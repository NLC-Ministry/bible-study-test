export const FIRST_STAGE_GLOBAL_PLAN_ID = "00000000-0000-0000-c026-000000000001";

export function isValidPlanId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function taipeiDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const read = type => parts.find(part => part.type === type)?.value || "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function planDateKey(plan, field) {
  const value = field === "start"
    ? (plan?.startDate || plan?.start_date)
    : (plan?.endDate || plan?.end_date);
  return String(value || "").slice(0, 10);
}

export function selectDefaultAdminRegistrationStatisticsPlan(plans = [], now = new Date()) {
  const safePlans = Array.isArray(plans) ? plans : [];
  if (safePlans.length === 0) return null;

  const today = taipeiDateKey(now);
  const ongoing = safePlans
    .filter(plan => {
      const start = planDateKey(plan, "start");
      const end = planDateKey(plan, "end");
      return start && start <= today && (!end || today <= end);
    })
    .sort((left, right) => planDateKey(right, "start").localeCompare(planDateKey(left, "start")));
  if (ongoing.length > 0) return ongoing[0];

  const upcoming = safePlans
    .filter(plan => planDateKey(plan, "start") > today)
    .sort((left, right) => planDateKey(left, "start").localeCompare(planDateKey(right, "start")));
  if (upcoming.length > 0) return upcoming[0];

  return [...safePlans]
    .sort((left, right) => planDateKey(right, "end").localeCompare(planDateKey(left, "end")))[0];
}

export function buildAdminRegistrationStatisticsPlans(globalPlans = [], presets = {}) {
  const plansById = new Map();
  const addPlan = plan => {
    if (!plan || !isValidPlanId(plan.id)) return;
    if ((plan.planKind || plan.plan_kind) === "church_campaign") return;
    plansById.set(String(plan.id), plan);
  };

  (Array.isArray(globalPlans) ? globalPlans : []).forEach(addPlan);

  const configuredStageOne = presets?.church_stage_01;
  const stageOne = configuredStageOne || {
    id: FIRST_STAGE_GLOBAL_PLAN_ID,
    name: "第1階段｜第一輪熱身賽",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    planKind: "church_campaign_stage"
  };
  if (!plansById.has(FIRST_STAGE_GLOBAL_PLAN_ID)) {
    addPlan({
      ...stageOne,
      id: FIRST_STAGE_GLOBAL_PLAN_ID,
      globalPlanId: FIRST_STAGE_GLOBAL_PLAN_ID,
      presetKey: "church_stage_01"
    });
  }

  return Array.from(plansById.values())
    .sort((left, right) => String(right.startDate || right.start_date || "")
      .localeCompare(String(left.startDate || left.start_date || "")));
}
