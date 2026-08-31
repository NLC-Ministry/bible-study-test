import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  removePlanReadingLogs,
  resetPlanProgressState
} from "../js/modules/plan-progress-reset.mjs";

describe("plan progress reset", () => {
  const plan = {
    id: "plan-1",
    presetKey: "campaign-stage-1",
    currentRound: 2,
    upgradePromptHandled: true,
    progress: 40,
    completedChapters: 2,
    isPlanCompleted: true,
    days: [{
      dayNum: 1,
      chapters: [
        { book: "馬太福音", chapter: 1, round: 1, isRead: true, isReadR1: true },
        { book: "馬太福音", chapter: 1, round: 2, isRead: true, isReadR2: true }
      ]
    }]
  };

  it("removes every scoped round and matching legacy plan log", () => {
    const logs = [
      { plan_id: "plan-1", book: "馬太福音", chapter: 1, round: 1 },
      { plan_id: "plan-1", book: "馬太福音", chapter: 1, round: 2 },
      { presetKey: "campaign-stage-1", book: "馬太福音", chapter: 1, round: 1 },
      { book: "馬太福音", chapter: 1, round: 1 },
      { plan_id: "other-plan", book: "馬太福音", chapter: 1, round: 1 },
      { book: "約翰福音", chapter: 1, round: 1 }
    ];

    expect(removePlanReadingLogs(logs, plan)).toEqual([
      { plan_id: "other-plan", book: "馬太福音", chapter: 1, round: 1 },
      { book: "約翰福音", chapter: 1, round: 1 }
    ]);
  });

  it("returns an upgraded plan to a clean first round", () => {
    const reset = resetPlanProgressState(structuredClone(plan));
    expect(reset).toMatchObject({
      currentRound: 1,
      upgradePromptHandled: false,
      progress: 0,
      completedChapters: 0,
      isPlanCompleted: false,
      isRound2Completed: false
    });
    expect(reset.days.flatMap(day => day.chapters).every(chapter =>
      chapter.isRead === false &&
      Object.entries(chapter).every(([key, value]) => !/^isReadR\d+$/.test(key) || value === false)
    )).toBe(true);
  });

  it("deletes by plan_id, resets the persisted round, and invalidates caches", () => {
    const source = readFileSync(new URL("../js/modules/plan.js", import.meta.url), "utf8");
    const resetStart = source.indexOf("// 1. Clear the persisted logs");
    const resetEnd = source.indexOf("showToast(", resetStart);
    const resetFlow = source.slice(resetStart, resetEnd);

    expect(resetFlow).toContain('.eq("plan_id", planId)');
    expect(resetFlow).not.toContain('.eq("preset_key"');
    expect(resetFlow).toContain("current_round: 1");
    expect(resetFlow).toContain("upgrade_prompt_handled: false");
    expect(resetFlow).toContain("removePlanReadingLogs(state.readingLogs, plan)");
    expect(resetFlow).toContain("resetPlanProgressState(plan)");
    expect(resetFlow).toContain("window._cachedAllUsersList = null");
  });

  it("prunes associated stage badges from localStorage on plan reset", () => {
    const campaignPlan = {
      id: "plan-stage-1",
      stageNo: 1,
      planKind: "church_campaign_stage"
    };

    const store = new Map();
    const mockStorage = {
      getItem: (key) => store.get(key) || null,
      setItem: (key, val) => store.set(key, String(val)),
      removeItem: (key) => store.delete(key)
    };

    vi.stubGlobal("localStorage", mockStorage);

    localStorage.setItem("unlocked_badges", JSON.stringify(["church_stage_award_1", "read_first_chapter"]));
    localStorage.setItem("church_stage_completed_rounds_1", "1");
    localStorage.setItem("church_stage_award_1_unlocked", "true");
    localStorage.setItem("notified_church_stage_award_1", "true");

    resetPlanProgressState(campaignPlan);

    const remainingUnlocked = JSON.parse(localStorage.getItem("unlocked_badges") || "[]");
    expect(remainingUnlocked).toEqual(["read_first_chapter"]);
    expect(localStorage.getItem("church_stage_completed_rounds_1")).toBeNull();
    expect(localStorage.getItem("church_stage_award_1_unlocked")).toBeNull();
    expect(localStorage.getItem("notified_church_stage_award_1")).toBeNull();

    vi.unstubAllGlobals();
  });
});
