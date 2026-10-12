import { loadAll, ensureFresh } from './lib/store.mjs';
import { getCredits } from './lib/api.mjs';

const target = process.argv[2];   // 昵称过滤，省略则全打
for (const a of loadAll()) {
  if (target && a.nickname !== target) continue;
  const f = await ensureFresh(a);
  const c = await getCredits(f.acct || a);
  if (!c.ok) { console.log(`${a.nickname}: 查询失败`); continue; }
  console.log(`${a.nickname}  合计 ${c.remain}`);
  (c.packs || []).filter((p) => p.remain > 0)
    .forEach((p) => console.log(`    ${String(p.remain).padStart(6)}  ${p.end || '永久'}`));
}
