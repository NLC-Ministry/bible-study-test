function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function getMemberOverallPlanProgress(member, totalChapters) {
  const chaptersPerRound = toNonNegativeNumber(totalChapters);
  const round = Math.max(1, Math.floor(toNonNegativeNumber(member && (member.currentRound ?? member.current_round ?? member.round)) || 1));
  const rawReadCount = member && (
    member.chaptersRead ?? 
    member.chapters_read ?? 
    member.completedChapters ?? 
    member.completed_chapters ?? 
    member.readChapters ?? 
    member.read_chapters ?? 
    member.completed ?? 
    (member.profile && (member.profile.chapters_read ?? member.profile.completed_chapters)) ??
    0
  );
  const currentRoundRead = Math.min(chaptersPerRound > 0 ? chaptersPerRound : Infinity, toNonNegativeNumber(rawReadCount));
  const completedPreviousRounds = (round - 1) * (chaptersPerRound > 0 ? chaptersPerRound : 0);
  const completedChapters = completedPreviousRounds + currentRoundRead;
  const journeyChapters = round * chaptersPerRound;
  const progress = chaptersPerRound > 0
    ? Math.min(100, Math.round(currentRoundRead / chaptersPerRound * 100))
    : 0;

  return { currentRoundRead, completedChapters, journeyChapters, progress, round };
}

// 「最高連續」：某個計畫自己的最長連續打卡天數。
// 不同計畫各算各的——只看歸屬這個計畫的 reading_logs（plan_id / presetKey），
// 完全沒有歸屬的舊日誌當相容退路。preFiltered=true 表示 logs 已在查詢層被
// 限定到這個計畫（例如別人的 allLogsCache），此時不再套 plan 比對。
export function computePlanScopedStreak(logs, { planId = null, presetKey = null, preFiltered = false } = {}) {
  if (!Array.isArray(logs) || logs.length === 0) return 0;

  const matchesPlan = (log) => {
    if (preFiltered) return true;
    if (planId && log.plan_id && log.plan_id === planId) return true;
    if (presetKey && (log.presetKey === presetKey || log.preset_key === presetKey)) return true;
    return !log.plan_id && !log.presetKey && !log.preset_key;
  };

  const toDayKey = (value) => {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.getFullYear() + "-"
      + String(date.getMonth() + 1).padStart(2, "0") + "-"
      + String(date.getDate()).padStart(2, "0");
  };

  const days = [...new Set(
    logs.filter(matchesPlan).map(log => toDayKey(log.read_at)).filter(Boolean)
  )].sort();
  if (days.length === 0) return 0;

  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1] + "T00:00:00");
    const cur = new Date(days[i] + "T00:00:00");
    const diff = Math.round((cur - prev) / 86400000);
    if (diff === 1) {
      run += 1;
      if (run > best) best = run;
    } else if (diff > 1) {
      run = 1;
    }
  }
  return best;
}

export function getTeamOverallPlanProgress(members, totalChapters) {
  const rows = (Array.isArray(members) ? members : []).map(member =>
    getMemberOverallPlanProgress(member, totalChapters)
  );
  const completedChapters = rows.reduce((sum, row) => sum + row.completedChapters, 0);
  const currentRoundReadChapters = rows.reduce((sum, row) => sum + row.currentRoundRead, 0);
  const currentRoundTargetChapters = rows.length * toNonNegativeNumber(totalChapters);
  const journeyChapters = rows.reduce((sum, row) => sum + row.journeyChapters, 0);
  const averageProgress = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + row.progress, 0) / rows.length)
    : 0;

  return {
    averageProgress,
    completedChapters,
    currentRoundReadChapters,
    currentRoundTargetChapters,
    journeyChapters,
    rows
  };
}