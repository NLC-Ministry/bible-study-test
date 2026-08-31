import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { getMemberOverallPlanProgress, getTeamOverallPlanProgress } from "../js/modules/team-progress-metrics.mjs";
import { isCampaignStageKind } from "../js/data/campaign-stage-kinds.mjs";
import {
  countScheduleDaysCoveredByChapters,
  countExpectedScheduleDays,
  countLateCompletedDays
} from "../js/data/schedule-progress.mjs";

const teamUi = readFileSync(new URL("../js/modules/team-registration.js", import.meta.url), "utf8");

describe("reading team dialog navigation", () => {
  it("returns from create-another-team and closing never joins a solo plan", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://example.test",
      runScripts: "outside-only"
    });
    const plan = {
      globalPlanId: "00000000-0000-0000-c026-000000000002",
      planKind: "church_campaign_stage",
      name: "第二階段",
      totalChapters: 100
    };
    const joinPresetPlan = vi.fn();
    const createReadingTeam = vi.fn();
    const getMyReadingTeam = vi.fn().mockResolvedValue({
      success: true,
      context: {
        teams: [{
          team: {
            id: "team-6",
            name: "測試團隊",
            division: 6,
            captainId: "user-1",
            capacity: 6,
            memberCount: 1,
            status: "forming",
            inviteCode: "DB967533C7"
          },
          members: [{
            userId: "user-1",
            name: "測試使用者",
            role: "captain",
            isMe: true,
            hasJoinedPlan: false,
            chaptersRead: 0
          }]
        }]
      }
    });

    Object.assign(dom.window, {
      state: {
        globalPlans: [],
        currentUser: { id: "user-1" },
        currentProfileId: "user-1"
      },
      db: {
        getMyReadingTeam,
        createReadingTeam,
        joinPresetPlan,
        removeReadingTeamMember: vi.fn(),
        disbandReadingTeam: vi.fn()
      },
      escapeHTML: value => String(value ?? ""),
      hydrateIcons: () => {},
      showToast: () => {},
      loader: { show: () => {}, hide: () => {} },
      showConfirmDialog: vi.fn().mockResolvedValue(false),
      getMemberOverallPlanProgress,
      getTeamOverallPlanProgress,
      isCampaignStageKind,
      countScheduleDaysCoveredByChapters,
      countExpectedScheduleDays,
      countLateCompletedDays
    });

    dom.window.eval(teamUi.replace(/^import[^;]+;\s*/gm, ""));
    await dom.window.openReadingTeamDialog(plan, { preferredDivision: 6 });

    const addOtherButton = dom.window.document.querySelector("[data-add-other-team]");
    expect(addOtherButton).not.toBeNull();
    addOtherButton.click();

    const backButton = dom.window.document.querySelector("[data-team-back]");
    expect(backButton?.textContent).toContain("返回我的團隊");
    backButton.click();
    expect(dom.window.document.querySelector("#reading-team-dialog-title")?.textContent).toBe("測試團隊");

    dom.window.document.querySelector("[data-team-close]")?.click();
    expect(dom.window.document.querySelector("#reading-team-dialog")).toBeNull();
    expect(createReadingTeam).not.toHaveBeenCalled();
    expect(joinPresetPlan).not.toHaveBeenCalled();
    dom.window.close();
  });
});