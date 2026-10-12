/**
 * 账号凭证存储
 *
 * 磁盘形态（每账号一个文件，与官方插件 OAuth 输出同形）：
 * {
 *   "auth":    { "accessToken", "refreshToken", "expiresAt", "domain", "realm" },
 *   "account": { "uid", "enterpriseId", "nickname" },
 *   "device_token": "…"        // 可选
 * }
 *
 * 设计要点（第二阶段网关要直接复用）：
 *   - 原子写：tmp + rename，避免半更新文件
 *   - 文件锁：refresh 是「读-改-写」，多进程并发会互相作废 token
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshAccessToken } from './api.mjs';

// 必须用 fileURLToPath：URL.pathname 不会解码 %XX，中文路径会指到影子目录
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const ACCOUNTS_DIR = path.join(ROOT, 'accounts');

function ensureDir() {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
}

function safeName(uid) {
  return `wb-${String(uid).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

// ---------------------------------------------------------------- 文件锁

const LOCK_PATH = () => path.join(ACCOUNTS_DIR, '.lock');

/** 简单自旋文件锁：跨进程串行化「读 token → refresh → 写回」。 */
export async function withLock(fn, { timeoutMs = 20000, staleMs = 60000 } = {}) {
  ensureDir();
  const lp = LOCK_PATH();
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lp);
        if (Date.now() - st.mtimeMs > staleMs) fs.unlinkSync(lp); // 陈旧锁回收
      } catch {}
      if (Date.now() - started > timeoutMs) throw new Error('获取账号锁超时');
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lp); } catch {}
  }
}

// ---------------------------------------------------------------- 读写

export function parseAccountFile(raw) {
  const doc = JSON.parse(raw);
  const nested = !!doc.auth;
  const a = nested ? doc.auth : doc;
  const acc = nested ? doc.account || {} : doc;
  if (!a.accessToken) throw new Error('缺少 accessToken');
  return {
    accessToken: a.accessToken,
    refreshToken: a.refreshToken || '',
    expiresAt: a.expiresAt || 0,
    domain: a.domain || '',
    realm: a.realm || doc.realm || 'cn',
    uid: acc.uid || '',
    enterpriseId: acc.enterpriseId || '',
    nickname: acc.nickname || '',
    deviceToken: doc.device_token || '',
  };
}

export function serializeAccount(acct) {
  const doc = {
    auth: {
      accessToken: acct.accessToken,
      refreshToken: acct.refreshToken || '',
      expiresAt: acct.expiresAt || 0,
      domain: acct.domain || '',
      realm: acct.realm || 'cn',
    },
    account: {
      uid: acct.uid || '',
      enterpriseId: acct.enterpriseId || '',
      nickname: acct.nickname || '',
    },
  };
  if (acct.deviceToken) doc.device_token = acct.deviceToken;
  return JSON.stringify(doc, null, 2) + '\n';
}

export function save(acct) {
  ensureDir();
  if (!acct.accessToken) throw new Error('拒绝保存：accessToken 为空');
  const dest = path.join(ACCOUNTS_DIR, safeName(acct.uid || `anon-${Date.now()}`));
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, serializeAccount(acct), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  return dest;
}

export function loadAll() {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(ACCOUNTS_DIR)) {
    if (!/^wb-.*\.json$/.test(f)) continue;
    const full = path.join(ACCOUNTS_DIR, f);
    try {
      out.push({ ...parseAccountFile(fs.readFileSync(full, 'utf8')), file: full, fileBase: f });
    } catch (e) {
      out.push({ uid: '', nickname: `(无法解析 ${f})`, file: full, fileBase: f, _error: String(e.message) });
    }
  }
  out.sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
  return out;
}

export function removeByUid(uid) {
  const hit = loadAll().find((a) => a.uid === uid);
  if (!hit) return false;
  fs.unlinkSync(hit.file);
  return true;
}

// ---------------------------------------------------------------- 续期

/**
 * 确保 accessToken 有效：剩余有效期不足 marginSec 时续期并原子写回。
 * 返回 {ok, refreshed, acct?, error?}。session 失效时 ok=false 且 needRelogin=true。
 */
export async function ensureFresh(acct, { marginSec = 7200, force = false } = {}) {
  if (acct._error) return { ok: false, refreshed: false, error: acct._error };
  const notExpiring = acct.expiresAt > 0 && Date.now() / 1000 + marginSec < acct.expiresAt;
  if (!force && notExpiring) return { ok: true, refreshed: false, acct };
  if (!acct.refreshToken) return { ok: false, refreshed: false, needRelogin: true, error: '没有 refreshToken，需重新登录' };

  return await withLock(async () => {
    // 双检：等锁期间可能已被别的进程刷新
    const onDisk = loadAll().find((a) => a.fileBase === acct.fileBase);
    if (onDisk && !force && onDisk.expiresAt > 0 && Date.now() / 1000 + marginSec < onDisk.expiresAt) {
      return { ok: true, refreshed: false, acct: onDisk };
    }
    const target = onDisk || acct;
    const r = await refreshAccessToken(target);
    if (!r.ok) {
      return {
        ok: false,
        refreshed: false,
        needRelogin: r.kind === 'session_dead',
        error: `${r.msg || r.kind || 'refresh 失败'}`,
      };
    }
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = Number(r.token.expiresIn || 0);
    const merged = {
      ...target,
      accessToken: r.token.accessToken,
      refreshToken: r.token.refreshToken || target.refreshToken,
      domain: r.token.domain || target.domain,
      expiresAt: expiresIn > 0 && expiresIn < 315360000 ? now + expiresIn : now + 60 * 24 * 3600,
    };
    save(merged);
    return { ok: true, refreshed: true, acct: merged };
  });
}
