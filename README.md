# 英雄聯盟全局 BP 模擬器（LoL Fearless Draft）

網址：https://bigshop127.github.io/LoL-BP/

和朋友一起做全局 BP（Fearless Draft）：輸入同一組房號＋密碼就會進到同一個房間，雙方的 Pick / Ban 即時同步。

- 5v5／1v1、硬全局／軟全局／標準 BP、每局 Ban 位數可調、局數無上限
- 英雄可依路線、近遠程、名稱篩選；「一鍵全禁／一鍵全開」只作用在目前篩選出來的英雄，所有局數都有效
- 「英雄開關管理」可逐隻啟用／禁用
- 一鍵複製 BP 戰報

## 結構

| 路徑 | 內容 |
| --- | --- |
| `index.html` | 整個網頁（GitHub Pages 直接提供） |
| `firestore.rules` | 房間資料的安全規則（Firebase 專案 `lol-bp-fearless`） |
| `worker/` | OP.GG 數據代轉（Cloudflare Worker） |
| `tests/` | 規則測試、Worker 測試、三個瀏覽器同時連線的端對端測試 |

## 開發

```bash
npm install
npm run test:worker        # Worker 離線測試（加 :live 會真的連 OP.GG）
npm run test:rules         # Firestore 規則（本機模擬器）
npm run test:e2e           # 端對端（本機模擬器＋無頭瀏覽器，不碰正式資料）
firebase deploy --only firestore:rules
cd worker && npx wrangler deploy
```

英雄資料來自 Riot Data Dragon；勝率數據來自 OP.GG。
