import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  getConfirmedReadingRound,
  getCurrentRoundChapterProgress,
  segmentScheduleDaysForRoundCount
} from "../js/data/current-round-progress.mjs";

const db = readFileSync("js/db.js", "utf8");
const plan = readFileSync("js/modules/plan.js", "utf8");
const utils = readFileSync("js/utils.js", "utf8");
const firstRoundLogs = Array.from({ length: 50 }, (_, index) => ({
  book: "創世記",
  chapter: index + 1,
  round: 1
}));

describe("participant overview current-round progress", () => {
  it("keeps an unconfirmed legacy upgrade on first-pass complete", () => {
    const confirmedRound = getConfirmedReadingRound({
      currentRound: 2,
      upgradePromptHandled: false,
      logs: firstRoundLogs
    });
    expect(confirmedRound).toBe(1);
    expect(getCurrentRoundChapterProgress(firstRoundLogs, confirmedRound, 50).progress).toBe(100);
  });

  it("shows pass two at zero only after the user confirms the upgrade", () => {
    const confirmedRound = getConfirmedReadingRound({
      currentRound: 2,
      upgradePromptHandled: true,
      logs: firstRoundLogs
    });
    expect(confirmedRound).toBe(2);
    expect(getCurrentRoundChapterProgress(firstRoundLogs, confirmedRound, 50)).toEqual({
      round: 2,
      read: 0,
      total: 50,
      progress: 0
    });
  });

  it("recognizes legacy users who already started reading pass two", () => {
    const logs = [...firstRoundLogs, { book: "創世記", chapter: 1, round: 2 }];
    expect(getConfirmedReadingRound({ currentRound: 2, logs })).toBe(2);
    expect(getCurrentRoundChapterProgress(logs, 2, 50).progress).toBe(2);
  });

  it("places completed chapters on their actual check dates and the next pass afterward", () => {
    const days = Array.from({ length: 4 }, (_, index) => ({
      dayNum: index + 1,
      isRestDay: false,
      chapters: index < 2 ? [{ book: "創世記", chapter: index + 1, round: 1 }] : []
    }));
    const actualFirstRoundOffsets = new Map([
      ["創世記_1", 0],
      ["創世記_2", 1]
    ]);
    const scheduled = segmentScheduleDaysForRoundCount(days, 2, [1], [actualFirstRoundOffsets]);

    expect(scheduled[0].chapters).toEqual([expect.objectContaining({ chapter: 1, round: 1 })]);
    expect(scheduled[1].chapters).toEqual([expect.objectContaining({ chapter: 2, round: 1 })]);
    expect(scheduled.slice(0, 2).flatMap(day => day.chapters).some(chapter => chapter.round === 2)).toBe(false);
    expect(scheduled.slice(2).flatMap(day => day.chapters).map(chapter => chapter.round)).toEqual([2, 2]);
  });

  it("persists confirmation, invalidates old totals, and renders only the active round", () => {
    expect(db).toContain("chapters_read: uniqueLogs.length");
    expect(db).toContain("getConfirmedReadingRound({");
    expect(plan).toContain("plan.upgradePromptHandled = true");
    expect(plan).toContain('statusStr = "第一遍完成"');
    // 0% now reads as "in progress" rather than "complete 0%".
    expect(plan).toContain('statusStr = memberProgress > 0 ? `第${memberRound}遍完成${memberProgress}%` : `第${memberRound}遍進行中`');
    expect(plan).toContain("const visibleChapters = (selectedDay.chapters || []).filter");
    expect(plan).toContain("window._cachedAllUsersList = null");
    expect(utils).toContain("log.read_at || log.readAt");
    expect(utils).toContain("segmentScheduleDaysForRoundCount(");
  });
});