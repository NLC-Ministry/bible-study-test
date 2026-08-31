import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { isCampaignStageKind } from "../js/data/campaign-stage-kinds.mjs";

const utilsSource = readFileSync(new URL("../js/utils.js", import.meta.url), "utf8");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`Could not find ${signature}`);
  const end = source.indexOf("\n}", start) + 2;
  return source.slice(start, end);
}

const getCampaignStageCompletedRoundsSrc = extractFunction(
  utilsSource,
  "function getCampaignStageCompletedRounds"
);

describe("badge unlock state stays synced with the live reading plan", () => {
  let store;
  let localStorage;
  let state;
  let getCampaignStageCompletedRounds;

  beforeEach(() => {
    store = new Map();
    localStorage = {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    };
    state = { activePlans: [] };
    // eslint-disable-next-line no-new-func
    getCampaignStageCompletedRounds = new Function(
      "state",
      "localStorage",
      "isCampaignStageKind",
      `${getCampaignStageCompletedRoundsSrc}\nreturn getCampaignStageCompletedRounds;`
    )(state, localStorage, isCampaignStageKind);
  });

  it("ignores a stale localStorage value when the plan is genuinely still on round 1", () => {
    // Regression for: badge showed as unlocked (2 rounds) from an earlier
    // testing session, even though the user's real, current plan hadn't
    // finished round 1 yet.
    localStorage.setItem("church_stage_completed_rounds_1", "2");
    state.activePlans = [{
      planKind: "church_campaign_stage",
      stageNo: 1,
      currentRound: 1,
      progress: 40
    }];

    expect(getCampaignStageCompletedRounds(1)).toBe(0);
  });

  it("self-heals the stale localStorage value to match the live plan", () => {
    localStorage.setItem("church_stage_completed_rounds_1", "2");
    state.activePlans = [{
      planKind: "church_campaign_stage",
      stageNo: 1,
      currentRound: 1,
      progress: 0
    }];

    getCampaignStageCompletedRounds(1);

    expect(localStorage.getItem("church_stage_completed_rounds_1")).toBe("0");
  });

  it("still reports completed rounds while genuinely in progress on a later round", () => {
    state.activePlans = [{
      planKind: "church_campaign_stage",
      stageNo: 1,
      currentRound: 3,
      progress: 50
    }];

    expect(getCampaignStageCompletedRounds(1)).toBe(2);
  });

  it("falls back to the persisted value only when there is no active plan for that stage", () => {
    // A stage that has genuinely rotated out of state.activePlans (e.g. an
    // older, already-fully-completed campaign stage) must keep its earned
    // badge instead of losing it just because it's no longer loaded.
    localStorage.setItem("church_stage_completed_rounds_1", "3");
    state.activePlans = [];

    expect(getCampaignStageCompletedRounds(1)).toBe(3);
  });

  it("does not confuse plans belonging to a different stage number", () => {
    localStorage.setItem("church_stage_completed_rounds_2", "5");
    state.activePlans = [{
      planKind: "church_campaign_stage",
      stageNo: 1,
      currentRound: 1,
      progress: 0
    }];

    expect(getCampaignStageCompletedRounds(2)).toBe(5);
  });
});
