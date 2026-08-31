function chapterKey(book, chapter) {
  return `${book || ""}_${Number(chapter) || 0}`;
}

export function getPlanChapterKeys(plan) {
  const keys = new Set();
  (plan && Array.isArray(plan.days) ? plan.days : []).forEach(day => {
    (Array.isArray(day && day.chapters) ? day.chapters : []).forEach(chapter => {
      keys.add(chapterKey(chapter.book, chapter.chapter));
    });
  });
  return keys;
}

export function isReadingLogForPlan(log, plan, planChapterKeys = getPlanChapterKeys(plan)) {
  if (!log || !plan) return false;
  const logPlanId = log.plan_id || null;
  const logPresetKey = log.presetKey || log.preset_key || null;
  if (plan.id && logPlanId === plan.id) return true;
  if (plan.presetKey && logPresetKey === plan.presetKey) return true;
  if (logPlanId || logPresetKey) return false;
  return planChapterKeys.has(chapterKey(log.book, log.chapter));
}

export function removePlanReadingLogs(logs, plan) {
  const planChapterKeys = getPlanChapterKeys(plan);
  return (Array.isArray(logs) ? logs : []).filter(log =>
    !isReadingLogForPlan(log, plan, planChapterKeys)
  );
}

export function cleanPlanAssociatedBadges(plan) {
  if (!plan) return;
  const storage = (typeof localStorage !== "undefined" && localStorage) || (typeof window !== "undefined" && window.localStorage) || null;
  if (!storage) return;

  const targetBadgeIds = new Set();

  // 1. Church Campaign Stage Badges
  const presetMatch = String(plan.presetKey || plan.id || "").match(/(?:stage_?|award_?|campaign-stage-?)(\d+)/i);
  const stageNo = Number(plan.stageNo || (plan.campaignDefinition && plan.campaignDefinition.stageNo) || (presetMatch && presetMatch[1]) || 0);
  if (stageNo > 0) {
    targetBadgeIds.add(`church_stage_award_${stageNo}`);
    storage.removeItem(`church_stage_completed_rounds_${stageNo}`);
  }

  // 2. Plan-specific completion badges (if any)
  if (plan.id) {
    targetBadgeIds.add(`plan_complete_${plan.id}`);
  }
  if (plan.presetKey) {
    targetBadgeIds.add(`plan_complete_${plan.presetKey}`);
  }

  // 3. Remove target badges from unlocked_badges array
  try {
    const unlockedBadges = JSON.parse(storage.getItem("unlocked_badges") || "[]");
    if (Array.isArray(unlockedBadges)) {
      const filteredBadges = unlockedBadges.filter(id => !targetBadgeIds.has(id));
      storage.setItem("unlocked_badges", JSON.stringify(filteredBadges));
    }
  } catch (e) {
    console.warn("Failed to parse unlocked_badges in cleanPlanAssociatedBadges:", e);
  }

  // 4. Remove notification, unlock flags, and star unlock dates
  targetBadgeIds.forEach(badgeId => {
    storage.removeItem(`notified_${badgeId}`);
    storage.removeItem(`${badgeId}_unlocked`);
    for (let star = 1; star <= 5; star++) {
      storage.removeItem(`date_unlocked_${badgeId}_lvl_${star}`);
    }
  });

  // 5. Trigger UI surface refresh
  if (typeof window !== "undefined" && typeof window.refreshBadgeSurfaces === "function") {
    window.refreshBadgeSurfaces();
  }
}

export function resetPlanProgressState(plan) {
  if (!plan) return plan;
  plan.currentRound = 1;
  plan.upgradePromptHandled = false;
  plan.lastUpgradedRound = null;
  plan.lastPromptedRound = null;
  plan.upgradeOverlayDismissedRound = null;
  plan.progress = 0;
  plan.completedChapters = 0;
  plan.isPlanCompleted = false;
  plan.isRound2Completed = false;
  plan.round2UpgradePromptHandled = false;

  (Array.isArray(plan.days) ? plan.days : []).forEach(day => {
    (Array.isArray(day.chapters) ? day.chapters : []).forEach(chapter => {
      chapter.isRead = false;
      Object.keys(chapter).forEach(key => {
        if (/^isReadR\d+$/.test(key)) chapter[key] = false;
      });
    });
  });

  cleanPlanAssociatedBadges(plan);

  return plan;
}
