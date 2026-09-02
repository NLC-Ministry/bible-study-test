import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = path => readFileSync(resolve(path), "utf8");
const migration = read("supabase/migrations/0056_lock_campaign_stages_until_admin_release.sql");
const visibilityMigration = read("supabase/migrations/0057_show_locked_campaign_stages.sql");
const planModule = read("js/modules/plan.js");
const db = read("js/db.js");
const campaign = read("js/data/church_campaign.js");
const edgeFunction = read("supabase/functions/nlc-data/index.ts");

describe("campaign stage release control", () => {
  it("locks stages 2 through 10 while keeping stage 1 open", () => {
    expect(migration).toContain("WHEN id = '00000000-0000-0000-c026-000000000001'::UUID THEN FALSE");
    expect(migration).toContain("ELSE TRUE");
    expect(campaign).toContain("isHidden: Number(stage.stageNo) > 1");
  });

  it("preserves the administrator visibility choice when campaign rules are republished", () => {
    expect(migration).toContain("stage_no <> 1");
    expect(migration).toContain("Deliberately preserve global_plans.is_hidden");
    const conflictUpdate = migration.match(/ON CONFLICT \(id\) DO UPDATE SET[\s\S]*?published_at = EXCLUDED\.published_at;/)?.[0] || "";
    expect(conflictUpdate).not.toMatch(/is_hidden\s*=/);
  });

  it("blocks hidden-stage enrollment and team registration in the database", () => {
    expect(migration).toContain("campaign_stage_not_open");
    expect(migration).toContain("trg_reading_plan_stage_open");
    expect(migration).toContain("trg_reading_log_stage_open");
    expect(migration).toContain("trg_reading_team_stage_open");
    expect(migration).toContain("trg_reading_team_member_stage_open");
  });

  it("shows an administrator release button and verifies persistence", () => {
    expect(planModule).toContain("admin-toggle-hidden-plan-btn");
    expect(planModule).toContain("開放給使用者");
    expect(planModule).toContain("暫停開放");
    expect(db).toContain('.select("id, is_hidden")');
    expect(db).toContain("Global plan visibility update was not verified");
  });

  it("shows locked campaign stages to members without enrollment actions", () => {
    expect(visibilityMigration).toContain("plan_kind = 'church_campaign_stage'");
    expect(edgeFunction).toContain('query.or("is_hidden.eq.false,plan_kind.eq.church_campaign_stage")');
    expect(planModule).toContain("missingCampaignStages");
    // 探索清單顯示鎖住階段的判斷：現在額外要求 discoverWhenLocked（月度期末賽 = true，
    // 第三階段之後 = false → 完全隱藏）。
    expect(planModule).toContain("window.isCampaignStageLocked(plan)");
    expect(planModule).toContain("window.isCampaignStageDiscoverableWhileLocked(plan)");
    // 第三階段起的隱藏階段：探索清單只有系統管理員 (role === "admin") 看得到。
    expect(planModule).toContain("const isFullyHiddenCampaignStage = isHidden");
    expect(planModule).toContain('if (isFullyHiddenCampaignStage && viewerRole !== "admin") return false;');
    expect(planModule).toContain("if (isHidden && !canManageHiddenPlans() && !showAsLocked) return false;");
    expect(planModule).toContain("const isLockedStage = window.isCampaignStageLocked(plan)");
    // 鎖住的教會階段（以及每日靈修計畫）在探索清單卡片不顯示加入/建隊動作。
    expect(planModule).toContain('(isLockedStage || isDevotional) ? "" : renderPlanCardActions([');
    expect(planModule).toContain("if (isLockedStage) {");
    expect(planModule).toContain("openPlanDetailsDialog(plan);");
    expect(planModule).toContain('icon: "lock"');
  });
});