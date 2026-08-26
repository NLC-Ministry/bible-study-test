// js/app.js

// Import support and core files needed before first paint.
import '../config.js';
import './data/bible_data.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './data/bible_verse_counts.js';
import './copy/zh-Hant.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './data/church_campaign.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './design/design-tokens.js';
import './design/design-system-helpers.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './design/icon-registry.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './design/icons.js';
import './state.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './auth.js?v=20260827_proactive_token_refresh';
import './auth-launch.mjs';
import './db.js?v=20260827_offline_snapshot_persistence';
import './utils.js?v=20260827_round_schedule_start_on_actual_entry';
import './gamification.js?v=20260826_quiz_remove_duplicate_scope_filter';
import { initModalManager } from './modules/modal-manager.mjs';

import {
  BIBLE_HUB_CONTINUE_RETURN_TO,
  consumeBibleHubResume,
  hubContinueHref,
  launchMemberHubContinue
} from './login-onboarding-gate.mjs';
import { cleanupProductionStorage } from './production-cleanup.mjs';
import { initializePwa } from './pwa/PwaCoordinator.js?v=20260826_quiz_remove_duplicate_scope_filter';
import { IndexedDbClient } from './pwa/IndexedDbClient.js';
import { OfflineBibleRepository } from './pwa/OfflineBibleRepository.js';
import { initOfflineBibleControls } from './pwa/OfflineBibleControls.js';
import { SupabaseRepository } from './pwa/SupabaseRepository.js';
import { clearBadge, requestNotificationPermission } from '../lib/services/badge-service.ts';

cleanupProductionStorage(window.localStorage);
initModalManager();

let buildVersion = "__BUILD_VERSION__";
if (!/^\d{14}$/.test(buildVersion)) {
  buildVersion = "dev_" + Date.now();
}
buildVersion += "_clean_demo_mode_v20_quiz_manual_retry_v1_member_hub_name_sync_v1_quiz_load_error_v1_group_filter_reset_fix_v1_quiz_publish_flow_redesign_v1_row_cap_pagination_fix_v1_quiz_entry_reading_gate_v1_quiz_feature_reopen_restore_v1_admin_mobile_layout_v1_reader_audio_resume_fix_v1_joined_plan_collapse_v1_admin_tabs_lead_v1";
const moduleCache = {};
const RELEASE_ONBOARDING_MODULE_PATH = './modules/onboarding-helper.js?v=20260826_quiz_remove_duplicate_scope_filter';
const RELEASE_ONBOARDING_STORAGE_KEY = "bible_onboarding_seen_version";
const ISSUE_REPORT_UI_MODULE_PATH = './modules/issue-report-ui.bundle.js?v=' + buildVersion;
let releaseOnboardingModulePromise = null;
let careReminderBadgeLastRefresh = 0;

function getReleaseOnboardingVersion(config = window.APP_CONFIG || {}) {
  return String(config.onboardingVersion || config.appVersion || "0.1.1");
}

function isReleaseOnboardingLoginEligible(authClient) {
  if (!authClient) return false;
  if (typeof authClient.isLoggedIn === "function") return authClient.isLoggedIn();
  return Boolean(authClient.loggedIn);
}

function shouldAutoShowReleaseOnboarding({ auth: authClient, syncComplete, storage = window.localStorage, config = window.APP_CONFIG || {} } = {}) {
  if (!isReleaseOnboardingLoginEligible(authClient)) return false;
  if (!syncComplete) return false;
  const version = getReleaseOnboardingVersion(config);
  try {
    return storage?.getItem(RELEASE_ONBOARDING_STORAGE_KEY) !== version;
  } catch {
    return window.__bibleOnboardingSeenInSession !== version;
  }
}

async function loadReleaseOnboardingHelper() {
  if (!releaseOnboardingModulePromise) {
    releaseOnboardingModulePromise = import(RELEASE_ONBOARDING_MODULE_PATH).then((mod) => {
      if (window.__bibleDeferredInstallPrompt && typeof mod.captureInstallPrompt === "function") {
        mod.captureInstallPrompt(window.__bibleDeferredInstallPrompt);
      }
      return mod;
    });
  }
  return releaseOnboardingModulePromise;
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  window.__bibleDeferredInstallPrompt = event;
});

window.openOnboardingHelper = async function openLazyOnboardingHelper(options = {}) {
  const mod = await loadReleaseOnboardingHelper();
  return mod.openOnboardingHelper(options);
};

function maybeShowReleaseOnboarding(options = {}) {
  if (!shouldAutoShowReleaseOnboarding(options)) return false;
  window.setTimeout(() => {
    window.openOnboardingHelper?.(options);
  }, 250);
  return true;
}

function updateCareReminderBadge(reminders = []) {
  const unreadReminderKeys = new Set();
  if (Array.isArray(reminders)) {
    reminders.forEach((reminder, index) => {
      if (!reminder || reminder.status === "read") return;
      const reminderId = String(reminder.id || "").trim();
      unreadReminderKeys.add(reminderId ? `id:${reminderId}` : `row:${index}`);
    });
  }
  const count = unreadReminderKeys.size;
  const badgeText = count > 9 ? "9+" : String(count);

  const bellBadge = document.getElementById("notification-bell-badge");
  if (bellBadge) {
    bellBadge.hidden = count === 0;
    bellBadge.textContent = count === 0 ? "" : badgeText;
  }
  const bellButton = document.getElementById("btn-notification-bell");
  if (bellButton) {
    bellButton.setAttribute(
      "aria-label",
      count > 0 ? `通知，${count} 則未讀` : "通知"
    );
  }

}

async function refreshCareReminderBadge(options = {}) {
  if (typeof db === "undefined" || typeof db.fetchCareReminders !== "function") return;
  if (!state.currentUser || !state.currentUser.id) {
    updateCareReminderBadge([]);
    return;
  }

  const now = Date.now();
  if (!options.force && now - careReminderBadgeLastRefresh < 30000) return;
  careReminderBadgeLastRefresh = now;

  try {
    const [careResult, quizResult] = await Promise.all([
      db.fetchCareReminders(),
      typeof db.fetchQuizNotifications === "function"
        ? db.fetchQuizNotifications()
        : Promise.resolve({ data: [], error: null })
    ]);
    if (!careResult.error || !quizResult.error) {
      updateCareReminderBadge([...(careResult.data || []), ...(quizResult.data || [])]);
    }
  } catch (error) {
    console.warn("Care reminder badge refresh failed:", error);
  }
}

window.updateCareReminderBadge = updateCareReminderBadge;
window.refreshCareReminderBadge = refreshCareReminderBadge;

function safeEscapeHTML(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function renderNotificationsList() {
  const container = document.getElementById("notification-list-container");
  if (!container) return;

  container.innerHTML = `<div style="text-align:center; padding:1.5rem; color:var(--text-muted); font-size:0.875rem;"><span class="nlc-icon nlc-icon--sm" data-icon="loading" aria-hidden="true"></span> 載入中...</div>`;
  if (typeof hydrateIcons === "function") hydrateIcons(container);

  const [careResult, quizResult] = await Promise.all([
    db.fetchAllNotifications(),
    typeof db.fetchQuizNotifications === "function"
      ? db.fetchQuizNotifications()
      : Promise.resolve({ data: [], error: null })
  ]);
  const notifications = [...(careResult.data || []), ...(quizResult.data || [])]
    .sort((left, right) => String(right.createdAt || right.created_at || right.sent_on || "")
      .localeCompare(String(left.createdAt || left.created_at || left.sent_on || "")))
    .slice(0, 20);
  const error = careResult.error && quizResult.error ? careResult.error : null;

  if (error || !notifications || notifications.length === 0) {
    container.innerHTML = `<div class="notification-popover__empty">目前沒有通知</div>`;
    return;
  }

  container.innerHTML = "";

  const roleNames = {
    member: "組員",
    group_leader: "小組長",
    zone_leader: "區長",
    great_zone_leader: "大區長",
    pastor: "牧者",
    admin: "系統管理員"
  };

  notifications.forEach(item => {
    const div = document.createElement("div");
    div.className = `notification-item ${item.status === 'unread' ? 'notification-item--unread' : ''}`;

    const sender = item.sender || {};
    const senderName = String(sender.name || "").trim() || "—";
    const senderRoleRaw = getUserRoleCode(sender);
    const isQuizNotification = item.type === "quiz";
    const isTeamReminder = String(item.plan_key || "").startsWith("reading-team:");
    const senderRole = isTeamReminder
      ? "隊友"
      : (getRoleDefinition(senderRoleRaw)?.label || roleNames[senderRoleRaw] || "領袖");

    const displaySenderRole = isQuizNotification ? "小測驗發佈者" : senderRole;
    const dateStr = item.sent_on || "";

    div.innerHTML = `
      <div class="notification-item__header">
        <span class="notification-item__sender">來自${displaySenderRole} ${safeEscapeHTML(senderName)}</span>
        <span class="notification-item__time">${safeEscapeHTML(dateStr)}</span>
      </div>
      <p class="notification-item__body">${safeEscapeHTML(item.message || "加油！一起穩定讀經。")}</p>
    `;

    div.onclick = async (e) => {
      e.stopPropagation();
      if (item.status === 'unread') {
        div.classList.remove("notification-item--unread");
        if (isQuizNotification && typeof db.acknowledgeQuizNotification === "function") {
          await db.acknowledgeQuizNotification(item.id);
        } else {
          await db.acknowledgeCareReminder(item.id);
        }
        await refreshCareReminderBadge({ force: true });
      }
      if (isQuizNotification) {
        const planKey = String(item.globalPlanId || "");
        const quizPlan = [...(state.activePlans || []), ...(state.globalPlans || [])]
          .find(plan => [plan.globalPlanId, plan.id].filter(Boolean).map(String).includes(planKey));
        if (quizPlan) {
          state.activePlan = quizPlan;
          state.planDetailOpen = true;
          state.planActiveSubTab = "today";
          window.currentPlanViewState = "DETAIL";
          const day = Array.isArray(quizPlan.days)
            ? quizPlan.days.find(entry => String(entry.isoDate || "") === String(item.quizDate || ""))
            : null;
          if (day) state.selectedPlanDay = day.dayNum;
          document.getElementById("notification-popover")?.classList.add("hidden");
          await appRouter.switchTab("plan-view", { keepPlanDetail: true });
        }
      }
    };

    container.appendChild(div);
  });

  if (typeof hydrateIcons === "function") {
    hydrateIcons(container);
  }
}

function initNotificationSystem() {
  const bellBtn = document.getElementById("btn-notification-bell");
  const popover = document.getElementById("notification-popover");
  const readAllBtn = document.getElementById("btn-notification-read-all");

  if (!bellBtn || !popover) return;

  function openPopover() {
    popover.classList.remove("hidden");
    bellBtn.setAttribute("aria-expanded", "true");
    const firstFocusable = popover.querySelector("button, [tabindex]");
    if (firstFocusable) firstFocusable.focus();
  }

  function closePopover() {
    popover.classList.add("hidden");
    bellBtn.setAttribute("aria-expanded", "false");
    bellBtn.focus();
  }

  bellBtn.onclick = async (e) => {
    e.stopPropagation();
    const isHidden = popover.classList.contains("hidden");

    document.querySelectorAll(".options-dropdown").forEach(el => el.classList.add("hidden"));

    if (isHidden) {
      openPopover();
      await renderNotificationsList();
    } else {
      closePopover();
    }
  };

  if (readAllBtn) {
    readAllBtn.onclick = async (e) => {
      e.stopPropagation();
      readAllBtn.disabled = true;
      const [careAck, quizAck] = await Promise.all([
        db.acknowledgeAllCareReminders(),
        typeof db.acknowledgeQuizNotification === "function"
          ? db.acknowledgeQuizNotification(null)
          : Promise.resolve({ error: null })
      ]);
      const error = careAck.error || quizAck.error;
      readAllBtn.disabled = false;
      if (!error) {
        updateCareReminderBadge([]);
        await renderNotificationsList();
      } else {
        alert("全部已讀失敗: " + (error.message || error));
      }
    };
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popover.classList.contains("hidden")) {
      closePopover();
    }
  });

  document.addEventListener("click", (e) => {
    if (!popover.classList.contains("hidden") && !popover.contains(e.target) && e.target !== bellBtn) {
      closePopover();
    }
  });
}

async function loadModule(name, path) {
  if (moduleCache[name]) {
    return moduleCache[name];
  }
  console.log(`📡 [ESM] Lazy-loading module: ${name} from ${path}`);
  try {
    const mod = await import(path);
    moduleCache[name] = mod;
    if (typeof mod.init === 'function') {
      mod.init();
    }
    return mod;
  } catch (err) {
    console.error(`Failed to load module ${name}:`, err);
    throw err;
  }
}

async function loadIssueReportUi(options = {}) {
  const mod = await loadModule('issue-report-ui', ISSUE_REPORT_UI_MODULE_PATH);
  if (mod && typeof mod.mountIssueReportUi === "function") {
    mod.mountIssueReportUi(options);
  }
  return mod;
}

function scheduleIssueReportUiLoad(options = {}) {
  let loadStarted = false;
  const load = () => {
    if (loadStarted) return;
    loadStarted = true;
    loadIssueReportUi(options).catch(err => {
      console.warn("[IssueReport] Lazy UI load failed; continuing without report UI.", err);
    });
  };

  window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(load, { timeout: 5000 });
    } else {
      window.setTimeout(load, 2000);
    }
  }, 3000);
}

async function ensurePlanFeatureModulesLoaded() {
  await loadModule('team-registration', './modules/team-registration.js?v=' + buildVersion);
  if (state.currentUser && getUserRoleCode(state.currentUser) === 'admin') {
    await loadModule('campaign-rule-editor', './modules/campaign-rule-editor.js?v=' + buildVersion);
  }
}

async function ensureAdminFeatureModulesLoaded() {
  await loadModule('campaign-rule-editor', './modules/campaign-rule-editor.js?v=' + buildVersion);
}

// Focus-triggered refreshes fire on every app re-foreground (switching apps,
// unlocking the screen, dismissing the keyboard) — throttle so a quick
// switch-away-and-back doesn't refetch everything and re-render the tab again.
const REFRESH_CURRENT_APP_VIEW_MIN_INTERVAL_MS = 60000;
let lastRefreshCurrentAppViewAt = 0;

async function refreshCurrentAppView() {
  const now = Date.now();
  if (now - lastRefreshCurrentAppViewAt < REFRESH_CURRENT_APP_VIEW_MIN_INTERVAL_MS) return;
  lastRefreshCurrentAppViewAt = now;

  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      await registration?.update();
    } catch (error) {
      console.warn("Unable to check for an app shell update", error);
    }
  }
  window._cachedAllUsersList = null;
  window._cachedAllUsersListKey = null;

  const currentTab = appRouter.currentTab || "dashboard-view";

  if (typeof db !== "undefined") {
    if (typeof db.loadOrgStructure === "function") {
      await db.loadOrgStructure();
    }
    // Plan tab only: force a fresh member-context resync before re-reading
    // the profile row. Without this, a stale member_context_synced_at from a
    // background sync job can outlast the 15-minute gate window and silently
    // bounce the user out of the plan tab into the Member Hub gate on every
    // refocus. Retrying quietly here first gives the backend a chance to
    // catch up; if it's still genuinely unavailable, the gate still shows.
    if (currentTab === "plan-view" && typeof db.syncNlcSessionWithSupabase === "function") {
      const forceMemberContextResync = true;
      try {
        await db.syncNlcSessionWithSupabase(forceMemberContextResync);
      } catch (error) {
        console.warn("[refreshCurrentAppView] Background member context resync failed", error);
      }
    }
    if (typeof db.loadUserData === "function") {
      await db.loadUserData(true);
    }
  }

  if (typeof window.syncActivePlanContext === "function") {
    window.syncActivePlanContext();
  }
  if (typeof updateAdminNavVisibility === "function") {
    updateAdminNavVisibility();
  }

  // Scripture text never changes once loaded — re-running switchTab here would
  // tear down and rebuild the verse list (renderReaderText resets scrollTop to 0)
  // for no reason. Skip it so refocusing the app doesn't yank the reader back
  // to the top or interrupt an in-progress long-press selection.
  if (currentTab !== "reader-view") {
    await appRouter.switchTab(currentTab, {
      keepPlanDetail: true,
      restoreTabScroll: false
    });
  }
  await refreshCareReminderBadge({ force: true });
}

// ─── Plan entry eligibility gate: fail-closed Hub states only ───
// Login card already owns 姓名 / 會籍 speech. Plan-view uses the same
// user-completion predicate and only explains fail-closed reasons.
// Every remediation path points to the church Member Hub.
let planEligibilityHubReturnBound = false;
let planEligibilityAutoRetryPending = false;

// member_context_unavailable almost always means the background Member Hub
// sync job just hasn't caught up yet, not that the user's data is actually
// incomplete — retry once quietly so people aren't stuck reading "go set up
// your identity" for information that's already correct.
function retryPlanEligibilityQuietly() {
  if (planEligibilityAutoRetryPending) return;
  if (typeof db === "undefined" || typeof db.syncNlcSessionWithSupabase !== "function") return;
  planEligibilityAutoRetryPending = true;
  const hubLink = document.getElementById("plan-eligibility-gate-hub-link");
  const isRetryButton = hubLink && hubLink.dataset.gateMode === "retry";
  if (isRetryButton) {
    hubLink.setAttribute("aria-busy", "true");
    hubLink.textContent = "重新確認中…";
  }
  db.syncNlcSessionWithSupabase(true)
    .then(() => {
      if (window.appRouter && window.appRouter.currentTab === "plan-view") {
        window.appRouter.switchTab("plan-view", { keepPlanDetail: true });
      }
    })
    .catch(err => console.warn("[PlanEligibilityGate] Retry sync failed:", err))
    .finally(() => {
      planEligibilityAutoRetryPending = false;
      if (isRetryButton && hubLink.dataset.gateMode === "retry") {
        hubLink.removeAttribute("aria-busy");
        hubLink.textContent = "重新嘗試同步";
      }
    });
}

function getPlanEligibilityGateCopy(block) {
  if (block.reason === "member_context_unavailable") {
    return {
      title: "登入已完成，正在重新確認會員資料",
      desc: "會員中心目前暫時無法同步會籍與小組歸屬，系統已在背景自動重試。若這裡卡住沒有自動消失，可以按下方按鈕手動重試一次；不需要前往會員中心，也不需要重新註冊帳號。支援代碼：MEMBER_CONTEXT_UNAVAILABLE",
      button: "重新嘗試同步",
      mode: "retry"
    };
  }
  if (block.reason === "inactive_membership") {
    return {
      title: "目前無法使用會員讀經計畫",
      desc: "您的會籍目前不是可使用狀態。請前往會員中心查看狀態，或聯繫教會同工協助。",
      button: "前往會員中心",
      mode: "hub"
    };
  }
  if (block.reason === "unknown_member_hub_action" || block.reason === "unknown_member_hub_state") {
    return {
      title: "需要在會員中心完成新的確認步驟",
      desc: "此版本尚未識別會員中心回傳的新狀態。為保護您的會籍資料，請使用下方按鈕由會員中心安全地繼續。",
      button: "前往會員中心",
      mode: "hub"
    };
  }
  if (block.reason === "membership_record_inconsistent") {
    return {
      title: "需要在會員中心確認會員資料",
      desc: "會員中心回傳的會籍紀錄需要確認。請使用下方按鈕前往會員中心繼續。",
      button: "前往會員中心",
      mode: "hub"
    };
  }
  return {
    title: "需要在會員中心繼續",
    desc: "請由會員中心安全地繼續。不要重複註冊帳號。",
    button: "前往會員中心",
    mode: "hub"
  };
}

function resetPlanNavigationForEligibilityGate() {
  window.currentPlanViewState = "LIST";
  state.planDetailOpen = false;
  state.planActiveSubTab = "today";
  if (state.inlineReader) state.inlineReader.active = false;
  if (state.readerState) {
    state.readerState.fromPlan = false;
    state.readerState.returnTab = null;
  }
}

function resyncPlanEligibilityAfterHubReturn() {
  const gate = document.getElementById("plan-eligibility-gate");
  const gated = gate && !gate.classList.contains("hidden");
  const onPlan = window.appRouter && window.appRouter.currentTab === "plan-view";
  if (!gated && !onPlan) return;
  retryPlanEligibilityQuietly();
}

function bindPlanEligibilityHubReturnSync() {
  if (planEligibilityHubReturnBound || typeof document === "undefined") return;
  planEligibilityHubReturnBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    resyncPlanEligibilityAfterHubReturn();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resyncPlanEligibilityAfterHubReturn();
  });
  const hubLink = document.getElementById("plan-eligibility-gate-hub-link");
  if (hubLink && !hubLink.dataset.hubContinueBound) {
    hubLink.dataset.hubContinueBound = "1";
    hubLink.addEventListener("click", (event) => {
      event.preventDefault();
      // member_context_unavailable is a "please wait" state, not a "go fix
      // something" state — the button retries in place instead of sending
      // people who already did everything right off to the Member Hub.
      if (hubLink.dataset.gateMode === "retry") {
        retryPlanEligibilityQuietly();
        return;
      }
      launchMemberHubContinue(typeof auth !== "undefined" ? auth : null);
    });
  }
}

function renderPlanEligibilityGate(block) {
  const planView = document.getElementById("plan-view");
  const gate = document.getElementById("plan-eligibility-gate");
  if (!planView || !gate) return;
  planView.classList.add("plan-view--gated");
  gate.classList.remove("hidden");

  const copy = getPlanEligibilityGateCopy(block);
  const titleEl = document.getElementById("plan-eligibility-gate-title");
  const descEl = document.getElementById("plan-eligibility-gate-desc");
  const hubLink = document.getElementById("plan-eligibility-gate-hub-link");

  if (titleEl) titleEl.textContent = copy.title;
  if (descEl) descEl.textContent = copy.desc;
  if (hubLink) {
    hubLink.dataset.gateMode = copy.mode;
    hubLink.textContent = copy.button;
    hubLink.removeAttribute("aria-busy");
    const fallback = hubContinueHref(typeof auth !== "undefined" ? auth : null);
    try {
      const fallbackUrl = new URL(fallback);
      const upstreamUrl = block.requiredActionUrl ? new URL(block.requiredActionUrl) : null;
      const resolverUrl = upstreamUrl
        && upstreamUrl.origin === fallbackUrl.origin
        && upstreamUrl.pathname === "/member/continue"
        ? upstreamUrl
        : fallbackUrl;
      resolverUrl.searchParams.set("satellite", "bible-app");
      resolverUrl.searchParams.set("returnTo", BIBLE_HUB_CONTINUE_RETURN_TO);
      hubLink.href = resolverUrl.toString();
    } catch {
      hubLink.href = fallback;
    }
  }

  if (typeof hydrateIcons === "function") hydrateIcons(gate);
  bindPlanEligibilityHubReturnSync();

  if (block.reason === "member_context_unavailable") {
    retryPlanEligibilityQuietly();
  }
}

function guardPlanEligibility() {
  const block = typeof getPlanEligibilityBlock === "function"
    ? getPlanEligibilityBlock(state.currentUser)
    : null;
  if (!block) return false;

  resetPlanNavigationForEligibilityGate();
  if (appRouter.currentTab === "plan-view") {
    renderPlanEligibilityGate(block);
    appRouter.updateNavigationChrome();
  } else {
    void appRouter.switchTab("plan-view");
  }
  return true;
}

function hidePlanEligibilityGate() {
  const planView = document.getElementById("plan-view");
  const gate = document.getElementById("plan-eligibility-gate");
  if (planView) planView.classList.remove("plan-view--gated");
  if (gate) gate.classList.add("hidden");
}

window.renderPlanEligibilityGate = renderPlanEligibilityGate;
window.hidePlanEligibilityGate = hidePlanEligibilityGate;
window.guardPlanEligibility = guardPlanEligibility;

// Paints the visible reader chrome straight from already-loaded global state, so the
// reference is correct the instant #reader-view fades in. It must not wait on the
// lazy-loaded bible.js module, or a stale placeholder flashes before the real chapter.
function paintReaderChromeFromState() {
  const books = window.BIBLE_BOOKS;
  if (!Array.isArray(books) || !state.readerState) return;
  const book = books.find(b => Number(b.id) === Number(state.readerState.bookId));
  if (!book) return;

  const refLabel = document.getElementById("reader-nav-ref-label");
  const isEnglishVersion = ["ESV", "NIV", "NLT", "WEB"].includes(String(state.readerState.version || "").toUpperCase());
  if (refLabel) refLabel.textContent = `${isEnglishVersion ? book.eng : book.name} ${state.readerState.chapter}`;
  const heading = document.getElementById("bible-title");
  if (heading) {
    heading.textContent = isEnglishVersion
      ? `${book.eng} Chapter ${state.readerState.chapter}`
      : `${book.name} ${state.readerState.chapter}章`;
  }

  const version = state.readerState.version || "CUNP";
  const versionLabel = version === "RCUVTS" ? "RCUV" : version;
  const versionBtn = document.getElementById("reader-nav-version-btn");
  const versionSpan = versionBtn ? versionBtn.querySelector("span") : null;
  if (versionSpan) versionSpan.textContent = versionLabel;
  const inlineVersion = document.getElementById("reader-version-inline");
  if (inlineVersion) inlineVersion.textContent = versionLabel;
  const navBadge = document.getElementById("bible-nav-version-badge");
  if (navBadge) navBadge.textContent = versionLabel;
}

// ─── Tab Switching: isSwitching guard prevents concurrent race conditions ───
let isSwitching = false;

appRouter.switchTab = async function (tabId, options = {}) {
  // ── Offline reading mode: only the Bible reader tab is reachable. Other
  // tabs would just show empty/stale data since offline mode only ever has
  // the small cached snapshot, not a live connection. Redirect (rather than
  // just refusing) so the initial boot navigation still lands somewhere. ──
  if (state.offlineMode && tabId !== "reader-view") {
    if (typeof showToast === "function") {
      showToast("離線閱讀模式僅能使用「讀經」，其他功能請連線後再試");
    }
    if (this.currentTab !== "reader-view") {
      return this.switchTab("reader-view", options);
    }
    return;
  }

  // ── State Lock: block double-tap / rapid navigation ──
  if (isSwitching) {
    console.warn(`[Router] switchTab('${tabId}') blocked — previous transition still in progress.`);
    return;
  }
  isSwitching = true;
  this.isTabTransitioning = true;

  const previousTab = this.currentTab;
  if (previousTab && previousTab !== tabId && typeof this.captureTabScroll === "function") {
    this.captureTabScroll(previousTab);
  }

  try {
    // ── Pre-flight: reader-state cleanup ──
    if (tabId !== "reader-view" || !options.fromPlan) {
      if (state.readerState) state.readerState.fromPlan = false;
    }

    // ── Pre-flight: stop TTS audio ──
    if (tabId !== "reader-view" && typeof window.speechSynthesis !== "undefined") {
      if (previousTab === "reader-view" && typeof window.clearReaderAudioOnPageExit === "function") {
        window.clearReaderAudioOnPageExit();
      } else {
        window.speechSynthesis.cancel();
      }
      const audioBtn = document.getElementById("reader-audio-btn");
      if (audioBtn) audioBtn.classList.remove("active");
    }

    // ── 1. Update currentTab immediately (sync) ──
    this.currentTab = tabId;

    // ── 2. Update nav button states (sync) ──
    document.querySelectorAll(".tab-btn, .mobile-nav-btn").forEach(btn => {
      const target = btn.getAttribute("data-target");
      if (!target) return;
      const isActive = target === tabId;
      btn.classList.toggle("active", isActive);
      if (btn.classList.contains("mobile-nav-btn") || btn.closest(".nav-tabs")) {
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
        if (isActive) btn.setAttribute("aria-current", "page");
        else btn.removeAttribute("aria-current");
      }
    });

    // ── 3. Show/hide view panes (sync) ──
    document.querySelectorAll(".view-pane").forEach(pane => {
      if (pane.id === tabId) {
        pane.classList.remove("hidden");
        pane.classList.add("active");
      } else {
        pane.classList.add("hidden");
        pane.classList.remove("active");
      }
    });

    // ── 3b. Paint reader top bar immediately so it's never stale while the
    // lazy bible.js module loads (avoids the fadeIn-then-label-swap flash) ──
    if (tabId === "reader-view") {
      paintReaderChromeFromState();
    }

    // ── 4. Pre-render state mutations (sync, before any await) ──
    if (tabId === "plan-view" && !options.keepPlanDetail) {
      // Only reset if no active plan: preserve plan detail when re-tapping the plan nav tab
      if (!state.activePlan) {
        state.planDetailOpen = false;
      }
    }
    if (tabId === "plan-view" && options.onboardingPlanDestination === "active-progress" && state.activePlan) {
      state.planDetailOpen = true;
      state.planActiveSubTab = "today";
      window.currentPlanViewState = "DETAIL";
    }

    // ── 5. Load module + render (fully awaited) ──
    if (typeof window.syncActivePlanContext === 'function') {
      window.syncActivePlanContext();
    }

    if (tabId === "dashboard-view") {
      const mod = await loadModule('home', './modules/home.js?v=' + buildVersion);
      if (mod && typeof mod.updateDashboardView === 'function') {
        await mod.updateDashboardView();
      } else if (typeof window.updateDashboardView === 'function') {
        await window.updateDashboardView();
      }

    } else if (tabId === "reader-view") {
      const mod = await loadModule('bible', './modules/bible.js?v=' + buildVersion);
      if (mod && typeof mod.renderReaderText === 'function') {
        await mod.renderReaderText();
      } else if (typeof window.renderReaderText === 'function') {
        await window.renderReaderText();
      }

    } else if (tabId === "plan-view") {
      const eligibilityBlock = typeof getPlanEligibilityBlock === "function"
        ? getPlanEligibilityBlock(state.currentUser)
        : null;
      if (eligibilityBlock) {
        resetPlanNavigationForEligibilityGate();
        renderPlanEligibilityGate(eligibilityBlock);
      } else {
        hidePlanEligibilityGate();
        const mod = await loadModule('plan', './modules/plan.js?v=' + buildVersion);
        await ensurePlanFeatureModulesLoaded();
        if (mod && typeof mod.renderPlanView === 'function') {
          await mod.renderPlanView();
        } else if (typeof window.renderPlanView === 'function') {
          await window.renderPlanView();
        }
        if (options.onboardingPlanDestination === "discover") {
          if (mod && typeof mod.showDiscoverPlans === "function") {
            await mod.showDiscoverPlans();
          } else if (typeof window.showDiscoverPlans === "function") {
            await window.showDiscoverPlans();
          }
        }
      }

    } else if (tabId === "stats-view") {
      const mod = await loadModule('plan', './modules/plan.js?v=' + buildVersion);
      if (typeof window.updateStatsView === 'function') {
        await window.updateStatsView();
      }

    } else if (tabId === "profile-view") {
      const mod = await loadModule('profile', './modules/profile.js?v=' + buildVersion);
      if (typeof window.syncActivePlanContext === 'function') {
        window.syncActivePlanContext();
      }
      if (typeof window.renderProfileView === 'function') {
        await window.renderProfileView();
      }

    } else if (tabId === "admin-view") {
      const adminPane = document.getElementById("admin-view");
      if (adminPane) {
        adminPane.classList.remove("hidden");
        adminPane.style.display = "block";
      }
      await loadModule('plan', './modules/plan.js?v=' + buildVersion);
      const mod = await loadModule('admin', './modules/admin.js?v=' + buildVersion);
      const isSystemAdmin = getUserRoleCode(state.currentUser) === 'admin';

      const MANAGEMENT_ROLES = ['admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader'];
      const userRole = getUserRoleCode(state.currentUser) || 'member';
      if (MANAGEMENT_ROLES.includes(userRole)) {
        if (mod && typeof mod.renderAdminPlanManagement === 'function') {
          await mod.renderAdminPlanManagement();
        } else if (typeof window.renderAdminPlanManagement === 'function') {
          await window.renderAdminPlanManagement();
        }
      }
      if (isSystemAdmin) {
        // Campaign editing and the React issue-report manager are secondary
        // system-management surfaces. Loading them (the report bundle is
        // comparatively large) must not delay the visible plan-management
        // panel; hydrate them in the background after its first render.
        void Promise.all([
          ensureAdminFeatureModulesLoaded(),
          loadIssueReportUi({ includeAdmin: true })
        ]).catch(err => {
          console.warn('[Admin] Secondary management modules failed to load:', err);
        });
      }
    }

    // ── 6. updateNavigationChrome — THE SINGLE, FINAL CALL ──
    // All async rendering is complete. State is now fully settled.
    this.updateNavigationChrome();
    refreshCareReminderBadge();

    if (options.restoreTabScroll && typeof this.restoreTabScroll === "function") {
      await this.restoreTabScroll(tabId);
    }

  } finally {
    // ── 7. Always release the lock, even on error ──
    this.isTabTransitioning = false;
    isSwitching = false;
  }
};

// If the reader's current version has no downloaded offline pack, silently
// switch to whichever offline pack IS installed (remembering the original
// choice in state.readerState.onlinePreferredVersion so the "online" handler
// can restore it later) so offline reading shows real, correctly-labeled
// content instead of the tiny hardcoded BIBLE_FALLBACK mislabeled with the
// unavailable version's name. If nothing has been downloaded at all, this
// intentionally leaves state.readerState.version untouched — the caller may
// still want to warn the user via notifyToast in that case.
async function applyOfflineBibleVersionFallback({ notifyToast = false } = {}) {
  if (!window.offlineBibleRepository) return;
  try {
    const installedPacks = await window.offlineBibleRepository.listInstalledPacks();
    const installedVersions = new Set(installedPacks.map(pack => pack.translation));
    const currentVersion = String(state.readerState.version || "CUNP").toUpperCase();
    if (installedVersions.has(currentVersion)) return;

    const offlineVersion = installedVersions.has("OCCB") ? "OCCB" : (installedVersions.has("WEB") ? "WEB" : null);
    if (!offlineVersion) {
      if (notifyToast && typeof window.showToast === "function") {
        window.showToast("目前離線，且尚未下載離線聖經版本，部分經文可能無法顯示。可到讀經設定下載離線版本。");
      }
      return;
    }

    state.readerState.onlinePreferredVersion = currentVersion;
    state.readerState.version = offlineVersion;
    document.documentElement.dataset.offlineBibleFallback = offlineVersion;

    if (typeof window.updatePillLabels === "function") window.updatePillLabels();
    if (typeof window.renderReaderText === "function" && appRouter.currentTab === "reader-view") {
      window.renderReaderText();
    }
    if (notifyToast && typeof window.showToast === "function") {
      window.showToast(`目前離線，已暫時切換為已下載的「${offlineVersion}」版本經文`);
    }
  } catch (error) {
    console.warn("[PWA] Could not select an installed offline Bible.", error);
  }
}

// Bootstrap the application on DomContentLoaded
document.addEventListener("DOMContentLoaded", async () => {
  // Clear badge notification count on app startup / load
  clearBadge().catch(err => console.error("Failed to clear badge on startup:", err));

  // Expose iOS 16.4+ notification permission helper for user gesture triggers
  window.requestPwaNotificationPermission = async () => {
    const permission = await requestNotificationPermission();
    console.log("PWA Notification permission status:", permission);
    return permission;
  };

  // Expose global manual refresh function (Pull-to-Refresh JS is completely removed)
  window.refreshCurrentAppView = refreshCurrentAppView;

  // Auto-refresh data when user switches back to the app window/tab
  window.addEventListener("focus", () => {
    if (typeof window.refreshCurrentAppView === "function") {
      window.refreshCurrentAppView();
    }
  });

  // Initialize Theme
  try {
    initTheme();
  } catch (err) {
    console.error("Failed to initialize theme:", err);
  }

  try {
    initNotificationSystem();
  } catch (err) {
    console.error("Failed to initialize notification system:", err);
  }

  if (typeof ComponentSkeletonLoader !== "undefined") {
    ComponentSkeletonLoader.applyBootSkeletons();
  }

  // Initialize Routing
  try {
    appRouter.init();
    if (typeof hydrateIcons === "function") hydrateIcons();
  } catch (err) {
    console.error("Failed to initialize routing:", err);
  }

  // Initialize Settings & State Loading
  try {
    loadLocalSettings();
  } catch (err) {
    console.error("Failed to load local settings:", err);
  }

  // Initialize Database Connection & Auth
  // db.init() handles: OIDC callback, session sync, and returns early after auth is established.
  // loadUserData() is called exactly once after init() to populate state.
  let initialSessionSyncSucceeded = false;
  try {
    initialSessionSyncSucceeded = await db.init() === true;
  } catch (err) {
    console.error('Failed to initialize database connection & auth:', err);
  }

  // Arm the proactive refresh timer even when db.init() reused an
  // already-valid cached session and never touched the tokens itself — that
  // fast path (see syncNlcSessionWithSupabase) never calls _saveTokens.
  if (typeof auth !== "undefined" && typeof auth.scheduleProactiveRefresh === "function") {
    auth.scheduleProactiveRefresh();
  }

  // One authoritative path for reading-log snapshots and mutations.
  const repositoryCache = "indexedDB" in window ? new IndexedDbClient() : null;
  window.pwaDataStore = repositoryCache;
  window.offlineBibleRepository = new OfflineBibleRepository({ dbClient: repositoryCache });
  initOfflineBibleControls(window.offlineBibleRepository).catch(error => {
    console.warn("[PWA] Offline Bible controls failed to initialize.", error);
  });
  if (state.offlineMode) {
    await applyOfflineBibleVersionFallback();
  }
  window.readingLogRepository = new SupabaseRepository({
    table: "reading_logs",
    clientProvider: () => window.state?.supabase,
    cacheClient: repositoryCache
  });
  window.readingLogRepository.addEventListener("data", event => {
    document.documentElement.dataset.readingDataSource = event.detail.source;
    document.documentElement.dataset.readingDataStale = String(Boolean(event.detail.stale));
  });
  window.readingLogRepository.addEventListener("error", event => {
    const error = event.detail;
    document.documentElement.dataset.repositoryError = error.category || "unknown";
    console.error(`[Repository:reading_logs] ${error.operation} failed (${error.category})`, error);
  });
  // Load all user data in one shot. db.init() guarantees auth is resolved before we reach here.
  try {
    const [, initialDataLoadSucceeded] = await Promise.all([
      db.fetchRoleDefinitions(),
      db.loadUserData(true)
    ]);

    if (typeof window.syncActivePlanContext === 'function') {
      window.syncActivePlanContext();
    }

    // Update role-dependent UI now that profile data is loaded
    if (typeof updateAdminNavVisibility === 'function') updateAdminNavVisibility();

    // Render the initial view only after ALL data is ready
    const resumePlan = consumeBibleHubResume(window.location.search);
    if (resumePlan) {
      const cleaned = new URL(window.location.href);
      cleaned.searchParams.delete("resume");
      const nextSearch = cleaned.searchParams.toString();
      window.history.replaceState(
        {},
        document.title,
        cleaned.pathname + (nextSearch ? `?${nextSearch}` : "") + cleaned.hash
      );
    }
    await appRouter.switchTab(resumePlan ? "plan-view" : "dashboard-view");
    refreshCareReminderBadge({ force: true });
    maybeShowReleaseOnboarding({
      auth,
      syncComplete: initialSessionSyncSucceeded && initialDataLoadSucceeded === true,
      storage: window.localStorage,
      config: window.APP_CONFIG
    });

    // Organization-directory data is not required for the first dashboard paint.
    // Load it in the background so larger churches do not block app startup.
    db.loadOrgStructure().catch(error => {
      console.warn("Organization directory load failed after startup", error);
    });
  } catch (err) {
    console.error('Failed to load initial data & render dashboard:', err);
  } finally {
    if (typeof ComponentSkeletonLoader !== 'undefined') {
      ComponentSkeletonLoader.clearBootInlineSkeletons();
    }
  }

  // Mount the report action independently of PWA initialization so a slow service worker cannot hide it.
  scheduleIssueReportUiLoad({ includeAdmin: false });

  // PWA registration and authenticated offline reading queue.
  try {
    await initializePwa();
  } catch (error) {
    console.warn("[PWA] Initialization failed; continuing in online-only mode.", error);
  }

  window.addEventListener("pwa:sync-status", event => {
    const detail = event.detail || {};
    document.documentElement.dataset.syncState = detail.status || "idle";
    document.documentElement.dataset.pendingSyncCount = String(detail.pending || 0);
    if (detail.status === "queued" && typeof showToast === "function") {
      showToast("已離線儲存，恢復網路後會自動同步");
    } else if (detail.status === "complete" && detail.pending === 0 && typeof showToast === "function") {
      showToast("離線讀經進度已同步");
    }
  });

  // The only place a genuine app-shell update is reported: fires once the new
  // service worker has actually taken control (see ServiceWorkerRegistrar.js).
  // Routine focus-triggered data refreshes must never claim "已更新" themselves.
  window.addEventListener("pwa:update-ready", () => {
    if (typeof showToast === "function") {
      showToast("已更新至最新版本");
    }
  });

  window.addEventListener("offline", () => {
    if (window.db?.tryRestoreOfflineSession?.()) {
      window.showToast?.("已切換為離線閱讀模式");
      if (appRouter.currentTab !== "reader-view") {
        appRouter.switchTab("reader-view");
      }
    }
    applyOfflineBibleVersionFallback({ notifyToast: true });
  });

  window.addEventListener("online", async () => {
    // Restore the reader's actual preferred version whenever offline
    // substituted it — independent of state.offlineMode, since a normal
    // online session that simply loses connectivity mid-use never sets that
    // flag (it only marks the cached-trusted-identity offline login path).
    const preferredVersion = state.readerState.onlinePreferredVersion;
    if (preferredVersion) {
      state.readerState.version = preferredVersion;
      delete state.readerState.onlinePreferredVersion;
      delete document.documentElement.dataset.offlineBibleFallback;
      if (typeof window.updatePillLabels === "function") window.updatePillLabels();
      if (typeof window.renderReaderText === "function" && appRouter.currentTab === "reader-view") {
        window.renderReaderText();
      }
      window.showToast?.(`已恢復連線，切回「${preferredVersion}」版本經文`);
    }

    if (!state.offlineMode || typeof auth === "undefined" || !auth.isLoggedIn()) return;
    try {
      await window.db.syncNlcSessionWithSupabase(true);
      await db.loadUserData(true);
      window.showToast?.("已恢復連線並同步登入狀態");
      if (appRouter.currentTab) await appRouter.switchTab(appRouter.currentTab);
    } catch (error) {
      console.warn("Online session revalidation failed", error);
      // Only send the user back to the login gate once auth itself has
      // actually given up — auth.isLoggedIn() only goes false after a
      // confirmed rejection (refreshTokens' authRejected path clears stored
      // tokens). A transient failure right as connectivity returns (spotty
      // signal, the reconnect event firing before the network is truly
      // usable) leaves tokens intact, so isLoggedIn() stays true and this
      // does nothing — the next natural retry (focus, tab switch) picks it
      // back up instead of yanking the user out of what they were doing.
      if (typeof auth.isLoggedIn === "function" && !auth.isLoggedIn() && typeof window.db.showConnectionError === "function") {
        window.db.showConnectionError("重新連線後登入狀態已失效，請重新登入。");
      }
    }
  });

  // ── Background pre-warm: silently load plan module script only ──
  loadModule('plan', './modules/plan.js?v=' + buildVersion).then(() => {
    ensurePlanFeatureModulesLoaded().catch(() => {});
  }).catch(() => {});

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshCareReminderBadge();
      clearBadge().catch(err => console.error("Failed to clear badge on visible:", err));

      // 💡 行動裝置前景切換健康保護：防止 iOS/Android 背景記憶體回收導致的空白或死機
      try {
        const isProfileLost = !state.currentUser || !state.currentUser.name;
        const isPlanLost = !state.activePlan && Array.isArray(state.activePlans) && state.activePlans.length > 0;
        if ((isProfileLost || isPlanLost) && typeof db !== "undefined" && typeof db.loadUserData === "function") {
          console.log("⚡ [HealthCheck] Foreground wake detected memory eviction, restoring state...");
          db.loadUserData().catch(err => console.warn("Failed to restore state on foreground wake:", err));
        }
      } catch (e) {
        console.warn("Visibility health check error:", e);
      }
    }
  });

  // ── Android 返回鍵相容防線：首頁雙擊退出保護與 Tab 返回攔截 ──
  (function() {
    let lastBackPress = 0;
    const doublePressInterval = 2000; // 2 秒

    // 初始化/切換首頁時 push 虛擬 Root 紀錄，用以攔截返回鍵
    function pushRootState() {
      if (!window.history.state || !window.history.state.isAppRoot) {
        window.history.pushState({ isAppRoot: true }, "");
      }
    }

    // 監聽 popstate
    window.addEventListener("popstate", (event) => {
      // 1. 檢查當前是否有 Vanilla Modal 開啟
      const versionPicker = document.getElementById("bible-version-picker-modal");
      const isPickerOpen = versionPicker && !versionPicker.classList.contains("hidden");

      const badgeDetail = document.getElementById("badge-detail-page");
      const isBadgeOpen = badgeDetail && !badgeDetail.classList.contains("hidden");

      // 判斷是否退回到了底層 (沒有 root state 了)
      const hasRootState = event.state && event.state.isAppRoot;
      const hasModalState = event.state && event.state.modalId;

      if (!hasRootState && !hasModalState) {
        // 如果有任何原生彈窗開啟，攔截返回鍵並優先關閉它們
        if (isPickerOpen) {
          const closeBtn = document.getElementById("version-picker-close");
          if (closeBtn) closeBtn.click();
          else versionPicker.classList.add("hidden");
          pushRootState();
          return;
        }

        if (isBadgeOpen) {
          const closeBtn = document.getElementById("badge-page-back-btn");
          if (closeBtn) closeBtn.click();
          else if (typeof window.closeBadgeDetailPage === "function") window.closeBadgeDetailPage();
          else badgeDetail.classList.add("hidden");
          pushRootState();
          return;
        }

        // 沒有彈窗開啟時，執行首頁或 Tab 導航邏輯
        const currentTab = window.appRouter ? window.appRouter.currentTab : "dashboard-view";

        if (currentTab === "dashboard-view") {
          // 在首頁：實施雙擊退出保護
          const now = Date.now();
          if (now - lastBackPress < doublePressInterval) {
            window.close();
          } else {
            lastBackPress = now;
            if (typeof showToast === "function") {
              showToast("再按一次返回鍵退出應用", doublePressInterval);
            }
            pushRootState();
          }
        } else {
          // 不在首頁：自動導回首頁，提升操作體驗
          if (window.appRouter && typeof window.appRouter.switchTab === "function") {
            window.appRouter.switchTab("dashboard-view").then(() => {
              pushRootState();
            }).catch(() => {
              pushRootState();
            });
          } else {
            pushRootState();
          }
        }
      }
    });

    // 啟動時與路由切換時，確保 Root State 存在
    pushRootState();

    // 攔截 switchTab 以在切換 Tab 時重新確認/鎖定 history 狀態
    if (window.appRouter) {
      const originalSwitchTab = window.appRouter.switchTab;
      window.appRouter.switchTab = async function(tabId, options) {
        const result = await originalSwitchTab.call(this, tabId, options);
        pushRootState();
        return result;
      };
    }
  })();

});
