#!/usr/bin/env node
/**
 * proxy.mjs —— 多账号积分统一网关
 *
 * CodeBuddy CLI 用自定义端点时走的是 OpenAI 协议：POST {CODEBUDDY_BASE_URL}/chat/completions
 * 上游 https://copilot.tencent.com/v2/chat/completions 收的是同一种格式，
 * 所以本网关是**纯透传**：只把身份头换成账号池里选中的账号。
 *
 *   CODEBUDDY_BASE_URL=http://127.0.0.1:7863 CODEBUDDY_API_KEY=any codebuddy
 *
 * CodeBuddy 自身的登录态完全不参与——进来的 Authorization / x-api-key 会被丢弃。
 *
 * 环境变量：
 *   WB_GATEWAY_PORT      默认 7863
 *   WB_GATEWAY_HOST      默认 127.0.0.1
 *   WB_UPSTREAM_BASE     默认 https://copilot.tencent.com/v2
 *   WB_GATEWAY_DEBUG=1   打印每次转发的摘要
 */
import http from 'node:http';
import { pick, reportQuotaExhausted, reportAuthIssue, reportRateLimited, snapshot, noteUsage } from './lib/pool.mjs';

const PORT = Number(process.env.WB_GATEWAY_PORT || 7863);
const HOST = process.env.WB_GATEWAY_HOST || '127.0.0.1';
const UPSTREAM_BASE = (process.env.WB_UPSTREAM_BASE || 'https://copilot.tencent.com/v2').replace(/\/+$/, '');
// 「等上游响应头」的超时。只覆盖到首个响应头为止，不会切断正常的长流式输出。
const UPSTREAM_HEADER_TIMEOUT_MS = Number(process.env.WB_UPSTREAM_HEADER_TIMEOUT_MS || 120000);
const DEBUG = process.env.WB_GATEWAY_DEBUG === '1';

// 模型名一律原样透传给上游（模型由客户端选，网关不锁死）；
// 只剥掉一个可选前缀，便于在 CodeBuddy 里把「走账号池」的模型跟别的区分开。
const MODEL_PREFIX = process.env.WB_MODEL_PREFIX || 'wb-';

/** 解析出真正的上游模型名。WB_UPSTREAM_MODEL 设了才强制锁死（默认不锁）。 */
function resolveModelName(from) {
  if (process.env.WB_UPSTREAM_MODEL) return process.env.WB_UPSTREAM_MODEL;
  return MODEL_PREFIX && from.startsWith(MODEL_PREFIX) ? from.slice(MODEL_PREFIX.length) : from;
}

/** 把请求体里的 model 换成上游认识的名字，并强制流式上行。 */
function rewriteModel(buf) {
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { return { body: buf, from: '', to: '', needAggregate: false }; }
  const from = j.model || '';
  const to = resolveModelName(from);

  // 上游不支持非流式请求（回 11101），所以一律以 stream=true 上行；
  // 客户端要非流式时，由网关把 SSE 收全再合成一个 chat.completion 返回。
  const needAggregate = j.stream !== true;
  if (j.model === to && !needAggregate) return { body: buf, from, to, needAggregate };

  j.model = to;
  j.stream = true;
  return { body: Buffer.from(JSON.stringify(j), 'utf8'), from, to, needAggregate };
}

/** 把上游 SSE 收全，合成为一个非流式 chat.completion 对象。 */
async function collectStream(up) {
  const dec = new TextDecoder();
  let buf = '', id = '', model = '', content = '', reasoning = '', role = 'assistant';
  let finish = null, usage = null;
  const created = Math.floor(Date.now() / 1000);
  // 工具调用分片按 index 聚合：name 一次性到达，arguments 分片追加
  const toolCalls = new Map();

  for await (const chunk of up.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.id) id = j.id;
      if (j.model) model = j.model;
      if (j.usage) usage = j.usage;
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      if (ch.delta) {
        if (typeof ch.delta.content === 'string') content += ch.delta.content;
        if (typeof ch.delta.reasoning_content === 'string') reasoning += ch.delta.reasoning_content;
        if (ch.delta.role) role = ch.delta.role;
        if (Array.isArray(ch.delta.tool_calls)) {
          for (const tc of ch.delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            const cur = toolCalls.get(idx)
              || { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) cur.id = tc.id;
            if (tc.type) cur.type = tc.type;
            if (tc.function) {
              if (tc.function.name) cur.function.name += tc.function.name;
              if (typeof tc.function.arguments === 'string') cur.function.arguments += tc.function.arguments;
            }
            toolCalls.set(idx, cur);
          }
        }
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }

  const message = { role, content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => ({
        id: tc.id || `call_${created}_${tc.function.name || 'unknown'}`,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
  }
  const out = {
    id: id || `chatcmpl-${created}`,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish || 'stop' }],
  };
  if (usage) out.usage = usage;
  return out;
}

// 这些头由网关接管或必须重算，不原样转发
const STRIP = new Set([
  'host', 'authorization', 'x-api-key', 'api-key', 'x-user-id', 'x-enterprise-id',
  'x-tenant-id', 'x-domain', 'content-length', 'connection', 'accept-encoding',
]);

function log(...a) { if (DEBUG) console.log(new Date().toISOString(), ...a); }

function upstreamHeaders(acct, incoming) {
  const h = {};
  for (const [k, v] of Object.entries(incoming)) if (!STRIP.has(k)) h[k] = v;
  h.Authorization = 'Bearer ' + acct.accessToken;
  h['X-CodeBuddy-Request'] = '1';
  if (acct.uid) h['X-User-Id'] = acct.uid;
  if (acct.domain) h['X-Domain'] = acct.domain;
  if (acct.enterpriseId) h['X-Enterprise-Id'] = acct.enterpriseId;
  return h;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/** 判断上游错误是不是「这个号不能用了，换下一个」。 */
function classify(status, text) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 402) return 'quota';
  if (status === 400 || status === 500 || status === 503) {
    // 400 + 额度/积分字样也算额度问题（上游口径不一）
    if (/quota|credit|balance|积分|余额|额度|insufficient/i.test(text)) return 'quota';
  }
  return 'fatal';
}

// 任何单次转发的异常都不允许拖垮整个网关（否则 CLI 会一直挂着等响应）
async function handleRequest(req, res) {
  let url = (req.url || '').split('?')[0];
  // OpenAI SDK 风格的客户端习惯把 base_url 写成以 /v1 结尾（请求打到 /v1/chat/completions）；
  // 上游没有 /v2/v1/... 路由（实测 404），转发前剥掉一层 /v1 前缀（保留路径开头的斜杠），
  // 两类客户端都零配置直连。
  if (url.startsWith('/v1/')) url = url.replace(/^\/v1/, '');

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, upstream: UPSTREAM_BASE }));
  }
  if (url === '/pool') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(snapshot()));
  }
  if (req.method !== 'POST' || !/(^|\/)chat\/completions$/.test(url)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `不支持 ${req.method} ${url}`, type: 'gateway' } }));
  }

  let body;
  try { body = await readBody(req); } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '读取请求体失败: ' + e.message, type: 'gateway' } }));
  }

  const { body: fwdBody, from: modelFrom, to: modelTo, needAggregate } = rewriteModel(body);
  // 无条件记录请求起点。只在「模型被重写」时打日志的话，模型名没变（或客户端发的是裸名）
  // 的请求会一点痕迹都不留 —— 一旦卡住，事后无法判断请求有没有到网关。
  log(`<- ${modelFrom || modelTo || '(无 model)'}${needAggregate ? ' [非流式]' : ''}`);
  if (modelFrom && modelFrom !== modelTo) log(`model 重写: ${modelFrom} -> ${modelTo}`);

  const tried = [];
  for (;;) {
    const sel = await pick({ exclude: tried });
    if (!sel.ok) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: sel.reason, type: 'gateway' } }));
    }
    const { acct } = sel;
    tried.push(acct.uid);
    const t0 = Date.now();

    let up;
    // 只给「等响应头」设超时：上游接了连接却不回包时，没有超时的 fetch 会永远挂着，
    // 客户端只看到一直转圈（这正是「卡住」最像的成因）。
    // 用可清除的定时器而不是 AbortSignal.timeout —— 后者会在整个请求生命周期后触发，
    // 会把还在正常流式输出的长回答直接切断。
    const ctl = new AbortController();
    const hdrTimer = setTimeout(() => ctl.abort(new Error(`上游 ${UPSTREAM_HEADER_TIMEOUT_MS}ms 未返回响应头`)), UPSTREAM_HEADER_TIMEOUT_MS);
    try {
      up = await fetch(`${UPSTREAM_BASE}${url}`, {
        method: 'POST',
        headers: upstreamHeaders(acct, req.headers),
        body: fwdBody,
        signal: ctl.signal,
      });
    } catch (e) {
      log('network error/timeout', acct.nickname, e.message);
      await new Promise((r) => setTimeout(r, 300));
      continue; // 网络问题/超时换号重试
    } finally {
      clearTimeout(hdrTimer);
    }

    if (up.ok || up.status === 200) {
      log(`200 ${modelTo} -> ${acct.nickname} (${Date.now() - t0}ms)${needAggregate ? ' [非流式客户端→已聚合]' : ''}`);

      if (needAggregate) {
        let agg = null;
        try { agg = await collectStream(up); } catch (e) { log('aggregate failed', e.message); }
        if (agg) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(agg));
          noteUsage(acct.uid, 0);
          return;
        }
        continue; // 聚合失败，换号重试
      }

      const out = {};
      for (const [k, v] of up.headers) if (!/content-length|content-encoding|transfer-encoding|connection/i.test(k)) out[k] = v;
      res.writeHead(up.status, out);
      try {
        for await (const chunk of up.body) res.write(chunk);
      } catch (e) {
        log('stream abort', e.message);
      }
      res.end();
      noteUsage(acct.uid, 0);
      return;
    }

    const text = await up.text().catch(() => '');
    const kind = classify(up.status, text);
    log(`${up.status} ${kind} ${acct.nickname} :: ${text.slice(0, 200)}`);

    if (kind === 'quota') { reportQuotaExhausted(acct.uid); continue; }
    if (kind === 'auth') { reportAuthIssue(acct.uid, 30); continue; }
    if (kind === 'rate') { reportRateLimited(acct.uid, 5); continue; }

    // 非账号问题：原样透传错误
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
    return res.end(text || '{}');
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    log('handler crash', (e && e.stack) || String(e));
    try {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'gateway error: ' + (e && e.message), type: 'gateway' } }));
    } catch {}
  });
});

server.listen(PORT, HOST, () => {
  console.log(`WorkBuddy 多账号网关已启动: http://${HOST}:${PORT}`);
  console.log(`上游: ${UPSTREAM_BASE}`);
  console.log(`用法: CODEBUDDY_BASE_URL=http://${HOST}:${PORT} CODEBUDDY_API_KEY=any codebuddy`);
});

// 手动启动时最容易撞上 launchd 托管的那一份，给个能直接照做的提示，不要甩堆栈
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用 —— 可能已有一个网关实例在运行（这是正常状态）。`);
    console.error(`  找进程: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    console.error(`  探活:   curl -s http://${HOST}:${PORT}/health`);
    process.exit(2);
  }
  console.error(`网关启动失败: ${e.message}`);
  process.exit(1);
});
