# 關閉獨立測驗頁的「黑屏 + 重整」— 分析與處置

> 狀態：O1 / O2 / O3 已實作（2026-08-29，前端版本 `20260828_exam_p5b`）。O4 / O5 待評估。

## 現況

大測驗有兩種掛載方式：

| 進入方式 | 掛載 | 關閉行為 | 體驗 |
|---|---|---|---|
| 首頁「查看成績」 | app 內覆蓋層（`mountExamRunner({standalone:false})`） | `host.remove()`，不導頁 | 即時 |
| 首頁 banner「進入測驗」／通知點擊 | 獨立文件 `exam.html`（同分頁 `location.assign(...&return=/x)`） | `_leaveStandalone()` | 慢 |
| 後台「預覽試卷」「測試作答」「正式作答」 | 獨立文件 `exam.html`（`<a target="_blank" rel="noopener">`） | `_leaveStandalone()` | 慢＋多餘冷啟動 |

慢的只有 `exam.html`。它關閉時 `_leaveStandalone()`：`history.back()` → 或 `?return=/x` → 或 `location.replace('/')`。**三條都是換 document + 從頭跑一次 `app.js`**（`db.init()` 還原 session／刷新 token／打網路 → `Promise.all([loadModule, 初始資料])` → `switchTab`）。跑完才有畫面，中間就是黑屏。

## 根因（依影響排序）

1. **`vercel.json` 對 `/` 與 `/index.html` 設 `Cache-Control: no-store`**。`no-store` 是瀏覽器 bfcache 的硬性禁用條件 → `history.back()` 回 `/` 永遠整頁重抓 + 冷啟動。**最大主因。**
2. **`exam.html` 與 `index.html` 是兩份獨立文件**（刻意設計：最小 bundle、完全隔離、沉浸不能亂逛）。代價是進出各冷啟動一次。
3. **app 冷啟動成本高**：首屏前有 `await db.init()` 與一組 `await Promise.all([...])`。
4. **SW 對導覽走 `networkFirst`，逾時最長 8 秒**：網路不穩時關閉測驗回 `/` 會卡等網路。
5. **`_leaveStandalone()` 對 `_blank` 分頁 fallback 到 `location.replace('/')`**：把「本來直接關掉就好」的拋棄式分頁硬導去 `/` 冷啟一次。

## 不能動的底線

| 不變量 | 守門位置 |
|---|---|
| 單次作答、送出冪等 | server：`exam_start_attempt` `ON CONFLICT`、`exam_submit_attempt` `alreadySubmitted` |
| 計時以伺服器為準（`deadlineAt` 在 start 時 `LEAST(now+dur, close_at)` 定死） | server；前端只顯示 |
| 未同步作答不遺失 | `flushSave` 15s + `persistLocal` 3s（localStorage）+ IndexedDB 佇列 + `beforeunload` + `requestExit` 離開前 flush |
| 作答中 token 面積最小化 | `exam.html` 精簡 bundle |
| 沉浸鎖定 | 獨立 document 天然強制 |
| `/exam`、`/modules/exam.js` 一定拿到新版 | `sw.js` `shouldBypassCache` + `networkFirst` |

**永遠不做**：把計時 / attempt 狀態 / 計分搬到前端；把 `exam_*` RPC 納入 SW 快取；放寬 `exam_*` 寫入的 server scope。

## 選項

### O1　恢復 `/` 的 bfcache　【風險低 · 效益最高】— 已實作
`vercel.json`：`/` 與 `/index.html` 的 `Cache-Control` 由
`no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`
改為
`no-cache, must-revalidate, proxy-revalidate, max-age=0`。

`no-cache` 仍**每次向伺服器驗證**（不吃舊版 HTML，freshness 不變），但移除 `no-store` 後瀏覽器可把頁面放進 bfcache。PWA 版本控管靠 SW + `?v=`，不靠 `no-store`。
效果：`history.back()` 從測驗頁回 app 瞬間還原（tab、捲動、記憶體狀態都在），零冷啟動、零資料風險。
`/exam.html`、`/exam`、`/sw.js` 維持 `no-store`（測驗頁進行中本來就因 `beforeunload` 不進 bfcache；SW 必須每次抓新）。

部署後驗證：
- OAuth 登入回呼（落在 `/`，`hasOauthCallbackSignal`）在 bfcache 還原下不誤觸
- PWA 更新提示仍正常
- 離線殼 fallback 仍正常
- `history.back` 有還原 tab 與捲動位置
- 不會把陳舊 ranking / 通知當成最新顯示（bfcache 還原後 `pageshow` 應觸發既有的刷新）

### O2　`_leaveStandalone()` 不再為 `_blank` 分頁冷啟 app　【風險低】— 已實作
後台「預覽試卷」「測試作答」「正式作答」的連結加 `&popup=1`。`_leaveStandalone()` 見 `popup=1` 且無 `?return=` → 先 best-effort `window.close()`，關不掉就鋪一張「測驗已關閉，可直接關閉此分頁」的卡片（附手動「回首頁」鈕），**不自動 `location.replace('/')`**。（不靠 `history.length` 猜，避免瀏覽器差異。）

### O3　導頁前鋪主題色過場　【風險低 · 純視覺】— 已實作
`_leaveStandalone()` 真正導頁前，先鋪一張 `position:fixed` 全螢幕、`var(--bg-app)` 底色的「返回中…」，把 teardown 空檔從黑屏變成有底色的載入。

### O4　`?return=` + app 快速續啟模式　【風險中】— 待評估
同分頁關閉走 `location.replace(return)`，`app.js` 認「resume」旗標跳過可從 IndexedDB / 快取還原的抓取，並標記資料新鮮度、背景再刷新。O1 做完後必要性大降，先量測再決定。

### O5　測驗預設走 app 內覆蓋層（結構性）　【風險高】— 待評估
banner / 通知也用 `standalone:false`，`exam.html` 只留深連結 fallback。關閉＝卸載覆蓋層＝即時。
代價：作答期間攤開整個 app（安全面 + 分心）、SW 規則要重審、要加防護讓背景 SPA 重繪／計時器不擾動 attempt、沉浸保證變弱。
**必須**先跑完 P4 真機清單（斷網續作、逾時當下斷網、雙分頁同時送出、改手機時鐘、手機↔電腦接續）。獨立專案，不與 O1–O3 綁定。

## 建議順序

1. 已做：O1 + O2 + O3（互相獨立、可回退、對完整性／有效性／安全性零成本）。
2. 部署後量測真機。仍慢 → O4。
3. O5 僅在產品決定「測驗住在 app 內」時評估，且先過完整測驗完整性測試計畫。
