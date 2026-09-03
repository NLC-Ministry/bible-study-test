# 第一輪期末賽：四小徽章 → 合成鐵獎（設計文件）

狀態：**設計中，未實作**。撰於 2026-09-03。純前端。

## 目標

「第一輪期末賽」已從單一階段拆成 **4 張月度計畫**（9 月出埃及記 / 10 月利未記 / 11 月民數記 / 12 月申命記）。
鐵獎應該是「四卷全部完成」的**合併獎**，不是任何單月計畫就能拿。

改成：**每卷一個小徽章（各自記遍數）→ 四塊到齊合成「鐵獎」大徽章**。

決策（使用者已定）：**期末測驗（12/27）不納入鐵獎條件** —— 鐵獎 = 四卷各完成 ≥ 1 遍即可。測驗是分開的成就 / 排名。

---

## 現況與待修 bug

| 位置 | 現況 | 問題 |
|---|---|---|
| `utils.js` `getCampaignStageCompletedRounds(2)` | = 四卷 `planCompletedRounds` 的**最小值** | ✅ 邏輯已正確，保留 |
| `plan.js` 1700 / 2108 `campaignAwardEarned` | `= (currentRound>1 \|\| progress>=100)`，只看**單張** | ❌ 讀完出埃及記就顯示「已獲得 鐵獎」 |
| `plan.js` 卡片「獎項：完成可獲得 鐵獎」 | 每張月度卡都這樣寫 | ❌ 讀者以為完成這張就有鐵獎 |
| `gamification.js` `ACHIEVEMENTS` | `createChurchCampaignStageDefinitions().map(...)` 現在回 **4 筆 stageNo=2** | ❌ 產生 4 個一模一樣的 `church_stage_award_2` 徽章 |

---

## 徽章清單

### 4 個小徽章（每卷一個）

| id | 標題 | icon | 星等來源（遍數） | 點亮條件 |
|---|---|---|---|---|
| `church_r1final_book_ex` | 出埃及記 | `bookOpen` | 出埃及記月度計畫的 `planCompletedRounds` | ≥ 1 遍 |
| `church_r1final_book_lev` | 利未記 | `bookOpen` | 利未記月度計畫 | ≥ 1 遍 |
| `church_r1final_book_num` | 民數記 | `bookOpen` | 民數記月度計畫 | ≥ 1 遍 |
| `church_r1final_book_deut` | 申命記 | `bookOpen` | 申命記月度計畫 | ≥ 1 遍 |

- 小徽章**各自有星**：出埃及記讀 3 遍 → 出埃及記小徽章 3 星，就算鐵獎還卡在 1 星（因為利未記只讀 1 遍）。→ 「多讀某一卷」有即時回饋，也和「章數排名」一致。
- 遍數來源：`planCompletedRounds(findActivePlanByKey('church_r1final_2026_09'))` 等。**不新增主要儲存**，但每卷加一個 localStorage 自癒快取 `church_r1final_rounds_<presetKey>`（比照現有 `church_stage_completed_rounds_2` 的寫法），讓計畫在賽季結束、`state.activePlans` 輪出後徽章不會熄。

### 合成大徽章（沿用既有 id）—— **季末由使用者手動合成**

鐵獎**不是**跑動的即時徽章。賽季結束後，使用者在徽章牆**自己按「合成鐵獎」**：
按下時看四個小徽章各自**凍結的星數**，一次算出鐵獎的等級並合成（有儀式感，時機自己選）。

| id | 標題 | 亮起門檻 | 等級（星數）來源 |
|---|---|---|---|
| `church_stage_award_2` | 鐵獎 | `min(四卷凍結星數) ≥ 1`（四卷缺一不可） | 見下「等級公式」 |

- **賽季進行中（9–12 月）**：四個小徽章正常累積各自星數；鐵獎欄位顯示 **「12/31 賽季結束後可合成」**（不畫星、不顯示「已獲得」）。就算你 12 月中就把四卷全讀完，也要等結算日才出現合成按鈕（使用者指定）。
- **季末（到達 `finalSynthesisDate`，建議 `2027-01-02`）**：`today >= 結算日` 且門檻過 且未合成 → 鐵獎欄變成 **「合成鐵獎」按鈕**（附星數預覽）。使用者按下 → 讀四卷凍結星數、算等級、播合成動畫、寫入 `unlocked_badges`、`church_r1final_synthesized='1'`、`church_r1final_iron_tier=<tier>`、記日期。
- **沒集滿四卷**：門檻未過 → **沒有合成按鈕**。已讀完的那幾卷小徽章維持點亮（例：出★1、利★1、民/申 熄），鐵獎欄顯示「完成 2/4 卷 · 未達鐵獎」。
- 星等階梯與其他階段一致：1–5 星 → 6–8 鑽石 → 9–10+ 皇冠。

### 等級公式（鐵獎）—— 三段階梯

門檻過了（四卷各 ≥ 1 遍）之後，看四卷遍數加總 `S = s_出 + s_利 + s_民 + s_申`：

| 階段 | 換算 | 上限 |
|---|---|---|
| ★ 星 | 每 **2 遍** 1 顆星（S=4 起算 1 星） | 5 顆 |
| 💎 鑽石 | 星滿之後，每 **3 遍** 1 顆鑽石 | 3 顆 |
| 👑 皇冠 | 鑽石滿之後，每 **4 遍** 1 個皇冠 | 3 個（最高） |

對照：

| S | 鐵獎 |
|---|---|
| 4 | ★1 |
| 6 | ★2 |
| 8 | ★3 |
| 10 | ★4 |
| 12 | ★5（星滿） |
| 15 | 💎1 |
| 18 | 💎2 |
| 21 | 💎3（鑽石滿） |
| 25 | 👑1 |
| 29 | 👑2 |
| 33+ | 👑3 |

概念：星最便宜（2 遍）、鑽石中等（3 遍）、皇冠最貴（4 遍）。切點放 `utils.js` 常數，好調。

- 這樣「四卷都讀完 1 遍」= ★1（門檻）；**重讀任何一卷都會往上加總**（出讀 3 遍、其餘各 1 → S=6 → ★2），比純 `min` 更能回饋重讀，又保住「四卷缺一不可」。
- 對照表放 `utils.js` 常數，日後好調。

（備選 A：純 `min(四卷星數)` —— 語意最純「完整讀完 N 遍」，但重讀某卷對鐵獎沒回饋。若教會偏好這個就把上表換成 `min`。）

---

## 星等規則總表（季末結算後）

| 情境（四卷凍結星數） | 出 | 利 | 民 | 申 | S 總和 | 鐵獎（結算後） |
|---|---|---|---|---|---|---|
| 只讀完出埃及記 1 遍（其餘 0） | ★1 | – | – | – | — | 未達鐵獎（完成 1/4） |
| 四卷各 1 遍 | ★1 | ★1 | ★1 | ★1 | 4 | ★1 |
| 出讀 3 遍、其餘各 1 遍 | ★3 | ★1 | ★1 | ★1 | 6 | ★2 |
| 四卷各 2 遍 | ★2 | ★2 | ★2 | ★2 | 8 | ★3 |
| 出 5・利 3・民 2・申 2 | ★5 | ★3 | ★2 | ★2 | 12 | ★5 |

> 賽季進行中：小徽章即時累積、鐵獎欄顯示「季末結算」。結算日一次合成。
> 額外的重讀同時也進「章數排名榜」（既有原則不變）。

---

## 資料模型：`getFirstRoundFinalStatus()`（新，放 `utils.js`）

全部可從 `state.activePlans` + localStorage 快取推導，**無 migration**。

```js
function getFirstRoundFinalStatus() {
  const spec = [
    { key: "church_r1final_2026_09", book: "出埃及記", badgeId: "church_r1final_book_ex" },
    { key: "church_r1final_2026_10", book: "利未記",   badgeId: "church_r1final_book_lev" },
    { key: "church_r1final_2026_11", book: "民數記",   badgeId: "church_r1final_book_num" },
    { key: "church_r1final_2026_12", book: "申命記",   badgeId: "church_r1final_book_deut" }
  ];
  const months = spec.map(s => {
    const plan = findActivePlanByKey(s.key);
    const live = plan ? planCompletedRounds(plan) : null;
    const cacheKey = `church_r1final_rounds_${s.key}`;
    if (live !== null) localStorage.setItem(cacheKey, String(live));
    const completedRounds = live !== null ? live : Number(localStorage.getItem(cacheKey) || 0);
    return {
      ...s, joined: Boolean(plan),
      progress: plan ? Number(plan.progress || 0) : 0,
      currentRound: plan ? Math.max(1, Number(plan.currentRound || 1)) : 1,
      completedRounds
    };
  });
  const collected = months.filter(m => m.completedRounds >= 1).length;   // 0..4
  const starSum = months.reduce((n, m) => n + m.completedRounds, 0);      // S
  const minRounds = Math.min(...months.map(m => m.completedRounds));

  const now = new Date();
  const synthDate = new Date(
    (window.CHURCH_CAMPAIGN && window.CHURCH_CAMPAIGN.finalSynthesisDate) || "2027-01-02"
  );
  const seasonEnded = now >= synthDate;

  return {
    months,
    collected,
    total: 4,
    starSum,
    minRounds,
    seasonEnded,
    thresholdMet: minRounds >= 1,                     // 四卷缺一不可
    ironTier: (minRounds >= 1) ? ironTierFromSum(starSum) : 0,  // 對照表；0 = 未達
    synthesized: localStorage.getItem("church_r1final_synthesized") === "1",
    canSynthesize: seasonEnded && minRounds >= 1
      && localStorage.getItem("church_r1final_synthesized") !== "1",   // → 顯示「合成鐵獎」按鈕
    ironAwardEarned: localStorage.getItem("church_r1final_synthesized") === "1" && minRounds >= 1
  };
}

// utils.js：S → 鐵獎「等效遍數等級」，餵進既有 renderBadgeStars（1..5=★, 6..8=💎, 9..10+=👑）
// 星每 2 遍、鑽石每 3 遍、皇冠每 4 遍。切點常數化好調。
const IRON_STEP_STAR = 2, IRON_STEP_DIAMOND = 3, IRON_STEP_CROWN = 4;
function ironTierFromSum(s) {
  if (s < 4) return 0;
  // 星：S 4→lvl1, 6→2, 8→3, 10→4, 12→5
  const starLvl = Math.min(5, Math.floor((s - 4) / IRON_STEP_STAR) + 1);
  if (starLvl < 5) return starLvl;                 // 1..4 → ★
  // 鑽石：S 12 起，每 3 遍一顆。15→💎1(lvl6), 18→💎2(7), 21→💎3(8)
  const dia = Math.floor((s - 12) / IRON_STEP_DIAMOND);
  if (dia <= 0) return 5;                          // S 12..14 → ★5
  if (dia <= 3) return 5 + dia;                    // 6..8 → 💎1..3
  // 皇冠：S 25→👑1(9), 29→👑2(10), 33→👑3(11)。S 22..24 仍是 💎3。
  const crown = Math.floor((s - 21) / IRON_STEP_CROWN);
  if (crown < 1) return 8;
  return 8 + Math.min(3, crown);                   // 9..11 → 👑1..3
}
```

---

## 合成流程

### 賽季進行中（9–12 月）
1. 每次讀經打卡 / 進度更新後照舊呼叫 `checkAchievements()`。
2. `checkAchievements` 只處理 **4 個小徽章**：`getBadgeMilestoneConfig('church_r1final_book_ex')` 回 `getValue: () => getFirstRoundFinalStatus().months[0].completedRounds`。level ≥ 1 → 解鎖該卷小徽章、記日期、彈一般解鎖通知。
3. 鐵獎 `church_stage_award_2`：`seasonEnded === false` → `getBadgeStarState` 一律回 level 0，徽章牆渲染「季末結算」占位（不畫星、不進 `unlocked_badges`）。

### 季末：使用者**手動按「合成鐵獎」**
到達 `finalSynthesisDate`（建議 2027-01-02）後，徽章牆的「第一輪期末賽」群組：

- `thresholdMet`（四卷各 ≥ 1 遍）且尚未合成 → 鐵獎格變成一顆 **「合成鐵獎」按鈕**，附預覽「四卷星數 3+1+1+1＝S6 → 可得 鐵獎 ★2」。
- 使用者**按下按鈕** → 播合成動畫 → 寫入：`unlocked_badges += church_stage_award_2`、`church_r1final_synthesized='1'`、`church_r1final_iron_tier=ironTier`（凍結）、記合成日期。
- 沒按之前：四卷小徽章維持點亮，鐵獎格是「待合成」按鈕狀態，不算已獲得。
- 門檻未過 → 沒有按鈕；鐵獎格顯示「完成 {collected}/4 卷 · 未達鐵獎」。
- 合成後 `getBadgeStarState('church_stage_award_2')` 星數讀凍結的 `church_r1final_iron_tier`，不再變動。

> 為什麼要手動按：讓使用者自己選合成的時機（有儀式感，像遊戲的「合成 / 開箱」動作），不是登入就突然彈一個。

`gamification.js` 匯出 `synthesizeFirstRoundFinal()` 給按鈕呼叫：算 tier → 寫 localStorage → 加入 `unlocked_badges` → 播動畫 → `refreshBadgeSurfaces()`。做防連點（`church_r1final_synthesized` 檢查）。

### 合成動畫
四個小徽章圖示往中間聚攏 → 融合成鐵獎（帶 `ironTier` 對應的星/鑽/皇冠）→ `launchFireworks()` + 「恭喜完成第一輪期末賽，獲得鐵獎 ★{tier}！」。用既有 canvas fireworks + 一段 CSS transform，不引新套件。**只放這一次**（按鈕觸發）。

### 徽章牆
把「出/利/民/申 4 小徽章 + 鐵獎」框成一個 **「第一輪期末賽」群組**（一個 section，四小 + 一大）。狀態：賽季中「季末結算」→ 季末門檻過「合成鐵獎」按鈕 → 按下後「鐵獎 ★{tier}」。

---

## 卡片文案（`plan.js`）

月度計畫（`plan.isMonthlyFinal` 或 `stageNo===2 && presetKey.startsWith('church_r1final')`）在三個渲染點：

| 位置 | 現在 | 改成 |
|---|---|---|
| 已加入卡 award 列（~1723 / ~1764） | 「獎項：完成可獲得 鐵獎」/「已獲得 鐵獎」 | 賽季中：「鐵獎：四卷全部完成才頒發 · 已完成 {collected}/4 卷」／季末門檻過未合成：「四卷完成 · 前往徽章牆合成鐵獎」／合成後：「已獲得 鐵獎 ★{tier}」。`campaignAwardEarned` 改用 `getFirstRoundFinalStatus().ironAwardEarned` |
| 計畫詳情 award 區塊（~2134） | 「完成本階段可獲得 鐵獎」 | 同上；`awardEarned` 同改 |
| 探索卡 status（~2494 `label:"完成獎勵"`） | 「鐵獎」 | 「鐵獎（四卷合計）」 |

`church_campaign.js` 的 `buildMonthlyFinalDefinition` 已有正確 `description`（「連同 9–12 月四個月全部完成可獲得鐵獎」）→ 保留；另加旗標 `isMonthlyFinal:true` / `finalMonthIndex` / `finalMonthTotal:4` / `finalBookBadgeId`，前端不用再靠字串猜。

---

## 程式改點

| 檔案 | 改動 |
|---|---|
| `js/data/church_campaign.js` | ① `mf(...)` / `buildMonthlyFinalDefinition`：加 `isMonthlyFinal` / `finalMonthIndex` / `finalMonthTotal:4` / `finalBookBadgeId` 旗標；② `CHURCH_CAMPAIGN` 加 `finalSynthesisDate: "2027-01-02"` |
| `js/gamification.js` | ① `ACHIEVEMENTS` 建立時**依 stageNo 去重**（修 4× 重複 bug）；② 加 4 個 `church_r1final_book_*` 徽章定義（`designVersion:2`、`maxStars:5`、`iconKey:"bookOpen"`）；③ `checkAchievements`：只解鎖 4 小徽章，鐵獎 `church_stage_award_2` 在合成前恆 level 0；④ 匯出 `synthesizeFirstRoundFinal()`（按鈕呼叫：防連點 → 算 tier → 寫 localStorage → `unlocked_badges` → 合成動畫 → `refreshBadgeSurfaces()`）；⑤ 合成動畫分支 |
| `js/utils.js` | ① 新 `getFirstRoundFinalStatus()`（含 `seasonEnded`/`thresholdMet`/`canSynthesize`/`synthesized`/`ironTier`）+ `IRON_TIER_TABLE` / `ironTierFromSum()`；② `getBadgeMilestoneConfig` 加 4 個 `church_r1final_book_*` 分支（`getValue` 回該卷 `completedRounds`）；③ `getBadgeStarState` / `renderBadgeStars`：`church_stage_award_2` 未合成回占位（賽季中「季末可合成」/ 季末「合成鐵獎」按鈕態）、合成後星數讀凍結的 `church_r1final_iron_tier`；④ `window.` 掛出 `getFirstRoundFinalStatus` |
| `js/modules/plan.js` | 三個 award 渲染點：月度計畫改文案——賽季中「鐵獎：四卷全部完成才頒發 · 已完成 {collected}/4 卷」、季末門檻過未合成「四卷完成 · 前往徽章牆合成鐵獎」、合成後「已獲得 鐵獎 ★{tier}」；`campaignAwardEarned`/`awardEarned` 改用 `getFirstRoundFinalStatus().ironAwardEarned` |
| `js/modules/profile.js` | 徽章牆把 4 小 + 鐵獎框成「第一輪期末賽」群組；`canSynthesize` 時鐵獎格渲染 **「合成鐵獎」按鈕**（onClick → `synthesizeFirstRoundFinal()`）；合成動畫掛點 |
| `index.css` | `.badge-group--r1final`、`.badge--pending-settlement`（季末結算占位樣式）、合成動畫 keyframes |
| `index.html` | bump `?v=` |

無 migration。DB 那 4 列 `rules.awardName:"鐵獎"` 不動（就是合併獎的名字）。

---

## 決策記錄

| # | 決策 | 選擇 |
|---|---|---|
| A | 期末測驗是否為鐵獎條件 | **否**（四卷完成即可，測驗另計） |
| B | 小徽章各自有星（遍數）嗎 | **有**（多讀某卷有即時回饋） |
| C | 合成的時機 | **賽季結束後**（`finalSynthesisDate`，建議 2027-01-02）、且門檻過，**由使用者在徽章牆手動按「合成鐵獎」**。不是即時、不是登入自動彈。只發生一次。 |
| D | 鐵獎星等規則 | **門檻**：四卷各 ≥ 1 遍（`min ≥ 1`，缺一不可）。**等級**：按四卷星數總和 `S` 對照 `IRON_TIER_TABLE`（重讀任何一卷都往上加）。不按章數加權。（備選：純 `min`。） |
| E | 是否改用 SSS/SSR 等級 | **否**（語境不合；既有「磐石→…→新耶路撒冷」金屬獎階梯維持不動） |

---

## 部署

1. 部署前端（bump 版本字串）。
2. 驗證（可用把 `finalSynthesisDate` 暫調到今天來測季末）：
   - 讀完出埃及記 → 出埃及記小徽章亮 ★1；鐵獎欄顯示「12/31 後可合成」；月度卡片顯示「已完成 1/4 卷」，**不**顯示「已獲得 鐵獎」。
   - 賽季中就算四卷全完成 → 鐵獎仍是「季末可合成」，**沒有**按鈕、不算已獲得。
   - 到結算日、四卷各 ≥ 1 遍 → 徽章牆出現 **「合成鐵獎」按鈕**＋星數預覽（例 S=6 → 鐵獎 ★2）。
   - 按下按鈕 → 合成動畫 + 鐵獎 ★2 寫入、按鈕消失、重整後仍是 ★2（凍結）。防連點。
   - 到結算日但只完成 2/4 卷 → 無按鈕，顯示「完成 2/4 卷 · 未達鐵獎」。
   - 徽章牆只有 **1 個** 鐵獎（不再是 4 個重複）。

---

## 未來延伸（不在初版）

- 第二輪期末賽（stage 4，2027 Apr–Aug）若也拆成月度 → 同一套（N 小徽章 → 青銅獎），把本設計參數化。
- 「累計讀經」整體稱號（跨全計畫總遍數 / 總章數）作為**獨立**系統，不動既有徽章、不用 SSS/SSR。
