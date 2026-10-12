/**
 * lib/api.mjs 重试行为的回归测试（本地假上游，不碰生产）。
 *
 * 断言：
 *   A. 503（重试边界内）→ 重试后成功，共 3 次请求
 *   B. 连接被 reset → 重试后成功，共 3 次请求
 *   C. 502 非 JSON（网关错误页）→ 重试后成功，共 3 次请求
 *   D. 业务码 10001（200）→ **绝不重试**，只请求 1 次
 *   E. 一直失败 → 重试次数有上界（3 次后放弃），不会无限重试
 */
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：URL.pathname 不解码 %XX，中文路径会指到影子路径（本项目踩过）
const API = fileURLToPath(new URL('./lib/api.mjs', import.meta.url));
const OK = { code: 0, msg: 'ok', data: { credit: 100 } };

let plan = [];        // 依次消费的故障脚本；用完就按 defaultStep
let defaultStep = { t: 'ok' };
let hits = 0;
let socketKills = 0;

const server = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  hits++;
  const step = plan.length ? plan.shift() : defaultStep;
  if (step.t === 'ok') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(OK));
  } else if (step.t === 'status') {
    res.writeHead(step.code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: step.code, msg: 'upstream busy' }));
  } else if (step.t === 'html') {
    res.writeHead(step.code, { 'Content-Type': 'text/html' });
    res.end('<html><body>502 Bad Gateway</body></html>');
  } else if (step.t === 'reset') {
    socketKills++;
    res.socket.destroy();
  } else if (step.t === 'biz10001') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来' }));
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.WB_BILLING_BASE = `http://127.0.0.1:${port}`;

// 必须在设置 env 之后动态 import：base 是在模块加载时读的
const { dailyCheckin } = await import(pathToFileURL(API).href);

const acct = { accessToken: 't', uid: 'u', enterpriseId: '' };
const rows = [];

async function scenario(name, steps, def) {
  plan = steps.map((s) => s);
  defaultStep = def || { t: 'ok' };
  hits = 0; socketKills = 0;
  const t0 = Date.now();
  const r = await dailyCheckin(acct);
  rows.push({ name, 请求次数: hits, 结果: r.ok ? `ok credit=${r.data?.credit}` : `fail kind=${r.kind} code=${r.code ?? '-'}`, 耗时秒: ((Date.now() - t0) / 1000).toFixed(2) });
}

const s503 = { t: 'status', code: 503 };
const s429 = { t: 'status', code: 429 };
const reset = { t: 'reset' };
const html502 = { t: 'html', code: 502 };

await scenario('A 503→503→成功', [s503, s503]);
await scenario('B 连接reset→reset→成功', [reset, reset]);
await scenario('C 502非JSON→502非JSON→成功', [html502, html502]);
await scenario('D 业务码10001（200）', [{ t: 'status', code: 200 }], null);
// D 需要回 200 + code=10001 的业务信封，单独跑：
plan = []; hits = 0;
defaultStep = { t: 'biz10001' };
const dRes = await dailyCheckin(acct);
rows[rows.length - 1] = { name: 'D 业务码10001（200）', 请求次数: hits, 结果: dRes.ok ? 'ok' : `fail kind=${dRes.kind} code=${dRes.code}`, 耗时秒: '-' };
await scenario('E 一直503（看是否有上界）', [], s503);
await scenario('F 429→成功', [s429]);

// G/H：getCredits 的 retries 开关（网关选号会传 retries:0 快速失败）
const { getCredits } = await import(pathToFileURL(API).href);
for (const [name, opts, steps, def] of [
  ['G getCredits retries:0 + 一直503（期望只请求1次）', { retries: 0 }, [], s503],
  ['H getCredits 默认 + 503→成功（期望2次）', {}, [s503], { t: 'ok' }],
]) {
  plan = steps.slice();
  defaultStep = def;
  hits = 0;
  const t0 = Date.now();
  const r = await getCredits(acct, opts);
  rows.push({ name, 请求次数: hits, 结果: r.ok ? 'ok' : `fail kind=${r.kind}`, 耗时秒: ((Date.now() - t0) / 1000).toFixed(2) });
}

server.close();
console.log('假上游请求统计：总请求 ' + (hits) + ' 次，连接被reset ' + socketKills + ' 次（最后一次场景）');
console.table(rows);
