import { isCampaignStageKind } from "./campaign-stage-kinds.mjs";

function taiwanTodayISO(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getPlanProgressLockReason(plan, options = {}) {
  if (!plan) return null;

  const hidden = options.hidden ?? Boolean(plan.isHidden || plan.is_hidden);
  if (isCampaignStageKind(plan) && hidden) return "unreleased";

  const startDate = String(plan.startDate || plan.start_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
  const todayISO = String(options.todayISO || taiwanTodayISO(options.now)).slice(0, 10);
  return todayISO < startDate ? "upcoming" : null;
}

export function isPlanProgressLocked(plan, options = {}) {
  return getPlanProgressLockReason(plan, options) !== null;
}
