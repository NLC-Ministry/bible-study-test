// 教會階段計畫的 plan_kind 判斷 —— 前端唯一定義。
//
// 對應 DB migration 0137 的 public.is_campaign_stage_kind /
// public.is_canonical_campaign_stage_kind。三個 runtime（Postgres、前端 ESM）
// 各一份定義，各自在自己的 runtime 內被所有呼叫點共用；改行為時三處一起改。
//
// 兩個概念：
//   isCampaignStageKind          —— 「行為上是一個階段計畫」：正式階段 or 大區延後梯次。
//     階段開放閘門、輪次進度凍結、階段獎、3/6 人團隊報名 / 團隊榜 / carry-over。
//   isCanonicalCampaignStageKind —— 「在全教會正式時間軸上」：只有正式階段。
//     preset 同步、preset override 重套規則；cohort 由後台自行維護，永不匹配。

export const CAMPAIGN_STAGE_KINDS = Object.freeze([
  "church_campaign_stage",
  "church_campaign_stage_cohort"
]);

export const CANONICAL_CAMPAIGN_STAGE_KIND = "church_campaign_stage";

function planKindOf(planOrKind) {
  if (planOrKind && typeof planOrKind === "object") {
    return String(planOrKind.planKind || planOrKind.plan_kind || "");
  }
  return String(planOrKind || "");
}

// 接受 plan 物件或 plan_kind 字串。
export function isCampaignStageKind(planOrKind) {
  return CAMPAIGN_STAGE_KINDS.includes(planKindOf(planOrKind));
}

export function isCanonicalCampaignStageKind(planOrKind) {
  return planKindOf(planOrKind) === CANONICAL_CAMPAIGN_STAGE_KIND;
}
