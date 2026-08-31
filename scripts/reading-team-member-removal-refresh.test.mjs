import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  getMemberOverallPlanProgress,
  getTeamOverallPlanProgress
} from "../js/modules/team-progress-metrics.mjs";
import { isCampaignStageKind } from "../js/data/campaign-stage-kinds.mjs";
import {
  countScheduleDaysCoveredByChapters,
  countExpectedScheduleDays,
  countLateCompletedDays
} from "../js/data/schedule-progress.mjs";

const teamUi = readFileSync(new URL("../js/modules/team-registration.js", import.meta.url), "utf8");

describe("reading team member removal refresh", () => {
  it("stops click bubbling and redraws only the inline roster", async () => {
    const dom = new JSDOM("<!doctype html><html><body><main id='parent'><div id='team'></div></main></body></html>", {
      url: "https://example.test",
      runScripts: "outside-only"
    });
    const plan = {
      globalPlanId: "00000000-0000-0000-c026-000000000002",
      planKind: "church_campaign_stage",
      name: "Stage 2",
      totalChapters: 100
    };
    const team = {
      id: "team-3",
      globalPlanId: plan.globalPlanId,
      name: "Original team",
      division: 3,
      captainId: "captain-1",
      capacity: 3,
      memberCount: 2,
      status: "forming"
    };
    const captain = {
      userId: "captain-1",
      name: "Captain",
      role: "captain",
      isMe: true,
      hasJoinedPlan: true,
      chaptersRead: 0
    };
    const removedMember = {
      userId: "member-2",
      name: "Member Two",
      role: "member",
      isMe: false,
      hasJoinedPlan: true,
      chaptersRead: 0
    };
    const removeReadingTeamMember = vi.fn().mockResolvedValue({ success: true });
    const getMyReadingTeam = vi.fn().mockResolvedValue({
      success: true,
      context: {
        teams: [{
          team: { ...team, memberCount: 1 },
          members: [captain]
        }]
      }
    });
    const parentClick = vi.fn();

    Object.assign(dom.window, {
      state: {
        currentUser: { id: "captain-1" },
        currentProfileId: "captain-1"
      },
      db: {
        removeReadingTeamMember,
        getMyReadingTeam,
        disbandReadingTeam: vi.fn()
      },
      escapeHTML: value => String(value ?? ""),
      hydrateIcons: () => {},
      showToast: vi.fn(),
      loader: { show: vi.fn(), hide: vi.fn() },
      showConfirmDialog: vi.fn().mockResolvedValue(true),
      getMemberOverallPlanProgress,
      getTeamOverallPlanProgress,
      isCampaignStageKind,
      countScheduleDaysCoveredByChapters,
      countExpectedScheduleDays,
      countLateCompletedDays
    });

    dom.window.document.getElementById("parent").addEventListener("click", parentClick);
    dom.window.eval(teamUi.replace(/^import[^;]+;\s*/gm, ""));

    const container = dom.window.document.getElementById("team");
    dom.window.renderMyReadingTeamInline(container, plan, {
      team,
      members: [captain, removedMember]
    }, "members");

    const removeButton = container.querySelector("[data-team-remove-user='member-2']");
    expect(removeButton).not.toBeNull();
    removeButton.click();

    await vi.waitFor(() => {
      expect(removeReadingTeamMember).toHaveBeenCalledWith("team-3", "member-2");
      expect(getMyReadingTeam).toHaveBeenCalledWith(plan);
      expect(container.textContent).not.toContain("Member Two");
    });
    expect(parentClick).not.toHaveBeenCalled();

    const inlineRemovalBinding = teamUi.slice(
      teamUi.lastIndexOf("bindTeamMemberRemovalButtons(container, team, members"),
      teamUi.indexOf("hydrate(container)", teamUi.lastIndexOf("bindTeamMemberRemovalButtons(container, team, members"))
    );
    expect(inlineRemovalBinding).toContain("refreshInlineReadingTeam");
    expect(inlineRemovalBinding).not.toContain("window.location.reload");

    dom.window.close();
  });
});