// OP.GG 代轉的測試：格式解析（離線）＋ 真的打一次 OP.GG（線上，加 --live 才跑）
// 用法：node tests/worker.test.mjs [--live]
import assert from 'node:assert/strict';
import { parseOpggText } from '../worker/src/opgg-format.js';
import worker, { getMeta, getMatchup, toOpggName } from '../worker/src/index.js';

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e}`); process.exitCode = 1; }
};

console.log('格式解析');
await test('巢狀類別＋清單＋字串跳脫', () => {
  const text = [
    'class LolListChampions: data',
    'class Data: champions',
    'class Champion: champion_id,key,name',
    '',
    'LolListChampions(Data([Champion(1,"Annie","安妮"),Champion(145,"Kaisa","Kai\'Sa"),Champion(36,"DrMundo","Dr. \\"M\\"")]))',
  ].join('\n');
  const r = parseOpggText(text);
  assert.equal(r.data.champions.length, 3);
  assert.deepEqual(r.data.champions[0], { champion_id: 1, key: 'Annie', name: '安妮' });
  assert.equal(r.data.champions[1].name, "Kai'Sa");
  assert.equal(r.data.champions[2].name, 'Dr. "M"');
});
await test('布林、null、小數、負數、空清單', () => {
  const text = 'class Row: a,b,c,d,e,f\n\nRow(true,false,null,0.63,-1.5,[])';
  assert.deepEqual(parseOpggText(text), { a: true, b: false, c: null, d: 0.63, e: -1.5, f: [] });
});
await test('參數比欄位少時補 null', () => {
  assert.deepEqual(parseOpggText('class R: a,b\n\nR(1)'), { a: 1, b: null });
});
await test('壞掉的格式會丟錯誤', () => {
  assert.throws(() => parseOpggText('class R: a\n\nR(1'), /解析失敗/);
});

await test('英雄名稱轉 OP.GG 格式', () => {
  assert.equal(toOpggName("Kai'Sa"), 'KAISA');
  assert.equal(toOpggName('Dr. Mundo'), 'DR_MUNDO');
  assert.equal(toOpggName('Nunu & Willump'), 'NUNU_WILLUMP');
  assert.equal(toOpggName('Jarvan IV'), 'JARVAN_IV');
  assert.equal(toOpggName('Lee Sin'), 'LEE_SIN');
});

console.log('Worker 路由（不連網）');
const call = (path, origin = 'https://bigshop127.github.io', method = 'GET') =>
  worker.fetch(new Request(`https://w.example${path}`, { method, headers: origin ? { Origin: origin } : {} }), {}, null);
await test('沒有 Origin 或別的網站 → 403', async () => {
  assert.equal((await call('/meta', '')).status, 403);
  assert.equal((await call('/meta', 'https://evil.example')).status, 403);
});
await test('OPTIONS 預檢回 CORS 標頭', async () => {
  const r = await call('/meta', 'http://localhost:8080', 'OPTIONS');
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
});
await test('matchup 參數不合法 → 400', async () => {
  assert.equal((await call('/matchup?champ=103&pos=xx&vs=134')).status, 400);
  assert.equal((await call('/matchup?champ=Ahri&pos=mid&vs=134')).status, 400);
  assert.equal((await call('/matchup?champ=103&pos=mid')).status, 400);
});
await test('未知路徑 → 404', async () => {
  assert.equal((await call('/nope')).status, 404);
});

if (process.argv.includes('--live')) {
  console.log('線上（真的連 OP.GG）');
  await test('meta：五路都有資料、能對上英雄代號', async () => {
    const m = await getMeta();
    const ids = Object.keys(m.champions);
    assert.ok(ids.length > 120, `英雄數 ${ids.length}`);
    const ahri = m.champions['103'];
    assert.equal(ahri.key, 'Ahri');
    assert.ok(ahri.positions.mid && ahri.positions.mid.wr > 0.3 && ahri.positions.mid.wr < 0.7, JSON.stringify(ahri));
    for (const p of ['top', 'jungle', 'mid', 'adc', 'support']) {
      assert.ok(Object.values(m.champions).some(c => c.positions[p]), `缺 ${p}`);
    }
    console.log(`       英雄 ${ids.length} 隻，對不上名字的：${JSON.stringify(m.unmatched)}`);
  });
  await test('matchup：阿璃 vs 星朵拉 有對位戰績', async () => {
    const r = await getMatchup(103, 'mid', 134);
    assert.ok(r.counters.length >= 5, `counters ${r.counters.length}`);
    const syn = r.counters.find(c => c.id === 134);
    assert.ok(syn && syn.play > 0, JSON.stringify(r.counters.slice(0, 5)));
    console.log(`       對位數 ${r.counters.length}，對星朵拉 ${syn.win}/${syn.play}，提示：${r.tip.slice(0, 50)}…`);
  });
  await test('matchup：名字有空格／符號的英雄（李星 vs 悟空、凱莎 vs 好運姐）', async () => {
    assert.ok((await getMatchup(64, 'jungle', 62)).counters.length > 0);
    assert.ok((await getMatchup(145, 'adc', 21)).counters.length > 0);
  });
  await test('meta：特殊版本英雄（Jade_ 開頭）不會蓋掉一般英雄', async () => {
    const m = await getMeta();
    assert.ok(!Object.keys(m.champions).some(id => Number(id) >= 10000));
    assert.equal(m.champions['1']?.key, 'Annie');
  });
  await test('Worker 完整走一次 /matchup', async () => {
    const r = await call('/matchup?champ=103&pos=mid&vs=134');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.counters.some(c => c.id === 134));
  });
  await test('Worker 完整走一次 /meta（含 CORS）', async () => {
    const r = await call('/meta');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://bigshop127.github.io');
    const j = await r.json();
    assert.ok(Object.keys(j.champions).length > 120);
  });
}

console.log(`\n${passed} 項通過${process.exitCode ? '，有失敗' : ''}`);
