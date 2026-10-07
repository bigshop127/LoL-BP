# ROADMAP

## 現況（2026-10-07）

- 從 Gemini 畫布版搬出來獨立成 repo（第一個 commit 是原封不動的原始版本，方便對照改了什麼）。
- 房間同步改接自己的 Firebase（`lol-bp-fearless`，Firestore 在 asia-east1 台灣）。
  - 雲端只存密碼的 SHA-256 雜湊（`lol-bp:房號:密碼`），規則禁止改雜湊、禁止列出所有房間、禁止刪除。
  - 只上傳有變動的欄位（例如 `games.2.bluePicks`），兩人同時點不同格不會互相蓋掉。
- OP.GG 數據：瀏覽器不能直接連 OP.GG（沒有 CORS、也擋 iframe），由 `worker/` 代轉 OP.GG 官方資料介面 `mcp-api.op.gg`。
  - `/meta`：各路勝率／登場率／禁用率（快取 30 分鐘）
  - `/matchup?champ=103&pos=mid&vs=134`：對位戰績（快取 3 小時）
  - 只有創造者模式的人會呼叫。
- 修掉的原始 bug：輸錯密碼的人點一下就會蓋掉整個房間；跳著點 Ban 位會存檔失敗；Ban 位數設 0 會變回 3；手動開關要按「完成管理」才上傳，期間朋友一動就被蓋掉。

## 已知限制

- 沒有帳號系統，知道房號的人就讀得到房間內容；密碼只擋「加入」，不是真正的權限控管（朋友間使用夠用）。
- 新版本剛上的前幾天 OP.GG 場數很少，對位勝率可能顯示「場數還不夠」。
- OP.GG 資料介面的英雄名稱格式是試出來的（`Kai'Sa`→`KAISA`、`Dr. Mundo`→`DR_MUNDO`），OP.GG 改格式時要跟著改 `worker/src/index.js` 的 `toOpggName`。

## 待辦

- （無）
