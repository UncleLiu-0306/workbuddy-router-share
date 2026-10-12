#!/usr/bin/env node
/**
 * wb.mjs —— WorkBuddy 多账号管理 / 每日签到 / 积分查询
 *
 *   node wb.mjs login              添加账号（浏览器授权，可用 --no-open 只打印链接）
 *   node wb.mjs import [--relaunch] 从本机 WorkBuddy 桌面端导入当前登录账号
 *   node wb.mjs list               列出已有账号
 *   node wb.mjs checkin            所有账号签到一次（cron 用，输出可直接投递）
 *   node wb.mjs status             查看各账号积分余额
 *   node wb.mjs refresh [--force]  提前续期 accessToken
 *   node wb.mjs remove <uid>       删除账号
 *   node wb.mjs models             上游可用模型目录（含积分倍率）
 *   node wb.mjs report             积分日报（签到 + 余额 + 较上次变动 + 到期提醒）
 *
 * 纯 HTTP 实现，不依赖 WorkBuddy 桌面端（仅 import 需要）。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { requestAuthState, pollAuthToken, fetchLoginAccount, dailyCheckin, getCredits, isAlreadyCheckedIn, fetchModels, jwtExp } from './lib/api.mjs';
import { loadAll, save, removeByUid, ensureFresh, ROOT } from './lib/store.mjs';
import { readDesktopSession } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const has = (f) => argv.includes(f);
const argAfter = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 22) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function label(a) {
  if (a.nickname) return a.nickname;
  return a.uid ? a.uid.slice(0, 8) : '(未知账号)';
}

// ---------------------------------------------------------------- login

async function cmdLogin() {
  const st = await requestAuthState();
  if (!st.ok) {
    console.error('❌ 申请授权失败：' + (st.msg || st.kind));
    return 1;
  }
  console.log('请在浏览器中用【要添加的那个账号】完成登录授权：\n');
  console.log('  ' + st.authUrl + '\n');
  console.log('提示：多账号建议用不同浏览器 / 无痕窗口，避免串号。');
  if (!has('--no-open')) {
    try { execSync(`open "${st.authUrl}"`, { stdio: 'ignore' }); console.log('（已尝试自动打开浏览器）'); } catch {}
  }
  console.log('\n等待授权完成…（最多 10 分钟，按 Ctrl+C 取消）');

  const deadline = Date.now() + 10 * 60 * 1000;
  let netFails = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await pollAuthToken(st.state);
    if (r.ok) {
      const acctInfo = await fetchLoginAccount(st.state, r.token.accessToken);
      const account = acctInfo.ok ? acctInfo.account : {};
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = Number(r.token.expiresIn || 0);
      const acct = {
        accessToken: r.token.accessToken,
        refreshToken: r.token.refreshToken || '',
        domain: r.token.domain || '',
        realm: 'cn',
        expiresAt: expiresIn > 0 && expiresIn < 315360000 ? now + expiresIn : now + 60 * 24 * 3600,
        uid: account.uid || '',
        enterpriseId: account.enterpriseId || '',
        nickname: account.nickname || '',
      };
      if (!acct.uid) {
        console.error('⚠️ 授权成功但未取到 uid，已放弃保存（避免脏数据）。');
        return 1;
      }
      const dup = loadAll().find((a) => a.uid === acct.uid);
      save(acct);
      console.log(`\n✅ 已添加账号：${label(acct)}  (${acct.uid})${dup ? '  —— 覆盖了原有同 uid 账号' : ''}`);
      console.log(`   有效期至 ${new Date(acct.expiresAt * 1000).toLocaleString('zh-CN')}（有 refreshToken 会自动续期）`);
      return 0;
    }
    if (r.kind === 'network') {
      if (++netFails >= 20) { console.error('\n❌ 网络连续失败，已中止：' + r.msg); return 1; }
      continue;
    }
    netFails = 0;
    if (r.kind !== 'pending' && r.kind !== 'business') {
      console.error(`\n❌ 授权失败：code=${r.code ?? '-'} ${r.msg || r.kind}`);
      return 1;
    }
    process.stdout.write('.');
  }
  console.error('\n❌ 等待超时，未完成授权。');
  return 1;
}

// ---------------------------------------------------------------- import

async function cmdImport() {
  console.log('读取本机 WorkBuddy 桌面端当前登录账号…');
  const s = await readDesktopSession({ relaunch: has('--relaunch'), log: (m) => console.log('  ' + m) });
  const acc = s.account || {};
  if (!acc.uid) {
    console.error('❌ 未取到 uid，放弃保存。');
    return 1;
  }
  const dup = loadAll().find((a) => a.uid === acc.uid);
  // 桌面端 IPC 只给 accessToken，没有 refreshToken；到期时间以 token 里的 exp 为准，
  // 不要用「当前时间 + 假设有效期」推算（会比真实到期乐观，掩盖失效）。
  const exp = jwtExp(s.accessToken) || Math.floor(Date.now() / 1000) + 24 * 3600;
  const acct = {
    accessToken: s.accessToken,
    refreshToken: '',
    domain: acc.domain || '',
    realm: 'cn',
    expiresAt: exp,
    uid: acc.uid,
    enterpriseId: '',
    nickname: acc.nickname || '',
  };
  save(acct);
  console.log(`\n✅ 已导入：${label(acct)}  (${acct.uid})${dup ? '  —— 覆盖了原有同 uid 账号' : ''}`);
  console.log('⚠️ 桌面端 IPC 不提供 refreshToken，该账号约 60 天后需重新导入（或用 login 重新授权以获得自动续期）。');
  if (s.launched) console.log('（本次为读取登录态启动了 WorkBuddy，可以自行关闭）');
  return 0;
}

// ---------------------------------------------------------------- list / status

async function cmdList() {
  const all = loadAll();
  if (!all.length) { console.log('还没有账号。用 `node wb.mjs login` 添加，或 `node wb.mjs import` 从桌面端导入。'); return 0; }
  console.log(`共 ${all.length} 个账号：\n`);
  for (const a of all) {
    const exp = a.expiresAt ? new Date(a.expiresAt * 1000).toLocaleDateString('zh-CN') : '-';
    console.log(`  ${label(a).padEnd(20)} ${a.uid}`);
    console.log(`    token 至 ${exp}${a.refreshToken ? '（可自动续期）' : '（无 refreshToken）'}${a._error ? '  ⚠️ ' + a._error : ''}`);
  }
  return 0;
}

async function withFresh(acct, out) {
  const r = await ensureFresh(acct, { force: has('--force') });
  if (!r.ok) {
    out.status = r.needRelogin ? 'relogin' : 'fail';
    out.msg = r.error || 'token 续期失败';
    return null;
  }
  return r.acct;
}

async function cmdStatus() {
  const all = loadAll();
  if (!all.length) { console.log('还没有账号。先 `node wb.mjs login`。'); return 0; }
  console.log(`账号积分总览（${all.length} 个）\n`);
  let total = 0, okN = 0;
  const rows = [];
  for (const a of all) {
    const out = { credits: null };
    const fresh = await withFresh(a, out);
    if (!fresh) { console.log(`  ❌ ${label(a)}  ${out.msg}`); continue; }
    const c = await getCredits(fresh);
    if (!c.ok) { console.log(`  ⚠️ ${label(a)}  查积分失败：${c.msg || c.kind}`); continue; }
    okN++; total += c.remain;
    // 只看还有余额的套餐：空套餐的到期日是假信号，会让号显得「马上要过期」
    let nearest = null;
    for (const p of c.packs || []) {
      if (!p.end || !(p.remain > 0)) continue;
      const t = Date.parse(String(p.end).replace(' ', 'T'));
      if (Number.isFinite(t) && (nearest === null || t < nearest)) nearest = t;
    }
    rows.push({ name: label(a), credits: c.remain, nearest });
    const exp = nearest ? new Date(nearest).toLocaleDateString('zh-CN') : '';
    console.log(`  ${String(c.remain).padStart(6)} 积分  ${label(a).padEnd(20)}${exp ? ' 最早到期 ' + exp : ''}`);
  }
  console.log(`\n合计 ${total} 积分（${okN}/${all.length} 个账号查询成功）`);

  // 消耗顺序：与网关选号规则一致（到期早的先花；同到期则余额多的先）
  const order = rows.filter((r) => r.credits > 0).sort((x, y) => {
    const ex = x.nearest ?? Number.POSITIVE_INFINITY;
    const ey = y.nearest ?? Number.POSITIVE_INFINITY;
    if (ex !== ey) return ex - ey;
    return y.credits - x.credits;
  });
  if (order.length) {
    console.log('\n消耗顺序（网关按此选号）');
    order.forEach((r, i) => {
      const d = r.nearest ? new Date(r.nearest).toLocaleDateString('zh-CN') : '永久';
      console.log(`   ${i + 1}. ${r.name}  余额 ${r.credits}  最早到期 ${d}`);
    });
  }
  return 0;
}

// ---------------------------------------------------------------- checkin

/** 对全部账号跑一次「续期 → 签到 → 查积分」，checkin 与 report 共用。 */
async function scanAll() {
  const all = loadAll();
  const rows = [];
  let claimed = 0, already = 0, failed = 0, total = 0;
  for (const a of all) {
    const out = {};
    const fresh = await withFresh(a, out);
    if (!fresh) {
      rows.push({ label: label(a), uid: a.uid, icon: '❌', text: out.msg, credits: null });
      failed++;
      continue;
    }
    const r = await dailyCheckin(fresh);
    let icon, text, delta = 0;
    if (r.ok) {
      const d = r.data || {};
      const gain = Number(d.credit ?? d.credits ?? d.reward ?? d.amount ?? 0);
      delta = Number.isFinite(gain) && gain > 0 ? gain : 0;
      icon = '✅';
      text = delta ? `新领 +${delta}` : '已领取';
      claimed++;
    }
    else if (isAlreadyCheckedIn(r)) { icon = '☑️'; text = '今日已领过'; already++; }
    else { icon = '❌'; text = `失败 code=${r.code ?? '-'} ${short(r.msg || r.kind, 40)}`; failed++; }

    let credits = null, nearest = null;
    const c = await getCredits(fresh);
    if (c.ok) {
      credits = c.remain;
      total += credits;
      for (const p of c.packs || []) {
        // 只看有余额的套餐，否则空套餐的到期日会造成「即将过期」的假提醒
        if (!p.end || !(p.remain > 0)) continue;
        const t = Date.parse(String(p.end).replace(' ', 'T'));
        if (Number.isFinite(t) && (!nearest || t < nearest)) nearest = t;
      }
    }
    rows.push({ label: label(a), uid: a.uid, icon, text, credits, delta, nearest });
  }
  return { rows, claimed, already, failed, total, count: all.length };
}

async function cmdCheckin() {
  const today = new Date().toLocaleDateString('zh-CN');
  const s = await scanAll();
  if (!s.count) {
    console.log(`WorkBuddy 每日签到 · ${today}\n⚠️ 还没有配置任何账号。`);
    return 1;
  }

  console.log(`WorkBuddy 每日签到 · ${today} · 共 ${s.count} 个账号`);
  for (const r of s.rows) {
    console.log(`${r.icon} ${r.label.padEnd(20)} ${r.text}${r.credits === null ? '' : `   余额 ${r.credits}`}`);
  }
  console.log(`\n成功 ${s.claimed} / 已领过 ${s.already} / 失败 ${s.failed}`);
  return s.failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- report

const SNAP = path.join(ROOT, 'state', 'credits.json');

function loadSnaps() {
  try { return JSON.parse(fs.readFileSync(SNAP, 'utf8')); } catch { return {}; }
}

function saveSnaps(s) {
  fs.mkdirSync(path.dirname(SNAP), { recursive: true });
  const tmp = SNAP + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, SNAP);
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 积分日报：签到结果 + 各账号余额 + 较上次快照的变动 + 到期提醒。 */
async function cmdReport() {
  const now = new Date();
  const today = now.toLocaleDateString('zh-CN');
  const key = dayKey(now);
  const s = await scanAll();
  if (!s.count) {
    console.log(`📊 WorkBuddy 积分日报 · ${today}\n⚠️ 还没有配置任何账号。`);
    return 1;
  }

  const snaps = loadSnaps();
  const prevKeys = Object.keys(snaps).filter((k) => k < key).sort();
  const prevKey = prevKeys.length ? prevKeys[prevKeys.length - 1] : null;
  const prev = prevKey ? snaps[prevKey] : null;

  const lines = [];
  lines.push(`📊 WorkBuddy 积分日报 · ${today}`);
  lines.push('');
  lines.push(`签到（${s.count} 个账号）`);
  for (const r of s.rows) lines.push(`${r.icon} ${r.label.padEnd(18)} ${r.text}`);
  lines.push('');
  lines.push('积分');
  for (const r of s.rows) {
    const before = prev && prev[r.uid] != null ? prev[r.uid] : null;
    const chg = before != null && r.credits != null ? r.credits - before : null;
    const tag = chg == null ? '' : chg > 0 ? `（+${chg}）` : chg < 0 ? `（${chg}）` : '（持平）';
    lines.push(`   ${String(r.credits ?? '-').padStart(6)}  ${r.label} ${tag}`.trimEnd());
  }
  let ptotal = null;
  if (prev) ptotal = s.rows.reduce((acc, r) => acc + (prev[r.uid] || 0), 0);
  const diff = ptotal == null ? null : s.total - ptotal;
  lines.push('   ──────');
  lines.push(`   ${String(s.total).padStart(6)}  合计${diff == null ? '' : diff > 0 ? `（较 ${prevKey} +${diff}）` : diff < 0 ? `（较 ${prevKey} ${diff}）` : `（较 ${prevKey} 持平）`}`);

  for (const r of s.rows) {
    if (!r.nearest) continue;
    const days = Math.ceil((r.nearest - now.getTime()) / 86400000);
    if (days <= 7) lines.push(`⏰ ${r.label} 有积分 ${new Date(r.nearest).toLocaleDateString('zh-CN')} 到期（剩 ${days} 天）`);
  }

  // 消耗顺序：与网关选号规则一致（到期早的先花；同到期则余额多的先），让你一眼看到下一个用谁
  const order = s.rows
    .filter((r) => (r.credits ?? 0) > 0)
    .sort((x, y) => {
      const ex = x.nearest ?? Number.POSITIVE_INFINITY;
      const ey = y.nearest ?? Number.POSITIVE_INFINITY;
      if (ex !== ey) return ex - ey;
      return (y.credits ?? -1) - (x.credits ?? -1);
    });
  if (order.length) {
    lines.push('');
    lines.push('消耗顺序（网关按此选号）');
    order.forEach((r, i) => {
      const d = r.nearest ? new Date(r.nearest).toLocaleDateString('zh-CN') : '永久';
      lines.push(`   ${i + 1}. ${r.label}  余额 ${r.credits}  最早到期 ${d}`);
    });
  }
  if (s.failed) lines.push(`⚠️ ${s.failed} 个账号异常，跑 \`node wb.mjs status\` 看详情。`);

  console.log(lines.join('\n'));

  snaps[key] = Object.fromEntries(s.rows.map((r) => [r.uid, r.credits]));
  const trimmed = {};
  for (const k of Object.keys(snaps).sort().slice(-60)) trimmed[k] = snaps[k];
  saveSnaps(trimmed);

  return s.failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- refresh

async function cmdRefresh() {
  const all = loadAll();
  if (!all.length) { console.log('还没有账号。'); return 0; }
  let ok = 0, need = 0, bad = 0;
  for (const a of all) {
    const r = await ensureFresh(a, { force: true });
    if (r.ok) { ok++; console.log(`  ${r.refreshed ? '🔄 已续期' : '⏭ 无需续期'}  ${label(a)}`); }
    else if (r.needRelogin) { need++; console.log(`  🔑 需重新登录  ${label(a)}  (${r.error})`); }
    else { bad++; console.log(`  ❌ 续期失败    ${label(a)}  (${r.error})`); }
  }
  console.log(`\n续期成功 ${ok} / 需重登 ${need} / 失败 ${bad}`);
  return 0;
}

// ---------------------------------------------------------------- models

async function cmdModels() {
  const all = loadAll();
  if (!all.length) { console.log('还没有账号。先 `node wb.mjs login`。'); return 0; }
  const errs = [];
  let rows = null;
  for (const acct of all) {
    const f = await ensureFresh(acct, {});
    if (!f.ok) { errs.push(`${label(acct)}: ${f.msg || f.status}`); continue; }
    const m = await fetchModels(acct);
    if (m.ok) { rows = m.rows; break; }
    errs.push(`${label(acct)}: ${m.msg || m.kind}`);
  }
  if (!rows) { console.error('❌ 拉取模型目录失败：' + errs.join('; ')); return 1; }

  console.log(`上游可用模型 ${rows.length} 个（按积分倍率从低到高）：\n`);
  for (const m of rows) {
    console.log(`  ${m.cli ? '●' : '○'} ${m.id.padEnd(26)} ${m.credits.padEnd(17)} ${m.name}`);
  }
  const cli = rows.filter((m) => m.cli);
  console.log('\n● = cli agent 推荐名单   ○ = 可用但不在推荐名单');
  if (cli.length) console.log(`\n可使用 "wb-" 前缀访问的模型：${cli.map((m) => 'wb-' + m.id).join(', ')}`);
  return 0;
}

async function cmdRemove() {
  const uid = argAfter('--uid') || argv[1];
  if (!uid) { console.error('用法：node wb.mjs remove <uid 或 uid 前缀>'); return 1; }
  const hit = loadAll().find((a) => a.uid === uid || a.uid.startsWith(uid));
  if (!hit) { console.error('未找到该账号：' + uid); return 1; }
  removeByUid(hit.uid);
  console.log(`已删除：${label(hit)}  (${hit.uid})`);
  return 0;
}

// ---------------------------------------------------------------- dispatch

const CMDS = {
  login: cmdLogin, import: cmdImport, list: cmdList, status: cmdStatus,
  checkin: cmdCheckin, refresh: cmdRefresh, remove: cmdRemove, models: cmdModels,
  report: cmdReport,
};

function usage() {
  console.log(`WorkBuddy 多账号工具

  node wb.mjs login [--no-open]      添加账号（浏览器授权）
  node wb.mjs import [--relaunch]    从桌面端导入当前登录账号
  node wb.mjs list                   列出账号
  node wb.mjs status                 查看积分余额
  node wb.mjs checkin                所有账号签到（cron 用）
  node wb.mjs refresh [--force]      手动续期 token
  node wb.mjs remove <uid>           删除账号
`);
}

if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); process.exit(0); }
if (!CMDS[cmd]) { console.error(`未知命令：${cmd}\n`); usage(); process.exit(1); }

try {
  process.exit(await CMDS[cmd]());
} catch (e) {
  console.error('❌ ' + String((e && e.message) || e));
  process.exit(1);
}
