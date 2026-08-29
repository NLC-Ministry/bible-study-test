import { describe, expect, it } from "vitest";
import {
  FIRST_STAGE_GLOBAL_PLAN_ID,
  buildAdminRegistrationStatisticsPlans,
  selectDefaultAdminRegistrationStatisticsPlan
} from "../js/modules/admin-registration-plan-options.mjs";

describe("admin registration statistics plan options", () => {
  it("offers stage one even when no global plan has loaded", () => {
    const plans = buildAdminRegistrationStatisticsPlans([], {});
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id: FIRST_STAGE_GLOBAL_PLAN_ID,
      name: "第1階段｜第一輪熱身賽",
      presetKey: "church_stage_01"
    });
  });

  it("does not wait for the plan start date", () => {
    const plans = buildAdminRegistrationStatisticsPlans([], {
      church_stage_01: {
        id: FIRST_STAGE_GLOBAL_PLAN_ID,
        name: "尚未開始的第一階段",
        startDate: "2099-08-01",
        planKind: "church_campaign_stage"
      }
    });
    expect(plans.map(plan => plan.id)).toContain(FIRST_STAGE_GLOBAL_PLAN_ID);
  });

  it("uses the loaded stage record once and excludes campaign containers", () => {
    const otherId = "11111111-1111-4111-8111-111111111111";
    const plans = buildAdminRegistrationStatisticsPlans([
      { id: FIRST_STAGE_GLOBAL_PLAN_ID, name: "資料庫第一階段", plan_kind: "church_campaign_stage" },
      { id: "22222222-2222-4222-8222-222222222222", name: "活動容器", plan_kind: "church_campaign" },
      { id: otherId, name: "另一個計畫", plan_kind: "custom" }
    ], {});

    expect(plans.filter(plan => plan.id === FIRST_STAGE_GLOBAL_PLAN_ID)).toHaveLength(1);
    expect(plans.find(plan => plan.id === FIRST_STAGE_GLOBAL_PLAN_ID)?.name).toBe("資料庫第一階段");
    expect(plans.map(plan => plan.id)).toContain(otherId);
    expect(plans.some(plan => plan.plan_kind === "church_campaign")).toBe(false);
  });

  it("defaults to the plan currently running in Taiwan instead of matching its name", () => {
    const plans = [
      { id: "11111111-1111-4111-8111-111111111111", name: "第一輪舊計畫", startDate: "2026-08-01", endDate: "2026-08-20" },
      { id: "22222222-2222-4222-8222-222222222222", name: "目前進行中的計畫", startDate: "2026-08-21", endDate: "2026-09-10" }
    ];
    expect(selectDefaultAdminRegistrationStatisticsPlan(plans, new Date("2026-08-30T04:00:00Z"))?.id)
      .toBe("22222222-2222-4222-8222-222222222222");
  });

  it("falls back to the nearest upcoming plan when none is ongoing", () => {
    const plans = [
      { id: "11111111-1111-4111-8111-111111111111", startDate: "2026-09-20", endDate: "2026-09-30" },
      { id: "22222222-2222-4222-8222-222222222222", startDate: "2026-09-05", endDate: "2026-09-15" }
    ];
    expect(selectDefaultAdminRegistrationStatisticsPlan(plans, new Date("2026-08-30T04:00:00Z"))?.id)
      .toBe("22222222-2222-4222-8222-222222222222");
  });
});
