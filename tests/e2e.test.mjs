// 端對端測試：三個無頭瀏覽器（創造者、朋友、輸錯密碼的人）同時連同一個房間
// 跑在 Firestore 模擬器上，不碰正式資料；OP.GG 走本機啟動的 Worker（會真的連 OP.GG）
// 用法：npm run test:e2e
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import worker from '../worker/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PORT = 8080, WORKER_PORT = 8787, EMU_PORT = 8085;
mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });

// ---- 本機網頁伺服器 ----
const web = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(await readFile(file));
}).listen(WEB_PORT);

// ---- 本機 Worker（把 Node 的請求轉給 worker.fetch）----
let workerHits = 0;
const workerServer = http.createServer(async (req, res) => {
  workerHits++;
  const r = await worker.fetch(new Request(`http://localhost:${WORKER_PORT}${req.url}`, { method: req.method, headers: req.headers }), {}, null);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(WORKER_PORT);

const exe = [
  `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1217/chrome-win64/chrome.exe`,
  `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1208/chrome-win64/chrome.exe`,
].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true });

const URL_BASE = `http://localhost:${WEB_PORT}/?emu=${EMU_PORT}&opgg=http://localhost:${WORKER_PORT}`;
const ROOM = `e2e-${Date.now()}`;

const errors = [];
async function openPage(label, viewport = { width: 1500, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`[${label}] ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/cdn\.tailwindcss|Failed to load resource/.test(t)) return; // 載入失敗改由 response 事件記錄（含網址）
    errors.push(`[${label}] ${t}`);
  });
  page.opggRequests = 0;
  page.on('request', r => { if (new URL(r.url()).port === String(WORKER_PORT)) page.opggRequests++; });
  page.on('response', r => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`[${label}] HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(URL_BASE);
  await page.waitForFunction(() => document.querySelectorAll('#championGrid > div').length > 150, null, { timeout: 30000 });
  return page;
}

const toast = (page) => page.locator('#toastMsg').innerText();
async function join(page, roomId, password) {
  await page.click('#btnRoomModal');
  await page.fill('#modalRoomIdInput', roomId);
  await page.fill('#modalRoomPasswordInput', password);
  await page.click('#btnJoinRoom');
}
const card = (page, id) => page.locator(`#championGrid > div[onclick="clickChampion('${id}')"]`);
const isCardDisabled = async (page, id) => (await card(page, id).getAttribute('class')).includes('disabled-champ');
async function pick(page, side, type, index, champId) {
  await page.click(`#${side}${type === 'pick' ? 'Pick' : 'Ban'}Slots > div:nth-child(${index + 1})`);
  await card(page, champId).click();
}
const waitText = (page, sel, text, timeout = 10000) =>
  page.waitForFunction(([s, t]) => (document.querySelector(s)?.innerText || '').includes(t), [sel, text], { timeout });

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e}`); process.exitCode = 1; }
};

const A = await openPage('創造者');
const B = await openPage('朋友');
const C = await openPage('輸錯密碼');

await test('房間視窗沒有創造者模式提示、密碼欄沒有 ** 字樣', async () => {
  await A.click('#btnRoomModal');
  const modalText = await A.locator('#roomModal').innerText();
  assert.ok(!modalText.includes('創造者模式提示'), modalText);
  assert.ok(!modalText.includes('**'));
  assert.ok(!(await A.getAttribute('#modalRoomPasswordInput', 'placeholder')).includes('**'));
  await A.click('#roomModal button[onclick="closeRoomModal()"]');
});

await test('房號不能有 /', async () => {
  await join(A, 'a/b', 'x');
  await waitText(A, '#toastMsg', '不能有');
  await A.click('#roomModal button[onclick="closeRoomModal()"]');
});

await test('創造者（**abc）建房、朋友（abc）加入同一房', async () => {
  await join(A, ROOM, '**abc');
  await waitText(A, '#roomStatusText', `房號: ${ROOM}`);
  await join(B, ROOM, 'abc');
  await waitText(B, '#roomStatusText', `房號: ${ROOM}`);
  assert.ok(await A.locator('#creatorBanner').isVisible(), '創造者應該看到 OP.GG 橫幅');
  assert.ok(!(await B.locator('#creatorBanner').isVisible()), '朋友不該看到 OP.GG 橫幅');
  assert.ok(!(await B.locator('#creatorBadge').isVisible()));
});

await test('創造者模式連上 OP.GG，卡片顯示真的勝率', async () => {
  await waitText(A, '#opggStatusText', '已連線', 60000);
  const badge = await card(A, 'Ahri').innerText();
  assert.match(badge, /\d+\.\d%\s*OP\.GG/, badge);
  const title = await card(A, 'Ahri').locator('div[title]').getAttribute('title');
  assert.match(title, /勝率 \d+\.\d%｜登場 \d+\.\d%｜禁用 \d+\.\d%/, title);
});

await test('朋友那邊完全沒有 OP.GG（沒顯示、也沒發出請求）', async () => {
  assert.equal(await B.locator('#championGrid').getByText('OP.GG').count(), 0);
  assert.equal(B.opggRequests, 0);
});

await test('創造者選的角，朋友畫面即時出現', async () => {
  await pick(A, 'blue', 'pick', 0, 'Ahri');
  await waitText(B, '#bluePickSlots', '阿璃');
});

await test('朋友選紅方後，創造者橫幅顯示 OP.GG 對位（阿璃 vs 星朵拉）', async () => {
  await pick(B, 'red', 'pick', 0, 'Syndra');
  await waitText(A, '#creatorMatchupSummary', '對決', 10000);
  await A.waitForFunction(() => /對位勝率: [\d.]+%|場數還不夠/.test(document.querySelector('#creatorMatchupSummary').innerText), null, { timeout: 60000 });
  const summary = await A.locator('#creatorMatchupSummary').innerText();
  const link = await A.locator('#creatorMatchupSummary a').getAttribute('href');
  assert.equal(link, 'https://op.gg/zh-tw/lol/champions/ahri/counters/mid?target_champion=syndra');
  console.log(`       橫幅：${summary.replace(/\s+/g, ' ')}`);
  const pickBadge = A.locator('#bluePickSlots a[href*="op.gg"]').first();
  assert.equal(await pickBadge.getAttribute('href'), 'https://op.gg/zh-tw/lol/champions/ahri/build/mid');
});

await test('兩個人同時點不同格，兩邊的選擇都保留', async () => {
  await A.click('#bluePickSlots > div:nth-child(2)');
  await B.click('#redPickSlots > div:nth-child(2)');
  await Promise.all([card(A, 'LeeSin').click(), card(B, 'Garen').click()]);
  for (const page of [A, B]) {
    await waitText(page, '#bluePickSlots', '李星');
    await waitText(page, '#redPickSlots', '蓋倫');
  }
});

await test('跳著點 Ban 位（先 B2）也能同步', async () => {
  await pick(A, 'blue', 'ban', 1, 'Zed');
  await B.waitForFunction(() => !!document.querySelector('#blueBanSlots > div:nth-child(2) img[src*="Zed"]'), null, { timeout: 10000 });
});

await test('輸錯密碼：擋下，而且之後亂點也蓋不掉房間', async () => {
  await join(C, ROOM, 'wrong');
  await waitText(C, '#toastMsg', '房間密碼錯誤');
  assert.ok(!(await C.locator('#roomStatusText').innerText()).includes('房號'));
  await C.click('#roomModal button[onclick="closeRoomModal()"]');
  await pick(C, 'blue', 'pick', 0, 'Jinx');
  await B.waitForTimeout(1500);
  assert.ok((await B.locator('#bluePickSlots').innerText()).includes('阿璃'));
  assert.ok(!(await B.locator('#bluePickSlots').innerText()).includes('吉茵珂絲'));
});

await test('一鍵全禁（上單分頁）：只禁上單；切 Game 2、朋友那邊都維持', async () => {
  await A.click('#roleFilters button:has-text("上單 TOP")');
  await A.click('#btnBanAll');
  await waitText(A, '#toastMsg', '上單');
  const topCards = await A.locator('#championGrid > div').count();
  const disabledTop = await A.locator('#championGrid > div.disabled-champ').count();
  assert.equal(disabledTop, topCards, `上單分頁 ${topCards} 隻應全部禁用，實際 ${disabledTop}`);
  await A.click('#roleFilters button:has-text("全部")');
  assert.ok(!(await isCardDisabled(A, 'Jinx')), '下路的吉茵珂絲不該被禁');
  assert.ok(await isCardDisabled(A, 'Darius'), '上單的達瑞斯要被禁');
  await B.waitForFunction(() => document.querySelector(`#championGrid > div[onclick="clickChampion('Darius')"]`)?.innerText.includes('已禁用'), null, { timeout: 10000 });
  assert.ok(!(await isCardDisabled(B, 'Jinx')));
  await A.click('#gameTabs button:has-text("Game 2")');
  await waitText(B, '#displayBanCount', '雙方各 2 隻');
  assert.ok(await isCardDisabled(A, 'Darius'));
  assert.ok(await isCardDisabled(B, 'Darius'));
  assert.ok(!(await isCardDisabled(B, 'Jinx')));
});

await test('原本的硬全局規則還在：Game 1 選過的阿璃在 Game 2 顯示全局BAN', async () => {
  assert.ok((await card(B, 'Ahri').innerText()).includes('全局BAN'));
  await pick(B, 'blue', 'pick', 0, 'Ahri');
  await waitText(B, '#toastMsg', '全局禁用');
});

await test('Game 1 Ban 掉的劫，在 Game 2 也顯示全局BAN、不能再 Ban 或選', async () => {
  for (const page of [A, B]) assert.ok((await card(page, 'Zed').innerText()).includes('全局BAN'));
  await pick(B, 'red', 'ban', 0, 'Zed');
  await waitText(B, '#toastMsg', '全局禁用');
  assert.ok(!(await B.locator('#redBanSlots img[src*="Zed"]').count()));
});

await test('一鍵全開（上單分頁）：上單恢復，其他手動禁用不受影響', async () => {
  await A.click('#roleFilters button:has-text("下路 ADC")');
  await A.click('#btnBanAll'); // 先多禁下路
  await A.click('#roleFilters button:has-text("上單 TOP")');
  await A.click('#btnUnbanAll');
  await waitText(A, '#toastMsg', '已解除');
  await A.click('#roleFilters button:has-text("全部")');
  // 純上單（不走下路）的應該恢復；下路的吉茵珂絲維持禁用
  await B.waitForFunction(() => !document.querySelector(`#championGrid > div[onclick="clickChampion('Darius')"]`).className.includes('disabled-champ'), null, { timeout: 10000 });
  assert.ok(await isCardDisabled(B, 'Jinx'));
});

await test('搜尋＋全部分頁：一鍵全禁只禁搜尋結果，再全開清乾淨', async () => {
  await A.click('#roleFilters button:has-text("全部")');
  await A.fill('#searchInput', '');
  await A.click('#btnUnbanAll'); // 全部清掉
  await A.fill('#searchInput', '阿璃');
  await A.click('#btnBanAll');
  await waitText(A, '#toastMsg', '搜尋「阿璃」');
  await A.fill('#searchInput', '');
  await A.dispatchEvent('#searchInput', 'input');
  const disabledAll = await A.locator('#championGrid > div.disabled-champ').count();
  // 只有阿璃被手動禁（加上 Game 1 硬全局的阿璃、李星、星朵拉、蓋倫、劫）
  assert.ok(disabledAll <= 5, `禁用數 ${disabledAll}`);
  await A.click('#btnBanAll');
  const total = await A.locator('#championGrid > div').count();
  assert.equal(await A.locator('#championGrid > div.disabled-champ').count(), total, '全部分頁全禁 → 全部禁用');
  await A.click('#btnUnbanAll');
  await B.waitForFunction(() => document.querySelectorAll('#championGrid > div.disabled-champ').length <= 5, null, { timeout: 10000 });
});

await test('Ban 位數可以設成 0', async () => {
  await A.click('button[onclick="openSettingsModal()"]');
  await A.fill('#g2BanCountInput', '0');
  await A.click('#settingsModal button[onclick="saveSettings()"]');
  await waitText(B, '#displayBanCount', '雙方各 0 隻');
});

await test('創造者重開房間視窗，密碼欄保留 **（重新加入不會掉創造者模式）', async () => {
  await A.click('#btnRoomModal');
  assert.equal(await A.inputValue('#modalRoomPasswordInput'), '**abc');
  await A.click('#roomModal button[onclick="closeRoomModal()"]');
});

await test('只顯示可用：藏起全局BAN／本局已用／手動禁用的英雄，只影響自己這台', async () => {
  // 現在在 Game 2（硬全局）：Game 1 的阿璃、李星、星朵拉、蓋倫、劫都是全局BAN
  await A.click('#btnAvailableOnly');
  assert.equal(await A.locator('#championGrid > div.disabled-champ').count(), 0, '開了之後不該有灰掉的卡片');
  assert.equal(await card(A, 'Ahri').count(), 0);
  assert.equal(await card(A, 'Zed').count(), 0);
  assert.equal(await card(A, 'Jinx').count(), 1);
  await waitText(A, '#champCountText', '藏起 5 隻');
  // 本局選走的也會藏起來
  await pick(A, 'blue', 'pick', 0, 'Jinx');
  await waitText(A, '#bluePickSlots', '吉茵珂絲');
  assert.equal(await card(A, 'Jinx').count(), 0);
  await waitText(A, '#champCountText', '藏起 6 隻');
  // 手動禁用的也藏起來；篩選結果全部不能選時顯示提示
  await A.fill('#searchInput', '達瑞斯');
  await A.click('#btnBanAll');
  await waitText(A, '#championGrid', '都不能選了');
  await A.click('#btnUnbanAll');
  await A.waitForFunction(() => !!document.querySelector(`#championGrid > div[onclick="clickChampion('Darius')"]`), null, { timeout: 5000 });
  await A.fill('#searchInput', '');
  // 朋友那邊照常顯示全部（灰掉）
  await waitText(B, '#bluePickSlots', '吉茵珂絲');
  assert.ok(await isCardDisabled(B, 'Ahri'));
  assert.ok(!(await B.locator('#champCountText').innerText()).includes('藏起'));
  // 關掉恢復原狀
  await A.click('#btnAvailableOnly');
  assert.ok(await isCardDisabled(A, 'Ahri'));
  assert.ok((await A.locator('#champCountText').innerText()).startsWith('顯示'));
});

const setMode = async (page, mode) => {
  await page.click('button[onclick="openSettingsModal()"]');
  await page.click(`#matchModeOptions label:has(input[value="${mode}"])`);
  await page.click('#settingsModal button[onclick="saveSettings()"]');
};
const slotCountIs = (page, n) => page.waitForFunction(
  (n) => document.querySelectorAll('#bluePickSlots > div').length === n && document.querySelectorAll('#redPickSlots > div').length === n,
  n, { timeout: 10000 });

await test('改成 3v3：雙方都變 3 個 Pick 位，前幾局已選的保留', async () => {
  await setMode(A, '3v3');
  await waitText(B, '#displayMatchMode', '3 vs 3');
  await slotCountIs(B, 3);
  await slotCountIs(A, 3);
  await A.click('#gameTabs button:has-text("Game 1")');
  for (const page of [A, B]) {
    await waitText(page, '#bluePickSlots', '李星');
    assert.ok((await page.locator('#bluePickSlots').innerText()).includes('阿璃'));
    assert.ok((await page.locator('#redPickSlots').innerText()).includes('蓋倫'));
  }
  // 重開設定視窗，3v3 是選取狀態
  await B.click('button[onclick="openSettingsModal()"]');
  assert.ok(await B.isChecked('#matchModeOptions input[value="3v3"]'));
  await B.screenshot({ path: path.join(ROOT, 'test-results', 'settings-3v3.png') });
  await B.click('#settingsModal button[onclick="closeSettingsModal()"]');
});

await test('朋友改成 2v2：多出來的 Pick 清掉並提示，我選到一半的格子自動取消', async () => {
  await pick(A, 'blue', 'pick', 2, 'Lux');
  await waitText(B, '#bluePickSlots', '拉克絲');
  await A.click('#redPickSlots > div:nth-child(3)');
  await waitText(A, '#displayActiveSlot', '紅方 Pick 3');
  await setMode(B, '2v2');
  await waitText(B, '#toastMsg', '清掉 1 個');
  await slotCountIs(A, 2);
  await waitText(A, '#displayActiveSlot', '自由選擇模式');
  assert.ok(!(await A.locator('#bluePickSlots').innerText()).includes('拉克絲'));
  assert.ok(!(await isCardDisabled(A, 'Lux')), '被清掉的拉克絲要能再選');
  await card(A, 'Lux').click();
  await waitText(A, '#toastMsg', '請先點選');
});

await test('4v4、再回 5v5：Pick 位跟著變，已選的都還在', async () => {
  await setMode(A, '4v4');
  await slotCountIs(B, 4);
  await waitText(B, '#displayMatchMode', '4 vs 4');
  await setMode(A, '5v5');
  await slotCountIs(B, 5);
  assert.ok((await B.locator('#bluePickSlots').innerText()).includes('阿璃'));
  assert.ok((await B.locator('#bluePickSlots').innerText()).includes('李星'));
});

await test('複製全部對戰：每一局都在、沒選任何英雄的局數略過；本局戰報照舊', async () => {
  await A.evaluate(() => {
    document.execCommand = () => { window.__copied = [...document.querySelectorAll('body > textarea')].pop()?.value; return true; };
  });
  await A.click('#btnCopyAll');
  await waitText(A, '#toastMsg', '已複製全部對戰（2 局）');
  const text = await A.evaluate(() => window.__copied);
  console.log(`       全部對戰：\n${text.split('\n').map(l => '         ' + l).join('\n')}`);
  assert.ok(text.includes('共 2 局'));
  assert.ok(text.includes('----- Game 1 -----') && text.includes('----- Game 2 -----'));
  assert.ok(!text.includes('Game 3'));
  assert.ok(text.includes(`對戰房：${ROOM}`));
  assert.ok(text.includes('5v5 團隊 (硬全局)'));
  assert.ok(text.indexOf('阿璃') < text.indexOf('----- Game 2 -----'), 'Game 1 的阿璃要在 Game 2 前面');
  assert.ok(text.indexOf('吉茵珂絲') > text.indexOf('----- Game 2 -----'));
  assert.ok(text.includes('禁用：無, 劫'));
  await A.click('button[onclick="copyDraftSummary()"]');
  await waitText(A, '#toastMsg', '已成功複製 BP 戰報');
  const single = await A.evaluate(() => window.__copied);
  assert.ok(single.startsWith('=== 英雄聯盟 BP戰報 (Game 1) ==='), single);
  assert.ok(!single.includes('吉茵珂絲'));
});

await test('下載全部 .txt：檔名有房號與日期、內容同複製全部', async () => {
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#btnDownloadAll')]);
  assert.match(dl.suggestedFilename(), new RegExp(`^LoL-BP_${ROOM}_\\d{4}-\\d{2}-\\d{2}\\.txt$`));
  const content = await readFile(await dl.path(), 'utf8');
  assert.ok(content.startsWith('﻿'), '開頭要有 BOM');
  assert.ok(content.includes('\r\n'));
  assert.ok(content.includes('----- Game 2 -----') && content.includes('吉茵珂絲'));
  await waitText(A, '#toastMsg', '已下載全部對戰（2 局）');
});

const gameOf = (page, g) => page.evaluate((g) => JSON.parse(JSON.stringify(window.roomState.games[g])), g);
const champName = (page, id) => page.evaluate((id) => window.championsMap[id].name, id);
const setRole = (page, label) => page.click(`#roleFilters button:has-text("${label}")`);
// Game 1 已經被選走／禁掉的：阿璃、李星（藍 Pick）、星朵拉、蓋倫（紅 Pick）、劫（藍 Ban 2）
const G1_TAKEN = ['Ahri', 'LeeSin', 'Syndra', 'Garen', 'Zed'];

await test('隨機（單格）：沒選欄位會提示；照篩選抽、只剩一隻能抽就一定是它，抽完再按提示沒得抽', async () => {
  await A.click('#gameTabs button:has-text("Game 1")'); // 換局會取消選取
  await A.click('#btnRandomOne');
  await waitText(A, '#toastMsg', '請先點選');
  // 上單只留達瑞斯能用（蓋倫本局已被選走）
  await setRole(A, '上單 TOP');
  await A.click('#btnBanAll');
  await A.fill('#searchInput', '達瑞斯');
  await A.click('#btnUnbanAll');
  await A.fill('#searchInput', '');
  await A.dispatchEvent('#searchInput', 'input');
  await A.click('#bluePickSlots > div:nth-child(3)');
  await A.click('#btnRandomOne');
  await waitText(A, '#toastMsg', '藍方 Pick 3 隨機抽到：達瑞斯（從 1 隻可用的裡面抽）');
  assert.equal((await gameOf(A, 1)).bluePicks[2], 'Darius');
  await waitText(A, '#displayActiveSlot', '藍方 Pick 4');
  await waitText(B, '#bluePickSlots', '達瑞斯');
  await A.click('#btnRandomOne');
  await waitText(A, '#toastMsg', '目前篩選（上單）已經沒有能抽的英雄了');
  assert.equal((await gameOf(A, 1)).bluePicks[3], null, '沒得抽時不能亂填');
  await A.click('#btnUnbanAll');
  await setRole(A, '全部');
});

await test('隨機（單格）：從全部可用的抽、跳下一格、格子閃一下、朋友同步；重抽一定換一隻', async () => {
  await A.click('#bluePickSlots > div:nth-child(4)');
  await A.click('#btnRandomOne');
  await waitText(A, '#toastMsg', '藍方 Pick 4 隨機抽到');
  const first = (await gameOf(A, 1)).bluePicks[3];
  assert.ok(first && ![...G1_TAKEN, 'Darius'].includes(first), `抽到不能用的 ${first}`);
  assert.ok((await A.locator('#bluePickSlots > div:nth-child(4)').getAttribute('class')).includes('random-flash'));
  await waitText(A, '#displayActiveSlot', '藍方 Pick 5');
  await waitText(B, '#bluePickSlots', await champName(A, first));
  // 點回同一格再抽：原本那隻算本局已用，一定換成別隻
  await A.click('#bluePickSlots > div:nth-child(4)');
  await A.click('#btnRandomOne');
  await A.waitForFunction((old) => window.roomState.games[1].bluePicks[3] !== old, first, { timeout: 5000 });
  const second = (await gameOf(A, 1)).bluePicks[3];
  assert.ok(second && ![...G1_TAKEN, 'Darius', first].includes(second), `重抽抽到 ${second}`);
  await waitText(B, '#bluePickSlots', await champName(A, second));
});

await test('隨機補滿本局：只補空的 Pick、Ban 不動、不重複，全局BAN／手動禁用的都不會出現，朋友同步', async () => {
  await A.click('#gameTabs button:has-text("Game 2")');
  await setRole(A, '下路 ADC');
  await A.click('#btnBanAll'); // 下路全部手動禁用（Game 2 已選的吉茵珂絲也是下路，要原地保留）
  await setRole(A, '全部');
  const g1 = await gameOf(A, 1);
  const manual = await A.evaluate(() => [...window.roomState.manualDisabledChamps]);
  const blocked = new Set([...manual, ...g1.bluePicks, ...g1.redPicks, ...g1.blueBans, ...g1.redBans].filter(Boolean));
  await A.click('#btnRandomFill');
  await waitText(A, '#toastMsg', '已隨機補滿 9 個 Pick 位（全部英雄）');
  const g2 = await gameOf(A, 2);
  assert.equal(g2.bluePicks[0], 'Jinx', '已經選好的不能動');
  const picks = [...g2.bluePicks, ...g2.redPicks];
  assert.equal(picks.filter(Boolean).length, 10);
  assert.equal(new Set(picks).size, 10, '同一局不能重複');
  picks.slice(1).forEach(id => assert.ok(!blocked.has(id), `抽到鎖住的 ${id}`));
  assert.ok(![...g2.blueBans, ...g2.redBans].some(Boolean), 'Ban 位不能動');
  assert.ok((await A.locator('#redPickSlots > div:nth-child(5)').getAttribute('class')).includes('random-flash'));
  await B.waitForFunction((want) => JSON.stringify([...window.roomState.games[2].bluePicks, ...window.roomState.games[2].redPicks]) === want,
    JSON.stringify(picks), { timeout: 10000 });
  await A.click('#btnRandomFill');
  await waitText(A, '#toastMsg', 'Game 2 雙方的 Pick 位都已經選好了');
  await setRole(A, '下路 ADC');
  await A.click('#btnUnbanAll');
  await setRole(A, '全部');
  await A.screenshot({ path: path.join(ROOT, 'test-results', 'random-fill.png') });
});

await test('剋星（創造者限定）：選了英雄自動列 5 隻、依克制程度排；下方分析有金牌／翡翠／鑽石；對面不能選的照列變灰、只看不能點', async () => {
  const E = await openPage('剋星');
  const urls = { counters: [], tiers: [] };
  E.on('request', r => { const m = /\/(counters|tiers)\?/.exec(r.url()); if (m) urls[m[1]].push(new URL(r.url()).search); });
  await join(E, `${ROOM}-c`, '**x');
  await waitText(E, '#opggStatusText', '已連線', 60000);

  const rowIds = (side, i) => E.locator(`#${side}PickSlots > div:nth-child(${i + 1}) [data-counter]`).evaluateAll(els => els.map(e => e.dataset.counter));
  const waitRow = (side, i) => E.waitForFunction(([s, i]) =>
    document.querySelectorAll(`#${s}PickSlots > div:nth-child(${i + 1}) [data-counter]`).length === 5, [side, i], { timeout: 60000 });
  // 分析區：等名單和三個分段都讀完
  const waitPanel = (side, champ) => E.waitForFunction(([s, c]) => {
    const p = document.querySelector(`#${s}CounterPanel .counter-panel`);
    return p && p.dataset.champ === c && p.querySelectorAll('li[data-counter]').length === 5
      && !p.querySelector('.animate-pulse') && !/讀取中/.test(p.innerText);
  }, [side, champ], { timeout: 60000 });
  const panel = (side) => E.evaluate((s) => {
    const p = document.querySelector(`#${s}CounterPanel .counter-panel`);
    return {
      champ: p.dataset.champ,
      text: p.innerText,
      list: [...p.querySelectorAll('li[data-counter]')].map(e => ({
        id: e.dataset.counter, source: e.dataset.source, blocked: !!e.dataset.blocked,
        wr: e.dataset.wr === '' ? null : Number(e.dataset.wr), play: Number(e.dataset.play), text: e.innerText,
      })),
      tiers: Object.fromEntries([...p.querySelectorAll('[data-tier]')].map(t => [t.dataset.tier,
        [...t.querySelectorAll('[data-tier-counter]')].map(e => ({ id: e.dataset.tierCounter, blocked: !!e.dataset.blocked, title: e.title }))])),
    };
  }, side);
  const rel = (play) => (play >= 50 ? 0 : play >= 20 ? 1 : 2);
  const assertSorted = (list) => list.slice(1).forEach((b, i) => {
    const a = list[i];
    assert.ok(rel(a.play) < rel(b.play) || (rel(a.play) === rel(b.play) && (a.wr ?? -1) >= (b.wr ?? -1)), JSON.stringify(list.map(x => [x.id, x.wr, x.play])));
  });
  // 勝率要跟 Worker 回的原始數據對得上（他對這隻英雄的勝率＝1－這隻英雄贏的場數／總場數）
  const assertMatchesWorker = async (champ, pos, p) => {
    const raw = await E.evaluate(([c, pos]) => {
      const champ = window.championsMap[c];
      const key = `${champ.numId}:${pos}`;
      return { counters: window.opgg.counters[key].data.counters, tiers: window.opgg.tiers[key].data.tiers,
        numOf: Object.fromEntries(Object.values(window.championsMap).map(x => [x.id, String(x.numId)])) };
    }, [champ, pos]);
    for (const x of p.list.filter(x => x.play > 0)) {
      const r = raw.counters.find(r => String(r.id) === raw.numOf[x.id]);
      assert.equal(x.play, r.play, x.id);
      assert.ok(Math.abs(x.wr - (1 - r.win / r.play)) < 1e-9, x.id);
    }
    for (const t of ['gold', 'emerald', 'diamond']) {
      const want = raw.tiers[t].counters.filter(r => r.play > 0)
        .sort((a, b) => a.win / a.play - b.win / b.play).map(r => String(r.id));
      assert.deepEqual(p.tiers[t].map(x => raw.numOf[x.id]), want, `${champ} ${t}`);
      assert.ok(p.tiers[t].length >= 1 && p.tiers[t].length <= 3, `${t} ${p.tiers[t].length}`);
    }
  };
  const DARIUS_TABLE = ['Jax', 'Jayce', 'Kennen', 'MonkeyKing', 'Mordekaiser'];

  // 達瑞斯：表上 7 隻 → 取前 5 隻，依克制程度排；分析區在 Pick 格下面，Pick 格自己不再重複小列
  await pick(E, 'blue', 'pick', 0, 'Darius');
  await waitPanel('blue', 'Darius');
  let darius = await panel('blue');
  assert.deepEqual(darius.list.map(x => x.id).sort(), [...DARIUS_TABLE].sort());
  assert.ok(darius.list.every(x => x.source === 'table' && !x.blocked && x.play > 0), JSON.stringify(darius.list));
  assertSorted(darius.list);
  assert.match(darius.text, /剋 達瑞斯/);
  assert.match(darius.text, /前 5 大剋星（克制程度 高→低）/);
  assert.ok(['金牌', '翡翠', '鑽石'].every(t => darius.text.includes(t)));
  await assertMatchesWorker('Darius', 'top', darius);
  assert.notDeepEqual(darius.tiers.gold.map(x => x.id), darius.tiers.diamond.map(x => x.id), '金牌和鑽石應該不一樣');
  assert.equal(await E.locator('#bluePickSlots .counter-row').count(), 0);
  console.log(`       達瑞斯：${darius.list.map(x => `${x.id} ${(x.wr * 100).toFixed(1)}%`).join('、')}`);
  console.log(`       分段：${Object.entries(darius.tiers).map(([t, l]) => `${t} ${l.map(x => x.id).join('/')}`).join('；')}`);

  // 漢默丁格：表上只有伊澤瑞爾 → 其他 4 隻用 OP.GG 上路補，不重複、不含自己
  await pick(E, 'red', 'pick', 0, 'Heimerdinger');
  await waitPanel('red', 'Heimerdinger');
  const heimer = await panel('red');
  assert.deepEqual(heimer.list.filter(x => x.source === 'table').map(x => x.id), ['Ezreal']);
  assert.equal(heimer.list.filter(x => x.source === 'opgg').length, 4);
  assert.equal(new Set(heimer.list.map(x => x.id)).size, 5);
  assert.ok(!heimer.list.some(x => x.id === 'Heimerdinger'));
  assertSorted(heimer.list);
  assert.match(heimer.text, /紅方 Pick 1・上路/);
  await assertMatchesWorker('Heimerdinger', 'top', heimer);

  // 阿璃：表上沒有 → 5 隻都是 OP.GG 中路；分析區換成阿璃，達瑞斯那格改成小列（順序跟分析區一樣）
  await pick(E, 'blue', 'pick', 1, 'Ahri');
  await waitPanel('blue', 'Ahri');
  const ahri = await panel('blue');
  assert.ok(ahri.list.every(x => x.source === 'opgg'), JSON.stringify(ahri.list));
  assertSorted(ahri.list);
  assert.match(ahri.text, /藍方 Pick 2・中路/);
  await assertMatchesWorker('Ahri', 'mid', ahri);
  await waitRow('blue', 0);
  assert.deepEqual(await rowIds('blue', 0), darius.list.map(x => x.id));
  assert.equal(await E.locator('#bluePickSlots > div:nth-child(2) .counter-row').count(), 0);
  console.log(`       阿璃：${ahri.list.map(x => `${x.id} ${(x.wr * 100).toFixed(1)}%`).join('、')}`);

  // 點達瑞斯那格 → 分析區切回達瑞斯
  await E.click('#bluePickSlots > div:nth-child(1)');
  await waitPanel('blue', 'Darius');
  await waitRow('blue', 1);

  // 本局 Ban 掉賈克斯、紅方選走凱能、手動禁用杰西 → 這三隻變灰，順序不變；分段裡出現的也一樣變灰
  await pick(E, 'blue', 'ban', 0, 'Jax');
  await pick(E, 'red', 'pick', 1, 'Kennen');
  await E.fill('#searchInput', '杰西');
  await E.click('#btnBanAll');
  await E.fill('#searchInput', '');
  await E.dispatchEvent('#searchInput', 'input');
  await E.click('#bluePickSlots > div:nth-child(1)');
  await waitPanel('blue', 'Darius');
  const blockedNow = new Set(['Darius', 'Heimerdinger', 'Ahri', 'Kennen', 'Jax', 'Jayce']);
  darius = await panel('blue');
  assert.deepEqual(darius.list.map(x => x.id).sort(), [...DARIUS_TABLE].sort());
  assertSorted(darius.list);
  darius.list.forEach(x => assert.equal(x.blocked, blockedNow.has(x.id), x.id));
  assert.match(darius.list.find(x => x.id === 'Jax').text, /不能選：本局已選或已 Ban/);
  assert.match(darius.list.find(x => x.id === 'Jayce').text, /不能選：已手動禁用/);
  Object.values(darius.tiers).flat().forEach(x => assert.equal(x.blocked, blockedNow.has(x.id), x.id));

  // Game 2（硬全局）：蓋倫的剋星凱能在 Game 1 用過、杰西手動禁用 → 灰掉
  await E.click('#gameTabs button:has-text("Game 2")');
  await pick(E, 'blue', 'pick', 0, 'Garen');
  await waitPanel('blue', 'Garen');
  const garen = await panel('blue');
  assert.deepEqual(garen.list.map(x => x.id).sort(), ['Camille', 'Jayce', 'Kayle', 'Kennen', 'Mordekaiser']);
  assertSorted(garen.list);
  garen.list.forEach(x => assert.equal(x.blocked, ['Kennen', 'Jayce'].includes(x.id), x.id));
  assert.match(garen.list.find(x => x.id === 'Kennen').text, /不能選：前幾局用過或 Ban 過/);

  // 點剋星（分析區、分段、小列）都不會選角
  const before = await E.evaluate(() => JSON.stringify(window.roomState.games));
  await E.locator('#blueCounterPanel li[data-counter]').first().click();
  await E.locator('#blueCounterPanel [data-tier-counter]').first().click();
  await E.click('#gameTabs button:has-text("Game 1")');
  await E.locator('#bluePickSlots [data-counter]').first().click();
  await E.waitForTimeout(500);
  assert.equal(await E.evaluate(() => JSON.stringify(window.roomState.games)), before);

  // 同一隻英雄只跟 OP.GG 要一次；分段只抓分析區看過的那幾隻
  const uniq = (l) => [...new Set(l)].sort();
  const seen = ['?champ=103&pos=mid', '?champ=122&pos=top', '?champ=74&pos=top', '?champ=85&pos=top', '?champ=86&pos=top'];
  assert.deepEqual(uniq(urls.counters), seen);
  assert.equal(urls.counters.length, 5, urls.counters.join(' '));
  assert.deepEqual(uniq(urls.tiers), seen);
  assert.equal(urls.tiers.length, 5, urls.tiers.join(' '));

  await E.click('#btnUnbanAll'); // 清掉手動禁用（不影響別的房間，保險起見）
  await E.click('#bluePickSlots > div:nth-child(1)');
  await waitPanel('blue', 'Darius');
  await E.setViewportSize({ width: 390, height: 844 });
  const overflow = await E.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `手機寬度超出 ${overflow}px`);
  await E.locator('#blueCounterPanel').screenshot({ path: path.join(ROOT, 'test-results', 'counters-mobile.png') });
  await E.setViewportSize({ width: 1500, height: 1000 });
  await E.waitForTimeout(300);
  await E.screenshot({ path: path.join(ROOT, 'test-results', 'counters.png') });
  await E.context().close();
});

await test('剋星只有創造者看得到：朋友畫面沒有剋星列和分析區，整個過程也沒發過 OP.GG 請求', async () => {
  assert.ok(await A.locator('.counter-row').count() > 0, '創造者應該有剋星列');
  assert.ok(await A.locator('.counter-panel').count() > 0, '創造者應該有剋星分析');
  assert.equal(await B.locator('.counter-row').count(), 0);
  assert.equal(await B.locator('.counter-panel').count(), 0);
  assert.equal(await B.locator('[data-counter], [data-tier-counter]').count(), 0);
  assert.equal(B.opggRequests, 0);
});

const gridIds = (page) => page.$$eval('#championGrid > div[onclick]', els => els.map(e => e.getAttribute('onclick').match(/'(.+)'/)[1]));
const draftOf = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.roomState.draft)));

await test('英雄池抽選：兩邊代表不能同一人，名字顯示在隊伍標頭，只有創造者能改名', async () => {
  await A.click('#btnDraftPanel');
  await B.click('#btnDraftPanel');
  await A.click(`#draftPanel button[onclick="setRep('blue', 0)"]`);
  await waitText(B, '#blueRepTag', 'The shy');
  assert.ok(await B.locator(`#draftPanel button[onclick="setRep('red', 0)"]`).isDisabled(), '對面選了的人要變灰');
  await B.evaluate(() => setRep('red', 0)); // 硬點也不行
  await waitText(B, '#toastMsg', '兩邊不能同一個人');
  assert.equal((await draftOf(B)).redRep, -1);
  await B.click(`#draftPanel button[onclick="setRep('red', 1)"]`);
  await waitText(A, '#redRepTag', '老蔡');
  assert.equal(await B.locator('#draftPanel input[id^="repName"]').count(), 0, '朋友不該看到改名欄');
  await A.fill('#repName1', '阿蔡');
  await A.press('#repName1', 'Tab');
  await waitText(B, '#redRepTag', '阿蔡');
  assert.equal((await draftOf(B)).reps[1], '阿蔡');
});

await test('英雄池抽選：池大小可預設可手動輸入，雙方各自從英雄列表選池、同步、滿了擋下', async () => {
  await A.click('#gameTabs button:has-text("Game 3")');
  await A.fill('#blueSizeInput', '4');
  await A.press('#blueSizeInput', 'Tab');
  await B.fill('#redSizeInput', '3');
  await B.press('#redSizeInput', 'Tab');
  await A.waitForFunction(() => window.roomState.draft.blueSize === 4 && window.roomState.draft.redSize === 3, null, { timeout: 10000 });
  await A.click(`#draftPanel button[onclick="togglePoolEdit('blue')"]`);
  for (const id of ['Garen', 'Renekton', 'Teemo', 'Nasus']) await card(A, id).click();
  await card(A, 'Fiora').click();
  await waitText(A, '#toastMsg', '藍方池已滿 4 隻');
  await card(A, 'Nasus').click(); // 再點一次移出
  assert.deepEqual((await draftOf(A)).bluePool, ['Garen', 'Renekton', 'Teemo']);
  await card(A, 'Fiora').click();
  await B.waitForFunction(() => window.roomState.draft.bluePool.length === 4, null, { timeout: 10000 });
  await B.click(`#draftPanel button[onclick="togglePoolEdit('red')"]`);
  await card(B, 'Garen').click(); // 藍方池已有的，紅方不能再選
  await waitText(B, '#toastMsg', '兩邊的池不能重複');
  assert.ok(!(await draftOf(B)).redPool.includes('Garen'));
  assert.ok((await card(B, 'Garen').getAttribute('class')).includes('disabled-champ'), '對面池的英雄要變灰');
  await B.click(`#draftPanel button[onclick="togglePoolEdit('red')"]`);
  await B.click(`#draftPanel button[onclick="randomFillPool('red')"]`);
  await B.waitForFunction(() => window.roomState.draft.redPool.length === 3, null, { timeout: 10000 });
  await A.waitForFunction(() => window.roomState.draft.redPool.length === 3, null, { timeout: 10000 });
  assert.deepEqual((await draftOf(B)).bluePool, ['Garen', 'Renekton', 'Teemo', 'Fiora'], '兩邊各自選池不會互相蓋掉');
  const dd = await draftOf(B);
  assert.ok(!dd.redPool.some(id => dd.bluePool.includes(id)), '隨機補滿也不會抽到對面池的英雄');
});

await test('英雄池抽選：池沒選滿不能抽；抽完 Pick 只顯示候選、其他英雄不出現，朋友同步', async () => {
  await A.click(`#draftPanel button[onclick="setDraftFearless('standard')"]`); // 前面幾局是隨機補的，先用不強制讓抽出數量固定
  await A.fill('#blueSizeInput', '5');
  await A.press('#blueSizeInput', 'Tab');
  await A.click('#btnDrawCands');
  await waitText(A, '#toastMsg', '雙方都選滿才能抽選');
  await A.fill('#blueSizeInput', '4');
  await A.press('#blueSizeInput', 'Tab');
  await A.fill('#drawCountInput', '2');
  await A.press('#drawCountInput', 'Tab');
  await A.click(`#draftPanel button[onclick="togglePoolEdit('blue')"]`); // 結束選池
  await A.click('#btnDrawCands');
  await A.waitForFunction(() => (window.roomState.draft.draws[3] || []).length === 4, null, { timeout: 10000 });
  const d = await draftOf(A);
  const cands = d.draws[3];
  assert.ok(cands.every(id => d.bluePool.includes(id) || d.redPool.includes(id)), '候選要來自雙方的池');
  assert.deepEqual((await gridIds(A)).sort(), [...cands].sort(), '格子只剩候選');
  await B.waitForFunction((n) => document.querySelectorAll('#championGrid > div').length === n, 4, { timeout: 10000 });
  assert.deepEqual((await gridIds(B)).sort(), [...cands].sort());
  await waitText(A, '#champCountText', '抽選候選 4 隻');
  await waitText(A, '#draftCands', '不夠選');
});

await test('英雄池抽選：Pick 只能選候選（硬點非候選被擋）；Ban 位仍可選全部英雄；隨機也只抽候選', async () => {
  const cands = (await draftOf(A)).draws[3];
  await A.click('#bluePickSlots > div:nth-child(1)');
  await A.evaluate(() => clickChampion('Zed'));
  await waitText(A, '#toastMsg', 'Pick 只能從候選英雄裡選');
  assert.equal((await gameOf(A, 3)).bluePicks[0] || null, null);
  await card(A, cands[0]).click();
  assert.equal((await gameOf(A, 3)).bluePicks[0], cands[0]);
  await A.evaluate(() => { window.roomState.g2BanCount = 1; syncAndRender(); }); // 前面測試把 Ban 位數設成 0
  await A.click('#blueBanSlots > div:nth-child(1)');
  assert.ok((await gridIds(A)).length > 150, '選 Ban 位時要顯示全部英雄');
  await A.click('#bluePickSlots > div:nth-child(2)');
  assert.equal((await gridIds(A)).length, 4);
  await A.click('#btnRandomOne');
  const g3 = await gameOf(A, 3);
  assert.ok(cands.includes(g3.bluePicks[1]), `隨機抽到候選外的 ${g3.bluePicks[1]}`);
});

await test('英雄池抽選：硬全局排除前幾局用過的；改「不強制」就能抽到；解除限制恢復全部', async () => {
  const free = await A.evaluate(() => { // 前面幾局完全沒用過、也沒被禁的英雄，抽選結果才不會被隨機補滿影響
    const used = new Set(Object.values(window.roomState.games).flatMap(g => [...g.bluePicks, ...g.redPicks, ...g.blueBans, ...g.redBans]));
    const manual = new Set(window.roomState.manualDisabledChamps);
    return window.allChampions.map(c => c.id).filter(id => !used.has(id) && !manual.has(id) && !['Ahri', 'Syndra'].includes(id)).slice(-2);
  });
  await A.evaluate(([f1, f2]) => {
    window.roomState.fearlessMode = 'hard';
    window.roomState.draft.bluePool = ['Ahri', f1]; window.roomState.draft.blueSize = 2;
    window.roomState.draft.redPool = ['Syndra', f2]; window.roomState.draft.redSize = 2;
    window.roomState.draft.drawCount = 2; window.roomState.draft.draws[4] = [];
    syncAndRender();
  }, free);
  await A.click('#gameTabs button:has-text("Game 4")');
  await A.click('#btnDrawCands');
  await waitText(A, '#toastMsg', '抽出 2 隻候選');
  assert.deepEqual((await draftOf(A)).draws[4].sort(), [...free].sort(), '硬全局：Game 1 用過的阿璃、星朵拉不能抽');
  await A.click(`#draftPanel button[onclick="setDraftFearless('standard')"]`);
  await B.waitForFunction(() => window.roomState.fearlessMode === 'standard', null, { timeout: 10000 });
  await A.click('#btnDrawCands');
  await A.waitForFunction(() => window.roomState.draft.draws[4].length === 4, null, { timeout: 10000 });
  assert.deepEqual((await draftOf(A)).draws[4].sort(), ['Ahri', 'Syndra', ...free].sort(), '不強制：全部都能抽');
  await A.click('#btnReleaseDraw');
  await A.waitForFunction(() => window.roomState.draft.draws[4].length === 0, null, { timeout: 10000 });
  await A.click('#bluePickSlots > div:nth-child(1)');
  assert.deepEqual((await gridIds(A)).sort(), ['Ahri', 'Syndra', ...free].sort(), '解除抽選後回到只顯示雙方英雄池');
  await A.click('#btnShowAll');
  assert.ok((await gridIds(A)).length > 150, '按「顯示全部英雄」要顯示全部');
  await A.click('#btnShowAll');
  // 各自分配：每方只能選自己那份
  await A.click(`#draftPanel button[onclick="setDrawMode('split')"]`);
  await A.click('#btnDrawCands');
  await A.waitForFunction(() => window.roomState.draft.drawsBlue[4].length === 2 && window.roomState.draft.drawsRed[4].length === 2, null, { timeout: 10000 });
  const sp = await draftOf(A);
  assert.deepEqual([...sp.drawsBlue[4]].sort(), ['Ahri', free[0]].sort());
  assert.deepEqual([...sp.drawsRed[4]].sort(), ['Syndra', free[1]].sort());
  await B.waitForFunction(() => window.roomState.draft.drawsRed[4]?.length === 2, null, { timeout: 10000 });
  await A.click('#bluePickSlots > div:nth-child(1)');
  assert.deepEqual((await gridIds(A)).sort(), [...sp.drawsBlue[4]].sort(), '點藍方 Pick 位只顯示藍方那份');
  await A.evaluate((id) => clickChampion(id), sp.drawsRed[4][0]);
  await waitText(A, '#toastMsg', 'Pick 只能從候選英雄裡選');
  await B.click('#redPickSlots > div:nth-child(1)');
  assert.deepEqual((await gridIds(B)).sort(), [...sp.drawsRed[4]].sort(), '點紅方 Pick 位只顯示紅方那份');
  await A.click('#btnReleaseDraw');
  await A.waitForFunction(() => window.roomState.draft.drawsBlue[4].length === 0, null, { timeout: 10000 });
  await A.click(`#draftPanel button[onclick="setDrawMode('shared')"]`);
  // 換到沒抽選的下一局：中間只顯示雙方池裡的英雄
  await A.click('#gameTabs button:has-text("Game 5")');
  assert.deepEqual((await gridIds(A)).sort(), ['Ahri', 'Syndra', ...free].sort(), '沒抽選的局數只顯示池內英雄');
  await A.click(`#draftPanel button[onclick="setDraftFearless('hard')"]`);
  await A.screenshot({ path: path.join(ROOT, 'test-results', 'draft-panel.png') });
});

await test('英雄池抽選：重置所有局數清掉候選但池與代表保留', async () => {
  await A.evaluate(() => resetEntireSeries());
  const d = await draftOf(A);
  assert.ok(Object.values(d.draws).every(l => l.length === 0));
  assert.equal(d.bluePool.length, 2);
  assert.equal(d.blueRep, 0);
  await A.click('#btnDraftPanel'); // 收起
});

await test('單機、什麼都還沒選：匯出會提示沒有紀錄', async () => {
  const D = await openPage('單機');
  await D.click('#btnCopyAll');
  await waitText(D, '#toastMsg', '還沒有任何一局');
  await D.click('#btnDownloadAll');
  await waitText(D, '#toastMsg', '還沒有任何一局');
  await D.context().close();
});

await test('手機寬度（390px）沒有橫向捲動', async () => {
  const M = await openPage('手機', { width: 390, height: 844 });
  const overflow = await M.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `超出 ${overflow}px`);
  await M.screenshot({ path: path.join(ROOT, 'test-results', 'mobile.png'), fullPage: false });
  await M.context().close();
});

await A.screenshot({ path: path.join(ROOT, 'test-results', 'creator.png') });
await B.screenshot({ path: path.join(ROOT, 'test-results', 'friend.png') });

await test('過程中沒有任何錯誤訊息', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
web.close();
workerServer.close();
console.log(`\n端對端測試 ${passed} 項通過${process.exitCode ? '，有失敗' : ''}（Worker 被呼叫 ${workerHits} 次）`);
process.exit(process.exitCode || 0);
