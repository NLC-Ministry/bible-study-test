import { describe, expect, it } from "vitest";
import {
  getMemberOverallPlanProgress,
  getTeamOverallPlanProgress,
  computePlanScopedStreak
} from "../js/modules/team-progress-metrics.mjs";

describe("current-round team progress", () => {
  it("shows zero percent after pass two is confirmed but no pass-two chapter is read", () => {
    expect(getMemberOverallPlanProgress({ currentRound: 2, chaptersRead: 0 }, 50)).toEqual({
      currentRoundRead: 0,
      completedChapters: 50,
      journeyChapters: 100,
      progress: 0,
      round: 2
    });
  });

  it("averages only each member's current-round completion", () => {
    const result = getTeamOverallPlanProgress([
      { currentRound: 2, chaptersRead: 0 },
      { currentRound: 1, chaptersRead: 2 },
      { currentRound: 1, chaptersRead: 0 }
    ], 50);
    expect(result.rows.map(row => row.progress)).toEqual([0, 4, 0]);
    expect(result.averageProgress).toBe(1);
    expect(result.completedChapters).toBe(52);
    expect(result.currentRoundReadChapters).toBe(2);
    expect(result.currentRoundTargetChapters).toBe(150);
  });
});

describe("computePlanScopedStreak — 不同計畫的最高連續獨立算", () => {
  const at = (d) => `${d}T09:00:00`;

  it("counts only the plan's own logs — an 8月正辦 read does not extend a 9月延後梯次 streak", () => {
    const logs = [
      // 8 月正辦（別的計畫），連 3 天
      { plan_id: "official", book: "創世記", chapter: 1, read_at: at("2026-08-29") },
      { plan_id: "official", book: "創世記", chapter: 2, read_at: at("2026-08-30") },
      { plan_id: "official", book: "創世記", chapter: 3, read_at: at("2026-08-31") },
      // 9 月延後梯次，連 2 天（跟 8/31 不連續，因為是不同計畫）
      { plan_id: "cohort", book: "創世記", chapter: 1, read_at: at("2026-09-02") },
      { plan_id: "cohort", book: "創世記", chapter: 2, read_at: at("2026-09-03") }
    ];
    expect(computePlanScopedStreak(logs, { planId: "cohort" })).toBe(2);
    expect(computePlanScopedStreak(logs, { planId: "official" })).toBe(3);
  });

  it("matches by presetKey too, and treats same-day multi-chapter as one day", () => {
    const logs = [
      { presetKey: "church_stage_cohort_01", book: "創世記", chapter: 1, read_at: at("2026-09-01") },
      { presetKey: "church_stage_cohort_01", book: "創世記", chapter: 2, read_at: at("2026-09-01") },
      { presetKey: "church_stage_cohort_01", book: "創世記", chapter: 3, read_at: at("2026-09-02") }
    ];
    expect(computePlanScopedStreak(logs, { presetKey: "church_stage_cohort_01" })).toBe(2);
  });

  it("returns the longest run, not the current one", () => {
    const logs = [
      { plan_id: "p", read_at: at("2026-09-01") },
      { plan_id: "p", read_at: at("2026-09-02") },
      { plan_id: "p", read_at: at("2026-09-03") }, // run of 3
      { plan_id: "p", read_at: at("2026-09-10") }  // gap, then run of 1
    ];
    expect(computePlanScopedStreak(logs, { planId: "p" })).toBe(3);
  });

  it("preFiltered trusts the caller (other users' already-scoped allLogsCache)", () => {
    const logs = [
      { plan_id: "someone-elses-enrollment", read_at: at("2026-09-01") },
      { plan_id: "someone-elses-enrollment", read_at: at("2026-09-02") }
    ];
    expect(computePlanScopedStreak(logs, { planId: "mine" })).toBe(0);
    expect(computePlanScopedStreak(logs, { preFiltered: true })).toBe(2);
  });

  it("handles empty / missing input", () => {
    expect(computePlanScopedStreak([], { planId: "p" })).toBe(0);
    expect(computePlanScopedStreak(null, { planId: "p" })).toBe(0);
    expect(computePlanScopedStreak([{ plan_id: "p", read_at: "not-a-date" }], { planId: "p" })).toBe(0);
  });
});