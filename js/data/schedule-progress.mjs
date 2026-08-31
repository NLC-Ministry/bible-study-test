// 教會進度比對的共用原語 —— 「落後 / 超前 / 補讀」全站只走這裡。
//
// 原則（見 docs，2026-08-31 定案）：
//   · 只在「第一遍」計算（currentRound === 1 且未完成）。第一遍之後只顯示輪次進度，
//     補讀天數凍結（因為第一遍的 log 之後不再變，重算也是同一個值）。
//   · 比對的尺一律是「教會原始階段日程」：該階段書卷章數 ÷ 起訖天數、平均鋪、每週七日。
//     不受使用者的 level 或個人休息日影響 —— 呼叫端要傳
//     buildChurchCampaignDays(campaignDefinition, BIBLE_BOOKS, []) 產生的 days。
//   · 演算法：用「累計已讀章數」依序蓋掉尺上的整天數；再減「從起始日到今天、尺上有章節的天數」。

export function toScheduleDateKey(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.getFullYear()
    + "-" + String(d.getMonth() + 1).padStart(2, "0")
    + "-" + String(d.getDate()).padStart(2, "0");
}

// 用「累計已讀章數」依序蓋掉基準日程上的整天數。0 章的休息日跳過、不中斷。
// 假設章節是照日程順序讀的（跟全 app 其他進度數字一致）。
export function countScheduleDaysCoveredByChapters(baselineDays, chaptersRead) {
  const target = Math.max(0, Number(chaptersRead) || 0);
  let cumulative = 0;
  let covered = 0;
  for (const day of (baselineDays || [])) {
    const n = day && Array.isArray(day.chapters) ? day.chapters.length : 0;
    if (n === 0) continue;
    if (cumulative + n > target) break;
    cumulative += n;
    covered++;
  }
  return covered;
}

// 從 startDate 到 now、基準日程上「有章節」的天數（休息日不算，兩邊尺一致）。
export function countExpectedScheduleDays(baselineDays, startDate, now = new Date()) {
  const days = baselineDays || [];
  if (!days.length) return 0;
  const start = new Date(String(startDate || "") + "T00:00:00");
  if (Number.isNaN(start.getTime())) return 0;
  start.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const elapsed = Math.round((today - start) / 86400000) + 1;
  return days
    .slice(0, Math.max(0, Math.min(days.length, elapsed)))
    .filter(d => d && Array.isArray(d.chapters) && d.chapters.length > 0)
    .length;
}

// { completedDays, expectedDays, diff }。diff < 0 落後、> 0 超前、-1 顯示「今日未完成」。
export function scheduleDayDiff({ baselineDays, startDate, chaptersRead, now = new Date() }) {
  const completedDays = countScheduleDaysCoveredByChapters(baselineDays, chaptersRead);
  const expectedDays = countExpectedScheduleDays(baselineDays, startDate, now);
  return { completedDays, expectedDays, diff: completedDays - expectedDays };
}

// 補讀天數：基準日程上「該天所有章節都讀了、且最後一章讀在排程日之後」的天數。
// chapterReadDateByKey: Map<`${book}_${chapter}`, 'YYYY-MM-DD'>，只放第一遍的 log。
export function countLateCompletedDays(baselineDays, startDate, chapterReadDateByKey) {
  const days = baselineDays || [];
  const start = new Date(String(startDate || "") + "T00:00:00");
  if (Number.isNaN(start.getTime()) || !days.length || !chapterReadDateByKey) return 0;
  start.setHours(0, 0, 0, 0);
  let late = 0;
  for (let i = 0; i < days.length; i++) {
    const chapters = days[i] && Array.isArray(days[i].chapters) ? days[i].chapters : [];
    if (!chapters.length) continue;
    const scheduled = new Date(start);
    scheduled.setDate(start.getDate() + i);
    const scheduledKey = toScheduleDateKey(scheduled);
    let allRead = true;
    let maxKey = "";
    for (const ch of chapters) {
      const k = chapterReadDateByKey.get(`${ch.book}_${ch.chapter}`);
      if (!k) { allRead = false; break; }
      if (k > maxKey) maxKey = k;
    }
    if (allRead && maxKey && maxKey > scheduledKey) late++;
  }
  return late;
}

// 只有第一遍進行中才算落後 / 超前 / 補讀。
export function isFirstRoundInProgress(plan) {
  if (!plan) return false;
  if ((Number(plan.currentRound) || 1) > 1) return false;
  if (plan.isPlanCompleted) return false;
  return true;
}

// 從一份帶 isReadR1 旗標的 days 算「第一遍已讀章數」。
export function countRound1ChaptersRead(planOrDays) {
  const days = Array.isArray(planOrDays) ? planOrDays : (planOrDays && planOrDays.days) || [];
  let n = 0;
  for (const day of days) {
    if (!day || !Array.isArray(day.chapters)) continue;
    for (const ch of day.chapters) {
      if (ch && (ch.round || 1) === 1 && (ch.isReadR1 || ch.isRead)) n++;
    }
  }
  return n;
}
