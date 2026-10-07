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
