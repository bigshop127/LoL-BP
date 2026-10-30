// Firestore 規則測試（跑在本機模擬器，不碰正式資料）
// 用法：npm run test:rules
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp, deleteField } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'lol-bp-fearless',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 },
});

const emptyGame = () => ({ bluePicks: [null, null, null, null, null], redPicks: [null, null, null, null, null], blueBans: [], redBans: [] });
const room = (over = {}) => ({
  passwordHash: 'a'.repeat(64),
  matchMode: '5v5', fearlessMode: 'hard', g1BanCount: 3, g2BanCount: 2, currentGame: 1,
  blueTeamName: '藍方隊伍', redTeamName: '紅方隊伍', manualDisabledChamps: [],
  games: { 1: emptyGame(), 2: emptyGame() },
  updatedAt: serverTimestamp(),
  ...over,
});

let passed = 0;
const test = async (name, fn) => {
  await env.clearFirestore();
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e}`); process.exitCode = 1; }
};
const db = () => env.unauthenticatedContext().firestore();
const seed = async (id, data) => env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'rooms', id), data));

await test('可以建立正常的房間', async () => {
  await assertSucceeds(setDoc(doc(db(), 'rooms', 'r1'), room()));
});
await test('沒密碼的房間（passwordHash 空字串）也可以建', async () => {
  await assertSucceeds(setDoc(doc(db(), 'rooms', 'r1'), room({ passwordHash: '' })));
});
await test('知道房號可以讀', async () => {
  await seed('r1', room());
  await assertSucceeds(getDoc(doc(db(), 'rooms', 'r1')));
});
await test('不能列出所有房間', async () => {
  await seed('r1', room());
  await assertFails(getDocs(collection(db(), 'rooms')));
});
await test('可以逐欄更新選角', async () => {
  await seed('r1', room());
  await assertSucceeds(updateDoc(doc(db(), 'rooms', 'r1'), { 'games.1.bluePicks': ['Ahri', null, null, null, null], updatedAt: serverTimestamp() }));
});
await test('可以新增第 6 局', async () => {
  await seed('r1', room());
  await assertSucceeds(updateDoc(doc(db(), 'rooms', 'r1'), { 'games.6.bluePicks': [null], 'games.6.redPicks': [null], 'games.6.blueBans': [], 'games.6.redBans': [] }));
});
await test('不能改密碼雜湊（輸錯密碼的人蓋不掉房間）', async () => {
  await seed('r1', room());
  await assertFails(setDoc(doc(db(), 'rooms', 'r1'), room({ passwordHash: 'b'.repeat(64) })));
  await assertFails(updateDoc(doc(db(), 'rooms', 'r1'), { passwordHash: '' }));
  await assertFails(updateDoc(doc(db(), 'rooms', 'r1'), { passwordHash: deleteField() }));
});
await test('不能刪房間', async () => {
  await seed('r1', room());
  await assertFails(deleteDoc(doc(db(), 'rooms', 'r1')));
});
await test('不收奇怪的欄位或數值', async () => {
  await assertFails(setDoc(doc(db(), 'rooms', 'r1'), room({ hacked: true })));
  await assertFails(setDoc(doc(db(), 'rooms', 'r2'), room({ matchMode: '6v6' })));
  await assertFails(setDoc(doc(db(), 'rooms', 'r3'), room({ g1BanCount: 99 })));
  await assertFails(setDoc(doc(db(), 'rooms', 'r4'), room({ currentGame: 0 })));
  await assertFails(setDoc(doc(db(), 'rooms', 'r5'), room({ blueTeamName: 'x'.repeat(41) })));
  await assertFails(setDoc(doc(db(), 'rooms', 'r6'), room({ manualDisabledChamps: 'Ahri' })));
});
await test('1v1～5v5 五種模式都可以建房、也可以中途改', async () => {
  for (const m of ['1v1', '2v2', '3v3', '4v4', '5v5']) {
    await assertSucceeds(setDoc(doc(db(), 'rooms', `m-${m}`), room({ matchMode: m })));
  }
  await assertSucceeds(updateDoc(doc(db(), 'rooms', 'm-5v5'), { matchMode: '3v3', 'games.1.bluePicks': [null, null, null] }));
  await assertFails(updateDoc(doc(db(), 'rooms', 'm-5v5'), { matchMode: '0v0' }));
});
await test('房號太長不行', async () => {
  await assertFails(setDoc(doc(db(), 'rooms', 'x'.repeat(65)), room()));
});
await test('Ban 位 0 可以存', async () => {
  await seed('r1', room());
  await assertSucceeds(updateDoc(doc(db(), 'rooms', 'r1'), { g1BanCount: 0, g2BanCount: 0 }));
});

await test('英雄池抽選 draft：可以建、可以逐欄更新；欄位亂寫不行', async () => {
  const draft = { reps: ['The shy', '老蔡', '小胖', '攻訐'], blueRep: 0, redRep: 1, blueSize: 10, redSize: 10, drawCount: 3,
    bluePool: ['Ahri'], redPool: ['Zed'], draws: { 1: ['Ahri', 'Zed'] } };
  await assertSucceeds(setDoc(doc(db(), 'rooms', 'd1'), room({ draft })));
  await assertSucceeds(updateDoc(doc(db(), 'rooms', 'd1'), { 'draft.bluePool': ['Ahri', 'Jinx'], 'draft.draws.2': ['Jinx'] }));
  await seed('d2', room()); // 舊房間沒有 draft，第一次更新只帶部分欄位
  await assertSucceeds(updateDoc(doc(db(), 'rooms', 'd2'), { 'draft.blueRep': 2 }));
  await assertFails(updateDoc(doc(db(), 'rooms', 'd2'), { 'draft.blueSize': 0 }));
  await assertFails(updateDoc(doc(db(), 'rooms', 'd2'), { 'draft.blueSize': 201 }));
  await assertFails(updateDoc(doc(db(), 'rooms', 'd2'), { 'draft.bluePool': Array(201).fill('x') }));
  await assertFails(updateDoc(doc(db(), 'rooms', 'd2'), { 'draft.drawCount': 'many' }));
  await assertFails(setDoc(doc(db(), 'rooms', 'd3'), room({ draft: 'oops' })));
});

await env.cleanup();
assert.ok(passed > 0);
console.log(`\n規則測試 ${passed} 項通過${process.exitCode ? '，有失敗' : ''}`);
