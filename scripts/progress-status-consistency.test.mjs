import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("progress status consistency unit tests", () => {
  it("verifies renderGroupParticipantsRankingTable in plan.js compares an exact days-completed figure against expected days, derived the same way for everyone", () => {
    // `completed` is a chapter count (unique book_chapter logs — see
    // uniquePlanLogs/chapters_read), never a day count, so it cannot be
    // diffed directly against a day count (expectedDaysCount) — that breaks
    // on any plan scheduling more than one chapter per day. Converting via
    // progress% × totalDays would "fix" the units but rounds twice (the
    // server already rounds plan_progress to a whole percent) and can put
    // two people with the exact same chapter total on opposite sides of a
    // day boundary. countExactDaysCoveredByChapters walks the shared
    // schedule and counts whole days covered by the exact integer chapter
    // count instead — deterministic, and identical for identical inputs —
    // applied the same way whether it's "me" or another member, and capped
    // at every day once a member has finished a full round (round 2+ /
    // isPlanCompleted) so finishing a round never reads as newly behind.
    const code = readFileSync("js/modules/plan.js", "utf8");
    expect(code).toContain("const countExactDaysCoveredByChapters = (days, chaptersRead) => {");
    expect(code).toContain("diff = completedDays - expectedDaysCount;");
    expect(code).toContain("memberIsCompletedOnce = state.activePlan.isPlanCompleted || (state.activePlan.currentRound || 1) > 1;");
    expect(code).toContain("memberIsCompletedOnce = (u.current_round || 1) > 1;");
    expect(code).not.toContain("diff = completed - expectedChaptersCount;");
    expect(code).not.toContain("diff = completed - expectedDaysCount;");
    expect(code).not.toContain("diff = completedDaysCount - expectedDaysCount;");
    expect(code).not.toContain("diff = completedDaysCapped - expectedDaysCount;");
    // Rest days (no chapters scheduled) must not inflate the expected side —
    // countExactDaysCoveredByChapters already skips them when counting
    // daysCovered, so expectedDaysCount has to skip them the same way or a
    // member perfectly on schedule reads as behind by however many rest
    // days have passed.
    expect(code).toContain("const expectedDaysCount = baselineScheduleDays");
    expect(code).toContain(".filter(day => day.chapters && day.chapters.length > 0)");
    // The comparison yardstick must be the church's canonical stage schedule
    // (round 1, 7 days/week), NOT the viewer's own state.activePlan.days —
    // that is reshaped by the viewer's personal rest days / (removed) level
    // and would contaminate every ranked member's 落後/超前 figure.
    expect(code).toContain("baselineScheduleDays = ");
    expect(code).toContain("window.getCanonicalStageScheduleDays(state.activePlan)");
    expect(code).toContain("countExactDaysCoveredByChapters(baselineScheduleDays, completed)");
  });

  it("verifies round 2+ progress displays '第2遍進行中' when progress is 0%", () => {
    const code = readFileSync("js/modules/plan.js", "utf8");
    expect(code).toContain('statusStr = memberProgress > 0 ? `第${memberRound}遍完成${memberProgress}%` : `第${memberRound}遍進行中`;');
  });

  it("countExactDaysCoveredByChapters gives identical days for identical chapter totals, with no rounding drift", () => {
    const code = readFileSync("js/modules/plan.js", "utf8");
    const start = code.indexOf("const countExactDaysCoveredByChapters = (days, chaptersRead) => {");
    const end = code.indexOf("};", start) + 2;
    const fnSource = code.slice(start, end);
    const countExactDaysCoveredByChapters = new Function(`
      ${fnSource}
      return countExactDaysCoveredByChapters;
    `)();

    // 2-chapters-per-day plan, 10 days.
    const twoPerDay = Array.from({ length: 10 }, () => ({ chapters: [{}, {}] }));

    // The exact scenario the user described: they've done 7 real days
    // (14 chapters) on a 2-chapters/day plan.
    expect(countExactDaysCoveredByChapters(twoPerDay, 14)).toBe(7);

    // Two people who both read exactly 16 chapters against the same
    // schedule must land on the exact same days-covered — no double
    // rounding, no per-person drift.
    expect(countExactDaysCoveredByChapters(twoPerDay, 16)).toBe(8);
    expect(countExactDaysCoveredByChapters(twoPerDay, 16)).toBe(countExactDaysCoveredByChapters(twoPerDay, 16));

    // A partial day's chapters don't count as a completed day.
    expect(countExactDaysCoveredByChapters(twoPerDay, 15)).toBe(7);

    // Uniform 1-chapter-per-day plan behaves like a plain day count.
    const onePerDay = Array.from({ length: 10 }, () => ({ chapters: [{}] }));
    expect(countExactDaysCoveredByChapters(onePerDay, 6)).toBe(6);

    // Rest days (no chapters) don't consume a "slot".
    const withRestDays = [{ chapters: [{}] }, { chapters: [] }, { chapters: [{}] }, { chapters: [{}] }];
    expect(countExactDaysCoveredByChapters(withRestDays, 2)).toBe(2);
  });

  it("a member perfectly on schedule never reads as behind just because rest days occurred", () => {
    const code = readFileSync("js/modules/plan.js", "utf8");
    const start = code.indexOf("const countExactDaysCoveredByChapters = (days, chaptersRead) => {");
    const end = code.indexOf("};", start) + 2;
    const countExactDaysCoveredByChapters = new Function(`
      ${code.slice(start, end)}
      return countExactDaysCoveredByChapters;
    `)();

    // A week with a rest day every 3rd slot: read, read, rest, read, read, rest, read.
    const schedule = [
      { chapters: [{}] }, { chapters: [{}] }, { chapters: [] },
      { chapters: [{}] }, { chapters: [{}] }, { chapters: [] },
      { chapters: [{}] }
    ];
    const elapsedDays = 7; // "today" is the 7th calendar day of the plan

    // Same formula the fix uses for expectedDaysCount: elapsed days, minus
    // the rest days among them.
    const expectedDaysCount = schedule
      .slice(0, elapsedDays)
      .filter(day => day.chapters && day.chapters.length > 0).length;
    expect(expectedDaysCount).toBe(5); // 7 elapsed calendar days, 2 of them rest days

    // The member has read exactly what was assigned through today (5 reading days' worth).
    const chaptersAssignedThroughToday = schedule
      .slice(0, elapsedDays)
      .reduce((sum, day) => sum + day.chapters.length, 0);
    const daysCovered = countExactDaysCoveredByChapters(schedule, chaptersAssignedThroughToday);

    expect(daysCovered).toBe(expectedDaysCount); // diff = 0 → "在進度上", not falsely "落後2天"
  });
});
