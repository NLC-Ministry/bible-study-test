import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getPlanUpgradeAvailability } from "../js/modules/plan-upgrade-availability.mjs";

const planSource = readFileSync("js/modules/plan.js", "utf8");
const css = readFileSync("index.css", "utf8");

describe("plan progress upgrade gate", () => {
  it("keeps upgrade available after an earlier prompt was dismissed", () => {
    const result = getPlanUpgradeAvailability({ currentRound: 1, progress: 100, lastPromptedRound: 1 });
    expect(result.eligible).toBe(true);
    expect(result.nextRound).toBe(2);
    expect(result.nextRoundLabel).toBe("第二遍");
  });

  it("does not allow incomplete or expired plans to upgrade", () => {
    expect(getPlanUpgradeAvailability({ currentRound: 1, progress: 99 }).eligible).toBe(false);
    expect(getPlanUpgradeAvailability({ currentRound: 1, progress: 100 }, { expired: true }).eligible).toBe(false);
  });

  it("recognizes an explicitly completed second round", () => {
    const result = getPlanUpgradeAvailability({ currentRound: 2, progress: 0, isRound2Completed: true });
    expect(result.eligible).toBe(true);
    expect(result.nextRound).toBe(3);
    expect(result.nextRoundLabel).toBe("第三遍");
  });

  it("covers the progress page with an upgrade question", () => {
    expect(planSource).toContain("renderPlanProgressUpgradeOverlay(state.activePlan)");
    expect(planSource).toContain('modal.className = "congrats-modal-overlay plan-upgrade-gate"');
    expect(planSource).toContain('modal.dataset.planUpgradePrompt = "true"');
    expect(planSource).toContain('data-plan-card-action="upgrade"');
    expect(planSource).toContain("await openJoinedPlanProgress(plan)");
    expect(css).toContain(".plan-upgrade-gate__panel");
  });

  it("keeps the gate busy until scheduling, persistence, and progress rendering finish", () => {
    const flow = planSource.slice(
      planSource.indexOf("window.triggerPlanUpgradeFlow ="),
      planSource.indexOf("// Reading From Plan")
    );
    expect(flow).toContain("setPlanUpgradeOverlayBusy(true");
    expect(flow).toContain("await persistPlanRoundState(plan)");
    expect(flow).toContain("await renderPlanView()");
    expect(flow.indexOf("await renderPlanView()")).toBeLessThan(flow.lastIndexOf("modal.remove()"));
    expect(flow).toContain("Object.assign(plan, previousPlanState)");
  });
});