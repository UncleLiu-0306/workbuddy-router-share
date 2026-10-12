/**
 * WorkBuddy / CodeBuddy CN 上游接口封装
 *
 * 三个域（CN）：
 *   chatBase    https://copilot.tencent.com   —— 插件授权 / token 续期 / 推理
 *   billingBase https://www.codebuddy.cn      —— 签到 / 积分
 *
 * 鉴权只要 accessToken + uid，不依赖桌面端与系统钥匙串。
 */
import { createHash } from 'node:crypto';

// 允许用环境变量指向别的 base（联调/回归测试用本地假上游；不设就是生产域名）
export const CHAT_BASE = process.env.WB_CHAT_BASE || 'https://copilot.tencent.com';
export const BILLING_BASE = process.env.WB_BILLING_BASE || 'https://www.codebuddy.cn';
const ORIGIN = 'https://www.codebuddy.cn';
const UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

/** 按 uid 稳定派生 36 hex 设备/会话标识（跨重启恒定、账号间互异），对齐官方"每账号一台固定虚拟设备"。 */
export function deriveStableId(uid, purpose) {
  return createHash('sha256').update(`wb2a:${purpose}:${uid}`).digest('hex').slice(0, 36);
}

function commonHeaders(acct = {}) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: ORIGIN,
    Referer: ORIGIN + '/',
    'User-Agent': UA,
    'Accept-Language': 'zh-CN',
    'X-CodeBuddy-Request': '1',
  };
  if (acct.uid) {
    h['X-Machine-ID'] = deriveStableId(acct.uid, 'machine');
    h['X-Session-ID'] = deriveStableId(acct.uid, 'session');
  }
  return h;
}

/** billing 域头：commonHeaders + 账号身份。 */
function billingHeaders(acct) {
  const h = commonHeaders(acct);
  if (acct.accessToken) h.Authorization = 'Bearer ' + acct.accessToken;
  if (acct.uid) h['X-User-Id'] = acct.uid;
  if (acct.enterpriseId) {
    h['X-Enterprise-Id'] = acct.enterpriseId;
    h['X-Tenant-Id'] = acct.enterpriseId;
  }
  if (acct.domain) h['X-Domain'] = acct.domain;
  return h;
}

/** 单次请求：{code,msg,data} 业务信封解包（不重试）。 */
async function once(url, init = {}, timeoutMs = 30000) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, kind: 'network', msg: String((e && e.message) || e) };
  }
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, kind: 'parse', httpStatus: res.status, msg: `非 JSON 响应(${res.status}): ${raw.slice(0, 160)}` };
  }
  if (json.code !== 0) {
    return { ok: false, kind: 'business', httpStatus: res.status, code: json.code, msg: json.msg || '(无 msg)', raw };
  }
  return { ok: true, httpStatus: res.status, data: json.data, raw };
}

/** 值得重试的状态码：上游过载/网关错误，「再来一次可能就好」。 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 重试间隔（毫秒）；数组长度 = 默认重试次数。1s/3s 够覆盖瞬时抖动，又不拖长一次运行。 */
const RETRY_DELAYS_MS = [1000, 3000];

/**
 * 是否属于「瞬时失败」。
 * 上游明确回了业务码（如 10001 今天已签到）时绝不重试——那是答案，不是故障。
 */
function isRetryable(r) {
  if (!r || r.ok) return false;
  if (r.kind === 'network') return true; // fetch failed / DNS 失败 / 超时
  return RETRYABLE_STATUS.has(Number(r.httpStatus));
}

/**
 * {code,msg,data} 业务信封解包，带瞬时失败重试。
 *
 * 为什么必须重试：签到一天只有一次机会，网络抖动会直接把这次机会吞掉（实测过一次本机网络
 * 故障窗口内，串行跑的前两个账号全部超时、第三个账号才成功）。签到/查积分都幂等
 * （已领会回 10001），重试的代价远低于漏签一整天。
 *
 * refresh 也走这里：响应丢失时旧 refreshToken 可能已被上游轮换，重试与不重试的后果相同
 * （都要重新登录），重试只多一次「请求根本没到上游」时自愈的机会。
 */
async function envelope(url, init = {}, timeoutMs = 30000, retries = RETRY_DELAYS_MS.length) {
  let r = await once(url, init, timeoutMs);
  for (let attempt = 1; attempt <= retries && isRetryable(r); attempt++) {
    await new Promise((s) => setTimeout(s, RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]));
    r = await once(url, init, timeoutMs);
  }
  return r;
}

// ---------------------------------------------------------------- 授权（设备流）

/** 第一步：申请授权 state。返回 {state, authUrl}。 */
export async function requestAuthState() {
  const r = await envelope(`${CHAT_BASE}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: commonHeaders(),
    body: '{}',
  });
  if (!r.ok) return r;
  if (!r.data?.state || !r.data?.authUrl) return { ok: false, kind: 'parse', msg: 'auth/state 缺少 state 或 authUrl' };
  return { ok: true, state: r.data.state, authUrl: r.data.authUrl };
}

/** 第二步：轮询换取 token。未完成授权时上游返回 11217「login ing...」。 */
export async function pollAuthToken(state) {
  const r = await envelope(`${CHAT_BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
    method: 'GET',
    headers: commonHeaders(),
  });
  if (!r.ok) {
    // 11217 = 用户尚未完成授权，继续等；其余业务码按原样返回由调用方判断
    if (r.code === 11217 || /login\s*ing/i.test(r.msg || '')) return { ok: false, kind: 'pending', code: r.code, msg: r.msg };
    return r;
  }
  if (!r.data?.accessToken) return { ok: false, kind: 'pending', msg: '尚未拿到 accessToken（登录未完成）' };
  const { accessToken, refreshToken, expiresIn, domain } = r.data;
  return { ok: true, token: { accessToken, refreshToken, expiresIn, domain } };
}

/** 第三步：拿账号信息（uid / nickname / enterpriseId）。 */
export async function fetchLoginAccount(state, accessToken) {
  const h = commonHeaders();
  h.Authorization = 'Bearer ' + accessToken;
  const r = await envelope(`${CHAT_BASE}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
    method: 'GET',
    headers: h,
  });
  if (!r.ok) return r;
  const d = r.data || {};
  return { ok: true, account: { uid: d.uid || '', enterpriseId: d.enterpriseId || '', nickname: d.nickname || '' } };
}

/** accessToken 续期。成功返回新 token；失败时 kind='session_dead' 表示需重新登录。 */
export async function refreshAccessToken(acct) {
  const h = commonHeaders(acct);
  h['X-Refresh-Token'] = acct.refreshToken;
  h['X-Auth-Refresh-Source'] = 'plugin';
  if (acct.enterpriseId) h['X-Enterprise-Id'] = acct.enterpriseId;
  const r = await envelope(`${CHAT_BASE}/v2/plugin/auth/token/refresh`, { method: 'POST', headers: h });
  if (!r.ok) {
    // 12153 / session 失效类 → 需要人工重登
    const dead = r.code === 12153 || /session|登录|token/i.test(r.msg || '');
    return { ...r, kind: dead ? 'session_dead' : r.kind };
  }
  if (!r.data?.accessToken) return { ok: false, kind: 'session_dead', msg: 'refresh 未返回 accessToken' };
  return { ok: true, token: r.data };
}

// ---------------------------------------------------------------- 签到 / 积分

/** 每日签到。已签到等幂等结果由调用方按 code/msg 判定。 */
export async function dailyCheckin(acct) {
  return await envelope(`${BILLING_BASE}/v2/billing/meter/daily-checkin`, {
    method: 'POST',
    headers: billingHeaders(acct),
    body: '{}',
  });
}

/** 查询各套餐积分余额并聚合。retries=0 可关掉重试（关键路径上要快速失败时用）。 */
export async function getCredits(acct, { retries = RETRY_DELAYS_MS.length } = {}) {
  const now = new Date();
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const far = new Date(now.getTime() + 365 * 101 * 86400 * 1000);
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(far),
  };
  const r = await envelope(`${BILLING_BASE}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: billingHeaders(acct),
    body: JSON.stringify(body),
  }, 30000, retries);
  if (!r.ok) return r;
  const accounts = r.data?.Response?.Data?.Accounts || [];
  const packs = accounts.map((a) => {
    let remain = Number(a.CycleCapacityRemain ?? a.CapacityRemain ?? 0);
    let size = Number(a.CycleCapacitySize ?? a.CapacitySize ?? 0);
    if (!Number.isFinite(remain)) remain = 0;
    if (!Number.isFinite(size)) size = 0;
    if (remain < 0) remain = 0;
    if (size > 0 && remain > size) remain = size;
    return { name: a.PackageName || '', remain, size, end: a.CycleEndTime || '' };
  });
  return {
    ok: true,
    remain: packs.reduce((s, p) => s + p.remain, 0),
    size: packs.reduce((s, p) => s + p.size, 0),
    packs,
  };
}

/** 判定「今天已签到」类幂等结果。 */
export function isAlreadyCheckedIn(r) {
  if (!r || r.ok) return false;
  const s = `${r.code ?? ''} ${r.msg ?? ''}`;
  return /10001|14001/.test(String(r.code ?? '')) || /已签到|已经签到|已领取|already/i.test(s);
}

/**
 * 拉取该账号在上游可用的模型目录（只读，不消耗积分）。
 * 返回 [{ id, name, credits, vendor, cli: 是否在 cli agent 名单内 }]，按倍率从低到高排序。
 */
export async function fetchModels(acct) {
  const r = await envelope(`${CHAT_BASE}/console/enterprises/personal/models`, {
    method: 'GET',
    headers: billingHeaders(acct),
  });
  if (!r.ok) return r;

  const d = r.data || {};
  const cliIds = new Set();
  const cliAgent = (d.agents || []).find((a) => a.name === 'cli');
  for (const id of (cliAgent && cliAgent.models) || []) cliIds.add(id);

  const rows = (d.models || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    credits: typeof m.credits === 'string' ? m.credits : (m.credits != null ? `x${m.credits}` : ''),
    vendor: m.vendor || '',
    cli: cliIds.has(m.id),
  }));

  const mult = (s) => {
    const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : 999;
  };
  rows.sort((a, b) => mult(a.credits) - mult(b.credits) || a.id.localeCompare(b.id));

  return { ok: true, rows, cliCount: cliIds.size };
}

/**
 * 从 JWT 里读真实到期时间（秒）。
 * 不要用「当前时间 + 假设有效期」来推算，否则会比真实到期乐观很多，
 * 导致 token 已经失效了脚本还以为没事。
 */
export function jwtExp(token) {
  try {
    const p = String(token).split('.');
    if (p.length !== 3) return 0;
    const payload = JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8'));
    return Number(payload.exp) || 0;
  } catch {
    return 0;
  }
}
