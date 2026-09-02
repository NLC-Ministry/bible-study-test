// Combined plan and stats module

import {
  isAlreadyJoinedTeamResult,
  resetPlanTeamInvitePanelState,
  resolveTeamJoinEffectivePlan
} from "./plan-team-navigation-helpers.mjs";
import {
  getPlanParticipationModel,
  shouldHidePlanTeamInviteShortcut
} from "./plan-participation-helpers.mjs";
import { getPlanUpgradeAvailability } from "./plan-upgrade-availability.mjs";
import { createReaderBottomDwellController, observeReaderEndSentinel } from "./reader-bottom-dwell.mjs";
import { isPlanProgressLocked } from "../data/plan-progress-availability.mjs";
import {
  countScheduleDaysCoveredByChapters,
  countExpectedScheduleDays,
  countLateCompletedDays,
  isFirstRoundInProgress
} from "../data/schedule-progress.mjs";
import {
  cleanPlanAssociatedBadges,
  removePlanReadingLogs,
  resetPlanProgressState
} from "./plan-progress-reset.mjs";
import { computePlanScopedStreak } from "./team-progress-metrics.mjs";

// Reading plans tab view controller

window._currentStatsTab = 'personal';
window._statsTabScope = null;

// Asynchronous Request & Click Debounce state trackers
let lastTrackerRequestId = 0;
let planUpgradeInFlight = false;
let dateClickDebounceTimer = null;
let viewMode = 'calendar'; // Today reading always shows calendar + chapter list
let planSearchQuery = '';
let teamCarryoverOfferInFlight = false;
let teamCarryoverCheckedSignature = "";
let planTeamInviteVisibilityRequestId = 0;

const PLAN_ROUTE = Object.freeze({
  LIST: "LIST",
  DETAIL: "DETAIL",
  GROUP: "GROUP",
  ORG_STATS: "ORG_STATS"
});

window.currentPlanViewState = window.currentPlanViewState || PLAN_ROUTE.LIST;

// 效能重構 B7：同一個 <canvas> 還在就只 chart.update()，不要每次 destroy + new Chart。
// destroy+new 會丟掉整個圖、重跑動畫、增加 GC，也是「Canvas is already in use」錯誤來源。
function renderOrUpdateChart(key, canvasEl, config) {
  if (!canvasEl || typeof Chart === "undefined") return null;
  state.statsCharts = state.statsCharts || {};
  const existing = state.statsCharts[key];
  if (existing && existing.canvas === canvasEl) {
    try {
      existing.data = config.data;
      if (config.options) existing.options = config.options;
      existing.update("none");
      return existing;
    } catch (_) { /* 落到重建 */ }
  }
  try { existing && existing.destroy(); } catch (_) {}
  try {
    const stale = Chart.getChart ? Chart.getChart(canvasEl) : null;
    if (stale && stale !== existing) stale.destroy();
  } catch (_) {}
  state.statsCharts[key] = new Chart(canvasEl.getContext("2d"), config);
  return state.statsCharts[key];
}

function getPlanDetailTabs() {
  return document.querySelector(".plan-detail-tabs");
}

function getPlanGroupNodes() {
  return [
    getPlanDetailTabs(),
    document.getElementById("subview-plan-stats"),
    document.getElementById("subview-plan-ranking")
  ].filter(Boolean);
}

function moveGroupNodesToDetail(shell = ensurePlanRouteShell()) {
  if (!shell || !shell.legacyDetail) return;

  const tabs = getPlanDetailTabs();
  const schedule = document.getElementById("subview-plan-schedule");
  if (tabs && schedule && tabs.parentElement !== shell.legacyDetail) {
    shell.legacyDetail.insertBefore(tabs, schedule);
  } else if (tabs && !schedule && tabs.parentElement !== shell.legacyDetail) {
    shell.legacyDetail.appendChild(tabs);
  }

  [
    document.getElementById("subview-plan-stats"),
    document.getElementById("subview-plan-ranking")
  ].filter(Boolean).forEach(node => {
    if (node.parentElement !== shell.legacyDetail) shell.legacyDetail.appendChild(node);
  });
  const stats = document.getElementById("subview-plan-stats");
  const members = document.getElementById("subview-plan-members");
  if (stats && members && members.parentElement !== stats) stats.insertBefore(members, stats.firstChild);
}

function moveGroupNodesToGroup(shell = ensurePlanRouteShell()) {
  if (!shell || !shell.groupView) return;
  getPlanGroupNodes().forEach(node => {
    if (node.parentElement !== shell.groupView) shell.groupView.appendChild(node);
  });
}

function forceHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle("hidden", hidden);
  el.hidden = hidden;
  if (hidden) {
    el.style.setProperty("display", "none", "important");
  } else {
    el.style.display = "";
  }
}

function ensurePlanRouteShell() {
  const planRoot = document.getElementById("plan-view");
  if (!planRoot) return null;

  const legacyList = document.getElementById("plan-list-subview");
  const legacyDetail = document.getElementById("plan-detail-subview");
  if (!legacyList || !legacyDetail) return null;

  let listView = document.getElementById("plan-list-view");
  if (!listView) {
    listView = document.createElement("div");
    listView.id = "plan-list-view";
    const listParent = legacyList.parentNode || planRoot;
    listParent.insertBefore(listView, legacyList);
    listView.appendChild(legacyList);
  }

  let detailView = document.getElementById("plan-detail-view");
  if (!detailView) {
    detailView = document.createElement("div");
    detailView.id = "plan-detail-view";
    detailView.className = "hidden";
    const detailParent = legacyDetail.parentNode || planRoot;
    detailParent.insertBefore(detailView, legacyDetail);
    detailView.appendChild(legacyDetail);
  }

  let groupView = document.getElementById("group-progress-view");
  if (!groupView) {
    groupView = document.createElement("div");
    groupView.id = "group-progress-view";
    groupView.className = "hidden";
    detailView.after(groupView);
  }

  return { listView, detailView, groupView, legacyList, legacyDetail };
}

function setOnlyPlanRouteVisible(route) {
  const shell = ensurePlanRouteShell();
  if (!shell) return null;

  forceHidden(shell.listView, route !== PLAN_ROUTE.LIST);
  forceHidden(shell.detailView, route === PLAN_ROUTE.LIST);
  forceHidden(shell.groupView, true);
  forceHidden(shell.legacyList, false);
  forceHidden(shell.legacyDetail, route === PLAN_ROUTE.LIST);


  return shell;
}

function getCurrentPlanRoute() {
  return window.currentPlanViewState || PLAN_ROUTE.LIST;
}

const PLAN_PAGE = Object.freeze({ READING: 0, GROUP: 1 });

function ensurePlanPageShell() {
  const shell = ensurePlanRouteShell();
  const detail = shell && shell.legacyDetail;
  if (!detail) return null;
  forceHidden(detail, false);
  const oldSegmented = document.getElementById("tab-today-task")?.closest(".px-4.py-2");
  if (oldSegmented) oldSegmented.style.display = "none";
  const legacyTabs = getPlanDetailTabs();
  if (legacyTabs) legacyTabs.style.display = "none";
  let strip = document.getElementById("plan-detail-tab-strip");
  let windowEl = document.getElementById("plan-view-window");
  if (!strip) {
    strip = document.createElement("nav");
    strip.id = "plan-detail-tab-strip";
    strip.className = "plan-detail-tab-strip hidden";
    strip.setAttribute("aria-label", "計畫分頁");
    strip.style.display = "none";
    strip.innerHTML = `<div class="plan-detail-tab-strip__scroller" role="tablist"><button id="plan-primary-tab-progress" class="plan-detail-tab-btn active" type="button" role="tab" aria-selected="true" data-plan-primary-view="progress">進度</button><button id="plan-primary-tab-personal" class="plan-detail-tab-btn" type="button" role="tab" aria-selected="false" data-plan-primary-view="personal">個人統計</button><button id="plan-primary-tab-stats" class="plan-detail-tab-btn" type="button" role="tab" aria-selected="false" data-plan-primary-view="stats">團體統計</button><button id="plan-primary-tab-ranking" class="plan-detail-tab-btn" type="button" role="tab" aria-selected="false" data-plan-primary-view="ranking">排名</button><div id="tab-indicator" aria-hidden="true"></div></div>`;
    detail.insertBefore(strip, detail.querySelector(".px-4.py-2, .plan-detail-tabs, #subview-plan-schedule") || detail.firstChild);
  }
  if (!windowEl) {
    windowEl = document.createElement("div");
    windowEl.id = "plan-view-window";
    windowEl.className = "plan-view-window hidden";
    windowEl.style.display = "none";
    windowEl.innerHTML = `<div id="plan-view-wrapper" class="w-full flex will-change-transform transition-transform duration-300"><section id="plan-page-0" class="plan-page-panel" data-plan-page="0"></section><section id="plan-page-1" class="plan-page-panel" data-plan-page="1"></section></div>`;
    strip.after(windowEl);
  }
  const wrapper = document.getElementById("plan-view-wrapper");
  const page0 = document.getElementById("plan-page-0");
  const page1 = document.getElementById("plan-page-1");
  const schedule = document.getElementById("subview-plan-schedule");
  const stats = document.getElementById("subview-plan-stats");
  const ranking = document.getElementById("subview-plan-ranking");
  const members = document.getElementById("subview-plan-members");
  if (page0 && schedule && schedule.parentElement !== page0) page0.appendChild(schedule);
  [stats, ranking].filter(Boolean).forEach(node => { if (page1 && node.parentElement !== page1) page1.appendChild(node); });
  if (stats && members && members.parentElement !== stats) stats.insertBefore(members, stats.firstChild);
  return { shell, detail, strip, windowEl, wrapper, page0, page1, schedule, stats, ranking, members };
}

const PLAN_PRIMARY_VIEW = Object.freeze({
  PROGRESS: "progress",
  PERSONAL: "personal",
  STATS: "stats",
  RANKING: "ranking"
});

function updatePlanPrimaryTabs(view = PLAN_PRIMARY_VIEW.PROGRESS) {
  const strip = document.getElementById("plan-detail-tab-strip");
  if (!strip) return;
  const activeView = Object.values(PLAN_PRIMARY_VIEW).includes(view) ? view : PLAN_PRIMARY_VIEW.PROGRESS;
  strip.querySelectorAll("[data-plan-primary-view]").forEach(button => {
    const isActive = button.dataset.planPrimaryView === activeView;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
    button.tabIndex = isActive ? 0 : -1;
  });
  const active = strip.querySelector(`[data-plan-primary-view="${activeView}"]`);
  const indicator = strip.querySelector("#tab-indicator");
  if (!active || !indicator) return;
  window.requestAnimationFrame(() => {
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.transform = `translateX(${active.offsetLeft}px)`;
  });
}

const GROUP_SUBVIEW = Object.freeze({ PERSONAL: "personal", STATS: "stats", RANKING: "ranking" });

async function showPlanGroupSubview(view = GROUP_SUBVIEW.STATS) {
  const allowedViews = Object.values(GROUP_SUBVIEW);
  let target = allowedViews.includes(view) ? view : GROUP_SUBVIEW.STATS;

  const isTeamPlan = typeof window.isReadingTeamPlan === "function" && window.isReadingTeamPlan(state.activePlan);
  if (isTeamPlan && target === GROUP_SUBVIEW.STATS) {
    const hasTeam = await checkUserHasTeam();
    if (!hasTeam) {
      target = GROUP_SUBVIEW.PERSONAL;
    }
  }

  const statsPanel = document.getElementById("subview-plan-stats");
  const rankingPanel = document.getElementById("subview-plan-ranking");
  const membersPanel = document.getElementById("subview-plan-members");

  const legacyScheduleTab = document.getElementById("tab-plan-schedule");
  if (legacyScheduleTab) {
    legacyScheduleTab.classList.remove("active");
    legacyScheduleTab.setAttribute("aria-selected", "false");
  }
  ["tab-plan-stats", "tab-plan-ranking", "tab-plan-members"].forEach(id => {
    const button = document.getElementById(id);
    if (!button) return;
    forceHidden(button, true);
    const isActive = id === "tab-plan-stats" && target === GROUP_SUBVIEW.STATS
      || id === "tab-plan-ranking" && target === GROUP_SUBVIEW.RANKING;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  forceHidden(statsPanel, target === GROUP_SUBVIEW.RANKING);
  forceHidden(rankingPanel, target !== GROUP_SUBVIEW.RANKING);
  forceHidden(membersPanel, true); // Keep members panel hidden under all main tabs

  window.PlanPageController.groupSubview = target;
  updatePlanPrimaryTabs(target);

  if (target === GROUP_SUBVIEW.PERSONAL) {
    await window.switchStatTab("personal");
  } else if (target === GROUP_SUBVIEW.STATS) {
    const regContainer = document.getElementById("reading-team-registration-inline");
    if (regContainer) regContainer.classList.add("hidden");

    // Hide personal section under the stats tab
    const personalSec = document.getElementById("stats-personal-section");
    if (personalSec) personalSec.classList.add("hidden");

    await prepareReadingTeamSubview("stats");
  } else if (target === GROUP_SUBVIEW.RANKING) {
    await renderPlanRankingView();
  }
}

async function checkUserHasTeam() {
  if (!state.activePlan) return false;
  const supported = typeof window.isReadingTeamPlan === "function" && window.isReadingTeamPlan(state.activePlan);
  if (!supported) return false;
  const result = await db.getMyReadingTeam(state.activePlan);
  if (result && result.success) {
    const contexts = getJoinedReadingTeamContexts(result.context);
    return contexts.length > 0;
  }
  return false;
}

window.PlanPageController = {
  currentIndex: PLAN_PAGE.READING,
  groupLoadedForPlanKey: null,
  groupLoadPromise: null,
  groupSubview: GROUP_SUBVIEW.STATS,
  ensureShell() {
    const shell = ensurePlanPageShell();
    if (!shell) return null;
    forceHidden(shell.strip, false);
    forceHidden(shell.windowEl, false);
    if (!shell.strip.dataset.planControllerBound) {
      shell.strip.addEventListener("click", async event => {
        const button = event.target.closest("[data-plan-primary-view]");
        if (!button) return;
        event.preventDefault();
        await window.PlanPageController.switchPrimaryView(button.dataset.planPrimaryView);
      });
      shell.strip.addEventListener("keydown", async event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const buttons = [...shell.strip.querySelectorAll("[data-plan-primary-view]")].filter(b => !b.classList.contains("hidden") && b.style.display !== "none");
        const current = buttons.indexOf(document.activeElement);
        if (current < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0
          : event.key === "End" ? buttons.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
        await window.PlanPageController.switchPrimaryView(buttons[next].dataset.planPrimaryView);
      });
      shell.strip.dataset.planControllerBound = "true";
    }
    const groupTabs = getPlanDetailTabs();
    if (groupTabs && !groupTabs.dataset.groupControllerBound) {
      const viewById = {
        "tab-plan-stats": GROUP_SUBVIEW.STATS,
        "tab-plan-ranking": GROUP_SUBVIEW.RANKING,
        "tab-plan-members": GROUP_SUBVIEW.STATS
      };
      groupTabs.addEventListener("click", async event => {
        const button = event.target.closest("button");
        const view = button ? viewById[button.id] : null;
        if (!view) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        await showPlanGroupSubview(view);
      }, true);
      groupTabs.dataset.groupControllerBound = "true";
    }
    return shell;
  },
  async switchPrimaryView(view, options = {}) {
    let targetView = Object.values(PLAN_PRIMARY_VIEW).includes(view) ? view : PLAN_PRIMARY_VIEW.PROGRESS;
    const isTeamPlan = typeof window.isReadingTeamPlan === "function" && window.isReadingTeamPlan(state.activePlan);
    if (isTeamPlan && targetView === PLAN_PRIMARY_VIEW.STATS) {
      const hasTeam = await checkUserHasTeam();
      if (!hasTeam) {
        targetView = PLAN_PRIMARY_VIEW.PERSONAL;
      }
    }
    if (targetView === PLAN_PRIMARY_VIEW.PROGRESS) {
      return this.switchPage(PLAN_PAGE.READING, options);
    }
    this.groupSubview = targetView;
    return this.switchPage(PLAN_PAGE.GROUP, { ...options, primaryView: targetView });
  },
  async switchPage(index, options = {}) {
    if (!state.activePlan) return;

    const target = Number(index) === PLAN_PAGE.GROUP ? PLAN_PAGE.GROUP : PLAN_PAGE.READING;
    const shell = this.ensureShell();
    if (!shell?.wrapper) return;

    // Check if user has team and dynamically update third tab name
    const isTeamPlan = typeof window.isReadingTeamPlan === "function" && window.isReadingTeamPlan(state.activePlan);
    let hasTeam = false;
    if (isTeamPlan) {
      hasTeam = await checkUserHasTeam();
    }
    const statsTab = document.getElementById("plan-primary-tab-stats");
    if (statsTab) {
      if (isTeamPlan) {
        statsTab.textContent = "團隊";
        forceHidden(statsTab, !hasTeam);
      } else {
        statsTab.textContent = "團體統計";
        forceHidden(statsTab, false);
      }
    }

    if (isTeamPlan && !hasTeam) {
      if (options.primaryView === GROUP_SUBVIEW.STATS) {
        options.primaryView = GROUP_SUBVIEW.PERSONAL;
      }
      if (this.groupSubview === GROUP_SUBVIEW.STATS) {
        this.groupSubview = GROUP_SUBVIEW.PERSONAL;
      }
    }

    this.currentIndex = target;
    state.planDetailOpen = true;
    state.planActiveSubTab = target === PLAN_PAGE.GROUP ? (options.primaryView || this.groupSubview || "stats") : "today";
    window.currentPlanViewState = target === PLAN_PAGE.GROUP ? PLAN_ROUTE.GROUP : PLAN_ROUTE.DETAIL;
    shell.wrapper.style.transform = `translateX(-${target * 100}%)`;
    const groupTabs = getPlanDetailTabs();
    if (groupTabs) forceHidden(groupTabs, true);
    if (target === PLAN_PAGE.READING) {
      updatePlanPrimaryTabs(PLAN_PRIMARY_VIEW.PROGRESS);
      forceHidden(shell.schedule, false);
      state.inlineReader.active = false;
      document.body.classList.remove("plan-inline-reader-open");
      inlineReaderBottomDwellController?.cancel();
      inlineReaderEndObserver?.disconnect();
      inlineReaderEndObserver = null;
      inlineReaderEndVisible = false;
      const inlineReader = document.getElementById("plan-inline-reader");
      if (inlineReader) inlineReader.classList.add("hidden");
      ensurePlanViewModeToggle();
      if (typeof setViewMode === "function") setViewMode("calendar");
      if (typeof renderPlanScheduleTracker === "function") await renderPlanScheduleTracker();
    } else {
      const planKey = state.activePlan.id || state.activePlan.globalPlanId || state.activePlan.presetKey;
      if (this.groupLoadedForPlanKey !== planKey || options.forceReload) {
        this.groupLoadPromise = fetchGroupRankings(planKey).finally(() => { this.groupLoadPromise = null; });
        await this.groupLoadPromise;
        this.groupLoadedForPlanKey = planKey;
      } else if (this.groupLoadPromise) {
        await this.groupLoadPromise;
      }
      await showPlanGroupSubview(options.primaryView || this.groupSubview || GROUP_SUBVIEW.STATS);
    }
    if (!options.skipChrome && typeof appRouter !== "undefined" && typeof appRouter.updateNavigationChrome === "function") appRouter.updateNavigationChrome();
  },
};

function ensurePlanViewModeToggle() {
  const toggle = document.getElementById("plan-view-mode-toggle");
  if (toggle) toggle.remove();
}

// Reactive state propagation audit
window.addEventListener("planDataChanged", (e) => {
  renderHorizontalDateStrip();
  renderPlanScheduleTracker(true);
});

function canUseAdvancedGroupStats() {
  const allowedRoles = ["admin", "pastor", "great_zone_leader", "zone_leader", "group_leader"];
  const currentRole = (state.currentUser && getUserRoleCode(state.currentUser)) || "member";

  return allowedRoles.includes(currentRole);
}

function getDefaultGroupStatsScope() {
  const myGroup = (state.currentUser && state.currentUser.small_group) || "";
  const myZone = (state.currentUser && state.currentUser.pastoral_zone) || "";
  if (myGroup) return `group:${myGroup.split(",")[0].trim()}`;
  return myZone ? `zone:${myZone.split(",")[0].trim()}` : "all";
}

function applyBasicStatsScope() {
  const basicSelect = document.getElementById("stats-basic-scope-select");
  if (!basicSelect) return getDefaultGroupStatsScope();
  if (!basicSelect.value) basicSelect.value = getDefaultGroupStatsScope();
  if (basicSelect.value === "advanced") return null;
  return basicSelect.value;
}

window.switchStatTab = async function (tab) {
  window._currentStatsTab = tab;

  const tabs = document.querySelectorAll(".stats-inner-tab");
  tabs.forEach(t => t.classList.toggle("active", t.getAttribute("data-tab") === tab));

  const adminScopeBar = document.getElementById("stats-admin-scope-bar");
  const membersOrgControls = document.getElementById("members-organization-controls");

  if (adminScopeBar) {
    adminScopeBar.classList.toggle("hidden", tab !== 'admin');
    adminScopeBar.style.display = tab === 'admin' ? "" : "none";
  }
  if (membersOrgControls) {
    // Members controls only show on members-related views, never alongside stats-admin-scope-bar
    membersOrgControls.style.display = "none";
  }

  if (tab === 'personal') {
    window._statsTabScope = 'me';
  } else if (tab === 'admin') {
    window._statsTabScope = applyBasicStatsScope();
  }

  if (state.activePlan) {
    await renderPlanStatsView();
  }
};


function getJoinedReadingTeamContexts(context) {
  if (Array.isArray(context && context.teams)) {
    return context.teams
      .filter(item => item && item.team)
      .sort((left, right) => Number(left.team.division) - Number(right.team.division));
  }
  return context && context.team ? [context] : [];
}

async function prepareReadingTeamSubview(mode) {
  // Bypass reading team subview when in ORG_STATS mode
  if (window.currentPlanViewState === PLAN_ROUTE.ORG_STATS) {
    const switcher = document.getElementById(mode === "stats" ? "stats-team-view-switch" : "members-team-view-switch");
    const inline = document.getElementById(mode === "stats" ? "reading-team-stats-inline" : "reading-team-members-inline");
    if (switcher) switcher.classList.add("hidden");
    if (inline) inline.classList.add("hidden");
    return true;
  }

  const isStats = mode === "stats";
  const switcher = document.getElementById(isStats ? "stats-team-view-switch" : "members-team-view-switch");
  const select = document.getElementById(isStats ? "stats-team-view-select" : "members-team-view-select");
  const inline = document.getElementById(isStats ? "reading-team-stats-inline" : "reading-team-members-inline");
  if (!switcher || !select || !inline) return true;

  const supported = typeof window.isReadingTeamPlan === "function" && window.isReadingTeamPlan(state.activePlan);
  if (!supported) {
    switcher.classList.add("hidden");
    inline.classList.add("hidden");
    return true;
  }

  const result = await db.getMyReadingTeam(state.activePlan);
  const contexts = result && result.success ? getJoinedReadingTeamContexts(result.context) : [];
  const activeDivisions = new Set(contexts.map(context => Number(context.team.division)));

  const orgOption = select.querySelector('option[value="organization"]');
  if (orgOption) orgOption.remove();

  select.querySelectorAll('option[data-reading-team-division]').forEach(option => {
    if (!activeDivisions.has(Number(option.dataset.readingTeamDivision))) option.remove();
  });

  if (contexts.length === 0) {
    select.value = "organization";
    delete select.dataset.readingTeamDefaultPlan;
    switcher.classList.add("hidden");
    inline.classList.add("hidden");
    return true;
  }

  const regContainer = document.getElementById("reading-team-registration-inline");
  if (regContainer) regContainer.classList.add("hidden");

  contexts.forEach(context => {
    const division = Number(context.team.division);
    const value = "reading-team-" + division;
    let option = select.querySelector('option[value="' + value + '"]');
    if (!option) {
      option = document.createElement("option");
      option.value = value;
      option.dataset.readingTeamDivision = String(division);
      select.appendChild(option);
    }
    option.textContent = "第 " + division + " 人組";
  });

  const activePlanKey = String(
    state.activePlan.globalPlanId
      || state.activePlan.id
      || state.activePlan.presetKey
      || state.activePlan.name
      || "current-plan"
  );
  if (select.dataset.readingTeamDefaultPlan !== activePlanKey) {
    select.dataset.readingTeamDefaultPlan = activePlanKey;
    select.value = "reading-team-" + Number(contexts[0].team.division);
  }

  if (contexts.length > 1) {
    switcher.classList.remove("hidden");
  } else {
    switcher.classList.add("hidden");
  }

  if (!select.dataset.readingTeamBound) {
    select.dataset.readingTeamBound = "true";
    select.addEventListener("change", async () => {
      if (isStats) {
        await prepareReadingTeamSubview("stats");
      } else {
        await prepareReadingTeamSubview("members");
      }
    });
  }

  // Direct C logic: render the team progress inline details
  const selectedDivision = Number(String(select.value).replace("reading-team-", ""));
  const selectedContext = contexts.find(context => Number(context.team.division) === selectedDivision) || contexts[0];
  const showTeam = !!selectedContext;
  inline.classList.toggle("hidden", !showTeam);
  if (showTeam && typeof window.renderMyReadingTeamInline === "function") {
    window.renderMyReadingTeamInline(inline, state.activePlan, selectedContext, mode);
  }

  return true;
}


function openPlanTeamInvitePanel() {
  const joinedContainer = document.getElementById("joined-plans-list-container");
  const presetContainer = document.getElementById("preset-plans-list-container");
  const sidebarCard = document.getElementById("plan-sidebar-info-card");
  const joinTeamContainer = document.getElementById("join-team-container");
  const trigger = document.getElementById("btn-open-plan-team-invite");

  if (joinedContainer) joinedContainer.classList.add("hidden");
  if (presetContainer) presetContainer.classList.add("hidden");
  if (sidebarCard) sidebarCard.classList.add("hidden");
  if (joinTeamContainer) joinTeamContainer.classList.remove("hidden");
  trigger?.setAttribute("aria-expanded", "true");
  setupGlobalJoinTeamForm();
  document.getElementById("global-team-code-input")?.focus();
}

function resetPlanTeamInvitePanel({ restoreFocus = false } = {}) {
  const joinTeamContainer = document.getElementById("join-team-container");
  const trigger = document.getElementById("btn-open-plan-team-invite");
  const activePill = document.querySelector("#plan-list-status-pills .pill-btn.active");
  const fallbackMine = document.querySelector('#plan-list-status-pills .pill-btn[data-filter="mine"]');
  const target = activePill || fallbackMine;

  resetPlanTeamInvitePanelState({
    panel: joinTeamContainer,
    trigger,
    target,
    restoreFocus
  });
}

function closePlanTeamInvitePanel() {
  resetPlanTeamInvitePanel({ restoreFocus: true });
}

async function updatePlanTeamInviteShortcutVisibility() {
  const shortcut = document.getElementById("plan-team-invite-shortcut");
  if (!shortcut) return;

  const requestId = ++planTeamInviteVisibilityRequestId;
  const revealShortcut = () => {
    if (requestId !== planTeamInviteVisibilityRequestId) return;
    shortcut.classList.remove("hidden");
    shortcut.hidden = false;
  };

  const canLoadTeams = state.isSupabaseMode
    && state.supabase
    && !(state.currentUser && state.currentUser.is_demo)
    && typeof window.isReadingTeamPlan === "function"
    && typeof db !== "undefined"
    && typeof db.getMyReadingTeam === "function";
  if (!canLoadTeams) {
    revealShortcut();
    return;
  }

  const eligiblePlans = (state.activePlans || []).filter(plan =>
    !isPlanExpired(plan)
    && (canManageHiddenPlans() || !isPlanHidden(plan))
    && window.isReadingTeamPlan(plan)
  );
  if (eligiblePlans.length === 0) {
    revealShortcut();
    return;
  }

  try {
    const results = await Promise.all(eligiblePlans.map(plan => db.getMyReadingTeam(plan)));
    if (requestId !== planTeamInviteVisibilityRequestId) return;

    // A failed lookup must never hide a useful action. Only hide after every
    // current plan positively reports membership in both supported divisions.
    if (results.some(result => !result || !result.success)) {
      revealShortcut();
      return;
    }

    const contextsByPlan = results.map(result => getJoinedReadingTeamContexts(result.context));
    const shouldHide = shouldHidePlanTeamInviteShortcut(contextsByPlan, [3, 6]);
    shortcut.classList.toggle("hidden", shouldHide);
    shortcut.hidden = shouldHide;

    if (shouldHide && !document.getElementById("join-team-container")?.classList.contains("hidden")) {
      resetPlanTeamInvitePanel();
    }
  } catch (error) {
    console.warn("Unable to update invite-code shortcut visibility:", error);
    revealShortcut();
  }
}

function initPlanControls() {
  ensurePlanRouteShell();
  renderPresetPlansList();

  const planSearchToggle = document.getElementById("btn-toggle-plan-search");
  const planSearchPanel = document.getElementById("plan-search-panel");
  const planSearchInput = document.getElementById("plan-search-input");
  const planSearchClear = document.getElementById("btn-clear-plan-search");

  const refreshPlanSearchResults = () => {
    renderJoinedPlansList();
    renderPresetPlansList();
  };

  const updatePlanSearchQuery = value => {
    planSearchQuery = normalizePlanSearchValue(value);
    if (planSearchClear) planSearchClear.classList.toggle("hidden", !planSearchQuery);
    refreshPlanSearchResults();
  };

  const closePlanSearch = () => {
    if (!planSearchPanel) return;
    planSearchPanel.classList.add("hidden");
    planSearchToggle?.setAttribute("aria-expanded", "false");
    if (planSearchInput && (planSearchInput.value || planSearchQuery)) {
      planSearchInput.value = "";
      updatePlanSearchQuery("");
    }
  };

  if (planSearchToggle && planSearchPanel && planSearchInput && !planSearchToggle._hasPlanSearchListener) {
    planSearchToggle.addEventListener("click", event => {
      event.preventDefault();
      const isOpening = planSearchPanel.classList.contains("hidden");
      if (!isOpening) {
        closePlanSearch();
        return;
      }
      planSearchPanel.classList.remove("hidden");
      planSearchToggle.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => planSearchInput.focus());
    });
    planSearchToggle._hasPlanSearchListener = true;

    planSearchInput.addEventListener("input", () => updatePlanSearchQuery(planSearchInput.value));
    planSearchInput.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePlanSearch();
      planSearchToggle.focus();
    });

    planSearchClear?.addEventListener("click", () => {
      planSearchInput.value = "";
      updatePlanSearchQuery("");
      planSearchInput.focus();
    });
  }

  const openInviteBtn = document.getElementById("btn-open-plan-team-invite");
  if (openInviteBtn && !openInviteBtn.dataset.planInviteBound) {
    openInviteBtn.dataset.planInviteBound = "true";
    openInviteBtn.addEventListener("click", event => {
      event.preventDefault();
      openPlanTeamInvitePanel();
    });
  }

  const closeInviteBtn = document.getElementById("btn-close-plan-team-invite");
  if (closeInviteBtn && !closeInviteBtn.dataset.planInviteBound) {
    closeInviteBtn.dataset.planInviteBound = "true";
    closeInviteBtn.addEventListener("click", event => {
      event.preventDefault();
      closePlanTeamInvitePanel();
    });
  }

  if (!window.__planTeamInviteVisibilityBound) {
    window.__planTeamInviteVisibilityBound = true;
    window.addEventListener("readingTeam:updated", () => {
      void updatePlanTeamInviteShortcutVisibility();
    });
  }

  const goMyProgressBtn = document.getElementById("go-my-progress-btn");
  if (goMyProgressBtn) {
    goMyProgressBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      snapCalendarToMyProgress();
    });
  }

  const goTodayPlanBtn = document.getElementById("go-today-plan-btn");
  if (goTodayPlanBtn) {
    goTodayPlanBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      snapCalendarToToday();
    });
  }

  // Back Button
  const backBtn = document.getElementById("btn-back-to-plans");
  if (backBtn && !backBtn.dataset.listenerBound) {
    backBtn.dataset.listenerBound = "true";
    backBtn.addEventListener("click", () => {

      state.activePlan = null;
      if (typeof window.syncActivePlanContext === 'function') window.syncActivePlanContext(null);
      localStorage.removeItem("selected_plan_key");
      setPlanState(PLAN_ROUTE.LIST);
    });
  }
  // Options Dropdown Menu Toggle
  const optionsBtn = document.getElementById("btn-plan-options");
  const dropdown = document.getElementById("plan-options-dropdown");
  if (optionsBtn && dropdown) {
    if (!optionsBtn.dataset.dropdownBound) {
      optionsBtn.dataset.dropdownBound = "true";
      optionsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const flexibleScheduleMenuButton = document.getElementById("edit-flexible-plan-schedule-btn");
        if (flexibleScheduleMenuButton) flexibleScheduleMenuButton.style.display = "";
        dropdown.classList.toggle("hidden");
      });
    }
    if (!window._planDropdownClickListenerBound) {
      window._planDropdownClickListenerBound = true;
      document.addEventListener("click", () => {
        const dd = document.getElementById("plan-options-dropdown");
        if (dd) dd.classList.add("hidden");
      });
    }
  }


  const planDetailsButton = document.getElementById("view-plan-details-btn");
  if (planDetailsButton) {
    planDetailsButton.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const dropdown = document.getElementById("plan-options-dropdown");
      if (dropdown) dropdown.classList.add("hidden");
      openPlanDetailsDialog(state.activePlan);
    });
  }

  const flexibleScheduleMenuButton = document.getElementById("edit-flexible-plan-schedule-btn");
  if (flexibleScheduleMenuButton) {
    flexibleScheduleMenuButton.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const plan = state.activePlan;
      if (!plan) return;
      const dropdown = document.getElementById("plan-options-dropdown");
      if (dropdown) dropdown.classList.add("hidden");
      const scheduleSettings = await openFlexibleScheduleDialog(plan, { editing: true });
      if (!scheduleSettings) return;
      const result = await db.updateFlexiblePlanSchedule(plan, scheduleSettings);
      if (!result || !result.success) {
        showToast("儲存每週安排失敗：" + ((result && result.error && result.error.message) || "請稍後再試"));
        return;
      }
      showToast("每週讀經安排已更新，章節已重新分配。");
      renderPlanScheduleView();
      await renderPlanScheduleTracker();
    });
  }

  // Abandon Plan Button inside options dropdown
  const deleteBtn = document.getElementById("delete-plan-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!state.activePlan) return;
      const confirmed = await window.showConfirmDialog({
        title: "確定要放棄目前的讀經計畫嗎？",
        message: "您的已讀進度紀錄仍會保留，之後您可以隨時重新加入。",
        confirmText: "確定放棄",
        cancelText: "保留計畫",
        isDestructive: true
      });
      if (!confirmed) return;
      await db.leavePlan(state.activePlan.id, state.activePlan.presetKey);
    });
  }

  // Reset Plan Progress Button inside options dropdown
  const resetProgressBtn = document.getElementById("reset-plan-progress-btn");
  if (resetProgressBtn) {
    resetProgressBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const menu = document.getElementById("plan-options-dropdown");
      if (menu) menu.classList.add("hidden");
      if (!state.activePlan) return;
      const planName = state.activePlan.name;
      const confirmed = await window.showConfirmDialog({
        title: `確定要重置「${planName}」的進度嗎？`,
        message: "重置後，此計畫的所有打卡紀錄都將會被清除，且無法復原。",
        confirmText: "確定重置",
        cancelText: "保留進度",
        isDestructive: true
      });
      if (!confirmed) return;

      loader.show("正在重置計畫進度...");
      try {
        const plan = state.activePlan;
        const planId = plan.id;

        // 1. Clear the persisted logs before changing local state. A Supabase
        // enrollment always has a UUID, so never query a non-existent preset_key
        // column on reading_logs.
        if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
          const user = await db.getCurrentDbUser();
          if (!user || !user.id || !planId) throw new Error("找不到可重置的讀經計畫資料");
          const cacheKey = `reading_logs:${user.id}`;
          const applyDeleteFilters = query => query.eq("user_id", user.id).eq("plan_id", planId);
          const deleteResult = window.readingLogRepository
            ? await window.readingLogRepository.delete(applyDeleteFilters, { invalidate: [cacheKey] })
            : await applyDeleteFilters(state.supabase.from("reading_logs").delete());
          if (deleteResult && deleteResult.error) {
            throw new Error(deleteResult.error.message || deleteResult.error.error || String(deleteResult.error));
          }

          const { error: planResetError } = await state.supabase
            .from("reading_plans")
            .update({
              current_round: 1,
              upgrade_prompt_handled: false
            })
            .eq("id", planId)
            .eq("user_id", user.id);
          if (planResetError) throw planResetError;
        }

        // 2. Only update memory after the server reset succeeds.
        state.readingLogs = removePlanReadingLogs(state.readingLogs, plan);
        resetPlanProgressState(plan);
        rebuildPlanSchedule(plan);
        const firstReadingDay = (plan.days || []).find(day => (day.chapters || []).some(ch => Number(ch.round || 1) === 1));
        if (firstReadingDay) state.selectedPlanDay = firstReadingDay.dayNum;
        window._cachedAllUsersList = null;
        window._cachedAllUsersListKey = null;

        // 3. Save to localStorage (if local/demo mode)
        if (!state.isSupabaseMode) {
          localStorage.setItem("reading_logs", JSON.stringify(state.readingLogs || []));
          localStorage.setItem("active_reading_plans", JSON.stringify(state.activePlans || []));
        }

        // 3b. Reset corresponding badges associated with this plan
        cleanPlanAssociatedBadges(plan);

        // 4. Update UI
        if (typeof calculatePlanProgress === "function") {
          calculatePlanProgress();
        }
        window.setDataVersion(prev => prev + 1);
        window.dispatchEvent(new CustomEvent("app:dataRefresh", { detail: { scope: "plan" } }));

        showToast("已成功重置計畫進度！");
        
        // Reload the plan detail view to reflect the 0% progress
        if (typeof window.setPlanState === 'function') {
          await window.setPlanState(PLAN_ROUTE.DETAIL);
        } else {
          renderPlanView();
        }
      } catch (err) {
        console.error("Failed to reset plan progress:", err);
        showToast("重置失敗：" + (err.message || err));
      } finally {
        loader.hide();
      }
    });
  }

  const _canSeeMembers = canUseAdvancedGroupStats();
  const innerAdminTab = document.getElementById("stats-inner-tab-admin");
  if (innerAdminTab) forceHidden(innerAdminTab, !_canSeeMembers);
  function closePlanOptionsMenu() {
    const menu = document.getElementById("plan-options-dropdown");
    if (menu) menu.classList.add("hidden");
  }

  function bindPlanMenuItem(id, handler) {
    const item = document.getElementById(id);
    if (!item) return;
    item.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handler();
      closePlanOptionsMenu();
    });
  }



  bindPlanMenuItem("menu-plan-stats", async () => {
    await window.PlanPageController.switchPage(PLAN_PAGE.GROUP);
    await showPlanGroupSubview(GROUP_SUBVIEW.STATS);
  });

  bindPlanMenuItem("menu-plan-ranking", async () => {
    await window.PlanPageController.switchPage(PLAN_PAGE.GROUP);
    await showPlanGroupSubview(GROUP_SUBVIEW.RANKING);
  });


  const membersMenuItem = document.getElementById("menu-plan-members");
  if (membersMenuItem) membersMenuItem.style.display = _canSeeMembers ? "" : "none";
  bindPlanMenuItem("menu-plan-members", async () => {
    if (!_canSeeMembers) return;
    await window.PlanPageController.switchPage(PLAN_PAGE.GROUP);
    await showPlanGroupSubview(GROUP_SUBVIEW.STATS);
  });
  // Category Pills filters inside Plan List Page
  const listPills = document.querySelectorAll("#plan-list-status-pills .pill-btn");
  listPills.forEach(pill => {
    pill.addEventListener("click", () => {
      listPills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      openInviteBtn?.setAttribute("aria-expanded", "false");
      const filter = pill.getAttribute("data-filter");

      const joinedContainer = document.getElementById("joined-plans-list-container");
      const presetContainer = document.getElementById("preset-plans-list-container");
      const sidebarCard = document.getElementById("plan-sidebar-info-card");
      const joinTeamContainer = document.getElementById("join-team-container");

      if (filter === "mine") {
        if (joinedContainer) joinedContainer.classList.remove("hidden");
        if (presetContainer) presetContainer.classList.add("hidden");
        if (joinTeamContainer) joinTeamContainer.classList.add("hidden");
        if (sidebarCard) sidebarCard.classList.remove("hidden");
        renderJoinedPlansList();
      } else if (filter === "saved") {
        if (joinedContainer) joinedContainer.classList.add("hidden");
        if (presetContainer) presetContainer.classList.remove("hidden");
        if (joinTeamContainer) joinTeamContainer.classList.add("hidden");
        if (sidebarCard) sidebarCard.classList.remove("hidden");
        renderPresetPlansList();
      } else {
        if (joinedContainer) joinedContainer.classList.remove("hidden");
        if (presetContainer) presetContainer.classList.add("hidden");
        if (joinTeamContainer) joinTeamContainer.classList.add("hidden");
        if (sidebarCard) sidebarCard.classList.add("hidden");
        renderJoinedPlansList();
      }
    });
  });

  // Action button: Start Reading Today
  const startReadingBtn = document.getElementById("btn-start-reading-today");
  if (startReadingBtn) {
    startReadingBtn.addEventListener("click", () => {
      if (!state.activePlan || !state.selectedPlanDay) return;
      const day = state.activePlan.days.find(d => d.dayNum === state.selectedPlanDay);
      const currentRound = Number(state.activePlan.currentRound || 1);
      const chapters = (day && day.chapters || []).filter(ch => Number(ch.round || currentRound) === currentRound);
      if (chapters.length === 0) return;

      const firstUnread = chapters.find(ch => !ch[`isReadR${currentRound}`]) || chapters[0];
      window.openPlanInlineReader(firstUnread.book, firstUnread.chapter, state.selectedPlanDay, firstUnread.round || 1);
    });
  }

  // Initialize Global Plans Admin Controls
  if (typeof initAdminPlanManagement === 'function') {
    initAdminPlanManagement();
  }
}





async function maybeOfferNextStageTeamCarryover() {
  if (teamCarryoverOfferInFlight
    || !state.currentUser
    || !state.isSupabaseMode
    || !state.supabase
    || state.currentUser.is_demo
    || typeof db.getReadingTeamCarryoverOffer !== "function"
    || typeof db.carryReadingTeamsToStage !== "function"
    || typeof window.showConfirmDialog !== "function") {
    return;
  }

  const openNextStages = (state.globalPlans || [])
    .filter(plan => plan && window.isCampaignStagePlan(plan))
    .filter(plan => Number(plan.stageNo || plan.campaignDefinition && plan.campaignDefinition.stageNo || 0) > 1)
    .filter(plan => !isPlanHidden(plan))
    .sort((left, right) =>
      Number(left.stageNo || left.campaignDefinition && left.campaignDefinition.stageNo || 0)
      - Number(right.stageNo || right.campaignDefinition && right.campaignDefinition.stageNo || 0)
    );
  const signature = openNextStages
    .map(plan => String(plan.id || plan.globalPlanId || plan.presetKey || ""))
    .filter(Boolean)
    .join("|");
  if (!signature || signature === teamCarryoverCheckedSignature) return;

  teamCarryoverCheckedSignature = signature;
  teamCarryoverOfferInFlight = true;
  let shouldRetry = false;
  let carryoverLoaderVisible = false;

  try {
    for (const plan of openNextStages) {
      const planKey = String(plan.id || plan.globalPlanId || plan.presetKey || "");
      if (!planKey || sessionStorage.getItem("reading_team_carryover_deferred_" + planKey) === "1") continue;

      const offerResult = await db.getReadingTeamCarryoverOffer(plan);
      if (!offerResult.success) {
        shouldRetry = true;
        continue;
      }

      const offer = offerResult.context || {};
      const teams = Array.isArray(offer.teams) ? offer.teams : [];
      if (!offer.eligible || teams.length === 0) continue;

      const targetStageNo = Number(offer.targetStageNo
        || plan.stageNo
        || plan.campaignDefinition && plan.campaignDefinition.stageNo
        || 0);
      const teamNames = teams.map(team => String(team.name || "")).filter(Boolean).join("、");
      const teamDescription = teamNames
        ? "「" + teamNames + "」"
        : "上一階段的原團隊";
      const confirmed = await window.showConfirmDialog({
        title: "第 " + targetStageNo + " 階段已開放報名",
        message: "是否由隊長帶領 " + teamDescription
          + " 整隊進入第 " + targetStageNo
          + " 階段？確認後全體隊員會直接加入，不需要重新報名或輸入邀請碼。",
        confirmText: "保留原團隊",
        cancelText: "稍後決定"
      });

      if (!confirmed) {
        sessionStorage.setItem("reading_team_carryover_deferred_" + planKey, "1");
        return;
      }

      loader.show("正在帶領原團隊進入下一階段…");
      carryoverLoaderVisible = true;
      const carryResult = await db.carryReadingTeamsToStage(plan);
      loader.hide();
      carryoverLoaderVisible = false;

      if (!carryResult.success) {
        shouldRetry = true;
        showToast(carryResult.message || "原團隊尚未完成轉移，請稍後再試。");
        return;
      }

      await db.loadUserData(true);
      calculateAllPlansProgress();
      showToast("已保留原團隊並進入第 " + targetStageNo + " 階段。");
      await renderPlanView();
      return;
    }
  } catch (error) {
    shouldRetry = true;
    console.error("Reading team carryover offer failed:", error);
  } finally {
    if (carryoverLoaderVisible) loader.hide();
    teamCarryoverOfferInFlight = false;
    if (shouldRetry) teamCarryoverCheckedSignature = "";
  }
}

async function renderPlanView() {
  if (typeof appRouter !== "undefined" && appRouter.currentTab && appRouter.currentTab !== "plan-view") {
    return;
  }
  try {
    if (state.activePlan && isPlanHidden(state.activePlan) && !canManageHiddenPlans()) {
      const nextVisiblePlan = (state.activePlans || []).find(plan => !isPlanHidden(plan));
      state.activePlan = nextVisiblePlan || null;
      if (state.activePlan) localStorage.setItem("selected_plan_key", state.activePlan.presetKey || state.activePlan.id || "");
      else localStorage.removeItem("selected_plan_key");
    }

    renderJoinedPlansList();
    renderPresetPlansList();
    void updatePlanTeamInviteShortcutVisibility();

    ensurePlanRouteShell();

    if (window.currentPlanViewState === PLAN_ROUTE.ORG_STATS) {
      window.currentPlanViewState = PLAN_ROUTE.LIST;
      state.planDetailOpen = false;
    }

    if (state.activePlan && state.planDetailOpen) {
      const groupViews = [GROUP_SUBVIEW.PERSONAL, GROUP_SUBVIEW.STATS, GROUP_SUBVIEW.RANKING, "group"];
      if (groupViews.includes(state.planActiveSubTab)) {
        if (window.PlanPageController && state.planActiveSubTab !== "group") {
          window.PlanPageController.groupSubview = state.planActiveSubTab;
        }
        await setPlanState(PLAN_ROUTE.GROUP);
      } else {
        await setPlanState(PLAN_ROUTE.DETAIL);
      }
    } else {
      await setPlanState(PLAN_ROUTE.LIST);
    }

    // System administrator controls use the UUID-backed role definition.
    const isSystemAdmin = getUserRoleCode(state.currentUser) === "admin";
    const adminCard = document.getElementById("admin-plan-card");
    if (adminCard) {
      adminCard.classList.toggle("hidden", !isSystemAdmin);
    }

    if (isSystemAdmin && typeof renderAdminPlanManagement === 'function') {
      renderAdminPlanManagement();
    }

    if (state.activePlan && isPlanHidden(state.activePlan) && canManageHiddenPlans()) {
      showToast("這個計畫目前已隱藏，一般使用者不會看到。");
    }

    void maybeOfferNextStageTeamCarryover();

    // NOTE: updateNavigationChrome() is intentionally NOT called here.
    // It is the exclusive responsibility of app.js switchTab to call it
    // once, after all async rendering is fully complete.
  } catch (err) {
    console.error("Critical error inside renderPlanView:", err);
  }
}



function getResolvedPresetKey(plan) {
  if (!plan) return null;
  return plan.presetKey || plan.globalPlanId || plan.id || plan.name || null;
}

function getPlanCoverColor(plan) {
  const covers = window.NLC_PLAN_COVERS || ["#B8E8F5", "#C8F5D8", "#FFE4CC", "#D4E4F7", "#E8E0F5", "#F7D4E4", "#F4F7D4", "#E4D4F7", "#D4F7F2"];
  const key = String(getResolvedPresetKey(plan) || "");
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return covers[Math.abs(hash) % covers.length] || covers[0];
}

function getPlanCoverHtml(plan) {
  const bg = getPlanCoverColor(plan);
  const isCampaign = plan && (
    plan.planKind === "church_campaign"
    || window.isCampaignStagePlan(plan)
    || plan.id === window.CHURCH_CAMPAIGN_ID
    || plan.globalPlanId === window.CHURCH_CAMPAIGN_ID
  );
  const campaignStageNo = plan && window.isCampaignStagePlan(plan)
    ? Number(plan.stageNo || plan.campaignDefinition && plan.campaignDefinition.stageNo || 0)
    : 0;
  if (campaignStageNo) {
    return `<div class="plan-cover-thumbnail plan-cover-thumbnail--icon" style="background: color-mix(in srgb, var(--primary-color) 8%, var(--bg-card)); color: var(--primary-color); border-color: color-mix(in srgb, var(--primary-color) 24%, var(--border-card));">
      <span class="nlc-icon nlc-icon--sm" data-icon="calendarThirty" aria-hidden="true"></span>
    </div>`;
  }

  const label = isCampaign ? "66卷" : escapeHTML(String(plan && plan.name || "讀經").slice(0, 2));
  return `<div class="plan-cover-thumbnail" style="background: ${bg};">${label}</div>`;
}

function renderPlanCardHeader({ eyebrow = "", title = "", meta = "", description = "" } = {}) {
  return `
    <div class="plan-card__header">
      ${eyebrow ? `<div class="plan-card__eyebrow">${eyebrow}</div>` : ""}
      <h4 class="plan-card__title">${title}</h4>
      ${meta ? `<div class="plan-card__meta">${meta}</div>` : ""}
      ${description ? `<p class="plan-card__description">${description}</p>` : ""}
    </div>
  `;
}

function renderPlanCardStatusSummary(items = []) {
  const rows = items.filter(Boolean).map(item => `
    <div class="plan-card__status-row ${item.tone ? `plan-card__status-row--${escapeHTML(item.tone)}` : ""}">
      ${item.icon ? `<span class="nlc-icon nlc-icon--sm" data-icon="${escapeHTML(item.icon)}" aria-hidden="true"></span>` : ""}
      <span class="plan-card__status-label">${item.label ? `${escapeHTML(item.label)}：` : ""}</span>
      <span class="plan-card__status-value">${item.value || ""}</span>
    </div>
  `).join("");

  if (!rows) return "";
  return `<div class="plan-card__status">${rows}</div>`;
}

function renderPlanCardActions(actions = []) {
  const buttons = actions.filter(Boolean).map(action => {
    const kind = action.kind === "primary" ? "primary" : "secondary";
    const buttonClass = kind === "primary" ? "primary-btn plan-card-action-btn" : "secondary-btn plan-card-action-btn";
    const icon = action.icon ? `<span class="nlc-icon nlc-icon--sm" data-icon="${escapeHTML(action.icon)}" aria-hidden="true"></span>` : "";
    const dataAction = action.action ? ` data-plan-card-action="${escapeHTML(action.action)}"` : "";
    return `
      <button type="button" class="plan-card__${kind}-action ${buttonClass}"${dataAction}>
        ${icon}<span>${escapeHTML(action.label || "")}</span>
      </button>
    `;
  }).join("");

  if (!buttons) return "";
  return `<div class="plan-card__actions plan-card-participation-actions">${buttons}</div>`;
}

function renderPlanCardShell({ plan, variant = "", header = "", status = "", progress = "", actions = "", after = "" } = {}) {
  const variantClass = variant ? ` plan-card--${escapeHTML(variant)}` : "";
  return `
    ${getPlanCoverHtml(plan)}
    <div class="plan-card__main${variantClass}">
      ${header}
      ${status}
      ${progress}
      ${actions}
      ${after}
    </div>
  `;
}

function normalizePlanSearchValue(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant")
    .replace(/\s+/g, " ")
    .trim();
}

function getPlanSearchText(plan) {
  if (!plan) return "";
  const stageNo = Number(plan.stageNo || plan.campaignDefinition && plan.campaignDefinition.stageNo || 0);
  const roundNo = Number(plan.roundNo || plan.campaignDefinition && plan.campaignDefinition.roundNo || 0);
  const bookNames = Array.isArray(plan.books)
    ? plan.books.map(book => typeof book === "string" ? book : book && (book.name || book.book)).filter(Boolean)
    : [];
  return normalizePlanSearchValue([
    plan.name,
    plan.description,
    plan.awardName,
    plan.presetKey,
    stageNo ? `第${stageNo}階段 ${stageNo}階段` : "",
    roundNo ? `第${roundNo}輪 ${roundNo}輪` : "",
    ...bookNames
  ].filter(Boolean).join(" "));
}

function matchesPlanSearch(plan) {
  if (!planSearchQuery) return true;
  return getPlanSearchText(plan).includes(planSearchQuery);
}

function getPlanStartCountdownText(plan) {
  if (!plan || !plan.startDate) return "";
  const parts = plan.startDate.split("-");
  if (parts.length !== 3) return `預計 ${escapeHTML(plan.startDate)} 開始`;
  
  const startYear = parseInt(parts[0], 10);
  const startMonth = parseInt(parts[1], 10) - 1;
  const startDay = parseInt(parts[2], 10);
  
  const start = new Date(startYear, startMonth, startDay);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const diffTime = start.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays <= 0) {
    return "今天開始";
  }
  return `${diffDays} 天後開始`;
}

function getPlanStorageKey(plan) {
  return plan && (plan.presetKey || plan.globalPlanId || plan.id || "");
}

async function openJoinedPlanProgress(plan) {
  if (!plan) return;
  delete plan.upgradeOverlayDismissedRound;
  state.activePlan = plan;
  state.planDetailOpen = true;
  state.planActiveSubTab = "today";
  window.currentPlanViewState = PLAN_ROUTE.DETAIL;
  if (typeof window.syncActivePlanContext === "function") window.syncActivePlanContext(plan);
  state.selectedPlanDay = null;
  localStorage.setItem("selected_plan_key", getPlanStorageKey(plan));
  if (isPlanExpired(plan)) showToast("此計畫已過期，僅供查看紀錄與統計。");
  if (typeof window.setPlanState === "function") {
    await window.setPlanState(PLAN_ROUTE.DETAIL);
  } else {
    await renderPlanView();
  }
}

async function openJoinedPlanTeam(plan) {
  await openJoinedPlanProgress(plan);
  if (window.PlanPageController) {
    await window.PlanPageController.switchPrimaryView(PLAN_PRIMARY_VIEW.STATS);
  }
}

async function confirmPlanJoin({ plan, mode, onConfirm }) {
  return new Promise(resolve => {
    const ElementCtor = window.HTMLElement || Element;
    const previousActiveElement = document.activeElement instanceof ElementCtor
      ? document.activeElement
      : null;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay plan-join-confirmation-overlay";
    overlay.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:var(--z-modal,700);";

    const title = mode === "team" ? "要和夥伴一起開始嗎？" : "要加入這個讀經計畫嗎？";
    const description = mode === "team"
      ? "你可以先選擇 3 人或 6 人團隊；建立後再把邀請碼分享給朋友。"
      : "加入後就能在首頁看到今天進度，也可以之後再加入團隊。";
    const confirmLabel = mode === "team" ? "選擇團隊人數" : "太好了，開始吧";

    overlay.innerHTML = `
      <section class="plan-join-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-join-confirmation-title" aria-describedby="plan-join-confirmation-description" tabindex="-1">
        <header class="plan-join-confirmation-dialog__header">
          <p class="plan-join-confirmation-dialog__eyebrow">${escapeHTML(plan.name || "讀經計畫")}</p>
          <h3 id="plan-join-confirmation-title">${title}</h3>
          <p id="plan-join-confirmation-description">${description}</p>
        </header>
        <footer class="plan-join-confirmation-dialog__footer">
          <p class="plan-join-confirmation-dialog__error" data-plan-confirm-error hidden></p>
          <button type="button" class="secondary-btn plan-join-confirmation-dialog__cancel" data-plan-confirm-cancel>我再看看</button>
          <button type="button" class="primary-btn plan-join-confirmation-dialog__confirm" data-plan-confirm-action>${confirmLabel}</button>
        </footer>
      </section>`;

    const panel = overlay.firstElementChild;
    const cancelButton = overlay.querySelector("[data-plan-confirm-cancel]");
    const confirmButton = overlay.querySelector("[data-plan-confirm-action]");
    const errorMessage = overlay.querySelector("[data-plan-confirm-error]");
    let settled = false;
    const focusableSelector = [
      "button:not([disabled])",
      "[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])'
    ].join(",");
    const focusableElements = () => Array.from(overlay.querySelectorAll(focusableSelector))
      .filter(element => element instanceof ElementCtor && !element.hidden);
    const close = value => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      if (previousActiveElement && document.contains(previousActiveElement)) {
        previousActiveElement.focus();
      }
      resolve(value);
    };
    const onKeyDown = event => {
      if (event.key === "Escape") close(false);
      if (event.key !== "Tab") return;

      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    overlay.addEventListener("click", event => {
      if (event.target === overlay) close(false);
    });
    cancelButton.addEventListener("click", () => close(false));
    confirmButton.addEventListener("click", async () => {
      confirmButton.disabled = true;
      if (errorMessage) {
        errorMessage.hidden = true;
        errorMessage.textContent = "";
      }
      try {
        await onConfirm();
        close(true);
      } catch (err) {
        console.error("Plan join confirmation failed:", err);
        if (!overlay.isConnected) return;
        if (errorMessage) {
          errorMessage.textContent = "暫時無法加入，請再試一次。";
          errorMessage.hidden = false;
        }
        confirmButton.disabled = false;
        confirmButton.focus();
      }
    });
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(overlay);
    if (typeof hydrateIcons === "function") hydrateIcons(overlay);
    (cancelButton || panel).focus();
  });
}

async function joinPlanSoloFromCard(plan, key) {
  const defaultSchedule = { readingDaysPerWeek: 7, restWeekdays: [] };
  const joinedPlan = await db.joinPresetPlan(key, defaultSchedule);
  if (joinedPlan) await openJoinedPlanProgress(joinedPlan);
  return joinedPlan;
}

async function createTeamFromPlanCard(plan, key) {
  if (typeof window.openReadingTeamDialog === "function") {
    await window.openReadingTeamDialog(plan);
  }
  return null;
}

function getJoinedPlanStartTime(plan) {
  if (!plan || !plan.startDate) return Number.MAX_SAFE_INTEGER;
  const date = new Date(`${plan.startDate}T00:00:00`);
  const time = date.getTime();
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
}

function sortJoinedPlansChronologically(plans) {
  return [...(plans || [])].sort((left, right) => {
    const leftStart = getJoinedPlanStartTime(left);
    const rightStart = getJoinedPlanStartTime(right);
    if (leftStart !== rightStart) return leftStart - rightStart;

    const leftStage = Number(left && (left.stageNumber || left.stage || left.stageIndex) || 0);
    const rightStage = Number(right && (right.stageNumber || right.stage || right.stageIndex) || 0);
    if (leftStage !== rightStage) return leftStage - rightStage;

    return String(left && left.name || "").localeCompare(String(right && right.name || ""), "zh-Hant");
  });
}

function renderPlanParticipationItem(model) {
  if (!model) return "";
  const actionHtml = model.action ? `
    <button
      type="button"
      class="plan-card-participation-item__button"
      data-plan-participation-action="${escapeHTML(model.action.action)}"
      data-plan-participation-division="${escapeHTML(String(model.action.division || ""))}"
    >
      ${escapeHTML(model.action.label)}
    </button>
  ` : "";

  return `
    <div class="plan-card-participation-item plan-card-participation-item--${escapeHTML(model.variant)} plan-card-participation-item--${escapeHTML(model.tone)}">
      <div class="plan-card-participation-item__media" aria-hidden="true">
        <span class="nlc-icon nlc-icon--sm" data-icon="${escapeHTML(model.icon)}"></span>
      </div>
      <div class="plan-card-participation-item__content">
        <div class="plan-card-participation-item__title">${escapeHTML(model.title)}</div>
        <div class="plan-card-participation-item__description">${escapeHTML(model.description)}</div>
      </div>
      ${actionHtml ? `<div class="plan-card-participation-item__actions">${actionHtml}</div>` : ""}
    </div>
  `;
}

function bindPlanParticipationItemActions(card, plan, model) {
  if (!card || !plan || !model || !model.action) return;
  card.querySelectorAll("[data-plan-participation-action]").forEach(button => {
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.getAttribute("data-plan-participation-action");
      const division = Number(button.getAttribute("data-plan-participation-division") || model.action.division || 3);

      if (action === "open-team") {
        await openJoinedPlanTeam(plan);
        return;
      }

      if (
        (action === "join-team-division" || action === "open-team-dialog")
        && typeof window.openReadingTeamDialog === "function"
      ) {
        await window.openReadingTeamDialog(plan, { preferredDivision: division });
      }
    });
  });
}

function renderJoinedPlansList() {
  try {
    const container = document.getElementById("joined-plans-list");
    if (!container) return;

    if (!state.activePlans) {
      ComponentSkeletonLoader.show('plan', container);
      return;
    }

    container.innerHTML = "";

    const activePill = document.querySelector("#plan-list-status-pills .pill-btn.active");
    const filter = activePill ? activePill.getAttribute("data-filter") : "mine";

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const isExpired = (plan) => {
      if (!plan || !plan.endDate) return false;
      const end = new Date(plan.endDate);
      end.setHours(0, 0, 0, 0);
      return today > end;
    };

    let plansToRender = [];
    if (filter === "mine") {
      plansToRender = (state.activePlans || []).filter(p => !isExpired(p));
    } else if (filter === "completed") {
      plansToRender = (state.activePlans || []).filter(p => isExpired(p));
    }

    plansToRender = plansToRender.filter(plan => canManageHiddenPlans() || !isPlanHidden(plan));
    plansToRender = plansToRender.filter(matchesPlanSearch);
    plansToRender = sortJoinedPlansChronologically(plansToRender);

    if (plansToRender.length === 0 && planSearchQuery) {
      container.innerHTML = `
        <div class="empty-state" style="text-align:center;padding:3rem 1rem;width:100%;">
          <p style="color:var(--text-secondary);margin:0 0 .5rem;font-weight:500;">找不到符合「${escapeHTML(planSearchQuery)}」的計畫</p>
          <p style="font-size:0.875rem;color:var(--text-muted);margin:0;">請嘗試其他計畫名稱、階段或獎項。</p>
        </div>
      `;
      return;
    }

    if (plansToRender.length === 0) {
      if (filter === "mine") {
        container.innerHTML = `
          <div class="empty-state" style="text-align: center; padding: 3rem 0;">
            <p style="color: var(--text-secondary); margin-bottom: 1.5rem; font-weight: 500;">您目前沒有加入任何讀經計畫。</p>
            <p style="font-size: 0.88rem; color: var(--text-muted);">${(window.APP_COPY && window.APP_COPY.plan.clickFindPlans) || "請點擊頂部「探索計畫」瀏覽並加入！"}</p>
          </div>
        `;
      } else {
        container.innerHTML = `
          <div class="empty-state" style="text-align: center; padding: 3rem 0; width: 100%;">
            <p style="color: var(--text-secondary); margin-bottom: 1rem; font-weight: 500;">目前沒有已結束的計畫</p>
            <p style="font-size: 0.875rem; color: var(--text-muted);">前往「探索計畫」加入新挑戰吧！</p>
          </div>
        `;
      }
      return;
    }

    plansToRender.forEach(plan => {
      const card = document.createElement("div");
      card.className = "plan-card joined-plan-item-card";
      card.onclick = async event => {
        if (event.target.closest("[data-plan-card-action]")) return;
        await openJoinedPlanProgress(plan);
      };

      const progress = plan.progress || 0;
      const currentRound = plan.currentRound || 1;
      const upgradeAvailability = getPlanUpgradeAvailability(plan, { expired: isPlanExpired(plan) });
      const isCampaignStage = window.isCampaignStagePlan(plan);
      const campaignAwardName = plan.awardName || plan.campaignDefinition && plan.campaignDefinition.awardName || "";
      const campaignAwardEarned = isCampaignStage && (currentRound > 1 || progress >= 100);
      const weeklyScheduleSummary = formatFlexibleScheduleSummary(plan);
      const isUpcomingFixed = isFixedPlanUpcoming(plan);
      const dateMeta = `
        <span class="nlc-icon nlc-icon--sm" data-icon="calendarThirty" aria-hidden="true"></span>
        <span>${escapeHTML(plan.startDate)} ~ ${escapeHTML(plan.endDate)}</span>
      `;

      if (filter === "completed") {
        // Expired plan: show status label instead of progress bar
        const isCompleted = (currentRound > 1) || (progress === 100);
        const statusText = isCompleted ? "已完成" : "未完成";

        card.innerHTML = renderPlanCardShell({
          plan,
          variant: "completed",
          header: renderPlanCardHeader({
            title: escapeHTML(plan.name),
            meta: dateMeta
          }),
          status: renderPlanCardStatusSummary([
            isCampaignStage && {
              icon: "award",
              label: "獎項",
              value: `${campaignAwardEarned ? "已獲得" : "完成可獲得"} ${escapeHTML(campaignAwardName)}`,
              tone: campaignAwardEarned ? "success" : "brand"
            },
            {
              icon: isCompleted ? "check" : "hourglass",
              label: "狀態",
              value: escapeHTML(statusText),
              tone: isCompleted ? "success" : "danger"
            }
          ]),
          actions: renderPlanCardActions([
            { kind: "secondary", icon: "calendarThirty", label: "查看紀錄", action: "open-detail" }
          ])
        });
      } else {
        // Normal active plan: show progress bar
        const progressText = isUpcomingFixed
          ? escapeHTML(getPlanStartCountdownText(plan))
          : (currentRound > 1
            ? `已完成第 ${currentRound - 1} 遍 👑<br>第 ${currentRound} 遍：已讀 ${progress}% (${plan.completedChapters} / ${plan.currentRoundTotalChapters || plan.totalChapters} 章)`
            : `已讀 ${progress}% (${plan.completedChapters} / ${plan.currentRoundTotalChapters || plan.totalChapters} 章)`);

        const isTeamPlan = typeof window.isReadingTeamPlan === "function" && window.isReadingTeamPlan(plan);
        const teamHtml = isTeamPlan ? `<div class="plan-card-team-controls"></div>` : "";
        const progressHtml = isUpcomingFixed
          ? ""
          : `<div class="plan-progress-wrapper plan-progress-wrapper--compact" style="width: 100%;">
              <div class="plan-progress-bar" style="width: ${progress}%;"></div>
            </div>`;

        card.innerHTML = renderPlanCardShell({
          plan,
          variant: isUpcomingFixed ? "upcoming" : "joined",
          header: renderPlanCardHeader({
            title: escapeHTML(plan.name),
            meta: dateMeta
          }),
          status: renderPlanCardStatusSummary([
            isCampaignStage && {
              icon: "award",
              label: "獎項",
              value: `${campaignAwardEarned ? "已獲得" : "完成可獲得"} ${escapeHTML(campaignAwardName)}`,
              tone: campaignAwardEarned ? "success" : "brand"
            },
            {
              icon: isUpcomingFixed ? "hourglass" : "bookOpen",
              label: isUpcomingFixed ? "開始時間" : "進度",
              value: progressText,
              tone: isUpcomingFixed ? "warning" : "neutral"
            },
            {
              icon: "calendarThirty",
              label: "安排",
              value: `<span class="joined-plan-schedule-summary">${escapeHTML(weeklyScheduleSummary)}</span>`
            }
          ]),
          progress: progressHtml,
          actions: renderPlanCardActions([
            { kind: upgradeAvailability.eligible ? "secondary" : "primary", icon: isUpcomingFixed ? "calendarThirty" : "bookOpen", label: isUpcomingFixed ? "查看計畫" : "繼續讀經", action: "continue" },
            upgradeAvailability.eligible && { kind: "primary", icon: "trophy", label: `開始${upgradeAvailability.nextRoundLabel}`, action: "upgrade" }
          ]),
          after: teamHtml
        });

        if (typeof hydrateIcons === "function") hydrateIcons(card);

        card.querySelector('[data-plan-card-action="continue"]')?.addEventListener("click", async event => {
          event.preventDefault();
          event.stopPropagation();
          await openJoinedPlanProgress(plan);
        });
        card.querySelector('[data-plan-card-action="upgrade"]')?.addEventListener("click", async event => {
          event.preventDefault();
          event.stopPropagation();
          delete plan.upgradeOverlayDismissedRound;
          await openJoinedPlanProgress(plan);
        });
        if (isTeamPlan) {
          const teamContainer = card.querySelector(".plan-card-team-controls");
          if (teamContainer) {
            teamContainer.classList.add("plan-card-participation-slot");
            const isDemo = state.currentUser && state.currentUser.is_demo;
            const isLoggedIn = typeof auth !== "undefined" && auth.isLoggedIn();

            if (isDemo || !isLoggedIn) {
              teamContainer.innerHTML = `<span class="plan-card-participation-item__hint">團隊功能需登入正式帳號</span>`;
            } else {
              teamContainer.innerHTML = `<span class="plan-card-participation-item__hint">正在載入團隊狀態...</span>`;
              db.getMyReadingTeam(plan).then(result => {
                if (!teamContainer.parentElement) return;
                const contexts = (result && result.success) ? getJoinedReadingTeamContexts(result.context) : [];
                const participationModel = getPlanParticipationModel(plan, contexts);
                teamContainer.innerHTML = renderPlanParticipationItem(participationModel);
                bindPlanParticipationItemActions(card, plan, participationModel);
                if (typeof hydrateIcons === "function") hydrateIcons(teamContainer);
              }).catch(err => {
                console.error("Error loading team info for card:", err);
                teamContainer.innerHTML = `<span class="plan-card-participation-item__hint plan-card-participation-item__hint--danger">無法載入團隊資料</span>`;
              });
            }
          }
        }
      }

      container.appendChild(card);
    });
  } catch (err) {
    console.error("Critical error inside renderJoinedPlansList:", err);
  }
}


function formatCampaignReadingRange(reading) {
  const book = (window.BIBLE_BOOKS || []).find(item => item.name === reading.book);
  const from = Number(reading.from || 1);
  const to = Number(reading.to || book && book.chapters || from);
  return reading.book + " " + (from === to ? from : from + "–" + to) + "章";
}

// ==================== 加入模式選擇對話框 ====================
// 顯示「個人 or 團體」選擇，在加入計畫之前呼叫。
// 回傳 3（3人團隊）、6（6人團隊）或 null（先自己開始）。
function openJoinModeDialog(plan) {
  return new Promise(resolve => {
    const existing = document.getElementById("join-mode-dialog");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "join-mode-dialog";
    overlay.className = "modal-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:10001;background:rgba(15,23,42,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:1rem;animation:fadeIn 0.18s ease;";

    overlay.innerHTML = `
      <div class="glass-card" role="dialog" aria-modal="true" aria-labelledby="join-mode-title"
        style="width:min(400px,100%);padding:1.5rem;background:var(--bg-card);border:1px solid var(--border-card);box-shadow:var(--shadow-lg);border-radius:20px;animation:slideUp 0.22s cubic-bezier(0.34,1.56,0.64,1);">

        <div style="display:flex;align-items:center;gap:.65rem;margin-bottom:.35rem;">
          <span class="nlc-icon nlc-icon--md" data-icon="people" style="color:var(--color-brand);" aria-hidden="true"></span>
          <h3 id="join-mode-title" style="margin:0;font-size:1.05rem;font-weight:600;color:var(--text-primary);">要與夥伴一起讀嗎？</h3>
        </div>
        <p style="margin:0 0 1.2rem;font-size:0.875rem;color:var(--text-muted);line-height:1.5;">
          計畫已加入！你可以額外選擇報名讀經小組團隊，與夥伴彼此鼓勵；若暫不組隊，請點擊下方的「先自己開始」。
        </p>

        <div style="display:flex;flex-direction:column;gap:.65rem;margin-bottom:1.4rem;">
          <!-- 3人團隊 -->
          <button type="button" id="join-mode-team-3"
            style="display:flex;align-items:center;gap:.9rem;padding:.9rem 1rem;border-radius:14px;
                   border:1.5px solid var(--border-card);background:var(--bg-input);
                   cursor:pointer;transition:all .18s ease;text-align:left;width:100%;">
            <span style="width:40px;height:40px;border-radius:50%;display:grid;place-items:center;
                         background:rgba(4,169,210,.10);flex-shrink:0;">
              <span class="nlc-icon nlc-icon--sm" data-icon="people" aria-hidden="true"></span>
            </span>
            <span style="display:flex;flex-direction:column;gap:.18rem;">
              <strong style="font-size:.92rem;font-weight:600;color:var(--text-primary);">報名 3 人團隊</strong>
              <span style="font-size:0.875rem;color:var(--text-muted);">固定三人組隊，共同挑戰進度</span>
            </span>
            <span style="margin-left:auto;flex-shrink:0;display:inline-flex;color:var(--text-muted);">
              <span class="nlc-icon nlc-icon--sm" data-icon="chevronRight" aria-hidden="true"></span>
            </span>
          </button>

          <!-- 6人團隊 -->
          <button type="button" id="join-mode-team-6"
            style="display:flex;align-items:center;gap:.9rem;padding:.9rem 1rem;border-radius:14px;
                   border:1.5px solid var(--border-card);background:var(--bg-input);
                   cursor:pointer;transition:all .18s ease;text-align:left;width:100%;">
            <span style="width:40px;height:40px;border-radius:50%;display:grid;place-items:center;
                         background:rgba(34,197,94,.10);flex-shrink:0;">
              <span class="nlc-icon nlc-icon--sm" data-icon="people" aria-hidden="true"></span>
            </span>
            <span style="display:flex;flex-direction:column;gap:.18rem;">
              <strong style="font-size:.92rem;font-weight:600;color:var(--text-primary);">報名 6 人團隊</strong>
              <span style="font-size:0.875rem;color:var(--text-muted);">固定六人組隊，挑戰更高榮譽</span>
            </span>
            <span style="margin-left:auto;flex-shrink:0;display:inline-flex;color:var(--text-muted);">
              <span class="nlc-icon nlc-icon--sm" data-icon="chevronRight" aria-hidden="true"></span>
            </span>
          </button>
        </div>

        <div style="display:flex;justify-content:flex-start;">
          <button type="button" id="join-mode-cancel" class="secondary-btn"
            style="font-size:0.875rem;padding:.45rem 1rem;cursor:pointer;">先自己開始</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    if (typeof hydrateIcons === "function") hydrateIcons(overlay);

    const close = value => { overlay.remove(); resolve(value); };

    // Hover effects
    const addHover = (btn, borderColor, bgColor) => {
      if (!btn) return;
      btn.addEventListener("mouseenter", () => {
        btn.style.borderColor = borderColor;
        btn.style.background = bgColor;
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.borderColor = "var(--border-card)";
        btn.style.background = "var(--bg-input)";
      });
    };

    const team3Btn = overlay.querySelector("#join-mode-team-3");
    const team6Btn = overlay.querySelector("#join-mode-team-6");
    const cancelBtn = overlay.querySelector("#join-mode-cancel");

    addHover(team3Btn, "var(--color-brand)", "rgba(4,169,210,.06)");
    addHover(team6Btn, "var(--color-success-foreground)", "rgba(34,197,94,.06)");

    team3Btn?.addEventListener("click", () => close(3));
    team6Btn?.addEventListener("click", () => close(6));
    cancelBtn?.addEventListener("click", () => close("solo"));
    overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
  });
}

// ==================== 全域加入團隊支援 ====================
async function joinTeamGlobally(inviteCode) {
  const code = String(inviteCode || "").trim().toUpperCase();
  if (!code) {
    return { success: false, message: "請輸入邀請碼。" };
  }

  if (!state.isSupabaseMode || !state.supabase || (state.currentUser && state.currentUser.is_demo)) {
    return { success: false, message: "團隊功能需登入正式帳號使用。" };
  }

  loader.show("正在尋找並加入團隊...");
  try {
    const candidatePlans = [];
    const seenIds = new Set();

    const addPlan = (p) => {
      if (!p) return;
      const id = p.globalPlanId || p.id;
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        candidatePlans.push(p);
      }
    };

    (state.activePlans || []).forEach(addPlan);
    (state.globalPlans || []).forEach(addPlan);

    if (candidatePlans.length === 0 && typeof CHURCH_PLAN_PRESETS !== "undefined") {
      Object.values(CHURCH_PLAN_PRESETS).forEach(addPlan);
    }

    let joinResult = null;
    let matchingPlan = null;

    // Try joining for each plan UUID
    for (const plan of candidatePlans) {
      const planId = typeof db._readingTeamPlanId === "function" ? db._readingTeamPlanId(plan) : (plan.globalPlanId || plan.id);
      if (!planId) continue;

      const res = await db.joinReadingTeam(plan, code);
      if (res && (res.success || isAlreadyJoinedTeamResult(res))) {
        joinResult = res;
        matchingPlan = plan;
        break;
      } else if (res && res.message && !res.message.includes("找不到這組邀請碼")) {
        joinResult = res;
        matchingPlan = plan;
        break;
      }
    }

    if (!joinResult || (!joinResult.success && !isAlreadyJoinedTeamResult(joinResult))) {
      return {
        success: false,
        message: (joinResult && joinResult.message) || "找不到這組邀請碼，請向隊長確認。"
      };
    }

    const effectivePlan = await resolveTeamJoinEffectivePlan({
      teamJoinResult: joinResult,
      matchingPlan,
      activePlans: state.activePlans || [],
      joinPlan: async plan => {
        const defaultSchedule = { readingDaysPerWeek: 7, restWeekdays: [] };
        return db.joinPresetPlan(plan.presetKey || plan.id, defaultSchedule);
      }
    });
    if (!effectivePlan) {
      return {
        success: false,
        message: "已加入團隊，但無法自動加入對應讀經計畫。請重新整理後再試。"
      };
    }

    return { success: true, plan: effectivePlan, result: joinResult };
  } catch (err) {
    console.error("joinTeamGlobally error:", err);
    return { success: false, message: "加入失敗：" + (err.message || err) };
  } finally {
    loader.hide();
  }
}
window.joinTeamGlobally = joinTeamGlobally;

function setupGlobalJoinTeamForm() {
  const form = document.getElementById("global-join-team-form");
  if (!form || form.dataset.listenerBound) return;
  form.dataset.listenerBound = "true";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("global-team-code-input");
    const errorEl = document.getElementById("global-join-team-error");
    const submitBtn = document.getElementById("global-join-team-submit-btn");

    if (!input || !errorEl) return;
    errorEl.style.display = "none";
    errorEl.textContent = "";

    const code = input.value.trim().toUpperCase();
    if (!code) {
      errorEl.textContent = "請輸入邀請碼！";
      errorEl.style.display = "block";
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.style.opacity = "0.7";
    }

    try {
      const res = await window.joinTeamGlobally(code);
      if (res && res.success) {
        const planName = res.plan && res.plan.name ? res.plan.name : "對應讀經計畫";
        const teamData = res.result && res.result.data;
        const teamName = teamData && (teamData.teamName || teamData.name || teamData.team && teamData.team.name)
          || res.result && (res.result.teamName || res.result.name);
        showToast(teamName
          ? `已成功加入「${planName}」的「${teamName}」團隊！`
          : `已成功加入「${planName}」的團隊！`);
        input.value = "";

        resetPlanTeamInvitePanel();
        void updatePlanTeamInviteShortcutVisibility();
        if (res.plan) {
          await openJoinedPlanTeam(res.plan);
        } else {
          closePlanTeamInvitePanel();
        }
      } else {
        errorEl.textContent = (res && res.message) || "加入失敗，請確認邀請碼是否正確。";
        errorEl.style.display = "block";
      }
    } catch (err) {
      errorEl.textContent = "加入團隊時發生錯誤：" + (err.message || err);
      errorEl.style.display = "block";
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.style.opacity = "1";
      }
    }
  });
}

function openPlanDetailsDialog(plan, options = {}) {
  if (!plan) return;
  const joinAction = typeof options.onJoin === "function" ? options.onJoin : null;
  const existing = document.getElementById("plan-details-dialog");
  if (existing) existing.remove();

  const isFlexible = plan.isFixed === false || plan.is_fixed === false;
  const definition = plan.campaignDefinition || null;
  const isCampaignStage = window.isCampaignStagePlan(plan) && definition;
  const books = plan.target_books || plan.targetBooks || plan.books || [];
  const scheduleText = (plan.startDate + " ～ " + plan.endDate) + "；" + formatFlexibleScheduleSummary(plan);
  const segments = isCampaignStage && Array.isArray(definition.segments) ? definition.segments : [];
  // 延後大區梯次沒有 campaignDefinition，但一樣要顯示「完成可獲得的獎」——用 plan.awardName。
  const awardName = plan.awardName || (isCampaignStage ? (definition.awardName || "") : "");
  const showAward = Boolean(awardName);
  const awardEarned = showAward && ((plan.currentRound || 1) > 1 || Number(plan.progress || 0) >= 100);
  const segmentHtml = segments.map(segment => `
    <section style="padding:.9rem;border:1px solid var(--border-card);border-radius:12px;background:var(--bg-secondary);">
      <div style="display:flex;justify-content:space-between;gap:.75rem;align-items:flex-start;">
        <strong style="font-size:0.875rem;font-weight:500;color:var(--text-primary);">${escapeHTML(segment.label)}</strong>
        <span style="font-size:0.875rem;color:var(--text-muted);white-space:nowrap;">${escapeHTML(segment.startDate)} ～ ${escapeHTML(segment.endDate)}</span>
      </div>
      <div style="margin-top:.5rem;font-size:0.875rem;line-height:1.65;color:var(--text-secondary);">${(segment.readings || []).map(formatCampaignReadingRange).map(escapeHTML).join("、")}</div>
    </section>
  `).join("");

  const overlay = document.createElement("div");
  overlay.id = "plan-details-dialog";
  overlay.className = "modal-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.58);display:flex;align-items:center;justify-content:center;padding:1rem;";
  overlay.innerHTML = `
    <div class="glass-card" role="dialog" aria-modal="true" aria-labelledby="plan-details-title"
      style="width:min(520px,100%);height:auto!important;max-height:84vh;overflow:auto;padding:1.5rem;background:var(--bg-card);border:1px solid var(--border-card);box-shadow:var(--shadow-lg);position:relative;">
      
      <!-- X Close Button -->
      <button type="button" id="plan-details-x-btn" class="dialog-close-button icon-button icon-button--subtle" aria-label="關閉"
        style="position:absolute;top:1rem;right:1rem;">
        <span class="nlc-icon nlc-icon--sm" data-icon="close" aria-hidden="true"></span>
      </button>

      <h3 id="plan-details-title" style="margin:0 0 1rem;font-size:1.15rem;font-weight:500;color:var(--text-primary);padding-right:2rem;">${escapeHTML(plan.name || "讀經計畫")}</h3>
      ${showAward ? `<div style="display:flex;align-items:center;gap:.75rem;padding:.9rem;margin-bottom:1rem;border-radius:14px;background:var(--bg-secondary);border:1px solid var(--border-card);"><div style="width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:var(--primary-color);color:white;"><span class="nlc-icon" data-icon="award" aria-hidden="true"></span></div><div><div style="font-size:0.875rem;color:var(--text-muted);">${awardEarned ? "已完成並獲得" : "完成本階段可獲得"}</div><strong style="font-size:1rem;color:var(--text-primary);">${escapeHTML(awardName)}</strong></div></div>` : ""}
      ${plan.description ? `<p style="margin:0 0 1rem;font-size:0.875rem;line-height:1.6;color:var(--text-secondary);">${escapeHTML(plan.description)}</p>` : ""}
      <dl style="display:grid;grid-template-columns:auto 1fr;gap:.65rem .9rem;margin:0;font-size:0.875rem;">
        <dt style="color:var(--text-muted);">計畫類型</dt><dd style="margin:0;color:var(--text-primary);">${isCampaignStage ? "教會分階段計畫" : (isFlexible ? "非固定日期" : "固定日期")}</dd>
        <dt style="color:var(--text-muted);">日期／安排</dt><dd style="margin:0;color:var(--text-primary);">${escapeHTML(scheduleText)}</dd>
        ${isCampaignStage ? `<dt style="color:var(--text-muted);">階段／輪次</dt><dd style="margin:0;color:var(--text-primary);">第 ${Number(definition.stageNo)} 階段・第 ${Number(definition.roundNo)} 輪</dd>${definition.examDate ? `<dt style="color:var(--text-muted);">考試日期</dt><dd style="margin:0;color:var(--text-primary);">${escapeHTML(definition.examDate)}</dd>` : ""}` : ""}
        <dt style="color:var(--text-muted);">閱讀經卷</dt><dd style="margin:0;color:var(--text-primary);line-height:1.55;">${books.length ? escapeHTML(books.join("、")) : "依計畫排程"}</dd>
      </dl>
      ${segmentHtml ? `<h4 style="margin:1.25rem 0 .7rem;font-size:.92rem;font-weight:500;color:var(--text-primary);">每月／階段章節安排</h4><div style="display:grid;gap:.65rem;">${segmentHtml}</div>` : ""}
      <div style="display:flex;justify-content:flex-end;margin-top:1.35rem;"><button type="button" id="plan-details-close" class="primary-btn">關閉</button></div>
    </div>
  `;
  document.body.appendChild(overlay);
  if (typeof hydrateIcons === "function") hydrateIcons(overlay);
  const close = () => overlay.remove();
  
  const xBtn = overlay.querySelector("#plan-details-x-btn");
  xBtn.addEventListener("click", close);

  const closeButton = overlay.querySelector("#plan-details-close");
  closeButton.addEventListener("click", close);

  if (joinAction) {
    const parent = closeButton.parentElement;
    closeButton.remove();
    
    const joinButton = document.createElement("button");
    joinButton.type = "button";
    joinButton.className = "primary-btn";
    joinButton.textContent = isFixedPlanUpcoming(plan) ? "預先加入計畫" : "加入計畫";
    joinButton.addEventListener("click", async () => {
      joinButton.disabled = true;
      close();
      await joinAction();
    });
    parent.appendChild(joinButton);
  }
  overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
}

function formatFlexibleScheduleSummary(plan) {
  const labels = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
  const restDays = Array.isArray(plan && (plan.restWeekdays || plan.rest_weekdays))
    ? (plan.restWeekdays || plan.rest_weekdays).map(Number).filter(day => day >= 0 && day <= 6)
    : [];
  const readingDays = Number(plan && (plan.readingDaysPerWeek || plan.reading_days_per_week)) || (7 - restDays.length);
  return restDays.length
    ? "每週 " + readingDays + " 天；" + restDays.map(day => labels[day]).join("、") + "休息"
    : "每週 7 天；沒有固定休息日";
}

function isFixedPlanUpcoming(plan) {
  if (!plan || plan.isFixed === false || plan.is_fixed === false || !plan.startDate) return false;
  if (typeof isPlanStarted === "function") return !isPlanStarted(plan);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(plan.startDate + "T00:00:00");
  return !Number.isNaN(start.getTime()) && today < start;
}

function openFlexibleScheduleDialog(plan, options = {}) {
  return new Promise(resolve => {
    const existing = document.getElementById("flexible-schedule-dialog");
    if (existing) existing.remove();

    const weekdayLabels = ["\u9031\u65e5", "\u9031\u4e00", "\u9031\u4e8c", "\u9031\u4e09", "\u9031\u56db", "\u9031\u4e94", "\u9031\u516d"];
    const initialRestDays = Array.isArray(plan && (plan.restWeekdays || plan.rest_weekdays))
      ? (plan.restWeekdays || plan.rest_weekdays).map(Number)
      : [0, 6];
    const initialReadingDays = Number(plan && (plan.readingDaysPerWeek || plan.reading_days_per_week)) || (7 - initialRestDays.length);
    const isEditing = options.editing === true;
    const isFixed = plan && plan.isFixed !== false && plan.is_fixed !== false;
    const isUpcomingFixed = isFixedPlanUpcoming(plan);
    const scheduleIntro = isUpcomingFixed
      ? `已開放預覽與預先加入，將於 ${plan.startDate} 正式開始，敬請期待。`
      : (isFixed
        ? `這是固定日期計畫，章節會依 ${plan.startDate} ～ ${plan.endDate} 與您選擇的讀經日安排。`
        : `${(plan && plan.name) || "非固定日期計畫"}會從今天開始，章節只會分配在您選擇的讀經日。`);
    const overlay = document.createElement("div");
    overlay.id = "flexible-schedule-dialog";
    overlay.className = "modal-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.58);display:flex;align-items:center;justify-content:center;padding:1rem;";
    overlay.innerHTML = `
      <div class="glass-card" role="dialog" aria-modal="true" aria-labelledby="flexible-schedule-title"
        style="width:min(420px,100%);height:auto!important;padding:1.5rem;background:var(--bg-card);border:1px solid var(--border-card);box-shadow:var(--shadow-lg);">
        <h3 id="flexible-schedule-title" style="margin:0 0 .35rem;font-size:1.15rem;font-weight:500;color:var(--text-primary);">\u8a2d\u5b9a\u6bcf\u9031\u8b80\u7d93\u5b89\u6392</h3>
        <p style="margin:0 0 1.25rem;font-size:0.875rem;line-height:1.55;color:var(--text-secondary);">
          ${escapeHTML(scheduleIntro)}
        </p>
        <label for="flexible-reading-days" style="display:block;margin-bottom:.45rem;font-size:0.875rem;font-weight:500;color:var(--text-primary);">\u4e00\u9031\u60f3\u8b80\u7d93\u5e7e\u5929</label>
        <select id="flexible-reading-days" class="form-control" style="width:100%;margin-bottom:1.1rem;">
          ${[1, 2, 3, 4, 5, 6, 7].map(days => `<option value="${days}" ${days === initialReadingDays ? "selected" : ""}>\u6bcf\u9031 ${days} \u5929</option>`).join("")}
        </select>
        <fieldset style="border:0;padding:0;margin:0;">
          <legend style="margin-bottom:.55rem;font-size:0.875rem;font-weight:500;color:var(--text-primary);">\u56fa\u5b9a\u4f11\u606f\u661f\u671f</legend>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.5rem;">
            ${weekdayLabels.map((label, day) => `
              <label style="display:flex;align-items:center;gap:.35rem;padding:.55rem .45rem;border:1px solid var(--border-card);border-radius:10px;cursor:pointer;font-size:0.875rem;color:var(--text-primary);">
                <input class="schedule-weekday-checkbox" type="checkbox" value="${day}" ${initialRestDays.includes(day) ? "checked" : ""}>
                <span>${label}</span>
              </label>
            `).join("")}
          </div>
        </fieldset>
        <p id="flexible-schedule-summary" style="margin:.85rem 0 0;font-size:0.875rem;color:var(--text-muted);"></p>
        <p id="flexible-schedule-error" role="alert" style="display:none;margin:.55rem 0 0;font-size:0.875rem;color:var(--color-danger);"></p>
        <div style="display:flex;justify-content:flex-end;gap:.65rem;margin-top:1.25rem;">
          <button type="button" id="flexible-schedule-cancel" class="secondary-btn">\u53d6\u6d88</button>
          <button type="button" id="flexible-schedule-confirm" class="primary-btn">${isEditing ? "儲存安排" : (isUpcomingFixed ? "預先加入" : "加入計畫")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const daysSelect = overlay.querySelector("#flexible-reading-days");
    const checkboxes = Array.from(overlay.querySelectorAll(".schedule-weekday-checkbox"));
    const summary = overlay.querySelector("#flexible-schedule-summary");
    const error = overlay.querySelector("#flexible-schedule-error");
    const preferredRestOrder = [0, 6, 5, 4, 3, 2, 1];

    const updateSummary = () => {
      const restDays = checkboxes.filter(input => input.checked).map(input => weekdayLabels[Number(input.value)]);
      summary.textContent = restDays.length > 0
        ? `\u6bcf\u9031\u8b80 ${daysSelect.value} \u5929\uff1b${restDays.join("\u3001")}\u56fa\u5b9a\u4f11\u606f\u3002`
        : "\u6bcf\u9031 7 \u5929\u90fd\u5b89\u6392\u8b80\u7d93\u3002";
      error.style.display = "none";
    };

    const syncRestDays = () => {
      const targetRestCount = 7 - Number(daysSelect.value);
      const selected = checkboxes.filter(input => input.checked).map(input => Number(input.value));
      const nextRestDays = selected.slice(0, targetRestCount);
      preferredRestOrder.forEach(day => {
        if (nextRestDays.length < targetRestCount && !nextRestDays.includes(day)) nextRestDays.push(day);
      });
      checkboxes.forEach(input => { input.checked = nextRestDays.includes(Number(input.value)); });
      updateSummary();
    };

    daysSelect.addEventListener("change", syncRestDays);
    checkboxes.forEach(input => input.addEventListener("change", () => {
      const restCount = checkboxes.filter(item => item.checked).length;
      if (restCount >= 7) {
        input.checked = false;
        error.textContent = "\u4e00\u9031\u81f3\u5c11\u9700\u8981\u4fdd\u7559 1 \u5929\u8b80\u7d93\u3002";
        error.style.display = "block";
        return;
      }
      daysSelect.value = String(7 - checkboxes.filter(item => item.checked).length);
      updateSummary();
    }));

    const close = value => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector("#flexible-schedule-cancel").addEventListener("click", () => close(null));
    overlay.querySelector("#flexible-schedule-confirm").addEventListener("click", () => {
      const restWeekdays = checkboxes.filter(input => input.checked).map(input => Number(input.value)).sort((a, b) => a - b);
      const templateStart = new Date(plan.startDate);
      const templateEnd = new Date(plan.endDate);
      const durationDays = Math.max(1, Math.ceil((templateEnd - templateStart) / 86400000) + 1);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const validationStart = isFixed && !Number.isNaN(templateStart.getTime()) ? templateStart : today;
      const hasReadingDay = Array.from({ length: durationDays }, (_, offset) => {
        const date = new Date(validationStart);
        date.setDate(validationStart.getDate() + offset);
        return date;
      }).some(date => !restWeekdays.includes(date.getDay()));

      if (!hasReadingDay) {
        error.textContent = "\u9019\u500b\u8a08\u756b\u671f\u9593\u5167\u6c92\u6709\u53ef\u7528\u7684\u8b80\u7d93\u65e5\uff0c\u8acb\u8abf\u6574\u4f11\u606f\u661f\u671f\u3002";
        error.style.display = "block";
        return;
      }
      close({ readingDaysPerWeek: 7 - restWeekdays.length, restWeekdays });
    });
    overlay.addEventListener("click", event => {
      if (event.target === overlay) close(null);
    });
    updateSummary();
  });
}

function renderPresetPlansList() {
  const container = document.getElementById("preset-plans-list");
  if (!container) return;
  container.innerHTML = "";

  // 每日靈修功能旗標還沒讀到 → 先讀，讀到「開啟」再重畫一次讓靈修計畫現身。
  if (typeof window.dailyDevotionFeatureEnabled !== "boolean" && typeof isDailyDevotionFeatureEnabled === "function") {
    isDailyDevotionFeatureEnabled().then(v => { if (v === true) renderPresetPlansList(); }).catch(() => {});
  }

  const legacyCategoryIdPrefix = "00000000-0000-0000-a000-";
  const isObsoleteCategoryPlan = plan =>
    String(plan && (plan.id || plan.globalPlanId || "")).startsWith(legacyCategoryIdPrefix)
    || String(plan && plan.presetKey || "").startsWith("m_");

  const presetPlanEntries = Object.entries(CHURCH_PLAN_PRESETS).map(([key, plan]) => ({
    ...plan,
    id: plan.id || key,
    presetKey: key
  }));
  const loadedPlans = state.globalPlans && state.globalPlans.length > 0
    ? state.globalPlans
    : [];
  const loadedPlanKeys = new Set(loadedPlans.flatMap(plan =>
    [plan && plan.id, plan && plan.globalPlanId, plan && plan.presetKey].filter(Boolean).map(String)
  ));
  const missingCampaignStages = presetPlanEntries.filter(plan =>
    ![plan.id, plan.globalPlanId, plan.presetKey].filter(Boolean).map(String).some(key => loadedPlanKeys.has(key))
  );
  const sourcePlans = loadedPlans.length > 0
    ? [...loadedPlans, ...missingCampaignStages]
    : presetPlanEntries;

  const joinedKeys = new Set((state.activePlans || []).flatMap(plan => [
    plan.id,
    plan.globalPlanId,
    plan.presetKey,
    plan.name
  ].filter(Boolean).map(String)));

  const isLegacyCampaignMaster = plan => {
    const identifiers = [plan && plan.id, plan && plan.globalPlanId, plan && plan.presetKey].filter(Boolean).map(String);
    const normalizedName = String(plan && plan.name || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
    return plan && (plan.planKind === "church_campaign"
      || identifiers.includes(String(window.CHURCH_CAMPAIGN_ID))
      || identifiers.includes(String(window.CHURCH_CAMPAIGN_PRESET_KEY))
      || normalizedName === "2026-2029 新生生命聖經速讀計畫");
  };

  const visiblePlans = sourcePlans.filter(plan => {
    if (!plan) return false;
    const isObsolete = isObsoleteCategoryPlan(plan);
    const isLegacy = isLegacyCampaignMaster(plan);
    const isHidden = isPlanHidden(plan);
    const matchesSearch = matchesPlanSearch(plan);
    
    const joinedKeysValues = [plan.id, plan.globalPlanId, plan.presetKey, plan.name].filter(Boolean).map(String);
    const isAlreadyJoined = joinedKeysValues.some(value => joinedKeys.has(value));

    if (isObsolete || isLegacy) return false;
    // 每日靈修計畫：daily_devotion 功能關著時，只有 admin / pastor 看得到（先建內容用）。
    if (!isDevotionalPlanVisibleToUser(plan)) return false;
    // 隱藏的計畫：一般會友看不到。例外：被鎖住的教會階段**且**標記為
    // discoverWhenLocked（月度期末賽）→ 顯示為 available-locked。第三階段之後
    // 沒帶這個旗標 → 完全隱藏，等管理員開放（is_hidden 轉 false）才現身。
    const showAsLocked = window.isCampaignStageLocked(plan)
      && window.isCampaignStageDiscoverableWhileLocked(plan);
    // 第三階段起（2027 年～，沒帶 discoverWhenLocked）的隱藏階段計畫：探索清單裡
    // 只有「系統管理員」看得到；牧者 / 區長 / 小組長也都看不到，直到 is_hidden
    // 轉 false 才對所有人現身。（一般隱藏計畫仍照 canManageHiddenPlans 放行給管理者預覽。）
    const isFullyHiddenCampaignStage = isHidden
      && window.isCampaignStageLocked(plan)
      && !window.isCampaignStageDiscoverableWhileLocked(plan);
    const viewerRole = (state.currentUser && getUserRoleCode(state.currentUser)) || "member";
    if (isFullyHiddenCampaignStage && viewerRole !== "admin") return false;
    if (isHidden && !canManageHiddenPlans() && !showAsLocked) return false;
    if (!matchesSearch) return false;
    return !isAlreadyJoined;
  });

  if (visiblePlans.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="text-align:center;padding:2.5rem 1rem;">
        <p style="color:var(--text-secondary);margin:0;">${planSearchQuery
          ? `找不到符合「${escapeHTML(planSearchQuery)}」的計畫。`
          : "目前沒有其他可加入的讀經計畫。"}</p>
      </div>
    `;
    return;
  }

  const getDurationLabel = (startDate, endDate) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "日期尚未公布";
    const days = Math.max(1, Math.ceil((end - start) / 86400000) + 1);
    return days >= 365 ? `${startDate} ～ ${endDate}` : `共 ${days} 天`;
  };

  visiblePlans.forEach(plan => {
    const key = plan.id || plan.presetKey;
    const isCampaignStage = window.isCampaignStagePlan(plan);
    const isLockedStage = window.isCampaignStageLocked(plan);
    const isDevotional = (plan.planKind || plan.plan_kind) === "devotional";
    const devDevMode = isDevotional && window.isDevotionalPlanDevMode(plan);
    const isFixed = plan.isFixed !== false && plan.is_fixed !== false;
    const scheduleLabel = isCampaignStage
      ? `第 ${Number(plan.stageNo || plan.campaignDefinition && plan.campaignDefinition.stageNo)} 階段・第 ${Number(plan.roundNo || plan.campaignDefinition && plan.campaignDefinition.roundNo)} 輪`
      : isDevotional
      ? `每日靈修・${getDurationLabel(plan.startDate, plan.endDate)}`
      : (isFixed ? getDurationLabel(plan.startDate, plan.endDate) : `彈性開始・${getDurationLabel(plan.startDate, plan.endDate)}`);
    const description = plan.description || "";
    const awardName = plan.awardName || plan.campaignDefinition && plan.campaignDefinition.awardName || "";
    const isUpcomingFixed = isFixed && isFixedPlanUpcoming(plan);
    const upcomingNotice = isUpcomingFixed
      ? `已開放預覽與預先加入・${plan.startDate} 正式開始，敬請期待`
      : "";

    const card = document.createElement("div");
    card.className = "plan-card joined-plan-item-card" + (devDevMode ? " plan-card--dev" : "");
    card.innerHTML = renderPlanCardShell({
      plan,
      variant: isLockedStage ? "available-locked" : (isUpcomingFixed ? "available-upcoming" : "available"),
      header: renderPlanCardHeader({
        title: escapeHTML(plan.name) + (devDevMode ? ' <span class="plan-card__dev-badge">開發中・會友看不到</span>' : ""),
        meta: `
          <span class="nlc-icon nlc-icon--sm" data-icon="calendarThirty" aria-hidden="true"></span>
          <span>${escapeHTML(scheduleLabel)}</span>
        `,
        description: description ? escapeHTML(description) : ""
      }),
      status: renderPlanCardStatusSummary([
        isCampaignStage && {
          icon: "award",
          label: "完成獎勵",
          value: escapeHTML(awardName)
        },
        isLockedStage && {
          icon: "lock",
          label: "\u958b\u653e\u72c0\u614b",
          value: "\u5c1a\u672a\u958b\u653e",
          tone: "warning"
        },
        devDevMode && {
          icon: "lock",
          label: "\u958b\u653e\u72c0\u614b",
          value: "\u958b\u767c\u4e2d\uff0c\u5c1a\u672a\u5c0d\u6703\u53cb\u958b\u653e\uff08\u53ea\u6709\u4f60\u770b\u5f97\u5230\uff09",
          tone: "warning"
        },
        upcomingNotice && {
          icon: "hourglass",
          label: "開放狀態",
          value: escapeHTML(upcomingNotice),
          tone: "warning"
        }
      ]),
      actions: (isLockedStage || isDevotional) ? "" : renderPlanCardActions([
        { kind: "primary", icon: "bookOpen", label: "自己加入", action: "solo-join" },
        { kind: "secondary", icon: "people", label: "建立團隊", action: "team-create" }
      ])
    });

    const openDetails = () => {
      if (isDevotional) {
        if (typeof window.previewDevotionalPlanAsMember === "function") {
          window.previewDevotionalPlanAsMember(plan.globalPlanId || plan.id);
        }
        return;
      }
      if (isLockedStage) {
        openPlanDetailsDialog(plan);
        return;
      }
      openPlanDetailsDialog(plan, { onJoin: async () => {
        await confirmPlanJoin({
          plan,
          mode: "solo",
          onConfirm: async () => {
            await joinPlanSoloFromCard(plan, key);
          }
        });
      }});
    };

    card.onclick = event => {
      if (event.target.closest("[data-plan-card-action]")) return;
      openDetails();
    };

    card.querySelector('[data-plan-card-action="details"]')?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openDetails();
    });
    card.querySelector('[data-plan-card-action="solo-join"]')?.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      await confirmPlanJoin({
        plan,
        mode: "solo",
        onConfirm: async () => {
          await joinPlanSoloFromCard(plan, key);
        }
      });
    });
    card.querySelector('[data-plan-card-action="team-create"]')?.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      // Opening team registration is navigation only. Creating a team inside
      // that dialog is the commit point; cancelling must never join a solo plan.
      await createTeamFromPlanCard(plan, key);
    });

    container.appendChild(card);
  });

  if (typeof hydrateIcons === "function") hydrateIcons(container);
}

function isChapterReadForRound(ch, round) {
  if (!ch) return false;
  const chRound = ch.round || 1;
  if (chRound < round) return true;
  if (chRound > round) return false;
  return Boolean(ch["isReadR" + round] || ch.isRead);
}

function isPlanDayCompletedForRound(day, round) {
  if (!day || !day.chapters || day.chapters.length === 0) return false;
  return day.chapters.every(ch => isChapterReadForRound(ch, round));
}

function countCompletedPlanDaysForRound(plan, round) {
  if (!plan || !plan.days) return 0;
  return plan.days.filter(day => isPlanDayCompletedForRound(day, round)).length;
}

function getNextReadingPlanDay(plan = state.activePlan) {
  if (!plan || !plan.days || plan.days.length === 0) return null;
  const currentRound = plan.currentRound || 1;
  const readingDays = plan.days.filter(day => Array.isArray(day.chapters) && day.chapters.length > 0);
  return readingDays.find(day => !isPlanDayCompletedForRound(day, currentRound))
    || readingDays[readingDays.length - 1]
    || plan.days[plan.days.length - 1];
}

function getExpectedPlanDayCount(plan = state.activePlan, now = new Date()) {
  if (!plan || !plan.days || plan.days.length === 0 || !plan.startDate) return 0;
  const planStart = new Date(plan.startDate);
  if (isNaN(planStart.getTime())) return 0;
  planStart.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const elapsedDays = Math.floor((today - planStart) / (1000 * 60 * 60 * 24)) + 1;
  const elapsedCalendarDays = Math.max(0, Math.min(plan.days.length, elapsedDays));
  return plan.days.slice(0, elapsedCalendarDays)
    .filter(day => Array.isArray(day.chapters) && day.chapters.length > 0)
}

function getPlanProgressStatus(plan = state.activePlan) {
  if (typeof getPlanProgressStatusFromDesignSystem === "function") {
    return getPlanProgressStatusFromDesignSystem(plan);
  }
  return { label: "進度一致", badgeClass: "stat-badge--brand", diff: 0 };
}

function renderHorizontalDateStrip() {
  const container = document.getElementById("plan-date-carousel");
  if (!container || !state.activePlan) return;

  if (!state.selectedPlanDay) {
    const nextReadingDay = getNextReadingPlanDay(state.activePlan);
    state.selectedPlanDay = nextReadingDay ? nextReadingDay.dayNum : 1;
  }

  const oldScrollContainer = container.querySelector(".calendar-scroll-container");
  const savedScrollTop = oldScrollContainer ? oldScrollContainer.scrollTop : null;

  container.innerHTML = "";

  // 1. Calculate active plan start/end dates
  let planStartDate = null;
  let planEndDate = null;

  if (state.activePlan.startDate) {
    planStartDate = new Date(state.activePlan.startDate);
  }
  if (state.activePlan.endDate) {
    planEndDate = new Date(state.activePlan.endDate);
  }

  // Fallback to first/last day of plan if start/end dates are not explicitly set or invalid
  if (!planStartDate || isNaN(planStartDate.getTime())) {
    const firstDay = state.activePlan.days[0];
    if (firstDay) {
      const parts = firstDay.date.split('/');
      planStartDate = new Date(Number(firstDay.year), Number(firstDay.month) - 1, Number(parts[1] || 1));
    } else {
      planStartDate = new Date();
    }
  }

  if (!planEndDate || isNaN(planEndDate.getTime())) {
    const lastDay = state.activePlan.days[state.activePlan.days.length - 1];
    if (lastDay) {
      const parts = lastDay.date.split('/');
      planEndDate = new Date(Number(lastDay.year), Number(lastDay.month) - 1, Number(parts[1] || 28));
    } else {
      planEndDate = new Date();
    }
  }

  // 2. Define Sliding Window boundaries: start - 2 weeks (backtrack to Sunday), end + 3 weeks (forward to Saturday)
  const startBase = new Date(planStartDate);
  startBase.setDate(startBase.getDate() - 14);
  const startDayOfWeek = startBase.getDay();
  const windowStart = new Date(startBase);
  windowStart.setDate(startBase.getDate() - startDayOfWeek);

  const endBase = new Date(planEndDate);
  endBase.setDate(endBase.getDate() + 21);
  const endDayOfWeek = endBase.getDay();
  const windowEnd = new Date(endBase);
  windowEnd.setDate(endBase.getDate() + (6 - endDayOfWeek));

  // 3. Create the Calendar Wrapper (scoped under .plan-calendar for square-cell styling)
  const calendarWrapper = document.createElement("div");
  calendarWrapper.className = "calendar-component plan-calendar";

  // 4. Create Global Static Weekday Header (outside the scroll container)
  const weekdaysDiv = document.createElement("div");
  weekdaysDiv.className = "calendar-weekdays";
  const weekdays = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
  weekdays.forEach(w => {
    const wDiv = document.createElement("div");
    wDiv.textContent = w;
    weekdaysDiv.appendChild(wDiv);
  });
  calendarWrapper.appendChild(weekdaysDiv);

  // 5. Create the Scroll Container (visible area is capped to five calendar rows)
  const scrollContainer = document.createElement("div");
  scrollContainer.className = "calendar-scroll-container scrollbar-none";

  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();

  // Find a plan day by exact date
  const findPlanDay = (year, month, dayOfMonth) => {
    return state.activePlan.days.find(d => {
      if (Number(d.year) !== Number(year) || Number(d.month) !== Number(month)) return false;
      const parts = d.date.split('/');
      return parts.length === 2 && Number(parts[1]) === Number(dayOfMonth);
    });
  };

  // 6. Generate single flat continuous array of dates within the sliding window
  let cells = [];
  let curr = new Date(windowStart);
  while (curr <= windowEnd) {
    cells.push({
      year: curr.getFullYear(),
      month: curr.getMonth() + 1,
      dayOfMonth: curr.getDate()
    });
    curr.setDate(curr.getDate() + 1);
  }

  // Month Grid Container (Seamless single grid, no month banners/dividers)
  const gridDiv = document.createElement("div");
  gridDiv.className = "calendar-grid";

  // Render cells flatly
  cells.forEach(cell => {
    const isToday = cell.year === todayYear && cell.month === todayMonth && cell.dayOfMonth === todayDay;
    const numberLabel = cell.dayOfMonth === 1 ? `${cell.month}/${cell.dayOfMonth}` : `${cell.dayOfMonth}`;
    const day = findPlanDay(cell.year, cell.month, cell.dayOfMonth);

    if (day) {
      const dayCell = document.createElement("button");
      dayCell.type = "button";
      dayCell.className = "plan-day-cell";
      dayCell.innerHTML = `<span class="day-number">${numberLabel}</span>`;
      dayCell.setAttribute("data-day-num", day.dayNum);
      dayCell.setAttribute("aria-selected", day.dayNum === state.selectedPlanDay ? "true" : "false");
      if (isToday) {
        dayCell.setAttribute("aria-current", "date");
      }

      const totalChapters = day.chapters ? day.chapters.length : 0;
      let completedChapters = 0;

      if (totalChapters > 0) {
        day.chapters.forEach(ch => {
          const currentRound = state.activePlan.currentRound || 1;
          const taskRound = ch.round || currentRound;
          const isRead = Boolean(ch["isReadR" + taskRound] || ch.isRead);

          if (isRead) completedChapters++;
        });
      }

      const isDayCompleted = totalChapters > 0 && completedChapters === totalChapters;
      const isPartiallyCompleted = totalChapters > 0 && completedChapters > 0 && completedChapters < totalChapters;

      const isPast = cell.year < todayYear ||
        (cell.year === todayYear && cell.month < todayMonth) ||
        (cell.year === todayYear && cell.month === todayMonth && cell.dayOfMonth < todayDay);

      // Selected active focus highlight
      if (day.dayNum === state.selectedPlanDay) {
        dayCell.classList.add("active");
      }

      if (isToday) {
        dayCell.classList.add("today");
      }

      if (isDayCompleted) {
        dayCell.classList.add("completed");
      }

      if (isPast && !isDayCompleted && totalChapters > 0) {
        dayCell.classList.add("past-unread");
      }

      if (isPartiallyCompleted) {
        const progressContainer = document.createElement("div");
        progressContainer.className = "micro-progress-container";
        const progressBar = document.createElement("div");
        progressBar.className = "micro-progress-bar";
        progressBar.style.width = `${(completedChapters / totalChapters) * 100}%`;
        progressContainer.appendChild(progressBar);
        dayCell.appendChild(progressContainer);
      }

      // Status dot indicator
      if (!isToday) {
        const dot = document.createElement("div");
        dot.className = "day-status-dot";
        if (isDayCompleted) {
          dot.classList.add("dot-completed");
        } else if (isPast && totalChapters > 0) {
          dot.classList.add("dot-behind");
        } else {
          dot.classList.add("dot-grey");
        }
        dayCell.appendChild(dot);
      }

      // Click handler with race condition cancellation
      dayCell.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (window._dateSwitchAbortController) {
          window._dateSwitchAbortController.abort();
        }
        window._dateSwitchAbortController = new AbortController();
        const signal = window._dateSwitchAbortController.signal;

        state.selectedPlanDay = day.dayNum;

        // 1. Pure front-end high-speed active class switching
        const prevSelected = container.querySelector('.plan-day-cell.active');
        if (prevSelected) {
          prevSelected.classList.remove('active');
          prevSelected.setAttribute('aria-selected', 'false');
        }
        dayCell.classList.add('active');
        dayCell.setAttribute('aria-selected', 'true');

        // 2. Refresh bottom task list without redrawing the calendar strip
        renderPlanScheduleTracker(true, signal);
      });

      gridDiv.appendChild(dayCell);
    } else {
      const dayCell = document.createElement("span");
      dayCell.className = "plan-day-cell plan-day-cell--muted other-month";
      dayCell.setAttribute("aria-hidden", "true");
      dayCell.innerHTML = `<span class="day-number">${numberLabel}</span>`;

      if (isToday) {
        dayCell.classList.add("today");
      } else {
        const dot = document.createElement("div");
        dot.className = "day-status-dot dot-grey";
        dayCell.appendChild(dot);
      }

      gridDiv.appendChild(dayCell);
    }
  });



  scrollContainer.appendChild(gridDiv);
  calendarWrapper.appendChild(scrollContainer);
  container.appendChild(calendarWrapper);

  const applyCalendarMaxRows = () => {
    const firstCell = gridDiv.querySelector(".plan-day-cell");
    if (!firstCell) return;

    const gridStyles = getComputedStyle(gridDiv);
    const rowGap = parseFloat(gridStyles.rowGap) || 0;
    const paddingTop = parseFloat(gridStyles.paddingTop) || 0;
    const paddingBottom = parseFloat(gridStyles.paddingBottom) || 0;
    const rowHeight = firstCell.getBoundingClientRect().height;

    if (rowHeight > 0) {
      const visibleRows = 5;
      const maxHeight = (rowHeight * visibleRows) + (rowGap * (visibleRows - 1)) + paddingTop + paddingBottom;
      scrollContainer.style.maxHeight = Math.ceil(maxHeight) + "px";
    }
  };

  applyCalendarMaxRows();

  if (savedScrollTop !== null) {
    scrollContainer.scrollTop = savedScrollTop;
  } else {
    // 首次載入或切換計畫時，自動將選取的天數滾動到可見區域（無縫定位，不造成全網頁大跳）
    const scrollToActiveCell = () => {
      const activeCell = gridDiv.querySelector(`.plan-day-cell[data-day-num="${state.selectedPlanDay}"]`);
      if (activeCell) {
        const containerHeight = scrollContainer.clientHeight;
        const cellTop = activeCell.offsetTop;
        const cellHeight = activeCell.offsetHeight;
        if (containerHeight > 0) {
          scrollContainer.scrollTop = cellTop - (containerHeight / 2) + (cellHeight / 2);
        }
      }
    };
    requestAnimationFrame(scrollToActiveCell);
  }

  requestAnimationFrame(applyCalendarMaxRows);

  if (container._calendarResizeCleanup) {
    container._calendarResizeCleanup();
  }
  const resizeObserver = new ResizeObserver(applyCalendarMaxRows);
  resizeObserver.observe(gridDiv);
  container._calendarResizeCleanup = () => resizeObserver.disconnect();

  // 🛡️ scrollIntoView 已物理刪除：
  // 禁止在此處用 scrollIntoView/scrollTo 做自動捲動，
  // 這是點擊日期格造成整頁大跳的根本元凶。
  // 日曆的垂直捲動位置由使用者手勢完全自主控制。
}

function renderPlanProgressUpgradeOverlay(plan = state.activePlan) {
  if (!plan || window.currentPlanViewState !== PLAN_ROUTE.DETAIL) return;

  const availability = getPlanUpgradeAvailability(plan, { expired: isPlanExpired(plan) });
  const existing = document.getElementById("congrats-modal");
  if (!availability.eligible) {
    if (!planUpgradeInFlight && existing?.dataset.planUpgradePrompt === "true") existing.remove();
    return;
  }
  if (Number(plan.upgradeOverlayDismissedRound || 0) === availability.currentRound) return;

  const planKey = String(plan.id || plan.globalPlanId || plan.presetKey || plan.name || "plan");
  if (existing &&
      existing.dataset.planUpgradePrompt === "true" &&
      existing.dataset.planKey === planKey &&
      Number(existing.dataset.planRound) === availability.currentRound) return;

  showCongratsModal(plan, availability.currentRound);
}

async function renderPlanScheduleTracker(skipCarouselUpdate = false, signal = null) {

  const container = document.getElementById("plan-tasks-list");
  if (!container || !state.activePlan) return;
  hideDailyQuizSection();

  if (!state.inlineReader?.active) {
    container.classList.remove("hidden");
    const carousel = document.getElementById("plan-date-carousel");
    const planDayHeader = document.getElementById("plan-day-subtitle") ? document.getElementById("plan-day-subtitle").parentElement : null;
    const readBtn = document.getElementById("plan-start-reading-container");
    const inlineReader = document.getElementById("plan-inline-reader");
    if (carousel) carousel.classList.remove("hidden");
    if (planDayHeader) planDayHeader.classList.remove("hidden");
    if (readBtn) readBtn.classList.remove("hidden");
    if (inlineReader) inlineReader.classList.add("hidden");
    document.body.classList.remove("plan-inline-reader-open");
  }

  renderPlanProgressUpgradeOverlay(state.activePlan);

  const currentRequestId = ++lastTrackerRequestId;

  container.innerHTML = "";

  // Set default selected day if not set or invalid for current plan
  let selectedDay = Array.isArray(state.activePlan.days)
    ? state.activePlan.days.find(d => d && d.dayNum === state.selectedPlanDay)
    : null;

  if (!selectedDay && Array.isArray(state.activePlan.days) && state.activePlan.days.length > 0) {
    const nextReadingDay = getNextReadingPlanDay(state.activePlan);
    state.selectedPlanDay = nextReadingDay ? nextReadingDay.dayNum : state.activePlan.days[0].dayNum;
    selectedDay = state.activePlan.days.find(d => d.dayNum === state.selectedPlanDay) || state.activePlan.days[0];
  }

  if (!selectedDay) {
    container.innerHTML = "";
    hideDailyQuizSection();
    return;
  }
  const currentRound = Number(state.activePlan.currentRound || 1);
  const visibleChapters = (selectedDay.chapters || []).filter(ch =>
    Number(ch.round || currentRound) === currentRound
  );

  // Render day subtitle
  const daySubtitle = document.getElementById("plan-day-subtitle");
  const currentViewDay = document.getElementById("current-view-day");
  const currentViewDate = document.getElementById("current-view-date");

  const year = selectedDay.year || new Date().getFullYear();
  const month = selectedDay.month || (new Date().getMonth() + 1);
  const dayOfMonth = selectedDay.date ? selectedDay.date.split('/')[1] : new Date().getDate();
  const displayDayNumber = isPlanStarted(state.activePlan) ? state.selectedPlanDay : 0;
  const formattedDayText = "第 " + displayDayNumber + " 天";
  const formattedDateText = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;

  if (daySubtitle) {
    daySubtitle.textContent = `${formattedDayText} (${year}年${month}月${dayOfMonth}日)`;
  }
  if (currentViewDay) {
    currentViewDay.textContent = formattedDayText;
  }
  if (currentViewDate) {
    currentViewDate.textContent = formattedDateText;
  }

  // Check checkPlanSchedule
  await checkPlanSchedule(state.activePlan);

  // Validate abort signal
  if (signal && signal.aborted) {
    return;
  }
  // Validate request pointer after asynchronous block to prevent race condition overrides
  if (currentRequestId !== lastTrackerRequestId) {
    return;
  }

  const isAdmin = state.currentUser && getUserRoleCode(state.currentUser) === 'admin';
  const started = isPlanStarted(state.activePlan) || isAdmin;

  // Render status pill for day
  const statusPill = document.getElementById("plan-day-status-pill");
  if (statusPill) {
    if (!visibleChapters || visibleChapters.length === 0) {
      statusPill.textContent = (window.APP_COPY && window.APP_COPY.plan.restDayPill) || "休息日";
      statusPill.className = "stat-badge stat-badge--brand";
    } else {
      const allDone = visibleChapters.every(ch => {
        const currentRound = state.activePlan.currentRound || 1;
        const taskRound = ch.round || currentRound;
        return Boolean(ch["isReadR" + taskRound] || ch.isRead);
      });
      if (allDone) {
        statusPill.textContent = "已完成";
        statusPill.className = "stat-badge stat-badge--success";
      } else {
        statusPill.textContent = "進行中";
        statusPill.className = "stat-badge stat-badge--warning";
      }
    }
  }

  // Update completion check on the active date card in the calendar dynamically
  const activeCard = document.querySelector(`.plan-day-cell[data-day-num="${state.selectedPlanDay}"]`);
  if (activeCard && state.activePlan) {
    const isDayCompleted = visibleChapters && visibleChapters.length > 0 && visibleChapters.every(ch => {
      const currentRound = state.activePlan.currentRound || 1;
      const taskRound = ch.round || currentRound;
      return Boolean(ch["isReadR" + taskRound] || ch.isRead);
    });

    if (isDayCompleted) {
      activeCard.classList.add("completed");
      const progressContainer = activeCard.querySelector('.micro-progress-container');
      if (progressContainer) progressContainer.remove();
    } else {
      activeCard.classList.remove("completed");
      const totalCh = visibleChapters.length;
      let completedCh = 0;
      visibleChapters.forEach(ch => {
        const currentRound = state.activePlan.currentRound || 1;
        const taskRound = ch.round || currentRound;
        const isRead = Boolean(ch["isReadR" + taskRound] || ch.isRead);
        if (isRead) completedCh++;
      });

      let progressContainer = activeCard.querySelector('.micro-progress-container');
      if (completedCh > 0 && completedCh < totalCh) {
        if (!progressContainer) {
          progressContainer = document.createElement("div");
          progressContainer.className = "micro-progress-container";
          const progressBar = document.createElement("div");
          progressBar.className = "micro-progress-bar";
          progressContainer.appendChild(progressBar);
          activeCard.appendChild(progressContainer);
        }
        progressContainer.querySelector('.micro-progress-bar').style.width = `${(completedCh / totalCh) * 100}%`;
      } else {
        if (progressContainer) progressContainer.remove();
      }
    }
  }

  // Render items
  if (!visibleChapters || visibleChapters.length === 0) {
    // 區分「這一天真的是休息日」與「整個計畫排程壞了（每一天都空）」——後者不能
    // 用休息日文案蓋過去，否則跟正常休息日分不出來（桃園延後梯次事故）。
    const planDays = Array.isArray(state.activePlan && state.activePlan.days) ? state.activePlan.days : [];
    const scheduleIsBroken = planDays.length > 0
      && !planDays.some(day => Array.isArray(day.chapters) && day.chapters.length > 0);
    if (scheduleIsBroken) {
      console.error(
        `[plan] 計畫「${state.activePlan.name}」(${state.activePlan.id}) 每一天都沒有章節，排程尚未就緒。`
      );
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; background: var(--bg-card); border: 1px dashed var(--border-card); border-radius: 14px; color: var(--text-secondary); font-weight: 500; width: 100%;">
          此計畫的每日進度尚未就緒，請聯絡教會同工。
        </div>
      `;
    } else {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; background: var(--bg-card); border: 1px dashed var(--border-card); border-radius: 14px; color: var(--text-secondary); font-weight: 500; width: 100%;">
          ${(window.APP_COPY && window.APP_COPY.plan.restDayBanner) || "今天是補讀或靈修休息日，好好親近神吧"}
        </div>
      `;
    }
    hideDailyQuizSection();
    return;
  }

  visibleChapters.forEach(ch => {

    const taskItem = document.createElement("div");
    taskItem.className = "plan-task-item";

    const taskRound = ch.round || currentRound;
    const { cssClass, content } = getChapterCheckboxState(ch, taskRound);
    const roundLabelHtml = taskRound >= 2
      ? `<span class="task-round-label round-${taskRound}">第${taskRound}遍</span>`
      : "";

    const isCurrentRead = Boolean(ch["isReadR" + taskRound] || ch.isRead);
    taskItem.innerHTML = `
      <button type="button"
              class="task-read-toggle"
              data-is-current-read="${isCurrentRead ? 'true' : 'false'}"
              aria-pressed="${isCurrentRead ? 'true' : 'false'}"
              aria-label="${ch.book} ${ch.chapter}章，${isCurrentRead ? '取消已讀' : '標記已讀'}">
        <span class="task-checkbox ${cssClass}" aria-hidden="true">
          ${content}
        </span>
      </button>
      <button type="button" class="task-open-button" aria-label="閱讀 ${ch.book} ${ch.chapter}章">
        <span class="task-title">
          ${ch.book} ${ch.chapter}章
        </span>
        ${roundLabelHtml}
        <span class="task-arrow" aria-hidden="true">
          ${typeof renderIcon === "function" ? renderIcon("chevronRight", { size: "sm", className: "nlc-icon" }) : ""}
        </span>
      </button>
    `;

    const readToggle = taskItem.querySelector(".task-read-toggle");
    const openButton = taskItem.querySelector(".task-open-button");
    const openChapter = () => window.openPlanChapterInReader(ch.book, ch.chapter, state.selectedPlanDay, taskRound);

    readToggle.addEventListener("click", event => {
      event.stopPropagation();
      if (readToggle.dataset.pending === "true") return;
      readToggle.dataset.pending = "true";
      window.toggleYouVersionChapter(readToggle, ch.book, ch.chapter, taskRound);
      window.setTimeout(() => {
        delete readToggle.dataset.pending;
      }, 450);
    });
    openButton.addEventListener("click", openChapter);
    container.appendChild(taskItem);
  });
  void renderDailyQuizSection(state.activePlan, selectedDay, currentRequestId);

  // 停在「本遍最後一個閱讀日」且已勾完、卻還沒 100% → 提醒前面有漏（本 session 一遍只跳一次）
  maybePromptMissedRoundChapters(state.activePlan);
  // 常駐「進入下一遍」按鈕（可重複手動觸發檢查）
  renderRoundAdvanceButton(state.activePlan, selectedDay);
}

let dailyQuizRenderRequestId = 0;
let dailyQuizFeatureRequest = null;

async function isDailyQuizFeatureEnabled() {
  if (typeof window.dailyQuizFeatureEnabled === "boolean") return window.dailyQuizFeatureEnabled;
  if (!dailyQuizFeatureRequest) {
    dailyQuizFeatureRequest = db.getFeatureSetting("daily_quiz", false).then(result => {
      window.dailyQuizFeatureEnabled = !result.error && result.enabled === true;
      return window.dailyQuizFeatureEnabled;
    }).catch(() => false).finally(() => { dailyQuizFeatureRequest = null; });
  }
  return dailyQuizFeatureRequest;
}

let dailyDevotionFeatureRequest = null;
async function isDailyDevotionFeatureEnabled() {
  if (typeof window.dailyDevotionFeatureEnabled === "boolean") return window.dailyDevotionFeatureEnabled;
  if (!dailyDevotionFeatureRequest) {
    dailyDevotionFeatureRequest = db.getFeatureSetting("daily_devotion", false).then(result => {
      window.dailyDevotionFeatureEnabled = !result.error && result.enabled === true;
      return window.dailyDevotionFeatureEnabled;
    }).catch(() => false).finally(() => { dailyDevotionFeatureRequest = null; });
  }
  return dailyDevotionFeatureRequest;
}
window.isDailyDevotionFeatureEnabled = isDailyDevotionFeatureEnabled;
// 每日靈修計畫是否出現在「探索計畫」清單：
//  · daily_devotion 功能開 → 所有人看得到
//  · 功能關 → 只有 admin / pastor 看得到（卡片會標「開發中・會友看不到」），一般會友完全看不到
function isDevotionalPlanVisibleToUser(plan) {
  if (!plan || (plan.planKind || plan.plan_kind) !== "devotional") return true; // 非靈修計畫不受此限
  if (window.dailyDevotionFeatureEnabled === true) return true;
  const role = typeof getUserRoleCode === "function" ? getUserRoleCode(state.currentUser) : null;
  return role === "admin" || role === "pastor";
}
window.isDevotionalPlanVisibleToUser = isDevotionalPlanVisibleToUser;
// 目前這份靈修計畫是「開發中、只有管理員看得到」的狀態嗎？
function isDevotionalPlanDevMode(plan) {
  return (plan && (plan.planKind || plan.plan_kind) === "devotional")
    && window.dailyDevotionFeatureEnabled !== true;
}
window.isDevotionalPlanDevMode = isDevotionalPlanDevMode;

// 管理員預覽：直接把某靈修計畫設為 activePlan 並切到「計畫」分頁的詳情
// （enterPlanDetailState 的 devotional 分支會渲染 renderDevotionViewer）。
function previewDevotionalPlanAsMember(globalPlanId) {
  const gp = (state.globalPlans || []).find(p => String(p.id) === String(globalPlanId)
    || String(p.globalPlanId) === String(globalPlanId));
  if (!gp) return;
  state.activePlan = gp;
  state.planDetailOpen = true;
  state.planActiveSubTab = "today";
  const onPlanTab = typeof window.appRouter !== "undefined" && window.appRouter.currentTab === "plan-view";
  if (onPlanTab && typeof setPlanState === "function") {
    setPlanState(PLAN_ROUTE.DETAIL);
  } else if (typeof window.appRouter !== "undefined" && typeof window.appRouter.switchTab === "function") {
    window.appRouter.switchTab("plan-view", { keepPlanDetail: true });
  }
}
window.previewDevotionalPlanAsMember = previewDevotionalPlanAsMember;

window.addEventListener("daily-quiz-feature-changed", event => {
  window.dailyQuizFeatureEnabled = event.detail?.enabled === true;
  if (!window.dailyQuizFeatureEnabled) {
    hideDailyQuizSection();
    return;
  }
  const selectedDay = Array.isArray(state.activePlan?.days)
    ? state.activePlan.days.find(day => day?.dayNum === state.selectedPlanDay)
    : null;
  if (state.activePlan && selectedDay) {
    void renderDailyQuizSection(state.activePlan, selectedDay, lastTrackerRequestId);
  }
});

function quizEscape(value) {
  return typeof escapeHTML === "function"
    ? escapeHTML(String(value ?? ""))
    : String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[character]);
}

function hideDailyQuizSection() {
  dailyQuizRenderRequestId += 1;
  const section = document.getElementById("daily-quiz-section");
  const content = document.getElementById("daily-quiz-content");
  if (section) section.classList.add("hidden");
  if (content) content.innerHTML = "";
}

function quizPublisherLabel(role) {
  return ({
    admin: "系統管理員",
    pastor: "牧者",
    great_zone_leader: "大區長",
    zone_leader: "區長",
    group_leader: "小組長"
  })[role] || "管理者";
}

function getDailyQuizTaiwanToday() {
  if (typeof window.getTaiwanTodayISO === "function") return window.getTaiwanTodayISO();
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date()).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDailyQuizReadingProgress(plan, quizDate) {
  const round = Number(plan?.currentRound || 1);
  const day = Array.isArray(plan?.days)
    ? plan.days.find(item => String(item?.isoDate || "") === String(quizDate || ""))
    : null;
  const chapters = Array.isArray(day?.chapters)
    ? day.chapters.filter(chapter => Number(chapter?.round || round) === round)
    : [];
  const completed = chapters.filter(chapter => Boolean(chapter?.[`isReadR${round}`] || chapter?.isRead)).length;
  return {
    total: chapters.length,
    completed,
    remaining: Math.max(0, chapters.length - completed),
    isComplete: chapters.length > 0 && completed === chapters.length
  };
}

function openDailyQuizContent(content, context, plan, quizDate) {
  if (context.myQuiz) renderAssignedDailyQuiz(content, context.myQuiz, plan, quizDate);
  else renderPublisherDailyQuiz(content, context, plan, quizDate);
  if (typeof hydrateIcons === "function") hydrateIcons(content);
}

function renderDailyQuizEntry(content, context, plan, quizDate) {
  const assignedQuiz = context.myQuiz || null;
  const isCompleted = Boolean(assignedQuiz?.attempt);
  const buttonLabel = assignedQuiz
    ? (isCompleted ? "查看測驗結果" : "進入小測驗")
    : "發佈小測驗";
  const description = assignedQuiz
    ? (isCompleted ? "今天的小測驗已完成，可查看答案與解說" : "完成今天的速讀進度後即可作答")
    : "查看已審核版本並發佈給所屬小組";

  content.innerHTML = `
    <button type="button" class="daily-quiz-entry-button" id="daily-quiz-entry-button" aria-describedby="daily-quiz-entry-description">
      <span class="daily-quiz-entry-icon" aria-hidden="true"><span class="nlc-icon" data-icon="checkOne"></span></span>
      <span class="daily-quiz-entry-copy">
        <strong>小測驗</strong>
        <small id="daily-quiz-entry-description">${description}</small>
      </span>
      <span class="daily-quiz-entry-action">${buttonLabel}<span class="nlc-icon nlc-icon--sm" data-icon="chevronRight" aria-hidden="true"></span></span>
    </button>`;

  content.querySelector("#daily-quiz-entry-button")?.addEventListener("click", () => {
    if (assignedQuiz && !isCompleted) {
      const progress = getDailyQuizReadingProgress(plan, quizDate);
      if (!progress.isComplete) {
        const message = progress.total > 0
          ? `請先閱讀完今天的速讀進度，再進入小測驗（尚有 ${progress.remaining} 章）。`
          : "請先完成今天的速讀進度，再進入小測驗。";
        if (typeof showToast === "function") showToast(message);
        return;
      }
    }
    openDailyQuizContent(content, context, plan, quizDate);
  });
}

function renderCompletedDailyQuiz(content, quiz) {
  const attempt = quiz.attempt;
  content.innerHTML = `
    <div class="daily-quiz-heading">
      <div><p class="daily-quiz-eyebrow">今日小測驗</p><h3 id="daily-quiz-title">完成作答</h3></div>
      <span class="daily-quiz-score">${Number(attempt.score || 0)}／${Number(attempt.total || 5)}</span>
    </div>
    <div class="daily-quiz-review-list">
      ${(quiz.questions || []).map((question, index) => {
        const chosen = Number((attempt.answers || [])[index]);
        const correct = Number(question.correctIndex);
        return `<article class="daily-quiz-review-item">
          <p><strong>${index + 1}. ${quizEscape(question.question)}</strong></p>
          <p class="${chosen === correct ? "daily-quiz-answer-correct" : "daily-quiz-answer-wrong"}">
            你的答案：${quizEscape((question.options || [])[chosen] || "未作答")}
          </p>
          ${chosen === correct ? "" : `<p class="daily-quiz-answer-correct">正確答案：${quizEscape((question.options || [])[correct] || "")}</p>`}
          <p class="daily-quiz-explanation">${quizEscape(question.explanation)} · ${quizEscape(question.verseRef)}</p>
        </article>`;
      }).join("")}
    </div>`;
}

function bindDailyQuizSubmission(content, quiz, plan, quizDate) {
  const form = content.querySelector("#daily-quiz-form");
  if (!form) return;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const answers = (quiz.questions || []).map((_question, index) => {
      const selected = form.querySelector(`input[name="daily-quiz-${index}"]:checked`);
      return selected ? Number(selected.value) : null;
    });
    if (answers.some(answer => answer === null)) {
      if (typeof showToast === "function") showToast(`請完成全部 ${answers.length} 題後再送出`);
      return;
    }
    const button = form.querySelector("button[type='submit']");
    if (button) button.disabled = true;
    const result = await db.submitDailyQuiz(quiz.publicationId, answers);
    if (!result.success) {
      if (button) button.disabled = false;
      if (typeof showToast === "function") showToast(result.message || "小測驗送出失敗");
      return;
    }
    if (typeof showToast === "function") showToast(`作答完成：${result.data.score}／${result.data.total}`);
    void renderDailyQuizSection(plan, { isoDate: quizDate }, lastTrackerRequestId, { open: true });
  });
}

function renderAssignedDailyQuiz(content, quiz, plan, quizDate) {
  if (quiz.attempt) {
    renderCompletedDailyQuiz(content, quiz);
    return;
  }
  content.innerHTML = `
    <div class="daily-quiz-heading">
      <div><p class="daily-quiz-eyebrow">今日小測驗</p><h3 id="daily-quiz-title">${(quiz.questions || []).length} 題選擇題</h3></div>
      <span class="daily-quiz-status">已由${quizPublisherLabel(quiz.publisherRole)}發佈</span>
    </div>
    <form id="daily-quiz-form" class="daily-quiz-form">
      ${(quiz.questions || []).map((question, questionIndex) => `
        <fieldset class="daily-quiz-question">
          <legend>${questionIndex + 1}. ${quizEscape(question.question)}</legend>
          <span class="daily-quiz-verse-ref">${quizEscape(question.verseRef)}</span>
          <div class="daily-quiz-options">
            ${(question.options || []).map((option, optionIndex) => `
              <label><input type="radio" name="daily-quiz-${questionIndex}" value="${optionIndex}"><span>${quizEscape(option)}</span></label>
            `).join("")}
          </div>
        </fieldset>
      `).join("")}
      <button type="submit" class="primary-btn daily-quiz-submit">送出答案</button>
    </form>`;
  bindDailyQuizSubmission(content, quiz, plan, quizDate);
}

function renderQuizScopeSelectorHtml(prefix) {
  return `<div class="admin-daily-quiz-scope-row" id="${prefix}-scope-row">
    <select id="${prefix}-region-select" class="form-control"></select>
    <select id="${prefix}-zone-select" class="form-control"></select>
    <select id="${prefix}-group-select" class="form-control"></select>
    <select id="${prefix}-master-select" class="hidden" style="display:none;"></select>
  </div>`;
}

function getQuizScope(prefix) {
  const readScope = id => {
    const value = document.getElementById(id)?.value || "";
    return value === "unassigned" ? "" : value;
  };
  const region = readScope(`${prefix}-region-select`);
  const zone = readScope(`${prefix}-zone-select`);
  const group = readScope(`${prefix}-group-select`);
  if (group) return { scopeType: "group", scopeName: group };
  if (zone) return { scopeType: "zone", scopeName: zone };
  if (region) return { scopeType: "region", scopeName: region.replace(/^region:/, "") };
  return { scopeType: "all", scopeName: null };
}

function renderQuizCustomQuestionBlock(index, question = {}) {
  return `<fieldset class="admin-daily-quiz-question admin-quiz-custom-question" data-question-index="${index}">
    <legend>第 ${index + 1} 題 <button type="button" class="icon-button icon-button--subtle" data-quiz-custom-remove aria-label="刪除第 ${index + 1} 題"><span class="nlc-icon" data-icon="close" aria-hidden="true"></span></button></legend>
    <label>題目<textarea class="form-control" data-field="question" rows="2">${quizEscape(question.question || "")}</textarea></label>
    <div class="admin-daily-quiz-options">
      ${[0, 1, 2, 3].map(optionIndex => `<label>選項 ${optionIndex + 1}<input class="form-control" data-option-index="${optionIndex}" value="${quizEscape((question.options || [])[optionIndex] || "")}"></label>`).join("")}
    </div>
    <div class="admin-daily-quiz-answer-row">
      <label>正確答案<select class="form-control" data-field="correctIndex">
        ${[0, 1, 2, 3].map(optionIndex => `<option value="${optionIndex}" ${Number(question.correctIndex) === optionIndex ? "selected" : ""}>選項 ${optionIndex + 1}</option>`).join("")}
      </select></label>
      <label>經文出處<input class="form-control" data-field="verseRef" value="${quizEscape(question.verseRef || "")}"></label>
    </div>
    <label>解說<textarea class="form-control" data-field="explanation" rows="2">${quizEscape(question.explanation || "")}</textarea></label>
  </fieldset>`;
}

function renderQuizCustomEditorHtml() {
  return `<div class="admin-daily-quiz-editor admin-quiz-custom-editor" data-quiz-custom-editor>
    <div class="admin-quiz-custom-questions" data-quiz-custom-questions>
      ${[0, 1].map(index => renderQuizCustomQuestionBlock(index)).join("")}
    </div>
    <div class="admin-daily-quiz-carousel-actions">
      <button type="button" class="secondary-btn" data-quiz-custom-add>新增題目</button>
    </div>
    <p class="admin-daily-quiz-note">自訂題目 2～10 題，發佈者自行負責內容，不需牧者審核，也不會出現在牧者共用審核清單。</p>
  </div>`;
}

function bindQuizCustomEditor(container, onChange) {
  const list = container.querySelector("[data-quiz-custom-questions]");
  const addBtn = container.querySelector("[data-quiz-custom-add]");
  if (!list || !addBtn || container.dataset.customBound === "true") return;
  container.dataset.customBound = "true";
  const renumber = () => {
    Array.from(list.children).forEach((block, index) => {
      block.dataset.questionIndex = String(index);
      const legend = block.querySelector("legend");
      if (legend && legend.firstChild) legend.firstChild.textContent = `第 ${index + 1} 題 `;
      const removeBtn = block.querySelector("[data-quiz-custom-remove]");
      if (removeBtn) removeBtn.disabled = list.children.length <= 2;
    });
    addBtn.disabled = list.children.length >= 10;
  };
  addBtn.addEventListener("click", () => {
    if (list.children.length >= 10) return;
    list.insertAdjacentHTML("beforeend", renderQuizCustomQuestionBlock(list.children.length));
    renumber();
    if (typeof hydrateIcons === "function") hydrateIcons(list.lastElementChild);
    if (typeof onChange === "function") onChange();
  });
  list.addEventListener("click", event => {
    const removeBtn = event.target.closest("[data-quiz-custom-remove]");
    if (!removeBtn || list.children.length <= 2) return;
    removeBtn.closest("[data-question-index]")?.remove();
    renumber();
    if (typeof onChange === "function") onChange();
  });
  list.addEventListener("input", () => { if (typeof onChange === "function") onChange(); });
  renumber();
}

function collectQuizCustomQuestions(container) {
  const list = container.querySelector("[data-quiz-custom-questions]");
  if (!list) return [];
  return Array.from(list.querySelectorAll("[data-question-index]")).map((field, index) => ({
    id: `c${index + 1}`,
    question: field.querySelector('[data-field="question"]')?.value.trim() || "",
    options: [0, 1, 2, 3].map(optionIndex => field.querySelector(`[data-option-index="${optionIndex}"]`)?.value.trim() || ""),
    correctIndex: Number(field.querySelector('[data-field="correctIndex"]')?.value || 0),
    explanation: field.querySelector('[data-field="explanation"]')?.value.trim() || "",
    verseRef: field.querySelector('[data-field="verseRef"]')?.value.trim() || ""
  }));
}

function quizCustomQuestionsAreValid(questions) {
  if (!Array.isArray(questions) || questions.length < 2 || questions.length > 10) return false;
  return questions.every(question =>
    question.question && question.verseRef && question.explanation
    && Array.isArray(question.options) && question.options.length === 4 && question.options.every(option => option)
  );
}

function renderPublisherDailyQuiz(content, context, plan, quizDate) {
  const groups = Array.isArray(context.managedGroups) ? context.managedGroups : [];
  const publishedGroups = groups.filter(group => group.publication);
  const approvedVariants = (Array.isArray(context.approvedVariants) ? context.approvedVariants : [])
    .filter(item => ["A", "B"].includes(String(item?.variant || "").toUpperCase()));
  const hasApproved = variant => approvedVariants.some(item => item.variant === variant);
  content.innerHTML = `
    <div class="daily-quiz-heading">
      <div><p class="daily-quiz-eyebrow">小測驗</p><h3 id="daily-quiz-title">今日發佈</h3></div>
      <span class="daily-quiz-status">已發佈 ${publishedGroups.length}／${groups.length} 個小組</span>
    </div>
    ${approvedVariants.length === 0
      ? '<p class="daily-quiz-publisher-notice">今日 AI 題目尚未完成審核，審核通過後會顯示可發佈版本；你也可以直接用自訂題目發佈。</p>'
      : ""}
    <div class="admin-quiz-publish-step">
      <p class="admin-quiz-publish-step-label">1. 發佈範圍</p>
      ${renderQuizScopeSelectorHtml("plan-quiz-publish")}
    </div>
    <div class="admin-quiz-publish-step">
      <p class="admin-quiz-publish-step-label">2. 題目版本</p>
      <div class="admin-quiz-version-choice" role="radiogroup" aria-label="題目版本">
        <button type="button" class="secondary-btn admin-quiz-version-btn" data-quiz-version-choice="A" ${hasApproved("A") ? "" : "disabled"}>版本 A</button>
        <button type="button" class="secondary-btn admin-quiz-version-btn" data-quiz-version-choice="B" ${hasApproved("B") ? "" : "disabled"}>版本 B</button>
        <button type="button" class="secondary-btn admin-quiz-version-btn" data-quiz-version-choice="C">自訂題目</button>
      </div>
      <div class="admin-quiz-custom-editor-slot hidden" data-quiz-custom-slot></div>
    </div>
    <button type="button" id="daily-quiz-publish-btn" class="primary-btn daily-quiz-publish" disabled>發佈小測驗</button>`;

  setupCascadingSelectors("plan-quiz-publish-region-select", "plan-quiz-publish-zone-select", "plan-quiz-publish-group-select", "plan-quiz-publish-master-select");

  let selectedVersion = null;
  const versionButtons = Array.from(content.querySelectorAll("[data-quiz-version-choice]"));
  const customSlot = content.querySelector("[data-quiz-custom-slot]");
  const publishBtn = content.querySelector("#daily-quiz-publish-btn");

  const refresh = () => {
    if (!publishBtn) return;
    let ready = false;
    if (selectedVersion === "A" || selectedVersion === "B") {
      ready = hasApproved(selectedVersion);
    } else if (selectedVersion === "C") {
      ready = customSlot ? quizCustomQuestionsAreValid(collectQuizCustomQuestions(customSlot)) : false;
    }
    publishBtn.disabled = !ready;
  };

  ["region", "zone", "group"].forEach(part => {
    content.querySelector(`#plan-quiz-publish-${part}-select`)?.addEventListener("change", refresh);
  });

  versionButtons.forEach(button => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      selectedVersion = button.dataset.quizVersionChoice;
      versionButtons.forEach(other => other.classList.toggle("active", other === button));
      if (selectedVersion === "C") {
        if (!customSlot.dataset.rendered) {
          customSlot.innerHTML = renderQuizCustomEditorHtml();
          customSlot.dataset.rendered = "true";
          bindQuizCustomEditor(customSlot, refresh);
          if (typeof hydrateIcons === "function") hydrateIcons(customSlot);
        }
        customSlot.classList.remove("hidden");
      } else {
        customSlot.classList.add("hidden");
      }
      refresh();
    });
  });

  publishBtn?.addEventListener("click", async () => {
    if (!selectedVersion) return;
    const scope = getQuizScope("plan-quiz-publish");
    const scopeLabel = scope.scopeType === "all" ? "你負責的全部小組" : scope.scopeName;
    let selection;
    if (selectedVersion === "C") {
      const questions = collectQuizCustomQuestions(customSlot);
      if (!quizCustomQuestionsAreValid(questions)) {
        if (typeof showToast === "function") showToast("自訂題目需要 2 至 10 題，且每題都要填寫完整。");
        return;
      }
      selection = { customQuestions: questions };
    } else {
      selection = { variant: selectedVersion };
    }
    if (!window.confirm(`確定發佈${selectedVersion === "C" ? "自訂題目" : `版本 ${selectedVersion}`}給「${scopeLabel}」嗎？`)) return;
    publishBtn.disabled = true;
    const originalLabel = publishBtn.textContent;
    publishBtn.textContent = "發佈中…";
    const result = await db.publishDailyQuiz(plan, quizDate, scope, selection);
    if (!result.success) {
      publishBtn.disabled = false;
      publishBtn.textContent = originalLabel;
      if (typeof showToast === "function") showToast(result.message || "小測驗發佈失敗");
      return;
    }
    if (typeof showToast === "function") showToast(`已發佈給 ${result.data.publishedCount} 個小組`);
    if (typeof window.refreshCareReminderBadge === "function") void window.refreshCareReminderBadge({ force: true });
    void renderDailyQuizSection(plan, { isoDate: quizDate }, lastTrackerRequestId, { open: true });
  });
}

async function renderDailyQuizSection(plan, selectedDay, trackerRequestId, options = {}) {
  const section = document.getElementById("daily-quiz-section");
  const content = document.getElementById("daily-quiz-content");
  if (!section || !content || !plan || !selectedDay) return;
  if (!await isDailyQuizFeatureEnabled()) {
    hideDailyQuizSection();
    return;
  }
  const quizDate = String(selectedDay.isoDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quizDate)
    || quizDate !== getDailyQuizTaiwanToday()
    || typeof db === "undefined"
    || typeof db._quizPlanId !== "function"
    || !db._quizPlanId(plan)) {
    hideDailyQuizSection();
    return;
  }

  const requestId = ++dailyQuizRenderRequestId;
  const result = await db.getDailyQuizDashboard(plan, quizDate);
  if (requestId !== dailyQuizRenderRequestId || trackerRequestId !== lastTrackerRequestId) return;
  if (!result.success) {
    hideDailyQuizSection();
    return;
  }
  const context = result.context || {};
  if (!context.myQuiz && !context.canPublish) {
    hideDailyQuizSection();
    return;
  }

  section.classList.remove("hidden");
  if (options.open === true) {
    if (context.myQuiz && !context.myQuiz.attempt) {
      const progress = getDailyQuizReadingProgress(plan, quizDate);
      if (!progress.isComplete) {
        renderDailyQuizEntry(content, context, plan, quizDate);
        return;
      }
    }
    openDailyQuizContent(content, context, plan, quizDate);
  } else {
    renderDailyQuizEntry(content, context, plan, quizDate);
  }
  if (typeof hydrateIcons === "function") hydrateIcons(section);
}

function getChapterCheckboxState(ch, currentRound) {
  const ICON_R1 = typeof renderIcon === "function" ? renderIcon("check", { size: "sm", className: "nlc-icon" }) : "";
  const ICON_R2 = typeof renderIcon === "function" ? renderIcon("zap", { size: "sm", className: "nlc-icon" }) : "";
  const ICON_R3 = typeof renderIcon === "function" ? renderIcon("star", { size: "sm", className: "nlc-icon" }) : "";
  const ICON_RX = typeof renderIcon === "function" ? renderIcon("trendingUp", { size: "sm", className: "nlc-icon" }) : "";

  if (currentRound === 1) {
    return ch.isReadR1 ? { cssClass: 'checked', content: ICON_R1 } : { cssClass: '', content: '' };
  }

  if (currentRound === 2) {
    return ch.isReadR2 ? { cssClass: 'checked round-2', content: ICON_R2 } : { cssClass: '', content: '' };
  }

  if (currentRound === 3) {
    return ch.isReadR3 ? { cssClass: 'checked round-3', content: ICON_R3 } : { cssClass: '', content: '' };
  }

  if (currentRound >= 4) {
    const isRead = Boolean(ch["isReadR" + currentRound] || ch.isRead);
    return isRead ? { cssClass: 'checked round-3', content: ICON_RX } : { cssClass: '', content: '' };
  }

  return { cssClass: '', content: '' };
}

function getRoundBadge(ch, currentRound) {
  if (currentRound >= 2) {
    const prevRound = currentRound - 1;
    const prevCompleted = Boolean(ch["isReadR" + prevRound]);
    const currCompleted = Boolean(ch["isReadR" + currentRound]);
    if (prevCompleted && !currCompleted) {
      if (currentRound === 2) return '✓第1遍';
      if (currentRound === 3) return '✓✓已讀';
      return `✓第${prevRound}遍`;
    }
  }
  return '';
}

window.toggleYouVersionChapter = function (checkboxEl, book, chapter, taskRound = null) {

  const isCurrentlyRead = checkboxEl.dataset.isCurrentRead === 'true';
  const willBeChecked = !isCurrentlyRead;
  const currentRound = taskRound || (state.activePlan ? (state.activePlan.currentRound || 1) : 1);

  // 未發布或尚未到開始日的階段只能預覽；允許取消先前誤記的已讀。
  if (willBeChecked && isPlanProgressLocked(state.activePlan, { hidden: window.isPlanHidden?.(state.activePlan) })) {
    showToast("此階段尚未正式開放，目前僅供預覽，無法記錄已讀。");
    if (checkboxEl) checkboxEl.checked = isCurrentlyRead;
    return;
  }

  // 💡 關鍵修復：唯讀歷史鎖定，防止誤觸修改已完成遍數的打卡紀錄
  if (state.activePlan && currentRound < (state.activePlan.currentRound || 1)) {
    showToast("此遍進度已完成存檔，無法修改以前的打卡紀錄。");
    if (checkboxEl) {
      checkboxEl.checked = isCurrentlyRead;
    }
    return;
  }

  if (state.activePlan && isPlanExpired(state.activePlan)) {
    showToast("此計畫已過期，無法再修改打卡紀錄。");
    if (checkboxEl) {
      checkboxEl.checked = isCurrentlyRead;
    }
    return;
  }

  if (state.offlineMode) {
    showToast("離線閱讀模式無法記錄進度，恢復連線後再試");
    if (checkboxEl) {
      checkboxEl.checked = isCurrentlyRead;
    }
    return;
  }

  if (checkboxEl) {
    checkboxEl.setAttribute("aria-pressed", String(willBeChecked));
    checkboxEl.setAttribute("aria-label", `${book} ${chapter}章，${willBeChecked ? "取消已讀" : "標記已讀"}`);
  }
  const selectedDay = state.activePlan && state.activePlan.days
    ? state.activePlan.days.find(d => d.dayNum === state.selectedPlanDay)
    : null;
  const chapterObj = selectedDay && selectedDay.chapters
    ? selectedDay.chapters.find(ch => ch.book === book && Number(ch.chapter) === Number(chapter) && (ch.round || currentRound) === currentRound)
    : null;

  const applyLocalReadState = (ch, checked) => {
    if (!ch) return;
    ch["isReadR" + currentRound] = checked;
    ch.isRead = checked;
  };

  const updateLocalReadingLogs = (book, chapter, round, checked) => {
    if (!state.readingLogs) state.readingLogs = [];
    if (checked) {
      const exists = state.readingLogs.some(l =>
        l.book === book &&
        Number(l.chapter) === Number(chapter) &&
        Number(l.round || 1) === Number(round) &&
        (l.plan_id === (state.activePlan ? state.activePlan.id : null) ||
          l.presetKey === (state.activePlan ? state.activePlan.presetKey : null))
      );
      if (!exists) {
        state.readingLogs.push({
          book: book,
          chapter: Number(chapter),
          round: Number(round),
          plan_id: state.activePlan ? state.activePlan.id : null,
          presetKey: state.activePlan ? state.activePlan.presetKey : null,
          preset_key: state.activePlan ? state.activePlan.presetKey : null,
          read_at: new Date().toISOString()
        });
      }
    } else {
      state.readingLogs = state.readingLogs.filter(l => !(
        l.book === book &&
        Number(l.chapter) === Number(chapter) &&
        Number(l.round || 1) === Number(round) &&
        ((state.activePlan && l.plan_id && l.plan_id === state.activePlan.id) ||
          (state.activePlan && l.presetKey && l.presetKey === state.activePlan.presetKey) ||
          (!state.activePlan && !l.plan_id && !l.presetKey) ||
          ((l.plan_id === null || l.plan_id === undefined) && (l.presetKey === null || l.presetKey === undefined)))
      ));
    }
  };

  // 1. 💡 立即在本機更新記憶體狀態與 UI 渲染（完全零延遲）
  updateLocalReadingLogs(book, chapter, currentRound, willBeChecked);
  applyLocalReadState(chapterObj, willBeChecked);
  calculatePlanProgress();

  // Set dataVersion to optimistically propagate changes to all listening views via CustomEvent
  window.setDataVersion(prev => prev + 1);

  // ── Cross-tab data sync: notify all loaded modules via unified event bus ──
  // Using an event prevents direct dependency on functions that may not be loaded yet.
  window.dispatchEvent(new CustomEvent("app:dataRefresh", { detail: { scope: "plan" } }));

  // 2. 💡 在背景非同步向 Supabase 發送寫入請求，不要阻塞使用者操作
  db.logChapterRead(book, chapter, willBeChecked, currentRound)
    .then(async () => {
      db.saveLocalUserStats();
      if (state.activePlan) {
        const plan = state.activePlan;
        calculatePlanProgress();
        if (plan.progress >= 100) {
          await handleRoundCompletion(plan);
        }
        if (willBeChecked && typeof window.checkAndPromptTodayCompletion === "function") {
          await window.checkAndPromptTodayCompletion();
        }
      }
    })
    .catch(error => {
      console.error("Failed to update reading progress in background", error);
      // 💡 同步失敗時，自動還原打勾狀態並提示使用者
      updateLocalReadingLogs(book, chapter, currentRound, isCurrentlyRead);
      applyLocalReadState(chapterObj, isCurrentlyRead);
      calculatePlanProgress();
      renderPlanScheduleTracker(true);
      showToast((window.APP_COPY && window.APP_COPY.plan.syncFail) || "進度沒同步成功，等一下再試試");
      // ── Re-sync dashboard after rollback via event bus ──
      window.dispatchEvent(new CustomEvent("app:dataRefresh", { detail: { scope: "plan" } }));
    });
};

function readChapterDirect(bookName, chapter) {
  const book = BIBLE_BOOKS.find(b => b.name === bookName);
  if (book) {
    state.readerState.bookId = book.id;
    state.readerState.chapter = chapter;

    document.getElementById("reader-testament-select").value = "all";
    populateBookSelector("all");
    populateChapterSelector();
    saveReaderPreferences();

    appRouter.switchTab("reader-view");
  }
}

function updatePlanCheckboxState(key, isChecked) {
  // Safe empty fallback since we redraw tasks on update
  if (state.activePlan) {
    renderPlanScheduleTracker();
  }
}

async function checkPlanSchedule(plan) {
  // Since manual settings and downgrades are removed, and levels only go up automatically,
  // we do not perform lag/lead checks or automatic downgrades.
  return;
}

function showCongratsModal(plan, round) {
  const availability = getPlanUpgradeAvailability(plan, { expired: isPlanExpired(plan) });
  if (!availability.eligible || availability.currentRound !== Number(round)) return;

  const oldModal = document.getElementById("congrats-modal");
  if (oldModal) oldModal.remove();

  const modal = document.createElement("div");
  modal.id = "congrats-modal";
  modal.className = "congrats-modal-overlay plan-upgrade-gate";
  modal.dataset.planUpgradePrompt = "true";
  modal.dataset.planKey = String(plan.id || plan.globalPlanId || plan.presetKey || plan.name || "plan");
  modal.dataset.planRound = String(availability.currentRound);
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "plan-upgrade-title");

  modal.innerHTML = `
    <div class="congrats-modal-box plan-upgrade-gate__panel">
      <span class="plan-upgrade-gate__icon" aria-hidden="true">
        <span class="nlc-icon nlc-icon--lg" data-icon="trophy"></span>
      </span>
      <p class="plan-upgrade-gate__eyebrow">${availability.currentRoundLabel}已完成</p>
      <h3 class="congrats-title" id="plan-upgrade-title">是否開始${availability.nextRoundLabel}？</h3>
      <p class="congrats-desc-secondary">確認後會先建立${availability.nextRoundLabel}的閱讀排程，完成後才回到進度頁。</p>
      <p class="plan-upgrade-gate__status" id="plan-upgrade-status" aria-live="polite"></p>
      <div class="congrats-actions">
        <button id="btn-modal-upgrade" type="button" class="congrats-upgrade-btn">開始${availability.nextRoundLabel}</button>
        <button id="btn-modal-later" type="button" class="congrats-later-btn">稍後再說</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  if (typeof hydrateIcons === "function") hydrateIcons(modal);

  modal.querySelector("#btn-modal-upgrade")?.addEventListener("click", () => window.triggerPlanUpgradeFlow());
  modal.querySelector("#btn-modal-later")?.addEventListener("click", () => {
    plan.upgradeOverlayDismissedRound = availability.currentRound;
    modal.remove();
  });
}

function setPlanUpgradeOverlayBusy(busy, nextRoundLabel = "", errorMessage = "") {
  const modal = document.getElementById("congrats-modal");
  if (!modal || modal.dataset.planUpgradePrompt !== "true") return;
  const panel = modal.querySelector(".plan-upgrade-gate__panel");
  const upgradeButton = modal.querySelector("#btn-modal-upgrade");
  const laterButton = modal.querySelector("#btn-modal-later");
  const status = modal.querySelector("#plan-upgrade-status");

  modal.classList.toggle("is-busy", busy);
  panel?.setAttribute("aria-busy", String(busy));
  if (upgradeButton) {
    upgradeButton.disabled = busy;
    upgradeButton.textContent = busy ? `正在建立${nextRoundLabel}排程…` : `開始${nextRoundLabel}`;
  }
  if (laterButton) laterButton.disabled = busy;
  if (status) {
    status.textContent = errorMessage || (busy ? `正在分配${nextRoundLabel}進度，請稍候。` : "");
    status.classList.toggle("is-error", Boolean(errorMessage));
  }
}

window.triggerPlanUpgradeFlow = async function() {
  const plan = state.activePlan;
  if (!plan) return;
  if (planUpgradeInFlight) return;

  if (isPlanExpired(plan)) {
    showToast("計畫時間已過，無法再進行升級。");
    const modal = document.getElementById("congrats-modal");
    if (modal) modal.remove();
    return;
  }

  const upgradeAvailability = getPlanUpgradeAvailability(plan, { expired: false });
  if (!upgradeAvailability.eligible) {
    showToast("完成目前這一遍後，才能開始下一遍。");
    return;
  }

  const currentRound = upgradeAvailability.currentRound;
  const nextRound = upgradeAvailability.nextRound;
  const previousPlanState = {
    currentRound: plan.currentRound,
    days: plan.days,
    totalDays: plan.totalDays,
    totalChapters: plan.totalChapters,
    currentRoundTotalChapters: plan.currentRoundTotalChapters,
    completedChapters: plan.completedChapters,
    progress: plan.progress,
    currentRoundStartedAt: plan.currentRoundStartedAt,
    lastUpgradedRound: plan.lastUpgradedRound,
    upgradePromptHandled: plan.upgradePromptHandled
  };
  planUpgradeInFlight = true;
  setPlanUpgradeOverlayBusy(true, upgradeAvailability.nextRoundLabel);

  // 記錄此類別完成的遍數，並觸發勳章解鎖檢查（cohort 階段與正式階段拿同一個獎）
  if (window.isCampaignStagePlan(plan)) {
    const stageNo = Number(plan.stageNo || (plan.campaignDefinition && plan.campaignDefinition.stageNo) || 0);
    if (stageNo > 0) {
      const completedRoundsKey = `church_stage_completed_rounds_${stageNo}`;
      const previousCompletedRounds = Number(localStorage.getItem(completedRoundsKey) || 0);
      localStorage.setItem(completedRoundsKey, String(Math.max(previousCompletedRounds, currentRound)));

      const badgeId = `church_stage_award_${stageNo}`;
      const unlockedBadges = JSON.parse(localStorage.getItem("unlocked_badges") || "[]");
      if (!unlockedBadges.includes(badgeId)) {
        unlockedBadges.push(badgeId);
        localStorage.setItem("unlocked_badges", JSON.stringify(unlockedBadges));
      }

      const today = new Date();
      const roundUnlockDateKey = `date_unlocked_${badgeId}_lvl_${currentRound}`;
      if (!localStorage.getItem(roundUnlockDateKey)) {
        localStorage.setItem(roundUnlockDateKey, `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`);
      }
    }
  }

  if (typeof checkAchievements === "function") {
    checkAchievements().catch(console.error);
  }

  loader.show("進入下一遍...");
  try {
    plan.currentRound = nextRound;
    plan.lastUpgradedRound = currentRound;
    plan.upgradePromptHandled = true;
    // 下一遍的排程從「現在點選確認」這一刻算起，不是讀完上一遍的隔天，
    // 也不是之後第一次打卡下一遍的日期。
    plan.currentRoundStartedAt = new Date().toISOString();

    rebuildPlanSchedule(plan);
    await persistPlanRoundState(plan);

    const firstNextRoundDay = plan.days.find(day => (day.chapters || []).some(chapter =>
      Number(chapter.round || 1) === nextRound
    ));
    if (firstNextRoundDay) state.selectedPlanDay = firstNextRoundDay.dayNum;
    window._cachedAllUsersList = null;
    window._cachedAllUsersListKey = null;

    calculatePlanProgress();
    await renderPlanView();
    window.dispatchEvent(new CustomEvent("app:dataRefresh", { detail: { scope: "plan" } }));

    const modal = document.getElementById("congrats-modal");
    if (modal) modal.remove();
    showToast(`恭喜！您已成功進入第 ${nextRound} 遍，開始新的讀經旅程。`);
  } catch (err) {
    Object.assign(plan, previousPlanState);
    calculatePlanProgress();
    console.error("Failed to upgrade plan:", err);
    setPlanUpgradeOverlayBusy(false, upgradeAvailability.nextRoundLabel, "排程建立失敗，請稍後再試。");
    showToast("升級失敗，請稍後再試");
  } finally {
    planUpgradeInFlight = false;
    loader.hide();
  }
};

// ── 最後一天漏讀提醒 ─────────────────────────────────────────────
// 使用者讀到「本遍最後一個閱讀日」、卻還沒 100% 時，前面一定有漏勾的章節。
// 不提醒的話他會以為「明明讀完了卻進不了下一遍 ＝ 系統壞了」。

function getCurrentRoundLastReadingDay(plan) {
  if (!plan || !Array.isArray(plan.days)) return null;
  const round = plan.currentRound || 1;
  for (let i = plan.days.length - 1; i >= 0; i--) {
    const day = plan.days[i];
    if ((day.chapters || []).some(ch => Number(ch.round || round) === round)) return day;
  }
  return null;
}

function getCurrentRoundMissedChapters(plan) {
  if (!plan || !Array.isArray(plan.days)) return [];
  const round = plan.currentRound || 1;
  const missed = [];
  plan.days.forEach(day => {
    (day.chapters || []).forEach(ch => {
      if (Number(ch.round || round) !== round) return;
      if (!ch["isReadR" + round]) {
        missed.push({ book: ch.book, chapter: ch.chapter, dayNum: day.dayNum, date: day.date });
      }
    });
  });
  return missed;
}

function maybePromptMissedRoundChapters(plan) {
  if (!plan || !Array.isArray(plan.days)) return;
  const round = plan.currentRound || 1;

  // 本遍已 100% → 不是這個情境（會走「進入下一遍」的恭喜 modal）
  const total = plan.currentRoundTotalChapters || 0;
  const done = plan.completedChapters || 0;
  if (plan.isPlanCompleted || Number(plan.progress) >= 100 || (total > 0 && done >= total)) return;

  // 本 session 這一遍已提醒過 → 不再跳
  if (plan.missedRoundPromptedRound === round) return;

  // 「本遍最後一個閱讀日」還沒全部勾完 → 使用者還在計畫中間，不打擾
  const lastDay = getCurrentRoundLastReadingDay(plan);
  if (!lastDay) return;
  const lastDayDone = (lastDay.chapters || [])
    .filter(ch => Number(ch.round || round) === round)
    .every(ch => Boolean(ch["isReadR" + round]));
  if (!lastDayDone) return;

  const missed = getCurrentRoundMissedChapters(plan);
  if (missed.length === 0) return; // 保險：有洞才會 progress<100，理論上到不了這

  plan.missedRoundPromptedRound = round;
  showMissedChaptersModal(plan, round, missed);
}

function showMissedChaptersModal(plan, round, missed) {
  const oldModal = document.getElementById("missed-chapters-modal");
  if (oldModal) oldModal.remove();

  const roundLabel = round === 1 ? "第一遍" : `第${round}遍`;
  const expired = isPlanExpired(plan);

  const byDay = new Map();
  missed.forEach(m => {
    if (!byDay.has(m.dayNum)) byDay.set(m.dayNum, { date: m.date, items: [] });
    byDay.get(m.dayNum).items.push(`${m.book}${m.chapter}`);
  });
  const groups = [...byDay.values()];
  const shownGroups = groups.slice(0, 10);
  const shownCount = shownGroups.reduce((sum, g) => sum + g.items.length, 0);
  const restCount = missed.length - shownCount;
  const listHtml = shownGroups.map(g =>
    `<li><span class="missed-chapters-date">${escapeHTML(g.date || "")}</span><span class="missed-chapters-items">${escapeHTML(g.items.join("、"))}</span></li>`
  ).join("") + (restCount > 0 ? `<li class="missed-chapters-more">…還有 ${restCount} 章</li>` : "");

  const firstMissedDay = missed[0].dayNum;

  const modal = document.createElement("div");
  modal.id = "missed-chapters-modal";
  modal.className = "congrats-modal-overlay";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "missed-chapters-title");
  modal.innerHTML = `
    <div class="congrats-modal-box">
      <span class="plan-upgrade-gate__icon" aria-hidden="true">
        <span class="nlc-icon nlc-icon--lg" data-icon="bookOne"></span>
      </span>
      <h3 class="congrats-title" id="missed-chapters-title">還差 ${missed.length} 章才能${expired ? "完成本遍" : "進入下一遍"}</h3>
      <p class="congrats-desc-secondary">你已經讀到${roundLabel}最後一天了，但前面有 ${missed.length} 章還沒打卡完成${expired ? "。計畫時間已過，補讀完可計入補讀章數，但無法再進入下一遍。" : "。補讀完這些章節，「進入下一遍」就會出現。"}</p>
      <ul class="missed-chapters-list">${listHtml}</ul>
      <div class="congrats-actions">
        <button id="btn-missed-goto" type="button" class="congrats-upgrade-btn">去補讀第一個</button>
        <button id="btn-missed-later" type="button" class="congrats-later-btn">知道了</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  if (typeof hydrateIcons === "function") hydrateIcons(modal);

  modal.querySelector("#btn-missed-later")?.addEventListener("click", () => modal.remove());
  modal.querySelector("#btn-missed-goto")?.addEventListener("click", () => {
    modal.remove();
    const day = (plan.days || []).find(d => d.dayNum === firstMissedDay);
    if (!day) return;
    state.selectedPlanDay = firstMissedDay;
    state.calendarViewYear = day.year || new Date().getFullYear();
    state.calendarViewMonth = day.month || (new Date().getMonth() + 1);
    // 日曆整段一次渲染，目標格已在 DOM → 只切 active class + 捲動容器內部，不重繪、不整頁跳
    const prev = document.querySelector(".plan-day-cell.active");
    if (prev) { prev.classList.remove("active"); prev.setAttribute("aria-selected", "false"); }
    const target = document.querySelector(`.plan-day-cell[data-day-num="${firstMissedDay}"]`);
    if (target) {
      target.classList.add("active");
      target.setAttribute("aria-selected", "true");
      const scroller = target.closest(".calendar-scroll-container");
      if (scroller) {
        requestAnimationFrame(() => {
          scroller.scrollTop = target.offsetTop - (scroller.clientHeight / 2) + (target.offsetHeight / 2);
        });
      }
    }
    if (typeof renderPlanScheduleTracker === "function") renderPlanScheduleTracker(true);
  });
}

// 常駐「進入下一遍」按鈕：停在「本遍最後一個閱讀日」且該日已勾完時出現，
// 不管整體進度是否 100%。按下時即時重算漏章：
//   有漏 → 再跳一次漏章清單（略過 session 旗標，這是使用者主動點的）
//   沒漏 → 走既有 triggerPlanUpgradeFlow（過期計畫則只結算本遍）
function renderRoundAdvanceButton(plan, selectedDay) {
  const container = document.getElementById("plan-tasks-list");
  if (!container) return;
  container.querySelector("#plan-round-advance-footer")?.remove();
  if (!plan || !selectedDay || !Array.isArray(plan.days)) return;

  const round = plan.currentRound || 1;
  const lastDay = getCurrentRoundLastReadingDay(plan);
  if (!lastDay || lastDay.dayNum !== selectedDay.dayNum) return;

  const lastDayChapters = (selectedDay.chapters || []).filter(ch => Number(ch.round || round) === round);
  if (lastDayChapters.length === 0) return;
  const lastDayDone = lastDayChapters.every(ch => Boolean(ch["isReadR" + round]));
  if (!lastDayDone) return;

  const expired = isPlanExpired(plan);
  const footer = document.createElement("div");
  footer.id = "plan-round-advance-footer";
  footer.className = "plan-round-advance-footer";
  footer.innerHTML = `
    <button id="btn-plan-round-advance" type="button" class="congrats-upgrade-btn">${expired ? "結算本遍" : "進入下一遍"}</button>
    <p class="plan-round-advance-hint">讀完最後一天了嗎？按這裡檢查前面有沒有漏勾，${expired ? "並結算本遍" : "沒漏就進入下一遍"}。</p>
  `;
  container.appendChild(footer);

  footer.querySelector("#btn-plan-round-advance")?.addEventListener("click", () => {
    if (typeof calculatePlanProgress === "function") calculatePlanProgress();
    const missed = getCurrentRoundMissedChapters(plan);
    if (missed.length > 0) {
      showMissedChaptersModal(plan, round, missed);
      return;
    }
    if (expired) {
      showToast("本遍已全部讀完。計畫時間已過，無法再進入下一遍。");
      return;
    }
    window.triggerPlanUpgradeFlow();
  });
}

async function handleRoundCompletion(plan) {
  if (!plan) return;
  calculatePlanProgress();

  const currentRound = plan.currentRound || 1;
  const currentRoundTotal = plan.currentRoundTotalChapters || 0;
  const currentRoundCompleted = plan.completedChapters || 0;
  const isCurrentRoundCompleted = currentRoundTotal > 0 && currentRoundCompleted >= currentRoundTotal;

  if (!isCurrentRoundCompleted) {
    maybePromptMissedRoundChapters(plan);
    return;
  }

  // Prevent multiple triggers for the same round completion in the same session
  if (plan.lastPromptedRound === currentRound) return;
  plan.lastPromptedRound = currentRound;

  if (isPlanExpired(plan)) {
    showToast("恭喜完成此遍補讀打卡！由於計畫時間已過，無法再進行升級。");
    return;
  }

  // Show the congrats medal modal, do NOT auto upgrade
  showCongratsModal(plan, currentRound);
};

function initAdminPlanManagement() {
  const addBtn = document.getElementById("admin-add-plan-btn");
  const cancelBtn = document.getElementById("admin-cancel-plan-btn");
  const saveBtn = document.getElementById("admin-save-plan-btn");
  const formContainer = document.getElementById("admin-plan-form-container");

  if (!addBtn || !cancelBtn || !saveBtn || !formContainer) return;

  // Render Bible books selection grids
  const oldGrid = document.getElementById("admin-old-books-grid");
  const newGrid = document.getElementById("admin-new-books-grid");

  if (oldGrid && newGrid) {
    oldGrid.innerHTML = "";
    newGrid.innerHTML = "";
    BIBLE_BOOKS.forEach(book => {
      const label = document.createElement("label");
      label.style = `
        display: flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 0.875rem;
        cursor: pointer;
        padding: 0.2rem 0.3rem;
        border-radius: 4px;
        background: white;
        border: 1px solid var(--border-card);
        user-select: none;
      `;
      label.innerHTML = `
        <input type="checkbox" class="admin-book-checkbox" value="${book.name}" style="margin: 0; cursor: pointer;">
        ${book.name}
      `;
      if (book.section === "old") {
        oldGrid.appendChild(label);
      } else {
        newGrid.appendChild(label);
      }
    });
  }

  // Bind quick select buttons
  const btnSelectAll = document.getElementById("admin-select-all-books");
  if (btnSelectAll) {
    btnSelectAll.onclick = () => {
      document.querySelectorAll(".admin-book-checkbox").forEach(cb => cb.checked = true);
    };
  }
  const btnClear = document.getElementById("admin-clear-books");
  if (btnClear) {
    btnClear.onclick = () => {
      document.querySelectorAll(".admin-book-checkbox").forEach(cb => cb.checked = false);
    };
  }
  const btnSelectOld = document.getElementById("admin-select-old-books");
  if (btnSelectOld) {
    btnSelectOld.onclick = () => {
      BIBLE_BOOKS.forEach(book => {
        const cb = document.querySelector(`.admin-book-checkbox[value="${book.name}"]`);
        if (cb) cb.checked = book.section === "old";
      });
    };
  }
  const btnSelectNew = document.getElementById("admin-select-new-books");
  if (btnSelectNew) {
    btnSelectNew.onclick = () => {
      BIBLE_BOOKS.forEach(book => {
        const cb = document.querySelector(`.admin-book-checkbox[value="${book.name}"]`);
        if (cb) cb.checked = book.section === "new";
      });
    };
  }

  // Bind schedule time type radios change
  const typeRadios = document.getElementsByName("admin-plan-time-type");
  const dateInputs = document.getElementById("admin-plan-date-inputs");
  const durationContainer = document.getElementById("admin-plan-duration-container");

  const toggleTimeTypeFields = (type) => {
    if (type === "flexible") {
      if (dateInputs) dateInputs.style.display = "none";
      if (durationContainer) durationContainer.style.display = "block";
    } else {
      if (dateInputs) dateInputs.style.display = "grid";
      if (durationContainer) durationContainer.style.display = "none";
    }
  };

  typeRadios.forEach(radio => {
    radio.onchange = (e) => toggleTimeTypeFields(e.target.value);
  });

  // Toggle Form
  addBtn.onclick = () => {
    document.getElementById("admin-plan-form-title").textContent = "新增讀經計畫";
    document.getElementById("admin-edit-plan-id").value = "";
    document.getElementById("admin-plan-name").value = "";
    document.getElementById("admin-plan-start-date").value = "";
    document.getElementById("admin-plan-end-date").value = "";
    const durationInput = document.getElementById("admin-plan-duration-days");
    if (durationInput) durationInput.value = "";

    // Set fixed as default
    const fixedRadio = document.querySelector('input[name="admin-plan-time-type"][value="fixed"]');
    if (fixedRadio) fixedRadio.checked = true;
    toggleTimeTypeFields("fixed");

    document.querySelectorAll(".admin-book-checkbox").forEach(cb => cb.checked = false);
    formContainer.classList.remove("hidden");
  };

  cancelBtn.onclick = () => {
    formContainer.classList.add("hidden");
  };

  // Save Plan
  saveBtn.onclick = async () => {
    const id = document.getElementById("admin-edit-plan-id").value;
    const name = document.getElementById("admin-plan-name").value.trim();

    // Determine time type selection
    const checkedRadio = document.querySelector('input[name="admin-plan-time-type"]:checked');
    const isFixed = checkedRadio ? checkedRadio.value === "fixed" : true;

    let startDate = "";
    let endDate = "";

    if (isFixed) {
      startDate = document.getElementById("admin-plan-start-date").value;
      endDate = document.getElementById("admin-plan-end-date").value;

      if (!startDate || !endDate) {
        alert("請選擇計畫開始與結束日期！");
        return;
      }
      if (new Date(startDate) > new Date(endDate)) {
        alert("開始日期不可晚於結束日期！");
        return;
      }
    } else {
      const durationVal = document.getElementById("admin-plan-duration-days").value;
      const durationDays = parseInt(durationVal);
      if (!durationVal || isNaN(durationDays) || durationDays <= 0) {
        alert("請輸入有效的計畫總天數！");
        return;
      }

      // Generate start/end dates for the template starting today to satisfy database constraints
      const getLocalDateString = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };

      const today = new Date();
      startDate = getLocalDateString(today);
      const end = new Date(today);
      end.setDate(today.getDate() + durationDays - 1);
      endDate = getLocalDateString(end);
    }

    const checkedBooks = [];
    document.querySelectorAll(".admin-book-checkbox:checked").forEach(cb => {
      checkedBooks.push(cb.value);
    });

    if (!name) {
      alert("請輸入計畫名稱！");
      return;
    }
    if (checkedBooks.length === 0) {
      alert("請至少選取一個聖經書卷！");
      return;
    }

    loader.show("正在儲存計畫...");
    const success = await db.saveGlobalPlan({
      id: id || null,
      name,
      startDate,
      endDate,
      books: checkedBooks,
      isFixed: isFixed
    });
    loader.hide();

    if (success) {
      if (typeof showToast === "function") {
        showToast("計畫儲存成功！已自動同步更新所有使用者的挑戰時間。");
      } else {
        alert("計畫儲存成功！");
      }

      // 💡 關鍵修復：儲存成功後，重新載入用戶的活動計畫資料，使主頁挑戰卡片的進度與時間即時重新計算
      if (typeof db !== "undefined" && db.loadUserData) {
        await db.loadUserData();
      }
      if (typeof updateDashboardView === "function") {
        updateDashboardView();
      }
      if (typeof renderPlanScheduleTracker === "function") {
        renderPlanScheduleTracker(true);
      }

      formContainer.classList.add("hidden");
      renderAdminPlanManagement();
      if (typeof renderPresetPlansList === 'function') {
        renderPresetPlansList();
      }
    }
  };
}

// 延後大區梯次：後台小面板（migration 0126–0128 + db.createRegionStageCohort）
function wireRegionCohortPanel() {
  const box = document.getElementById("admin-region-cohort");
  if (!box || box.dataset.wired === "1") return;
  box.dataset.wired = "1";

  const regionSel = document.getElementById("cohort-region");
  if (regionSel) {
    const regions = (state.orgStructure && state.orgStructure.regions) || [];
    regionSel.innerHTML = regions.length
      ? regions.map(r => `<option value="${escapeHTML(r)}">${escapeHTML(r)}</option>`).join("")
      : `<option value="">（尚無大區資料）</option>`;
  }

  const btn = document.getElementById("cohort-create-btn");
  btn?.addEventListener("click", async () => {
    const greatRegion = (document.getElementById("cohort-region")?.value || "").trim();
    const sourceStageNo = Number(document.getElementById("cohort-stage")?.value || 0);
    const startDate = document.getElementById("cohort-start")?.value || "";
    const endDate = document.getElementById("cohort-end")?.value || "";
    const isHidden = document.getElementById("cohort-hidden")?.checked !== false;
    if (!greatRegion) { showToast("請選擇大區"); return; }
    if (!startDate || !endDate) { showToast("請填起訖日期"); return; }
    if (endDate <= startDate) { showToast("結束日要晚於開始日"); return; }
    btn.disabled = true;
    const res = await db.createRegionStageCohort({ greatRegion, sourceStageNo, startDate, endDate, isHidden });
    btn.disabled = false;
    if (!res.success) { showToast(res.message || "建立失敗"); return; }
    showToast(res.data?.created ? `已建立「${res.data.name}」` : `已更新「${res.data?.name || "梯次"}」`);
    if (typeof db.loadGlobalPlans === "function") await db.loadGlobalPlans();
    renderAdminPlanManagement();
    if (typeof renderPresetPlansList === "function") renderPresetPlansList();
  });
}

async function renderAdminPlanManagement() {
  const tableBody = document.getElementById("admin-plans-table-body");
  if (!tableBody) return;

  wireRegionCohortPanel();

  if (firstPaint(tableBody)) tableBody.innerHTML = typeof ComponentSkeletonLoader !== "undefined"
    ? `<tr><td colspan="3">${ComponentSkeletonLoader.getHtml("table-rows", { count: 3, cols: 3 })}</td></tr>`
    : "";

  try {
    const plans = state.globalPlans || [];
    tableBody.innerHTML = "";

    if (plans.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">目前無任何計畫，請點擊上方「新增計畫」建立</td></tr>`;
      return;
    }

    plans.forEach(plan => {
      const tr = document.createElement("tr");

      const bookListText = plan.books.join(", ");
      const bookCount = plan.books.length;
      const hidden = isPlanHidden(plan);
      const isFixed = plan.isFixed !== false && plan.is_fixed !== false;
      const isCampaign = plan.planKind === "church_campaign" || plan.id === window.CHURCH_CAMPAIGN_ID;
      // 正式階段限定：cohort 階段在「大區延後梯次」專屬面板管理，這裡維持一般計畫列
      // 的編輯 / 刪除操作，不套用階段列（隱藏刪除、鎖編輯規則）的處理。
      const isCampaignStage = window.isCanonicalCampaignStagePlan(plan);
      const campaignStageNo = Number(plan.stageNo || plan.campaignDefinition && plan.campaignDefinition.stageNo || 0);

      let timeColHtml = "";
      if (isFixed) {
        timeColHtml = `
          <span style="font-size: 0.875rem; font-weight: 500; display: block; white-space: nowrap;"><span class="nlc-icon" data-icon="calendarThirty" aria-hidden="true"></span> ${plan.startDate}</span>
          <span style="font-size: 0.875rem; font-weight: 500; display: block; white-space: nowrap; margin-left: 0.6rem; color: var(--text-muted);">~ ${plan.endDate}</span>
        `;
      } else {
        const duration = Math.ceil((new Date(plan.endDate) - new Date(plan.startDate)) / (1000 * 60 * 60 * 24)) + 1;
        timeColHtml = `
          <span style="font-size: 0.875rem; font-weight: 500; display: block; white-space: nowrap;"><span class="nlc-icon" data-icon="calendarThirty" aria-hidden="true"></span> 彈性時間</span>
          <span style="font-size: 0.875rem; font-weight: 500; display: block; white-space: nowrap; margin-left: 0.6rem; color: var(--text-muted);">共 ${duration} 天</span>
        `;
      }

      tr.innerHTML = `
        <td>
          <strong style="display: block; margin-bottom: 0.15rem; font-size: 0.875rem; word-break: break-all;">${escapeHTML(plan.name)}${hidden ? ' <span class="text-warning" style="font-size:0.875rem; font-weight: 500;">已隱藏</span>' : ''}</strong>
          <span title="${escapeHTML(bookListText)}" style="font-size: 0.875rem; color: var(--text-muted); cursor: help; text-decoration: underline dashed; text-underline-offset: 2px;">
            共 ${bookCount} 卷書卷
          </span>
        </td>
        <td>
          ${timeColHtml}
        </td>
        <td style="text-align: center; vertical-align: middle;">
          <div style="display: flex; flex-direction: column; gap: 0.25rem; align-items: center; justify-content: center;">
            ${isCampaignStage ? `<span class="admin-plan-visibility-state" style="font-size:0.875rem;font-weight:600;color:${hidden ? 'var(--color-warning)' : 'var(--color-success)'};">${hidden ? '尚未開放' : '已開放'}</span>` : ""}
            ${isCampaignStage && campaignStageNo >= 2 && campaignStageNo <= 10 ? `<button class="secondary-btn admin-toggle-hidden-plan-btn" style="font-size:0.875rem;padding:0.25rem 0.45rem;height:auto;">${hidden ? '開放給使用者' : '暫停開放'}</button>` : ""}
            <button class="primary-btn admin-campaign-rules-btn" style="font-size:0.875rem;padding:0.25rem 0.45rem;height:auto;">編輯規則</button>
            <button class="primary-btn admin-edit-plan-btn" style="font-size: 0.875rem; padding: 0.2rem 0.4rem; min-width: 42px; text-align: center; height: auto; cursor: pointer;">編輯</button>
            <button class="danger-btn admin-delete-plan-btn" style="font-size: 0.875rem; padding: 0.2rem 0.4rem; min-width: 42px; text-align: center; height: auto; cursor: pointer;">刪除</button>
          </div>
        </td>
      `;

      const campaignRulesBtn = tr.querySelector(".admin-campaign-rules-btn");
      if (isCampaign) {
        campaignRulesBtn.onclick = () => window.openCampaignRuleEditor(plan);
        tr.querySelector(".admin-edit-plan-btn").style.display = "none";
        tr.querySelector(".admin-delete-plan-btn").style.display = "none";
      } else if (isCampaignStage) {
        campaignRulesBtn.remove();
        tr.querySelector(".admin-edit-plan-btn").style.display = "none";
        tr.querySelector(".admin-delete-plan-btn").style.display = "none";
      } else {
        campaignRulesBtn.remove();
      }

      // Bind edit event
      tr.querySelector(".admin-edit-plan-btn").onclick = () => {
        document.getElementById("admin-plan-form-title").textContent = "編輯讀經計畫";
        document.getElementById("admin-edit-plan-id").value = plan.id;
        document.getElementById("admin-plan-name").value = plan.name;

        // Set radio button and fields visibility
        const fixedRadio = document.querySelector('input[name="admin-plan-time-type"][value="fixed"]');
        const flexRadio = document.querySelector('input[name="admin-plan-time-type"][value="flexible"]');
        const dateInputs = document.getElementById("admin-plan-date-inputs");
        const durationContainer = document.getElementById("admin-plan-duration-container");

        if (isFixed) {
          if (fixedRadio) fixedRadio.checked = true;
          document.getElementById("admin-plan-start-date").value = plan.startDate;
          document.getElementById("admin-plan-end-date").value = plan.endDate;
          document.getElementById("admin-plan-duration-days").value = "";
          if (dateInputs) dateInputs.style.display = "grid";
          if (durationContainer) durationContainer.style.display = "none";
        } else {
          if (flexRadio) flexRadio.checked = true;
          const duration = Math.ceil((new Date(plan.endDate) - new Date(plan.startDate)) / (1000 * 60 * 60 * 24)) + 1;
          document.getElementById("admin-plan-duration-days").value = duration;
          document.getElementById("admin-plan-start-date").value = "";
          document.getElementById("admin-plan-end-date").value = "";
          if (dateInputs) dateInputs.style.display = "none";
          if (durationContainer) durationContainer.style.display = "block";
        }

        // Check corresponding books
        document.querySelectorAll(".admin-book-checkbox").forEach(cb => {
          cb.checked = plan.books.includes(cb.value);
        });

        document.getElementById("admin-plan-form-container").classList.remove("hidden");
        document.getElementById("admin-plan-form-container").scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };

      const toggleHiddenBtn = tr.querySelector(".admin-toggle-hidden-plan-btn");
      if (toggleHiddenBtn) {
        toggleHiddenBtn.onclick = async () => {
          if (!hidden && typeof window.showConfirmDialog === "function") {
            const confirmed = await window.showConfirmDialog({
              title: "暫停開放這個階段？",
              message: "一般使用者將不再看到或加入這個階段；既有資料不會在此操作中刪除。",
              confirmText: "暫停開放",
              cancelText: "取消",
              isDestructive: true
            });
            if (!confirmed) return;
          }

          loader.show(hidden ? "正在開放階段…" : "正在暫停開放…");
          const success = await db.setGlobalPlanHidden(plan, !hidden);
          loader.hide();
          if (!success) {
            showToast("開放狀態未能儲存，請稍後再試。");
            return;
          }

          showToast(hidden ? "此階段已開放給使用者。" : "此階段已暫停開放。");
          renderAdminPlanManagement();
          if (typeof renderPresetPlansList === "function") renderPresetPlansList();
          if (typeof renderJoinedPlansList === "function") renderJoinedPlansList();
        };
      }

      // Bind delete event
      tr.querySelector(".admin-delete-plan-btn").onclick = async () => {
        const confirmed = await window.showConfirmDialog({
          title: "確定要刪除此計畫嗎？",
          message: `您確定要刪除「${plan.name}」嗎？這將使其他會友無法再從列表「加入」此計畫，但已加入的會友仍可照常閱讀打卡。`,
          confirmText: "確認刪除",
          cancelText: "取消",
          isDestructive: true
        });
        if (!confirmed) return;

        loader.show("刪除計畫中...");
        const success = await db.deleteGlobalPlan(plan.id);
        loader.hide();
        if (success) {
          showToast("計畫已成功刪除！");
          renderAdminPlanManagement();
          if (typeof renderPresetPlansList === 'function') {
            renderPresetPlansList();
          }
        }
      };

      tableBody.appendChild(tr);
    });

  } catch (err) {
    console.error("Failed to render admin plans:", err);
    tableBody.innerHTML = `<tr><td colspan="4" class="text-danger" style="text-align: center;">載入計畫失敗: ${err.message || err}</td></tr>`;
  }
}



window.openPlanChapterInReader = function (bookName, chapter, dayNum, round = null) {
  if (typeof window.guardPlanEligibility === "function" && window.guardPlanEligibility()) return;
  if (state.activePlan && isPlanExpired(state.activePlan)) {
    showToast("此計畫已過期，無法再進入進度閱讀。");
    return;
  }
  const book = BIBLE_BOOKS.find(b => b.name === bookName || b.eng === bookName);
  if (!book) {
    console.warn('找不到本地聖經卷名，無法進入閱讀：', bookName);
    return;
  }

  state.readerState.bookId = book.id;
  state.readerState.chapter = Number(chapter) || 1;
  state.readerState.fromPlan = true;
  state.readerState.returnTab = "plan-view";
  state.readerState.planDayNum = dayNum || null;
  state.readerState.planRound = round || (state.activePlan ? state.activePlan.currentRound || 1 : 1);
  state.readerState.planContextId = window.getActivePlanContextId?.(state.activePlan)
    || state.activePlan?.id
    || state.activePlan?.globalPlanId
    || state.activePlan?.presetKey
    || null;
  console.info("[AutoRead] Opened plan chapter in reader", {
    planContextId: state.readerState.planContextId, book: book.name, chapter: state.readerState.chapter, round: state.readerState.planRound
  });

  if (typeof saveReaderPreferences === 'function') {
    saveReaderPreferences();
  } else {
    localStorage.setItem("reader_state", JSON.stringify({
      bookId: state.readerState.bookId,
      chapter: state.readerState.chapter
    }));
  }

  appRouter.switchTab('reader-view', { fromPlan: true });
};

// Initialize state for inline reader
state.inlineReader = {
  active: false,
  dayNum: 0,
  chaptersList: [],
  currentIndex: 0,
  autoMarked: false,
  autoMarkInFlight: false
};

let inlineReaderBottomDwellController = null;
let inlineReaderEndObserver = null;
let inlineReaderEndVisible = false;

function getCurrentInlineReaderTask() {
  const plan = state.activePlan;
  const reader = state.inlineReader;
  if (!plan || !reader?.active) return null;
  const chapter = reader.chaptersList[reader.currentIndex];
  if (!chapter) return null;
  const round = Number(chapter.round || plan.currentRound || 1);
  return { plan, chapter, round };
}

function getInlineReaderTargetKey() {
  const task = getCurrentInlineReaderTask();
  if (!task) return "";
  return [
    task.plan.id || task.plan.globalPlanId || task.plan.presetKey || "plan",
    state.inlineReader.dayNum,
    task.round,
    task.chapter.book,
    task.chapter.chapter
  ].join("|");
}

function isInlineReaderTaskRead(task) {
  if (!task) return false;
  return Boolean(task.chapter[`isReadR${task.round}`] || (task.round === 1 && task.chapter.isRead));
}

function findInlineReaderLog(task) {
  return (state.readingLogs || []).find(log =>
    String(log.book) === String(task.chapter.book) &&
    Number(log.chapter) === Number(task.chapter.chapter) &&
    Number(log.round || 1) === task.round &&
    (log.plan_id === task.plan.id || log.presetKey === task.plan.presetKey || log.preset_key === task.plan.presetKey)
  );
}

async function autoMarkInlineReaderTaskRead(expectedTargetKey) {
  const task = getCurrentInlineReaderTask();
  if (!task || getInlineReaderTargetKey() !== expectedTargetKey) return false;
  if (isInlineReaderTaskRead(task)) return true;
  if (state.inlineReader.autoMarked || state.inlineReader.autoMarkInFlight) return false;
  if (isPlanExpired(task.plan) || task.round < Number(task.plan.currentRound || 1)) return false;
  if (isPlanProgressLocked(task.plan, { hidden: window.isPlanHidden?.(task.plan) })) return false;
  // Offline reading mode is read-only for progress — skip silently, matching
  // this auto-mark flow's existing "no intrusive toast" design.
  if (state.offlineMode) return false;

  const readKey = `isReadR${task.round}`;
  const previousRoundRead = Boolean(task.chapter[readKey]);
  const previousRead = Boolean(task.chapter.isRead);
  const existingLog = findInlineReaderLog(task);
  state.inlineReader.autoMarked = true;
  state.inlineReader.autoMarkInFlight = true;
  task.chapter[readKey] = true;
  if (task.round === 1) task.chapter.isRead = true;

  try {
    calculatePlanProgress();
    await db.logChapterRead(task.chapter.book, task.chapter.chapter, true, task.round, task.plan);
    if (typeof db.saveLocalUserStats === "function") db.saveLocalUserStats();
    calculatePlanProgress();
    window.setDataVersion?.(previous => previous + 1);
    window.dispatchEvent(new CustomEvent("app:dataRefresh", { detail: { scope: "plan" } }));
    if (task.plan.progress >= 100) {
      await window.closePlanInlineReader();
      await handleRoundCompletion(task.plan);
    }
    console.info("[AutoRead] Inline reading log persisted", { targetKey: expectedTargetKey });
    return true;
  } catch (error) {
    console.error("Failed to auto-mark inline reader progress", error);
    task.chapter[readKey] = previousRoundRead;
    task.chapter.isRead = previousRead;
    if (!existingLog && Array.isArray(state.readingLogs)) {
      state.readingLogs = state.readingLogs.filter(log => !(
        String(log.book) === String(task.chapter.book) &&
        Number(log.chapter) === Number(task.chapter.chapter) &&
        Number(log.round || 1) === task.round &&
        (log.plan_id === task.plan.id || log.presetKey === task.plan.presetKey || log.preset_key === task.plan.presetKey)
      ));
    }
    state.inlineReader.autoMarked = false;
    calculatePlanProgress();
    showToast((window.APP_COPY && window.APP_COPY.plan.syncFail) || "閱讀進度同步失敗，請稍後再試");
    return false;
  } finally {
    state.inlineReader.autoMarkInFlight = false;
  }
}

function checkInlineReaderBottomDwell(surface = document.querySelector(".main-content"), isAtBottom = null) {
  const task = getCurrentInlineReaderTask();
  inlineReaderBottomDwellController?.check(surface, {
    eligible: Boolean(
      task &&
      !isPlanProgressLocked(task.plan, { hidden: window.isPlanHidden?.(task.plan) }) &&
      !isInlineReaderTaskRead(task) &&
      !state.inlineReader.autoMarked &&
      !state.inlineReader.autoMarkInFlight
    ),
    targetKey: getInlineReaderTargetKey(),
    isAtBottom
  });
}

function handleInlineReaderScroll(event) {
  checkInlineReaderBottomDwell(event.currentTarget || event.target);
}

function bindInlineReaderEndObserver() {
  inlineReaderEndObserver?.disconnect();
  inlineReaderEndObserver = null;
  inlineReaderEndVisible = false;
  const root = document.querySelector(".main-content");
  const sentinel = document.getElementById("plan-inline-reader-end-sentinel");
  if (!root || !sentinel) return;
  inlineReaderEndObserver = observeReaderEndSentinel({
    root,
    sentinel,
    onChange: isVisible => {
      inlineReaderEndVisible = isVisible;
      if (isVisible) {
        console.info("[AutoRead] Inline reader bottom detected", { targetKey: getInlineReaderTargetKey() || null });
        checkInlineReaderBottomDwell(root, () => inlineReaderEndVisible);
      } else inlineReaderBottomDwellController?.cancel();
    }
  });
}
function scheduleInlineReaderBottomDwellCheck() {
  requestAnimationFrame(() => requestAnimationFrame(() => checkInlineReaderBottomDwell()));
}

function initInlineReaderBottomDwell() {
  const scrollSurface = document.querySelector(".main-content");
  if (!scrollSurface) return;
  if (!inlineReaderBottomDwellController) {
    inlineReaderBottomDwellController = createReaderBottomDwellController({
      dwellMs: 1000,
      bottomThreshold: 96,
      onComplete: autoMarkInlineReaderTaskRead
    });
  }
  if (scrollSurface.dataset.inlineReaderBottomDwellBound !== "true") {
    scrollSurface.dataset.inlineReaderBottomDwellBound = "true";
    scrollSurface.addEventListener("scroll", handleInlineReaderScroll, { passive: true });
    scrollSurface.addEventListener("scrollend", handleInlineReaderScroll, { passive: true });
  }
}

window.openPlanInlineReader = async function (bookName, chapter, dayNum, round = null) {
  if (typeof window.guardPlanEligibility === "function" && window.guardPlanEligibility()) return;
  if (state.activePlan && isPlanExpired(state.activePlan)) {
    showToast("此計畫已過期，無法再進入進度閱讀。");
    return;
  }
  if (!state.activePlan) return;

  state.selectedPlanDay = dayNum;

  const day = (state.activePlan.days || []).find(d => d.dayNum === dayNum);
  const targetRound = Number(round || state.activePlan.currentRound || 1);
  const chaptersForRound = (day && day.chapters || []).filter(ch =>
    Number(ch.round || targetRound) === targetRound
  );
  if (chaptersForRound.length === 0) return;

  // Set state before switchTab so renderPlanScheduleTracker sees inlineReader.active = true
  state.inlineReader.active = true;
  state.inlineReader.dayNum = dayNum;
  state.inlineReader.chaptersList = chaptersForRound;
  state.inlineReader.currentIndex = chaptersForRound.findIndex(ch =>
    ch.book === bookName &&
    Number(ch.chapter) === Number(chapter) &&
    (round == null || Number(ch.round || 1) === Number(round))
  );
  if (state.inlineReader.currentIndex === -1) state.inlineReader.currentIndex = 0;

  // Switch to plan-view and AWAIT renderPlanView() to finish before touching DOM
  if (typeof appRouter !== 'undefined' && typeof appRouter.switchTab === 'function') {
    await appRouter.switchTab('plan-view', { keepPlanDetail: true });
  }

  // Now that renderPlanView() is fully settled, apply inline reader DOM state
  document.body.classList.add("plan-inline-reader-open");
  console.info("[AutoRead] Opened inline plan reader", {
    planId: state.activePlan?.id || null, book: bookName, chapter: Number(chapter), round: targetRound
  });

  // Hide checklist interface elements
  const carousel = document.getElementById("plan-date-carousel");
  const planDayHeader = document.getElementById("plan-day-subtitle") ? document.getElementById("plan-day-subtitle").parentElement : null;
  const taskList = document.getElementById("plan-tasks-list");
  const readBtn = document.getElementById("plan-start-reading-container");

  if (carousel) carousel.classList.add("hidden");
  if (planDayHeader) planDayHeader.classList.add("hidden");
  if (taskList) taskList.classList.add("hidden");
  if (readBtn) readBtn.classList.add("hidden");

  // Show inline reader container
  const inlineReader = document.getElementById("plan-inline-reader");
  if (inlineReader) inlineReader.classList.remove("hidden");

  initInlineReaderBottomDwell();
  renderInlineScriptureText();
};

window.closePlanInlineReader = async function () {
  state.inlineReader.active = false;
  document.body.classList.remove("plan-inline-reader-open");
  inlineReaderBottomDwellController?.cancel();
  inlineReaderEndObserver?.disconnect();
  inlineReaderEndObserver = null;
  inlineReaderEndVisible = false;

  // Show checklist interface elements
  const carousel = document.getElementById("plan-date-carousel");
  const planDayHeader = document.getElementById("plan-day-subtitle") ? document.getElementById("plan-day-subtitle").parentElement : null;
  const taskList = document.getElementById("plan-tasks-list");
  const readBtn = document.getElementById("plan-start-reading-container");

  if (carousel) carousel.classList.remove("hidden");
  if (planDayHeader) planDayHeader.classList.remove("hidden");
  if (taskList) taskList.classList.remove("hidden");
  if (readBtn) readBtn.classList.remove("hidden");

  // Hide inline reader container
  const inlineReader = document.getElementById("plan-inline-reader");
  if (inlineReader) inlineReader.classList.add("hidden");

  // Re-render checklist and date carousel to show checked updates immediately
  calculatePlanProgress();
  if (typeof renderHorizontalDateStrip === "function") renderHorizontalDateStrip();
  await renderPlanScheduleTracker(true);
};

async function renderInlineScriptureText() {
  const currentCh = state.inlineReader.chaptersList[state.inlineReader.currentIndex];
  if (!currentCh) return;

  state.inlineReader.autoMarked = false;
  state.inlineReader.autoMarkInFlight = false;
  inlineReaderBottomDwellController?.reset();
  inlineReaderEndObserver?.disconnect();
  inlineReaderEndObserver = null;
  inlineReaderEndVisible = false;

  // Set Title
  const titleEl = document.getElementById("plan-inline-reader-title");
  if (titleEl) titleEl.textContent = `${currentCh.book} ${currentCh.chapter}章`;

  // Set Footer text
  const footerPlanName = document.getElementById("plan-inline-footer-plan-name");
  const footerProgress = document.getElementById("plan-inline-footer-progress");

  if (footerPlanName) footerPlanName.textContent = state.activePlan.name;
  if (footerProgress) footerProgress.textContent = `第 ${state.inlineReader.dayNum} 天 • ${state.inlineReader.chaptersList.length} 之 ${state.inlineReader.currentIndex + 1}`;

  // Load verses
  const container = document.getElementById("plan-inline-bible-content");
  if (container) {
    container.innerHTML = typeof ComponentSkeletonLoader !== "undefined"
      ? ComponentSkeletonLoader.getHtml("reader")
      : "";

    const book = BIBLE_BOOKS.find(b => b.name === currentCh.book);
    if (book) {
      try {
        const data = await fetchBibleChapter(book.eng, currentCh.chapter);
        container.innerHTML = "";
        data.verses.forEach(v => {
          const verseDiv = document.createElement("div");
          verseDiv.className = "bible-verse";
          verseDiv.style.marginBottom = "0.8rem";
          verseDiv.innerHTML = `<span class="verse-num" style="font-weight: 500; color: var(--primary-color); margin-right: 0.5rem; font-size: 0.875rem;">${v.verse}</span><span class="verse-text" style="font-size: 1.05rem; line-height: 1.8;">${v.text}</span>`;
          container.appendChild(verseDiv);
        });
        const sentinel = document.createElement("div");
        sentinel.id = "plan-inline-reader-end-sentinel";
        sentinel.setAttribute("aria-hidden", "true");
        sentinel.style.cssText = "height:1px;width:100%;pointer-events:none;";
        container.appendChild(sentinel);
      } catch (err) {
        container.innerHTML = `<div class="text-danger" style="text-align: center; padding: 2rem;">載入經文失敗: ${err.message || err}</div>`;
      }
    }
  }

  bindInlineReaderEndObserver();

  // Prev / Next button states
  const prevBtn = document.getElementById("plan-inline-prev-btn");
  const nextBtn = document.getElementById("plan-inline-next-btn");

  if (prevBtn) {
    if (state.inlineReader.currentIndex === 0) {
      prevBtn.setAttribute("disabled", "true");
      prevBtn.style.opacity = "0.3";
      prevBtn.style.pointerEvents = "none";
    } else {
      prevBtn.removeAttribute("disabled");
      prevBtn.style.opacity = "1";
      prevBtn.style.pointerEvents = "auto";
    }
  }

  if (nextBtn) {
    if (state.inlineReader.currentIndex === state.inlineReader.chaptersList.length - 1) {
      nextBtn.setAttribute("disabled", "true");
      nextBtn.style.opacity = "0.3";
      nextBtn.style.pointerEvents = "none";
    } else {
      nextBtn.removeAttribute("disabled");
      nextBtn.style.opacity = "1";
      nextBtn.style.pointerEvents = "auto";
    }
  }

  // The plan detail page scrolls inside .main-content, not the browser window.
  const scrollSurface = document.querySelector(".main-content" );
  if (scrollSurface) scrollSurface.scrollTop = 0;
  scheduleInlineReaderBottomDwellCheck();
}

window.navigateInlineChapter = function (direction) {
  const newIndex = state.inlineReader.currentIndex + direction;
  if (newIndex >= 0 && newIndex < state.inlineReader.chaptersList.length) {
    state.inlineReader.currentIndex = newIndex;
    renderInlineScriptureText();
  }
};

// Window scroll listener for inline reader automatic check-in has been removed to prevent screen jumping and layout shift.


// ==================== PERSONAL STATS & HEATMAP & ACHIEVEMENTS ====================
// ==================== PERSONAL STATS & HEATMAP & ACHIEVEMENTS ====================
// ==================== CASCADING SELECTORS HELPER ====================
// A user's org placement (great_region/pastoral_zone/small_group, and the
// managed_* delegation columns derived from it) is synced from a DIFFERENT
// Member Hub field than their leadership role. A leadership *assignment*
// ("this person leads 大安小組") can exist even when their own personal
// placement is blank/unset — so before concluding a leader has no org data
// at all, also check member_context_leadership_assignments, which records
// exactly which unit(s) each of their leadership roles applies to.
function getLeadershipAssignmentNodeNames(user, levelName) {
  const assignments = Array.isArray(user && user.member_context_leadership_assignments)
    ? user.member_context_leadership_assignments
    : [];
  const matches = assignments.filter(a => a && a.levelName === levelName && a.nodeName);
  if (matches.length === 0) return "";
  const primary = matches.find(a => a.isPrimary);
  return String((primary || matches[0]).nodeName || "").trim();
}

function setupCascadingSelectors(regionId, zoneId, groupId, masterId) {
  const regionSelect = document.getElementById(regionId);
  const zoneSelect = document.getElementById(zoneId);
  const groupSelect = document.getElementById(groupId);
  const masterSelect = document.getElementById(masterId);

  if (!regionSelect || !zoneSelect || !groupSelect || !masterSelect) return;

  if (regionSelect.dataset.orgStructureRefreshBound !== "true") {
    regionSelect.dataset.orgStructureRefreshBound = "true";
    window.addEventListener("org-structure-updated", () => {
      if (!regionSelect.isConnected) return;
      delete regionSelect.dataset.populatedFor;
      setupCascadingSelectors(regionId, zoneId, groupId, masterId);
    });
  }

  const previousSelection = {
    region: regionSelect.value,
    zone: zoneSelect.value,
    group: groupSelect.value
  };
  const preservePreviousSelection = Boolean(regionSelect.dataset.populatedFor);

  const userKey = state.currentUser ? [
    state.currentUser.id || state.currentUser.name,
    getUserRoleCode(state.currentUser),
    state.currentUser.managed_regions || state.currentUser.great_region || "",
    state.currentUser.managed_zones || state.currentUser.pastoral_zone || "",
    state.currentUser.managed_groups || state.currentUser.small_group || "",
    Number(state.orgStructure?.revision || 0)
  ].join("|") : "anonymous";
  // Skip rebuilding once already populated for this exact user/role. The
  // check used to also require regionSelect.options.length > 1, but
  // zone_leader/group_leader roles always render exactly one disabled
  // region option by design (js/modules/plan.js populateGroups/populateZones
  // "else" branches), so that length check never became true for them.
  // Every subsequent re-render (e.g. after the group/zone/region "change"
  // handler calls renderPlanMembersView -> populateMembersSelector) then
  // wiped and rebuilt the selects from scratch, snapping the value back to
  // the default and making the filter look unresponsive.
  if (regionSelect.dataset.populatedFor === userKey) return;

  regionSelect.dataset.populated = "true";
  regionSelect.dataset.populatedFor = userKey;

  // Reset disabled states for fresh population
  regionSelect.disabled = false;
  zoneSelect.disabled = false;
  groupSelect.disabled = false;

  const userRole = (state.currentUser && getUserRoleCode(state.currentUser)) || "member";
  const isAdmin = hasWholeChurchPlanScope(userRole);
  const isGreatZoneLeader = userRole === "great_zone_leader";
  const isZoneLeader = userRole === "zone_leader";
  const isGroupLeader = userRole === "group_leader";

  let isInitializing = true;

  // Hide selectors that exceed user's permission level
  if (isAdmin || isGreatZoneLeader) {
    regionSelect.style.display = "";
    zoneSelect.style.display = "";
    groupSelect.style.display = "";
  } else if (isZoneLeader) {
    regionSelect.style.display = "none";
    zoneSelect.style.display = "";
    groupSelect.style.display = "";
  } else if (isGroupLeader) {
    regionSelect.style.display = "none";
    zoneSelect.style.display = "none";
    groupSelect.style.display = "";
  } else {
    regionSelect.style.display = "none";
    zoneSelect.style.display = "none";
    groupSelect.style.display = "none";
  }

  // Get regions list
  let regions = state.orgStructure.regions || [];
  let myRegions = [];
  if (isGreatZoneLeader) {
    const userGreatRegion = (state.currentUser.managed_regions || state.currentUser.great_region
      || getLeadershipAssignmentNodeNames(state.currentUser, "大區") || "");
    myRegions = userGreatRegion.split(",").map(s => s.trim()).filter(Boolean);
    regions = regions.filter(r => myRegions.includes(r));
  }

  // Helper to get zones for a region
  function getZonesForRegion(rName) {
    if (!rName) return [];
    if (state.isSupabaseMode && state.orgStructure.rawZones && state.orgStructure.rawRegions) {
      const regionObj = state.orgStructure.rawRegions.find(r => r.name === rName);
      if (!regionObj) return [];
      return state.orgStructure.rawZones.filter(z => z.great_region_id === regionObj.id).map(z => z.name);
    }
    return state.orgStructure.zones[rName] || [];
  }

  // Helper to get groups for a zone
  function getGroupsForZone(zName) {
    if (!zName) return [];
    if (state.isSupabaseMode && state.orgStructure.rawGroups && state.orgStructure.rawZones) {
      const zoneObj = state.orgStructure.rawZones.find(z => z.name === zName);
      if (!zoneObj) return [];
      return state.orgStructure.rawGroups.filter(g => g.pastoral_zone_id === zoneObj.id).map(g => g.name);
    }
    return state.orgStructure.groups[zName] || [];
  }

  // Populate Regions
  regionSelect.innerHTML = "";
  if (isAdmin) {
    regionSelect.options.add(new Option("-- 請選擇大區 --", ""));
    regions.forEach(r => regionSelect.options.add(new Option(`大區：${r}`, `region:${r}`)));
    if (isInitializing) {
      const userGreatRegion = state.currentUser ? (state.currentUser.managed_regions || state.currentUser.great_region || "") : "";
      if (userGreatRegion) {
        regionSelect.value = "region:" + userGreatRegion;
      }
    }
  } else if (isGreatZoneLeader) {
    if (myRegions.length === 0) {
      // managed_regions and great_region are both blank — this leader has no
      // org placement to scope by. Say so explicitly instead of silently
      // showing an unlabeled "全部大區 ()" option that resolves to "show
      // everything", which just looks like broken/missing data on screen.
      regionSelect.options.add(new Option("⚠️ 尚未設定大區歸屬，請聯絡系統管理員", "unassigned"));
      regionSelect.disabled = true;
    } else {
      regionSelect.options.add(new Option(`全部大區 (${myRegions.join(",")})`, ""));
      myRegions.forEach(r => regionSelect.options.add(new Option(`大區：${r}`, `region:${r}`)));
      if (isInitializing && myRegions.length === 1) {
        regionSelect.value = "region:" + myRegions[0];
      }
    }
  } else {
    const userReg = (state.currentUser.managed_regions || state.currentUser.great_region || "");
    regionSelect.options.add(new Option(userReg ? `大區：${userReg}` : "大區", ""));
    regionSelect.disabled = true;
  }
  if (preservePreviousSelection
    && Array.from(regionSelect.options).some(option => option.value === previousSelection.region)) {
    regionSelect.value = previousSelection.region;
  }

  // Update Master Select Value
  // "unassigned" is a sentinel option shown when a leader has no org
  // placement set at all — treat it the same as no selection rather than
  // building a nonsense "group:unassigned" filter value.
  function updateMasterValue(isInitialCall = false) {
    let finalVal = "all";
    const selectedGroup = groupSelect.value === "unassigned" ? "" : groupSelect.value;
    const selectedZone = zoneSelect.value === "unassigned" ? "" : zoneSelect.value;
    const selectedRegion = regionSelect.value === "unassigned" ? "" : regionSelect.value;

    if (isGroupLeader) {
      finalVal = selectedGroup ? `group:${selectedGroup}` : "all_groups";
    } else if (isZoneLeader) {
      if (selectedGroup) finalVal = `group:${selectedGroup}`;
      else if (selectedZone) finalVal = `zone:${selectedZone}`;
      else finalVal = "all_zones";
    } else if (isGreatZoneLeader) {
      if (selectedGroup) finalVal = `group:${selectedGroup}`;
      else if (selectedZone) finalVal = `zone:${selectedZone}`;
      else if (selectedRegion) finalVal = selectedRegion;
      else finalVal = "all_great_region";
    } else if (isAdmin) {
      if (selectedGroup) finalVal = `group:${selectedGroup}`;
      else if (selectedZone) finalVal = `zone:${selectedZone}`;
      else if (selectedRegion) finalVal = selectedRegion;
      else finalVal = "all";
    }

    masterSelect.innerHTML = "";
    masterSelect.options.add(new Option(finalVal, finalVal));
    masterSelect.value = finalVal;
    if (!isInitialCall) masterSelect.dispatchEvent(new Event("change"));
  }

  // Handle Region Change
  regionSelect.onchange = () => {
    populateZones();
    populateGroups();
    updateMasterValue();
  };

  // Populate Zones
  function populateZones() {
    zoneSelect.innerHTML = "";
    zoneSelect.disabled = false;

    if (isAdmin) {
      const regVal = regionSelect.value;
      if (!regVal || regVal === "all") {
        zoneSelect.options.add(new Option("-- 請先選擇大區 --", ""));
        zoneSelect.disabled = true;
      } else {
        const rName = regVal.replace("region:", "");
        zoneSelect.options.add(new Option("全部牧區", ""));
        const zones = getZonesForRegion(rName);
        zones.sort().forEach(z => zoneSelect.options.add(new Option(`牧區：${z}`, z)));
        if (isInitializing) {
          const userZone = state.currentUser ? (state.currentUser.managed_zones || state.currentUser.pastoral_zone || "") : "";
          if (userZone && zones.includes(userZone)) {
            zoneSelect.value = userZone;
          }
        }
      }
    } else if (isGreatZoneLeader) {
      const regVal = regionSelect.value;
      if (!regVal || regVal === "all_great_region") {
        zoneSelect.options.add(new Option("-- 請選擇特定大區 --", ""));
        zoneSelect.disabled = true;
      } else {
        const rName = regVal.replace("region:", "");
        zoneSelect.options.add(new Option("全部牧區", ""));
        const zones = getZonesForRegion(rName);
        zones.sort().forEach(z => zoneSelect.options.add(new Option(`牧區：${z}`, z)));
        if (isInitializing) {
          const userZone = state.currentUser ? (state.currentUser.managed_zones || state.currentUser.pastoral_zone || "") : "";
          if (userZone && zones.includes(userZone)) {
            zoneSelect.value = userZone;
          }
        }
      }
    } else if (isZoneLeader) {
      const userZone = (state.currentUser.managed_zones || state.currentUser.pastoral_zone
        || getLeadershipAssignmentNodeNames(state.currentUser, "牧區") || "");
      const myZones = userZone.split(",").map(s => s.trim()).filter(Boolean);
      if (myZones.length > 1) {
        zoneSelect.options.add(new Option(`全部牧區 (${myZones.join(",")})`, ""));
        myZones.forEach(z => zoneSelect.options.add(new Option(`牧區：${z}`, z)));
      } else if (myZones.length === 1) {
        zoneSelect.options.add(new Option(`牧區：${myZones[0]}`, myZones[0]));
        zoneSelect.disabled = true;
      } else {
        // managed_zones and pastoral_zone are both blank — same "no org
        // placement" gap as the great_zone_leader case above.
        zoneSelect.options.add(new Option("⚠️ 尚未設定牧區歸屬，請聯絡系統管理員", "unassigned"));
        zoneSelect.disabled = true;
      }
    } else {
      const userZone = (state.currentUser.managed_zones || state.currentUser.pastoral_zone || "");
      zoneSelect.options.add(new Option(userZone ? `牧區：${userZone}` : "牧區", ""));
      zoneSelect.disabled = true;
    }
  }

  // Handle Zone Change
  zoneSelect.onchange = () => {
    populateGroups();
    updateMasterValue();
  };

  // Populate Groups
  function populateGroups() {
    groupSelect.innerHTML = "";
    groupSelect.disabled = false;

    const zoneVal = zoneSelect.value;
    if (isAdmin || isGreatZoneLeader) {
      if (!zoneVal) {
        groupSelect.options.add(new Option("-- 請先選擇牧區 --", ""));
        groupSelect.disabled = true;
      } else {
        groupSelect.options.add(new Option("全部小組", ""));
        const groups = getGroupsForZone(zoneVal);
        groups.sort().forEach(g => groupSelect.options.add(new Option(`小組：${g}`, g)));
        if (isInitializing) {
          const userGroup = state.currentUser ? (state.currentUser.managed_groups || state.currentUser.small_group || "") : "";
          if (userGroup && groups.includes(userGroup)) {
            groupSelect.value = userGroup;
          }
        }
      }
    } else if (isZoneLeader) {
      const userZone = (state.currentUser.managed_zones || state.currentUser.pastoral_zone || "");
      const myZones = userZone.split(",").map(s => s.trim()).filter(Boolean);
      const activeZone = zoneVal || (myZones.length === 1 ? myZones[0] : "");
      if (!activeZone) {
        groupSelect.options.add(new Option("-- 請先選擇牧區 --", ""));
        groupSelect.disabled = true;
      } else {
        groupSelect.options.add(new Option("全部小組", ""));
        const groups = getGroupsForZone(activeZone);
        groups.sort().forEach(g => groupSelect.options.add(new Option(`小組：${g}`, g)));
        if (isInitializing) {
          const userGroup = state.currentUser ? (state.currentUser.managed_groups || state.currentUser.small_group || "") : "";
          if (userGroup && groups.includes(userGroup)) {
            groupSelect.value = userGroup;
          }
        }
      }
    } else if (isGroupLeader) {
      const userGroup = (state.currentUser.managed_groups || state.currentUser.small_group
        || getLeadershipAssignmentNodeNames(state.currentUser, "小組") || "");
      const myGroups = userGroup.split(",").map(s => s.trim()).filter(Boolean);
      if (myGroups.length > 1) {
        groupSelect.options.add(new Option(`全部小組 (${myGroups.join(",")})`, ""));
        myGroups.forEach(g => groupSelect.options.add(new Option(`小組：${g}`, g)));
      } else if (myGroups.length === 1) {
        groupSelect.options.add(new Option(`小組：${myGroups[0]}`, myGroups[0]));
        groupSelect.disabled = true;
      } else {
        // managed_groups and small_group are both blank — this is the
        // scenario reported as "篩選器沒得選的小組長無法更新資料": the
        // dropdown used to silently show a blank "小組：" label with an
        // empty value, so the leader had nothing they could click and no
        // indication of why. Now it says plainly what's missing.
        groupSelect.options.add(new Option("⚠️ 尚未設定小組歸屬，請聯絡系統管理員", "unassigned"));
        groupSelect.disabled = true;
      }
    } else {
      groupSelect.options.add(new Option("小組", ""));
      groupSelect.disabled = true;
    }
  }

  groupSelect.onchange = () => {
    updateMasterValue();
  };

  // Initialize
  populateZones();
  if (preservePreviousSelection
    && Array.from(zoneSelect.options).some(option => option.value === previousSelection.zone)) {
    zoneSelect.value = previousSelection.zone;
  }
  populateGroups();
  if (preservePreviousSelection
    && Array.from(groupSelect.options).some(option => option.value === previousSelection.group)) {
    groupSelect.value = previousSelection.group;
  }

  // Set initial master select value mapping without triggering render loop
  updateMasterValue(true);

  isInitializing = false;
}

// ==================== STATS SELECTOR POPULATOR ====================
function populateStatsSelector() {
  const basicSelect = document.getElementById("stats-basic-scope-select");
  const regionSelect = document.getElementById("stats-admin-region-select");
  const zoneSelect = document.getElementById("stats-admin-zone-select");
  const groupSelect = document.getElementById("stats-admin-group-select");
  const rankingZoneSelector = document.getElementById("ranking-zone-selector");
  const canAdvanced = canUseAdvancedGroupStats();
  const myZone = (state.currentUser && state.currentUser.pastoral_zone || "").split(",")[0].trim();
  const zoneScope = myZone ? `zone:${myZone}` : "all";

  if (basicSelect && !basicSelect.dataset.initialized) {
    basicSelect.dataset.initialized = "true";
    basicSelect.addEventListener("change", async () => {
      const useAdvanced = basicSelect.value === "advanced";
      [regionSelect, zoneSelect, groupSelect].forEach(el => {
        if (el) el.style.display = canAdvanced && useAdvanced ? "" : "none";
      });
      window._statsTabScope = applyBasicStatsScope();
      if (rankingZoneSelector && window._statsTabScope) rankingZoneSelector.value = window._statsTabScope;
      await renderPlanStatsView();
    });
  }

  if (basicSelect) {
    const previous = basicSelect.value || zoneScope;
    basicSelect.innerHTML = "";
    basicSelect.options.add(new Option(myZone ? `\u6211\u7684\u7267\u5340\uFF1A${myZone}` : "\u6211\u7684\u7267\u5340", zoneScope));
    basicSelect.options.add(new Option("\u5168\u6559\u6703", "all"));
    if (canAdvanced) basicSelect.options.add(new Option("\u9032\u968E\u7BC4\u570D", "advanced"));
    basicSelect.value = [...basicSelect.options].some(o => o.value === previous) ? previous : zoneScope;
  }

  setupCascadingSelectors("stats-admin-region-select", "stats-admin-zone-select", "stats-admin-group-select", "ranking-zone-selector");

  const useAdvanced = canAdvanced && basicSelect && basicSelect.value === "advanced";
  [regionSelect, zoneSelect, groupSelect].forEach(el => {
    if (el) el.style.display = useAdvanced ? "" : "none";
  });
  window._statsTabScope = useAdvanced ? null : (basicSelect ? basicSelect.value : getDefaultGroupStatsScope());

  if (rankingZoneSelector && !rankingZoneSelector.dataset.listenerInitialized) {
    rankingZoneSelector.dataset.listenerInitialized = "true";
    rankingZoneSelector.addEventListener("change", async () => {
      if (basicSelect && basicSelect.value !== "advanced") return;
      window._statsTabScope = null;
      const tabStats = document.getElementById("tab-plan-stats");
      const tabRanking = document.getElementById("tab-plan-ranking");
      const tabMembers = document.getElementById("tab-plan-members");

      if (tabStats && tabStats.classList.contains("active")) {
        await renderPlanStatsView();
      } else if (tabRanking && tabRanking.classList.contains("active")) {
        await renderPlanRankingView();
      } else if (tabMembers && tabMembers.classList.contains("active")) {
        await renderPlanMembersView();
      }
    });
  }
}
// ==================== ORG FILTER UTILITY ====================
function getActiveOrgFilter() {
  const regionSelect = document.getElementById("members-admin-region-select");
  const zoneSelect = document.getElementById("members-admin-zone-select");
  const groupSelect = document.getElementById("members-admin-group-select");
  if (!regionSelect || !zoneSelect || !groupSelect) return "all";

  const role = (state.currentUser && getUserRoleCode(state.currentUser)) || "member";
  const selectedGroup = groupSelect.value === "unassigned" ? "" : groupSelect.value;
  const selectedZone = zoneSelect.value === "unassigned" ? "" : zoneSelect.value;
  const selectedRegion = regionSelect.value === "unassigned" ? "" : regionSelect.value;
  if (selectedGroup) return `group:${selectedGroup}`;
  if (selectedZone) return `zone:${selectedZone}`;
  if (selectedRegion) return selectedRegion;
  if (role === "group_leader") return "all_groups";
  if (role === "zone_leader") return "all_zones";
  if (role === "great_zone_leader") return "all_great_region";
  return "all";
}

// ==================== MEMBERS SELECTOR POPULATOR ====================
// Drives the collapsed 查看範圍 trigger's preview text (admin-plan-filter-card--org
// in index.html) so an admin can see the current scope without expanding it.
// Harmless no-op when that trigger isn't on screen (e.g. the 組員狀況/計畫統計
// subviews reuse the same three selects without this collapsed wrapper).
function updateAdminPlanFilterSummary() {
  const summaryText = document.getElementById("admin-plan-filter-summary-text");
  if (!summaryText) return;
  const parts = ["members-admin-region-select", "members-admin-zone-select", "members-admin-group-select"]
    .map(id => document.getElementById(id))
    .filter(select => select && !select.disabled && select.value && select.value !== "unassigned")
    .map(select => select.options[select.selectedIndex]?.text || "")
    .filter(Boolean);
  summaryText.textContent = parts.length ? `查看範圍：${parts.join(" · ")}` : "查看範圍：全部";
}

function populateMembersSelector() {
  setupCascadingSelectors("members-admin-region-select", "members-admin-zone-select", "members-admin-group-select", "members-zone-selector");

  // Direct bindings to guarantee that any dropdown selection change immediately updates stats
  const regionSelect = document.getElementById("members-admin-region-select");
  const zoneSelect = document.getElementById("members-admin-zone-select");
  const groupSelect = document.getElementById("members-admin-group-select");

  [regionSelect, zoneSelect, groupSelect].forEach(el => {
    if (el && !el.dataset.directListenerBound) {
      el.dataset.directListenerBound = "true";
      el.addEventListener("change", async () => {
        updateAdminPlanFilterSummary();
        await renderPlanMembersView();
        if (typeof window.refreshAdminTeamRegistrationFilters === "function") {
          await window.refreshAdminTeamRegistrationFilters();
        }
      });
    }
  });

  const membersZoneSelector = document.getElementById("members-zone-selector");
  if (membersZoneSelector && !membersZoneSelector.dataset.listenerInitialized) {
    membersZoneSelector.dataset.listenerInitialized = "true";
    membersZoneSelector.addEventListener("change", async () => {
      await renderPlanMembersView();
      if (typeof window.refreshAdminTeamRegistrationFilters === "function") {
        await window.refreshAdminTeamRegistrationFilters();
      }
    });
  }

  updateAdminPlanFilterSummary();
}

async function renderPlanStatsView() {
  if (typeof window.syncActivePlanContext === 'function') window.syncActivePlanContext();
  if (!state.activePlan) return;

  const personalSec = document.getElementById("stats-personal-section");
  const groupSec = document.getElementById("stats-group-section");
  const currentTab = window._currentStatsTab || 'personal';

  if (currentTab !== 'personal' && !(await prepareReadingTeamSubview("stats"))) return;
  populateStatsSelector();
  if (currentTab === 'personal') {
    const teamSwitcher = document.getElementById("stats-team-view-switch");
    const teamInline = document.getElementById("reading-team-stats-inline");
    const regContainer = document.getElementById("reading-team-registration-inline");
    if (teamSwitcher) teamSwitcher.classList.add("hidden");
    if (teamInline) teamInline.classList.add("hidden");
    if (regContainer) regContainer.classList.add("hidden");
    // Show personal, hide group
    if (personalSec) personalSec.classList.remove("hidden");
    if (groupSec) groupSec.classList.add("hidden");

    // Set User Profile names
    const statsUserName = document.getElementById("stats-user-name");
    const reportPlanTitle = document.getElementById("report-plan-title");

    const userName = state.currentUser.name || "弟兄姊妹";
    if (statsUserName) statsUserName.textContent = userName;
    if (reportPlanTitle) reportPlanTitle.textContent = state.activePlan.name;

    // Personal Streak val —— 這個計畫自己的最長連續打卡天數，不混用全域 streak。
    const personalStreak = computePlanScopedStreak(state.readingLogs || [], {
      planId: state.activePlan.id,
      presetKey: state.activePlan.presetKey
    });

    // 1. Highest streak (最高連續)
    const reportStatStreak = document.getElementById("report-stat-streak");
    if (reportStatStreak) reportStatStreak.textContent = personalStreak;

    const currentRound = state.activePlan.currentRound || 1;
    const totalPlanDays = state.activePlan.days.length;

    // Helper: count completed days for a given round
    const countCompletedDaysForRound = (rTarget) => {
      return state.activePlan.days.filter(d => {
        if (!d.chapters || d.chapters.length === 0) return false;
        // 同一份日程；某一遍完成 = 每章都有 isReadR{rTarget}。
        return d.chapters.every(ch => Boolean(ch["isReadR" + rTarget] || (rTarget === 1 && ch.isRead)));
      }).length;
    };

    // 2. Total completed (累計完成)
    // Round 2+: freeze display at round-1 completion total (which should be 100%)
    const completedR1 = countCompletedDaysForRound(1);
    const completedCurrentRound = countCompletedDaysForRound(currentRound);
    const displayCompletedDays = currentRound > 1 ? totalPlanDays : completedR1;

    const reportStatCompleted = document.getElementById("report-stat-completed");
    if (reportStatCompleted) reportStatCompleted.textContent = displayCompletedDays;

    const reportStatStartDate = document.getElementById("report-stat-start-date");
    if (reportStatStartDate) {
      const pDate = new Date(state.activePlan.startDate);
      if (!isNaN(pDate)) {
        reportStatStartDate.textContent = `從 ${pDate.getFullYear()}年${pDate.getMonth() + 1}月${pDate.getDate()}日起`;
      } else {
        reportStatStartDate.textContent = `從 ${state.activePlan.startDate} 起`;
      }
    }

    // 3. Progress Status（落後/超前只在第一遍；之後只顯示輪次進度 —— 見 getPlanProgressStatus）
    const reportStatProgressStatus = document.getElementById("report-stat-progress-status");
    if (reportStatProgressStatus) {
      const progressStatus = getPlanProgressStatus(state.activePlan);
      reportStatProgressStatus.textContent = progressStatus.label;
      reportStatProgressStatus.className = "stat-badge " + progressStatus.badgeClass;
    }

    // 4. Makeup/Catch up days (🛡️ 進度救援)
    // 一律對「教會原始日程」算，只看第一遍的 log（第一遍之後 log 不再變，數值自然凍結）。
    const toLocalStr = window.toLocalYYYYMMDD || ((val) => {
      if (!val) return "";
      const date = val instanceof Date ? val : new Date(val);
      if (Number.isNaN(date.getTime())) return "";
      return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    });
    const round1DateByChapter = new Map();
    (state.readingLogs || []).forEach(l => {
      if ((l.plan_id === state.activePlan.id || l.presetKey === state.activePlan.presetKey) && (l.round || 1) === 1) {
        round1DateByChapter.set(`${l.book}_${l.chapter}`, toLocalStr(l.read_at));
      }
    });
    const canonicalDays = typeof window.getCanonicalStageScheduleDays === "function"
      ? window.getCanonicalStageScheduleDays(state.activePlan)
      : (state.activePlan.days || []);
    const catchUpDaysVal = countLateCompletedDays(canonicalDays, state.activePlan.startDate, round1DateByChapter);
    const reportStatMakeup = document.getElementById("report-stat-makeup");
    if (reportStatMakeup) reportStatMakeup.textContent = catchUpDaysVal;
    const makeupCard = document.getElementById("report-stat-makeup-card");
    if (makeupCard) {
      makeupCard.classList.toggle("stat-bento--danger-active", catchUpDaysVal > 0);
    }

    // 5. Cumulative chapters read (累積閱讀章數) — 所有遍次累計，不重置。
    // 嚴格以「這個計畫」為範圍：比對 plan_id / global_plan_id / presetKey / preset_key，
    // 四個都沒有的舊日誌才當「無歸屬」退路計入（與 calculateAllPlansProgress 同一套規則）。
    // 不能再用「沒有 plan_id 就算這個計畫」的寬鬆退路——那會把別的計畫（例如 8 月
    // 正辦階段，帶 global_plan_id 但沒有 camelCase 的 plan_id）的打卡混進來，
    // 導致總章數超過本計畫實際卷數（出埃及記只有 40 章卻顯示 45）。
    const reportStatTotalChapters = document.getElementById("report-stat-total-chapters");
    if (reportStatTotalChapters) {
      const planIds = [state.activePlan.id, state.activePlan.globalPlanId, state.activePlan.global_plan_id]
        .filter(Boolean).map(String);
      const planKeys = [state.activePlan.presetKey, state.activePlan.preset_key]
        .filter(Boolean).map(String);
      const uniqueKeys = new Set();
      if (state.readingLogs) {
        state.readingLogs.forEach(l => {
          const logPlanId = l.plan_id || l.global_plan_id;
          const logKey = l.presetKey || l.preset_key;
          const logMatchesPlan =
            (logPlanId && planIds.includes(String(logPlanId))) ||
            (logKey && planKeys.includes(String(logKey))) ||
            (!l.plan_id && !l.global_plan_id && !l.presetKey && !l.preset_key);
          if (logMatchesPlan) {
            // 每一遍各章節分開計算，累積跨遍次總章數
            const r = l.round || 1;
            uniqueKeys.add(`${l.book}_${l.chapter}_${r}`);
          }
        });
      }
      reportStatTotalChapters.textContent = uniqueKeys.size;
    }

    // Render heatmap, trend chart, and badges wall
    renderPersonalHeatmap();
    renderPersonalTrendChart();
    renderPersonalUnlockedBadges();
  } else {
    // Show group, hide personal
    if (personalSec) personalSec.classList.add("hidden");
    if (groupSec) groupSec.classList.remove("hidden");

    // Render Group Stats
    await renderPlanHistoryView();
  }
}

async function renderPlanHistoryView() {
  if (!state.activePlan) return;

  // 1. Render Group Rankings/Participants table at top (Wait, the ranking table is no longer at top of stats, but we still trigger it to update scoped user list)
  await renderGroupParticipantsRankingTable();

  // 2. Render group mini-cards and stats
  await renderGroupMiniStats();

  // 4. Render pastoral ranking bar chart
  renderGroupPastoralChart();

  // 5. Render small group chart (with zone selector)
  renderGroupZoneChartWithSelector();

  // 6. Render 7-day growth trend line chart
  renderGroupGrowthTrend();

  // 7. Render team heatmap
  renderGroupTeamHeatmap();

  // 7.5 Render Group Progress Distribution (only visible on Admin tab)
  const distCard = document.getElementById("grp-distribution-card");
  if (distCard) {
    if (window._currentStatsTab === 'admin') {
      distCard.classList.remove("hidden");
      distCard.style.display = "";
      renderGroupProgressDistribution();
    } else {
      distCard.classList.add("hidden");
      distCard.style.display = "none";
    }
  }

  // 8. Render Bible Pilgrimage Trail canvas
  // Pilgrimage Card is strictly moved to Reading Team Inline view, completely removed from Admin / Group Stats.
}

async function renderGroupMiniStats(overrideFilter) {
  if (!state.activePlan) return;

  let allUsers = [];
  try {
    allUsers = await db.fetchMergedUsersList();
  } catch (e) {
    console.warn('Failed to fetch users for group stats mini-cards', e);
  }

  // Use the selector's scoped users if available, otherwise fallback to user's scope.
  // Priority: explicit overrideFilter param → _statsTabScope → cached _grpScopedUsers → default scope
  let scopedUsers = window._grpScopedUsers;
  const effectiveFilter = overrideFilter !== undefined ? overrideFilter : window._statsTabScope;
  if (effectiveFilter !== null && effectiveFilter !== undefined && allUsers.length > 0) {

    if (effectiveFilter === "all") {
      scopedUsers = allUsers;
    } else if (effectiveFilter === "me") {
      scopedUsers = allUsers.filter(u => u.name === state.currentUser.name);
    } else if (effectiveFilter === "all_groups") {
      const userGroupStr = state.currentUser.managed_groups || state.currentUser.small_group
        || getLeadershipAssignmentNodeNames(state.currentUser, "小組") || "";
      const myGroups = userGroupStr.split(",").map(value => value.trim()).filter(Boolean);
      scopedUsers = allUsers.filter(u => myGroups.includes(u.small_group));
    } else if (effectiveFilter === "all_great_region") {
      const userGreatRegion = state.currentUser.managed_regions || state.currentUser.great_region
        || getLeadershipAssignmentNodeNames(state.currentUser, "大區") || "";
      const myRegions = userGreatRegion.split(",").map(s => s.trim()).filter(Boolean);
      scopedUsers = allUsers.filter(u => myRegions.includes(u.great_region));
    } else if (effectiveFilter === "all_zones") {
      const userZoneStr = state.currentUser.managed_zones || state.currentUser.pastoral_zone
        || getLeadershipAssignmentNodeNames(state.currentUser, "牧區") || "";
      const myZones = userZoneStr.split(",").map(s => s.trim()).filter(Boolean);
      scopedUsers = allUsers.filter(u => myZones.includes(u.pastoral_zone));
    } else if (effectiveFilter.startsWith("region:")) {
      const region = effectiveFilter.replace("region:", "");
      scopedUsers = allUsers.filter(u => u.great_region === region);
    } else if (effectiveFilter.startsWith("group:")) {
      const group = effectiveFilter.replace("group:", "");
      scopedUsers = allUsers.filter(u => u.small_group === group);
    } else if (effectiveFilter.startsWith("zone:")) {
      const zone = effectiveFilter.replace("zone:", "");
      scopedUsers = allUsers.filter(u => u.pastoral_zone === zone);
    }
  } else if (scopedUsers === undefined) {
    scopedUsers = getScopedUsers(allUsers, state.currentUser);
  }
  if (!scopedUsers) scopedUsers = [];


  const totalChapters = scopedUsers.reduce((sum, u) => sum + (u.chapters_read || 0), 0);
  const totalMembers = scopedUsers.length;
  const totalActive = scopedUsers.filter(u => (u.chapters_read || 0) > 0 || Boolean(u.last_read)).length;

  // Determine current scope label from selector
  let scopeLabel = "全教會";
  const rankingZoneSelector = document.getElementById("ranking-zone-selector");
  const selectedFilter = overrideFilter !== undefined
    ? overrideFilter
    : (window._statsTabScope !== null
      ? window._statsTabScope
      : (rankingZoneSelector ? rankingZoneSelector.value : null));

  if (selectedFilter) {
    if (selectedFilter === "all") {
      scopeLabel = "全教會";
    } else if (selectedFilter === "all_great_region") {
      scopeLabel = state.currentUser.great_region || "大區";
    } else if (selectedFilter === "all_zones") {
      scopeLabel = state.currentUser.pastoral_zone || "牧區";
    } else if (selectedFilter === "all_groups") {
      scopeLabel = state.currentUser.small_group || "小組";
    } else if (selectedFilter.startsWith("region:")) {
      scopeLabel = selectedFilter.replace("region:", "");
    } else if (selectedFilter.startsWith("zone:")) {
      scopeLabel = selectedFilter.replace("zone:", "");
    } else if (selectedFilter.startsWith("group:")) {
      scopeLabel = selectedFilter.replace("group:", "");
    }
  } else {
    // If no selector filter is loaded yet, guess label from user role
    const userRole = getUserRoleCode(state.currentUser) || "member";
    if (hasWholeChurchPlanScope(userRole)) {
      scopeLabel = "全教會";
    } else if (userRole === "great_zone_leader") {
      scopeLabel = state.currentUser.great_region || "大區";
    } else if (userRole === "zone_leader") {
      scopeLabel = state.currentUser.pastoral_zone || "牧區";
    } else {
      scopeLabel = state.currentUser.small_group || "小組";
    }
  }

  // Update labels based on scope
  const labelTotal = document.getElementById('grp-label-total-read');
  const labelMembers = document.getElementById('grp-label-members');
  const labelActive = document.getElementById('grp-label-active');

  if (labelTotal) labelTotal.textContent = scopeLabel === "全教會" ? '全教會總閱讀章數' : `${scopeLabel} 總閱讀章數`;
  if (labelMembers) labelMembers.textContent = scopeLabel === "全教會" ? '全教會參與人數' : `${scopeLabel} 參與人數`;
  if (labelActive) labelActive.textContent = scopeLabel === "全教會" ? '每日活躍' : `${scopeLabel} 每日活躍`;

  const elTotal = document.getElementById('grp-total-read');
  const elMembers = document.getElementById('grp-total-members');
  const elActive = document.getElementById('grp-active-members');

  if (elTotal) elTotal.textContent = totalChapters;
  if (elMembers) elMembers.textContent = totalMembers;
  if (elActive) elActive.textContent = totalActive;

  // Also stash for charts
  window._grpScopedUsers = scopedUsers;
  window._grpAllUsers = allUsers;
}

function renderGroupProgressDistribution(overrideFilter) {
  const scopedUsers = window._grpScopedUsers || [];
  const totalCount = scopedUsers.length;

  let titleSuffix = "團體進度狀態分佈";
  const rankingZoneSelector = document.getElementById("ranking-zone-selector");
  const selectedFilter = overrideFilter !== undefined
    ? overrideFilter
    : (window._statsTabScope !== null
      ? window._statsTabScope
      : (rankingZoneSelector ? rankingZoneSelector.value : null));

  if (selectedFilter) {
    if (selectedFilter === "all") titleSuffix = "全教會進度狀態分佈";
    else if (selectedFilter === "all_great_region") titleSuffix = `${state.currentUser.great_region || "大區"}進度狀態分佈`;
    else if (selectedFilter === "all_zones") titleSuffix = `${state.currentUser.pastoral_zone || "牧區"}進度狀態分佈`;
    else if (selectedFilter === "all_groups") titleSuffix = `${state.currentUser.small_group || "小組"}進度狀態分佈`;
    else if (selectedFilter.startsWith("region:")) titleSuffix = `${selectedFilter.replace("region:", "")}大區進度狀態分佈`;
    else if (selectedFilter.startsWith("zone:")) titleSuffix = `${selectedFilter.replace("zone:", "")}牧區進度狀態分佈`;
    else if (selectedFilter.startsWith("group:")) titleSuffix = `${selectedFilter.replace("group:", "")}小組進度狀態分佈`;
  }

  let expectedPct = 50;
  if (state.activePlan) {
    const start = new Date(state.activePlan.startDate + "T00:00:00");
    const end = new Date(state.activePlan.endDate + "T00:00:00");
    const totalDays = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const elapsed = Math.max(0, Math.min(totalDays, Math.round((today - start) / (1000 * 60 * 60 * 24)) + 1));
    expectedPct = Math.round((elapsed / totalDays) * 100) || 0;
  }

  const toLocalStr = window.toLocalYYYYMMDD || ((val) => {
    if (!val) return "";
    const date = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(date.getTime())) return "";
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  });
  const todayStr = toLocalStr(new Date());
  const todayDoneCount = scopedUsers.filter(u => u.last_read === todayStr).length;
  const todayRate = totalCount ? Math.round((todayDoneCount / totalCount) * 100) : 0;
  const totalChapters = scopedUsers.reduce((sum, u) => sum + (u.chapters_read || 0), 0);
  const dailyActiveCount = scopedUsers.filter(u => u.last_read === todayStr).length;

  let aheadCount = 0;
  let onCount = 0;
  let behindCount = 0;
  let rereadCount = 0;

  scopedUsers.forEach(u => {
    const currentRound = u.current_round !== undefined
      ? u.current_round
      : (u.chapters_read > 850 ? 3 : u.chapters_read > 500 ? 2 : 1);
    if (currentRound >= 2) {
      rereadCount++;
      aheadCount++;
      return;
    }

    if (u.plan_progress === 0) behindCount++;
    else if (u.plan_progress > expectedPct + 5) aheadCount++;
    else if (u.plan_progress < expectedPct - 5) behindCount++;
    else onCount++;
  });

  const behindPct = totalCount ? Math.round((behindCount / totalCount) * 100) : 0;
  const onPct = totalCount ? Math.round((onCount / totalCount) * 100) : 0;
  const aheadPct = totalCount ? Math.round((aheadCount / totalCount) * 100) : 0;

  // Direct DOM Updates for Group Stats Bento Cards
  const elTotal = document.getElementById('grp-total-read');
  const elMembers = document.getElementById('grp-total-members');
  const elActive = document.getElementById('grp-active-members');
  const elBehindCount = document.getElementById('grp-behind-count');
  const elReread = document.getElementById('grp-reread-count');

  if (elTotal) elTotal.textContent = totalChapters;
  if (elMembers) elMembers.textContent = totalCount;
  if (elActive) elActive.textContent = dailyActiveCount;
  if (elBehindCount) elBehindCount.textContent = behindCount;
  if (elReread) elReread.textContent = rereadCount;

  // Update segments of three-color progress bar
  const barBehind = document.getElementById('grp-today-bar-behind');
  const barOn = document.getElementById('grp-today-bar-on-schedule');
  const barAhead = document.getElementById('grp-today-bar-ahead');

  if (barBehind) {
    barBehind.style.width = `${behindPct}%`;
    barBehind.title = `落後: ${behindCount} 人 (${behindPct}%)`;
  }
  if (barOn) {
    barOn.style.width = `${onPct}%`;
    barOn.title = `在進度上: ${onCount} 人 (${onPct}%)`;
  }
  if (barAhead) {
    barAhead.style.width = `${aheadPct}%`;
    barAhead.title = `超前: ${aheadCount} 人 (${aheadPct}%)`;
  }
}

function renderGroupPastoralChart() {
  return; // Disabled
}

function renderGroupZoneChartWithSelector() {
  // Merged into renderGroupPastoralChart above
  return;
}

function renderGroupGrowthTrend(overrideFilter) {
  const scopedUsers = window._grpScopedUsers || [];
  const chartCard = document.getElementById('grp-daily-active-chart-card');
  const titleEl = document.getElementById('grp-daily-active-chart-title');
  const canvasEl = document.getElementById('grp-daily-active-chart');

  if (!canvasEl) return;

  // Hide chart if no data
  if (scopedUsers.length === 0) {
    if (chartCard) chartCard.style.display = 'none';
    return;
  }
  if (chartCard) chartCard.style.display = '';

  // Update title based on scope
  if (titleEl) {
    const rankingZoneSelector = document.getElementById('ranking-zone-selector');
    const selectedFilter = overrideFilter !== undefined
      ? overrideFilter
      : (window._statsTabScope !== null
        ? window._statsTabScope
        : (rankingZoneSelector ? rankingZoneSelector.value : null));
    let scopeLabel = '全教會';
    if (selectedFilter) {
      if (selectedFilter === 'all') scopeLabel = '全教會';
      else if (selectedFilter === 'all_great_region') scopeLabel = state.currentUser.great_region || '大區';
      else if (selectedFilter === 'all_zones') scopeLabel = state.currentUser.pastoral_zone || '牧區';
      else if (selectedFilter === 'all_groups') scopeLabel = state.currentUser.small_group || '小組';
      else if (selectedFilter.startsWith('region:')) scopeLabel = selectedFilter.replace('region:', '');
      else if (selectedFilter.startsWith('zone:')) scopeLabel = selectedFilter.replace('zone:', '');
      else if (selectedFilter.startsWith('group:')) scopeLabel = selectedFilter.replace('group:', '');
    } else {
      const userRole = getUserRoleCode(state.currentUser) || 'member';
      if (hasWholeChurchPlanScope(userRole)) scopeLabel = '全教會';
      else if (userRole === 'great_zone_leader') scopeLabel = state.currentUser.great_region || '大區';
      else if (userRole === 'zone_leader') scopeLabel = state.currentUser.pastoral_zone || '牧區';
      else scopeLabel = state.currentUser.small_group || '小組';
    }
    titleEl.textContent = `${scopeLabel} 每日活躍人數（近30天）`;
  }

  // Build 30-day window
  const today = new Date();
  const labels = [];
  const data = [];
  const DAYS = 30;

  const userIds = new Set(scopedUsers.map(u => u.id).filter(Boolean));
  const userNames = new Set(scopedUsers.map(u => u.name).filter(Boolean));
  const scopedPlanIds = new Set(scopedUsers.map(u => u.plan_id).filter(Boolean));
  const currentPlanId = state.activePlan && state.activePlan.id;
  const currentPresetKey = state.activePlan && state.activePlan.presetKey;

  // Build per-day unique user sets from logs
  const activeByDate = {}; // date string -> Set of user_id / name

  if (state.isSupabaseMode && state.allLogsCache) {
    state.allLogsCache.forEach(log => {
      if (!log.read_at) return;
      if (!userIds.has(log.user_id)) return;
      if (scopedPlanIds.size > 0) {
        if (!scopedPlanIds.has(log.plan_id)) return;
      } else if (!logMatchesPlan(log, currentPlanId, currentPresetKey)) {
        return;
      }
      const dStr = log.read_at.substring(0, 10);
      if (!activeByDate[dStr]) activeByDate[dStr] = new Set();
      activeByDate[dStr].add(log.user_id || log.name);
    });
  } else {
    (state.readingLogs || []).forEach(log => {
      if (!log.read_at) return;
      const nameMatch = log.name ? userNames.has(log.name) : true;
      if (!nameMatch) return;
      if (!logMatchesPlan(log, currentPlanId, currentPresetKey)) return;
      const dStr = log.read_at.substring(0, 10);
      if (!activeByDate[dStr]) activeByDate[dStr] = new Set();
      activeByDate[dStr].add(log.user_id || log.name);
    });
  }

  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dStr = typeof toTaiwanISODate === "function" ? toTaiwanISODate(d) : d.toISOString().substring(0, 10);
    const mmdd = dStr.substring(5).replace('-', '/');
    // Only show every 5th label to avoid crowding on mobile
    labels.push(i % 5 === 0 || i === 0 ? mmdd : '');
    data.push(activeByDate[dStr] ? activeByDate[dStr].size : 0);
  }

  const isDark = state.theme === 'dark' ||
    document.body.classList.contains('dark-theme') ||
    document.body.classList.contains('dark') ||
    document.documentElement.getAttribute('data-theme') === 'dark';
  const fontColor = isDark ? 'rgba(180,180,180,0.85)' : 'rgba(60,60,60,0.75)';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  const brandColor = '#04A9D2';
  const brandFill = isDark
    ? 'rgba(4,169,210,0.18)'
    : 'rgba(4,169,210,0.10)';

  renderOrUpdateChart('dailyActive', canvasEl, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '活躍人數',
        data,
        borderColor: brandColor,
        backgroundColor: brandFill,
        borderWidth: 2,
        fill: true,
        tension: 0.42,
        pointRadius: 2.5,
        pointBackgroundColor: brandColor,
        pointHoverRadius: 5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.parsed.y} 人`
          },
          backgroundColor: isDark ? 'rgba(30,30,35,0.92)' : 'rgba(255,255,255,0.95)',
          borderColor: brandColor,
          borderWidth: 1,
          titleColor: isDark ? '#fff' : '#111',
          bodyColor: isDark ? 'rgba(200,200,200,0.9)' : 'rgba(60,60,60,0.85)',
          padding: 10,
          cornerRadius: 8,
        }
      },
      scales: {
        x: {
          ticks: {
            color: fontColor,
            font: { size: 10 },
            maxRotation: 0,
          },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          ticks: {
            color: fontColor,
            font: { size: 10 },
            stepSize: 1,
            precision: 0,
          },
          grid: { color: gridColor },
          border: { display: false },
          beginAtZero: true,
        }
      }
    }
  });
}



function renderGroupTeamHeatmap(overrideFilter) {
  const scopedUsers = window._grpScopedUsers || [];
  const heatmapCard = document.getElementById("grp-heatmap-card");

  if (scopedUsers.length === 0) {
    if (heatmapCard) heatmapCard.style.display = "none";
    return;
  } else {
    if (heatmapCard) heatmapCard.style.display = "";
  }

  // Determine current scope label from selector
  let scopeLabel = "全教會";
  const rankingZoneSelector = document.getElementById("ranking-zone-selector");
  const selectedFilter = overrideFilter !== undefined
    ? overrideFilter
    : (window._statsTabScope !== null
      ? window._statsTabScope
      : (rankingZoneSelector ? rankingZoneSelector.value : null));

  if (selectedFilter) {
    if (selectedFilter === "all") {
      scopeLabel = "全教會";
    } else if (selectedFilter === "all_great_region") {
      scopeLabel = state.currentUser.great_region || "大區";
    } else if (selectedFilter === "all_zones") {
      scopeLabel = state.currentUser.pastoral_zone || "牧區";
    } else if (selectedFilter === "all_groups") {
      scopeLabel = state.currentUser.small_group || "小組";
    } else if (selectedFilter.startsWith("region:")) {
      scopeLabel = selectedFilter.replace("region:", "");
    } else if (selectedFilter.startsWith("zone:")) {
      scopeLabel = selectedFilter.replace("zone:", "");
    } else if (selectedFilter.startsWith("group:")) {
      scopeLabel = selectedFilter.replace("group:", "");
    }
  } else {
    const userRole = getUserRoleCode(state.currentUser) || "member";
    if (hasWholeChurchPlanScope(userRole)) {
      scopeLabel = "全教會";
    } else if (userRole === "great_zone_leader") {
      scopeLabel = state.currentUser.great_region || "大區";
    } else if (userRole === "zone_leader") {
      scopeLabel = state.currentUser.pastoral_zone || "牧區";
    } else {
      scopeLabel = state.currentUser.small_group || "小組";
    }
  }

  const titleEl = document.getElementById('grp-heatmap-title');
  if (titleEl) {
    titleEl.textContent = scopeLabel === "全教會"
      ? '全教會讀經活躍度 (計畫期間打卡活躍度)'
      : `${scopeLabel} 讀經活躍度 (計畫期間打卡活躍度)`;
  }

  const userIds = new Set(scopedUsers.map(u => u.id).filter(Boolean));
  const userNames = new Set(scopedUsers.map(u => u.name).filter(Boolean));
  const scopedPlanIds = new Set(scopedUsers.map(u => u.plan_id).filter(Boolean));
  const currentPlanId = state.activePlan && state.activePlan.id;
  const currentPresetKey = state.activePlan && state.activePlan.presetKey;

  const logsByDate = {};

  if (state.isSupabaseMode && state.allLogsCache) {
    // Supabase mode: use full log cache, filter by team users AND current plan
    state.allLogsCache.forEach(log => {
      if (!log.read_at) return;
      if (!userIds.has(log.user_id)) return;
      // Each participant has their own reading_plans.id for the same global plan.
      if (scopedPlanIds.size > 0) {
        if (!scopedPlanIds.has(log.plan_id)) return;
      } else if (!logMatchesPlan(log, currentPlanId, currentPresetKey)) {
        return;
      }
      const dStr = log.read_at.substring(0, 10);
      logsByDate[dStr] = (logsByDate[dStr] || 0) + 1;
    });
  } else {
    // Local / mock mode: filter state.readingLogs by plan
    (state.readingLogs || []).forEach(log => {
      if (!log.read_at) return;
      const nameMatch = log.name ? userNames.has(log.name) : true;
      if (!nameMatch) return;
      if (!logMatchesPlan(log, currentPlanId, currentPresetKey)) return;
      const dStr = log.read_at.substring(0, 10);
      logsByDate[dStr] = (logsByDate[dStr] || 0) + 1;
    });
  }
  const planStart = state.activePlan ? state.activePlan.startDate : null;
  const planEnd = state.activePlan ? state.activePlan.endDate : null;
  buildHeatmapGrid('grp-bible-heatmap-container', logsByDate, scopedUsers.length, '章', planStart, planEnd);
}

function logMatchesPlan(log, currentPlanId, currentPresetKey) {
  // 嚴格以「這個計畫」為範圍：plan_id / global_plan_id / presetKey / preset_key 任一
  // 對得上才算；四個都沒有的舊日誌才當「無歸屬」退路計入。不能用「沒有 plan_id
  // 就算這個計畫」的寬鬆退路——那會把別的計畫（帶 global_plan_id 但沒有 camelCase
  // plan_id）的打卡混進活躍度 / 累積章數（與 calculateAllPlansProgress 同一套規則）。
  const ap = state.activePlan || {};
  const planIds = [currentPlanId, ap.id, ap.globalPlanId, ap.global_plan_id].filter(Boolean).map(String);
  const planKeys = [currentPresetKey, ap.presetKey, ap.preset_key].filter(Boolean).map(String);
  const logPlanId = log.plan_id || log.global_plan_id;
  const logKey = log.presetKey || log.preset_key;
  return (logPlanId && planIds.includes(String(logPlanId))) ||
    (logKey && planKeys.includes(String(logKey))) ||
    (!log.plan_id && !log.global_plan_id && !log.presetKey && !log.preset_key);
}

function renderPersonalHeatmap() {
  // 只顯示當前計畫的閱讀記錄
  const currentPlanId = state.activePlan && state.activePlan.id;
  const currentPresetKey = state.activePlan && state.activePlan.presetKey;
  const logsByDate = {};
  (state.readingLogs || []).forEach(log => {
    if (!log.read_at) return;
    const matches = logMatchesPlan(log, currentPlanId, currentPresetKey);
    if (matches) {
      const dStr = log.read_at.substring(0, 10);
      logsByDate[dStr] = (logsByDate[dStr] || 0) + 1;
    }
  });
  const start = state.activePlan ? state.activePlan.startDate : null;
  const end = state.activePlan ? state.activePlan.endDate : null;
  buildHeatmapGrid("bible-heatmap-container", logsByDate, 1, "章", start, end);
}

function renderPersonalTrendChart() {
  const canvas = document.getElementById("personal-reading-trend-chart");
  if (!canvas) return;

  const currentPlanId = state.activePlan && state.activePlan.id;
  const currentPresetKey = state.activePlan && state.activePlan.presetKey;

  const range = state.personalTrendRange || "month";

  // Style buttons according to range selection
  const btnWeek = document.getElementById("trend-range-week");
  const btnMonth = document.getElementById("trend-range-month");
  const btnYear = document.getElementById("trend-range-year");

  [btnWeek, btnMonth, btnYear].forEach((btn) => {
    if (btn) btn.classList.remove("active");
  });

  const activeBtn = document.getElementById(`trend-range-${range}`);
  if (activeBtn) activeBtn.classList.add("active");

  let labels = [];
  let chartData = [];

  if (range === "week") {
    // 7 days starting from Sunday of the current week
    const dates = [];
    const today = new Date();
    const dayOfWeek = today.getDay();
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - dayOfWeek);

    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday);
      d.setDate(sunday.getDate() + i);
      const dStr = typeof toTaiwanISODate === "function" ? toTaiwanISODate(d) : d.toISOString().substring(0, 10);
      dates.push(dStr);
      labels.push(`${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`);
    }
    const logsByDate = {};
    if (state.readingLogs) {
      state.readingLogs.forEach(log => {
        if (!log.read_at) return;
        if (!logMatchesPlan(log, currentPlanId, currentPresetKey)) return;
        const dStr = log.read_at.substring(0, 10);
        logsByDate[dStr] = (logsByDate[dStr] || 0) + 1;
      });
    }
    chartData = dates.map(dStr => logsByDate[dStr] || 0);

  } else if (range === "year") {
    // 12 months
    const months = [];
    const today = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const yStr = d.getFullYear();
      const mStr = String(d.getMonth() + 1).padStart(2, '0');
      months.push(`${yStr}-${mStr}`);
      labels.push(`${yStr}/${mStr}`);
    }
    const logsByMonth = {};
    if (state.readingLogs) {
      state.readingLogs.forEach(log => {
        if (!log.read_at) return;
        if (!logMatchesPlan(log, currentPlanId, currentPresetKey)) return;
        const mStr = log.read_at.substring(0, 7);
        logsByMonth[mStr] = (logsByMonth[mStr] || 0) + 1;
      });
    }
    chartData = months.map(mStr => logsByMonth[mStr] || 0);

  } else {
    // 30 days (default)
    const dates = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dStr = typeof toTaiwanISODate === "function" ? toTaiwanISODate(d) : d.toISOString().substring(0, 10);
      dates.push(dStr);
      labels.push(`${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`);
    }
    const logsByDate = {};
    if (state.readingLogs) {
      state.readingLogs.forEach(log => {
        if (!log.read_at) return;
        if (!logMatchesPlan(log, currentPlanId, currentPresetKey)) return;
        const dStr = log.read_at.substring(0, 10);
        logsByDate[dStr] = (logsByDate[dStr] || 0) + 1;
      });
    }
    chartData = dates.map(dStr => logsByDate[dStr] || 0);
  }

  // Render Chart.js
  const isDark = state.theme === 'dark' ||
    document.body.classList.contains('dark-theme') ||
    document.body.classList.contains('dark') ||
    document.documentElement.getAttribute('data-theme') === 'dark';
  const fontColor = isDark ? 'rgba(248, 250, 252, 0.85)' : 'rgba(15, 23, 42, 0.75)';

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 160);
  gradient.addColorStop(0, 'rgba(4, 169, 210, 0.22)');
  gradient.addColorStop(1, 'rgba(4, 169, 210, 0)');

  renderOrUpdateChart('personalTrend', canvas, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '每日讀經章數',
        data: chartData,
        borderColor: '#04A9D2',
        backgroundColor: gradient,
        fill: true,
        tension: 0.35,
        borderWidth: 2,
        pointBackgroundColor: '#04A9D2',
        pointBorderColor: '#ffffff',
        pointBorderWidth: 1,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (context) {
              return `讀經章數: ${context.raw} 章`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: fontColor, font: { size: 9, weight: '300' } },
          grid: { display: false }
        },
        y: {
          ticks: { color: fontColor, stepSize: range === "year" ? 20 : 5, font: { size: 9, weight: '300' } },
          grid: { display: false },
          min: 0
        }
      }
    }
  });
}

// Window actions
window.changePersonalTrendRange = function (range) {
  state.personalTrendRange = range;
  renderPersonalTrendChart();
};

function renderPersonalUnlockedBadges() {
  // Deprecated: Badge strip is removed as badges only display on the profile page
}

async function renderMyPersonalRankings() {
  if (!state.activePlan) return;

  const rankSkeleton = typeof ComponentSkeletonLoader !== "undefined"
    ? ComponentSkeletonLoader.getHtml("inline", { width: "4.5rem", height: "1.4rem" })
    : "—";
  const elRankAll = document.getElementById("my-rank-all");
  const elRankAllTotal = document.getElementById("my-rank-all-total");
  const elRankZoneTitle = document.getElementById("my-rank-zone-title");
  const elRankZone = document.getElementById("my-rank-zone");
  const elRankZoneTotal = document.getElementById("my-rank-zone-total");

  if (elRankAll && firstPaint(elRankAll)) elRankAll.innerHTML = rankSkeleton;
  if (elRankAllTotal && firstPaint(elRankAllTotal)) elRankAllTotal.innerHTML = ComponentSkeletonLoader
    ? ComponentSkeletonLoader.getHtml("inline", { width: "3rem", height: "0.8rem" })
    : "—";
  if (elRankZone && firstPaint(elRankZone)) elRankZone.innerHTML = rankSkeleton;
  if (elRankZoneTotal && firstPaint(elRankZoneTotal)) elRankZoneTotal.innerHTML = ComponentSkeletonLoader
    ? ComponentSkeletonLoader.getHtml("inline", { width: "3rem", height: "0.8rem" })
    : "—";

  let result;
  try {
    result = await db.getPersonalPlanRankingSummary(state.activePlan);
  } catch (error) {
    console.warn("Failed to fetch personal plan ranking summary", error);
    result = { success: false };
  }

  const context = result && result.success ? result.context || {} : {};
  const churchRank = Number(context.churchRank || 0);
  const churchTotal = Number(context.churchTotal || 0);
  const zoneName = String(context.zoneName || state.currentUser.pastoral_zone || "").trim();
  const zoneRank = Number(context.zoneRank || 0);
  const zoneTotal = Number(context.zoneTotal || 0);

  if (elRankAll) elRankAll.textContent = churchRank > 0 ? `第 ${churchRank} 名` : "尚未加入";
  if (elRankAllTotal) elRankAllTotal.textContent = `共 ${churchTotal} 人`;
  if (elRankZoneTitle) elRankZoneTitle.textContent = zoneName ? `${zoneName} 個人排行` : "牧區個人排行";
  if (elRankZone) elRankZone.textContent = !zoneName ? "未選牧區" : (zoneRank > 0 ? `第 ${zoneRank} 名` : "尚未加入");
  if (elRankZoneTotal) elRankZoneTotal.textContent = zoneName ? `共 ${zoneTotal} 人` : "請設定所屬牧區";
}

function updateReadingTeamRankingSummary(division, text) {
  const summary = document.querySelector(`[data-team-ranking-summary="${division}"]`);
  if (summary) summary.textContent = text;
}

function focusReadingTeamRanking(container) {
  if (!container || container.hidden) return;
  const myTeamRow = container.querySelector(".bar-race-row--mine");
  if (!myTeamRow) {
    container.scrollTop = 0;
    return;
  }
  const containerRect = container.getBoundingClientRect();
  const rowRect = myTeamRow.getBoundingClientRect();
  const rowTop = container.scrollTop + rowRect.top - containerRect.top;
  const centeredOffset = rowTop - (container.clientHeight - rowRect.height) / 2;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.min(maxScroll, Math.max(0, centeredOffset));
}

function bindReadingTeamRankingToggles(sections) {
  sections.forEach(section => {
    const details = section.container.closest("[data-team-ranking-details]");
    if (!details || details.dataset.bound === "true") return;
    details.dataset.bound = "true";
    details.addEventListener("toggle", () => {
      if (details.open) requestAnimationFrame(() => focusReadingTeamRanking(section.container));
    });
  });
}

async function renderReadingTeamLeaderboards() {
  const sections = [
    { division: 3, key: "division3", container: document.getElementById("reading-team-ranking-3") },
    { division: 6, key: "division6", container: document.getElementById("reading-team-ranking-6") }
  ].filter(section => section.container);
  if (sections.length === 0) return;
  bindReadingTeamRankingToggles(sections);

  const skeleton = typeof ComponentSkeletonLoader !== "undefined"
    ? ComponentSkeletonLoader.getHtml("bar-race", { count: 3 })
    : '<div style="padding:1.25rem;text-align:center;color:var(--text-muted);">載入中…</div>';
  sections.forEach(section => {
    section.container.className = "bar-race-list reading-team-ranking-list";
    section.container.setAttribute("aria-busy", "true");
    if (firstPaint(section.container)) section.container.innerHTML = skeleton;
    updateReadingTeamRankingSummary(section.division, "團隊排行榜載入中…");
  });

  if (!state.activePlan) {
    sections.forEach(section => {
      section.container.removeAttribute("aria-busy");
      section.container.innerHTML = '<div style="padding:1.25rem;text-align:center;color:var(--text-muted);">請先選擇計畫</div>';
      updateReadingTeamRankingSummary(section.division, "尚未選擇計畫");
    });
    return;
  }

  const settleRequest = (request, timeoutMs) => new Promise(resolve => {
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({
      success: false,
      message: "團隊排行榜載入逾時，請重新載入。"
    }), timeoutMs);
    Promise.resolve()
      .then(request)
      .then(finish, error => finish({ success: false, message: error && error.message }));
  });

  let result = await settleRequest(
    () => db.getReadingTeamLeaderboards(state.activePlan),
    8000
  );

  // Rolling-deployment compatibility: administrators can temporarily reuse the
  // existing aggregate statistics RPC until the dedicated leaderboard RPC is live.
  const canUseAdminFallback = hasWholeChurchPlanScope(state.currentUser);
  if ((!result || !result.success) && canUseAdminFallback && typeof db.getReadingTeamStatistics === "function") {
    const fallback = await settleRequest(
      () => db.getReadingTeamStatistics(state.activePlan),
      5000
    );
    if (fallback && fallback.success) {
      const fallbackTeams = Array.isArray(fallback.context && fallback.context.teams)
        ? fallback.context.teams
        : [];
      result = {
        success: true,
        context: {
          division3: fallbackTeams.filter(team => Number(team.division) === 3),
          division6: fallbackTeams.filter(team => Number(team.division) === 6)
        }
      };
    }
  }

  if (!result || !result.success) {
    const message = escapeHTML(result && result.message || "目前無法載入團隊排行榜。");
    sections.forEach(section => {
      section.container.removeAttribute("aria-busy");
      updateReadingTeamRankingSummary(section.division, "讀取失敗・請重新載入");
      section.container.innerHTML = `
        <div style="padding:1.25rem;text-align:center;color:var(--text-muted);">
          <div>${message}</div>
          <button type="button" class="secondary-btn" data-team-ranking-retry style="margin-top:0.75rem;">重新載入</button>
        </div>
      `;
      const retryButton = section.container.querySelector("[data-team-ranking-retry]");
      if (retryButton) retryButton.onclick = () => renderReadingTeamLeaderboards();
    });
    return;
  }

  const context = result.context || {};
  sections.forEach(section => {
    const teams = Array.isArray(context[section.key]) ? [...context[section.key]] : [];
    section.container.removeAttribute("aria-busy");
    const completedAt = team => {
      const time = team && team.lastReadAt ? new Date(team.lastReadAt).getTime() : Infinity;
      return Number.isFinite(time) ? time : Infinity;
    };
    teams.sort((a, b) => {
      const scoreDiff = Number(b.chaptersRead || 0) - Number(a.chaptersRead || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const aTime = completedAt(a);
      const bTime = completedAt(b);
      if (aTime !== bTime) return aTime - bTime;
      return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
    });

    if (teams.length === 0) {
      section.container.innerHTML = `<div style="padding:1.25rem;text-align:center;color:var(--text-muted);">目前尚無 ${section.division} 人團隊</div>`;
      updateReadingTeamRankingSummary(section.division, "共 0 隊");
      return;
    }

    const maxChapters = Math.max(...teams.map(team => Number(team.chaptersRead || 0)), 1);
    section.container.innerHTML = '<div class="bar-race-track"></div>';
    const track = section.container.querySelector(".bar-race-track");

    let calculatedRank = 1;
    teams.forEach((team, index) => {
      const chaptersRead = Math.max(0, Number(team.chaptersRead || 0));
      const memberCount = Math.max(0, Number(team.memberCount || 0));
      const previousTeam = index > 0 ? teams[index - 1] : null;
      const sharesRank = previousTeam
        && chaptersRead === Math.max(0, Number(previousTeam.chaptersRead || 0))
        && completedAt(team) === completedAt(previousTeam);
      if (index > 0 && !sharesRank) calculatedRank = index + 1;
      const serverRank = Number(team.rank);
      const rank = Number.isFinite(serverRank) && serverRank > 0 ? serverRank : calculatedRank;
      const progressPercent = Math.min(100, Math.round(chaptersRead / maxChapters * 100));
      const row = document.createElement("div");
      row.className = `bar-race-row${team.isMine ? " bar-race-row--mine" : ""}`;
      row.style.setProperty("--target-width", `${progressPercent}%`);
      row.dataset.teamRank = String(rank);
      row.style.transitionDelay = `${index * 70}ms`;
      row.innerHTML = `
        <div class="bar-race-rank">${rank}</div>
        <div class="bar-race-main">
          <div class="bar-race-meta">
            <span class="bar-race-name">${escapeHTML(team.name || "未命名隊伍")}${team.isMine ? '<span class="bar-race-mine-badge">我的團隊</span>' : ""}</span>
            <span class="bar-race-percent">${chaptersRead} 章</span>
          </div>
          <div class="bar-race-bar-shell" role="progressbar" aria-label="${escapeHTML(team.name || "未命名隊伍")}閱讀進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressPercent}">
            <div class="bar-race-bar"></div>
          </div>
          <div class="bar-race-details">
            <span class="bar-race-members">${memberCount}/${section.division} 人</span>
          </div>
        </div>
      `;
      track.appendChild(row);
    });

    const myTeamRow = track.querySelector(".bar-race-row--mine");
    const teamCountLabel = `共 ${teams.length} 隊`;
    updateReadingTeamRankingSummary(
      section.division,
      myTeamRow
        ? `我的團隊第 ${myTeamRow.dataset.teamRank} 名・${teamCountLabel}`
        : `${teamCountLabel}・尚未加入 ${section.division} 人團隊`
    );

    requestAnimationFrame(() => {
      track.querySelectorAll(".bar-race-row").forEach(row => row.classList.add("is-running"));
      requestAnimationFrame(() => focusReadingTeamRanking(section.container));
    });
  });
}

function focusPastoralRaceRanking(container) {
  if (!container || container.hidden) return;
  const myPastoralRow = container.querySelector(".pastoral-race-row--mine");
  if (!myPastoralRow) {
    container.scrollTop = 0;
    return;
  }
  const containerRect = container.getBoundingClientRect();
  const rowRect = myPastoralRow.getBoundingClientRect();
  const rowTop = container.scrollTop + rowRect.top - containerRect.top;
  const centeredOffset = rowTop - (container.clientHeight - rowRect.height) / 2;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.min(maxScroll, Math.max(0, centeredOffset));
}

function bindPastoralRankingToggle(container) {
  const details = container && container.closest("[data-pastoral-ranking-details]");
  if (!details || details.dataset.focusBound === "true") return;
  details.dataset.focusBound = "true";
  details.addEventListener("toggle", () => {
    if (!details.open) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => focusPastoralRaceRanking(container));
    });
  });
}

async function renderPlanRankingView() {
  const rankingResults = await Promise.allSettled([
    Promise.resolve().then(() => renderReadingTeamLeaderboards()),
    Promise.resolve().then(() => renderMyPersonalRankings())
  ]);
  rankingResults.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(index === 0
        ? "Failed to render reading-team leaderboards"
        : "Failed to render personal rankings", result.reason);
    }
  });

  const container = document.getElementById("pastoral-ranking-list-container");
  if (!container) return;
  bindPastoralRankingToggle(container);

  const rankingCard = container.closest(".glass-card");
  if (rankingCard) rankingCard.style.display = "";

  const header = container.previousElementSibling;
  if (header) header.style.display = "none";
  container.className = "bar-race-list";
  container.style.cssText = "";
  if (firstPaint(container)) container.innerHTML = typeof ComponentSkeletonLoader !== "undefined"
    ? ComponentSkeletonLoader.getHtml("bar-race", { count: 4 })
    : "";

  let pastoralStats = [];
  let unassignedPastoralCount = 0;
  try {
    const result = await db.getPastoralZoneLeaderboard(state.activePlan);
    if (!result.success) throw result.error || new Error(result.message || "Failed to load pastoral leaderboard");
    const context = result.context || {};
    const completionTime = item => {
      const timestamp = item && item.completed_at ? new Date(item.completed_at).getTime() : Infinity;
      return Number.isFinite(timestamp) ? timestamp : Infinity;
    };
    pastoralStats = (Array.isArray(context.zones) ? context.zones : []).map(zone => ({
      name: zone.name || "",
      total_chapters: Number(zone.chaptersRead || 0),
      members: Number(zone.memberCount || 0),
      average_chapters: Math.round(Number(
        zone.averageChapters ?? (
          Number(zone.memberCount || 0) > 0
            ? Number(zone.chaptersRead || 0) / Number(zone.memberCount || 0)
            : 0
        )
      ) * 100) / 100,
      completed_at: zone.lastReadAt || null,
      is_mine: zone.isMine === true
    })).sort((a, b) => {
      const averageDiff = b.average_chapters - a.average_chapters;
      if (averageDiff !== 0) return averageDiff;
      const timeDiff = completionTime(a) - completionTime(b);
      if (timeDiff !== 0) return timeDiff;
      return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
    });
    unassignedPastoralCount = Number(context.unassignedCount || 0);
  } catch (e) {
    console.error("Failed to load pastoral rankings", e);
  }

  const badge = document.getElementById("pastoral-ranking-count-badge");
  if (badge) {
    badge.textContent = `共 ${pastoralStats.length} 個牧區`;
    badge.style.display = pastoralStats.length > 0 ? "inline-block" : "none";
  }

  if (pastoralStats.length === 0) {
    container.innerHTML = `<div style="text-align: center; padding: 1.5rem; color: var(--text-muted);">目前沒有排行資料</div>`;
    return;
  }

  const maxAverageChapters = Math.max(...pastoralStats.map(item => item.average_chapters), 1);
  const pastoralCompletionTime = item => {
    const timestamp = item && item.completed_at ? new Date(item.completed_at).getTime() : Infinity;
    return Number.isFinite(timestamp) ? timestamp : Infinity;
  };
  const formatPastoralCompletion = value => {
    if (!value) return "尚無完成時間";
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const [, month, day] = text.split("-");
      return `完成 ${Number(month)}/${Number(day)}`;
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "尚無完成時間";
    return `完成 ${new Intl.DateTimeFormat("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date)}`;
  };
  const formatAverageChapters = value => new Intl.NumberFormat("zh-TW", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
  const renderRace = () => {
    container.className = "pastoral-race-list";
    container.innerHTML = `
      <div class="pastoral-race-toolbar">
        <div>
          <div class="pastoral-race-title">即時閱讀表現</div>
          <div class="pastoral-race-subtitle">以目前最高平均每人閱讀章數為 100%</div>
        </div>
      </div>
      <div class="pastoral-race-average-notice" role="note" aria-label="平均數計算說明">
        <strong>提醒：此排行榜顯示平均數</strong>
        <span>平均每人閱讀章數＝牧區總閱讀章數 ÷ 牧區有效人數；尚未閱讀的有效成員也會計入人數。</span>
      </div>
      <div class="pastoral-race-track">
        ${pastoralStats.length === 0 ? '<div class="pastoral-race-empty">目前沒有已設定牧區的排行資料</div>' : ""}
      </div>
    `;
    const track = container.querySelector(".pastoral-race-track");

    let calculatedRank = 1;
    pastoralStats.forEach((item, index) => {
      const previousItem = index > 0 ? pastoralStats[index - 1] : null;
      const sharesRank = previousItem
        && item.average_chapters === previousItem.average_chapters
        && pastoralCompletionTime(item) === pastoralCompletionTime(previousItem);
      if (index > 0 && !sharesRank) calculatedRank = index + 1;
      const rank = calculatedRank;
      const pct = Math.min(100, Math.round((item.average_chapters / maxAverageChapters) * 100));
      const placementClass = rank <= 3 ? " pastoral-race-row--podium" : "";
      const ownershipClass = item.is_mine ? " pastoral-race-row--mine" : "";
      const row = document.createElement("div");
      row.className = `pastoral-race-row${placementClass}${ownershipClass}`;
      row.style.setProperty("--target-width", `${pct}%`);
      row.style.transitionDelay = `${index * 70}ms`;
      row.innerHTML = `
        <div class="pastoral-race-rank" aria-label="第 ${rank} 名">${rank}</div>
        <div class="pastoral-race-main">
          <div class="pastoral-race-heading">
            <div class="pastoral-race-identity">
              <span class="pastoral-race-name">${escapeHTML(item.name)}</span>
              ${item.is_mine ? '<span class="pastoral-race-mine-badge">我的牧區</span>' : ""}
              <span class="pastoral-race-members">總計 ${item.total_chapters} 章 · ${item.members} 人</span>
            </div>
            <div class="pastoral-race-score"><strong>${formatAverageChapters(item.average_chapters)}</strong><span>章／人</span></div>
          </div>
          <div class="pastoral-race-progress-meta">
            <span>相對閱讀速度</span>
            <strong>${pct}%</strong>
          </div>
          <div class="pastoral-race-progress" role="progressbar" aria-label="${escapeHTML(item.name)}平均每人閱讀章數" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-valuetext="平均每人 ${formatAverageChapters(item.average_chapters)} 章，相對進度 ${pct}%">
            <div class="pastoral-race-progress-fill"></div>
          </div>
        </div>
      `;
      track.appendChild(row);
    });

    if (typeof hydrateIcons === "function") hydrateIcons(container);

    requestAnimationFrame(() => {
      track.querySelectorAll(".pastoral-race-row").forEach(row => row.classList.add("is-running"));
      requestAnimationFrame(() => focusPastoralRaceRanking(container));
    });
  };

  renderRace();
}

async function renderGroupParticipantsRankingTable() {
  if (!state.activePlan) return;

  const rankingTitle = document.getElementById("ranking-title") || document.getElementById("members-ranking-title");
  const currentPlanIdForStats = state.activePlan.id;
  const currentPresetKeyForStats = state.activePlan.presetKey;
  const uniquePlanLogs = (logs) => {
    const unique = new Set();
    const planChapters = new Set();
    if (state.activePlan && state.activePlan.days) {
      state.activePlan.days.forEach(d => {
        if (d.chapters) {
          d.chapters.forEach(ch => {
            planChapters.add(`${ch.book}_${ch.chapter}`);
          });
        }
      });
    }
    (logs || []).forEach(log => {
      if (!logMatchesPlan(log, currentPlanIdForStats, currentPresetKeyForStats)) return;
      if (planChapters.has(`${log.book}_${log.chapter}`)) {
        unique.add(`${log.book}_${log.chapter}_${log.round || 1}`);
      }
    });
    return unique.size;
  };
  const myPlanReadCount = uniquePlanLogs(state.readingLogs || []);
  // 「最高連續」各計畫獨立算：只看歸屬這個計畫的打卡，不混用全域 state.currentUser.streak。
  const personalStreak = myPlanReadCount > 0
    ? computePlanScopedStreak(state.readingLogs || [], {
        planId: currentPlanIdForStats,
        presetKey: currentPresetKeyForStats
      })
    : 0;

  // 進度狀態 / 補讀天數是「大家對同一把尺」的天數比較，尺一律是這個階段的
  // 教會原始日程（七日、不套任何使用者的 level 或個人休息日）。絕不能用
  // state.activePlan.days —— 那是「看榜這個人自己」的排程。
  const baselineScheduleDays = typeof window.getCanonicalStageScheduleDays === "function"
    ? window.getCanonicalStageScheduleDays(state.activePlan)
    : (state.activePlan.days || []);

  const calculateCatchUpDays = (userLogs) => {
    if (!state.activePlan || !baselineScheduleDays.length) return 0;
    const statsStart = new Date(state.activePlan.startDate + "T00:00:00");
    statsStart.setHours(0, 0, 0, 0);
    let catchUpDaysVal = 0;
    const toLocalStr = window.toLocalYYYYMMDD || ((val) => {
      if (!val) return "";
      const date = val instanceof Date ? val : new Date(val);
      if (Number.isNaN(date.getTime())) return "";
      return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    });

    // 💡 效能關鍵升級：建立 logMap (Key: book_chapter -> read_at)，將 O(N) 搜尋優化為 O(1)
    const logMap = new Map();
    if (Array.isArray(userLogs)) {
      for (let i = 0; i < userLogs.length; i++) {
        const l = userLogs[i];
        if ((l.round || 1) === 1 && l.book && l.chapter !== undefined) {
          logMap.set(`${l.book}_${l.chapter}`, l.read_at);
        }
      }
    }

    const days = baselineScheduleDays;
    for (let index = 0; index < days.length; index++) {
      const day = days[index];
      const scheduledDate = new Date(statsStart);
      scheduledDate.setDate(statsStart.getDate() + index);
      const scheduledDateStr = scheduledDate.getFullYear() + '-' + String(scheduledDate.getMonth() + 1).padStart(2, '0') + '-' + String(scheduledDate.getDate()).padStart(2, '0');

      let allChaptersCompleted = true;
      let maxReadDateStr = "";

      for (let c = 0; c < day.chapters.length; c++) {
        const ch = day.chapters[c];
        const readAt = logMap.get(`${ch.book}_${ch.chapter}`);
        if (readAt === undefined) {
          allChaptersCompleted = false;
          break;
        }
        const logDateStr = toLocalStr(readAt);
        if (!maxReadDateStr || logDateStr > maxReadDateStr) {
          maxReadDateStr = logDateStr;
        }
      }

      if (allChaptersCompleted && maxReadDateStr && maxReadDateStr > scheduledDateStr) {
        catchUpDaysVal++;
      }
    }
    return catchUpDaysVal;
  };

  // Everyone's days-completed is derived the same way, from their exact
  // chapter total, by walking the shared schedule and counting whole days
  // fully covered — never from a percent-of-total estimate. Two people who
  // have both read exactly the same number of chapters against the same
  // schedule always get the exact same days-completed figure this way; a
  // progress% × totalDays estimate would round twice (plan_progress is
  // already a server-rounded whole percent) and could put two identical
  // 16-chapter readers on opposite sides of a day boundary — one reading as
  // "今日未完成", the other as "在進度上" — for no real difference between
  // them. This assumes chapters are read in schedule order, same as every
  // other progress figure in this app.
  const countExactDaysCoveredByChapters = (days, chaptersRead) => {
    let cumulative = 0;
    let daysCovered = 0;
    for (const day of days) {
      const dayChapterCount = day.chapters ? day.chapters.length : 0;
      if (dayChapterCount === 0) continue;
      if (cumulative + dayChapterCount > chaptersRead) break;
      cumulative += dayChapterCount;
      daysCovered++;
    }
    return daysCovered;
  };

  const planStart = new Date(state.activePlan.startDate + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffTime = today.getTime() - planStart.getTime();
  const diffDays = Math.max(0, Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1);
  const elapsedPlanDaysCount = Math.min(baselineScheduleDays.length, diffDays);
  // Rest days (no chapters scheduled) don't increment daysCovered above, so
  // the expected side must exclude them too — otherwise every rest day
  // silently counts as a calendar day you were supposed to read, and a
  // member perfectly on schedule reads as behind by however many rest days
  // have passed.
  const expectedDaysCount = baselineScheduleDays
    .slice(0, elapsedPlanDaysCount)
    .filter(day => day.chapters && day.chapters.length > 0)
    .length;

  const userZone = state.currentUser.managed_zones || state.currentUser.pastoral_zone
    || getLeadershipAssignmentNodeNames(state.currentUser, "牧區") || "";
  const userRole = getUserRoleCode(state.currentUser) || "member";
  const isAdmin = hasWholeChurchPlanScope(userRole);
  const isGreatZoneLeader = userRole === "great_zone_leader";
  const isZoneLeader = userRole === "zone_leader";
  const isGroupLeader = userRole === "group_leader";

  const listContainer = document.getElementById("ranking-participants-list");
  if (listContainer) {
    if (firstPaint(listContainer)) listContainer.innerHTML = typeof ComponentSkeletonLoader !== "undefined"
      ? ComponentSkeletonLoader.getHtml("member-progress", { count: 5 })
      : "";

    let allUsers = [];
    try {
      const activeKey = state.activePlan
        ? (state.activePlan.globalPlanId || state.activePlan.presetKey || state.activePlan.name || state.activePlan.id)
        : null;
      if (window._cachedAllUsersList && window._cachedAllUsersListKey === activeKey && window._cachedAllUsersList.length > 0) {
        allUsers = window._cachedAllUsersList;
      } else {
        allUsers = await db.fetchMergedUsersList(activeKey);
        window._cachedAllUsersList = allUsers;
        window._cachedAllUsersListKey = activeKey;
      }
    } catch (e) {
      console.warn("Failed to fetch merged users, fallback to empty array", e);
    }

    let scopedUsersList = allUsers;
    if (isAdmin) {
      scopedUsersList = allUsers;
    } else if (isGreatZoneLeader) {
      const userGreatRegion = state.currentUser.managed_regions || state.currentUser.great_region
        || getLeadershipAssignmentNodeNames(state.currentUser, "大區") || "";
      const myRegions = userGreatRegion.split(",").map(s => s.trim()).filter(Boolean);
      scopedUsersList = allUsers.filter(u => myRegions.includes(u.great_region));
    } else if (isZoneLeader) {
      const userZoneStr = state.currentUser.managed_zones || state.currentUser.pastoral_zone
        || getLeadershipAssignmentNodeNames(state.currentUser, "牧區") || "";
      const myZones = userZoneStr.split(",").map(s => s.trim()).filter(Boolean);
      scopedUsersList = allUsers.filter(u => myZones.includes(u.pastoral_zone));
    } else if (isGroupLeader) {
      const userGroupStr = state.currentUser.managed_groups || state.currentUser.small_group
        || getLeadershipAssignmentNodeNames(state.currentUser, "小組") || "";
      const myGroups = userGroupStr.split(",").map(s => s.trim()).filter(Boolean);
      scopedUsersList = allUsers.filter(u => myGroups.includes(u.small_group));
    } else {
      const userZones = (userZone || "").split(",").map(s => s.trim()).filter(Boolean);
      scopedUsersList = allUsers.filter(u => userZones.includes(u.pastoral_zone));
    }

    const tabMembers = document.getElementById("tab-plan-members");
    const isMembersActive = (tabMembers && tabMembers.classList.contains("active"))
      || window.currentPlanViewState === PLAN_ROUTE.ORG_STATS;

    if (isMembersActive) {
      populateMembersSelector();
    } else {
      populateStatsSelector();
    }
    const rankingZoneSelector = document.getElementById("ranking-zone-selector");
    const membersZoneSelector = document.getElementById("members-zone-selector");
    const searchInput = document.getElementById("member-search-input");
    const query = searchInput ? searchInput.value.trim().toLowerCase() : "";

    let groupMembers = scopedUsersList;

    if (isMembersActive) {
      if (query) {
        groupMembers = scopedUsersList.filter(u => u.name.toLowerCase().includes(query));
        if (rankingTitle) rankingTitle.textContent = `搜尋結果: ${query}`;
      } else {
        const selectedFilter = getActiveOrgFilter();
        if (selectedFilter) {
          if (selectedFilter.startsWith("zone:")) {
            const zone = selectedFilter.replace("zone:", "");
            if (zone === "未設定牧區") {
              groupMembers = scopedUsersList.filter(u => !u.pastoral_zone || u.pastoral_zone.trim() === "");
              if (rankingTitle) rankingTitle.textContent = "參與者總覽 (未設定牧區成員)";
            } else {
              groupMembers = scopedUsersList.filter(u => u.pastoral_zone === zone);
              if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${zone}牧區)`;
            }
          } else if (selectedFilter.startsWith("group:")) {
            const group = selectedFilter.replace("group:", "");
            groupMembers = scopedUsersList.filter(u => u.small_group === group);
            if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${group}小組)`;
          } else if (selectedFilter.startsWith("region:")) {
            const region = selectedFilter.replace("region:", "");
            groupMembers = scopedUsersList.filter(u => u.great_region === region);
            if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${region}大區成員)`;
          } else if (selectedFilter === "all") {
            groupMembers = scopedUsersList;
            if (rankingTitle) rankingTitle.textContent = "參與者總覽 (全教會成員)";
          } else if (selectedFilter === "all_great_region") {
            groupMembers = scopedUsersList;
            if (rankingTitle) rankingTitle.textContent = "參與者總覽 (所屬大區成員)";
          } else {
            const userZones = (userZone || "").split(",").map(s => s.trim()).filter(Boolean);
            groupMembers = scopedUsersList.filter(u => userZones.includes(u.pastoral_zone));
            if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${userZone}牧區)`;
          }
        } else {
          const userZones = (userZone || "").split(",").map(s => s.trim()).filter(Boolean);
          groupMembers = scopedUsersList.filter(u => userZones.includes(u.pastoral_zone));
          if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${userZone}牧區)`;
        }
      }
    } else {
      const selectedFilter = window._statsTabScope !== null
        ? window._statsTabScope
        : (rankingZoneSelector ? rankingZoneSelector.value : null);
      if (selectedFilter) {
        if (selectedFilter === "all") {
          groupMembers = allUsers;
          if (rankingTitle) rankingTitle.textContent = "參與者總覽 (全教會排行)";
        } else if (selectedFilter === "all_great_region") {
          const userGreatRegion = state.currentUser.managed_regions || state.currentUser.great_region
            || getLeadershipAssignmentNodeNames(state.currentUser, "大區") || "";
          const userRegions = userGreatRegion.split(",").map(s => s.trim()).filter(Boolean);
          groupMembers = allUsers.filter(u => userRegions.includes(u.great_region));
          if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${userGreatRegion}排行)`;
        } else if (selectedFilter === "all_zones") {
          const userZoneStr = state.currentUser.managed_zones || state.currentUser.pastoral_zone
            || getLeadershipAssignmentNodeNames(state.currentUser, "牧區") || "";
          const userZones = userZoneStr.split(",").map(s => s.trim()).filter(Boolean);
          groupMembers = allUsers.filter(u => userZones.includes(u.pastoral_zone));
          if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${userZoneStr}排行)`;
        } else if (selectedFilter === "all_groups") {
          const userGroupStr = state.currentUser.managed_groups || state.currentUser.small_group
            || getLeadershipAssignmentNodeNames(state.currentUser, "小組") || "";
          const userGroups = userGroupStr.split(",").map(s => s.trim()).filter(Boolean);
          groupMembers = allUsers.filter(u => userGroups.includes(u.small_group));
          if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${userGroupStr}排行)`;
        } else if (selectedFilter.startsWith("region:")) {
          const region = selectedFilter.replace("region:", "");
          groupMembers = allUsers.filter(u => u.great_region === region);
          if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${region}大區排行)`;
        } else if (selectedFilter.startsWith("zone:")) {
          const zone = selectedFilter.replace("zone:", "");
          if (zone === "未設定牧區") {
            groupMembers = allUsers.filter(u => !u.pastoral_zone || u.pastoral_zone.trim() === "");
            if (rankingTitle) rankingTitle.textContent = "參與者總覽 (未設定牧區成員排行)";
          } else {
            groupMembers = allUsers.filter(u => u.pastoral_zone === zone);
            if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${zone}牧區排行)`;
          }
        } else if (selectedFilter.startsWith("group:")) {
          const group = selectedFilter.replace("group:", "");
          groupMembers = allUsers.filter(u => u.small_group === group);
          if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${group}小組排行)`;
        }
      } else {
        const userZones = (userZone || "").split(",").map(s => s.trim()).filter(Boolean);
        groupMembers = allUsers.filter(u => userZones.includes(u.pastoral_zone));
        if (rankingTitle) rankingTitle.textContent = `參與者總覽 (${userZone}牧區排行)`;
      }
    }

    if (rankingTitle) {
      const adminParticipantsTitle = document.getElementById("admin-participants-title");
      if (adminParticipantsTitle) {
        adminParticipantsTitle.textContent = rankingTitle.textContent;
      }
    }

    window._grpScopedUsers = groupMembers;

    groupMembers = groupMembers.map(u => {
      const isMe = u.name === state.currentUser.name;
      const hasAnyPlanRead = isMe
        ? myPlanReadCount > 0
        : ((u.chapters_read || 0) > 0 || ((u.plan_progress || 0) > 0 && Boolean(u.last_read)));
      // 別人的 allLogsCache 已在查詢層限定到這個計畫（preset_key / global_plan_id），
      // 所以 preFiltered；他們的 log.plan_id 是各自的 enrollment，不能拿來比對我的。
      const streak = !hasAnyPlanRead
        ? 0
        : isMe
          ? personalStreak
          : computePlanScopedStreak(
              (state.allLogsCache || []).filter(l => l.user_id === u.id),
              { preFiltered: true }
            );

      let completed = 0;
      let makeup = 0;
      let diff = 0;

      if (hasAnyPlanRead) {
        let memberIsCompletedOnce;
        if (isMe) {
          completed = myPlanReadCount;
          const myUserLogs = (state.readingLogs || []).filter(l =>
            l.plan_id === state.activePlan.id || l.presetKey === state.activePlan.presetKey
          );
          makeup = calculateCatchUpDays(myUserLogs);
          memberIsCompletedOnce = state.activePlan.isPlanCompleted || (state.activePlan.currentRound || 1) > 1;
        } else {
          completed = u.chapters_read || 0;
          const otherUserLogs = (state.allLogsCache || []).filter(l => l.user_id === u.id);
          makeup = calculateCatchUpDays(otherUserLogs);
          memberIsCompletedOnce = (u.current_round || 1) > 1;
        }
        // 讀完一遍後直接視為天數全滿，避免進入二三遍後被誤判落後。
        // 一律對「基準日程」比對，不受看榜者自己的 level 影響。
        const completedDays = memberIsCompletedOnce
          ? baselineScheduleDays.length
          : countExactDaysCoveredByChapters(baselineScheduleDays, completed);
        diff = completedDays - expectedDaysCount;
      }

      const memberRound = Number(isMe ? state.activePlan.currentRound : u.current_round) || 1;
      const memberProgress = Math.max(0, Math.min(100, Math.round(Number(
        isMe ? state.activePlan.progress : u.plan_progress
      ) || 0)));
      let statusStr = hasAnyPlanRead ? "在進度上" : "未開始";
      let statusColor = "var(--text-muted)";
      if (hasAnyPlanRead && memberRound === 1 && memberProgress >= 100) {
        statusStr = "第一遍完成";
        statusColor = "var(--color-success-foreground)";
      } else if (hasAnyPlanRead && memberRound > 1) {
        statusStr = memberProgress > 0 ? `第${memberRound}遍完成${memberProgress}%` : `第${memberRound}遍進行中`;
        statusColor = memberProgress >= 100 ? "var(--color-success-foreground)" : "var(--color-brand)";
      } else if (hasAnyPlanRead && diff > 0) {
        statusStr = `超前 ${diff}天`;
        statusColor = "var(--color-success-foreground)";
      } else if (hasAnyPlanRead && diff < 0) {
        statusStr = diff === -1 ? "今日未完成" : `落後 ${Math.abs(diff)}天`;
        statusColor = "var(--color-danger)";
      }

      return {
        id: u.id,
        name: u.name,
        streak: streak,
        completed: completed,
        makeup: makeup,
        statusStr: statusStr,
        statusColor: statusColor,
        isMe: isMe,
        isBehind: hasAnyPlanRead && diff < 0,
        isNotStarted: !hasAnyPlanRead,
        last_read: u.last_read_at || u.last_read || null
      };
    });

    // ── 多重排序 + Dense Rank（參與者排行榜）──
    // 排序一：completed DESC（進度天數高者優先）
    // 排序二：last_read ASC（相同進度時，最早完成者優先；null 排最後）
    // 排序三：id ASC（確定性防線，保證跨查詢順序 100% 穩定）
    groupMembers.sort((a, b) => {
      const diff = (b.completed ?? 0) - (a.completed ?? 0);
      if (diff !== 0) return diff;
      const aT = a.last_read ? new Date(a.last_read).getTime() : Infinity;
      const bT = b.last_read ? new Date(b.last_read).getTime() : Infinity;
      if (aT !== bT) return aT - bT;
      return String(a.id ?? a.name ?? '').localeCompare(String(b.id ?? b.name ?? ''));
    });

    // Dense Rank：進度 + last_read 完全相同者共享同一名次
    // 未開始（completed = 0）→ 一律顯示最後名次，讓人感受「從最後衝到最前」的動力
    const _totalMemberCount = groupMembers.length;
    let _denseRank = 1;
    groupMembers = groupMembers.map((m, i) => {
      // 未開始者：名次 = 總人數（最後一名）
      if ((m.completed ?? 0) === 0) return { ...m, rank: _totalMemberCount };
      if (i === 0) return { ...m, rank: 1 };
      const prev = groupMembers[i - 1];
      const same = (m.completed ?? 0) === (prev.completed ?? 0)
        && (m.last_read ?? null) === (prev.last_read ?? null);
      if (!same) _denseRank = i + 1;
      return { ...m, rank: _denseRank };
    });

    window._grpScopedProcessedMembers = groupMembers;

    if (searchInput && !searchInput.dataset.listenerInitialized) {
      searchInput.dataset.listenerInitialized = "true";
      let searchFrame = null;
      searchInput.addEventListener("input", () => {
        if (searchFrame !== null) window.cancelAnimationFrame(searchFrame);
        searchFrame = window.requestAnimationFrame(() => {
          searchFrame = null;
          window.displayParticipantsList(100);
        });
      });
    }
    window.displayParticipantsList(100);
  }
}

window.displayParticipantsList = function (limit = 100) {
  const listContainer = document.getElementById("ranking-participants-list");
  if (!listContainer) return;

  const searchInput = document.getElementById("member-search-input");
  const query = searchInput ? searchInput.value.trim().toLowerCase() : "";

  // Filter based on search query
  let items = window._grpScopedProcessedMembers || [];
  if (query) {
    items = items.filter(m => m.name.toLowerCase().includes(query));
  }

  // Load previous ranks for trend comparison
  const activeKey = state.activePlan
    ? (state.activePlan.globalPlanId || state.activePlan.presetKey || state.activePlan.name || state.activePlan.id)
    : null;
  const storageKey = `nlc_prev_ranks_${activeKey}`;
  let prevRanks = {};
  if (activeKey) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) prevRanks = JSON.parse(raw);
    } catch (e) {
      console.warn("Failed to load prev ranks:", e);
    }
  }

  listContainer.innerHTML = "";

  if (items.length === 0) {
    listContainer.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted); font-size: 0.88rem;">無符合搜尋條件的成員</div>`;
    return;
  }

  // Slice items to show only the specified limit
  const visibleItems = items.slice(0, limit);

  // Determine if current user is a leader who can send care reminders
  const _careRole = (state.currentUser && getUserRoleCode(state.currentUser)) || "member";
  const _canSendCare = ["group_leader", "zone_leader", "great_zone_leader", "pastor", "admin"].includes(_careRole);

  // 對齊 header 欄位動態調整（含名次欄）
  const headerEl = document.getElementById("members-ranking-header") || listContainer.previousElementSibling;
  if (headerEl) {
    // 名次欄寬度 36px
    if (_canSendCare) {
      headerEl.style.gridTemplateColumns = "36px 1fr 80px 80px 70px 90px 44px";
      let reminderHeader = document.getElementById("members-ranking-reminder-col");
      if (!reminderHeader) {
        reminderHeader = Array.from(headerEl.children).find(child => child.id === "members-ranking-reminder-col" || child.textContent === "提醒");
      }
      if (!reminderHeader) {
        reminderHeader = document.createElement("div");
        reminderHeader.id = "members-ranking-reminder-col";
        reminderHeader.style.color = "var(--text-muted)";
        reminderHeader.textContent = "提醒";
        headerEl.appendChild(reminderHeader);
      }
    } else {
      headerEl.style.gridTemplateColumns = "36px 1fr 80px 80px 70px 90px";
      const reminderHeader = document.getElementById("members-ranking-reminder-col")
        || Array.from(headerEl.children).find(child => child.id === "members-ranking-reminder-col" || child.textContent === "提醒");
      if (reminderHeader) reminderHeader.remove();
    }
    // 論是否已有名次 header—若編影第一個子元素不是名次欄，則插入
    const firstChild = headerEl.firstElementChild;
    if (!firstChild || firstChild.id !== "members-ranking-rank-col") {
      const rankHeader = document.createElement("div");
      rankHeader.id = "members-ranking-rank-col";
      rankHeader.style.cssText = "color: var(--text-muted); font-size: 0.875rem; text-align: center;";
      rankHeader.textContent = "名次";
      headerEl.insertBefore(rankHeader, firstChild);
    }
  }

  visibleItems.forEach(m => {
    const itemRow = document.createElement("div");
    // 名次欄 36px 加入 grid
    itemRow.style.cssText = `
      display: grid;
      grid-template-columns: 36px 1fr 80px 80px 70px 90px${_canSendCare ? ' 44px' : ''};
      gap: 0.4rem;
      align-items: center;
      padding: 0.6rem 0.2rem;
      border-bottom: 1px solid var(--border-card);
      font-size: 0.88rem;
      font-weight: 500;
      text-align: center;
    `;
    if (m.isMe) {
      itemRow.style.background = "var(--color-brand-muted, rgba(4,169,210,0.08))";
      itemRow.style.borderRadius = "8px";
    }

    const rankNum = m.rank ?? "—";
    let trendHtml = "";
    if (rankNum !== "—" && m.completed > 0 && activeKey) {
      const prevRank = prevRanks[m.id];
      if (prevRank !== undefined) {
        if (Number(rankNum) < Number(prevRank)) {
          trendHtml = `<span style="color: var(--color-success-foreground); font-size: 0.875rem; margin-left: 2px; display: inline-flex; align-items: center; justify-content: center;" title="相較上次更新上升 ${prevRank - rankNum} 名">▲</span>`;
        } else if (Number(rankNum) > Number(prevRank)) {
          trendHtml = `<span style="color: var(--color-danger); font-size: 0.875rem; margin-left: 2px; display: inline-flex; align-items: center; justify-content: center;" title="相較上次更新下降 ${rankNum - prevRank} 名">▼</span>`;
        }
      }
    }

    // 名次徽章樣式：Top 3 上色，其餘灰色
    const rankColor = rankNum === 1 ? '#f59e0b' : rankNum === 2 ? 'var(--text-secondary)' : rankNum === 3 ? '#cd7f32' : 'var(--text-muted)';
    itemRow.innerHTML = `
      <div style="font-size: 0.875rem; font-weight: 700; color: ${rankColor}; text-align: center; display: flex; align-items: center; justify-content: center; gap: 2px;">
        #${rankNum}${trendHtml}
      </div>
      <div style="text-align: left; word-break: break-word; white-space: normal; line-height: 1.25; color: ${m.isMe ? 'var(--primary-color)' : 'var(--text-primary)'}">
        ${escapeHTML(m.name)}
      </div>
      <div class="text-danger">${m.streak}</div>
      <div class="text-success-fg">${m.completed}</div>
      <div class="text-warning">${m.makeup}</div>
      <div style="color: ${m.statusColor}; font-size: 0.875rem;">${m.statusStr}</div>
    `;

    // 💌 關心戳一下按鈕（僅限領袖，自己的列不顯示）
    if (_canSendCare) {
      if (!m.isMe) {
        const careBtn = document.createElement("button");
        careBtn.className = "secondary-btn";
        careBtn.title = "傳送關心提醒";
        careBtn.setAttribute("aria-label", `關心 ${m.name}`);
        careBtn.style.cssText = `
          display: flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; border-radius: 50%;
          padding: 0;
          margin: 0 auto;
          color: var(--color-brand, #04A9D2);
          background: transparent;
          border: 1px solid var(--border-card, rgba(0,0,0,0.1));
          cursor: pointer; transition: all 0.2s ease;
          flex-shrink: 0;
          box-shadow: none;
        `;
        careBtn.innerHTML = `<span class="nlc-icon nlc-icon--sm" data-icon="remind" aria-hidden="true" style="color: inherit; background: transparent;"></span>`;
        careBtn.addEventListener("mouseenter", () => {
          careBtn.style.background = "var(--color-brand-muted, rgba(4,169,210,0.08))";
          careBtn.style.borderColor = "var(--color-brand-border, rgba(4,169,210,0.24))";
        });
        careBtn.addEventListener("mouseleave", () => {
          careBtn.style.background = "transparent";
          careBtn.style.borderColor = "var(--border-card, rgba(0,0,0,0.1))";
        });
        careBtn.onclick = () => window.openCareReminderDialog(m);
        itemRow.appendChild(careBtn);
        if (typeof hydrateIcons === "function") hydrateIcons(careBtn);
      } else {
        // 自己的列提供空白的佔位元素，確保表格寬度跟 header 完全對齊
        const spacer = document.createElement("div");
        spacer.style.width = "44px";
        itemRow.appendChild(spacer);
      }
    }

    listContainer.appendChild(itemRow);
  });

  // If there are remaining items, append a "Load More" button at the bottom of the list
  if (items.length > limit) {
    const loadMoreRow = document.createElement("div");
    loadMoreRow.style.cssText = `
      text-align: center;
      padding: 0.8rem;
      margin-top: 0.4rem;
    `;

    const loadMoreBtn = document.createElement("button");
    loadMoreBtn.className = "secondary-btn";
    loadMoreBtn.style.cssText = `
      padding: 0.4rem 1.2rem;
      font-size: 0.875rem;
      font-weight: 500;
      border-radius: 20px;
      background: var(--bg-input);
      border: 1px solid var(--border-card);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
    `;
    loadMoreBtn.textContent = `載入更多成員 (剩餘 ${items.length - limit} 人)`;
    loadMoreBtn.onclick = () => {
      window.displayParticipantsList(limit + 100);
    };

    loadMoreRow.appendChild(loadMoreBtn);
    listContainer.appendChild(loadMoreRow);
  }

  // Save current ranks for next comparison
  if (activeKey) {
    const currentRanks = {};
    (window._grpScopedProcessedMembers || []).forEach(m => {
      if (m.rank && m.id) {
        currentRanks[m.id] = m.rank;
      }
    });
    try {
      localStorage.setItem(storageKey, JSON.stringify(currentRanks));
    } catch (e) {
      console.warn("Failed to save current ranks:", e);
    }
  }
}

// ==================== 組員狀況 TAB ====================
async function renderPlanMembersView() {
  if (!state.activePlan) return;

  // Set up collapsible list logic
  const toggleBtn = document.getElementById("btn-toggle-members-collapse");
  const wrapper = document.getElementById("members-list-collapsible-wrapper");
  if (toggleBtn && wrapper && !toggleBtn.dataset.listenerBound) {
    toggleBtn.dataset.listenerBound = "true";
    toggleBtn.addEventListener("click", () => {
      const isCollapsed = wrapper.classList.toggle("hidden");
      toggleBtn.querySelector("span:first-child").textContent = isCollapsed ? "展開" : "收合";
      toggleBtn.querySelector("span:last-child").textContent = isCollapsed ? "▼" : "▲";
    });
  }

  const refreshBtn = document.getElementById("btn-refresh-members-ranking");
  if (refreshBtn && !refreshBtn.dataset.listenerBound) {
    refreshBtn.dataset.listenerBound = "true";
    refreshBtn.addEventListener("click", async () => {
      window._cachedAllUsersList = null;
      window._cachedAllUsersListKey = null;
      if (typeof showToast === "function") showToast("更新排名中...");
      
      const membersTitleEl = document.getElementById("members-ranking-title");
      if (membersTitleEl) {
        const rankingTitleEl = document.getElementById("ranking-title");
        if (rankingTitleEl) rankingTitleEl.id = "_ranking-title-backup";
        membersTitleEl.id = "ranking-title";
        await renderGroupParticipantsRankingTable();
        membersTitleEl.id = "members-ranking-title";
        if (rankingTitleEl) rankingTitleEl.id = "ranking-title";
      } else {
        await renderGroupParticipantsRankingTable();
      }
      if (typeof showToast === "function") showToast("排名已更新");
    });
  }

  if (!(await prepareReadingTeamSubview("members"))) return;

  // Switch the header filter bars: show members controls, hide stats controls
  const adminScopeBar = document.getElementById("stats-admin-scope-bar");
  const membersOrgControls = document.getElementById("members-organization-controls");
  if (adminScopeBar) {
    adminScopeBar.classList.add("hidden");
    adminScopeBar.style.display = "none";
  }
  if (membersOrgControls) {
    membersOrgControls.style.display = "";
  }

  // Make sure selectors are populated correctly
  populateMembersSelector();

  // Use members-ranking-title element instead of ranking-title so the title
  // updates show up in the members subview card.
  const membersTitleEl = document.getElementById("members-ranking-title");
  if (membersTitleEl) {
    // Temporarily swap the id so the shared function writes to the right element
    const rankingTitleEl = document.getElementById("ranking-title");
    if (rankingTitleEl) rankingTitleEl.id = "_ranking-title-backup";
    membersTitleEl.id = "ranking-title";
    await renderGroupParticipantsRankingTable();
    membersTitleEl.id = "members-ranking-title";
    if (rankingTitleEl) rankingTitleEl.id = "ranking-title";
  } else {
    await renderGroupParticipantsRankingTable();
  }

  // When in org-stats mode, the members filter should also control all the
  // statistics cards and charts on this page. After renderGroupParticipantsRankingTable
  // has set window._grpScopedUsers for the selected scope, re-render the stats.
  if (window.currentPlanViewState === PLAN_ROUTE.ORG_STATS) {
    // Read the current filter value from the members selector directly.
    // Do NOT sync to ranking-zone-selector because that would fire its own
    // change listener and re-render with the wrong scope.
    const currentOrgFilter = getActiveOrgFilter();

    // Pass the filter explicitly so renderGroupMiniStats/charts use it for both
    // scopedUsers calculation and scopeLabel, bypassing _statsTabScope.
    await renderGroupMiniStats(currentOrgFilter);
    renderGroupGrowthTrend(currentOrgFilter);
    renderGroupTeamHeatmap(currentOrgFilter);

    const distCard = document.getElementById("grp-distribution-card");
    if (distCard && distCard.style.display !== "none") {
      renderGroupProgressDistribution(currentOrgFilter);
    }

    // Also update the group stats section visibility
    const groupSec = document.getElementById("stats-group-section");
    if (groupSec) {
      groupSec.classList.remove("hidden");
      groupSec.style.display = "";
    }
  }
}




window.showPlanStatsModal = function () {
  if (!state.activePlan) {
    showToast((window.APP_COPY && window.APP_COPY.plan.noPlanJoined) || "還沒加入任何計畫");
    return;
  }

  const plan = state.activePlan;
  const streakDays = computePlanScopedStreak(state.readingLogs || [], {
    planId: plan.id,
    presetKey: plan.presetKey
  });

  // 1. Calculate today's chapters progress
  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();
  const todayDayObj = plan.days.find(d => {
    if (Number(d.year) !== todayYear || Number(d.month) !== todayMonth) return false;
    const parts = d.date.split('/');
    return parts.length === 2 && Number(parts[1]) === todayDay;
  });

  let todayTotalCount = 0;
  let todayReadCount = 0;
  if (todayDayObj && todayDayObj.chapters) {
    todayTotalCount = todayDayObj.chapters.length;
    todayDayObj.chapters.forEach(ch => {
      const currentRound = plan.currentRound || 1;
      const taskRound = ch.round || currentRound;
      if (Boolean(ch["isReadR" + taskRound] || (taskRound === 1 && ch.isRead))) todayReadCount++;
    });
  }

  // 2. Calculate overall plan progress
  const totalCompletionRate = plan.progress || 0;

  // 3. Calculate catch-up days (進度救援)
  const start = new Date(plan.startDate + "T00:00:00");
  start.setHours(0, 0, 0, 0);
  const end = new Date(plan.endDate + "T00:00:00");
  end.setHours(0, 0, 0, 0);
  const totalDays = plan.totalDays || (Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
  const todayZero = new Date();
  todayZero.setHours(0, 0, 0, 0);
  const elapsedDays = Math.max(0, Math.min(totalDays, Math.round((todayZero - start) / (1000 * 60 * 60 * 24)) + 1));

  const toLocalStr = window.toLocalYYYYMMDD || ((val) => {
    if (!val) return "";
    const date = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(date.getTime())) return "";
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  });
  // 補讀：一律對「教會原始日程」算，只看第一遍的 log（第一遍後 log 不變 → 數值凍結）。
  const round1DateByChapter = new Map();
  (state.readingLogs || []).forEach(l => {
    if ((l.plan_id === plan.id || l.presetKey === plan.presetKey) && (l.round || 1) === 1) {
      round1DateByChapter.set(`${l.book}_${l.chapter}`, toLocalStr(l.read_at));
    }
  });
  const canonicalDays = typeof window.getCanonicalStageScheduleDays === "function"
    ? window.getCanonicalStageScheduleDays(plan)
    : (plan.days || []);
  const catchUpDays = countLateCompletedDays(canonicalDays, plan.startDate, round1DateByChapter);

  // 4. Calculate cumulative chapters read (累計閱讀) — 嚴格以本計畫為範圍：
  // plan_id / global_plan_id / presetKey / preset_key 任一對得上；四個都沒有才當
  // 無歸屬退路。別再用「沒有 plan_id 就算這個計畫」的寬鬆退路。
  const planIds = [plan.id, plan.globalPlanId, plan.global_plan_id].filter(Boolean).map(String);
  const planKeys = [plan.presetKey, plan.preset_key].filter(Boolean).map(String);
  const uniqueKeys = new Set();
  const planChapters = new Set();
  if (plan && plan.days) {
    plan.days.forEach(d => {
      if (d.chapters) {
        d.chapters.forEach(ch => {
          planChapters.add(`${ch.book}_${ch.chapter}`);
        });
      }
    });
  }
  if (state.readingLogs) {
    state.readingLogs.forEach(l => {
      const logPlanId = l.plan_id || l.global_plan_id;
      const logKey = l.presetKey || l.preset_key;
      const logMatchesPlan =
        (logPlanId && planIds.includes(String(logPlanId))) ||
        (logKey && planKeys.includes(String(logKey))) ||
        (!l.plan_id && !l.global_plan_id && !l.presetKey && !l.preset_key);
      if (logMatchesPlan && planChapters.has(`${l.book}_${l.chapter}`)) {
        const r = l.round || 1;
        uniqueKeys.add(`${l.book}_${l.chapter}_${r}`);
      }
    });
  }
  const totalReadChapters = uniqueKeys.size;

  // 5. Calculate completed days (達標天數)
  const totalCompletedDays = plan.days.filter(day => {
    if (!day.chapters || day.chapters.length === 0) return false;
    return day.chapters.every(ch => {
      const currentRound = plan.currentRound || 1;
      const taskRound = ch.round || currentRound;
      return Boolean(ch["isReadR" + taskRound] || (taskRound === 1 && ch.isRead));
    });
  }).length;

  // 6. Progress status（落後/超前只在第一遍；之後只顯示輪次進度 —— 見 getPlanProgressStatus）
  const progressStatus = getPlanProgressStatus(plan);
  const statusLabel = progressStatus.label;
  const statusBadgeClass = progressStatus.badgeClass || "stat-badge--brand";

  // 7. Create Stats Modal Elements
  const modalOverlay = document.createElement("div");
  modalOverlay.className = "modal-overlay";
  modalOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(15, 23, 42, 0.6);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 1.2rem;
    opacity: 0;
    transition: opacity 0.25s ease;
  `;

  const modalContainer = document.createElement("div");
  modalContainer.className = "modal-container";
  modalContainer.style.cssText = `
    background: var(--bg-card);
    border: 1px solid var(--border-card);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    width: 100%;
    max-width: 420px;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
    transform: scale(0.92);
    transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
  `;

  // Prevent background clicks closing modal unless clicked outside
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) {
      closeStatsModal();
    }
  });

  const closeStatsModal = () => {
    modalOverlay.style.opacity = "0";
    modalContainer.style.transform = "scale(0.92)";
    setTimeout(() => {
      modalOverlay.remove();
    }, 250);
  };

  // Header content
  const headerDiv = document.createElement("div");
  headerDiv.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-card);
    padding-bottom: 0.8rem;
  `;
  headerDiv.innerHTML = `
    <h3 style="font-size: 1.15rem; font-weight: 500; color: var(--text-primary); margin: 0; display: flex; align-items: center; gap: 0.5rem;">
      <span class="nlc-icon" data-icon="barChart" aria-hidden="true"></span> 詳細數據統計
    </h3>
    <button aria-label="關閉" class="dialog-close-button icon-button icon-button--subtle" onclick="this.closest('.modal-overlay').remove()"><span class="nlc-icon nlc-icon--sm" data-icon="close" aria-hidden="true"></span></button>
  `;

  headerDiv.querySelector("button").onclick = (e) => {
    e.stopPropagation();
    closeStatsModal();
  };

  // 2x2 Grid Layout Content
  const gridDiv = document.createElement("div");
  gridDiv.style.cssText = `
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.8rem;
  `;

  // Helper to generate a styled card
  const makeCardHtml = (title, dataText, desc, iconColor, bgGlow = '') => {
    return `
      <div class="stat-grid-card" style="background: var(--bg-card); border: 1px solid var(--border-card); border-radius: var(--radius-sm); padding: 0.9rem; display: flex; flex-direction: column; justify-content: space-between; height: 120px; box-shadow: var(--shadow-sm); transition: all 0.2s; ${bgGlow}">
        <div style="font-size: 0.875rem; font-weight: 500; color: var(--text-secondary); display: flex; align-items: center; gap: 0.3rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">
          ${title}
        </div>
        <div style="font-size: 1.45rem; font-weight: 500; color: ${iconColor}; margin: 0.3rem 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">
          ${dataText}
        </div>
        <div style="font-size: 0.875rem; color: var(--text-muted); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; font-weight: 500;">
          ${desc}
        </div>
      </div>
    `;
  };

  // Card A: 進度救援
  const cardA = makeCardHtml(
    iconLabel("shieldCheck", "進度救援"),
    `${catchUpDays} 天`,
    `過去落後但已成功補讀完畢的天數。`,
    `#ea580c`,
    `background: rgba(254, 118, 21, 0.06);`
  );

  // Card B: 累計閱讀
  const cardB = makeCardHtml(
    iconLabel("trophy", "累計閱讀"),
    `${totalReadChapters} 章`,
    `在此計畫中讀完的經文章節總數。`,
    `var(--primary-color)`
  );

  // Card C: 達標天數
  const cardC = makeCardHtml(
    iconLabel("calendarThirty", "達標天數"),
    `${totalCompletedDays} 天`,
    `計畫中所有章節皆 100% 讀完的累積總天數。`,
    `var(--color-success-foreground)`
  );

  // Card D: 計畫狀態 (Badge text with specific colors)
  const badgeHtml = `
    <span class="stat-badge ${statusBadgeClass}">${statusLabel}</span>
  `;
  const cardD = makeCardHtml(
    iconLabel("signpost", "計畫狀態"),
    badgeHtml,
    `目前讀經進度與計畫預期進度的比對結果。`,
    `var(--text-primary)`
  );

  gridDiv.innerHTML = cardA + cardB + cardC + cardD;

  // Bottom action close button
  const footerDiv = document.createElement("div");
  footerDiv.style.cssText = `
    display: flex;
    justify-content: flex-end;
    margin-top: 0.2rem;
  `;
  const closeBtn = document.createElement("button");
  closeBtn.className = "primary-btn";
  closeBtn.style.cssText = `
    padding: 0.5rem 1.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: 20px;
    width: 100%;
  `;
  closeBtn.textContent = "關閉";
  closeBtn.onclick = closeStatsModal;
  footerDiv.appendChild(closeBtn);

  modalContainer.appendChild(headerDiv);
  modalContainer.appendChild(gridDiv);
  modalContainer.appendChild(footerDiv);
  modalOverlay.appendChild(modalContainer);

  document.body.appendChild(modalOverlay);

  // Trigger smooth enter transitions
  requestAnimationFrame(() => {
    modalOverlay.style.opacity = "1";
    modalContainer.style.transform = "scale(1)";
  });
};

function setViewMode() {
  viewMode = 'calendar';
  state.planViewMode = 'calendar';
  ensurePlanViewModeToggle();
  renderPlanScheduleView();
}

function renderPlanScheduleView() {
  const container = document.getElementById("plan-schedule-view-container");
  if (!container || !state.activePlan) return;

  container.innerHTML = "";

  const calContainer = document.createElement("div");
  calContainer.id = "calendar-view-container";
  calContainer.className = "w-full px-4 text-center mx-0";

  const calendarCarousel = document.createElement("div");
  calendarCarousel.className = "date-carousel";
  calendarCarousel.id = "plan-date-carousel";
  calendarCarousel.style.width = "100%";

  calContainer.appendChild(calendarCarousel);
  container.appendChild(calContainer);
  renderHorizontalDateStrip();
}

function snapCalendarToToday() {
  if (!state.activePlan) return;
  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();
  const todayPlanDay = state.activePlan.days.find(d => {
    if (Number(d.year) !== todayYear || Number(d.month) !== todayMonth) return false;
    const parts = d.date.split('/');
    return parts.length === 2 && Number(parts[1]) === todayDay;
  });
  if (todayPlanDay) {
    state.selectedPlanDay = todayPlanDay.dayNum;
    state.calendarViewYear = todayYear;
    state.calendarViewMonth = todayMonth;

    // 🛡️ 只做 CSS active class 切換，嚴禁呼叫 renderHorizontalDateStrip 重繪整個日曆
    const prev = document.querySelector('.plan-day-cell.active');
    if (prev) {
      prev.classList.remove('active');
      prev.setAttribute('aria-selected', 'false');
    }
    const target = document.querySelector(`.plan-day-cell[data-day-num="${todayPlanDay.dayNum}"]`);
    if (target) {
      target.classList.add('active');
      target.setAttribute('aria-selected', 'true');
    }

    renderPlanScheduleTracker(true);
    showToast("已跳轉至今日進度");
  } else {
    showToast("今日不在計畫期間內");
  }
}

function snapCalendarToMyProgress() {
  if (!state.activePlan) return;
  const nextReadingDay = getNextReadingPlanDay(state.activePlan);
  if (nextReadingDay) {
    state.selectedPlanDay = nextReadingDay.dayNum;
    state.calendarViewYear = nextReadingDay.year || new Date().getFullYear();
    state.calendarViewMonth = nextReadingDay.month || (new Date().getMonth() + 1);

    // 🛡️ 只做 CSS active class 切換，嚴禁呼叫 renderHorizontalDateStrip 重繪整個日曆
    const prev = document.querySelector('.plan-day-cell.active');
    if (prev) {
      prev.classList.remove('active');
      prev.setAttribute('aria-selected', 'false');
    }
    const target = document.querySelector(`.plan-day-cell[data-day-num="${nextReadingDay.dayNum}"]`);
    if (target) {
      target.classList.add('active');
      target.setAttribute('aria-selected', 'true');
    }

    renderPlanScheduleTracker(true);
    showToast("已回到您的實際讀經進度");
  } else {
    showToast("計畫已全部完成！");
  }
}



// --- Stats View Logic ---

// Statistics & charts tab view controller


async function updateStatsView(filterPresetKey = null) {
  // If no filter is provided, fallback to the current active plan's global key.
  if (!filterPresetKey && state.activePlan) {
    filterPresetKey = state.activePlan.globalPlanId || state.activePlan.presetKey || state.activePlan.name || state.activePlan.id;
  }
  window.currentStatsFilterPresetKey = filterPresetKey;

  const statsTableBody = document.getElementById("stats-members-table-body");
  const statsValueIds = ["stats-total-read", "stats-total-members", "stats-active-members"];
  if (typeof ComponentSkeletonLoader !== "undefined") {
    if (statsTableBody) ComponentSkeletonLoader.fill("table-rows", statsTableBody, { count: 5, cols: 6 });
    statsValueIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.dataset.statsOriginalHtml = el.innerHTML;
        el.innerHTML = ComponentSkeletonLoader.getHtml("inline", { width: "3.5rem", height: "1.1rem" });
      }
    });
  }

  let pastoralStats = [];
  let rawAllUsers = [];

  // Pass filterPresetKey to fetchMergedUsersList so stats are plan-specific!
  const unfilteredAllUsers = await db.fetchMergedUsersList(filterPresetKey);
  window.unfilteredAllUsersCache = unfilteredAllUsers;

  const mockUser = unfilteredAllUsers.find(u => u.name === state.currentUser.name) || {
    name: state.currentUser.name,
    great_region: state.currentUser.great_region || "東區",
    pastoral_zone: state.currentUser.pastoral_zone || "大安1",
    small_group: state.currentUser.small_group || "馬鈴",
    role_code: getUserRoleCode(state.currentUser) || "member",
    chapters_read: 0,
    plan_progress: 0,
    last_read: null
  };
  window.mockUserCache = mockUser;
  rawAllUsers = [...unfilteredAllUsers];

  const role = getUserRoleCode(mockUser);

  // Dynamically calculate pastoralStats in frontend from the filtered users list!
  const zoneMap = {};
  unfilteredAllUsers.forEach(u => {
    const zone = u.pastoral_zone || "未分類";
    const region = u.great_region || "未分類";
    if (!zoneMap[zone]) {
      zoneMap[zone] = {
        name: zone,
        great_region: region,
        member_count: 0,
        total_chapters: 0,
        total_progress: 0,
        active_count: 0
      };
    }
    zoneMap[zone].member_count++;
    zoneMap[zone].total_chapters += u.chapters_read || 0;
    zoneMap[zone].total_progress += u.plan_progress || 0;
    if (u.chapters_read > 0) {
      zoneMap[zone].active_count++;
    }
  });

  pastoralStats = Object.values(zoneMap).map(item => ({
    name: item.name,
    great_region: item.great_region,
    member_count: item.member_count,
    total_chapters: item.total_chapters,
    avg_progress: Math.round(item.total_progress / item.member_count) || 0,
    active_count: item.active_count
  })).sort((a, b) => b.total_chapters - a.total_chapters);

  rawAllUsers = getScopedUsers(rawAllUsers, mockUser);

  // Filter pastoralStats based on Great Region for non-admin roles
  if (!hasWholeChurchPlanScope(role)) {
    pastoralStats = pastoralStats.filter(z => z.great_region === mockUser.great_region);
  }

  // 1. Determine Stats Scoped Users
  let statsUsers = [];
  if (hasWholeChurchPlanScope(role)) {
    const zoneSelectGroup = document.getElementById("stats-zone-selector");
    const selectedZone = zoneSelectGroup ? zoneSelectGroup.value : "";
    if (selectedZone) {
      statsUsers = unfilteredAllUsers.filter(u => u.pastoral_zone === selectedZone);
    } else {
      statsUsers = unfilteredAllUsers;
    }
  } else if (role === "great_zone_leader") {
    statsUsers = unfilteredAllUsers.filter(u => u.great_region === mockUser.great_region);
  } else if (role === "zone_leader") {
    statsUsers = unfilteredAllUsers.filter(u => u.pastoral_zone === mockUser.pastoral_zone);
  } else { // group_leader or member
    statsUsers = unfilteredAllUsers.filter(u => u.pastoral_zone === mockUser.pastoral_zone && u.small_group === mockUser.small_group);
  }

  if (statsUsers.length === 0) {
    statsUsers = [mockUser];
  }

  // 2. Update Mini Card Labels based on Scoped Team
  const miniCardLabels = document.querySelectorAll('.stats-overview-row .label');
  if (miniCardLabels.length === 3) {
    if (hasWholeChurchPlanScope(role)) {
      const zoneSelectGroup = document.getElementById("stats-zone-selector");
      const selectedZone = zoneSelectGroup ? zoneSelectGroup.value : "";
      miniCardLabels[0].textContent = selectedZone ? `${selectedZone} 總閱讀章數` : "全教會總閱讀章數";
      miniCardLabels[1].textContent = selectedZone ? `${selectedZone} 參與人數` : "全教會參與人數";
      miniCardLabels[2].textContent = selectedZone ? `${selectedZone} 本週活躍人數` : "全教會本週活躍人數";
    } else if (role === "great_zone_leader") {
      miniCardLabels[0].textContent = "本大區總閱讀章數";
      miniCardLabels[1].textContent = "本大區參與人數";
      miniCardLabels[2].textContent = "本大區本週活躍人數";
    } else if (role === "zone_leader") {
      miniCardLabels[0].textContent = "本牧區總閱讀章數";
      miniCardLabels[1].textContent = "本牧區參與人數";
      miniCardLabels[2].textContent = "本牧區本週活躍人數";
    } else { // group_leader or member
      miniCardLabels[0].textContent = "本小組總閱讀章數";
      miniCardLabels[1].textContent = "本小組參與人數";
      miniCardLabels[2].textContent = "本小組本週活躍人數";
    }
  }

  // 3. Render Mini Card values
  const totalChaptersAll = statsUsers.reduce((sum, item) => sum + (item.chapters_read || 0), 0);
  const totalMembers = statsUsers.length;
  const totalActive = statsUsers.filter(u => {
    if (!u.last_read) return false;
    const lastReadDate = new Date(u.last_read);
    const today = new Date();
    const diffTime = Math.abs(today - lastReadDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays <= 2;
  }).length;

  document.getElementById("stats-total-read").textContent = totalChaptersAll + " 章";
  document.getElementById("stats-total-members").textContent = totalMembers + " 人";
  document.getElementById("stats-active-members").textContent = totalActive + " 人";

  // 3. Render Roster Details Table
  renderRosterTable(rawAllUsers);

  // 4. Handle Chart visibility and rendering
  const chartsContainer = document.getElementById("pastoral-rank-chart").closest('.grid-layout');
  const groupChartContainer = document.getElementById("group-stats-chart").closest('.grid-layout');
  const zoneSelectGroup = document.getElementById("stats-zone-selector");

  // Show both charts to everyone, but apply filters/locks by role
  chartsContainer.classList.remove("hidden");
  groupChartContainer.classList.remove("hidden");

  if (role === "member" || role === "group_leader" || role === "zone_leader") {
    zoneSelectGroup.innerHTML = `<option value="${mockUser.pastoral_zone}">${mockUser.pastoral_zone}</option>`;
    zoneSelectGroup.value = mockUser.pastoral_zone;
    zoneSelectGroup.disabled = true;

    renderCharts(pastoralStats);
    updateGroupChart(mockUser.pastoral_zone);
  } else {
    zoneSelectGroup.disabled = false;

    populateStatsZoneSelector(pastoralStats);
    renderCharts(pastoralStats);
  }

  // Render Monthly Hall of Fame
  renderMonthlyHallOfFame();

  // Render Heatmap and Badges Wall
  renderHeatmap(statsUsers);
  if (typeof renderUnlockedBadgesWall !== 'undefined') {
    renderUnlockedBadgesWall();
  }

  // Render Team Progress Status & Growth Trend Dashboard
  renderTeamStatsAnalysisDashboard(unfilteredAllUsers, mockUser);

  if (typeof ComponentSkeletonLoader !== "undefined") {
    statsValueIds.forEach(id => {
      const el = document.getElementById(id);
      if (el && el.dataset.statsOriginalHtml !== undefined) {
        delete el.dataset.statsOriginalHtml;
      }
    });
  }
}

function renderRosterTable(users) {
  const tbody = document.getElementById("stats-members-table-body");
  tbody.innerHTML = "";

  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">尚無使用者資料</td></tr>`;
    return;
  }

  // Sort by chapters read descending
  const sorted = [...users].sort((a, b) => b.chapters_read - a.chapters_read);
  sorted.forEach(user => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHTML(user.name)}</strong></td>
      <td>${escapeHTML(user.pastoral_zone || "無")}</td>
      <td>${escapeHTML(user.small_group || "無")}</td>
      <td><span style="font-weight: 500; color: var(--primary-color);">${user.chapters_read}</span> 章</td>
      <td>
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <span style="font-size:0.875rem; font-weight: 500;">${user.plan_progress}%</span>
          <div style="flex:1; width:50px; height:6px; background: var(--color-progress-track); border-radius:5px; overflow:hidden;">
            <div style="width:${user.plan_progress}%; height:100%; background: var(--color-success);"></div>
          </div>
        </div>
      </td>
      <td>🔥 ${user.streak || 0} 天</td>
    `;
    tbody.appendChild(tr);
  });
}

function populateStatsZoneSelector(zones) {
  const selector = document.getElementById("stats-zone-selector");
  selector.innerHTML = "";

  zones.forEach(zone => {
    const option = document.createElement("option");
    option.value = zone.name;
    option.textContent = zone.name;
    selector.appendChild(option);
  });

  selector.onchange = () => {
    updateGroupChart(selector.value);
    if (typeof renderTeamStatsAnalysisDashboard === 'function') {
      renderTeamStatsAnalysisDashboard(window.unfilteredAllUsersCache, window.mockUserCache);
    }
  };

  if (zones.length > 0) {
    updateGroupChart(zones[0].name);
  }
}

function renderCharts(zoneStats) {
  const canvasRank = document.getElementById("pastoral-rank-chart");
  const canvasProgress = document.getElementById("pastoral-progress-chart");

  const labels = zoneStats.map(z => z.name);
  const chaptersData = zoneStats.map(z => z.total_chapters);
  const progressData = zoneStats.map(z => z.avg_progress);

  const isDark = state.theme === "dark" || document.body.classList.contains("dark-theme");
  const fontColor = isDark ? NLC_CHART.muted : NLC_DESIGN.black;
  const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";

  // Chart 1: Ranking Chart
  renderOrUpdateChart('rank', canvasRank, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '累計速讀章數',
        data: chaptersData,
        backgroundColor: [
          'rgba(4, 169, 210, 0.85)',
          'color-mix(in srgb, var(--color-success) 85%, transparent)',
          'rgba(245, 158, 11, 0.85)',
          'rgba(252, 54, 90, 0.85)'
        ],
        borderRadius: 8,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: { ticks: { color: fontColor }, grid: { display: false } },
        y: { ticks: { color: fontColor }, grid: { color: gridColor } }
      }
    }
  });

  // Chart 2: Average Progress Chart
  renderOrUpdateChart('progress', canvasProgress, {
    type: 'radar',
    data: {
      labels: labels,
      datasets: [{
        label: '平均進度 (%)',
        data: progressData,
        backgroundColor: 'rgba(4, 169, 210, 0.2)',
        borderColor: 'rgba(4, 169, 210, 0.9)',
        borderWidth: 2,
        pointBackgroundColor: '#04A9D2'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        r: {
          angleLines: { color: gridColor },
          grid: { color: gridColor },
          pointLabels: { color: fontColor, font: { weight: 'bold' } },
          ticks: { backdropColor: 'transparent', color: fontColor, min: 0, max: 100 }
        }
      }
    }
  });
}

async function updateGroupChart(zoneName) {
  const canvasGroup = document.getElementById("group-stats-chart");

  let groupStats = [];
  const mockUser = {
    name: state.currentUser.name,
    pastoral_zone: state.currentUser.pastoral_zone || "大安1",
    small_group: state.currentUser.small_group || "馬鈴",
    chapters_read: state.currentUser.chapters_read,
    plan_progress: state.currentUser.plan_progress,
    last_read: state.currentUser.last_read
  };

  if (state.isSupabaseMode && state.supabase) {
    try {
      const { data } = await state.supabase
        .from("view_small_group_stats")
        .select("pastoral_zone, small_group, total_chapters_read")
        .eq("pastoral_zone", zoneName);

      if (data) {
        groupStats = data.map(item => ({
          name: item.small_group,
          total_chapters: item.total_chapters_read
        })).sort((a, b) => b.total_chapters - a.total_chapters);
      }
    } catch (e) {
      console.error("Failed to load small group stats from Supabase:", e);
    }
  } else {
    if (typeof MockStatsService !== 'undefined' && MockStatsService) {
      groupStats = MockStatsService.getSmallGroupStats(zoneName, mockUser);
    } else {
      groupStats = [];
    }
  }

  const labels = groupStats.map(g => g.name);
  const data = groupStats.map(g => g.total_chapters);

  const isDark = state.theme === "dark" || document.body.classList.contains("dark-theme");
  const fontColor = isDark ? NLC_CHART.muted : NLC_DESIGN.black;
  const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";

  renderOrUpdateChart('group', canvasGroup, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '累計章數',
        data: data,
        backgroundColor: 'color-mix(in srgb, var(--color-success) 80%, transparent)',
        borderRadius: 6
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: fontColor }, grid: { color: gridColor } },
        y: { ticks: { color: fontColor }, grid: { display: false } }
      }
    }
  });
}

function renderMonthlyHallOfFame() {
  const fameList = document.getElementById("monthly-fame-list");
  if (!fameList) return;

  fameList.innerHTML = "";

  const placeholder = document.createElement("div");
  placeholder.style.cssText = "grid-column: span 3; text-align: center; padding: 2rem; color: var(--text-muted); font-size: 0.9rem;";
  placeholder.textContent = "正式計畫尚未結算，月度名人堂虛位以待！";
  fameList.appendChild(placeholder);
}

// ==========================================
// TEAM BIBLE READING HEATMAP
// ==========================================

function getTeamLogs(teamUsers) {
  const filterPresetKey = window.currentStatsFilterPresetKey;
  if (state.isSupabaseMode && state.allLogsCache) {
    const userIds = new Set(teamUsers.map(u => u.id));
    return state.allLogsCache.filter(l => {
      if (!userIds.has(l.user_id)) return false;
      if (filterPresetKey) {
        const cacheKey = l.user_id + '_' + filterPresetKey;
        if (window.userPlanIdCache && window.userPlanIdCache[cacheKey]) {
          return l.plan_id === window.userPlanIdCache[cacheKey];
        }
        if (l.user_id === state.currentUser.id && state.activePlan) {
          return l.plan_id === state.activePlan.id;
        }
        return false;
      }
      return true;
    });
  } else {
    // Generate mock logs for team users based on their chapters_read and last_read
    const logs = [];

    // Include current user's real logs
    const currentUserRealLogs = state.readingLogs.filter(l => {
      if (filterPresetKey) {
        return l.presetKey === filterPresetKey || (state.activePlan && l.plan_id === state.activePlan.id);
      }
      return true;
    }).map(l => ({
      user_id: state.currentUser.id || state.currentUser.name,
      read_at: l.read_at
    }));
    logs.push(...currentUserRealLogs);

    const otherUsers = teamUsers.filter(u => u.name !== state.currentUser.name);
    otherUsers.forEach(u => {
      if (!u.chapters_read) return;

      const lastReadDateStr = u.last_read || new Date().toISOString().substring(0, 10);
      const lastReadDate = new Date(lastReadDateStr);
      lastReadDate.setHours(12, 0, 0, 0);

      let chaptersRemaining = u.chapters_read;
      // We will distribute the check-ins backwards from lastReadDate
      let currentDate = new Date(lastReadDate);

      // Let's generate daily check-ins
      for (let i = 0; i < 365 && chaptersRemaining > 0; i++) {
        const seed = Math.sin(u.name.charCodeAt(0) + i) * 10000;
        const rand = seed - Math.floor(seed);

        if (rand < 0.35) {
          const count = Math.min(chaptersRemaining, Math.floor(rand * 5) + 1);
          const dateStr = currentDate.toISOString().substring(0, 10);
          for (let c = 0; c < count; c++) {
            logs.push({
              user_id: u.id || u.name,
              read_at: dateStr
            });
          }
          chaptersRemaining -= count;
        }
        currentDate.setDate(currentDate.getDate() - 1);
      }
    });
    return logs;
  }
}

function renderHeatmap(teamUsers = []) {
  const container = document.getElementById("bible-heatmap-container");
  if (!container) return;

  container.innerHTML = "";

  // Title update based on scope
  const titleEl = document.getElementById("heatmap-card-title");
  if (titleEl) {
    const role = getUserRoleCode(state.currentUser) || "member";
    if (hasWholeChurchPlanScope(role)) {
      const zoneSelectGroup = document.getElementById("stats-zone-selector");
      const selectedZone = zoneSelectGroup ? zoneSelectGroup.value : "";
      titleEl.textContent = selectedZone
        ? `${selectedZone} 團隊讀經活躍度 (近4個月打卡活躍度)`
        : "全教會團隊讀經活躍度 (近4個月打卡活躍度)";
    } else if (role === "great_zone_leader") {
      titleEl.textContent = `${state.currentUser.great_region} 團隊讀經活躍度 (近4個月打卡活躍度)`;
    } else if (role === "zone_leader") {
      titleEl.textContent = `${state.currentUser.pastoral_zone} 團隊讀經活躍度 (近4個月打卡活躍度)`;
    } else {
      titleEl.textContent = `${state.currentUser.small_group} 小組讀經活躍度 (近4個月打卡活躍度)`;
    }
  }

  // Build logs-by-date map from team logs
  const teamLogs = getTeamLogs(teamUsers);
  const logsByDate = {};
  teamLogs.forEach(log => {
    if (log.read_at) {
      const dStr = log.read_at.substring(0, 10);
      logsByDate[dStr] = (logsByDate[dStr] || 0) + 1;
    }
  });

  const planStart = state.activePlan ? state.activePlan.startDate : null;
  const planEnd = state.activePlan ? state.activePlan.endDate : null;
  buildHeatmapGrid("bible-heatmap-container", logsByDate, teamUsers.length, "章", planStart, planEnd);
}

// ==========================================
// TEAM STATISTICS ANALYSIS & GROWTH TREND
// ==========================================

function renderTeamStatsAnalysisDashboard(unfilteredAllUsers, mockUser) {
  let teamUsers = [];
  const role = getUserRoleCode(mockUser) || 'member';

  if (hasWholeChurchPlanScope(role)) {
    const zoneSelectGroup = document.getElementById("stats-zone-selector");
    const selectedZone = zoneSelectGroup ? zoneSelectGroup.value : "";
    if (selectedZone) {
      teamUsers = unfilteredAllUsers.filter(u => u.pastoral_zone === selectedZone);
    } else {
      teamUsers = unfilteredAllUsers;
    }
  } else if (role === 'great_zone_leader') {
    teamUsers = unfilteredAllUsers.filter(u => u.great_region === mockUser.great_region);
  } else if (role === 'zone_leader') {
    teamUsers = unfilteredAllUsers.filter(u => u.pastoral_zone === mockUser.pastoral_zone);
  } else {
    // member or group_leader
    teamUsers = unfilteredAllUsers.filter(u => u.pastoral_zone === mockUser.pastoral_zone && u.small_group === mockUser.small_group);
  }

  if (teamUsers.length === 0) {
    teamUsers = [mockUser];
  }

  const totalTeamCount = teamUsers.length;

  // 1. Completion Rate Today
  const todayStr = typeof toTaiwanISODate === "function" ? toTaiwanISODate() : new Date().toISOString().substring(0, 10);
  const completedTodayCount = teamUsers.filter(u => u.last_read === todayStr).length;
  const todayCompletionRate = totalTeamCount > 0 ? Math.round((completedTodayCount / totalTeamCount) * 100) : 0;

  document.getElementById("team-today-completion-rate").textContent = todayCompletionRate + "%";

  // 2. Expected progress percentage
  let expectedPercentage = 0;
  if (state.activePlan) {
    const start = new Date(state.activePlan.startDate);
    const end = new Date(state.activePlan.endDate);
    const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
    const today = new Date();
    const elapsedDays = Math.max(0, Math.min(totalDays, Math.ceil((today - start) / (1000 * 60 * 60 * 24)) + 1));
    expectedPercentage = Math.round((elapsedDays / totalDays) * 100) || 0;
  } else {
    expectedPercentage = 50;
  }

  let aheadCount = 0;
  let onScheduleCount = 0;
  let behindCount = 0;
  let round2PlusCount = 0;

  teamUsers.forEach(u => {
    // Determine round proxy if round field is undefined (e.g. mock data)
    const round = u.current_round !== undefined
      ? u.current_round
      : (u.chapters_read > 500 ? (u.chapters_read > 850 ? 3 : 2) : 1);

    if (round >= 2) {
      round2PlusCount++;
      aheadCount++;
      return;
    }

    if (u.plan_progress === 0) {
      behindCount++;
    } else if (u.plan_progress > expectedPercentage + 5) {
      aheadCount++;
    } else if (u.plan_progress < expectedPercentage - 5) {
      behindCount++;
    } else {
      onScheduleCount++;
    }
  });

  const aheadRate = totalTeamCount > 0 ? Math.round((aheadCount / totalTeamCount) * 100) : 0;
  const onScheduleRate = totalTeamCount > 0 ? Math.round((onScheduleCount / totalTeamCount) * 100) : 0;
  const behindRate = totalTeamCount > 0 ? Math.round((behindCount / totalTeamCount) * 100) : 0;
  const round2PlusRate = totalTeamCount > 0 ? Math.round((round2PlusCount / totalTeamCount) * 100) : 0;

  document.getElementById("team-stat-ahead-label").textContent = `${aheadCount} 人 (${aheadRate}%)`;
  document.getElementById("team-stat-on-schedule-label").textContent = `${onScheduleCount} 人 (${onScheduleRate}%)`;
  document.getElementById("team-stat-behind-label").textContent = `${behindCount} 人 (${behindRate}%)`;
  document.getElementById("team-stat-round2-label").textContent = `${round2PlusCount} 人 (${round2PlusRate}%)`;

  document.getElementById("team-stat-ahead-bar").style.width = aheadRate + "%";
  document.getElementById("team-stat-on-schedule-bar").style.width = onScheduleRate + "%";
  document.getElementById("team-stat-behind-bar").style.width = behindRate + "%";
  document.getElementById("team-stat-round2-bar").style.width = round2PlusRate + "%";

  // 3. Render Growth Trend Chart
  const canvasGrowth = document.getElementById("team-growth-chart");

  const totalActiveMembers = teamUsers.filter(u => u.chapters_read > 0).length;
  const trendData = [];
  const trendLabels = [];
  const todayDateObj = new Date();

  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayDateObj);
    d.setDate(todayDateObj.getDate() - i);
    trendLabels.push(d.toISOString().substring(5, 10).replace('-', '/'));

    const factor = 0.8 + (6 - i) * 0.033;
    trendData.push(Math.round(totalActiveMembers * factor));
  }

  const isDark = state.theme === "dark" || document.body.classList.contains("dark-theme");
  const fontColor = isDark ? NLC_CHART.muted : NLC_DESIGN.black;
  const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";

  renderOrUpdateChart('growth', canvasGrowth, {
    type: 'line',
    data: {
      labels: trendLabels,
      datasets: [{
        label: '參與人數',
        data: trendData,
        borderColor: '#04A9D2',
        backgroundColor: 'var(--color-brand-subtle, rgba(4,169,210,0.12))',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#04A9D2'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: fontColor }, grid: { display: false } },
        y: { ticks: { color: fontColor, stepSize: 1 }, grid: { color: gridColor } }
      }
    }
  });

  // Render personal stats card
  renderProfileReadingStats();

  // Render team heatmap
  renderHeatmap(teamUsers);
}

// ─────────────────────────────────────────────
// Personal Reading Stats Calculation & Rendering (Migrated from profile.js)
// ─────────────────────────────────────────────

/**
 * Calculate reading statistics for the active plan.
 */
function calculateProfileStats(plan) {
  if (!plan) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(plan.startDate + "T00:00:00");
  start.setHours(0, 0, 0, 0);
  const end = new Date(plan.endDate + "T00:00:00");
  end.setHours(0, 0, 0, 0);

  const totalDays = plan.totalDays || (Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
  const elapsedDays = Math.max(0, Math.min(totalDays, Math.round((today - start) / (1000 * 60 * 60 * 24)) + 1));

  // 落後/超前/補讀一律對「教會原始日程」算，且只在第一遍（見比對原則）。
  const currentRound = plan.currentRound || 1;
  const toLocalStr = window.toLocalYYYYMMDD || ((val) => {
    if (!val) return "";
    const date = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(date.getTime())) return "";
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  });
  const canonicalDays = typeof window.getCanonicalStageScheduleDays === "function"
    ? window.getCanonicalStageScheduleDays(plan)
    : (plan.days || []);
  const round1DateByChapter = new Map();
  (state.readingLogs || []).forEach(l => {
    if ((l.plan_id === plan.id || l.presetKey === plan.presetKey) && (l.round || 1) === 1) {
      round1DateByChapter.set(`${l.book}_${l.chapter}`, toLocalStr(l.read_at));
    }
  });

  let lagDays = 0;
  let leadDays = 0;
  if (currentRound === 1 && !plan.isPlanCompleted) {
    const round1Chapters = round1DateByChapter.size;
    const completedDays = countScheduleDaysCoveredByChapters(canonicalDays, round1Chapters);
    const expectedDays = countExpectedScheduleDays(canonicalDays, plan.startDate, today);
    const diff = completedDays - expectedDays;
    if (diff > 0) leadDays = diff;
    else if (diff < 0) lagDays = -diff;
  }

  // 補讀：只看第一遍的 log，第一遍後 log 不再變 → 數值自然凍結。
  const makeupDays = countLateCompletedDays(canonicalDays, plan.startDate, round1DateByChapter);

  return {
    elapsedDays,
    totalDays,
    lagDays,
    leadDays,
    makeupDays,
    startDateStr: plan.startDate,
    endDateStr: plan.endDate,
    currentRound
  };
}

/**
 * Render personal reading stats card.
 */
function renderProfileReadingStats(container) {
  if (!container) return;

  const plan = state.activePlan;
  const streakDays = computePlanScopedStreak(state.readingLogs || [], {
    planId: plan && plan.id,
    presetKey: plan && plan.presetKey
  });
  const stats = calculateProfileStats(plan);

  if (!plan || !stats) {
    // Empty state
    container.innerHTML = `
      <div class="empty-state" style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted);">
        <div style="margin: 0 auto 1rem; opacity: 0.6; display: block; width: 48px;">
          ${typeof renderIcon === "function" ? renderIcon("inbox", { size: "hero", className: "nlc-icon" }) : ""}
        </div>
        <p style="font-size: 0.9rem; font-weight: 500; margin-bottom: 0.5rem; color: var(--text-primary);">${(window.APP_COPY && window.APP_COPY.stats.noPlan) || "尚未加入讀經計畫"}</p>
        <p style="font-size: 0.875rem; color: var(--text-muted); line-height: 1.5; margin-bottom: 1.5rem;">
          請至「計畫」分頁挑選計畫並加入，即可在此查看進度統計。
        </p>
        
        <div class="stat-item-card" style="background: var(--bg-card); border: 1px solid var(--border-card); padding: 0.8rem 1rem; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between; text-align: left;">
          <div style="display: flex; align-items: center; gap: 0.8rem;">
            <div class="stat-icon-wrapper stat-icon-wrapper--sm stat-icon-wrapper--danger">
              ${typeof renderIcon === "function" ? renderIcon("fire", { size: "sm", className: "nlc-icon" }) : ""}
            </div>
            <div>
              <div style="font-size: 0.875rem; color: var(--text-secondary); font-weight: 500;">連續讀經</div>
            </div>
          </div>
          <div class="stat-value stat-value--hero stat-value--danger">
            ${streakDays} <span class="stat-value__unit">天</span>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // Determine Today's Progress display string
  let todayProgressText = "";
  const start = new Date(stats.startDateStr);
  const end = new Date(stats.endDateStr);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  if (today < start) {
    todayProgressText = `<span style="font-size: 0.875rem; font-weight: 500; color: var(--text-muted);">尚未開始 (預計 ${stats.startDateStr})</span>`;
  } else if (today > end) {
    todayProgressText = `<span style="font-size: 0.875rem; font-weight: 500; color: var(--text-muted);">已結束 (共 ${stats.totalDays} 天)</span>`;
  } else {
    todayProgressText = `<span style="font-size: 1.25rem; font-weight: 500; color: var(--primary-color);">${stats.elapsedDays}</span> <span style="font-size: 0.875rem; font-weight: 500; color: var(--text-secondary);">/ ${stats.totalDays} 天</span>`;
  }

  const lagDisplay = stats.lagDays > 0
    ? `${stats.lagDays} <span style="font-size: 0.875rem; font-weight: 500; color: var(--text-secondary);">天</span>`
    : `<span style="font-size: 0.95rem; font-weight: 500; color: var(--text-muted);">0 天</span>`;

  const leadDisplay = stats.leadDays > 0
    ? `${stats.leadDays} <span style="font-size: 0.875rem; font-weight: 500; color: var(--text-secondary);">天</span>`
    : `<span style="font-size: 0.95rem; font-weight: 500; color: var(--text-muted);">0 天</span>`;

  const makeupDisplay = stats.makeupDays > 0
    ? `${stats.makeupDays} <span style="font-size: 0.875rem; font-weight: 500; color: var(--text-secondary);">天</span>`
    : `<span style="font-size: 0.95rem; font-weight: 500; color: var(--text-muted);">0 天</span>`;

  const lagIconClass = stats.lagDays > 0 ? "stat-icon-wrapper--danger" : "stat-icon-wrapper--neutral";
  const lagValueClass = stats.lagDays > 0 ? "stat-value--danger" : "stat-value--muted";
  const leadIconClass = stats.leadDays > 0 ? "stat-icon-wrapper--success" : "stat-icon-wrapper--neutral";
  const leadValueClass = stats.leadDays > 0 ? "stat-value--success" : "stat-value--muted";
  const makeupIconClass = stats.makeupDays > 0 ? "stat-icon-wrapper--brand" : "stat-icon-wrapper--neutral";
  const makeupValueClass = stats.makeupDays > 0 ? "stat-value--brand" : "stat-value--muted";

  container.innerHTML = `
    <div class="profile-stats-grid" style="display: grid; grid-template-columns: 1fr; gap: 1rem;">
      
      <!-- Today's Day -->
      <div class="stat-item-card" style="background: var(--bg-card); border: 1px solid var(--border-card); padding: 1rem; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 0.8rem;">
          <div class="stat-icon-wrapper stat-icon-wrapper--brand">
            ${typeof renderIcon === "function" ? renderIcon("calendar", { size: "sm", className: "nlc-icon" }) : ""}
          </div>
          <div>
            <div style="font-size: 0.875rem; color: var(--text-secondary); font-weight: 500;">今日進度</div>
            <div style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.1rem;">目前讀經進度天數</div>
          </div>
        </div>
        <div class="stat-value stat-value--brand">
          \\\${todayProgressText}
        </div>
      </div>

      <!-- Consecutive Streak -->
      <div class="stat-item-card" style="background: var(--bg-card); border: 1px solid var(--border-card); padding: 1rem; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 0.8rem;">
          <div class="stat-icon-wrapper stat-icon-wrapper--danger">
            ${typeof renderIcon === "function" ? renderIcon("fire", { size: "sm", className: "nlc-icon" }) : ""}
          </div>
          <div>
            <div style="font-size: 0.875rem; color: var(--text-secondary); font-weight: 500;">連續讀經</div>
            <div style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.1rem;">每日穩定靈修天數</div>
          </div>
        </div>
        <div class="stat-value stat-value--danger">
          \\\${streakDays} <span class="stat-value__unit">天</span>
        </div>
      </div>

      <!-- Behind Days -->
      <div class="stat-item-card" style="background: var(--bg-card); border: 1px solid var(--border-card); padding: 1rem; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 0.8rem;">
          <div class="stat-icon-wrapper \\\${lagIconClass}">
            \\\${typeof renderIcon === "function" ? renderIcon("exclamationCircle", { size: "sm", className: "nlc-icon" }) : ""}
          </div>
          <div>
            <div style="font-size: 0.875rem; color: var(--text-secondary); font-weight: 500;">落後進度</div>
            <div style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.1rem;">落後預計進度天數</div>
          </div>
        </div>
        <div class="stat-value \\\${lagValueClass}">
          \\\${lagDisplay}
        </div>
      </div>

      <!-- Ahead Days -->
      <div class="stat-item-card" style="background: var(--bg-card); border: 1px solid var(--border-card); padding: 1rem; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 0.8rem;">
          <div class="stat-icon-wrapper \\\${leadIconClass}">
            \\\${typeof renderIcon === "function" ? renderIcon("trendTwo", { size: "sm", className: "nlc-icon" }) : ""}
          </div>
          <div>
            <div style="font-size: 0.875rem; color: var(--text-secondary); font-weight: 500;">超前進度</div>
            <div style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.1rem;">超前預計進度天數</div>
          </div>
        </div>
        <div class="stat-value \\\${leadValueClass}">
          \\\${leadDisplay}
        </div>
      </div>

      <!-- Makeup Days -->
      <div class="stat-item-card" style="background: var(--bg-card); border: 1px solid var(--border-card); padding: 1rem; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 0.8rem;">
          <div class="stat-icon-wrapper \\\${makeupIconClass}">
            \\\${typeof renderIcon === "function" ? renderIcon("refresh", { size: "sm", className: "nlc-icon" }) : ""}
          </div>
          <div>
            <div style="font-size: 0.875rem; color: var(--text-secondary); font-weight: 500;">補讀天數</div>
            <div style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.1rem;">事後補讀完畢天數</div>
          </div>
        </div>
        <div class="stat-value \\\${makeupValueClass}">
          \\\${makeupDisplay}
        </div>
      </div>

    </div>
  `;
}

async function enterPlanListState() {
  window.currentPlanViewState = PLAN_ROUTE.LIST;
  state.planDetailOpen = false;
  state.planActiveSubTab = "today";
  if (window.PlanPageController) window.PlanPageController.groupLoadedForPlanKey = null;
  const shell = setOnlyPlanRouteVisible(PLAN_ROUTE.LIST);
  moveGroupNodesToDetail(shell);
  renderJoinedPlansList();
  renderPresetPlansList();
}

async function enterPlanDetailState() {
  if (typeof window.guardPlanEligibility === "function" && window.guardPlanEligibility()) return;
  if (!state.activePlan) {
    await enterPlanListState();
    return;
  }
  // 每日靈修計畫：不跑讀經打卡機制，改渲染靈修 viewer。
  if ((state.activePlan.planKind || state.activePlan.plan_kind) === "devotional") {
    window.currentPlanViewState = PLAN_ROUTE.DETAIL;
    state.planDetailOpen = true;
    state.planActiveSubTab = "today";
    setOnlyPlanRouteVisible(PLAN_ROUTE.DETAIL);
    await renderDevotionViewer(state.activePlan);
    return;
  }
  calculatePlanProgress();
  window.currentPlanViewState = PLAN_ROUTE.DETAIL;
  state.planDetailOpen = true;
  state.planActiveSubTab = "today";
  setOnlyPlanRouteVisible(PLAN_ROUTE.DETAIL);
  if (window.PlanPageController) await window.PlanPageController.switchPage(PLAN_PAGE.READING, { skipChrome: true });
}

async function fetchGroupRankings(planId) {
  if (!state.activePlan && planId) {
    state.activePlan = (state.activePlans || []).find(plan =>
      plan.id === planId ||
      plan.globalPlanId === planId ||
      plan.presetKey === planId
    ) || null;
    if (typeof window.syncActivePlanContext === "function") window.syncActivePlanContext(state.activePlan);
  }
  if (!state.activePlan) return;

  window._statsTabScope = getDefaultGroupStatsScope();
  populateStatsSelector();
  populateMembersSelector();
}

async function enterGroupProgressState() {
  if (typeof window.guardPlanEligibility === "function" && window.guardPlanEligibility()) return;
  if (!state.activePlan) {
    await enterPlanListState();
    return;
  }
  window.currentPlanViewState = PLAN_ROUTE.GROUP;
  state.planDetailOpen = true;

  const isTeamPlan = typeof window.isReadingTeamPlan === "function" && window.isReadingTeamPlan(state.activePlan);
  let hasTeam = false;
  if (isTeamPlan) {
    hasTeam = await checkUserHasTeam();
  }

  let requestedSubview = Object.values(GROUP_SUBVIEW).includes(state.planActiveSubTab)
    ? state.planActiveSubTab
    : (window.PlanPageController?.groupSubview || GROUP_SUBVIEW.STATS);

  if (isTeamPlan && !hasTeam && requestedSubview === GROUP_SUBVIEW.STATS) {
    requestedSubview = GROUP_SUBVIEW.PERSONAL;
  }

  state.planActiveSubTab = requestedSubview;
  setOnlyPlanRouteVisible(PLAN_ROUTE.GROUP);
  if (window.PlanPageController) {
    window.PlanPageController.groupSubview = requestedSubview;
    await window.PlanPageController.switchPage(PLAN_PAGE.GROUP, { skipChrome: true, primaryView: requestedSubview });
  }
}

async function setPlanState(newState) {
  ensurePlanRouteShell();

  const normalized = String(newState || "").toUpperCase();
  if (normalized === PLAN_ROUTE.DETAIL || normalized === "DETAIL" || normalized === PLAN_ROUTE.GROUP || normalized === "GROUP") {
    if (state.activePlan && isPlanExpired(state.activePlan)) {
      showToast("此計畫已過期，僅供查看紀錄與統計。");
    }
  }


  if (normalized === PLAN_ROUTE.LIST || normalized === "LIST") {
    await enterPlanListState();
  } else if (normalized === PLAN_ROUTE.DETAIL || normalized === "DETAIL") {
    await enterPlanDetailState();
  } else if (normalized === PLAN_ROUTE.GROUP || normalized === "GROUP") {
    await enterGroupProgressState();

  } else {
    console.error(`[PlanSM] Unknown state: ${newState}`);
    return;
  }

  if (typeof appRouter !== "undefined" && typeof appRouter.updateNavigationChrome === "function") {
    appRouter.updateNavigationChrome();
  }
}

async function showDiscoverPlans() {
  await setPlanState(PLAN_ROUTE.LIST);
  document.querySelector('#plan-list-status-pills .pill-btn[data-filter="saved"]')?.click();
}

// ── 每日靈修 viewer（會友端；plan_kind='devotional'）─────────────────────────
let devotionViewerDayIndex = null;
let devotionViewerPlanId = null;

function renderDevotionViewer(plan) {
  const host = document.getElementById("plan-detail-subview");
  if (!host) return Promise.resolve();
  host.innerHTML = '<div class="devotion-view"><p class="devotion-view__loading">正在載入每日靈修…</p></div>';

  const planId = plan.globalPlanId || plan.global_plan_id || plan.id;
  if (devotionViewerPlanId !== planId) { devotionViewerPlanId = planId; devotionViewerDayIndex = null; }
  return db.getDevotionalPlan(planId).then(res => {
    if (!res.success) {
      host.innerHTML = `<div class="devotion-view"><p class="devotion-view__loading">${escapeHTML(res.message || "無法載入每日靈修。")}</p></div>`;
      return;
    }
    const d = res.data || {};
    const days = (Array.isArray(d.days) ? d.days : []).slice().sort((a, b) => a.dayIndex - b.dayIndex);
    if (!days.length) {
      host.innerHTML = '<div class="devotion-view"><p class="devotion-view__loading">內容準備中，敬請期待。</p></div>';
      return;
    }
    const total = days[days.length - 1].dayIndex;
    // 預設落在「今天對應的那天」，夾在有內容的範圍
    if (devotionViewerDayIndex == null) {
      const todayRow = days.find(x => x.displayDate === d.today);
      if (todayRow) devotionViewerDayIndex = todayRow.dayIndex;
      else {
        const past = days.filter(x => x.displayDate <= d.today);
        devotionViewerDayIndex = past.length ? past[past.length - 1].dayIndex : days[0].dayIndex;
      }
    }
    const clampToAvailable = (idx) => {
      const exact = days.find(x => x.dayIndex === idx);
      if (exact) return exact;
      const le = days.filter(x => x.dayIndex <= idx);
      return le.length ? le[le.length - 1] : days[0];
    };
    let cur = clampToAvailable(devotionViewerDayIndex);
    devotionViewerDayIndex = cur.dayIndex;

    const paint = () => {
      cur = days.find(x => x.dayIndex === devotionViewerDayIndex) || cur;
      const locked = cur.locked === true;
      const idxPos = days.findIndex(x => x.dayIndex === cur.dayIndex);
      const prev = idxPos > 0 ? days[idxPos - 1] : null;
      const next = idxPos < days.length - 1 ? days[idxPos + 1] : null;
      const refs = Array.isArray(cur.passageRefs) ? cur.passageRefs : [];
      const firstRef = refs[0] || null;
      const reflections = Array.isArray(cur.reflections) ? cur.reflections : [];
      const lsBase = `devotion_thought_${planId}_${cur.dayIndex}_`;
      const isChecked = (i) => { try { return localStorage.getItem(lsBase + i) === "1"; } catch (_) { return false; } };

      host.innerHTML = `
        <div class="devotion-view">
          <div class="devotion-view__nav">
            <button type="button" class="pill-btn" data-devo-prev ${prev ? "" : "disabled"}>◀ 前一天</button>
            <div class="devotion-view__daylabel">
              <strong>第 ${cur.dayIndex} 天</strong> / 共 ${total} 天
              <span class="devotion-view__date">${escapeHTML(cur.displayDate || "")}</span>
            </div>
            <button type="button" class="pill-btn" data-devo-next ${next ? "" : "disabled"}>後一天 ▶</button>
          </div>
          ${locked ? `
            <div class="devotion-view__locked">
              <span class="nlc-icon nlc-icon--md" data-icon="lock" aria-hidden="true"></span>
              <p>這一天 ${escapeHTML(cur.displayDate || "")} 開放</p>
            </div>` : `
            <section class="devotion-view__block">
              <h4 class="devotion-view__h">經文進度</h4>
              <p class="devotion-view__passage">${escapeHTML(cur.passageLabel || "（未設定）")}</p>
              ${firstRef && firstRef.book ? `<button type="button" class="secondary-btn" data-devo-read>打開閱讀器</button>` : ""}
            </section>
            <section class="devotion-view__block">
              <h4 class="devotion-view__h">思想經文</h4>
              ${reflections.length ? `<ul class="devotion-view__reflections">${reflections.map((t, i) => `
                <li>
                  <label>
                    <input type="checkbox" data-devo-think="${i}" ${isChecked(i) ? "checked" : ""}>
                    <span>${escapeHTML(t)}</span>
                  </label>
                </li>`).join("")}</ul>` : `<p class="devotion-view__muted">（本日無思想題）</p>`}
            </section>
            ${cur.videoUrl ? `
            <section class="devotion-view__block">
              <h4 class="devotion-view__h">靈修影片</h4>
              <a class="secondary-btn" href="${escapeHTML(cur.videoUrl)}" target="_blank" rel="noopener noreferrer">
                ${escapeHTML(cur.videoTitle || "觀看影片")} ↗
              </a>
            </section>` : ""}
            ${typeof window.openVerseNotesForPlanDay === "function" ? `
            <section class="devotion-view__block">
              <button type="button" class="pill-btn" data-devo-notes>我的靈修筆記</button>
            </section>` : ""}
          `}
        </div>`;

      if (typeof hydrateIcons === "function") hydrateIcons(host);
      host.querySelector("[data-devo-prev]")?.addEventListener("click", () => { if (prev) { devotionViewerDayIndex = prev.dayIndex; paint(); } });
      host.querySelector("[data-devo-next]")?.addEventListener("click", () => { if (next) { devotionViewerDayIndex = next.dayIndex; paint(); } });
      host.querySelector("[data-devo-read]")?.addEventListener("click", () => {
        if (firstRef && firstRef.book && typeof readChapterDirect === "function") {
          readChapterDirect(firstRef.book, Number(firstRef.chapterFrom) || 1);
        }
      });
      host.querySelectorAll("[data-devo-think]").forEach(cb => {
        cb.addEventListener("change", () => {
          try { localStorage.setItem(lsBase + cb.dataset.devoThink, cb.checked ? "1" : "0"); } catch (_) {}
        });
      });
      host.querySelector("[data-devo-notes]")?.addEventListener("click", () => {
        if (typeof window.openVerseNotesForPlanDay === "function") {
          window.openVerseNotesForPlanDay(planId, cur.dayIndex, cur.passageLabel);
        }
      });
    };
    paint();
  });
}
window.renderDevotionViewer = renderDevotionViewer;

function planGoBack() {
  if (getCurrentPlanRoute() !== PLAN_ROUTE.LIST) setPlanState(PLAN_ROUTE.LIST);
}


// ES Module exports
export function init() {
  if (typeof initPlanControls === 'function') {
    initPlanControls();
  }
}

// Global attachments for compatibility
window.initPlanControls = init;
if (typeof renderPlanView === 'function') {
  window.renderPlanView = renderPlanView;
}
export { renderPlanView, showDiscoverPlans };
if (typeof updateStatsView === 'function') {
  window.updateStatsView = updateStatsView;
}
if (typeof renderPlanScheduleTracker === 'function') {
  window.renderPlanScheduleTracker = renderPlanScheduleTracker;
  window.handleRoundCompletion = handleRoundCompletion;
}
if (typeof renderHorizontalDateStrip === 'function') {
  window.renderHorizontalDateStrip = renderHorizontalDateStrip;
}

if (typeof renderPlanRankingView === 'function') {
  window.renderPlanRankingView = renderPlanRankingView;
}
if (typeof renderPlanMembersView === 'function') {
  window.renderPlanMembersView = renderPlanMembersView;
}
if (typeof populateMembersSelector === 'function') {
  window.populateMembersSelector = populateMembersSelector;
}
if (typeof setupCascadingSelectors === 'function') {
  window.setupCascadingSelectors = setupCascadingSelectors;
}
if (typeof renderPlanStatsView === 'function') {
  window.renderPlanStatsView = renderPlanStatsView;
}
if (typeof showPlanStatsModal === 'function') {
  window.showPlanStatsModal = showPlanStatsModal;
}
if (typeof switchStatTab === 'function') {
  window.switchStatTab = switchStatTab;
}
if (typeof updateStatsScopeSelect === 'function') {
  window.updateStatsScopeSelect = updateStatsScopeSelect;
}
if (typeof snapCalendarToMyProgress === 'function') {
  window.snapCalendarToMyProgress = snapCalendarToMyProgress;
}
if (typeof snapCalendarToToday === 'function') {
  window.snapCalendarToToday = snapCalendarToToday;
}

function planToggleGroupProgress() {
  if (typeof window.syncActivePlanContext === "function") window.syncActivePlanContext();
  if (!state.activePlan || !window.PlanPageController) return;
  const nextIndex = window.PlanPageController.currentIndex === PLAN_PAGE.GROUP ? PLAN_PAGE.READING : PLAN_PAGE.GROUP;
  window.PlanPageController.switchPage(nextIndex);
}

window.fetchGroupRankings = fetchGroupRankings;
window.setPlanState = setPlanState;
window.showDiscoverPlans = showDiscoverPlans;
window.planGoBack = planGoBack;
window.planToggleGroupProgress = planToggleGroupProgress;
window.togglePlanDetailSubTab = planToggleGroupProgress;



// ==================== 關心戳一下 Dialog ====================
window.openCareReminderDialog = async function(member) {
  // Remove any existing dialog
  const existingDialog = document.getElementById("care-reminder-dialog-overlay");
  if (existingDialog) existingDialog.remove();

  // 打開對話框時先看看今天是不是已經傳過一則給這個人——有的話直接把內容
  // 帶進來顯示 + 開放編輯，而不是讓人送出後就再也看不到自己寫了什麼，
  // 也不會因為「今天已經傳過」而卡死。
  const planKeyForCare = state.activePlan ? (state.activePlan.presetKey || state.activePlan.globalPlanId || "") : "";
  let existingReminder = null;
  if (!member.readingTeamId && typeof db !== "undefined" && typeof db.getTodayCareReminderFor === "function") {
    try {
      const existingRes = await db.getTodayCareReminderFor(member.id, planKeyForCare);
      existingReminder = existingRes && existingRes.data ? existingRes.data : null;
    } catch (_) {
      existingReminder = null;
    }
  }
  // A dialog may have been opened again for someone else while this lookup
  // was in flight — bail out rather than showing stale data on top of it.
  if (document.getElementById("care-reminder-dialog-overlay")) return;

  const reasonLabels = {
    behind: "📉 進度落後",
    inactive: "😴 很久沒打卡",
    care: "💛 一般關心",
    encouragement: "🌟 特別鼓勵"
  };

  // Auto-pick a default reason based on member status
  const autoReason = member.isBehind ? "behind" : member.isNotStarted ? "inactive" : "care";

  const defaultMessages = {
    behind: `Hi ${member.name}！這週的讀經進度稍微落後囉，有任何困難都可以跟我說喔，加油！`,
    inactive: `${member.name} 你好，最近都沒看到你打卡讀經，希望一切都好，我們在等你哦！`,
    care: `${member.name} 你好，只是想關心一下你最近的讀經狀況，如果有任何需要都可以找我！`,
    encouragement: `${member.name}！你最近讀經很穩定，真的很棒！繼續加油哦，感謝主！`
  };

  // 今天已經傳過 → 帶入已發送的內容，讓對話框一打開就看得到自己寫了什麼；
  // 對方已讀/已關閉 → 鎖定不能再改，但內容還是看得到。
  const defaultReason = existingReminder ? existingReminder.reason : autoReason;
  const initialMessage = existingReminder ? existingReminder.message : defaultMessages[defaultReason];
  const isLocked = !!(existingReminder && existingReminder.status !== "unread");

  const overlay = document.createElement("div");
  overlay.id = "care-reminder-dialog-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    padding: 1rem;
    animation: fadeIn 0.2s ease;
  `;

  overlay.innerHTML = `
    <div id="care-reminder-dialog" style="
      background: var(--bg-card, white);
      border-radius: 16px;
      padding: 1.5rem;
      width: 100%; max-width: 440px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.25);
      animation: slideUp 0.25s cubic-bezier(0.34,1.56,0.64,1);
    ">
      <div style="display:flex; align-items:center; gap:0.6rem; margin-bottom:1rem;">
        <span class="nlc-icon nlc-icon--md" data-icon="remind" style="color:var(--color-warning-text, rgb(217,119,6));" aria-hidden="true"></span>
        <h3 style="margin:0; font-size:1rem; font-weight:700; color:var(--text-primary);">關心提醒 ・ ${escapeHTML(member.name)}</h3>
      </div>

      <p style="margin:0 0 1rem; font-size:0.875rem; color:var(--text-muted);">
        進度：<strong style="color:${member.statusColor}">${member.statusStr}</strong>
        &nbsp;・&nbsp;完成：${member.completed} 天
      </p>

      ${existingReminder ? `<p id="care-existing-note" style="margin:0 0 1rem; font-size:0.875rem; color:var(--color-brand); background:var(--color-brand-subtle); border-radius:8px; padding:0.5rem 0.75rem;">
        今天已經傳過一則給${escapeHTML(member.name)}${isLocked ? '，對方已經看過，內容鎖定無法修改' : '，以下是當時的內容，可以直接修改後更新'}
      </p>` : ""}

      <label style="display:block; font-size:0.875rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.4rem;">
        關心原因
      </label>
      <div id="care-reason-btns" style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem;">
        ${Object.entries(reasonLabels).map(([key, label]) => `
          <button type="button"
            data-reason="${key}"
            ${isLocked ? "disabled" : ""}
            class="care-reason-btn${key === defaultReason ? ' active' : ''}"
            style="
              padding: 0.35rem 0.75rem; border-radius: 20px; font-size: 0.875rem; font-weight:500;
              border: 1.5px solid ${key === defaultReason ? 'var(--color-warning-text, rgb(217,119,6))' : 'var(--border-card)'};
              background: ${key === defaultReason ? 'var(--color-warning-muted,rgba(251,191,36,0.15))' : 'var(--bg-input)'};
              color: ${key === defaultReason ? 'var(--color-warning-text, rgb(217,119,6))' : 'var(--text-secondary)'};
              cursor: ${isLocked ? "not-allowed" : "pointer"}; opacity: ${isLocked ? "0.6" : "1"}; transition: all 0.15s;
            ">
            ${label}
          </button>
        `).join("")}
      </div>

      <label for="care-msg-input" style="display:block; font-size:0.875rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.4rem;">
        訊息內容
      </label>
      <textarea id="care-msg-input"
        rows="4"
        maxlength="300"
        placeholder="輸入關心訊息..."
        ${isLocked ? "readonly" : ""}
        style="
          width:100%; box-sizing:border-box;
          padding: 0.65rem 0.75rem;
          border-radius: 10px;
          border: 1.5px solid var(--border-card);
          background: var(--bg-input);
          color: var(--text-primary);
          resize: vertical;
          font-family: inherit;
          outline: none;
          transition: border-color 0.15s;
          margin-bottom: 0.25rem;
          ${isLocked ? "opacity: 0.7; cursor: not-allowed;" : ""}
        "
      >${escapeHTML(initialMessage)}</textarea>
      <div id="care-char-count" style="text-align:right; font-size:0.875rem; color:var(--text-muted); margin-bottom:1rem;">
        ${initialMessage.length} / 300
      </div>

      <div id="care-dialog-error" style="display:none; color:var(--color-danger); font-size:0.875rem; margin-bottom:0.75rem; padding:0.5rem 0.75rem; background:var(--color-danger-muted,rgba(239,68,68,0.1)); border-radius:8px;"></div>

      <div style="display:flex; gap:0.75rem; justify-content:flex-end;">
        <button id="care-cancel-btn" type="button" style="
          padding:0.55rem 1.2rem; border-radius:10px; font-size:0.88rem; font-weight:600;
          border:1.5px solid var(--border-card); background:var(--bg-input);
          color:var(--text-secondary); cursor:pointer;
        ">${isLocked ? "關閉" : "取消"}</button>
        ${isLocked ? "" : `<button id="care-send-btn" type="button" style="
          padding:0.55rem 1.4rem; border-radius:10px; font-size:0.88rem; font-weight:600;
          border:none; background:var(--color-warning-text, rgb(217,119,6));
          color:white; cursor:pointer; display:flex; align-items:center; gap:0.4rem;
          transition: opacity 0.15s;
        ">
          <span class="nlc-icon nlc-icon--sm" data-icon="send" aria-hidden="true"></span>
          <span id="care-send-btn-label">${existingReminder ? "更新關心內容" : "傳送關心"}</span>
        </button>`}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  if (typeof hydrateIcons === "function") hydrateIcons(overlay);

  // Wire up reason buttons
  let selectedReason = defaultReason;
  const reasonBtns = overlay.querySelectorAll(".care-reason-btn");
  const msgInput = overlay.querySelector("#care-msg-input");
  const charCount = overlay.querySelector("#care-char-count");

  reasonBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      selectedReason = btn.dataset.reason;
      reasonBtns.forEach(b => {
        const isActive = b.dataset.reason === selectedReason;
        b.style.borderColor = isActive ? "var(--color-warning-text, rgb(217,119,6))" : "var(--border-card)";
        b.style.background = isActive ? "var(--color-warning-muted,rgba(251,191,36,0.15))" : "var(--bg-input)";
        b.style.color = isActive ? "var(--color-warning-text, rgb(217,119,6))" : "var(--text-secondary)";
      });
      msgInput.value = defaultMessages[selectedReason];
      charCount.textContent = `${msgInput.value.length} / 300`;
    });
  });

  msgInput.addEventListener("input", () => {
    charCount.textContent = `${msgInput.value.length} / 300`;
  });

  // Close on overlay click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector("#care-cancel-btn").addEventListener("click", () => overlay.remove());

  // Send / update — tracked locally so a second click in the same dialog
  // session (after a first successful send) is labeled/announced as an
  // edit instead of a brand new send.
  let alreadySentToday = !!existingReminder;
  const sendBtn = overlay.querySelector("#care-send-btn");
  if (sendBtn) sendBtn.addEventListener("click", async () => {
    const message = msgInput.value.trim();
    const errorEl = overlay.querySelector("#care-dialog-error");

    errorEl.style.display = "none";

    if (!message) {
      errorEl.textContent = "請輸入關心訊息！";
      errorEl.style.display = "block";
      return;
    }
    if (message.length > 300) {
      errorEl.textContent = "訊息不能超過 300 字！";
      errorEl.style.display = "block";
      return;
    }

    const wasEdit = alreadySentToday;
    const idleLabel = wasEdit ? "更新關心內容" : "傳送關心";
    sendBtn.disabled = true;
    sendBtn.style.opacity = "0.6";
    sendBtn.innerHTML = `<span class="nlc-icon nlc-icon--sm" data-icon="loader" aria-hidden="true"></span> ${wasEdit ? "更新中…" : "傳送中…"}`;
    if (typeof hydrateIcons === "function") hydrateIcons(sendBtn);

    try {
      const result = member.readingTeamId
        ? await db.sendReadingTeamReminder({
            teamId: member.readingTeamId,
            recipientId: member.id,
            globalPlanId: member.readingTeamPlanId,
            reason: selectedReason,
            message: message
          })
        : await db.sendCareReminder({
            recipientId: member.id,
            reason: selectedReason,
            message: message,
            planKey: planKeyForCare
          });

      if (result.error) throw result.error;

      alreadySentToday = true;
      if (typeof showToast === "function") {
        showToast(wasEdit ? `已更新給 ${member.name} 的關心內容 💛` : `已傳送關心提醒給 ${member.name} 💛`);
      }
      // Deliberately do NOT close the dialog — the whole point is that the
      // text just sent stays visible right here, still editable, instead of
      // disappearing the moment it's sent.
      sendBtn.disabled = false;
      sendBtn.style.opacity = "1";
      sendBtn.innerHTML = `<span class="nlc-icon nlc-icon--sm" data-icon="send" aria-hidden="true"></span> <span id="care-send-btn-label">更新關心內容</span>`;
      if (typeof hydrateIcons === "function") hydrateIcons(sendBtn);
    } catch (err) {
      console.error("sendCareReminder failed:", err);
      sendBtn.disabled = false;
      sendBtn.style.opacity = "1";
      sendBtn.innerHTML = `<span class="nlc-icon nlc-icon--sm" data-icon="send" aria-hidden="true"></span> <span id="care-send-btn-label">${idleLabel}</span>`;
      if (typeof hydrateIcons === "function") hydrateIcons(sendBtn);

      errorEl.textContent = `傳送失敗：${err.message || "請稍後再試"}`;
      errorEl.style.display = "block";
    }
  });

  // Focus textarea
  setTimeout(() => { if (msgInput) msgInput.focus(); }, 100);
};
