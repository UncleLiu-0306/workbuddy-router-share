#!/usr/bin/env node
/**
 * add-to-codebuddy.mjs —— 把账号池接入 CodeBuddy
 *
 * 为什么不用环境变量：~/.codebuddy/models.json 里自定义模型的 url 优先级高于
 * CODEBUDDY_BASE_URL，而你的默认模型本身就是自定义模型，所以环境变量根本不会生效。
 *
 * 模型名映射：注册 wb-<模型名> → 网关剥掉 wb- 前缀 → 上游真实模型名。
 * 这样 CodeBuddy 里能逐个模型切换，而积分全部走账号池。
 *
 *   node add-to-codebuddy.mjs                     注册 cli 推荐名单全部模型
 *   node add-to-codebuddy.mjs --only glm-5.3-flash,kimi-k3-1
 *   node add-to-codebuddy.mjs --list              列出已注册的 wb-* 条目
 *   node add-to-codebuddy.mjs --remove            全部移除
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAll, ensureFresh } from './lib/store.mjs';
import { fetchModels } from './lib/api.mjs';

const MODELS_JSON = path.join(os.homedir(), '.codebuddy', 'models.json');
const PREFIX = 'wb-';
const GATEWAY = `http://127.0.0.1:${process.env.WB_GATEWAY_PORT || 7863}/chat/completions`;

function load() {
  if (!fs.existsSync(MODELS_JSON)) return { models: [] };
  const j = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf8'));
  if (!Array.isArray(j.models)) j.models = [];
  return j;
}

function backup() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const dst = `${MODELS_JSON}.bak-${stamp}`;
  fs.copyFileSync(MODELS_JSON, dst);
  // gw.sh 每次 start/stop 都会备份，保留最近 10 份即可，别把目录堆满
  try {
    const dir = path.dirname(MODELS_JSON);
    const base = path.basename(MODELS_JSON) + '.bak-';
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 10))) fs.unlinkSync(path.join(dir, f));
  } catch {}
  return dst;
}

function save(j) {
  const tmp = `${MODELS_JSON}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, MODELS_JSON);
}

async function pickCatalog() {
  const all = loadAll();
  if (!all.length) {
    console.error('❌ 还没有账号，先跑 `node wb.mjs login`。');
    process.exit(1);
  }
  for (const acct of all) {
    const f = await ensureFresh(acct, {});
    if (!f.ok) continue;
    const m = await fetchModels(acct);
    if (m.ok) return m.rows;
  }
  console.error('❌ 拉取上游模型目录失败（账号登录态可能已失效，跑 `node wb.mjs status` 看看）。');
  process.exit(1);
}

function entryFor(row) {
  return {
    id: PREFIX + row.id,
    name: `WorkBuddy · ${row.name}`,
    vendor: 'WorkBuddy',
    url: GATEWAY,
    apiKey: 'workbuddy-pool',
    maxInputTokens: 200000,
    maxOutputTokens: row.maxOutputTokens || 32000,
    supportsToolCall: true,
    supportsReasoning: true,
  };
}

const argv = process.argv.slice(2);
const mode = argv.includes('--remove') ? 'remove' : argv.includes('--list') ? 'list' : 'add';
const onlyArg = (() => {
  const i = argv.indexOf('--only');
  if (i < 0) return null;
  return String(argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
})();

if (!fs.existsSync(MODELS_JSON)) {
  console.error(`❌ 没找到 ${MODELS_JSON}`);
  process.exit(1);
}

const j = load();
const mine = j.models.filter((m) => String(m.id).startsWith(PREFIX));

if (mode === 'list') {
  if (!mine.length) console.log(`（没有注册任何 ${PREFIX}* 模型）`);
  for (const m of mine) console.log(`${m.id}\t${m.name}\t${m.url}`);
  console.log(`\n其它自定义模型 ${j.models.length - mine.length} 个未受影响。`);
  process.exit(0);
}

if (mode === 'remove') {
  if (!mine.length) { console.log(`（没有 ${PREFIX}* 条目，无需移除）`); process.exit(0); }
  const bk = backup();
  j.models = j.models.filter((m) => !String(m.id).startsWith(PREFIX));
  save(j);
  console.log(`✅ 已移除 ${mine.length} 个 ${PREFIX}* 模型；模型数 ${mine.length + j.models.length} -> ${j.models.length}；备份: ${bk}`);
  process.exit(0);
}

const rows = await pickCatalog();
const chosen = onlyArg
  ? rows.filter((r) => onlyArg.includes(r.id) || onlyArg.includes(PREFIX + r.id))
  : rows.filter((r) => r.cli);

if (!chosen.length) {
  console.error('❌ 没有匹配的模型。用 `node wb.mjs models` 看可用 id。');
  process.exit(1);
}

const bk = backup();
for (const row of chosen) {
  const e = entryFor(row);
  const i = j.models.findIndex((m) => m.id === e.id);
  if (i >= 0) j.models[i] = { ...j.models[i], ...e };
  else j.models.push(e);
}
save(j);

console.log(`✅ 已注册 ${chosen.length} 个模型，全部指向 ${GATEWAY}；备份: ${bk}`);
for (const row of chosen) console.log(`   ${PREFIX}${row.id.padEnd(24)} ${row.name.padEnd(20)} ${row.credits || ''}`);
console.log(`\n模型数 ${j.models.length}（其中 ${PREFIX}* 共 ${j.models.filter((m) => String(m.id).startsWith(PREFIX)).length} 个）`);
console.log(`用法：codebuddy 里 /model 选「WorkBuddy · xxx」，或 codebuddy --model ${PREFIX}${chosen[0].id}`);
