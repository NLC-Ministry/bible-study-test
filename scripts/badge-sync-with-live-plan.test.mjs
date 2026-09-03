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

function extractRange(source, fromSig, toSig) {
  const start = source.indexOf(fromSig);
  const end = source.indexOf("\n}", source.indexOf(toSig)) + 2;
  if (start === -1 || end <= 1) throw new Error(`Could not slice ${fromSig}..${toSig}`);
  return source.slice(start, end);
}

// getCampaignStageCompletedRounds now leans on 3 helper fns declared just above it.
const getCampaignStageCompletedRoundsSrc = extractRange(
  utilsSource,
  "function getFirstRoundFinalMonthlyKeys",
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
      "window",
      `${getCampaignStageCompletedRoundsSrc}\nreturn getCampaignStageCompletedRounds;`
    )(state, localStorage, isCampaignStageKind, {
      CHURCH_PLAN_PRESETS: {
        church_r1final_2026_09: {}, church_r1final_2026_10: {},
        church_r1final_2026_11: {}, church_r1final_2026_12: {}
      }
    });
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
    // stage 3 有 live 計畫（round 2 / 100% → 完成 2 遍）；stage 4 沒 live、有 stale 快取 "5"
    localStorage.setItem("church_stage_completed_rounds_4", "5");
    state.activePlans = [{
      planKind: "church_campaign_stage",
      stageNo: 3,
      currentRound: 2,
      progress: 100
    }];
    expect(getCampaignStageCompletedRounds(3)).toBe(2);   // 讀自己的 live，不吃 stage 4 快取
    expect(getCampaignStageCompletedRounds(4)).toBe(5);   // 沒 live → fallback 自己的快取
  });

  it("第一輪期末賽鐵獎：合成前一律 0；合成後讀凍結的 iron_tier（不再跑 live min）", () => {
    const mf = (key, currentRound, progress) => ({ presetKey: key, currentRound, progress, planKind: "church_campaign_stage", stageNo: 2 });
    // 四卷都完成第一遍，但使用者「還沒按合成」 → 鐵獎徽章等效等級 = 0
    state.activePlans = [
      mf("church_r1final_2026_09", 1, 100), mf("church_r1final_2026_10", 1, 100),
      mf("church_r1final_2026_11", 1, 100), mf("church_r1final_2026_12", 1, 100)
    ];
    expect(getCampaignStageCompletedRounds(2)).toBe(0);

    // 使用者按了合成、凍結成 ★3（tier 3）
    localStorage.setItem("church_r1final_synthesized", "1");
    localStorage.setItem("church_r1final_iron_tier", "3");
    expect(getCampaignStageCompletedRounds(2)).toBe(3);

    // 凍結後即使 live 計畫變動也不再改變
    state.activePlans = [];
    expect(getCampaignStageCompletedRounds(2)).toBe(3);
  });
});
