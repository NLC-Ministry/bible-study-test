import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getPlanProgressLockReason, isPlanProgressLocked } from "../js/data/plan-progress-availability.mjs";

const read = path => readFileSync(path, "utf8");

describe("locked campaign stage progress", () => {
  it("locks hidden stages and released stages before their Taiwan start date", () => {
    const stage = { planKind: "church_campaign_stage", startDate: "2026-09-01" };
    expect(getPlanProgressLockReason(stage, { hidden: true, todayISO: "2026-09-01" })).toBe("unreleased");
    expect(getPlanProgressLockReason(stage, { hidden: false, todayISO: "2026-08-31" })).toBe("upcoming");
    expect(isPlanProgressLocked(stage, { hidden: false, todayISO: "2026-09-01" })).toBe(false);
  });

  it("guards both bottom-dwell readers and the shared data write path", () => {
    const bible = read("js/modules/bible.js");
    const plan = read("js/modules/plan.js");
    const db = read("js/db.js");
    expect(bible).toContain("isPlanProgressLocked(taskContext.plan");
    expect(plan).toContain("isPlanProgressLocked(task.plan");
    expect(db).toContain('progressError.code = "PLAN_PROGRESS_LOCKED"');
  });

  it("enforces the same rule in Postgres for service-role writes", () => {
    const migration = read("supabase/migrations/0098_block_progress_before_stage_start.sql");
    expect(migration).toContain("campaign_stage_progress_not_open");
    expect(migration).toContain("AT TIME ZONE 'Asia/Taipei'");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OF plan_id, user_id, book, chapter, round, read_at");
    expect(migration).toContain("enrollment_user_id IS DISTINCT FROM NEW.user_id");
    expect(migration).toContain("reading_log_plan_owner_mismatch");
  });
});
