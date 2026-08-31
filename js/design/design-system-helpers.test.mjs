import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getHonorBadgeItemClasses,
  getMobileNavAriaState,
  getExpectedPlanDayCount,
  getNextReadingPlanDay,
  getPlanProgressBadgeClass,
  getPlanProgressStatus,
  getStatMetricConfig,
} from "./design-system-helpers.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function makePlan(overrides = {}) {
  const days = Array.from({ length: 10 }, (_, i) => ({
    dayNum: i + 1,
    chapters: [{ book: "創", chapter: i + 1, isReadR1: i < 3 }],
  }));
  return {
    startDate: "2026-01-01",
    days,
    currentRound: 1,
    ...overrides,
  };
}

describe("getPlanProgressBadgeClass", () => {
  it("returns danger when behind schedule", () => {
    const plan = makePlan();
    const badgeClass = getPlanProgressBadgeClass(plan, {
      getExpected: () => 5,
      getNextDay: () => plan.days[2],
    });
    expect(badgeClass).toBe("stat-badge--danger");
  });

  it("returns success when ahead of schedule", () => {
    const plan = makePlan();
    const badgeClass = getPlanProgressBadgeClass(plan, {
      getExpected: () => 2,
      getNextDay: () => plan.days[5],
    });
    expect(badgeClass).toBe("stat-badge--success");
  });

  it("returns brand when on schedule", () => {
    const plan = makePlan();
    const badgeClass = getPlanProgressBadgeClass(plan, {
      getExpected: () => 3,
      getNextDay: () => plan.days[3],
    });
    expect(badgeClass).toBe("stat-badge--brand");
  });

  it("returns success for every round after the first", () => {
    const plan = makePlan({ currentRound: 3 });
    expect(getPlanProgressBadgeClass(plan)).toBe("stat-badge--success");
  });
});

describe("flexible schedule rest days", () => {
  const flexiblePlan = makePlan({
    startDate: "2026-01-04",
    days: [
      { dayNum: 1, chapters: [] },
      { dayNum: 2, chapters: [{ book: "Gen", chapter: 1 }] },
      { dayNum: 3, chapters: [] },
      { dayNum: 4, chapters: [{ book: "Gen", chapter: 2 }] },
    ],
  });

  it("skips rest days when finding the next reading day", () => {
    expect(getNextReadingPlanDay(flexiblePlan).dayNum).toBe(2);
  });

  it("counts only scheduled reading days in expected progress", () => {
    expect(getExpectedPlanDayCount(flexiblePlan, new Date(2026, 0, 6, 12))).toBe(1);
  });

  it("does not count a rest day before the next task as completed progress", () => {
    const status = getPlanProgressStatus(flexiblePlan, { getExpected: () => 1 });
    expect(status.diff).toBe(-1);
  });
});


describe("getStatMetricConfig", () => {
  it("maps streak to fire icon and warning modifier", () => {
    expect(getStatMetricConfig("streak")).toEqual({
      icon: "fire",
      modifier: "warning",
    });
  });

  it("maps today to book icon and brand modifier", () => {
    expect(getStatMetricConfig("today")).toEqual({
      icon: "bookOpen",
      modifier: "brand",
    });
  });
});

describe("getHonorBadgeItemClasses", () => {
  it("returns unlocked and locked class strings", () => {
    expect(getHonorBadgeItemClasses(true)).toBe("honor-badge-item unlocked");
    expect(getHonorBadgeItemClasses(false)).toBe("honor-badge-item locked");
  });
});

describe("getMobileNavAriaState", () => {
  it("marks active tab with aria-current page", () => {
    const state = getMobileNavAriaState("dashboard-view", "dashboard-view");
    expect(state.ariaSelected).toBe("true");
    expect(state.ariaCurrent).toBe("page");
    expect(state.className).toContain("active");
  });

  it("marks inactive tab without aria-current", () => {
    const state = getMobileNavAriaState("dashboard-view", "plan-view");
    expect(state.ariaSelected).toBe("false");
    expect(state.ariaCurrent).toBeUndefined();
  });
});

describe("getPlanProgressStatus labels", () => {
  it("labels behind schedule as 落後", () => {
    const plan = makePlan();
    const status = getPlanProgressStatus(plan, {
      getExpected: () => 5,
      getNextDay: () => plan.days[2],
    });
    expect(status.label).toMatch(/^落後/);
  });

  it("labels 1 day behind schedule as 今日未完成", () => {
    // makePlan(): 3 chapters read (isReadR1: i < 3), 1 chapter/day baseline → 3 days covered.
    const plan = makePlan();
    const status = getPlanProgressStatus(plan, {
      getExpected: () => 4,
    });
    expect(status.label).toBe("今日未完成");
  });

  it("shows only the current round and its completion percentage after round one", () => {
    const plan = makePlan({ currentRound: 2, progress: 38 });
    const status = getPlanProgressStatus(plan);
    expect(status).toMatchObject({
      label: "第2遍完成38%",
      badgeClass: "stat-badge--success",
    });
  });
});

describe("static markup audit", () => {
  it("profile badges card uses profile-badges-card without slate/zinc classes", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).toMatch(/class="[^"]*\bprofile-badges-card\b[^"]*"[^>]*id="profile-badges-inner-card"/);
    expect(html).not.toMatch(/profile-badges-inner-card[^>]*slate-/);
    expect(html).not.toMatch(/profile-badges-inner-card[^>]*zinc-/);
  });

  it("plan-progress-bar uses progress fill token not success mint", () => {
    const css = readFileSync(join(root, "index.css"), "utf8");
    const barRule = css.match(/\.plan-progress-bar\s*\{[^}]+\}/);
    expect(barRule).toBeTruthy();
    expect(barRule[0]).toMatch(/var\(--color-progress-fill\)/);
    expect(barRule[0]).not.toMatch(/--color-success\)/);
  });
});
