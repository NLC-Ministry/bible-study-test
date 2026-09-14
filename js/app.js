// js/app.js

// Import support and core files needed before first paint.
import '../config.js';
import './data/bible_data.js?v=20260914_chapter_fetch_timeout';
import './data/bible_verse_counts.js';
import './copy/zh-Hant.js?v=20260914_name_placeholder_unify';
import './data/church_campaign.js?v=20260901_r1final_monthly_split';
import './design/design-tokens.js';
import './design/design-system-helpers.js?v=20260901_round_schedule_restore';
import './design/icon-registry.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './design/icons.js';
import './state.js?v=20260914_tab_switch_navguard';
import './auth.js?v=20260906_session_expired_event';
import './auth-launch.mjs';
import './db.js?v=20260914_name_review_removed';
import './utils.js?v=20260914_name_review_removed';
import './gamification.js?v=20260826_quiz_remove_duplicate_scope_filter';
import { initModalManager } from './modules/modal-manager.mjs';

import {
  BIBLE_HUB_CONTINUE_RETURN_TO,
  consumeBibleHubResume,
  hubContinueHref,
  launchMemberHubContinue
} from './login-onboarding-gate.mjs?v=20260828_login_gate_refresh_latest';
import { cleanupProductionStorage } from './production-cleanup.mjs';
import { initializePwa } from './pwa/PwaCoordinator.js?v=20260826_quiz_remove_duplicate_scope_filter';
import { IndexedDbClient } from './pwa/IndexedDbClient.js';
import { OfflineBibleRepository } from './pwa/OfflineBibleRepository.js';
import { initOfflineBibleControls } from './pwa/OfflineBibleControls.js';
import { SupabaseRepository } from './pwa/SupabaseRepository.js?v=20260901_reading_log_pagination_fix';
import { clearBadge, requestNotificationPermission } from '../lib/services/badge-service.ts';

cleanupProductionStorage(window.localStorage);
initModalManager();

let buildVersion = "__BUILD_VERSION__";
if (!/^\d{14}$/.test(buildVersion)) {
  buildVersion = "dev_" + Date.now();
}
buildVersion += "_clean_demo_mode_v20_quiz_manual_retry_v1_member_hub_name_sync_v1_quiz_load_error_v1_group_filter_reset_fix_v1_quiz_publish_flow_redesign_v1_row_cap_pagination_fix_v1_quiz_entry_reading_gate_v1_quiz_feature_reopen_restore_v1_admin_mobile_layout_v1_reader_audio_resume_fix_v1_joined_plan_collapse_v1_admin_tabs_lead_v1_0830_quiz_pledge_banner_v1_big_exam_p1_v1_fullscreen_resilience_v1_exam_p2_admin_v1_result_review_v1_feature_toggle_move_v1_paper_picker_v1_section_config_v1_exam_p3_stats_notify_v1_exam_announcement_flag_v1_exam_p4_resilience_v1_exam_no_shortanswer_hide_v1_exam_mode_switch_v1_noflash_sweep_v1_exam_p4_two_track_v1_notif_admin_anon_v1_exam_autoscore_toggle_v1_answer_only_editor_v1_exam_publish_results_lock_v1_push_guards_v1_result_pending_label_v1_staff_preview_label_v1_exam_close_ux_o1o2o3_v1_finalize_expired_v1_stats_team_size_v1_stats_scope_teamrank_v1_exam_practice_review_autoclose_v1_exam_multi_paper_profile_v1_exam_practice_grace_day_v1_exam_batch_grading_v1_region_cohort_v1_exam_empty_shortanswer_zero_v1_exam_team_fixed_divisor_v1_exam_full_result_paper_v1_exam_red_correction_overlay_v1_announcement_live_only_v1_result_numeric_answers_v1_match_review_draw_v1_choice_mark_v1_practice_to_review_rename_v1_pledge_copy_v1_registration_current_plan_default_v1_corrected_label_wording_v2_exam_token_resilience_v1_grading_full_sheet_v1_answers_export_v1_result_row_declutter_v1_perf_foreground_coordinator_a1_v1_perf_token_no_wipe_a2_v1_perf_badge_throttle_a5_v1_perf_chart_update_b7_v1_cohort_stage_kind_v1_ranking_baseline_schedule_v1_progress_baseline_round1_v1_level_teardown_v1_round_schedule_restore_v1_missed_chapters_reminder_v1_care_reminder_edit_merge_v1_reader_position_fromplan_fix_v1_reading_log_pagination_fix_v1_db_pagination_audit_v1_highlights_notes_review_v1_reader_next_chapter_jump_fix_v1_ten_verse_chapter_load_fix_v1_member_hub_org_dedupe_v1_profile_subpage_overlay_fix_v1_cohort_materialized_schedule_v1_cohort_plain_plan_award_only_v1_admin_section_nav_step1_v1_emergency_announcement_editor_v1_admin_section_open_fix_v1_admin_section_unified_v2_admin_section_mobile_drilldown_v1_r1final_monthly_split_v1_r1final_discover_lock_v1_r1final_award_aggregate_v1_exam_grading_fixes_v1_score_input_validation_v1_login_continuation_return_fix_v1_profile_subpage_close_selector_fix_v1_r1final_badge_puzzle_v1_devotion_editor_modal_video_v1_devotion_progress_notes_v1_devotion_ui_polish_v1_devotion_publish_all_v1_home_feature_cards_v1_home_cards_login_race_v1_myplans_devotion_order_v1_home_cards_no_planjs_dep_v1_gm_topic_passage_inline_v1_match_lines_on_top_v1_match_align_button_v1_devotion_share_copy_v1_devotion_share_scripture_v1_devotion_sync_log_v1_devotion_group_hidden_v1_devotion_hidden_toggle_v1_lock_ended_stage_team_v1_exam_grading_seq_v1_plan_gate_login_only_v1_lazy_supabase_lib_v1_lazy_chartjs_v1_boot_resilient_settled_v1_a1_revert_v1_lazy_html2canvas_v1_font_light_drop_v1_plan_audience_region_gate_v1_session_expiry_foreground_gate_v1_session_expired_event_v1_batch_select_capability_v1_batch_select_loaduserdata_v1_batch_select_orgstructure_v1_batch_select_globalplans_v1_read_dedup_v1_feature_settings_bulk_v1_org_structure_rpc_v1_batch_metric_label_v1_exam_pr_values_v1_issue_report_thread_exit_v1_verse_multi_select_v1_plan_series_filter_v1_team_invite_unfilled_v1_round_overflow_schedule_v1_book_badge_crowns_v1_prestige_svg_v1_exam_first_round_filter_v1_exam_paper_linked_plan_v1";
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

  // 只是鈴鐺數字，不需要太即時。非強制情況（回前景 / 定期）節流 90 秒，
  // 少打三個通知 RPC（care / quiz / exam）。使用者按「已讀」等動作走 force。
  const now = Date.now();
  if (!options.force && now - careReminderBadgeLastRefresh < 90000) return;
  careReminderBadgeLastRefresh = now;

  try {
    const [careResult, quizResult, examResult, issueResult] = await Promise.all([
      db.fetchCareReminders(),
      typeof db.fetchQuizNotifications === "function"
        ? db.fetchQuizNotifications()
        : Promise.resolve({ data: [], error: null }),
      typeof db.fetchExamNotifications === "function"
        ? db.fetchExamNotifications()
        : Promise.resolve({ data: [], error: null }),
      typeof db.fetchIssueThreadUnread === "function"
        ? db.fetchIssueThreadUnread()
        : Promise.resolve({ total: 0, error: null })
    ]);
    if (!careResult.error || !quizResult.error || !examResult.error) {
      const issueUnread = Math.max(0, Number(issueResult && issueResult.total) || 0);
      updateCareReminderBadge([
        ...(careResult.data || []),
        ...(quizResult.data || []),
        ...(examResult.data || []),
        // 回報有新回覆：以「未讀」佔位項灌進鈴鐺數字。
        ...Array.from({ length: issueUnread }, (_unused, i) => ({ id: `issue-thread-${i}`, status: "unread" }))
      ]);
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

  const [careResult, quizResult, examResult, issueResult] = await Promise.all([
    db.fetchAllNotifications(),
    typeof db.fetchQuizNotifications === "function"
      ? db.fetchQuizNotifications()
      : Promise.resolve({ data: [], error: null }),
    typeof db.fetchExamNotifications === "function"
      ? db.fetchExamNotifications()
      : Promise.resolve({ data: [], error: null }),
    typeof db.fetchIssueThreadUnread === "function"
      ? db.fetchIssueThreadUnread()
      : Promise.resolve({ total: 0, error: null })
  ]);
  const notifications = [...(careResult.data || []), ...(quizResult.data || []), ...(examResult.data || [])]
    .sort((left, right) => String(right.createdAt || right.created_at || right.sent_on || "")
      .localeCompare(String(left.createdAt || left.created_at || left.sent_on || "")))
    .slice(0, 20);
  const issueUnread = Math.max(0, Number(issueResult && issueResult.total) || 0);
  if (issueUnread > 0) {
    notifications.unshift({
      type: "issue-thread",
      status: "unread",
      sender: { role: "admin" },
      message: `你的回報有 ${issueUnread} 則新回覆，點此查看。`,
      sent_on: ""
    });
  }
  const error = careResult.error && quizResult.error && examResult.error ? careResult.error : null;

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
    const isExamNotification = item.type === "exam";
    const isTeamReminder = String(item.plan_key || "").startsWith("reading-team:");
    const senderRole = isTeamReminder
      ? "隊友"
      : (getRoleDefinition(senderRoleRaw)?.label || roleNames[senderRoleRaw] || "領袖");

    const displaySenderRole = isExamNotification ? "大測驗" : (isQuizNotification ? "小測驗發佈者" : senderRole);
    // 系統管理員發出的通知：只顯示「系統管理員」，不打出本名
    const isAdminSender = senderRoleRaw === "admin";
    const senderLabel = isAdminSender ? "來自系統管理員" : `來自${displaySenderRole} ${safeEscapeHTML(senderName)}`;
    const dateStr = item.sent_on || "";

    div.innerHTML = `
      <div class="notification-item__header">
        <span class="notification-item__sender">${senderLabel}</span>
        <span class="notification-item__time">${safeEscapeHTML(dateStr)}</span>
      </div>
      <p class="notification-item__body">${safeEscapeHTML(item.message || "加油！一起穩定讀經。")}</p>
    `;

    div.onclick = async (e) => {
      e.stopPropagation();
      if (item.type === "issue-thread") {
        document.getElementById("notification-popover")?.classList.add("hidden");
        window.dispatchEvent(new CustomEvent("open-issue-report", { detail: { tab: "my-reports" } }));
        return;
      }
      if (item.status === 'unread') {
        div.classList.remove("notification-item--unread");
        if (isExamNotification && typeof db.acknowledgeExamNotification === "function") {
          await db.acknowledgeExamNotification(item.id);
        } else if (isQuizNotification && typeof db.acknowledgeQuizNotification === "function") {
          await db.acknowledgeQuizNotification(item.id);
        } else {
          await db.acknowledgeCareReminder(item.id);
        }
        await refreshCareReminderBadge({ force: true });
      }
      if (isExamNotification && item.paperId) {
        document.getElementById("notification-popover")?.classList.add("hidden");
        // 同分頁導向，不開新視窗：安裝版 PWA / 手機 / 桌機行為一致，也不會被彈窗攔截。
        // 帶上 return，測驗頁關閉時用「上一頁」回到這裡（原分頁狀態由 bfcache 還原）。
        const back = location.pathname + location.search;
        location.assign(
          "exam.html?paper=" + encodeURIComponent(item.paperId) +
          "&return=" + encodeURIComponent(back)
        );
        return;
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

// A lazy-loaded view module (bible.js/plan.js/home.js/…) is fetched over the
// network like any other request — a momentary blip, or a brief real offline
// window, fails it exactly like any other fetch. Retry a couple of times
// before giving up, since most real-world failures here are transient rather
// than "this file genuinely doesn't exist".
const MODULE_LOAD_RETRY_DELAYS_MS = [400, 1200];

async function loadModule(name, path) {
  if (moduleCache[name]) {
    return moduleCache[name];
  }
  let lastErr = null;
  for (let attempt = 0; attempt <= MODULE_LOAD_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const mod = await import(path);
      moduleCache[name] = mod;
      if (typeof mod.init === 'function') {
        mod.init();
      }
      return mod;
    } catch (err) {
      lastErr = err;
      const delayMs = MODULE_LOAD_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) break;
      console.warn(`[ESM] Attempt ${attempt + 1} to load module ${name} failed, retrying in ${delayMs}ms`, err);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  console.error(`Failed to load module ${name} after ${MODULE_LOAD_RETRY_DELAYS_MS.length + 1} attempts:`, lastErr);
  const moduleError = new Error(`載入頁面元件失敗，請重新整理頁面再試一次。`);
  moduleError.code = "MODULE_LOAD_FAILED";
  moduleError.cause = lastErr;
  throw moduleError;
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

// ─── 計畫資格：只在登入時判斷 ───
// 登入流程（db.init → getUserOnboardingBlock → getLoginGateCopy）已經在「會員
// 資料剛同步過」的當下判斷過一次；通過了才會進到 App。計畫分頁 / 首頁的讀經
// 捷徑不再自己重新判斷——這樣冷啟動時 member_context_synced_at 看起來過期，也
// 不會把整個計畫分頁擋掉閃一下。會員資料若之後真的變動（例如會籍被停用），
// 下次登入時會重新判斷。

function hidePlanEligibilityGate() {
  const planView = document.getElementById("plan-view");
  const gate = document.getElementById("plan-eligibility-gate");
  if (planView) planView.classList.remove("plan-view--gated");
  if (gate) gate.classList.add("hidden");
}

// 保留成 no-op：既有呼叫端（home.js 的 openActivePlanFromDashboard /
// startReadingCurrentChapter、plan.js 的 openPlanChapterInReader /
// openPlanInlineReader）不用改，行為就是「不再攔」。
function guardPlanEligibility() { return false; }

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

// ─── Tab Switching: navRenderGuard lets the newest switchTab call always win.
// A superseded call's own chrome/history side effects are skipped instead of
// blocking the newer navigation from starting — see handleTabClick in
// state.js for the matching guard on the tab-bar click itself. ───
const navRenderGuard = createRenderGuard();

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

  // ── Take a ticket: this call proceeds immediately. If a newer switchTab
  // call starts before this one's async work finishes, this one's tail
  // effects (step 6 below) quietly no-op instead of clobbering the newer
  // navigation's chrome/history state. ──
  const myGen = navRenderGuard.start();
  this.isTabTransitioning = true;
  this.transitioningToTab = tabId;

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

    // Profile subpages are top-level fixed overlays (not nested in #profile-view),
    // so hiding the pane no longer hides them via an ancestor — close explicitly.
    if (state.profileDetailOpen && typeof window.closeProfileDetail === "function") {
      window.closeProfileDetail();
    }

    // Admin section drill-in overlay (mobile) — drop the body state on any tab change.
    if (typeof window.closeAdminSection === "function") {
      window.closeAdminSection();
    }

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
      // 計畫資格只在登入時判斷（db.init）。這裡不再重新判斷、不再擋整頁，
      // 直接把計畫分頁渲染出來。
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
    // Only the newest switchTab call gets to touch chrome/history/scroll; an
    // older call that's been superseded quietly stops here instead of
    // undoing what the newer navigation already rendered.
    if (navRenderGuard.isStale(myGen)) return;
    this.updateNavigationChrome();
    refreshCareReminderBadge();

    if (options.restoreTabScroll && typeof this.restoreTabScroll === "function") {
      await this.restoreTabScroll(tabId);
    }

  } catch (error) {
    console.error(`[Router] switchTab('${tabId}') failed:`, error);
    if (navRenderGuard.isStale(myGen)) return;
    // Best-effort recovery: fall back to the previous (working) tab instead
    // of leaving the user stuck staring at a half-rendered pane whose lazy
    // module (home.js/bible.js/plan.js/…) never finished loading — a failed
    // dynamic import here used to be an unhandled rejection with no visible
    // sign anything went wrong.
    if (previousTab && previousTab !== tabId) {
      this.currentTab = previousTab;
      document.querySelectorAll(".tab-btn, .mobile-nav-btn").forEach(btn => {
        const target = btn.getAttribute("data-target");
        if (!target) return;
        const isActive = target === previousTab;
        btn.classList.toggle("active", isActive);
        if (btn.classList.contains("mobile-nav-btn") || btn.closest(".nav-tabs")) {
          btn.setAttribute("aria-selected", isActive ? "true" : "false");
          if (isActive) btn.setAttribute("aria-current", "page");
          else btn.removeAttribute("aria-current");
        }
      });
      document.querySelectorAll(".view-pane").forEach(pane => {
        if (pane.id === previousTab) {
          pane.classList.remove("hidden");
          pane.classList.add("active");
        } else {
          pane.classList.add("hidden");
          pane.classList.remove("active");
        }
      });
      this.updateNavigationChrome();
    }
    if (typeof showToast === "function") {
      showToast(error && error.code === "MODULE_LOAD_FAILED"
        ? "載入頁面元件失敗，請重新整理頁面再試一次。"
        : "頁面切換失敗，請稍後再試。");
    }
  } finally {
    // ── 7. Release the transition flag — but only if we're still the
    // current navigation. A superseded call must not clear the flags a
    // newer, still-in-flight switchTab call owns. ──
    if (!navRenderGuard.isStale(myGen)) {
      this.isTabTransitioning = false;
      this.transitioningToTab = null;
    }
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
    return requestNotificationPermission();
  };

  // Expose global manual refresh function (Pull-to-Refresh JS is completely removed)
  window.refreshCurrentAppView = refreshCurrentAppView;

  // ── 單一「App 回前景」協調器（效能重構 A1）────────────────────────────
  // 以前散在 app.js / auth.js / db.js / profile.js 的 6 個 visibilitychange /
  // focus 監聽器，各自 syncNlcSessionWithSupabase(true) + 重繪，手機每次回前景
  // 就一陣網路風暴 + 整頁 innerHTML 重建。改成一個入口、統一節流、預設只做輕事，
  // 只有偵測到 state 真的壞掉才重抓 + 重繪。
  let _lastForegroundRunAt = 0;
  const FOREGROUND_MIN_INTERVAL_MS = 45000;

  // Session died while the app was open — a data call hit auth.js's authRejected
  // path, which cleared the tokens and blanked state.currentUser. Nothing else
  // brings the login card back up mid-session, so if the app shell is still on
  // screen, surface it. Same !isLoggedIn() guard the online-event handler uses:
  // it only goes false after a confirmed rejection, never a transient network
  // failure (those keep the tokens), so this won't fire on a flaky reconnect.
  // Called both from onAppForeground and from the auth:session-expired event.
  function surfaceLoginCardIfSessionLost() {
    if (typeof db === "undefined" || typeof db.showConnectionError !== "function") return;
    const loggedIn = typeof auth !== "undefined" && typeof auth.isLoggedIn === "function" && auth.isLoggedIn();
    if (loggedIn) return;
    const appLayout = document.querySelector(".app-layout");
    const gate = document.getElementById("login-gate");
    const showingApp = appLayout && !appLayout.classList.contains("hidden")
      && (!gate || gate.classList.contains("hidden"));
    if (state.isSupabaseMode && showingApp) {
      db.showConnectionError("登入狀態已失效，請重新登入。");
    }
  }

  function onAppForeground() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const now = Date.now();
    if (now - _lastForegroundRunAt < FOREGROUND_MIN_INTERVAL_MS) return;
    _lastForegroundRunAt = now;

    // 1) 一定要做的輕事：主動續期（到期前才會真的換）+ 通知數（自帶 30s 節流）
    // getValidAccessToken() 內部只在接近到期時才真的續，token 還新鮮就只是讀 localStorage；
    // 回前景直接補一次，別等下一個資料請求 401 才反應（背景期間 timer 常被瀏覽器凍結）。
    try {
      if (typeof auth !== "undefined") {
        auth.scheduleProactiveRefresh?.();
        auth.getValidAccessToken?.().catch(() => {});
      }
    } catch (_) {}
    refreshCareReminderBadge();
    clearBadge().catch(() => {});

    const loggedIn = typeof auth !== "undefined" && typeof auth.isLoggedIn === "function" && auth.isLoggedIn();
    if (typeof db === "undefined") return;
    if (!loggedIn) {
      surfaceLoginCardIfSessionLost();
      return;
    }

    const currentTab = (window.appRouter && window.appRouter.currentTab) || "dashboard-view";

    // 2) 只有 state 真的壞掉（背景被記憶體回收）才重抓 + 重繪
    const profileLost = !state.currentUser || !state.currentUser.name;
    const planLost = !state.activePlan && Array.isArray(state.activePlans) && state.activePlans.length > 0;
    if (profileLost || planLost) {
      Promise.resolve(db.loadUserData && db.loadUserData(true)).then(() => {
        if (typeof window.syncActivePlanContext === "function") window.syncActivePlanContext();
        if (currentTab && currentTab !== "reader-view" && window.appRouter) {
          window.appRouter.switchTab(currentTab, { keepPlanDetail: true, restoreTabScroll: false });
        }
      }).catch(() => {});
    }

    // 3) Member Hub 回來時：只在「登入閘門」還開著的情況下重同步 + 重新套用登入
    //    閘門（計畫資格只在登入時判斷，計畫分頁本身不再有自己的閘門）。
    const loginGate = document.getElementById("login-gate");
    if (loginGate && !loginGate.classList.contains("hidden") && typeof db.syncNlcSessionWithSupabase === "function") {
      db.syncNlcSessionWithSupabase(true).then(() => db.applyLoginOnboardingGate && db.applyLoginOnboardingGate()).catch(() => {});
    }
    if (currentTab === "profile-view" && typeof db.syncNlcSessionWithSupabase === "function") {
      db.syncNlcSessionWithSupabase(true).then(() => {
        if (typeof window.renderProfileView === "function") window.renderProfileView();
        if (typeof window.renderMemberHubProfileLinks === "function") window.renderMemberHubProfileLinks();
      }).catch(() => {});
    }
  }
  document.addEventListener("visibilitychange", () => onAppForeground());
  window.addEventListener("pageshow", (e) => { if (e && e.persisted) onAppForeground(); });
  // auth.js fires this the moment getValidAccessToken() gives up (tokens already
  // cleared). Surface the login card immediately, not only on the next foreground.
  window.addEventListener("auth:session-expired", () => surfaceLoginCardIfSessionLost());

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
    // allSettled, not all: a stale/expired NLC session makes the data-layer shim
    // reject (getValidAccessToken throws). That must NOT abort the first render —
    // db.init() has already shown the login gate for a bad session, and for a
    // session that only degraded mid-boot an empty dashboard the user can refresh
    // is still far better than a black screen.
    const [roleResult, userDataResult] = await Promise.allSettled([
      db.fetchRoleDefinitions(),
      db.loadUserData(true)
    ]);
    if (roleResult.status === "rejected") {
      console.error("Role definitions load failed during boot:", roleResult.reason);
    }
    if (userDataResult.status === "rejected") {
      console.error("Initial user-data load failed during boot:", userDataResult.reason);
    }
    const initialDataLoadSucceeded = userDataResult.status === "fulfilled" && userDataResult.value === true;

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

  // 回前景的處理已收斂到單一 onAppForeground()（見上方效能重構 A1）。

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

      const profileSub = state.profileDetailOpen
        && document.getElementById(`profile-tab-content-${state.profileDetailOpen}`);
      const isProfileSubOpen = !!(profileSub && !profileSub.classList.contains("hidden"));

      const isAdminSectionOpen = document.body.classList.contains("admin-section-open");

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

        // Admin section drill-in (mobile) — back returns to the function list.
        if (isAdminSectionOpen) {
          if (typeof window.closeAdminSection === "function") window.closeAdminSection();
          else document.body.classList.remove("admin-section-open");
          pushRootState();
          return;
        }

        // A profile subpage is a top-level overlay — back should close it in
        // place and leave the user on the profile tab, not jump to dashboard.
        if (isProfileSubOpen) {
          if (typeof window.closeProfileDetail === "function") window.closeProfileDetail();
          else profileSub.classList.add("hidden");
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

    // 攔截 switchTab 以在切換 Tab 時重新確認/鎖定 history 狀態。
    // 只有「還是最新一次」的切換才 push history，過期的切換完成時安靜跳過，
    // 避免快速連續切分頁時 history 被重複/錯序寫入。
    if (window.appRouter) {
      const originalSwitchTab = window.appRouter.switchTab;
      window.appRouter.switchTab = async function(tabId, options) {
        const callPromise = originalSwitchTab.call(this, tabId, options);
        const myGen = navRenderGuard.current;
        const result = await callPromise;
        if (!navRenderGuard.isStale(myGen)) pushRootState();
        return result;
      };
    }
  })();

});
