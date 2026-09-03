import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  cleanupProductionStorage,
  cleanupRetiredOfflineOperations,
  isRetiredPlanRecord,
  RETIRED_BADGE_IDS
} from "../js/production-cleanup.mjs";
import { isRetiredPlanRequest } from "../supabase/functions/nlc-data/retired-resources.ts";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

describe("production plan cleanup", () => {
  it("removes retired plans, their local progress and queued mutations without touching current stages", async () => {
    const currentPlan = {
      id: "00000000-0000-0000-c026-000000000001",
      globalPlanId: "00000000-0000-0000-c026-000000000001",
      presetKey: "church_stage_01",
      name: "第1階段｜第一輪熱身賽"
    };
    const retiredPlan = {
      id: "old-enrollment-id",
      presetKey: "q1",
      name: "第一季速讀：2026年7月~9月"
    };
    const storage = new MemoryStorage({
      active_reading_plans: JSON.stringify([retiredPlan, currentPlan]),
      global_plans_presets: JSON.stringify([retiredPlan, currentPlan]),
      reading_logs: JSON.stringify([
        { plan_id: "old-enrollment-id", presetKey: "q1", book: "創世記", chapter: 1 },
        { plan_id: currentPlan.id, presetKey: currentPlan.presetKey, book: "創世記", chapter: 2 }
      ]),
      selected_plan_key: "q1",
      unlocked_badges: JSON.stringify(["subscribe_plan", "church_stage_award_1"]),
      notified_subscribe_plan: "true",
      date_unlocked_subscribe_plan_lvl_1: "2026年1月1日"
    });

    const result = cleanupProductionStorage(storage);
    expect(result).toEqual({ plans: 1, logs: 1, badges: 1 });
    expect(JSON.parse(storage.getItem("active_reading_plans"))).toEqual([currentPlan]);
    expect(JSON.parse(storage.getItem("reading_logs"))).toHaveLength(1);
    expect(storage.getItem("selected_plan_key")).toBeNull();
    expect(JSON.parse(storage.getItem("unlocked_badges"))).toEqual(["church_stage_award_1"]);
    expect(storage.getItem("notified_subscribe_plan")).toBeNull();

    const deleted = [];
    const operations = [
      { id: "old-op", payload: { presetKey: "q2" } },
      { id: "current-op", payload: { planId: currentPlan.id, presetKey: currentPlan.presetKey } }
    ];
    const dbClient = {
      getAll: async () => operations,
      delete: async (_store, id) => deleted.push(id)
    };
    await expect(cleanupRetiredOfflineOperations(dbClient)).resolves.toBe(1);
    expect(deleted).toEqual(["old-op"]);
    expect(isRetiredPlanRecord(currentPlan)).toBe(false);
  });

  it("uses cascading foreign keys, ordered deletes and rollback assertions", () => {
    const sql = read("supabase/migrations/0026_production_cleanup_obsolete_plans_badges.sql");
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/COMMIT;\s*$/);
    expect(sql.match(/ON DELETE CASCADE/g)?.length).toBeGreaterThanOrEqual(2);
    expect(sql.indexOf("DELETE FROM public.reading_plans")).toBeLessThan(
      sql.indexOf("DELETE FROM public.global_plans")
    );
    expect(sql).toContain("DELETE FROM public.care_reminders");
    expect(sql).toContain("DELETE FROM public.reading_teams");
    expect(sql).toContain("retired plan children remain");
    expect(sql).toContain("RAISE EXCEPTION 'cleanup_failed:");
    expect(sql).toContain("USING retired_badge_ids");
    expect(sql).not.toMatch(/DELETE FROM public\.global_plans[\s\S]*\bLIKE\b/);
  });

  it("maps retired plan requests to Not Found while preserving current plans", () => {
    expect(isRetiredPlanRequest({
      table: "global_plans",
      action: "select",
      filters: [{ type: "eq", column: "id", value: "00000000-0000-0000-c026-000000009999" }]
    })).toBe(true);
    expect(isRetiredPlanRequest({
      action: "rpc",
      function: "join_reading_team_by_code",
      args: { p_global_plan_id: "00000000-0000-0000-c026-000000009999" }
    })).toBe(true);
    expect(isRetiredPlanRequest({
      table: "global_plans",
      action: "select",
      filters: [{ type: "eq", column: "id", value: "00000000-0000-0000-c026-000000000001" }]
    })).toBe(false);

    const edge = read("supabase/functions/nlc-data/index.ts");
    expect(edge).toContain('error: "resource_not_found"');
    expect(edge).toContain('resource: "reading_plan" }, 404');
  });
});

describe("legacy badge cleanup", () => {
  it("keeps only the ten campaign badge definitions and rejects unknown badge IDs", () => {
    const gamification = read("js/gamification.js");
    const utils = read("js/utils.js");
    const html = read("index.html");

    for (const badgeId of RETIRED_BADGE_IDS) {
      expect(gamification).not.toContain(`id: "${badgeId}"`);
      expect(utils).not.toContain(`${badgeId}:`);
    }
    expect(gamification).toContain("window.createChurchCampaignStageDefinitions()");
    expect(gamification).toContain('status: 404, error: "badge_not_found"');
    expect(html).toContain('id="badge-wall-summary">0 / 10');
    expect(utils).not.toContain("tier-bronze");
  });
});
