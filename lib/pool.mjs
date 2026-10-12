/**
 * 账号池：按「额度到期紧迫度」选号 + 失败冷却。
 *
 * 策略：
 *   - **优先消耗快到期的额度**：按各号最早到期的套餐时间从早到晚排序，先磨快过期的号，
 *     避免积分过期作废。到期时间相同的，余额多的优先（少换号）。
 *   - **粘性只在无害时保留**：当前活跃号本来就是最该用的那个才不动（利于上游 prompt cache）；
 *     它若不是最紧迫的就切过去——浪费快过期的额度比 cache 未命中更贵。
 *   - 余额为 0 的号在还有其它可用号时直接跳过，不必等它 402。
 *   - 402/额度不足 → 冷却到次日 00:01（等签到补上）；401/403 → 冷却 30 分钟（可能是 token 抖动）；
 *     429 → 冷却 5 分钟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAll, ensureFresh, ROOT } from './store.mjs';
import { getCredits } from './api.mjs';

const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'pool.json');
const CREDIT_TTL_MS = 60_000;

function now() { return Math.floor(Date.now() / 1000); }

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { activeUid: '', cooldownUntil: {}, credits: {}, lastError: {} };
  }
}

function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

export function snapshot() {
  const s = loadState();
  const t = now();
  const rows = loadAll().map((a) => ({
    uid: a.uid,
    nickname: a.nickname,
    cooled: (s.cooldownUntil[a.uid] || 0) > t,
    cooldownUntil: s.cooldownUntil[a.uid] || 0,
    credits: s.credits[a.uid]?.remain ?? null,
    expiresAt: s.credits[a.uid]?.nearest ?? null,
    active: s.activeUid === a.uid,
  }));
  // 按选号优先级排序，一眼看出接下来会用谁
  rows.sort((x, y) => comparePriority(
    { credits: x.credits, nearest: x.expiresAt },
    { credits: y.credits, nearest: y.expiresAt },
  ));
  return { activeUid: s.activeUid, rows };
}

/** 拿号积分 + 最早到期时间（带 60s 缓存）。 */
async function creditInfo(acct, state, { fresh = false } = {}) {
  const c = state.credits[acct.uid];
  const cached = c ? { remain: c.remain, nearest: c.nearest ?? null } : { remain: null, nearest: null };
  if (!fresh && c && Date.now() - c.at < CREDIT_TTL_MS) return cached;

  // 网关选号在聊天请求的关键路径上：这里**不重试**（retries=0）。
  // 网络抖动时宁可快速沿用作废的缓存值（见下面的 return cached），也不能让一次聊天请求
  // 先等 3×30s 的积分查询重试才开始转发。
  const r = await getCredits(acct, { retries: 0 });
  if (!r.ok) return cached; // 查不到就沿用上次的值，别把号判死

  let nearest = null;
  for (const p of r.packs || []) {
    // 只看还有余额的套餐：空套餐的到期日会让号显得「马上要过期」，是假信号
    if (!p.end || !(p.remain > 0)) continue;
    const t = Date.parse(String(p.end).replace(' ', 'T'));
    if (Number.isFinite(t) && (nearest === null || t < nearest)) nearest = t;
  }
  state.credits[acct.uid] = { remain: r.remain, packs: r.packs, nearest, at: Date.now() };
  return { remain: r.remain, nearest };
}

/**
 * 排序：到期越早越优先（快过期的先花掉）；到期相同则余额多的优先。
 * 没有到期时间（永久额度）排最后。
 */
function comparePriority(x, y) {
  const ex = x.nearest ?? Number.POSITIVE_INFINITY;
  const ey = y.nearest ?? Number.POSITIVE_INFINITY;
  if (ex !== ey) return ex - ey;
  return (y.credits ?? -1) - (x.credits ?? -1);
}

/**
 * 选一个可用账号。
 * @returns {{ok:true, acct:object, credits:number|null}|{ok:false, reason:string}}
 */
export async function pick({ exclude = [] } = {}) {
  const state = loadState();
  const t = now();
  const all = loadAll().filter((a) => !a._error && !exclude.includes(a.uid));
  if (!all.length) return { ok: false, reason: exclude.length ? '所有账号都试过了' : '没有配置任何账号（先跑 node wb.mjs login）' };

  const usable = all.filter((a) => (state.cooldownUntil[a.uid] || 0) <= t);
  if (!usable.length) {
    const soonest = Math.min(...all.map((a) => state.cooldownUntil[a.uid] || 0));
    return { ok: false, reason: `所有账号均在冷却中（最早 ${new Date(soonest * 1000).toLocaleString('zh-CN')} 恢复）` };
  }

  // 给每个可用号算「到期紧迫度」。
  // 并行查：缓存过期后（如网关刚启动）这里是 N 次上游调用，串行会给第一个请求叠加 N 秒。
  // 正常情况下积分有 60s 缓存，这里不发请求。
  const probed = await Promise.all(usable.map(async (a) => {
    try {
      const fresh = await ensureFresh(a);
      if (!fresh.ok) return { uid: a.uid, err: fresh.error || 'token 续期失败' };
      const info = await creditInfo(fresh.acct, state);
      return { acct: fresh.acct, credits: info.remain, nearest: info.nearest };
    } catch (e) {
      // 单个号探测抛异常不能拖垮整个选号（否则 pick 直接 reject，请求以 500 收场）
      return { uid: a.uid, err: (e && e.message) || String(e) };
    }
  }));
  const scored = [];
  for (const p of probed) {
    if (p.err) { state.lastError[p.uid] = p.err; continue; }
    scored.push(p);
  }
  if (!scored.length) {
    saveState(state);
    return { ok: false, reason: '所有账号 token 续期均失败，需重新登录' };
  }

  // 还有余额的优先；若全是 0 / 查不到，就仍从原集合挑，交给上游 402 去冷却
  const withCredits = scored.filter((x) => (x.credits ?? 1) > 0);
  const sorted = [...(withCredits.length ? withCredits : scored)].sort(comparePriority);
  const best = sorted[0];

  // 只在「到期档位」之间切号。同一档（到期日相同）内保持粘性：
  // 否则两个到期日相同的号会因余额此消彼长而反复互切——实测 79 次请求里横跳 4 次
  // （131→185→131→185），白丢上游 prompt cache；而它们谁先花完对「避免过期」毫无区别。
  const tierExp = best.nearest ?? Number.POSITIVE_INFINITY;
  const activeInTier = sorted.find(
    (x) => x.acct.uid === state.activeUid && (x.nearest ?? Number.POSITIVE_INFINITY) === tierExp,
  );
  const chosen = activeInTier || best;

  const switched = state.activeUid !== chosen.acct.uid;
  if (switched) state.activeUid = chosen.acct.uid;
  saveState(state);
  return { ok: true, acct: chosen.acct, credits: chosen.credits, nearest: chosen.nearest, switched };
}

export function reportQuotaExhausted(uid) {
  const s = loadState();
  const d = new Date();
  const nextDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 1, 0);
  s.cooldownUntil[uid] = Math.floor(nextDay.getTime() / 1000);
  if (s.credits[uid]) s.credits[uid] = { ...s.credits[uid], remain: 0, at: Date.now() };
  s.lastError[uid] = '额度不足，冷却到次日';
  if (s.activeUid === uid) s.activeUid = '';
  saveState(s);
  return s.cooldownUntil[uid];
}

export function reportAuthIssue(uid, minutes = 30) {
  const s = loadState();
  s.cooldownUntil[uid] = now() + minutes * 60;
  if (s.activeUid === uid) s.activeUid = '';
  saveState(s);
}

export function reportRateLimited(uid, minutes = 5) {
  const s = loadState();
  s.cooldownUntil[uid] = now() + minutes * 60;
  if (s.activeUid === uid) s.activeUid = '';
  saveState(s);
}

/** 上游返回用量后刷新本地缓存（让选号依据更准）。 */
export function noteUsage(uid, totalTokens) {
  if (!uid) return;
  const s = loadState();
  const c = s.credits[uid];
  if (c && Number.isFinite(totalTokens)) c.remain = Math.max(0, c.remain - totalTokens);
  saveState(s);
}
