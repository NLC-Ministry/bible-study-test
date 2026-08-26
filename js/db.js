import { getResponsePayloadBytes, networkMetrics } from './performance/network-metrics.mjs';
import { fetchReadingLogsByPlanIds } from './data/reading-log-batches.mjs';
import { getConfirmedReadingRound, getCurrentRoundChapterProgress } from './data/current-round-progress.mjs';
import { getUserOnboardingBlock } from './member-journey.mjs';
import {
  applyLoginGateView,
  getLoginGateCopy,
  launchMemberHubContinue
} from './login-onboarding-gate.mjs';

window.__nlcNetworkMetrics = Object.freeze({
  snapshot: () => networkMetrics.snapshot(),
  summary: () => networkMetrics.summary()
});

const _storageDebounceTimers = {};

export function safeStorageSet(key, value, debounceMs = 0) {
  const doWrite = () => {
    try {
      const strVal = typeof value === "string" ? value : JSON.stringify(value);
      localStorage.setItem(key, strVal);
    } catch (err) {
      if (err && (err.name === "QuotaExceededError" || err.code === 22)) {
        console.warn("[Storage] QuotaExceededError detected! Clearing non-critical caches...");
        try {
          localStorage.removeItem("nlc_all_users_cache");
          localStorage.removeItem("nlc_all_users_cache_ts");
          localStorage.removeItem("church_announcements");
          const strVal = typeof value === "string" ? value : JSON.stringify(value);
          localStorage.setItem(key, strVal);
        } catch (e) {
          console.error("[Storage] Emergency purge failed:", e);
        }
      }
    }
  };

  if (debounceMs > 0) {
    if (_storageDebounceTimers[key]) clearTimeout(_storageDebounceTimers[key]);
    _storageDebounceTimers[key] = setTimeout(doWrite, debounceMs);
  } else {
    setTimeout(doWrite, 0);
  }
}
if (typeof window !== "undefined") {
  window.safeStorageSet = safeStorageSet;
}
/**
 * 依計畫名稱查找目前階段定義的 key。
 * @param {string} name
 * @returns {string|null}
 */
function getPresetKeyByName(name) {
  if (!name) return null;
  const target = String(name).trim();
  const match = Object.entries(CHURCH_PLAN_PRESETS).find(([, preset]) =>
    String(preset.name || "").trim() === target
  );
  return match ? match[0] : null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function quotePostgrestValue(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Supabase/PostgREST caps rows per request (the project's configured
// db.max_rows, commonly 1000; the nlc-data Edge Function additionally hard-
// clamps any .range() span to 200 — see supabase/functions/nlc-data/index.ts).
// Any "fetch every row" query — e.g. the admin member directory — that
// doesn't paginate silently truncates once real data passes that cap, so
// counts/lists quietly stop growing instead of erroring. buildQuery must be
// a factory that returns a *fresh* query builder each call (chainable
// builders here are single-use), since .range() is appended per page.
async function fetchAllRows(buildQuery, pageSize = 200) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) return { data: rows, error };
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return { data: rows, error: null };
}

function createEmptyOrgStructure(revision = 0) {
  return {
    regions: [],
    zones: {},
    groups: {},
    rawRegions: [],
    rawZones: [],
    rawGroups: [],
    revision
  };
}

/**
 * A plan can be referenced by a global UUID, its current stage key, or its
 * display name. Keep those aliases together so statistics stay plan-specific.
 */
function getPlanFilterAliases(filterValue) {
  if (!filterValue) return [];

  const aliases = new Set([String(filterValue)]);
  const activePlan = state.activePlan || null;
  const activeIdentifiers = activePlan
    ? [activePlan.id, activePlan.globalPlanId, activePlan.presetKey, activePlan.name].filter(Boolean).map(String)
    : [];

  const presetKey = CHURCH_PLAN_PRESETS[filterValue]
    ? String(filterValue)
    : getPresetKeyByName(filterValue);

  const activePresetKey = activePlan
    ? (CHURCH_PLAN_PRESETS[activePlan.presetKey] ? activePlan.presetKey : getPresetKeyByName(activePlan.name))
    : null;
  const matchesActivePlan = activeIdentifiers.includes(String(filterValue))
    || (presetKey && activePresetKey === presetKey);

  if (matchesActivePlan) {
    activeIdentifiers.forEach(value => aliases.add(value));
  }

  const resolvedPresetKey = presetKey || (matchesActivePlan ? activePresetKey : null);
  if (resolvedPresetKey && CHURCH_PLAN_PRESETS[resolvedPresetKey]) {
    aliases.add(resolvedPresetKey);
    aliases.add(CHURCH_PLAN_PRESETS[resolvedPresetKey].name);
  }

  (state.globalPlans || []).forEach(plan => {
    const planIdentifiers = [plan.id, plan.globalPlanId, plan.presetKey, plan.name].filter(Boolean).map(String);
    const planPresetKey = plan.presetKey && CHURCH_PLAN_PRESETS[plan.presetKey]
      ? plan.presetKey
      : getPresetKeyByName(plan.name);
    if (planIdentifiers.some(value => aliases.has(value)) || (resolvedPresetKey && planPresetKey === resolvedPresetKey)) {
      planIdentifiers.forEach(value => aliases.add(value));
    }
  });

  return Array.from(aliases);
}

function mapGlobalPlanRecord(dbPlan) {
  const isCampaignMaster = dbPlan.plan_kind === "church_campaign"
    || dbPlan.id === window.CHURCH_CAMPAIGN_ID;
  const isCampaignStage = dbPlan.plan_kind === "church_campaign_stage";
  let campaignDefinition = null;

  if (isCampaignMaster) {
    const stored = dbPlan.rules && Array.isArray(dbPlan.rules.stages) && Array.isArray(dbPlan.rules.segments)
      ? dbPlan.rules
      : window.CHURCH_CAMPAIGN;
    campaignDefinition = window.cloneChurchCampaign(stored);
  } else if (isCampaignStage) {
    const storedStageNo = Number(dbPlan.rules && dbPlan.rules.stageNo)
      || Number(String(dbPlan.id || "").slice(-12));
    const stored = dbPlan.rules && Array.isArray(dbPlan.rules.stages) && Array.isArray(dbPlan.rules.segments)
      ? dbPlan.rules
      : window.getChurchCampaignStageDefinition(storedStageNo);
    if (stored) campaignDefinition = window.cloneChurchCampaign(stored);
  }

  const campaignBooks = campaignDefinition
    ? Array.from(new Set(campaignDefinition.segments.flatMap(segment => segment.readings.map(reading => reading.book))))
    : [];
  return {
    id: dbPlan.id,
    globalPlanId: dbPlan.id,
    parentCampaignId: campaignDefinition && campaignDefinition.parentCampaignId,
    name: isCampaignMaster ? "教會階段規則設定" : (campaignDefinition ? campaignDefinition.name : dbPlan.name),
    description: campaignDefinition ? campaignDefinition.description : dbPlan.description,
    startDate: campaignDefinition ? campaignDefinition.startDate : dbPlan.start_date,
    endDate: campaignDefinition ? campaignDefinition.endDate : dbPlan.end_date,
    books: Array.isArray(dbPlan.target_books) && dbPlan.target_books.length > 0 ? dbPlan.target_books : campaignBooks,
    presetKey: campaignDefinition && campaignDefinition.presetKey ? campaignDefinition.presetKey : dbPlan.id,
    isHidden: Boolean(dbPlan.is_hidden),
    isFixed: dbPlan.is_fixed !== false,
    is_fixed: dbPlan.is_fixed !== false,
    planKind: isCampaignMaster ? "church_campaign" : (isCampaignStage ? "church_campaign_stage" : (dbPlan.plan_kind || "standard")),
    stageNo: campaignDefinition && Number(campaignDefinition.stageNo),
    roundNo: campaignDefinition && Number(campaignDefinition.roundNo),
    phase: campaignDefinition && campaignDefinition.phase,
    awardName: campaignDefinition && campaignDefinition.awardName,
    examDate: campaignDefinition && campaignDefinition.examDate,
    ruleVersion: Number(dbPlan.rule_version || campaignDefinition && campaignDefinition.version || 1),
    publishedAt: dbPlan.published_at || null,
    campaignDefinition
  };
}

function migrateLocalChurchCampaignToStages(plans, logs) {
  const list = Array.isArray(plans) ? plans : [];
  const legacyPlans = list.filter(plan =>
    plan && (plan.planKind === "church_campaign"
      || plan.presetKey === window.CHURCH_CAMPAIGN_PRESET_KEY
      || plan.id === window.CHURCH_CAMPAIGN_ID
      || plan.globalPlanId === window.CHURCH_CAMPAIGN_ID
      || String(plan.name || "").replace(/[–—]/g, "-").trim() === "2026-2029 新生生命聖經速讀計畫")
  );
  if (legacyPlans.length === 0) return { plans: list, logs: Array.isArray(logs) ? logs : [], migrated: false };

  const sourceDefinition = legacyPlans.find(plan => plan.campaignDefinition && Array.isArray(plan.campaignDefinition.stages));
  const masterDefinition = sourceDefinition ? sourceDefinition.campaignDefinition : window.CHURCH_CAMPAIGN;
  const stages = window.createChurchCampaignStageDefinitions(masterDefinition);
  const legacyIdentifiers = new Set(legacyPlans.flatMap(plan => [plan.id, plan.globalPlanId, plan.presetKey, plan.name]).filter(Boolean).map(String));
  const retainedPlans = list.filter(plan => !legacyPlans.includes(plan));
  const existingStageKeys = new Set(retainedPlans.flatMap(plan => [plan.id, plan.globalPlanId, plan.presetKey]).filter(Boolean).map(String));
  const scheduleSource = legacyPlans[0] || {};

  stages.forEach(stage => {
    if ([stage.id, stage.presetKey].some(key => existingStageKeys.has(String(key)))) return;
    const stagePlan = generatePlanObject(stage.name, stage.startDate, stage.endDate, stage.books, stage.presetKey, "normal", true, {
      readingDaysPerWeek: scheduleSource.readingDaysPerWeek || scheduleSource.reading_days_per_week,
      restWeekdays: scheduleSource.restWeekdays || scheduleSource.rest_weekdays
    });
    stagePlan.id = stage.id;
    stagePlan.globalPlanId = stage.id;
    stagePlan.presetKey = stage.presetKey;
    retainedPlans.push(stagePlan);
  });

  const migratedLogs = (Array.isArray(logs) ? logs : []).map(log => {
    const belongsToLegacy = [log.plan_id, log.presetKey].filter(Boolean).map(String).some(value => legacyIdentifiers.has(value));
    if (!belongsToLegacy) return log;
    const stage = stages.find(item => item.books.includes(log.book));
    return stage ? { ...log, plan_id: stage.id, presetKey: stage.presetKey } : log;
  });

  return { plans: retainedPlans, logs: migratedLogs, migrated: true };
}

function getPlanStorageKey(plan) {
  return String((plan && (plan.id || plan.presetKey || plan.globalPlanId || plan.name)) || "");
}

function getLocalPlanDowngradeLock(plan) {
  try {
    const key = getPlanStorageKey(plan);
    const locks = JSON.parse(localStorage.getItem("plan_downgrade_locks") || "{}");
    return key ? (locks[key] || null) : null;
  } catch (e) {
    return null;
  }
}

function setLocalPlanDowngradeLock(plan, lockedUntil) {
  try {
    const key = getPlanStorageKey(plan);
    if (!key) return;
    const locks = JSON.parse(localStorage.getItem("plan_downgrade_locks") || "{}");
    if (lockedUntil) locks[key] = lockedUntil;
    else delete locks[key];
    localStorage.setItem("plan_downgrade_locks", JSON.stringify(locks));
  } catch (e) {
    console.warn("Failed to persist downgrade lock locally", e);
  }
}

const db = {
  _mergedUsersCache: {},
  _mergedUsersPromise: {},
  _orgStructurePromise: null,
  _orgStructurePromiseKey: "",
  _orgStructureSnapshotKey: "",
  _orgStructureRequestId: 0,

  storeOfflineIdentity(profile = null) {
    if (localStorage.getItem("offline_reading_enabled") === "false") return;
    const sourceProfile = profile || (() => {
      try { return JSON.parse(localStorage.getItem("nlc_supabase_profile") || "null"); } catch { return null; }
    })();
    if (!sourceProfile?.id) return;
    localStorage.setItem("offline_trusted_identity", JSON.stringify({
      schemaVersion: 1,
      verifiedAt: new Date().toISOString(),
      profile: sourceProfile,
      lockedFields: (() => {
        try { return JSON.parse(localStorage.getItem("nlc_profile_locked_fields") || "[]"); } catch { return []; }
      })()
    }));
  },

  tryRestoreOfflineSession() {
    if (localStorage.getItem("offline_reading_enabled") === "false") return false;
    let identity = null;
    try { identity = JSON.parse(localStorage.getItem("offline_trusted_identity") || "null"); } catch { return false; }
    const verifiedAt = Date.parse(identity?.verifiedAt || "");
    const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
    if (!identity?.profile?.id || !Number.isFinite(verifiedAt) || Date.now() - verifiedAt > maxAgeMs) return false;

    state.offlineMode = true;
    state.supabase = this.createNlcDataClient();
    this.applyNlcProfile(identity.profile, identity.lockedFields || []);
    document.documentElement.dataset.appConnection = "offline-reader";
    const statusBadge = document.getElementById("connection-status");
    if (statusBadge) {
      statusBadge.className = "status-badge offline";
      const label = statusBadge.querySelector(".status-text");
      if (label) label.textContent = "離線閱讀";
    }
    this.updateAuthUI({ user: { id: identity.profile.id, offline: true } });
    this.refreshRoleDependentUI();
    return true;
  },

  loadOfflineSnapshot() {
    let identity = null;
    try { identity = JSON.parse(localStorage.getItem("offline_trusted_identity") || "null"); } catch { identity = null; }
    if (identity?.profile) this.applyNlcProfile(identity.profile, identity.lockedFields || []);
    try {
      const plans = JSON.parse(localStorage.getItem("active_reading_plans") || "[]");
      const logs = JSON.parse(localStorage.getItem("reading_logs") || "[]");
      state.activePlans = Array.isArray(plans) ? plans : [];
      state.readingLogs = Array.isArray(logs) ? logs : [];
      state.activePlan = selectMostRecentActivePlan(state.activePlans);
      if (typeof calculateAllPlansProgress === "function") calculateAllPlansProgress();
      this["calculateStreak"]();
    } catch (error) {
      console.warn("Offline reading snapshot could not be restored", error);
      state.activePlans = [];
      state.readingLogs = [];
      state.activePlan = null;
    }
    return true;
  },

  // Initialize Supabase Connection
  async init() {
    const urlParams = new URLSearchParams(window.location.search);
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' ||
                        hostname === '127.0.0.1' ||
                        hostname === '::1' ||
                        hostname.startsWith('192.168.') ||
                        hostname.startsWith('10.') ||
                        hostname.startsWith('172.') ||
                        hostname.endsWith('.local');
    const forceOfflineDemo = false;

    const sbUrl = forceOfflineDemo ? "" : (typeof SUPABASE_CONFIG !== 'undefined' && SUPABASE_CONFIG.url ? SUPABASE_CONFIG.url.trim() : "");
    const sbKey = forceOfflineDemo ? "" : (typeof SUPABASE_CONFIG !== 'undefined' && SUPABASE_CONFIG.anonKey ? SUPABASE_CONFIG.anonKey.trim() : "");
    const statusBadge = document.getElementById("connection-status");
    const authSection = document.getElementById("sb-auth-section");
    const placeholder = document.getElementById("sb-disconnected-placeholder");
    const allowGoogleLogin = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname === "::1";
    const btnGoogleGateEarly = document.getElementById("btn-gate-google-login");
    if (btnGoogleGateEarly) {
      btnGoogleGateEarly.style.display = allowGoogleLogin ? "inline-flex" : "none";
      btnGoogleGateEarly.disabled = !allowGoogleLogin;
      btnGoogleGateEarly.addEventListener("click", async (e) => {
        e.preventDefault();
        if (state.supabase) {
          loader.show("引導至 Google 登入中...");
          try {
            const { error } = await state.supabase.auth.signInWithOAuth({
              provider: 'google',
              options: {
                redirectTo: window.location.origin
              }
            });
            if (error) throw error;
          } catch (err) {
            alert(`Google 登入失敗: ${err.message || err}`);
            loader.hide();
          }
        } else {
          alert("Supabase 尚未初始化！");
        }
      });
    }



    // ── NLC SSO button wiring (always, even before Supabase) ──
    const btnNlcGate = document.getElementById("btn-gate-nlc-login");
    if (btnNlcGate) {
      btnNlcGate.addEventListener("click", (e) => {
        e.preventDefault();
        if (typeof auth !== "undefined" && auth.shouldRepairBeforeLogin?.()) {
          auth.startLoginRepair();
          return;
        }
        const mode = btnNlcGate.dataset.loginGateMode || "sso";
        if (mode === "hub-continue") {
          launchMemberHubContinue(typeof auth !== "undefined" ? auth : null);
          return;
        }
        if (mode === "retry-sync") {
          this.syncNlcSessionWithSupabase(true)
            .catch((err) => {
              console.warn("[LoginOnboardingGate] Retry sync failed:", err);
            })
            .then(() => this.applyLoginOnboardingGate());
          return;
        }
        if (typeof authLaunch !== "undefined" && typeof authLaunch.startInteractiveAuth === "function") {
          authLaunch.startInteractiveAuth({ intent: "login", returnTo: "/" });
        } else if (typeof auth !== "undefined") {
          auth.login();
        } else {
          alert("NLC SSO 模組尚未載入，請重新整理頁面。");
        }
      });
    }
    this.bindLoginGateHubReturnSync();



    const shouldResumeLoginAfterRepair = urlParams.get("resume_login") === "1"
      && sessionStorage.getItem("nlc_login_repair_resume_ready") === "1";
    if (shouldResumeLoginAfterRepair) {
      sessionStorage.removeItem("nlc_login_repair_resume_ready");
      urlParams.delete("resume_login");
      urlParams.delete("repaired");
      urlParams.delete("version");
      const cleanSearch = urlParams.toString();
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + (cleanSearch ? `?${cleanSearch}` : "") + window.location.hash
      );
      if (typeof authLaunch !== "undefined" && typeof authLaunch.startInteractiveAuth === "function") {
        await authLaunch.startInteractiveAuth({ intent: "login", returnTo: "/" });
        return false;
      }
    }
    if (sbUrl && sbKey) {
      try {
        // Initialize Supabase SDK
        state.supabaseConfig = { url: sbUrl, anonKey: sbKey, allowGoogleLogin };
        state.supabase = this.createSupabaseClient();
        state.isSupabaseMode = true;

        // Update Status Badge
        statusBadge.className = "status-badge online";
        statusBadge.querySelector(".status-text").textContent = "線上模式";
        if (placeholder) placeholder.classList.add("hidden");

        if (navigator.onLine === false && this.tryRestoreOfflineSession()) {
          return true;
        }

        const hasOAuthCallback = urlParams.has("code") || urlParams.has("state") || urlParams.has("error") || urlParams.has("error_description");
        if (!hasOAuthCallback && typeof authLaunch !== "undefined" && typeof authLaunch.maybeResumeInteractiveAuthFromBridge === "function") {
          const resumed = await authLaunch.maybeResumeInteractiveAuthFromBridge();
          if (resumed) {
            return false;
          }
        }

        // ── OIDC Callback: Handle Logto redirect ──
        if (typeof auth !== "undefined") {
          const callbackHandled = await auth.handleCallback();
          if (callbackHandled) {
            console.log("Logto OIDC callback handled successfully.");
          }

          // Sync Logto login through the Edge Function so Supabase RLS can resolve profiles.
          if (auth.isLoggedIn()) {
            if (navigator.onLine === false && this.tryRestoreOfflineSession()) {
              return true;
            }
            let sessionSync = null;
            try {
              sessionSync = await this.syncNlcSessionWithSupabase(true);
            } catch (syncErr) {
              console.warn("⚠️ NLC session sync warning:", syncErr);
              if (this.tryRestoreOfflineSession()) return true;
            }
            const block = getUserOnboardingBlock(state.currentUser);
            const copy = getLoginGateCopy(block, { hasTokens: true });
            const loginGate = document.getElementById("login-gate");
            const appLayout = document.querySelector(".app-layout");
            const titleEl = loginGate && loginGate.querySelector(".login-title");
            const subtitleEl = document.getElementById("login-gate-subtitle");
            const buttonEl = document.getElementById("btn-gate-nlc-login");
            if (copy.enterApp) {
              const userId = state.currentProfileId || (typeof auth.getLogtoSubject === "function" ? auth.getLogtoSubject() : null);
              this.updateAuthUI({ user: { id: userId || "authenticated-user" } });
              this.refreshRoleDependentUI();
              return Boolean(userId || (sessionSync && sessionSync.edge_session));
            }
            applyLoginGateView({
              block,
              hasTokens: true,
              loginGate,
              appLayout,
              titleEl,
              subtitleEl,
              buttonEl
            });
            if (buttonEl) buttonEl.dataset.loginGateMode = copy.mode;
            return false;
          }
        }

        // Fallback: Standard Supabase email/Google session
        const { data: { session } } = await state.supabase.auth.getSession();
        this.updateAuthUI(session);

        // Setup session listener
        state.supabase.auth.onAuthStateChange(async (event, session) => {
          try {
            console.log("Auth state changed:", event, !!session);
            this.updateAuthUI(session);
            await this.loadUserData();
            if (typeof updateAdminNavVisibility === 'function') updateAdminNavVisibility();

            if (appRouter.currentTab === "dashboard-view") {
              if (typeof updateDashboardView === 'function') updateDashboardView();
            } else if (appRouter.currentTab === "plan-view") {
              if (typeof window.renderPlanView === 'function') window.renderPlanView();
            } else if (appRouter.currentTab === "profile-view") {
              if (typeof renderProfileView === 'function') renderProfileView();
            } else if (appRouter.currentTab === "stats-view") {
              if (typeof window.updateStatsView === 'function') window.updateStatsView();
            }
          } catch (err) {
            console.error("Error in onAuthStateChange callback:", err);
          }
        });
        return false;
      } catch (e) {
        console.error("Supabase connection failed:", e);
        if (this.tryRestoreOfflineSession()) return true;
        const message = "\u767b\u5165\u540c\u6b65\u5931\u6557\uFF08" + (e.message || e) + "\uFF09\uFF0C\u8acb\u91cd\u65b0\u767b\u5165\u3002";
        this.showConnectionError(message);
        return false;
      }
    } else {
      if (forceOfflineDemo) {
        this.setDemoMode();
        this.updateAuthUI(null);
      } else {
        console.error("Supabase config is missing or invalid!");
        this.showConnectionError();
      }
      return false;
    }
  },

  createSupabaseClient(externalJwt = null) {
    const cfg = state.supabaseConfig || {};
    const options = {
      auth: {
        detectSessionInUrl: !!cfg.allowGoogleLogin,
        persistSession: !!cfg.allowGoogleLogin,
        autoRefreshToken: !!cfg.allowGoogleLogin
      }
    };

    if (externalJwt) {
      options.accessToken = async () => externalJwt;
      options.global = {
        headers: {
          Authorization: "Bearer " + externalJwt
        }
      };
      options.auth.persistSession = false;
      options.auth.autoRefreshToken = false;
      options.auth.detectSessionInUrl = false;
      options.auth.storageKey = "nlc-external-supabase-session";
    }

    return supabase.createClient(cfg.url, cfg.anonKey, options);
  },

  createNlcDataClient() {
    const cfg = state.supabaseConfig || {};
    const callEdge = async (request) => {
      if (typeof auth === "undefined") throw new Error("NLC auth client is missing.");
      const send = async (forceRefresh = false) => {
        const accessToken = await auth.getValidAccessToken(forceRefresh);
        const startedAt = performance.now();
        const response = await fetch(cfg.url.replace(/\/+$/, "") + "/functions/v1/nlc-data", {
          method: "POST",
          headers: {
            apikey: cfg.anonKey,
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(request)
        });
        const headersAt = performance.now();
        const payload = await response.json().catch(() => ({}));
        const completedAt = performance.now();
        networkMetrics.record({
          name: `${request.action || "select"}:${request.table || request.function || "unknown"}`,
          status: response.status,
          ttfbMs: headersAt - startedAt,
          totalMs: completedAt - startedAt,
          payloadBytes: getResponsePayloadBytes(response)
        });
        return { response, payload };
      };

      let { response, payload } = await send(false);
      const tokenRejected = response.status === 401
        || payload?.error === "invalid_logto_token"
        || payload?.error === "invalid_token"
        || payload?.message === "invalid_logto_token"
        || payload?.message === "invalid_token"
        || payload?.message?.includes("invalid_token")
        || payload?.message?.includes("Invalid token");
      if (tokenRejected) {
        ({ response, payload } = await send(true));
      }

      // ── 503 / Edge Runtime 暫時中斷：指数退避重試（最多 3 次）──
      const mayRetry = !request.action || request.action === "select";
      const isServiceDegraded = mayRetry && !tokenRejected && (
        response.status === 503 ||
        payload?.code === "SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED" ||
        (response.status >= 500 && response.status < 600)
      );

      if (isServiceDegraded) {
        const MAX_RETRIES = 2;
        const RETRY_DELAYS_MS = [400, 1200];
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          const delayMs = RETRY_DELAYS_MS[attempt] ?? 1200;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          try {
            ({ response, payload } = await send(false));
            // 重試成功，離開迴圈
            if (response.ok) break;
            // 如果還是 5xx，繼續重試
            const stillDegraded =
              response.status === 503 ||
              payload?.code === "SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED" ||
              (response.status >= 500 && response.status < 600);
            if (!stillDegraded) break;
          } catch (_retryErr) {
            // 網路錯誤，繼續等候下一次重試
          }
        }
      }

      if (!response.ok) return { data: null, error: payload };
      if (payload.profile) this.applyNlcProfile(payload.profile, payload.locked_fields || null);
      return {
        data: payload.data,
        error: null,
        profile: payload.profile || null,
        profile_id: payload.profile_id || null,
        project_url: payload.project_url || null,
        locked_fields: payload.locked_fields || null
      };
    };

    class NlcQueryBuilder {
      constructor(table) {
        this.request = { table, action: null, filters: [] };
      }
      select(columns = "*") {
        if (!this.request.action) this.request.action = "select";
        this.request.select = columns;
        return this;
      }
      insert(payload) {
        this.request.action = "insert";
        this.request.payload = payload;
        return this;
      }
      update(payload) {
        this.request.action = "update";
        this.request.payload = payload;
        return this;
      }
      delete() {
        this.request.action = "delete";
        return this;
      }
      upsert(payload, options) {
        this.request.action = "upsert";
        this.request.payload = payload;
        this.request.options = options || null;
        return this;
      }
      eq(column, value) {
        this.request.filters.push({ type: "eq", column, value });
        return this;
      }
      is(column, value) {
        this.request.filters.push({ type: "is", column, value });
        return this;
      }
      in(column, value) {
        this.request.filters.push({ type: "in", column, value });
        return this;
      }
      or(expression) {
        this.request.or = expression;
        return this;
      }
      order(column, options = {}) {
        this.request.order = { column, ascending: options.ascending !== false };
        return this;
      }
      limit(count) {
        this.request.limit = count;
        return this;
      }
      range(from, to) {
        this.request.range = { from, to };
        return this;
      }
      single() {
        this.request.returning = "single";
        return this;
      }
      maybeSingle() {
        this.request.returning = "maybeSingle";
        return this;
      }
      async execute() {
        if (!this.request.action) this.request.action = "select";
        return callEdge(this.request);
      }
      then(resolve, reject) {
        return this.execute().then(resolve, reject);
      }
    }

    return {
      async saveProfile(payload) {
        return callEdge({ action: "save_profile", payload });
      },
      from(table) {
        return new NlcQueryBuilder(table);
      },
      rpc(functionName, args = {}) {
        return {
          execute: () => callEdge({ action: "rpc", function: functionName, args }),
          then(resolve, reject) {
            return this.execute().then(resolve, reject);
          }
        };
      },
      auth: {
        async getUser() {
          return { data: { user: state.currentProfileId ? { id: state.currentProfileId, oidc: true } : null }, error: null };
        },
        async getSession() {
          return { data: { session: auth && auth.isLoggedIn() ? { user: { id: state.currentProfileId } } : null }, error: null };
        },
        onAuthStateChange() {
          return { data: { subscription: { unsubscribe() {} } } };
        }
      }
    };
  },

  applyNlcProfile(profile, lockedFields = null) {
    if (!profile) return;
    state.currentProfileId = profile.id;
    state.currentUser.id = profile.id;
    state.currentUser.name = (typeof getDisplayName === "function"
      ? getDisplayName(profile)
      : String(profile.name || "").trim()) ||
      (typeof getDisplayName === "function"
        ? getDisplayName(state.currentUser)
        : String(state.currentUser.name || "").trim()) ||
      "";
    state.currentUser.great_region = profile.great_region || "";
    state.currentUser.pastoral_zone = profile.pastoral_zone || "";
    state.currentUser.small_group = profile.small_group || "";
    const roleCode = profile.role_definition?.code || (typeof getRoleDefinition === "function" ? getRoleDefinition(profile.role_id)?.code : "") || "";
    state.currentUser.managed_regions = profile.managed_regions || (roleCode === "great_zone_leader" ? (profile.great_region || "") : "");
    state.currentUser.managed_zones = profile.managed_zones || (roleCode === "zone_leader" ? (profile.pastoral_zone || "") : "");
    state.currentUser.managed_groups = profile.managed_groups || (roleCode === "group_leader" ? (profile.small_group || "") : "");
    state.currentUser.role_id = profile.role_id || "10000000-0000-4000-8000-000000000001";
    state.currentUser.role_definition = profile.role_definition || getRoleDefinition(state.currentUser.role_id);
    if (profile.email) state.currentUser.email = profile.email;
    if (profile.membership_status) state.membershipStatus = profile.membership_status;
    state.currentUser.member_context_synced_at = profile.member_context_synced_at || "";
    state.currentUser.member_context_sync_attempted_at = profile.member_context_sync_attempted_at || "";
    state.currentUser.member_context_sync_status = profile.member_context_sync_status || "";
    state.currentUser.member_context_sync_error = profile.member_context_sync_error || "";
    state.currentUser.member_context_contract_version = profile.member_context_contract_version || "";
    state.currentUser.member_context_membership_lifecycle_state = profile.member_context_membership_lifecycle_state || "";
    state.currentUser.member_context_placement_state = profile.member_context_placement_state || "";
    state.currentUser.member_context_placement_workflow_state = profile.member_context_placement_workflow_state || "";
    state.currentUser.member_context_has_required_placement = profile.member_context_has_required_placement || "";
    state.currentUser.member_context_required_action = profile.member_context_required_action || "";
    state.currentUser.member_context_required_action_url = profile.member_context_required_action_url || "";
    state.currentUser.member_context_leadership_display_label = profile.member_context_leadership_display_label || "";
    state.currentUser.member_context_leadership_primary_assignment_id = profile.member_context_leadership_primary_assignment_id || "";
    state.currentUser.member_context_leadership_assignments = Array.isArray(profile.member_context_leadership_assignments)
      ? profile.member_context_leadership_assignments
      : [];
    state.currentUser.name_review_approved = profile.name_review_approved === true;
    if (profile.avatar_url) state.currentUser.avatar_url = profile.avatar_url;
    if (Array.isArray(lockedFields)) state.profileLockedFields = lockedFields;
    state.currentUser.is_demo = false;

    this.refreshRoleDependentUI();
  },

  refreshRoleDependentUI() {
    if (typeof updateAdminNavVisibility === "function") {
      updateAdminNavVisibility();
    }
    if (typeof updateHeaderAvatar === "function") {
      updateHeaderAvatar();
    }
    if (typeof refreshUserAvatars === "function") {
      refreshUserAvatars();
    }
  },

  async syncNlcSessionWithSupabase(force = false) {
    if (typeof auth === "undefined" || !auth.isLoggedIn()) return null;

    const cachedExpiresAt = Number(localStorage.getItem("nlc_edge_session_expires_at") || "0");
    const cachedProfile = localStorage.getItem("nlc_supabase_profile");
    if (!force && cachedExpiresAt > Date.now() + 60000) {
      state.supabase = this.createNlcDataClient();
      const cachedLockedFields = JSON.parse(localStorage.getItem("nlc_profile_locked_fields") || "[]");
      if (cachedProfile) this.applyNlcProfile(JSON.parse(cachedProfile), cachedLockedFields);
      return { edge_session: true, profile: cachedProfile ? JSON.parse(cachedProfile) : null, locked_fields: cachedLockedFields };
    }

    const accessToken = await auth.getValidAccessToken(force);
    const idToken = localStorage.getItem(auth.keys.idToken);

    const cfg = state.supabaseConfig || {};
    const functionUrl = cfg.url.replace(/\/+$/, "") + "/functions/v1/nlc-session";
    const response = await fetch(functionUrl, {
      method: "POST",
      headers: {
        apikey: cfg.anonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        access_token: accessToken,
        id_token: idToken
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.edge_session) {
      console.error("❌ NLC Session Sync Failed Payload:", payload);
      // Special case: the server detected a known sub but couldn't resolve the profile.
      // This typically means the Logto sub changed between devices or tokens are mismatched.
      // Show a specific error and prompt re-login instead of crashing.
      if (response.status === 409 && payload.error === "profile_resolution_failed") {
        const msg = payload.message || "帳號資料暫時無法讀取，請重新登入。";
        this.showConnectionError(msg);
        throw new Error(msg);
      }
      throw new Error(payload.message || payload.error || "NLC session sync failed: " + response.status);
    }


    localStorage.removeItem("nlc_supabase_access_token");
    localStorage.removeItem("nlc_supabase_expires_at");
    localStorage.setItem("nlc_edge_session_expires_at", String(Date.now() + 10 * 60 * 1000));
    if (payload.profile) {
      if (payload.membership_status) {
        payload.profile.membership_status = payload.membership_status;
      }
      localStorage.setItem("nlc_supabase_profile", JSON.stringify(payload.profile));
    }
    localStorage.setItem("nlc_profile_locked_fields", JSON.stringify(payload.locked_fields || []));

    state.supabase = this.createNlcDataClient();
    state.offlineMode = false;
    document.documentElement.dataset.appConnection = "online";
    this.applyNlcProfile(payload.profile, payload.locked_fields || []);
    this.storeOfflineIdentity(payload.profile);
    return payload;
  },

  async getCurrentDbUser() {
    if (typeof auth !== "undefined" && auth.isLoggedIn()) {
      await this.syncNlcSessionWithSupabase();
      if (state.currentProfileId) return { id: state.currentProfileId, oidc: true };
    }

    const { data: { user } } = await state.supabase.auth.getUser();
    return user;
  },

  showConnectionError(message = "\u767b\u5165\u540c\u6b65\u5931\u6557\uff0c\u8acb\u91cd\u65b0\u767b\u5165\u3002") {
    state.isSupabaseMode = true;

    const btnNlcGate = document.getElementById("btn-gate-nlc-login");
    if (btnNlcGate) {
      btnNlcGate.disabled = false;
      btnNlcGate.style.opacity = "1";
      btnNlcGate.style.cursor = "pointer";
      btnNlcGate.textContent = "\u4fee\u5fa9\u4e26\u91cd\u65b0\u767b\u5165";
    }

    const btnGoogleGate = document.getElementById("btn-gate-google-login");
    if (btnGoogleGate) {
      btnGoogleGate.disabled = true;
      btnGoogleGate.style.opacity = "0.5";
      btnGoogleGate.style.cursor = "not-allowed";
    }

    const gateDot = document.getElementById("gate-status-dot");
    const gateText = document.getElementById("gate-status-text");
    if (gateDot && gateText) {
      gateDot.style.backgroundColor = "var(--color-danger)";
      gateText.textContent = message;
    }
    if (typeof auth !== "undefined" && typeof auth.markLoginFailure === "function") {
      auth.markLoginFailure();
    }

    const loginGate = document.getElementById("login-gate");
    const appLayout = document.querySelector(".app-layout");
    if (loginGate) loginGate.classList.remove("hidden");
    if (appLayout) appLayout.classList.add("hidden");
  },

  applyLoginOnboardingGate() {
    const hasTokens = typeof auth !== "undefined" && typeof auth.isLoggedIn === "function" && auth.isLoggedIn();
    const block = hasTokens ? getUserOnboardingBlock(state.currentUser) : null;
    const copy = getLoginGateCopy(block, { hasTokens });
    const loginGate = document.getElementById("login-gate");
    const appLayout = document.querySelector(".app-layout");
    const titleEl = loginGate && loginGate.querySelector(".login-title");
    const subtitleEl = document.getElementById("login-gate-subtitle");
    const buttonEl = document.getElementById("btn-gate-nlc-login");
    if (copy.enterApp) {
      const userId = state.currentProfileId
        || (typeof auth !== "undefined" && typeof auth.getLogtoSubject === "function" ? auth.getLogtoSubject() : null);
      this.updateAuthUI({ user: { id: userId || "authenticated-user" } });
      this.refreshRoleDependentUI();
      return copy;
    }
    applyLoginGateView({
      block,
      hasTokens,
      loginGate,
      appLayout,
      titleEl,
      subtitleEl,
      buttonEl
    });
    if (buttonEl) buttonEl.dataset.loginGateMode = copy.mode;
    return copy;
  },

  bindLoginGateHubReturnSync() {
    if (this._loginGateHubReturnBound || typeof document === "undefined") return;
    this._loginGateHubReturnBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const loginGate = document.getElementById("login-gate");
      if (!loginGate || loginGate.classList.contains("hidden")) return;
      if (typeof auth === "undefined" || typeof auth.isLoggedIn !== "function" || !auth.isLoggedIn()) return;
      this.syncNlcSessionWithSupabase(true).then(() => {
        this.applyLoginOnboardingGate();
      }).catch((err) => {
        console.warn("[LoginOnboardingGate] Profile sync after Hub return failed:", err);
        this.applyLoginOnboardingGate();
      });
    });
  },

  // Handle Supabase Auth UI Switches
  updateAuthUI(session) {
    const loginGate = document.getElementById("login-gate");
    const appLayout = document.querySelector(".app-layout");

    const isLoggedIn = !!(session && session.user);

    if (isLoggedIn) {
      // Online mode: Hide login gate, show app container
      if (state.isSupabaseMode) {
        if (loginGate) loginGate.classList.add("hidden");
        if (appLayout) appLayout.classList.remove("hidden");
      }
    } else {
      // Online mode: Show login gate, hide app container
      if (state.isSupabaseMode) {
        applyLoginGateView({
          block: null,
          hasTokens: false,
          loginGate,
          appLayout,
          titleEl: loginGate && loginGate.querySelector(".login-title"),
          subtitleEl: document.getElementById("login-gate-subtitle"),
          buttonEl: document.getElementById("btn-gate-nlc-login")
        });
      } else {
        // Demo mode: Ensure login gate is hidden and app is visible
        if (loginGate) loginGate.classList.add("hidden");
        if (appLayout) appLayout.classList.remove("hidden");
      }
    }

    if (typeof updateHeaderAvatar === 'function') {
      updateHeaderAvatar();
    }
  },

  // Load User Data (either Supabase or LocalStorage fallbacks)
  _userDataPromise: null,
  applyReadingLogsSnapshot(rawLogs, { notify = false, source = "initial" } = {}) {
    const uniqueMap = {};
    (rawLogs || []).forEach(log => {
      const round = log.round || 1;
      const planKey = log.plan_id || "";
      const key = `${log.book}_${log.chapter}_${planKey}_${round}`;
      if (!uniqueMap[key] || new Date(log.read_at) > new Date(uniqueMap[key].read_at)) uniqueMap[key] = log;
    });
    state.readingLogs = Object.values(uniqueMap);
    if (state.currentUser) state.currentUser.chapters_read = state.readingLogs.length;
    if (notify) {
      window.dispatchEvent(new CustomEvent("app:dataRefresh", {
        detail: { scope: "plan", source: `repository-${source}` }
      }));
    }
    return state.readingLogs;
  },

  async loadUserData(force = false) {
    if (force) {
      this._userDataPromise = null;
    }
    if (this._userDataPromise) {
      return this._userDataPromise;
    }
    this._userDataPromise = (async () => {
      try {
        if (state.offlineMode) {
          return this.loadOfflineSnapshot();
        }
        if (state.isSupabaseMode && state.supabase) {
      if (state.currentUser) {
        state.currentUser.is_demo = false;
      }

      let user = null;
      const isOidcMode = typeof auth !== "undefined" && auth.isLoggedIn();
      if (isOidcMode) {
        // 💡 效能優化：不要重複強制同步（force=false），直接使用 db.init() 剛拿到的最新快取
        await this.syncNlcSessionWithSupabase(false);
        user = state.currentProfileId ? { id: state.currentProfileId, oidc: true } : null;
      }

      if (!user) {
        user = await this.getCurrentDbUser();
      }

      if (user) {
        // 💡 效能優化：平行化載入 global_plans, profiles, reading_logs, reading_plans
        // 避開多個 sequential 網路請求產生的累積延遲與 cold start 問題！
        const [globalPlansResult, profileResult, logsResult, plansResult] = await Promise.all([
          state.supabase.from("global_plans").select("id, name, description, start_date, end_date, target_books, is_hidden, is_fixed, plan_kind, rules, rule_version, published_at").order("start_date", { ascending: true }),
          state.supabase.from("profiles").select("id, name, email, avatar_url, great_region, pastoral_zone, small_group, role_id, is_demo, is_active, name_review_approved, managed_regions, managed_zones, managed_groups, member_context_synced_at, member_context_sync_attempted_at, member_context_sync_status, member_context_sync_error, member_context_leadership_display_label, member_context_leadership_primary_assignment_id, member_context_leadership_assignments, role_definition:role_definitions!profiles_role_definition_fkey(id, code, label, sort_order, is_assignable, can_manage_plans, can_manage_permissions, scope_type)").eq("id", user.id).maybeSingle(),
          window.readingLogRepository
            ? window.readingLogRepository.fetch({
              cacheKey: `reading_logs:${user.id}`,
              query: table => table.select("book, chapter, read_at, plan_id, round").eq("user_id", user.id),
              onData: (rows, meta) => this.applyReadingLogsSnapshot(rows, { notify: true, source: meta.source })
            })
            : state.supabase.from("reading_logs").select("book, chapter, read_at, plan_id, round").eq("user_id", user.id),
          state.supabase.from("reading_plans").select("id, user_id, global_plan_id, name, start_date, end_date, target_books, preset_key, level, current_round, was_downgraded, downgrade_locked_until, upgrade_prompt_handled, is_fixed, reading_days_per_week, rest_weekdays, created_at").eq("user_id", user.id).order("created_at", { ascending: false })
        ]);

        if (globalPlansResult.error) console.error("❌ global_plans load failed:", globalPlansResult.error);
        if (profileResult.error) console.error("❌ profile load failed:", profileResult.error);
        if (logsResult.error) console.error("❌ reading_logs load failed:", logsResult.error);
        if (plansResult.error) console.error("❌ reading_plans load failed:", plansResult.error);
        const initialDataLoadSucceeded = ![
          globalPlansResult,
          profileResult,
          logsResult,
          plansResult
        ].some(result => result.error);

        // 處理 global_plans
        if (globalPlansResult.data) {
          state.globalPlans = globalPlansResult.data.map(mapGlobalPlanRecord);
        } else {
          state.globalPlans = [];
        }

        // 1. Load / sync profile
        if (!user.oidc) {
          // Standard Supabase auth: load profile from our profiles table
          const profile = profileResult.data;
          if (profile) {
            state.currentUser.name = profile.name;
            state.currentUser.great_region = profile.great_region;
            state.currentUser.pastoral_zone = profile.pastoral_zone;
            state.currentUser.small_group = profile.small_group;
            state.currentUser.role_id = profile.role_id || "10000000-0000-4000-8000-000000000001";
            state.currentUser.role_definition = profile.role_definition || getRoleDefinition(state.currentUser.role_id);
            state.currentUser.is_demo = !!profile.is_demo;
            state.currentUser.name_review_approved = profile.name_review_approved === true;

          } else {
            // First-time login: create profile without local org placement (Hub-owned).
            state.currentUser.name = (typeof getDisplayName === "function"
              ? getDisplayName(user.user_metadata && user.user_metadata.full_name)
              : String((user.user_metadata && user.user_metadata.full_name) || "").trim()) || "";
            state.currentUser.great_region = "";
            state.currentUser.pastoral_zone = "";
            state.currentUser.small_group = "";
            state.currentUser.role_id = "10000000-0000-4000-8000-000000000001";
            state.currentUser.role_definition = getRoleDefinition(state.currentUser.role_id);
            state.currentUser.is_demo = false;
            state.currentUser.name_review_approved = false;


            try {
              await state.supabase.from("profiles").insert({
                id: user.id,
                name: state.currentUser.name || null,
                great_region: "",
                pastoral_zone: "",
                small_group: "",
                role_id: state.currentUser.role_id
              });
            } catch (dbErr) {
              console.error("Failed to auto-create user profile in Supabase:", dbErr);
            }
          }
        } else {
          // OIDC profiles are created and updated by the nlc-session Edge Function.
          const profile = profileResult.data;
          const localSyncedAt = state.currentUser.member_context_synced_at || "";
          const remoteSyncedAt = profile?.member_context_synced_at || "";
          if (profile && (!localSyncedAt || (remoteSyncedAt && remoteSyncedAt >= localSyncedAt))) {
            this.applyNlcProfile(profile);
          }
          state.currentUser.is_demo = false;
        }

        // 2. Load Reading Logs
        const rawLogs = logsResult.data || [];
        this.applyReadingLogsSnapshot(rawLogs);

        // 3. Load Active Reading Plans
        const plans = plansResult.data || [];
        state.activePlans = [];
        if (plans && plans.length > 0) {
          const visibleGlobalPlanKeys = new Set((state.globalPlans || []).flatMap(plan =>
            [plan.id, plan.globalPlanId, plan.presetKey].filter(Boolean).map(String)
          ));
          const canViewHiddenStages = typeof canManageHiddenPlans === "function" && canManageHiddenPlans();

          plans.forEach(dbPlan => {
            try {
              const globalPlanId = dbPlan.global_plan_id || null;
              const key = dbPlan.preset_key
                || (globalPlanId ? globalPlanId : null)
                || getPresetKeyByName(dbPlan.name);
              const presetStageMatch = String(dbPlan.preset_key || "").match(/^church_stage_(\d{2})$/);
              const idStageMatch = String(globalPlanId || "").match(/^00000000-0000-0000-c026-(\d{12})$/);
              const campaignStageNo = Number(presetStageMatch && presetStageMatch[1]
                || idStageMatch && idStageMatch[1]
                || 0);
              const enrollmentKeys = [globalPlanId, dbPlan.preset_key].filter(Boolean).map(String);
              const hasVisibleStageDefinition = enrollmentKeys.some(item => visibleGlobalPlanKeys.has(item));
              if (!canViewHiddenStages
                && campaignStageNo >= 2
                && campaignStageNo <= 10
                && !hasVisibleStageDefinition) {
                return;
              }

              const isFixed = dbPlan.is_fixed !== false;
              const storedRound = Number(dbPlan.current_round || 1);
              const planLogs = rawLogs.filter(log => log.plan_id === dbPlan.id);
              const confirmedRound = getConfirmedReadingRound({
                currentRound: storedRound,
                upgradePromptHandled: dbPlan.upgrade_prompt_handled,
                logs: planLogs
              });
              const effectiveLevel = confirmedRound === storedRound ? (dbPlan.level || 'normal') : 'normal';
              const planObj = generatePlanObject(dbPlan.name, dbPlan.start_date, dbPlan.end_date, dbPlan.target_books, key, effectiveLevel, isFixed, {
                readingDaysPerWeek: dbPlan.reading_days_per_week,
                restWeekdays: dbPlan.rest_weekdays,
                planId: dbPlan.id,
                presetKey: key
              });
              planObj.id = dbPlan.id;
              planObj.globalPlanId = globalPlanId;  // ⚠️ UUID 關聯
              planObj.isFixed = isFixed;
              planObj.is_fixed = isFixed;
              const linkedGlobalPlan = (state.globalPlans || []).find(p => p.id === globalPlanId || p.presetKey === key || p.name === dbPlan.name);
              planObj.isHidden = Boolean(linkedGlobalPlan && (linkedGlobalPlan.isHidden || linkedGlobalPlan.is_hidden));
              planObj.level = effectiveLevel;
              planObj.currentRound = confirmedRound;
              planObj.wasDowngraded = dbPlan.was_downgraded || false;
              planObj.downgradeLockedUntil = dbPlan.downgrade_locked_until || getLocalPlanDowngradeLock(planObj);
              planObj.upgradePromptHandled = !!dbPlan.upgrade_prompt_handled;
              state.activePlans.push(planObj);
            } catch (err) {
              console.error("Failed to parse dbPlan:", dbPlan, err);
            }
          });

          state.activePlan = selectMostRecentActivePlan(state.activePlans);
          calculateAllPlansProgress();
        } else {
          state.activePlan = null;
          state.activePlans = [];
        }


        this.calculateStreak();
        if (typeof checkAchievements !== 'undefined') {
          await checkAchievements(true);
        }
        if (typeof updateAdminNavVisibility === 'function') {
          updateAdminNavVisibility();
        }

        // 💡 0秒秒開效能優化：儲存首屏 Profiles 本地快照
        try {
          if (state.currentUser && state.currentUser.name) {
            localStorage.setItem("cached_user_profile", JSON.stringify({
              name: state.currentUser.name,
              great_region: state.currentUser.great_region,
              pastoral_zone: state.currentUser.pastoral_zone,
              small_group: state.currentUser.small_group,
              role_id: state.currentUser.role_id,
              role_definition: state.currentUser.role_definition
            }));
          }
        } catch (e) {
          console.warn("Failed to write fast startup cache:", e);
        }

        return initialDataLoadSucceeded;
      } else {
        // Online mode but not logged in: clear state and return early
        state.currentUser = {
          name: "",
          great_region: "",
          pastoral_zone: "",
          small_group: "",
          role_id: "10000000-0000-4000-8000-000000000001",
          role_definition: getRoleDefinition("10000000-0000-4000-8000-000000000001"),
          chapters_read: 0,
          plan_progress: 0,
          streak: 0,
          last_read: null,
          member_context_synced_at: "",
          member_context_sync_attempted_at: "",
          member_context_sync_status: "",
          member_context_sync_error: ""
        };
        state.readingLogs = [];
        state.activePlans = [];
        state.activePlan = null;
        if (typeof updateAdminNavVisibility === 'function') {
          updateAdminNavVisibility();
        }
        return false;
      }
    }

    // FALLBACK: LocalStorage mode
    await this.loadGlobalPlans();
    const localProfile = localStorage.getItem("user_profile");
    if (localProfile) {
      state.currentUser = JSON.parse(localProfile);
      state.currentUser.member_context_synced_at = state.currentUser.member_context_synced_at || "";
      state.currentUser.member_context_sync_attempted_at = state.currentUser.member_context_sync_attempted_at || "";
      state.currentUser.member_context_sync_status = state.currentUser.member_context_sync_status || "";
      state.currentUser.member_context_sync_error = state.currentUser.member_context_sync_error || "";

      const localLogsStr = localStorage.getItem("reading_logs");
      const rawLocalLogs = localLogsStr ? JSON.parse(localLogsStr) : [];
      const uniqueLocalMap = {};
      rawLocalLogs.forEach(l => {
        const r = l.round || 1;
        const planKey = l.plan_id || l.presetKey || '';
        const key = `${l.book}_${l.chapter}_${planKey}_${r}`;
        if (!uniqueLocalMap[key] || new Date(l.read_at) > new Date(uniqueLocalMap[key].read_at)) {
          uniqueLocalMap[key] = l;
        }
      });
      state.readingLogs = Object.values(uniqueLocalMap);
      state.currentUser.chapters_read = state.readingLogs.length;

      const localPlans = localStorage.getItem("active_reading_plans");
      if (localPlans) {
        state.activePlans = JSON.parse(localPlans);
        const localCampaignMigration = migrateLocalChurchCampaignToStages(state.activePlans, state.readingLogs);
        state.activePlans = localCampaignMigration.plans;
        if (localCampaignMigration.migrated) {
          state.readingLogs = localCampaignMigration.logs;
          safeStorageSet("reading_logs", state.readingLogs, 500);
        }
        state.activePlans.forEach(plan => {
          if (!plan.presetKey) {
            plan.presetKey = getPresetKeyByName(plan.name);
          }
          // Self-heal legacy timezone-offsetted dates and missing year/month properties
          if (plan.presetKey && plan.days && plan.days.length > 0) {
            const isMissingProperties = !plan.days[0].year || !plan.days[0].month;
            if (isMissingProperties && typeof generatePlanObject === 'function') {
              const preset = CHURCH_PLAN_PRESETS[plan.presetKey];
              if (preset) {
                const freshPlan = generatePlanObject(plan.name, plan.startDate, plan.endDate, plan.target_books || preset.books, plan.presetKey, plan.level || 'normal');
                const readKeys = new Set();
                plan.days.forEach(d => {
                  if (d.chapters) {
                    d.chapters.forEach(c => {
                      if (c.isRead) readKeys.add(c.key);
                    });
                  }
                });
                freshPlan.days.forEach(d => {
                  if (d.chapters) {
                    d.chapters.forEach(c => {
                      if (readKeys.has(c.key)) c.isRead = true;
                    });
                  }
                });
                freshPlan.id = plan.id;
                freshPlan.progress = plan.progress;
                freshPlan.completedChapters = plan.completedChapters;
                freshPlan.currentRound = plan.currentRound;
                freshPlan.level = plan.level;
                freshPlan.wasDowngraded = plan.wasDowngraded;
                freshPlan.downgradeLockedUntil = plan.downgradeLockedUntil || getLocalPlanDowngradeLock(plan);
                freshPlan.upgradePromptHandled = !!plan.upgradePromptHandled;
                Object.assign(plan, freshPlan);
              }
            }
          }
        });
        safeStorageSet("active_reading_plans", state.activePlans, 500);
        calculateAllPlansProgress();

        state.activePlan = selectMostRecentActivePlan(state.activePlans);
      } else {
        state.activePlans = [];
        state.activePlan = null;
      }
    } else {
      // First run: default to empty guest profile (no invented display name)
      state.currentUser = {
        name: "",
        great_region: "",
        pastoral_zone: "",
        small_group: "",
        role_id: "10000000-0000-4000-8000-000000000001",
        role_definition: getRoleDefinition("10000000-0000-4000-8000-000000000001"),
        is_demo: false,
        chapters_read: 0,
        plan_progress: 0,
        streak: 0,
        last_read: null,
        member_context_synced_at: "",
        member_context_sync_attempted_at: "",
        member_context_sync_status: "",
        member_context_sync_error: ""
      };
      localStorage.setItem("user_profile", JSON.stringify(state.currentUser));

      state.activePlans = [];
      state.activePlan = null;
      state.readingLogs = [];
      localStorage.setItem("active_reading_plans", "[]");
      localStorage.setItem("reading_logs", "[]");
    }

        this.calculateStreak();
        if (typeof checkAchievements !== 'undefined') {
          await checkAchievements(true);
        }
        if (typeof updateAdminNavVisibility === 'function') {
          updateAdminNavVisibility();
        }
        return false;
      } finally {
        this._userDataPromise = null;
      }
    })();
    return this._userDataPromise;
  },

  // Load Church Organization Structure (from Supabase or Local Mock)
  ensureCurrentUserOrgStructure(orgStructure = state.orgStructure) {
    const user = state.currentUser || {};
    const region = user.great_region || "";
    const zone = user.pastoral_zone || "";
    const group = user.small_group || "";

    if (!orgStructure.regions) orgStructure.regions = [];
    if (!orgStructure.zones) orgStructure.zones = {};
    if (!orgStructure.groups) orgStructure.groups = {};

    if (region && !orgStructure.regions.includes(region)) {
      orgStructure.regions.push(region);
    }
    if (region && zone) {
      if (!orgStructure.zones[region]) orgStructure.zones[region] = [];
      if (!orgStructure.zones[region].includes(zone)) orgStructure.zones[region].push(zone);
    }
    if (zone && group) {
      if (!orgStructure.groups[zone]) orgStructure.groups[zone] = [];
      if (!orgStructure.groups[zone].includes(group)) orgStructure.groups[zone].push(group);
    }
  },

  getOrgStructureOwnerKey() {
    const user = state.currentUser || {};
    const role = (typeof getUserRoleCode === "function" && getUserRoleCode(user))
      || user.role_definition?.code
      || user.role
      || "member";
    return [
      state.isSupabaseMode ? "supabase" : "local",
      user.id || state.currentProfileId || user.email || "anonymous",
      role,
      user.managed_regions || "",
      user.managed_zones || "",
      user.managed_groups || "",
      user.great_region || "",
      user.pastoral_zone || "",
      user.small_group || ""
    ].map(value => String(value)).join("|");
  },

  notifyOrgStructureChanged(status, detail = {}) {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    window.dispatchEvent(new CustomEvent("org-structure-updated", {
      detail: {
        status,
        revision: Number(state.orgStructure?.revision || 0),
        ...detail
      }
    }));
  },

  resetOrgStructure({ notify = true } = {}) {
    const revision = Number(state.orgStructure?.revision || 0) + 1;
    this._orgStructureRequestId += 1;
    this._orgStructurePromise = null;
    this._orgStructurePromiseKey = "";
    this._orgStructureSnapshotKey = "";
    state.orgStructure = createEmptyOrgStructure(revision);
    if (notify) this.notifyOrgStructureChanged("reset");
  },

  async loadOrgStructure() {
    const ownerKey = this.getOrgStructureOwnerKey();
    if (this._orgStructurePromise && this._orgStructurePromiseKey === ownerKey) {
      return this._orgStructurePromise;
    }

    // A snapshot is safe to keep during a background refresh only when it
    // belongs to this exact user, role and managed scope. Account/permission
    // changes still fail closed so another user's broader filters never leak.
    if (this._orgStructureSnapshotKey !== ownerKey) {
      this.resetOrgStructure();
    }

    const requestId = ++this._orgStructureRequestId;
    const loadPromise = (async () => {
      if (state.isSupabaseMode && state.supabase) {
        try {
          // profiles remain the source of truth after the legacy organization
          // system was removed. Build a complete candidate off-screen and only
          // publish it after every page has loaded successfully.
          let usersResult = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              usersResult = await fetchAllRows(() => state.supabase
                .from("profiles")
                .select("great_region, pastoral_zone, small_group"));
            } catch (error) {
              usersResult = { data: [], error };
            }
            if (!usersResult.error) break;
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400));
          }
          const { data: users, error } = usersResult || { data: [], error: new Error("org_structure_load_failed") };

          if (error) throw error;

          const regionsSet = new Set();
          const zonesMap = new Map(); // region -> Set of zones
          const groupsMap = new Map(); // zone -> Set of groups

          (users || []).forEach(u => {
            const region = (u.great_region || "").trim();
            const zone = (u.pastoral_zone || "").trim();
            const group = (u.small_group || "").trim();

            if (region) {
              regionsSet.add(region);
              if (zone) {
                if (!zonesMap.has(region)) zonesMap.set(region, new Set());
                zonesMap.get(region).add(zone);

                if (group) {
                  if (!groupsMap.has(zone)) groupsMap.set(zone, new Set());
                  groupsMap.get(zone).add(group);
                }
              }
            }
          });

          const nextOrgStructure = createEmptyOrgStructure(Number(state.orgStructure?.revision || 0) + 1);
          nextOrgStructure.regions = Array.from(regionsSet).sort();
          nextOrgStructure.regions.forEach(region => {
            nextOrgStructure.zones[region] = zonesMap.has(region)
              ? Array.from(zonesMap.get(region)).sort()
              : [];
          });
          zonesMap.forEach(zoneSet => {
            zoneSet.forEach(zone => {
              nextOrgStructure.groups[zone] = groupsMap.has(zone)
                ? Array.from(groupsMap.get(zone)).sort()
                : [];
            });
          });

          // Compatibility shapes used by existing permission and selector UI.
          nextOrgStructure.rawRegions = nextOrgStructure.regions.map(region => ({ id: region, name: region }));
          zonesMap.forEach((zoneSet, region) => {
            zoneSet.forEach(zone => {
              nextOrgStructure.rawZones.push({ id: zone, name: zone, great_region_id: region });
            });
          });
          groupsMap.forEach((groupSet, zone) => {
            groupSet.forEach(group => {
              nextOrgStructure.rawGroups.push({ id: group, name: group, pastoral_zone_id: zone });
            });
          });
          this.ensureCurrentUserOrgStructure(nextOrgStructure);

          // Ignore a response from an account/scope that stopped being current
          // while the request was in flight.
          if (requestId !== this._orgStructureRequestId || ownerKey !== this.getOrgStructureOwnerKey()) {
            return false;
          }
          state.orgStructure = nextOrgStructure;
          this._orgStructureSnapshotKey = ownerKey;
          this.notifyOrgStructureChanged("ready");
          return true;
        } catch (err) {
          console.error("Failed to load dynamic org structure from Supabase:", err);
          if (requestId !== this._orgStructureRequestId || ownerKey !== this.getOrgStructureOwnerKey()) {
            return false;
          }

          const preserved = this._orgStructureSnapshotKey === ownerKey;
          if (!preserved) {
            const fallback = createEmptyOrgStructure(Number(state.orgStructure?.revision || 0) + 1);
            this.ensureCurrentUserOrgStructure(fallback);
            state.orgStructure = fallback;
          }
          this.notifyOrgStructureChanged("error", { preserved });
          return false;
        }
      }

      this.loadMockOrgStructure();
      state.orgStructure.revision = Number(state.orgStructure?.revision || 0) + 1;
      this.ensureCurrentUserOrgStructure();
      this._orgStructureSnapshotKey = ownerKey;
      this.notifyOrgStructureChanged("ready");
      return true;
    })();

    this._orgStructurePromise = loadPromise;
    this._orgStructurePromiseKey = ownerKey;
    try {
      return await loadPromise;
    } finally {
      if (this._orgStructurePromise === loadPromise) {
        this._orgStructurePromise = null;
        this._orgStructurePromiseKey = "";
      }
    }
  },

  async syncChurchOrganization(regions, zones, groups) {
    // 組織架構已改為動態從使用者資料重構，不需手動更新組織表
    return { success: true };
  },

  loadMockOrgStructure() {
    // 優先從 mock_stats.js 動態讀取以避免重複定義
    if (typeof MOCK_GREAT_REGIONS !== 'undefined' && MOCK_GREAT_REGIONS.length > 0) {
      state.orgStructure.regions = [...MOCK_GREAT_REGIONS];
      state.orgStructure.zones = {};
      if (typeof MOCK_PASTORAL_ZONES_BY_REGION !== 'undefined') {
        Object.assign(state.orgStructure.zones, MOCK_PASTORAL_ZONES_BY_REGION);
      }
      state.orgStructure.groups = {};
      if (typeof MOCK_SMALL_GROUPS !== 'undefined') {
        Object.assign(state.orgStructure.groups, MOCK_SMALL_GROUPS);
      }
      return;
    }

    // 當 mock_stats.js 載入失敗或不存在時的後備資料
    state.orgStructure.regions = ["東區", "南區", "西區", "北區", "青少年", "慶典", "創藝"];
    state.orgStructure.zones = {
      "東區": ["大安1", "大安2", "大安6", "信義", "內湖"],
      "南區": ["文山", "中永和", "新店"],
      "西區": ["萬華", "板橋", "新莊"],
      "北區": ["士林", "北投", "天母"]
    };
    state.orgStructure.groups = {
      "大安1": ["馬鈴", "大衛", "約書亞"],
      "大安2": ["雅各", "彼得"],
      "中永和": ["保羅", "提摩太"],
      "文山": ["西面", "路得"],
      "大安6": ["以利亞"]
    };
  },

  // Save log to DB/LocalStorage
  async logChapterRead(book, chapter, isChecked, roundOverride = null, planOverride = null) {
    console.log('🏗️ [系統審計] 進入資料讀寫，當前操作類型：資料庫寫入進度', '資料版本:', state.dataVersion);
    const todayISO = new Date().toISOString();
    const targetPlan = planOverride || state.activePlan;
    const planId = targetPlan ? targetPlan.id : null;
    const presetKey = targetPlan ? targetPlan.presetKey : null;
    const round = roundOverride || (targetPlan ? (targetPlan.currentRound || 1) : 1);
    const isSamePlanLog = (log) => {
      const logPlanId = log.plan_id || null;
      const logPresetKey = log.presetKey || log.preset_key || null;
      if (planId && logPlanId) return logPlanId === planId;
      if (presetKey && logPresetKey) return logPresetKey === presetKey;
      if (planId && !logPlanId && !logPresetKey) return true;
      if (presetKey && !logPlanId && !logPresetKey) return true;
      return !planId && !presetKey && !logPlanId && !logPresetKey;
    };
    const isSameChapterLog = (log) =>
      log.book === book &&
      Number(log.chapter) === Number(chapter) &&
      (log.round || 1) === round &&
      isSamePlanLog(log);

    if (isChecked) {
      const existingLog = state.readingLogs.find(isSameChapterLog);
      if (!existingLog) {
        state.readingLogs.push({ book, chapter, read_at: todayISO, plan_id: planId, presetKey: presetKey, round: round });
      } else {
        existingLog.read_at = todayISO;
        if (!existingLog.plan_id && planId) existingLog.plan_id = planId;
        if (!existingLog.presetKey && presetKey) existingLog.presetKey = presetKey;
      }

      // The plan UI updates state.readingLogs optimistically before this runs.
      // Always persist independently; local existence does not mean a DB row exists.
      if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
        const user = await this.getCurrentDbUser();
        if (!user || !user.id) {
          const authError = new Error("Unable to persist reading progress: authenticated profile unavailable");
          authError.status = 401;
          throw authError;
        }

        const row = {
          user_id: user.id,
          plan_id: planId,
          book,
          chapter: Number(chapter),
          read_at: todayISO,
          round: Number(round)
        };
        const cacheKey = `reading_logs:${user.id}`;
        const repository = window.readingLogRepository || null;
        const throwWriteError = result => {
          if (!result?.error) return result;
          const error = new Error(result.error.message || result.error.error || String(result.error));
          error.status = Number(result.status || result.error.status || 0);
          error.code = result.error.code || null;
          throw error;
        };
        const insertReadingLog = () => repository
          ? repository.insert(row, { invalidate: [cacheKey] })
          : state.supabase.from("reading_logs").insert(row);
        const updateReadingLog = id => repository
          ? repository.update({ read_at: todayISO }, query => query.eq("id", id), { invalidate: [cacheKey] })
          : state.supabase.from("reading_logs").update({ read_at: todayISO }).eq("id", id);
        const compatiblePlanWrite = async () => {
          const existingResult = await state.supabase.from("reading_logs").select("id")
            .eq("user_id", user.id).eq("plan_id", planId).eq("book", book)
            .eq("chapter", Number(chapter)).eq("round", Number(round)).limit(1);
          throwWriteError(existingResult);
          const existingRow = Array.isArray(existingResult?.data) ? existingResult.data[0] : existingResult?.data;
          return existingRow?.id ? updateReadingLog(existingRow.id) : insertReadingLog();
        };

        let writeResult;
        if (planId) {
          try {
            writeResult = repository
              ? await repository.upsert(row, { onConflict: "user_id,plan_id,book,chapter,round" }, { invalidate: [cacheKey] })
              : await state.supabase.from("reading_logs").upsert(row, { onConflict: "user_id,plan_id,book,chapter,round" });
            throwWriteError(writeResult);
          } catch (upsertError) {
            console.warn("[ReadingLog] Upsert failed; retrying with compatible update/insert", {
              planId, book, chapter: Number(chapter), round: Number(round), error: upsertError
            });
            writeResult = await compatiblePlanWrite();
          }
        } else {
          const deleteResult = repository
            ? await repository.delete(query => query.eq("user_id", user.id).eq("book", book)
              .eq("chapter", chapter).eq("round", round).is("plan_id", null), { invalidate: [cacheKey] })
            : await state.supabase.from("reading_logs").delete()
              .eq("user_id", user.id).eq("book", book).eq("chapter", chapter)
              .eq("round", round).is("plan_id", null);
          throwWriteError(deleteResult);
          writeResult = await insertReadingLog();
        }
        throwWriteError(writeResult);
        console.info("[ReadingLog] Persisted", { planId, book, chapter: Number(chapter), round: Number(round) });
      }
    } else {
      state.readingLogs = state.readingLogs.filter(l => !isSameChapterLog(l));

      if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
        const user = await this.getCurrentDbUser();
        if (user) {
          const applyDeleteFilters = query => {
            query = query.eq("user_id", user.id).eq("book", book).eq("chapter", chapter).eq("round", round);
            return planId ? query.or(`plan_id.eq.${planId},plan_id.is.null`) : query.is("plan_id", null);
          };
          const cacheKey = `reading_logs:${user.id}`;
          const deleteResult = window.readingLogRepository
            ? await window.readingLogRepository.delete(applyDeleteFilters, { invalidate: [cacheKey] })
            : await applyDeleteFilters(state.supabase.from("reading_logs").delete());
          if (deleteResult && deleteResult.error) {
            throw new Error(deleteResult.error.message || deleteResult.error.error || String(deleteResult.error));
          }
        }
      }
    }

    if (!state.isSupabaseMode) {
      localStorage.setItem("reading_logs", JSON.stringify(state.readingLogs));
    }

    this.calculateStreak();
    this.saveLocalUserStats();

    // Reading progress is stored in reading_logs. Never write profile identity
    // fields here; stale tabs must not overwrite newer Member Hub names.
    if (typeof checkAchievements !== 'undefined') {
      await checkAchievements();
    }
  },

  async syncProfileStatsToSupabase() {
    if (state.currentUser && state.currentUser.is_demo) {
      console.warn("syncProfileStatsToSupabase aborted: current user is demo user.");
      return { aborted: true, reason: "demo" };
    }

    const editedName = state.currentUser.name || "";
    const lockedFields = new Set(state.profileLockedFields || []);

    if (lockedFields.has("name")) {
      return { aborted: true, reason: "member_hub_managed_name" };
    }

    const user = await this.getCurrentDbUser();
    if (!user) {
      throw new Error("Current login session is unavailable. Please sign in again.");
    }

    const displayName = lockedFields.has("name") ? (state.currentUser.name || "") : editedName;
    const profilePayload = {
      id: user.id,
      name: displayName,
      updated_at: new Date().toISOString()
    };

    let verifiedProfile = null;
    if (state.supabase.saveProfile) {
      const saveResult = await state.supabase.saveProfile(profilePayload);
      if (saveResult.error) throw new Error(saveResult.error.message || saveResult.error.error || saveResult.error);
      if (!saveResult.project_url) {
        throw new Error("個人資料暫時無法儲存，請稍後再試。");
      }
      verifiedProfile = saveResult.profile || saveResult.data || null;
    } else {
      const { data, error } = await state.supabase
        .from("profiles")
        .update({ name: displayName, updated_at: profilePayload.updated_at })
        .eq("id", user.id)
        .select("id, name")
        .single();
      if (error) throw new Error(error.message || error.error || error);
      verifiedProfile = data || null;
    }

    if (!verifiedProfile || verifiedProfile.id !== user.id) {
      const verifyResult = await state.supabase
        .from("profiles")
        .select("id, name")
        .eq("id", user.id)
        .maybeSingle();
      if (verifyResult.error) throw new Error(verifyResult.error.message || verifyResult.error.error || verifyResult.error);
      verifiedProfile = verifyResult.data || null;
    }

    if (!verifiedProfile || verifiedProfile.id !== user.id) {
      throw new Error("個人資料尚未成功儲存，請稍後再試。");
    }

    if (typeof auth !== "undefined" && auth.isLoggedIn()) {
      const cachedProfile = localStorage.getItem("nlc_supabase_profile");
      if (cachedProfile) {
        try {
          const merged = { ...JSON.parse(cachedProfile), name: verifiedProfile.name };
          localStorage.setItem("nlc_supabase_profile", JSON.stringify(merged));
          this.applyNlcProfile(merged, state.profileLockedFields);
          return { profile: merged };
        } catch (_err) {
          // fall through to verified profile
        }
      }
    }

    state.currentUser.name = verifiedProfile.name || state.currentUser.name;
    return { profile: verifiedProfile };
  },

  // Calculate streak based on reading logs
  calculateStreak() {
    if (state.readingLogs.length === 0) {
      state.currentUser.streak = 0;
      return;
    }

    const toLocalYYYYMMDD = (val) => {
      if (!val) return "";
      const date = val instanceof Date ? val : new Date(val);
      if (Number.isNaN(date.getTime())) return "";
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };

    const dates = [...new Set(state.readingLogs.map(log => toLocalYYYYMMDD(log.read_at)))].filter(Boolean).sort().reverse();

    if (dates.length === 0) {
      state.currentUser.streak = 0;
      return;
    }

    const todayStr = toLocalYYYYMMDD(new Date());
    const yesterdayStr = toLocalYYYYMMDD(new Date(Date.now() - 86400000));

    if (dates[0] !== todayStr && dates[0] !== yesterdayStr) {
      state.currentUser.streak = 0;
      state.currentUser.last_read = dates[0];
      this.saveLocalUserStats();
      return;
    }

    let streak = 1;
    let currentDate = new Date(dates[0]);

    for (let i = 1; i < dates.length; i++) {
      const nextDate = new Date(dates[i]);
      const diffTime = Math.abs(currentDate - nextDate);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        streak++;
        currentDate = nextDate;
      } else if (diffDays > 1) {
        break;
      }
    }

    state.currentUser.streak = streak;
    state.currentUser.last_read = dates[0];
    this.saveLocalUserStats();
  },

  saveLocalUserStats() {
    state.currentUser.chapters_read = state.readingLogs.length;
    if (state.activePlan) {
      state.currentUser.plan_progress = state.activePlan.progress;
    }
    if (!state.isSupabaseMode) {
      localStorage.setItem("user_profile", JSON.stringify(state.currentUser));
    }
  },

  async fetchAdminUserProfiles() {
    if (!state.isSupabaseMode || !state.supabase) {
      return { data: [], error: new Error("admin_user_directory_requires_supabase") };
    }
    if (getUserRoleCode(state.currentUser) !== "admin") {
      return { data: [], error: new Error("admin_user_directory_admin_required") };
    }
    try {
      const firstStageGlobalPlanId = "00000000-0000-0000-c026-000000000001";
      const firstStagePresetKey = "church_stage_01";
      let profiles = [];

      const { data: pData, error: pError } = await fetchAllRows(() => state.supabase
        .from("profiles")
        .select("id, name, email, great_region, pastoral_zone, small_group, is_active, name_review_approved, member_context_synced_at, member_context_sync_status, role_id, role_definition:role_definitions(id, code, label)")
        .eq("is_demo", false)
        .order("name", { ascending: true }));

      if (pError) {
        const { data: fallbackProfiles, error: fbErr } = await fetchAllRows(() => state.supabase
          .from("profiles")
          .select("id, name, email, great_region, pastoral_zone, small_group, is_active, name_review_approved, member_context_synced_at, member_context_sync_status, role_id")
          .eq("is_demo", false)
          .order("name", { ascending: true }));
        if (fbErr) {
          // Both attempts included name_review_approved (migration 0069).
          // If that column hasn't been deployed to this database yet, both
          // fail identically — degrade once more without it rather than
          // breaking the whole admin directory over one optional field.
          const { data: legacyProfiles, error: legacyErr } = await fetchAllRows(() => state.supabase
            .from("profiles")
            .select("id, name, email, great_region, pastoral_zone, small_group, is_active, member_context_synced_at, member_context_sync_status, role_id")
            .eq("is_demo", false)
            .order("name", { ascending: true }));
          if (legacyErr) return { data: [], error: legacyErr };
          profiles = (legacyProfiles || []).map(profile => ({ ...profile, name_review_approved: false }));
        } else {
          profiles = fallbackProfiles || [];
        }
      } else {
        profiles = pData || [];
      }

      const { data: enrollmentsResult } = await fetchAllRows(() => state.supabase
        .from("reading_plans")
        .select("user_id")
        .or(`global_plan_id.eq.${firstStageGlobalPlanId},preset_key.eq.${firstStagePresetKey}`));

      const joinedProfileIds = new Set((enrollmentsResult || []).map(plan => String(plan.user_id)));

      // 團隊組隊狀態：先前這裡完全沒有查詢過，profile.is_joined_team／team_name
      // 一直是 undefined，導致後台「未加入團隊」篩選勾選框形同虛設（永遠不會排除
      // 任何人），使用者卡片上的組隊狀態也永遠顯示「未加入團隊」。
      const { data: teamMembershipsResult } = await fetchAllRows(() => state.supabase
        .from("reading_team_members")
        .select("user_id, team_id, member_role"));

      const teamIds = Array.from(new Set((teamMembershipsResult || []).map(m => m.team_id).filter(Boolean)));
      let teamNameById = new Map();
      if (teamIds.length > 0) {
        const { data: teamsResult } = await fetchAllRows(() => state.supabase
          .from("reading_teams")
          .select("id, name")
          .in("id", teamIds));
        teamNameById = new Map((teamsResult || []).map(t => [String(t.id), t.name]));
      }
      // A member can belong to more than one team across different plans;
      // the directory card only has room for one, so — matching the same
      // "last membership wins" simplification already used elsewhere for
      // this kind of display (see _getAdminMemberTeamPlacementsFallback) —
      // later rows overwrite earlier ones here.
      const teamMembershipByUser = new Map();
      (teamMembershipsResult || []).forEach(m => {
        teamMembershipByUser.set(String(m.user_id), {
          team_name: teamNameById.get(String(m.team_id)) || "",
          member_role: m.member_role || null
        });
      });

      return {
        data: profiles.map(profile => {
          const membership = teamMembershipByUser.get(String(profile.id));
          return {
            ...profile,
            joined_stage_one: joinedProfileIds.has(String(profile.id)),
            is_joined_team: teamMembershipByUser.has(String(profile.id)),
            team_name: membership?.team_name || null,
            member_role: membership?.member_role || null
          };
        }),
        error: null
      };
    } catch (error) {
      return { data: [], error };
    }
  },

  async fetchManagedScopeProfiles() {
    if (!state.isSupabaseMode || !state.supabase) {
      return { data: [], error: new Error("managed_scope_requires_supabase") };
    }
    if (!hasWholeChurchPlanScope(state.currentUser)) {
      return { data: [], error: new Error("managed_scope_admin_required") };
    }
    try {
      let profiles = [];
      const { data, error } = await fetchAllRows(() => state.supabase
        .from("profiles")
        .select("id, name, email, great_region, pastoral_zone, small_group, managed_regions, managed_zones, managed_groups, role_id, role_definition:role_definitions(id, code, label, scope_type)")
        .eq("is_demo", false)
        .eq("is_active", true)
        .order("name", { ascending: true }));

      if (error) {
        const { data: fbData, error: fbError } = await fetchAllRows(() => state.supabase
          .from("profiles")
          .select("id, name, email, great_region, pastoral_zone, small_group, managed_regions, managed_zones, managed_groups, role_id")
          .eq("is_demo", false)
          .eq("is_active", true)
          .order("name", { ascending: true }));
        if (fbError) return { data: [], error: fbError };
        profiles = fbData || [];
      } else {
        profiles = data || [];
      }

      const pendingBackfills = [];

      profiles.forEach(profile => {
        const role = getUserRoleCode(profile) || "member";
        if (role === "great_zone_leader" && !profile.managed_regions && profile.great_region) {
          profile.managed_regions = profile.great_region.trim();
          pendingBackfills.push(
            this.updateManagedScopes(profile.id, { managedRegions: [profile.great_region.trim()] })
          );
        } else if (role === "zone_leader" && !profile.managed_zones && profile.pastoral_zone) {
          profile.managed_zones = profile.pastoral_zone.trim();
          pendingBackfills.push(
            this.updateManagedScopes(profile.id, { managedZones: [profile.pastoral_zone.trim()] })
          );
        } else if (role === "group_leader" && !profile.managed_groups && profile.small_group) {
          profile.managed_groups = profile.small_group.trim();
          pendingBackfills.push(
            this.updateManagedScopes(profile.id, { managedGroups: [profile.small_group.trim()] })
          );
        }
      });

      if (pendingBackfills.length > 0) {
        Promise.allSettled(pendingBackfills).catch(() => {});
      }

      return { data: profiles, error: null };
    } catch (error) {
      return { data: [], error };
    }
  },

  async updateManagedScopes(profileId, scopes = {}) {
    if (!state.isSupabaseMode || !state.supabase) {
      return { data: null, error: new Error("managed_scope_requires_supabase") };
    }
    if (!hasWholeChurchPlanScope(state.currentUser)) {
      return { data: null, error: new Error("managed_scope_admin_required") };
    }
    const normalize = values => Array.from(new Set(
      (Array.isArray(values) ? values : [])
        .map(value => String(value || "").trim())
        .filter(Boolean)
    ));
    const normRegions = normalize(scopes.managedRegions);
    const normZones = normalize(scopes.managedZones);
    const normGroups = normalize(scopes.managedGroups);
    const updatePayload = {
      managed_regions: normRegions.join(","),
      managed_zones: normZones.join(","),
      managed_groups: normGroups.join(",")
    };

    try {
      const { data: updatedProfile, error: tableError } = await state.supabase
        .from("profiles")
        .update(updatePayload)
        .eq("id", profileId)
        .select("id, managed_regions, managed_zones, managed_groups")
        .maybeSingle();

      if (!tableError && updatedProfile) {
        const resultData = {
          profileId,
          managedRegions: normRegions,
          managedZones: normZones,
          managedGroups: normGroups
        };
        if (String(profileId) === String(state.currentProfileId || state.currentUser?.id)) {
          state.currentUser.managed_regions = updatePayload.managed_regions || "";
          state.currentUser.managed_zones = updatePayload.managed_zones || "";
          state.currentUser.managed_groups = updatePayload.managed_groups || "";
        }
        return { data: resultData, error: null };
      }
    } catch (_tableErr) {}

    try {
      const { data, error } = await state.supabase.rpc("set_profile_managed_scopes", {
        p_profile_id: profileId,
        p_managed_regions: normRegions,
        p_managed_zones: normZones,
        p_managed_groups: normGroups
      });
      if (!error && data) {
        if (String(profileId) === String(state.currentProfileId || state.currentUser?.id)) {
          state.currentUser.managed_regions = (data?.managedRegions || []).join(",");
          state.currentUser.managed_zones = (data?.managedZones || []).join(",");
          state.currentUser.managed_groups = (data?.managedGroups || []).join(",");
        }
        return { data, error: null };
      }
    } catch (_rpcErr) {}

    const resultData = {
      profileId,
      managedRegions: normRegions,
      managedZones: normZones,
      managedGroups: normGroups
    };
    if (String(profileId) === String(state.currentProfileId || state.currentUser?.id)) {
      state.currentUser.managed_regions = updatePayload.managed_regions || "";
      state.currentUser.managed_zones = updatePayload.managed_zones || "";
      state.currentUser.managed_groups = updatePayload.managed_groups || "";
    }
    return { data: resultData, error: null };
  },

  /** Admin approves a name the getProfileNameFlags() heuristic flags, without changing it. */
  async approveProfileName(profileId) {
    if (!state.isSupabaseMode || !state.supabase) {
      return { data: null, error: new Error("profile_name_review_requires_supabase") };
    }
    if (getUserRoleCode(state.currentUser) !== "admin") {
      return { data: null, error: new Error("profile_name_review_admin_required") };
    }
    const { data, error } = await state.supabase
      .from("profiles")
      .update({ name_review_approved: true })
      .eq("id", profileId)
      .select("id, name, name_review_approved")
      .maybeSingle();
    return { data, error };
  },

  /** Admin directly corrects a flagged name and approves the replacement. */
  async adminOverwriteProfileName(profileId, name) {
    if (!state.isSupabaseMode || !state.supabase) {
      return { data: null, error: new Error("profile_name_review_requires_supabase") };
    }
    if (getUserRoleCode(state.currentUser) !== "admin") {
      return { data: null, error: new Error("profile_name_review_admin_required") };
    }
    const trimmed = String(name || "").trim();
    if (!trimmed) return { data: null, error: new Error("profile_name_required") };
    const { data, error } = await state.supabase
      .from("profiles")
      .update({ name: trimmed, name_review_approved: true })
      .eq("id", profileId)
      .select("id, name, name_review_approved")
      .maybeSingle();
    return { data, error };
  },

  async fetchRoleDefinitions() {
    const fallback = [
      { id: "10000000-0000-4000-8000-000000000001", code: "member", label: "一般會友", sort_order: 60, is_assignable: false },
      { id: "10000000-0000-4000-8000-000000000002", code: "group_leader", label: "小組長", sort_order: 50, is_assignable: false },
      { id: "10000000-0000-4000-8000-000000000003", code: "zone_leader", label: "牧區長", sort_order: 40, is_assignable: false },
      { id: "10000000-0000-4000-8000-000000000004", code: "great_zone_leader", label: "大區長", sort_order: 30, is_assignable: false },
      { id: "10000000-0000-4000-8000-000000000005", code: "pastor", label: "牧者", sort_order: 20, is_assignable: false },
      { id: "10000000-0000-4000-8000-000000000006", code: "admin", label: "系統管理員", sort_order: 10, is_assignable: false }
    ];
    if (!state.isSupabaseMode || !state.supabase) {
      state.roleDefinitions = fallback;
      return fallback;
    }
    const { data, error } = await state.supabase
      .from("role_definitions")
      .select("id, code, label, sort_order, is_assignable, can_manage_plans, can_manage_permissions, scope_type")
      .order("sort_order", { ascending: true });
    if (error) {
      console.warn("Role definitions are not available yet; using compatibility labels.", error);
      state.roleDefinitions = fallback;
      return fallback;
    }
    state.roleDefinitions = Array.isArray(data) && data.length ? data : fallback;
    return state.roleDefinitions;
  },
  async fetchMergedUsersList(filterPresetKey = null, ignorePlanFilter = false) {
    if (ignorePlanFilter) {
      filterPresetKey = false;
    } else if (!filterPresetKey && state.activePlan) {
      filterPresetKey = state.activePlan.globalPlanId || state.activePlan.presetKey || state.activePlan.name || state.activePlan.id;
    }
    const cacheKey = filterPresetKey || 'all';

    // 1. Concurrent request deduplication
    if (this._mergedUsersPromise[cacheKey]) {
      return this._mergedUsersPromise[cacheKey];
    }

    // 2. Cache expiration validation (60-second TTL)
    const cachedEntry = this._mergedUsersCache[cacheKey];
    const now = Date.now();
    if (cachedEntry && (now - cachedEntry.timestamp < 60000)) {
      return cachedEntry.data;
    }

    // 3. Create the actual load promise
    const loadPromise = (async () => {
      try {
        const result = await this._executeFetchMergedUsersList(filterPresetKey);
        this._mergedUsersCache[cacheKey] = {
          data: result,
          timestamp: Date.now()
        };
        return result;
      } finally {
        delete this._mergedUsersPromise[cacheKey];
      }
    })();

    this._mergedUsersPromise[cacheKey] = loadPromise;
    return loadPromise;
  },

  async _executeFetchMergedUsersList(filterPresetKey) {
    const planFilterAliases = getPlanFilterAliases(filterPresetKey);
    const planFilterAliasSet = new Set(planFilterAliases);
    const currentPlanId = state.activePlan ? state.activePlan.id : null;
    const currentPresetKey = state.activePlan ? state.activePlan.presetKey : null;
    const currentPlanLogMap = new Map();
    (state.readingLogs || []).forEach(log => {
      const logPlanId = log.plan_id || null;
      const logPresetKey = log.presetKey || log.preset_key || null;
      const matchesPlan =
        (currentPlanId && logPlanId && logPlanId === currentPlanId) ||
        (currentPresetKey && logPresetKey && logPresetKey === currentPresetKey) ||
        ((currentPlanId || currentPresetKey) && !logPlanId && !logPresetKey) ||
        (!currentPlanId && !currentPresetKey && !logPlanId && !logPresetKey);
      if (!matchesPlan) return;
      const round = log.round || 1;
      const logKey = `${log.book}_${log.chapter}_${round}`;
      const existingLog = currentPlanLogMap.get(logKey);
      const candidateReadAt = String(log.read_at || "");
      const existingReadAt = String(existingLog && existingLog.read_at || "");
      if (!existingLog || (candidateReadAt && (!existingReadAt || candidateReadAt < existingReadAt))) {
        currentPlanLogMap.set(logKey, log);
      }
    });
    const currentPlanLogs = Array.from(currentPlanLogMap.values());
    const currentPlanLastReadAt = currentPlanLogs.length > 0
      ? currentPlanLogs.map(log => log.read_at).filter(Boolean).sort().reverse()[0] || null
      : null;
    const currentPlanLastRead = currentPlanLastReadAt ? currentPlanLastReadAt.substring(0, 10) : null;

    const mockUser = {
      name: state.currentUser.name,
      great_region: state.currentUser.great_region || "",
      pastoral_zone: state.currentUser.pastoral_zone || "",
      small_group: state.currentUser.small_group || "",
      role_code: getUserRoleCode(state.currentUser) || "member",
      chapters_read: currentPlanLogs.length,
      plan_progress: state.activePlan ? (state.activePlan.progress || 0) : 0,
      last_read: currentPlanLastRead,
      last_read_at: currentPlanLastReadAt
    };

    if (state.isSupabaseMode && state.supabase) {
      try {
        const { data: usersProfiles, error: profilesError } = await fetchAllRows(() => state.supabase
          .from("profiles")
          .select("id, name, email, great_region, pastoral_zone, small_group, role_id, role_definition:role_definitions!profiles_role_definition_fkey(id, code, label), managed_regions, managed_zones, managed_groups")
          .eq("is_demo", false));
        if (profilesError) throw profilesError;

        const buildPlansQuery = () => {
          let q = state.supabase.from("reading_plans").select("id, user_id, name, preset_key, global_plan_id, target_books, current_round, level, upgrade_prompt_handled");
          if (filterPresetKey) {
            const textConditions = planFilterAliases.flatMap(alias => [
              `preset_key.eq.${quotePostgrestValue(alias)}`,
              `name.eq.${quotePostgrestValue(alias)}`
            ]);
            const uuidConditions = planFilterAliases
              .filter(isUuid)
              .flatMap(alias => [
                `global_plan_id.eq.${quotePostgrestValue(alias)}`,
                `id.eq.${quotePostgrestValue(alias)}`
              ]);
            q = q.or([...textConditions, ...uuidConditions].join(","));
          }
          return q;
        };
        const { data: allPlans, error: plansError } = await fetchAllRows(buildPlansQuery);
        if (plansError) throw plansError;

        const planIds = (allPlans || []).map(plan => plan.id).filter(Boolean);
        const { data: allLogs, error: logsError } = await fetchReadingLogsByPlanIds(
          state.supabase,
          planIds
        );
        if (logsError) throw logsError;
        state.allLogsCache = allLogs || [];

        // Fetch today's devotional notes (golden verses)
        const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
        const { data: todayNotes } = await state.supabase.from("devotional_notes").select("user_id, content").eq("note_date", todayStr);
        const notesByUser = {};
        if (todayNotes) {
          todayNotes.forEach(n => {
            notesByUser[n.user_id] = n.content;
          });
        }

        window.userPlanIdCache = {};
        if (allPlans) {
          allPlans.forEach(p => {
            if (p.user_id && p.preset_key) {
              window.userPlanIdCache[p.user_id + '_' + p.preset_key] = p.id;
            }
            if (p.user_id && p.name) {
              window.userPlanIdCache[p.user_id + '_' + p.name] = p.id;
            }
            if (p.user_id && p.global_plan_id) {
              window.userPlanIdCache[p.user_id + '_' + p.global_plan_id] = p.id;
            }
          });
        }

        if (usersProfiles) {
          // Pre-group plans by user_id
          const plansByUser = {};
          if (allPlans) {
            allPlans.forEach(p => {
              if (p.user_id) {
                if (!plansByUser[p.user_id]) plansByUser[p.user_id] = [];
                plansByUser[p.user_id].push(p);
              }
            });
          }

          // Pre-group logs by user_id
          const logsByUser = {};
          if (allLogs) {
            allLogs.forEach(l => {
              if (l.user_id) {
                if (!logsByUser[l.user_id]) logsByUser[l.user_id] = [];
                logsByUser[l.user_id].push(l);
              }
            });
          }

          return usersProfiles.map(profile => {
            const userPlans = plansByUser[profile.id] || [];
            const uPlan = filterPresetKey
              ? userPlans.find(p => [p.preset_key, p.global_plan_id, p.name, p.id].some(value => value && planFilterAliasSet.has(String(value))))
              : userPlans[0] || null;

            if (filterPresetKey && !uPlan) return null;

            const uLogs = logsByUser[profile.id] || [];
            const filteredLogs = filterPresetKey
              ? uLogs.filter(l => uPlan ? l.plan_id === uPlan.id : false)
              : uLogs;

            // Group filteredLogs to ensure each (book, chapter, round) is counted at most once
            const uniqueLogsMap = {};
            filteredLogs.forEach(l => {
              const r = l.round || 1;
              const key = `${l.book}_${l.chapter}_${r}`;
              const existingLog = uniqueLogsMap[key];
              const candidateReadAt = String(l.read_at || "");
              const existingReadAt = String(existingLog && existingLog.read_at || "");
              if (!existingLog || (candidateReadAt && (!existingReadAt || candidateReadAt < existingReadAt))) {
                uniqueLogsMap[key] = l;
              }
            });
            const uniqueLogs = Object.values(uniqueLogsMap);

            const confirmedRound = uPlan
              ? getConfirmedReadingRound({
                  currentRound: uPlan.current_round || 1,
                  upgradePromptHandled: uPlan.upgrade_prompt_handled,
                  logs: uniqueLogs
                })
              : 1;
            let planProgress = 0;
            if (uPlan && uPlan.target_books && uPlan.target_books.length > 0) {
              let totalChapters = 0;
              uPlan.target_books.forEach(bName => {
                const b = BIBLE_BOOKS.find(book => book.name === bName);
                if (b) totalChapters += b.chapters;
              });
              planProgress = getCurrentRoundChapterProgress(
                uniqueLogs,
                confirmedRound,
                totalChapters
              ).progress;
            }

            let lastRead = null;
            let lastReadAt = null;
            if (uniqueLogs.length > 0) {
              const sortedLogs = [...uniqueLogs].sort((a, b) => new Date(b.read_at) - new Date(a.read_at));
              if (sortedLogs[0] && sortedLogs[0].read_at) {
                lastReadAt = sortedLogs[0].read_at;
                lastRead = lastReadAt.substring(0, 10);
              }
            }

            return {
              id: profile.id,
              name: profile.name,
              great_region: profile.great_region,
              pastoral_zone: profile.pastoral_zone,
              small_group: profile.small_group,
              role_id: profile.role_id,
              role_definition: profile.role_definition,
              chapters_read: uniqueLogs.length,
              plan_progress: planProgress,
              streak: profile.streak || 0,
              last_read: lastRead,
              last_read_at: lastReadAt,
              plan_id: uPlan ? uPlan.id : null,
              presetKey: uPlan ? uPlan.preset_key : null,
              globalPlanId: uPlan ? uPlan.global_plan_id : null,
              current_round: confirmedRound,
              level: uPlan && confirmedRound === Number(uPlan.current_round || 1) ? (uPlan.level || 'normal') : 'normal',
              today_devotional: notesByUser[profile.id] || null
            };
          }).filter(Boolean);
        }
        return [mockUser];
      } catch (err) {
        console.error("Failed to fetch merged users:", err);
      }
      return [mockUser];
    }

    // Offline / Local Storage mode
    let localUsers = [];
    if (typeof MockStatsService !== 'undefined') {
      localUsers = MockStatsService.getAllUsers(mockUser);
    } else {
      localUsers = [mockUser];
    }

    const localNotesStr = localStorage.getItem("devotional_notes") || "{}";
    const localNotes = JSON.parse(localNotesStr);
    const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    const myTodayNote = localNotes[todayStr] || null;

    if (filterPresetKey) {
      const plan = state.activePlans ? state.activePlans.find(p => p.presetKey === filterPresetKey) : null;
      if (plan) {
        mockUser.chapters_read = plan.completedChapters;
        mockUser.plan_progress = plan.progress;
      }
      localUsers = localUsers.map(u => {
        if (u.name === mockUser.name) {
          return {
            ...u,
            chapters_read: mockUser.chapters_read,
            plan_progress: mockUser.plan_progress,
            today_devotional: myTodayNote
          };
        }
        return {
          ...u,
          chapters_read: 0,
          plan_progress: 0,
          last_read: null,
          today_devotional: null
        };
      });
    } else {
      localUsers = localUsers.map(u => {
        let uNote = null;
        if (u.name === mockUser.name) {
          uNote = myTodayNote;
        } else {
          const mockVerses = [
            "起初，神創造天地。 (創 1:1)",
            "神愛世人，甚至將他的獨生子賜給他們... (約 3:16)",
            "耶和華是我的牧者，我必不致缺乏。 (詩 23:1)",
            "你要專心仰賴耶和華，不可倚靠自己的聰明 (箴 3:5)"
          ];
          const isRecentRead = u.last_read && (
            u.last_read === todayStr ||
            u.last_read === "2026-06-26" ||
            u.last_read === "2026-06-25"
          );
          if (isRecentRead) {
            const idx = Math.abs(u.name.charCodeAt(0)) % mockVerses.length;
            uNote = mockVerses[idx];
          }
        }
        return {
          ...u,
          today_devotional: uNote
        };
      });
    }
    return localUsers;
  },

  async getUserRankings() {
    if (state.isSupabaseMode && state.supabase && state.currentUser && state.currentUser.id) {
      try {
        const { data, error } = await state.supabase.rpc('get_user_rankings', { user_uuid: state.currentUser.id });
        if (error) throw error;
        if (data && data.length > 0) {
          return {
            groupRank: parseInt(data[0].group_rank, 10),
            groupTotal: parseInt(data[0].group_total, 10),
            zoneRank: parseInt(data[0].zone_rank, 10),
            zoneTotal: parseInt(data[0].zone_total, 10),
            regionRank: parseInt(data[0].region_rank, 10),
            regionTotal: parseInt(data[0].region_total, 10),
            churchRank: parseInt(data[0].church_rank, 10),
            churchTotal: parseInt(data[0].church_total, 10)
          };
        }
      } catch (err) {
        console.error("Failed to call get_user_rankings RPC:", err);
      }
    }

    // Offline / Demo fallback calculation
    const allMockUsers = [...MOCK_USERS_DATA];
    const currentMockIdx = allMockUsers.findIndex(u => u.name === state.currentUser.name);
    const updatedCurrentUser = {
      name: state.currentUser.name,
      great_region: state.currentUser.great_region || "東區",
      pastoral_zone: state.currentUser.pastoral_zone || "大安1",
      small_group: state.currentUser.small_group || "馬鈴",
      role_code: getUserRoleCode(state.currentUser) || "member",
      chapters_read: state.currentUser.chapters_read || 0,
      plan_progress: state.currentUser.plan_progress || 0,
      streak: state.currentUser.streak || 0,
      last_read: state.currentUser.last_read
    };
    if (currentMockIdx !== -1) {
      allMockUsers[currentMockIdx] = updatedCurrentUser;
    } else {
      allMockUsers.push(updatedCurrentUser);
    }

    const getRankAndTotal = (filteredList) => {
      const sorted = [...filteredList].sort((a, b) => {
        if (b.chapters_read !== a.chapters_read) {
          return b.chapters_read - a.chapters_read;
        }
        return a.name.localeCompare(b.name);
      });
      const myIdx = sorted.findIndex(u => u.name === state.currentUser.name);
      return {
        rank: myIdx !== -1 ? myIdx + 1 : 0,
        total: sorted.length
      };
    };

    const churchStats = getRankAndTotal(allMockUsers);
    const regionStats = getRankAndTotal(allMockUsers.filter(u => u.great_region === updatedCurrentUser.great_region));
    const zoneStats = getRankAndTotal(allMockUsers.filter(u => u.pastoral_zone === updatedCurrentUser.pastoral_zone));
    const groupStats = getRankAndTotal(allMockUsers.filter(u => u.pastoral_zone === updatedCurrentUser.pastoral_zone && u.small_group === updatedCurrentUser.small_group));

    return {
      groupRank: groupStats.rank,
      groupTotal: groupStats.total,
      zoneRank: zoneStats.rank,
      zoneTotal: zoneStats.total,
      regionRank: regionStats.rank,
      regionTotal: regionStats.total,
      churchRank: churchStats.rank,
      churchTotal: churchStats.total
    };
  },

  async getDevotionalNote(date) {
    if (state.isSupabaseMode && state.supabase) {
      const user = await this.getCurrentDbUser();
      if (user) {
        const { data } = await state.supabase
          .from("devotional_notes")
          .select("content")
          .eq("user_id", user.id)
          .eq("note_date", date)
          .maybeSingle();
        return data ? data.content : "";
      }
    } else {
      const notesStr = localStorage.getItem("devotional_notes");
      if (notesStr) {
        const notes = JSON.parse(notesStr);
        return notes[date] || "";
      }
    }
    return "";
  },

  async saveDevotionalNote(date, content, noteId = null) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      const user = await this.getCurrentDbUser();
      if (!user) return null;

      if (noteId) {
        // 如果有指定正在編輯的 noteId，則更新它（解決同一次輸入的自動存檔與點擊發佈衝突）
        const { error } = await state.supabase
          .from("devotional_notes")
          .update({ content: content })
          .eq("id", noteId);

        if (error) throw error;
        return noteId;
      } else {
        // 沒有指定 noteId，則新增一筆，並回傳新產生的 ID 以供後續自動存檔/發佈更新
        const { data, error } = await state.supabase
          .from("devotional_notes")
          .insert({
            user_id: user.id,
            note_date: date,
            content: content
          })
          .select("id")
          .single();

        if (error) throw error;
        return data ? data.id : null;
      }
    } else {
      const notesStr = localStorage.getItem("devotional_notes") || "[]";
      let notes = [];
      try {
        notes = JSON.parse(notesStr);
        if (!Array.isArray(notes)) notes = [];
      } catch (e) {
        notes = [];
      }

      if (noteId) {
        const existingIdx = notes.findIndex(n => n.id === noteId);
        if (existingIdx !== -1) {
          notes[existingIdx].content = content;
          localStorage.setItem("devotional_notes", JSON.stringify(notes));
          return noteId;
        }
      }

      // 新增一筆
      const newId = "mock_note_" + Date.now();
      notes.unshift({
        id: newId,
        user_id: "me",
        note_date: date,
        content: content,
        created_at: new Date().toISOString()
      });
      localStorage.setItem("devotional_notes", JSON.stringify(notes));
      return newId;
    }
  },

  async deleteDevotionalNote(noteId) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      const { error } = await state.supabase
        .from("devotional_notes")
        .delete()
        .eq("id", noteId);

      if (error) throw error;
    } else {
      const notesStr = localStorage.getItem("devotional_notes") || "[]";
      let notes = [];
      try {
        notes = JSON.parse(notesStr);
        if (!Array.isArray(notes)) notes = [];
      } catch (e) {
        notes = [];
      }
      notes = notes.filter(n => n.id !== noteId);
      localStorage.setItem("devotional_notes", JSON.stringify(notes));
    }
  },

  async getVerseNotesForChapter(bookName, chapter) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      const user = await this.getCurrentDbUser();
      if (!user) return {};
      const { data, error } = await state.supabase
        .from("verse_notes")
        .select("verse, content")
        .eq("user_id", user.id)
        .eq("book", bookName)
        .eq("chapter", chapter);
      if (error) {
        console.warn("[db] getVerseNotesForChapter failed:", error);
        return {};
      }
      const notes = {};
      (data || []).forEach(row => { notes[row.verse] = row.content; });
      return notes;
    }
    const notesStr = localStorage.getItem("verse_notes") || "{}";
    let allNotes = {};
    try { allNotes = JSON.parse(notesStr) || {}; } catch (e) { allNotes = {}; }
    const notes = {};
    Object.keys(allNotes).forEach(key => {
      const [book, ch, verse] = key.split("_");
      if (book === bookName && Number(ch) === Number(chapter)) notes[verse] = allNotes[key].content;
    });
    return notes;
  },

  async saveVerseNote(bookName, chapter, verse, content) {
    const trimmed = String(content || "").trim();
    if (!trimmed) {
      await this.deleteVerseNote(bookName, chapter, verse);
      return "";
    }
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      const user = await this.getCurrentDbUser();
      if (!user) return "";
      const { error } = await state.supabase
        .from("verse_notes")
        .upsert({
          user_id: user.id,
          book: bookName,
          chapter: Number(chapter),
          verse: Number(verse),
          content: trimmed
        }, { onConflict: "user_id,book,chapter,verse" });
      if (error) throw error;
      return trimmed;
    }
    const notesStr = localStorage.getItem("verse_notes") || "{}";
    let allNotes = {};
    try { allNotes = JSON.parse(notesStr) || {}; } catch (e) { allNotes = {}; }
    const key = `${bookName}_${chapter}_${verse}`;
    allNotes[key] = { content: trimmed, updatedAt: new Date().toISOString() };
    localStorage.setItem("verse_notes", JSON.stringify(allNotes));
    return trimmed;
  },

  async deleteVerseNote(bookName, chapter, verse) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      const user = await this.getCurrentDbUser();
      if (!user) return;
      const { error } = await state.supabase
        .from("verse_notes")
        .delete()
        .eq("user_id", user.id)
        .eq("book", bookName)
        .eq("chapter", Number(chapter))
        .eq("verse", Number(verse));
      if (error) throw error;
      return;
    }
    const notesStr = localStorage.getItem("verse_notes") || "{}";
    let allNotes = {};
    try { allNotes = JSON.parse(notesStr) || {}; } catch (e) { allNotes = {}; }
    delete allNotes[`${bookName}_${chapter}_${verse}`];
    localStorage.setItem("verse_notes", JSON.stringify(allNotes));
  },

  async toggleDevotionalLike(noteId) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      const user = await this.getCurrentDbUser();
      if (!user) return false;

      const { data: existing } = await state.supabase
        .from("devotional_likes")
        .select("id")
        .eq("note_id", noteId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (existing) {
        await state.supabase
          .from("devotional_likes")
          .delete()
          .eq("id", existing.id);
        return false;
      } else {
        await state.supabase
          .from("devotional_likes")
          .insert([{ note_id: noteId, user_id: user.id }]);
        return true;
      }
    } else {
      const likedKey = `like_${noteId}`;
      const isLiked = localStorage.getItem(likedKey) === "true";
      if (isLiked) {
        localStorage.removeItem(likedKey);
        return false;
      } else {
        localStorage.setItem(likedKey, "true");
        return true;
      }
    }
  },

  async addDevotionalComment(noteId, content) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      const user = await this.getCurrentDbUser();
      if (!user) return null;

      const { data, error } = await state.supabase
        .from("devotional_comments")
        .insert([{ note_id: noteId, user_id: user.id, content }])
        .select("id, note_id, user_id, content, created_at")
        .single();

      if (error) throw error;
      return data;
    } else {
      const commentsKey = `comments_${noteId}`;
      const list = JSON.parse(localStorage.getItem(commentsKey) || "[]");
      const newComment = {
        id: `comment_${Date.now()}`,
        note_id: noteId,
        user_id: state.currentUser ? state.currentUser.id || "me" : "me",
        content,
        created_at: new Date().toISOString()
      };
      list.push(newComment);
      localStorage.setItem(commentsKey, JSON.stringify(list));
      return newComment;
    }
  },

  _readingTeamPlanId(plan) {
    const value = plan && (plan.globalPlanId || plan.global_plan_id || plan.id);
    return isUuid(value) ? String(value) : null;
  },

  _readingTeamErrorMessage(error) {
    const raw = String(error && (error.message || error.error || error.details) || error || "");
    const messages = {
      profile_required: "目前找不到你的會員資料，請重新登入後再試。",
      profile_identity_not_found: "目前找不到你的會員資料，請重新登入後再試。",
      team_plan_not_found: "這個計畫目前未開放團隊報名。",
      team_statistics_admin_required: "目前無法查看這項團隊資料。",
      team_statistics_management_scope_required: "你目前沒有可查看團隊資料的管理範圍。",
      invalid_team_division: "團隊只能選擇 3 人組或 6 人組。",
      invalid_team_name: "請輸入 1 至 40 字的團隊名稱，且不可包含控制字元或 HTML 尖括號。",
      duplicate_team_name: "這個團隊名稱已有人使用，請換一個名稱。",
      already_in_plan_team: "你已加入這個人數組別的團隊。",
      already_in_plan_division: "你已加入這個人數組別的團隊；仍可參加另一種人數的團隊。",
      team_invite_not_found: "找不到這組邀請碼，請向隊長確認。",
      reading_team_full: "這個團隊已額滿。",
      ready_team_roster_locked: "團隊已額滿，名單目前不能調整。",
      captain_must_disband_team: "隊長需解散尚未成隊的團隊，不能直接退出。",
      team_carryover_captain_required: "只有上一階段的原隊長可以帶領全隊進入下一階段。",
      team_carryover_member_conflict: "原團隊中有隊員已加入下一階段的其他團隊，無法整隊帶入。",
      target_stage_not_open: "下一階段尚未開放報名。",
      previous_stage_not_found: "找不到上一階段的團隊資料。",
      team_captain_required: "只有隊長可以解散團隊。",
      team_captain_transfer_required: "只有目前隊長可以轉移隊長。",
      team_captain_transfer_same_member: "你目前已經是隊長。",
      team_captain_transfer_member_required: "新隊長必須是這支團隊的現有隊員。",
      team_captain_membership_missing: "目前的隊長資料不完整，請重新整理後再試。",
      team_member_remove_captain_required: "只有隊長可以將隊員移出團隊。",
      team_captain_remove_self_not_allowed: "隊長不能將自己移出團隊；若要退出，請解散團隊。",
      reading_team_not_found: "找不到這個團隊。",
      not_a_team_member: "你目前不在這個團隊中。",
      team_reminder_self_not_allowed: "不需要提醒自己，完成閱讀後直接打卡就可以了。",
      team_reminder_same_team_required: "只能提醒同一支團隊裡的夥伴。",
      team_reminder_daily_limit: "今天已提醒過這位夥伴，明天再為彼此加油。",
      invalid_reminder_reason: "請重新選擇提醒方式。",
      plan_management_scope_required: "你目前沒有可管理這項計畫的權限範圍。",
      plan_member_outside_scope: "這位使用者不在你的管理範圍內。",
      plan_invitation_recipient_already_joined: "這位使用者已經加入所選計畫。",
      plan_invitation_recipient_not_found: "找不到這位使用者，或帳號目前未啟用。",
      plan_invitation_self_not_allowed: "不需要提醒自己加入計畫。",
      plan_not_found: "找不到所選計畫，請重新整理後再試。",      invalid_reminder_message: "提醒內容需為 1 至 300 字。",
      forbidden_rpc: "團隊功能暫時無法使用，請稍後再試。"
    };
    const key = Object.keys(messages).find(code => raw.includes(code));
    return key ? messages[key] : (raw || "團隊資料處理失敗，請稍後再試。");
  },

  async _callReadingTeamRpc(functionName, args) {
    if (!state.isSupabaseMode || !state.supabase || state.currentUser && state.currentUser.is_demo) {
      return { success: false, message: "團隊報名需登入正式帳號後使用。" };
    }
    try {
      const { data, error } = await state.supabase.rpc(functionName, args);
      if (error) return { success: false, error, message: this._readingTeamErrorMessage(error) };
      return { success: true, data };
    } catch (error) {
      return { success: false, error, message: this._readingTeamErrorMessage(error) };
    }
  },

  _quizPlanId(plan) {
    return this._readingTeamPlanId(plan);
  },

  _quizErrorMessage(error) {
    const raw = String(error && (error.message || error.error || error.details) || error || "");
    const normalized = raw.toLowerCase();
    if (normalized.includes("statement timeout")
      || normalized.includes("canceling statement")
      || normalized.includes("query timeout")
      || normalized.includes("57014")) {
      return "小測驗載入逾時，請稍後再試。";
    }
    if (normalized.includes("pgrst202")
      || normalized.includes("could not find the function")
      || normalized.includes("schema cache")) {
      return "小測驗資料庫版本尚未更新，請通知管理員完成系統更新。";
    }
    const messages = {
      quiz_review_required: "只有牧者或系統管理員可以審核與修改小測驗。",
      quiz_regeneration_permission_required: "只有牧者或系統管理員可以重新生成小測驗。",
      quiz_regeneration_variants_required: "請選擇需要重新生成的題目版本。",
      quiz_generation_secret_missing: "小測驗生成服務尚未完成排程密鑰設定。",
      quiz_plan_date_not_found: "找不到這個日期對應的教會進度。",
      quiz_approval_locked: "題目審核通過後已鎖定，不能取消審核、修改或更換。",
      quiz_already_approved: "題目已審核通過，不能再更換。",
      quiz_not_ready: "這一版題目尚未生成完成。",
      quiz_approval_required: "至少需要一版已審核題目才能發佈。",
      quiz_publish_scope_required: "只能發佈到你所負責組織範圍內的小組。",
      quiz_publish_groups_required: "目前沒有可以發佈的小組。",
      quiz_assignment_required: "你所屬的小組尚未收到這份小測驗。",
      quiz_publication_not_found: "找不到這份小測驗發佈紀錄。",
      quiz_not_available: "這份小測驗目前無法作答。",
      daily_quiz_feature_disabled: "每日小測驗功能目前已關閉。",
      quiz_answers_required: "請完成全部題目後再送出。",
      invalid_quiz_answer: "作答資料格式不正確，請重新選擇答案。",
      invalid_quiz_question: "每題都需要題目、四個選項、答案、解說與經文出處。",
      invalid_quiz_question_count: "自訂題目需要 2 至 10 題。",
      quiz_already_published: "這一版已經發佈，為避免改變組員正在作答的內容，不能再修改或取消審核。"
    };
    const key = Object.keys(messages).find(code => raw.includes(code));
    return key ? messages[key] : "目前無法載入小測驗資料，請稍後再試。";
  },

  async _callQuizRpc(functionName, args = {}) {
    if (!state.isSupabaseMode || !state.supabase || (state.currentUser && state.currentUser.is_demo)) {
      return { success: false, message: "小測驗功能需要登入正式帳號。" };
    }
    try {
      const { data, error } = await state.supabase.rpc(functionName, args);
      if (error) {
        const errorDetails = error && typeof error === "object"
          ? {
              message: error.message || null,
              code: error.code || null,
              details: error.details || null,
              hint: error.hint || null,
              status: error.status || null
            }
          : { message: String(error || "unknown_error") };
        console.warn(`[Quiz] ${functionName} failed: ${JSON.stringify(errorDetails)}`);
        return { success: false, error, message: this._quizErrorMessage(error) };
      }
      return { success: true, data };
    } catch (error) {
      const errorDetails = error && typeof error === "object"
        ? {
            message: error.message || null,
            code: error.code || null,
            details: error.details || null,
            hint: error.hint || null,
            status: error.status || null
          }
        : { message: String(error || "unknown_error") };
      console.warn(`[Quiz] ${functionName} failed: ${JSON.stringify(errorDetails)}`);
      return { success: false, error, message: this._quizErrorMessage(error) };
    }
  },

  async getDailyQuizDashboard(plan, quizDate) {
    const planId = this._quizPlanId(plan);
    if (!planId || !/^\d{4}-\d{2}-\d{2}$/.test(String(quizDate || ""))) {
      return { success: false, message: "找不到小測驗對應的計畫日期。" };
    }
    const result = await this._callQuizRpc("get_daily_quiz_dashboard", {
      p_global_plan_id: planId,
      p_quiz_date: quizDate
    });
    return result.success ? { success: true, context: result.data || {} } : result;
  },

  async reviewDailyQuiz(quizId, approved = true) {
    return this._callQuizRpc("review_daily_quiz", {
      p_quiz_id: quizId,
      p_approved: approved === true
    });
  },

  async regenerateDailyQuiz(plan, quizDate, variants = []) {
    const planId = this._quizPlanId(plan);
    if (!planId || !/^\d{4}-\d{2}-\d{2}$/.test(String(quizDate || ""))) {
      return { success: false, message: "找不到小測驗對應的計畫日期。" };
    }
    return this._callQuizRpc("request_daily_quiz_regeneration", {
      p_global_plan_id: planId,
      p_quiz_date: quizDate,
      p_variants: Array.isArray(variants) ? variants : []
    });
  },

  async updateDailyQuizQuestions(quizId, questions) {
    return this._callQuizRpc("update_daily_quiz_questions", {
      p_quiz_id: quizId,
      p_questions: questions
    });
  },

  async publishDailyQuiz(plan, quizDate, scope = {}, selection = {}) {
    const planId = this._quizPlanId(plan);
    if (!planId) return { success: false, message: "找不到小測驗對應的計畫。" };
    return this._callQuizRpc("publish_daily_quiz", {
      p_global_plan_id: planId,
      p_quiz_date: quizDate,
      p_scope_type: scope.scopeType || "all",
      p_scope_name: scope.scopeName || null,
      p_variant: selection.variant || null,
      p_custom_questions: Array.isArray(selection.customQuestions) && selection.customQuestions.length
        ? selection.customQuestions
        : null
    });
  },

  async submitDailyQuiz(publicationId, answers) {
    return this._callQuizRpc("submit_daily_quiz", {
      p_publication_id: publicationId,
      p_answers: answers
    });
  },

  async fetchQuizNotifications() {
    const result = await this._callQuizRpc("get_quiz_notifications");
    return result.success
      ? { data: Array.isArray(result.data) ? result.data : [], error: null }
      : { data: [], error: result.error || new Error(result.message) };
  },

  async acknowledgeQuizNotification(notificationId = null) {
    const result = await this._callQuizRpc("mark_quiz_notifications_read", {
      p_notification_id: notificationId || null
    });
    return { error: result.success ? null : (result.error || new Error(result.message)) };
  },

  async getMyReadingTeam(plan) {
    const planId = this._readingTeamPlanId(plan);
    if (!planId) return { success: false, message: "這個計畫目前未開放團隊報名。" };
    const result = await this._callReadingTeamRpc("get_my_reading_team", { p_global_plan_id: planId });
    return result.success ? { success: true, context: result.data || { teams: [], team: null, members: [] } } : result;
  },

  async getReadingTeamCarryoverOffer(plan) {
    const planId = this._readingTeamPlanId(plan);
    if (!planId) return { success: false, message: "找不到下一階段計畫。" };
    if (!state.isSupabaseMode || !state.supabase || state.currentUser && state.currentUser.is_demo) {
      return { success: true, context: { eligible: false, teams: [] } };
    }
    const result = await this._callReadingTeamRpc("get_reading_team_carryover_offer", {
      p_target_global_plan_id: planId
    });
    return result.success
      ? { success: true, context: result.data || { eligible: false, teams: [] } }
      : result;
  },

  async carryReadingTeamsToStage(plan) {
    const planId = this._readingTeamPlanId(plan);
    if (!planId) return { success: false, message: "找不到下一階段計畫。" };
    return this._callReadingTeamRpc("carry_reading_teams_to_stage", {
      p_target_global_plan_id: planId
    });
  },

  async getReadingTeamRegistrationOverview() {
    if (!state.isSupabaseMode || !state.supabase || (state.currentUser && state.currentUser.is_demo)) {
      const mockStats = await this.getReadingTeamStatistics({
        id: "00000000-0000-4000-8000-000000000001"
      });
      const visiblePlan = (state.globalPlans || []).find(plan => !plan.isHidden && !plan.is_hidden) || {};
      const teams = mockStats.success && mockStats.context ? mockStats.context.teams || [] : [];
      return {
        success: true,
        context: {
          summary: {
            planCount: teams.length > 0 ? 1 : 0,
            teamCount: teams.length,
            memberCount: teams.reduce((total, team) => total + Number(team.memberCount || 0), 0)
          },
          plans: teams.length > 0 ? [{
            id: visiblePlan.id || "demo-plan",
            name: visiblePlan.name || "示範速讀計畫",
            startDate: visiblePlan.startDate || visiblePlan.start_date || null,
            endDate: visiblePlan.endDate || visiblePlan.end_date || null,
            teamCount: teams.length,
            memberCount: teams.reduce((total, team) => total + Number(team.memberCount || 0), 0),
            teams
          }] : []
        }
      };
    }

    const result = await this._callReadingTeamRpc("get_reading_team_registration_overview", {});
    if (result.success && result.data) {
      return { success: true, context: result.data };
    }
    return this._getReadingTeamRegistrationOverviewFallback();
  },

  async _getReadingTeamRegistrationOverviewFallback() {
    try {
      const client = state.supabase;
      if (!client) return { success: true, context: { summary: {}, plans: [] } };

      const { data: teams, error: teamsErr } = await client
        .from("reading_teams")
        .select("id, global_plan_id, name, division, status, created_at");
      if (teamsErr || !Array.isArray(teams)) return { success: true, context: { summary: {}, plans: [] } };

      const teamIds = teams.map(t => t.id).filter(Boolean);
      let members = [];
      if (teamIds.length > 0) {
        const { data: mRows, error: mErr } = await client
          .from("reading_team_members")
          .select("team_id, user_id, member_role");
        if (!mErr && Array.isArray(mRows)) members = mRows;
      }

      // Filter to non-empty strings, not just truthy: a malformed/non-UUID
      // entry sent through .in() can make PostgREST reject the whole
      // request with a bare "Bad Request" (no Postgres error code) instead
      // of skipping just that row.
      const userIds = Array.from(new Set(
        members.map(m => m.user_id).filter(id => typeof id === "string" && id.length > 0)
      ));
      let profilesMap = new Map();
      if (userIds.length > 0) {
        const { data: pRows } = await client
          .from("profiles")
          .select("id, name, great_region, pastoral_zone, small_group")
          .in("id", userIds);
        if (Array.isArray(pRows)) {
          profilesMap = new Map(pRows.map(p => [String(p.id), p]));
        }
      }

      const teamMembersMap = new Map();
      members.forEach(m => {
        const tid = String(m.team_id);
        if (!teamMembersMap.has(tid)) teamMembersMap.set(tid, []);
        const p = profilesMap.get(String(m.user_id));
        teamMembersMap.get(tid).push({
          userId: m.user_id,
          role: m.member_role,
          name: p?.name || "",
          greatRegion: p?.great_region || "",
          pastoralZone: p?.pastoral_zone || "",
          smallGroup: p?.small_group || ""
        });
      });

      const globalPlans = state.globalPlans || [];
      const planMap = new Map(globalPlans.map(gp => [String(gp.id), gp]));

      const plansGrouped = new Map();
      teams.forEach(t => {
        const pid = String(t.global_plan_id || "global");
        if (!plansGrouped.has(pid)) {
          const gp = planMap.get(pid);
          plansGrouped.set(pid, {
            id: pid,
            name: gp?.name || "團隊計畫",
            startDate: gp?.startDate || gp?.start_date || null,
            endDate: gp?.endDate || gp?.end_date || null,
            teams: []
          });
        }
        const tMembers = teamMembersMap.get(String(t.id)) || [];
        plansGrouped.get(pid).teams.push({
          id: t.id,
          name: t.name,
          division: t.division,
          status: t.status,
          memberCount: tMembers.length,
          members: tMembers
        });
      });

      const plansList = Array.from(plansGrouped.values());
      return {
        success: true,
        context: {
          summary: {
            planCount: plansList.length,
            teamCount: teams.length,
            memberCount: members.length
          },
          plans: plansList
        }
      };
    } catch (_fallbackErr) {
      return { success: true, context: { summary: {}, plans: [] } };
    }
  },

  async getAdminRegistrationStatistics(globalPlanId) {
    if (!isUuid(globalPlanId)) {
      return { success: true, context: { planId: globalPlanId || "", planName: "", summary: {}, pastoralZones: [], greatRegions: [] } };
    }
    const result = await this._callReadingTeamRpc("get_admin_registration_statistics", {
      p_global_plan_id: String(globalPlanId)
    });
    if (result.success && result.data) {
      return { success: true, context: result.data };
    }
    return {
      success: true,
      context: {
        planId: globalPlanId,
        planName: "",
        summary: {},
        pastoralZones: [],
        greatRegions: []
      }
    };
  },

  _resolveManagementGlobalPlanId(plan) {
    const globalPlans = Array.isArray(state.globalPlans) ? state.globalPlans : [];
    const identifiers = [
      plan && plan.globalPlanId,
      plan && plan.global_plan_id,
      plan && plan.presetKey,
      plan && plan.preset_key,
      plan && plan.name
    ].filter(Boolean).map(String);
    const matchedGlobalPlan = globalPlans.find(item => [
      item.id,
      item.globalPlanId,
      item.global_plan_id,
      item.presetKey,
      item.preset_key,
      item.name
    ].filter(Boolean).map(String).some(value => identifiers.includes(value)));
    const value = matchedGlobalPlan && (matchedGlobalPlan.id || matchedGlobalPlan.globalPlanId)
      || plan && (plan.globalPlanId || plan.global_plan_id)
      || (globalPlans.some(item => String(item.id) === String(plan && plan.id)) ? plan.id : null);
    return isUuid(value) ? String(value) : null;
  },

  async _getUnjoinedPlanMembersFallback(plan, planId = null) {
    if (!state.isSupabaseMode || !state.supabase) {
      return { success: true, context: { planId, planName: plan && plan.name || "", members: [] } };
    }
    try {
      const { data: profiles, error: profilesError } = await state.supabase
        .from("profiles")
        .select("id, name, great_region, pastoral_zone, small_group, is_active, is_demo")
        .eq("is_active", true)
        .eq("is_demo", false);
      if (profilesError) throw profilesError;

      const aliases = [planId, plan && plan.presetKey, plan && plan.preset_key, plan && plan.name]
        .filter(Boolean).map(String);
      let plansQuery = state.supabase
        .from("reading_plans")
        .select("user_id, global_plan_id, preset_key, name");
      if (aliases.length > 0) {
        const conditions = aliases.flatMap(alias => {
          const quoted = quotePostgrestValue(alias);
          const values = [`preset_key.eq.${quoted}`, `name.eq.${quoted}`];
          if (isUuid(alias)) values.push(`global_plan_id.eq.${quoted}`);
          return values;
        });
        plansQuery = plansQuery.or(conditions.join(","));
      }
      const { data: joinedPlans, error: plansError } = await plansQuery;
      if (plansError) throw plansError;

      const currentUser = state.currentUser || {};
      const joinedIds = new Set((joinedPlans || []).map(item => String(item.user_id || "")));
      const overlap = (left, right) => {
        const leftValues = String(left || "").split(",").map(value => value.trim()).filter(Boolean);
        const rightValues = String(right || "").split(",").map(value => value.trim()).filter(Boolean);
        return leftValues.some(value => rightValues.includes(value));
      };
      const withinScope = candidate => hasWholeChurchPlanScope(currentUser)
        || (getUserRoleCode(currentUser) === "great_zone_leader" && overlap(candidate.great_region, currentUser.managed_regions || currentUser.great_region))
        || (getUserRoleCode(currentUser) === "zone_leader" && overlap(candidate.pastoral_zone, currentUser.managed_zones || currentUser.pastoral_zone))
        || (getUserRoleCode(currentUser) === "group_leader" && overlap(candidate.small_group, currentUser.managed_groups || currentUser.small_group));
      const members = (profiles || [])
        .filter(candidate => String(candidate.id) !== String(currentUser.id || state.currentProfileId || ""))
        .filter(withinScope)
        .filter(candidate => !joinedIds.has(String(candidate.id)))
        .map(candidate => ({
          id: candidate.id,
          name: candidate.name,
          greatRegion: candidate.great_region || "",
          pastoralZone: candidate.pastoral_zone || "",
          smallGroup: candidate.small_group || "",
          remindedToday: false
        }))
        .sort((left, right) => [left.greatRegion, left.pastoralZone, left.smallGroup, left.name].join("|")
          .localeCompare([right.greatRegion, right.pastoralZone, right.smallGroup, right.name].join("|"), "zh-Hant"));
      return { success: true, context: { planId, planName: plan && plan.name || "", members, fallback: true } };
    } catch (error) {
      return { success: false, error, message: this._readingTeamErrorMessage(error) };
    }
  },

  async getUnjoinedPlanMembers(plan) {
    const planId = this._resolveManagementGlobalPlanId(plan);
    if (planId) {
      const result = await this._callReadingTeamRpc("get_unjoined_plan_members", {
        p_global_plan_id: planId,
        p_plan_key: String(plan && (plan.presetKey || plan.preset_key) || "")
      });
      if (result.success) {
        return { success: true, context: result.data || { planId, planName: plan && plan.name || "", members: [] } };
      }
      console.warn("get_unjoined_plan_members unavailable; using scoped compatibility query", result.error || result.message);
    }
    return this._getUnjoinedPlanMembersFallback(plan, planId);
  },

  async _getJoinedPlanMembersFallback(plan, planId = null) {
    if (!state.isSupabaseMode || !state.supabase) {
      return { success: true, context: { planId, planName: plan && plan.name || "", members: [] } };
    }
    try {
      const { data: profiles, error: profilesError } = await state.supabase
        .from("profiles")
        .select("id, name, great_region, pastoral_zone, small_group, is_active, is_demo")
        .eq("is_active", true)
        .eq("is_demo", false);
      if (profilesError) throw profilesError;

      const aliases = [planId, plan && plan.presetKey, plan && plan.preset_key, plan && plan.name]
        .filter(Boolean).map(String);
      let plansQuery = state.supabase
        .from("reading_plans")
        .select("user_id, global_plan_id, preset_key, name, created_at, current_round");
      if (aliases.length > 0) {
        const conditions = aliases.flatMap(alias => {
          const quoted = quotePostgrestValue(alias);
          const values = [`preset_key.eq.${quoted}`, `name.eq.${quoted}`];
          if (isUuid(alias)) values.push(`global_plan_id.eq.${quoted}`);
          return values;
        });
        plansQuery = plansQuery.or(conditions.join(","));
      }
      const { data: joinedPlans, error: plansError } = await plansQuery;
      if (plansError) throw plansError;

      const currentUser = state.currentUser || {};
      const joinedByUserId = new Map((joinedPlans || []).map(item => [String(item.user_id || ""), item]));
      const overlap = (left, right) => {
        const leftValues = String(left || "").split(",").map(value => value.trim()).filter(Boolean);
        const rightValues = String(right || "").split(",").map(value => value.trim()).filter(Boolean);
        return leftValues.some(value => rightValues.includes(value));
      };
      const withinScope = candidate => hasWholeChurchPlanScope(currentUser)
        || (getUserRoleCode(currentUser) === "great_zone_leader" && overlap(candidate.great_region, currentUser.managed_regions || currentUser.great_region))
        || (getUserRoleCode(currentUser) === "zone_leader" && overlap(candidate.pastoral_zone, currentUser.managed_zones || currentUser.pastoral_zone))
        || (getUserRoleCode(currentUser) === "group_leader" && overlap(candidate.small_group, currentUser.managed_groups || currentUser.small_group));
      const members = (profiles || [])
        .filter(candidate => String(candidate.id) !== String(currentUser.id || state.currentProfileId || ""))
        .filter(withinScope)
        .filter(candidate => joinedByUserId.has(String(candidate.id)))
        .map(candidate => {
          const joined = joinedByUserId.get(String(candidate.id));
          return {
            id: candidate.id,
            name: candidate.name,
            greatRegion: candidate.great_region || "",
            pastoralZone: candidate.pastoral_zone || "",
            smallGroup: candidate.small_group || "",
            joinedAt: joined && joined.created_at || null,
            currentRound: joined && joined.current_round || 1
          };
        })
        .sort((left, right) => [left.greatRegion, left.pastoralZone, left.smallGroup, left.name].join("|")
          .localeCompare([right.greatRegion, right.pastoralZone, right.smallGroup, right.name].join("|"), "zh-Hant"));
      return { success: true, context: { planId, planName: plan && plan.name || "", members, fallback: true } };
    } catch (error) {
      return { success: false, error, message: this._readingTeamErrorMessage(error) };
    }
  },

  async getJoinedPlanMembers(plan) {
    const planId = this._resolveManagementGlobalPlanId(plan);
    if (planId) {
      const result = await this._callReadingTeamRpc("get_joined_plan_members", {
        p_global_plan_id: planId,
        p_plan_key: String(plan && (plan.presetKey || plan.preset_key) || "")
      });
      if (result.success) {
        return { success: true, context: result.data || { planId, planName: plan && plan.name || "", members: [] } };
      }
      console.warn("get_joined_plan_members unavailable; using scoped compatibility query", result.error || result.message);
    }
    return this._getJoinedPlanMembersFallback(plan, planId);
  },

  async _getAdminMemberTeamPlacementsFallback(plan, planId) {
    try {
      const client = state.supabase;
      if (!client) throw new Error("Supabase client not initialized");

      const { data: profiles, error: profilesError } = await client
        .from("profiles")
        .select("id, name, email, great_region, pastoral_zone, small_group, is_active, is_demo")
        .eq("is_active", true)
        .eq("is_demo", false);

      if (profilesError) throw profilesError;

      let memberships = [];
      if (planId) {
        const { data: teamMembers, error: tmError } = await client
          .from("reading_team_members")
          .select("user_id, team_id, member_role, division, global_plan_id")
          .eq("global_plan_id", planId);
        if (!tmError && teamMembers) memberships = teamMembers;
      }

      const teamIds = Array.from(new Set(memberships.map(m => m.team_id).filter(Boolean)));
      let teams = [];
      if (teamIds.length > 0) {
        const { data: teamRows, error: teamsError } = await client
          .from("reading_teams")
          .select("id, name")
          .in("id", teamIds);
        if (!teamsError && teamRows) teams = teamRows;
      }

      const teamMap = new Map(teams.map(t => [String(t.id), t]));
      const memberCountMap = new Map();
      memberships.forEach(m => {
        const tid = String(m.team_id);
        memberCountMap.set(tid, (memberCountMap.get(tid) || 0) + 1);
      });
      const membershipMap = new Map(memberships.map(m => [String(m.user_id), m]));

      const currentUser = state.currentUser || {};
      const overlap = (left, right) => {
        const leftValues = String(left || "").split(",").map(value => value.trim()).filter(Boolean);
        const rightValues = String(right || "").split(",").map(value => value.trim()).filter(Boolean);
        return leftValues.some(value => rightValues.includes(value));
      };
      const withinScope = candidate => hasWholeChurchPlanScope(currentUser)
        || (getUserRoleCode(currentUser) === "great_zone_leader" && overlap(candidate.great_region, currentUser.managed_regions || currentUser.great_region))
        || (getUserRoleCode(currentUser) === "zone_leader" && overlap(candidate.pastoral_zone, currentUser.managed_zones || currentUser.pastoral_zone))
        || (getUserRoleCode(currentUser) === "group_leader" && overlap(candidate.small_group, currentUser.managed_groups || currentUser.small_group));

      const data = (profiles || [])
        .filter(withinScope)
        .map(candidate => {
          const membership = membershipMap.get(String(candidate.id));
          const team = membership ? teamMap.get(String(membership.team_id)) : null;
          return {
            profileId: candidate.id,
            name: candidate.name || "",
            email: candidate.email || "",
            greatRegion: candidate.great_region || "",
            pastoralZone: candidate.pastoral_zone || "",
            smallGroup: candidate.small_group || "",
            isJoined: Boolean(membership && team),
            teamId: team ? team.id : null,
            teamName: team ? team.name : null,
            division: membership ? membership.division : null,
            memberRole: membership ? membership.member_role : null,
            memberCount: membership ? (memberCountMap.get(String(membership.team_id)) || 1) : 0
          };
        })
        .sort((left, right) => [left.greatRegion, left.pastoralZone, left.smallGroup, left.name].join("|")
          .localeCompare([right.greatRegion, right.pastoralZone, right.smallGroup, right.name].join("|"), "zh-Hant"));

      return { success: true, data };
    } catch (error) {
      console.error("_getAdminMemberTeamPlacementsFallback error:", error);
      return { success: false, data: [] };
    }
  },

  async getAdminMemberTeamPlacements(plan) {
    const planId = this._resolveManagementGlobalPlanId(plan);
    if (!planId) {
      return this._getAdminMemberTeamPlacementsFallback(plan, null);
    }
    const result = await this._callReadingTeamRpc("get_admin_member_team_placements", {
      p_global_plan_id: planId
    });
    if (result.success && Array.isArray(result.data) && result.data.length > 0) {
      return { success: true, data: result.data };
    }
    console.warn("get_admin_member_team_placements unavailable or empty; using table query fallback", result.error || result.message);
    return this._getAdminMemberTeamPlacementsFallback(plan, planId);
  },

  async sendPlanJoinInvitation(plan, recipientId) {
    const planId = this._resolveManagementGlobalPlanId(plan);
    if (planId) {
      const result = await this._callReadingTeamRpc("send_plan_join_invitation", {
        p_global_plan_id: planId,
        p_recipient_id: recipientId,
        p_plan_key: String(plan && (plan.presetKey || plan.preset_key) || "")
      });
      if (result.success) return { success: true, context: result.data || { sent: true } };
      console.warn("send_plan_join_invitation unavailable; using scoped care reminder", result.error || result.message);
    }
    const planName = String(plan && plan.name || "所選計畫");
    const reminderKey = `plan-invite:${planId || plan && (plan.presetKey || plan.preset_key) || planName}`;
    const fallback = await this.sendCareReminder({
      recipientId,
      reason: "encouragement",
      message: `邀請你加入「${planName}」讀經計畫，一起開始讀經吧！`,
      planKey: reminderKey
    });
    return fallback && !fallback.error
      ? { success: true, context: { sent: true, fallback: true } }
      : { success: false, error: fallback && fallback.error, message: this._readingTeamErrorMessage(fallback && fallback.error) };
  },
  async getReadingTeamStatistics(plan) {
    const planId = this._readingTeamPlanId(plan);
    if (!planId) return { success: false, message: "這個計畫目前未開放團隊統計。" };
    if (!state.isSupabaseMode || !state.supabase || (state.currentUser && state.currentUser.is_demo)) {
      return {
        success: true,
        context: {
          summary: {
            teamCount: 3,
            readyTeamCount: 2,
            memberCount: 12,
            division3Teams: 2,
            division6Teams: 1
          },
          teams: [
            {
              id: "mock-team-1",
              name: "聖靈果子隊",
              division: 3,
              status: "ready",
              memberCount: 3,
              members: [
                { userId: "user-1", name: "張茂松", role: "captain", pastoralZone: "大安區" },
                { userId: "user-2", name: "李家同", role: "member", pastoralZone: "大安區" },
                { userId: "user-3", name: "王建煊", role: "member", pastoralZone: "信義區" }
              ]
            },
            {
              id: "mock-team-2",
              name: "信心得勝隊",
              division: 3,
              status: "signup",
              memberCount: 2,
              members: [
                { userId: "user-4", name: "陳之藩", role: "captain", pastoralZone: "新莊區" },
                { userId: "user-5", name: "胡適", role: "member", pastoralZone: "板橋區" }
              ]
            },
            {
              id: "mock-team-3",
              name: "恩典滿滿隊",
              division: 6,
              status: "ready",
              memberCount: 6,
              members: [
                { userId: "user-6", name: "林語堂", role: "captain", pastoralZone: "士林區" },
                { userId: "user-7", name: "梁實秋", role: "member", pastoralZone: "北投區" },
                { userId: "user-8", name: "徐志摩", role: "member", pastoralZone: "士林區" },
                { userId: "user-9", name: "朱自清", role: "member", pastoralZone: "大同區" },
                { userId: "user-10", name: "沈從文", role: "member", pastoralZone: "中山區" },
                { userId: "user-11", name: "巴金", role: "member", pastoralZone: "士林區" }
              ]
            }
          ]
        }
      };
    }
    const result = await this._callReadingTeamRpc("get_reading_team_statistics", { p_global_plan_id: planId });
    return result.success ? { success: true, context: result.data || { summary: {}, teams: [] } } : result;
  },

  async getReadingTeamLeaderboards(plan) {
    const planId = this._readingTeamPlanId(plan);
    if (!planId) return { success: false, message: "這個計畫目前未開放團隊排行榜。" };
    if (!state.isSupabaseMode || !state.supabase || (state.currentUser && state.currentUser.is_demo)) {
      return {
        success: true,
        context: {
          division3: [
            { id: "mock-team-1", name: "聖靈果子隊", division: 3, status: "ready", memberCount: 3, chaptersRead: 126, rank: 1, captainPastoralZone: "大安牧區", isMine: true },
            { id: "mock-team-2", name: "信心得勝隊", division: 3, status: "forming", memberCount: 2, chaptersRead: 74, rank: 2, captainPastoralZone: "信義牧區", isMine: false }
          ],
          division6: [
            { id: "mock-team-3", name: "恩典滿滿隊", division: 6, status: "ready", memberCount: 6, chaptersRead: 238, rank: 1, captainPastoralZone: "中山牧區", isMine: true }
          ]
        }
      };
    }
    const result = await this._callReadingTeamRpc("get_reading_team_leaderboards", {
      p_global_plan_id: planId
    });
    if (!result.success) return result;

    const context = result.data || { division3: [], division6: [] };
    const leaderboardTeams = [
      ...(Array.isArray(context.division3) ? context.division3 : []),
      ...(Array.isArray(context.division6) ? context.division6 : [])
    ];
    if (!leaderboardTeams.some(team => typeof team.isMine === "boolean")) {
      const ownResult = await this.getMyReadingTeam(plan);
      const ownContexts = ownResult.success && ownResult.context
        ? (Array.isArray(ownResult.context.teams) ? ownResult.context.teams : [ownResult.context])
        : [];
      const ownTeamIds = new Set(ownContexts.map(item => item && item.team && String(item.team.id)).filter(Boolean));
      ["division3", "division6"].forEach(key => {
        context[key] = (Array.isArray(context[key]) ? context[key] : []).map(team => ({
          ...team,
          isMine: ownTeamIds.has(String(team.id))
        }));
      });
    }
    return { success: true, context };
  },

  async getPastoralZoneLeaderboard(plan) {
    const planId = this._readingTeamPlanId(plan);
    if (!planId) return { success: false, message: "找不到目前計畫，暫時無法載入牧區排行榜。" };
    if (!state.isSupabaseMode || !state.supabase || (state.currentUser && state.currentUser.is_demo)) {
      const ownZone = String(state.currentUser && state.currentUser.pastoral_zone || "").trim();
      return {
        success: true,
        context: {
          zones: [
            { name: ownZone || "第一牧區", memberCount: 12, chaptersRead: 126, averageChapters: 10.5, lastReadAt: null, isMine: true },
            { name: "第二牧區", memberCount: 10, chaptersRead: 98, averageChapters: 9.8, lastReadAt: null, isMine: false }
          ],
          unassignedCount: 0
        }
      };
    }
    const result = await this._callReadingTeamRpc("get_pastoral_zone_leaderboard", {
      p_global_plan_id: planId
    });
    return result.success
      ? { success: true, context: result.data || { zones: [], unassignedCount: 0 } }
      : result;
  },

  async getPersonalPlanRankingSummary(plan) {
    const planId = this._readingTeamPlanId(plan);
    if (!planId) return { success: false, message: "找不到目前計畫，暫時無法載入個人排名。" };
    if (!state.isSupabaseMode || !state.supabase || (state.currentUser && state.currentUser.is_demo)) {
      return {
        success: true,
        context: {
          churchRank: 1,
          churchTotal: 1,
          zoneName: String(state.currentUser && state.currentUser.pastoral_zone || "").trim() || null,
          zoneRank: 1,
          zoneTotal: 1
        }
      };
    }
    const result = await this._callReadingTeamRpc("get_personal_plan_ranking_summary", {
      p_global_plan_id: planId
    });
    return result.success
      ? {
          success: true,
          context: result.data || {
            churchRank: null,
            churchTotal: 0,
            zoneName: null,
            zoneRank: null,
            zoneTotal: 0
          }
        }
      : result;
  },

  async createReadingTeam(plan, division, name) {
    const planId = this._readingTeamPlanId(plan);
    if (!planId) return { success: false, message: "這個計畫目前未開放團隊報名。" };
    return this._callReadingTeamRpc("create_reading_team", {
      p_global_plan_id: planId,
      p_division: Number(division),
      p_name: String(name || "").trim()
    });
  },

  async joinReadingTeam(plan, inviteCode) {
    const planId = this._readingTeamPlanId(plan);
    if (!planId) return { success: false, message: "這個計畫目前未開放團隊報名。" };
    return this._callReadingTeamRpc("join_reading_team_by_code", {
      p_global_plan_id: planId,
      p_invite_code: String(inviteCode || "").trim().toUpperCase()
    });
  },

  async leaveReadingTeam(teamId) {
    return this._callReadingTeamRpc("leave_reading_team", { p_team_id: teamId });
  },

  async removeReadingTeamMember(teamId, memberId) {
    return this._callReadingTeamRpc("remove_reading_team_member", {
      p_team_id: teamId,
      p_member_id: memberId
    });
  },

  async disbandReadingTeam(teamId) {
    return this._callReadingTeamRpc("disband_reading_team", { p_team_id: teamId });
  },

  async renameReadingTeam(teamId, newName) {
    return this._callReadingTeamRpc("rename_reading_team", {
      p_team_id: teamId,
      p_name: String(newName || "").trim()
    });
  },

  async transferReadingTeamCaptain(teamId, newCaptainId) {
    return this._callReadingTeamRpc("transfer_reading_team_captain", {
      p_team_id: teamId,
      p_new_captain_id: newCaptainId
    });
  },

  async sendReadingTeamReminder({ teamId, recipientId, globalPlanId, reason, message }) {
    const result = await this._callReadingTeamRpc("send_reading_team_reminder", {
      p_team_id: teamId,
      p_recipient_id: recipientId,
      p_global_plan_id: globalPlanId,
      p_reason: reason,
      p_message: String(message || "").trim()
    });
    return result.success ? { error: null } : { error: new Error(result.message || "提醒傳送失敗。") };
  },

  async joinPresetPlan(key, scheduleSettings = null) {
    let preset = (state.globalPlans || []).find(p => p.presetKey === key || p.id === key);
    if (!preset) {
      preset = CHURCH_PLAN_PRESETS[key] || Object.values(CHURCH_PLAN_PRESETS).find(p => p.id === key);
    }
    if (!preset) {
      loader.hide();
      showToast("找不到該預設計畫。");
      return null;
    }

    const presetKey = preset.presetKey || key;

        loader.show("加入挑戰計畫中...");

    const getCleanDisplayName = (name) => String(name || "").trim();

    const planName = getCleanDisplayName(preset.name, presetKey);
    let startDate = preset.startDate;
    let endDate = preset.endDate;
    const selectedBooks = preset.books;

    // 優先用 globalPlan 查詢，並確定是否為固定時間計畫
    const globalPlan = (state.globalPlans || []).find(gp => gp.id === key || gp.presetKey === key);
    const isFixed = globalPlan ? globalPlan.isFixed !== false : true;
    const weeklySchedule = normalizePlanScheduleSettings(
      isFixed,
      scheduleSettings && scheduleSettings.readingDaysPerWeek,
      scheduleSettings && scheduleSettings.restWeekdays
    );

    if (!isFixed) {
      const getLocalDateString = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };

      const origStart = new Date(preset.startDate);
      const origEnd = new Date(preset.endDate);
      const durationDays = Math.max(1, Math.ceil((origEnd - origStart) / (1000 * 60 * 60 * 24)) + 1);

      const today = new Date();
      startDate = getLocalDateString(today);

      const end = new Date(today);
      end.setDate(today.getDate() + durationDays - 1);
      endDate = getLocalDateString(end);
    }

    let newPlanObj = null;

    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      try {
        const user = await this.getCurrentDbUser();
        if (user) {
          const globalPlanId = isUuid(key) ? key : (isUuid(preset.id) ? preset.id : (isUuid(preset.globalPlanId) ? preset.globalPlanId : null));

          const insertPayload = {
            user_id: user.id,
            name: planName,
            start_date: startDate,
            end_date: endDate,
            target_books: selectedBooks,
            preset_key: presetKey,
            level: 'normal',
            current_round: 1,
            was_downgraded: false,
            downgrade_locked_until: null,
            upgrade_prompt_handled: false,
            is_fixed: isFixed,
            reading_days_per_week: weeklySchedule.readingDaysPerWeek,
            rest_weekdays: weeklySchedule.restWeekdays
          };

          if (globalPlanId) {
            insertPayload.global_plan_id = globalPlanId;
          }

          let existingQuery = state.supabase
            .from("reading_plans")
            .select("id, user_id, global_plan_id, name, start_date, end_date, target_books, preset_key, level, current_round, is_fixed, reading_days_per_week, rest_weekdays")
            .eq("user_id", user.id);
          if (globalPlanId) existingQuery = existingQuery.eq("global_plan_id", globalPlanId);
          else existingQuery = existingQuery.eq("preset_key", presetKey).eq("name", planName);

          const { data: existingPlan, error: existingError } = await existingQuery.maybeSingle();
          if (existingError) throw existingError;

          if (existingPlan) {
            const existingIsFixed = existingPlan.is_fixed !== false;
            newPlanObj = generatePlanObject(planName, existingPlan.start_date, existingPlan.end_date, selectedBooks, presetKey, 'normal', existingIsFixed, {
              readingDaysPerWeek: existingPlan.reading_days_per_week,
              restWeekdays: existingPlan.rest_weekdays
            });
            newPlanObj.id = existingPlan.id;
            newPlanObj.globalPlanId = existingPlan.global_plan_id || null;
            newPlanObj.level = existingPlan.level || newPlanObj.level || "normal";
            newPlanObj.currentRound = existingPlan.current_round || 1;
            newPlanObj.isFixed = existingIsFixed;
            newPlanObj.is_fixed = existingIsFixed;
            if (!state.activePlans) state.activePlans = [];
            if (!state.activePlans.some(p => p.id === newPlanObj.id)) state.activePlans.push(newPlanObj);
            state.activePlan = newPlanObj;
            localStorage.setItem("selected_plan_key", presetKey);
          } else {
            const { data: dbPlan, error } = await state.supabase
              .from("reading_plans")
              .insert(insertPayload)
              .select("id, user_id, global_plan_id, name, start_date, end_date, target_books, preset_key, level, current_round, is_fixed, reading_days_per_week, rest_weekdays")
              .single();

            if (error) {
              console.error("Failed to insert plan in Supabase:", error);
              loader.hide();
              showToast("加入讀經計畫失敗：" + (error.message || error.error || error));
              return null;
            }

            if (!dbPlan) throw new Error("No plan returned after insert.");

            const dbIsFixed = dbPlan.is_fixed !== false;
            newPlanObj = generatePlanObject(planName, dbPlan.start_date, dbPlan.end_date, selectedBooks, presetKey, 'normal', dbIsFixed, {
              readingDaysPerWeek: dbPlan.reading_days_per_week,
              restWeekdays: dbPlan.rest_weekdays
            });
            newPlanObj.id = dbPlan.id;
            newPlanObj.globalPlanId = dbPlan.global_plan_id || null;
            newPlanObj.isFixed = dbIsFixed;
            newPlanObj.is_fixed = dbIsFixed;
            if (!state.activePlans) state.activePlans = [];
            state.activePlans.push(newPlanObj);
            state.activePlan = newPlanObj;
            localStorage.setItem("selected_plan_key", presetKey);
          }
        }
      } catch (e) {
        console.error("Error inserting plan in Supabase:", e);
        loader.hide();
        showToast("加入讀經計畫失敗：" + (e.message || e));
        return null;
      }
    } else {
      newPlanObj = generatePlanObject(planName, startDate, endDate, selectedBooks, presetKey, 'normal', isFixed, weeklySchedule);
      newPlanObj.isFixed = isFixed;
      newPlanObj.is_fixed = isFixed;
      if (!state.activePlans) state.activePlans = [];
      state.activePlans.push(newPlanObj);
      state.activePlan = newPlanObj;
      localStorage.setItem("active_reading_plans", JSON.stringify(state.activePlans));
      localStorage.setItem("selected_plan_key", presetKey);
    }

    if (newPlanObj && preset.planKind) {
      Object.assign(newPlanObj, {
        globalPlanId: newPlanObj.globalPlanId || preset.globalPlanId || preset.id || null,
        planKind: preset.planKind,
        stageNo: preset.stageNo || null,
        roundNo: preset.roundNo || null,
        awardName: preset.awardName || null,
        campaignDefinition: preset.campaignDefinition || null
      });
    }

    calculatePlanProgress();
    this.saveLocalUserStats();
    this._userDataPromise = null; // 💡 關鍵修復：清除資料加載快取以使快取失效

    state.planDetailOpen = true;
    state.planActiveSubTab = "today";
    state.selectedPlanDay = null;
    window.currentPlanViewState = "DETAIL";
    if (typeof window.syncActivePlanContext === "function") {
      window.syncActivePlanContext(newPlanObj);
    }

    loader.hide();
    updateDashboardView();

    if (typeof appRouter !== "undefined" && typeof appRouter.switchTab === "function") {
      await appRouter.switchTab("plan-view", { keepPlanDetail: true });
    } else if (typeof window.setPlanState === "function") {
      await window.setPlanState("DETAIL");
    } else {
      renderPlanView();
    }

    const started = isPlanStarted(newPlanObj);

    if (started) {
      showToast(`成功加入 ${planName}！計畫已開始。`);
    } else {
      showToast(`成功預約加入 ${planName}！計畫將於 ${startDate} 開始。`);
    }
    return newPlanObj;
  },

  async joinPlan(name, startDate, endDate, books, key, scheduleSettings = null) {
    return this.joinPresetPlan(key, scheduleSettings);
  },


  async updateFlexiblePlanSchedule(plan, scheduleSettings) {
    if (!plan) {
      return { success: false, error: new Error("A plan is required.") };
    }
    const isFixed = plan.isFixed !== false && plan.is_fixed !== false;

    const weeklySchedule = normalizePlanScheduleSettings(
      isFixed,
      scheduleSettings && scheduleSettings.readingDaysPerWeek,
      scheduleSettings && scheduleSettings.restWeekdays
    );

    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      const { error } = await state.supabase
        .from("reading_plans")
        .update({
          reading_days_per_week: weeklySchedule.readingDaysPerWeek,
          rest_weekdays: weeklySchedule.restWeekdays
        })
        .eq("id", plan.id);
      if (error) return { success: false, error };
    }

    const rebuilt = generatePlanObject(
      plan.name,
      plan.startDate,
      plan.endDate,
      plan.target_books || plan.targetBooks || [],
      plan.presetKey || plan.globalPlanId,
      plan.level || "normal",
      isFixed,
      weeklySchedule
    );
    const preserved = {
      id: plan.id,
      globalPlanId: plan.globalPlanId || null,
      presetKey: plan.presetKey,
      currentRound: plan.currentRound || 1,
      level: plan.level || "normal",
      wasDowngraded: Boolean(plan.wasDowngraded),
      isFixed,
      is_fixed: isFixed
    };
    Object.assign(plan, rebuilt, preserved);

    if (typeof checkPlanSchedule === "function") {
      await checkPlanSchedule(plan);
    }
    calculateAllPlansProgress();
    this.saveLocalUserStats();
    this._mergedUsersCache = {};
    this._mergedUsersPromise = {};

    if (!state.isSupabaseMode) {
      localStorage.setItem("active_reading_plans", JSON.stringify(state.activePlans || []));
    }
    return { success: true, plan };
  },

  async leavePlan(planId, presetKey) {
    loader.show("退出計畫中...");

    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      try {
        const { error } = await state.supabase.from("reading_plans").delete().eq("id", planId);
        if (error) throw error;
      } catch (e) {
        console.error("Failed to delete plan from Supabase:", e);
      }
    }

    state.activePlans = state.activePlans.filter(p => p.id !== planId && p.presetKey !== presetKey);
    state.readingLogs = state.readingLogs.filter(l => l.plan_id !== planId && l.presetKey !== presetKey);

    if (!state.isSupabaseMode) {
      localStorage.setItem("active_reading_plans", JSON.stringify(state.activePlans));
      localStorage.setItem("reading_logs", JSON.stringify(state.readingLogs));
    }

    if (state.activePlans.length > 0) {
      state.activePlan = selectMostRecentActivePlan(state.activePlans);
      if (state.activePlan) {
        localStorage.setItem("selected_plan_key", state.activePlan.presetKey || state.activePlan.id || "");
      } else {
        localStorage.removeItem("selected_plan_key");
      }
    } else {
      state.activePlan = null;
      localStorage.removeItem("selected_plan_key");
    }

    calculateAllPlansProgress();
    this.saveLocalUserStats();
    this._userDataPromise = null; // 💡 關鍵修復：清除資料加載快取以使快取失效

    loader.hide();
    renderPlanView();
    updateDashboardView();
    showToast("已成功退出該讀經計畫並清除相關計畫讀經打卡紀錄。");
  },

  async loadGlobalPlans() {
    state.globalPlans = [];

    if (state.isSupabaseMode && state.supabase) {
      // ── Supabase 模式：資料完全來自資料庫，不混合硬寫的 CHURCH_PLAN_PRESETS ──
      try {
        const { data, error } = await state.supabase
          .from("global_plans")
          .select("id, name, description, start_date, end_date, target_books, is_hidden, is_fixed, plan_kind, rules, rule_version, published_at")
          .order("start_date", { ascending: true });

        if (error) {
          console.error("Failed to load global plans from Supabase:", error);
        } else {
          state.globalPlans = (data || []).map(mapGlobalPlanRecord);
          return;
        }
      } catch (e) {
        console.error("Error loading global plans from Supabase:", e);
      }
    }

    // ── localStorage / Demo 模式：從本機讀取，並補上硬寫的四季預設計畫 ──
    const localCampaignOverride = (() => {
      try {
        const value = JSON.parse(localStorage.getItem("church_campaign_override") || "null");
        return value && Array.isArray(value.stages) && Array.isArray(value.segments) ? value : null;
      } catch (error) {
        return null;
      }
    })();
    const mergeWithPresets = (loadedList) => {
      const presetKeys = Object.keys(CHURCH_PLAN_PRESETS);
      const presetPlans = Object.entries(CHURCH_PLAN_PRESETS).map(([key, originalPreset]) => {
        const overrideStage = localCampaignOverride && originalPreset.planKind === "church_campaign_stage"
          ? window.getChurchCampaignStageDefinition(originalPreset.stageNo, localCampaignOverride)
          : null;
        const p = overrideStage ? { ...originalPreset, ...overrideStage, campaignDefinition: overrideStage, ruleVersion: localCampaignOverride.version } : originalPreset;
        return ({
        id: p.id || key,
        globalPlanId: p.id || key,
        name: p.name,
        startDate: p.startDate,
        endDate: p.endDate,
        books: p.books,
        presetKey: key,
        isHidden: Boolean(p.isHidden || p.is_hidden),
        isFixed: p.isFixed !== false,
        is_fixed: p.isFixed !== false,
        planKind: p.planKind || "standard",
        parentCampaignId: p.parentCampaignId || null,
        stageNo: p.stageNo || null,
        roundNo: p.roundNo || null,
        phase: p.phase || null,
        awardName: p.awardName || null,
        examDate: p.examDate || null,
        ruleVersion: Number(p.ruleVersion || 1),
        description: p.description || "",
        campaignDefinition: p.campaignDefinition ? window.cloneChurchCampaign(p.campaignDefinition) : null
      });
      });
      // 自訂計畫：排除目前內建階段，避免重複顯示。
      const customPlans = loadedList.filter(p => !presetKeys.includes(p.presetKey) && !presetKeys.includes(p.id));
      const masterDefinition = localCampaignOverride || window.CHURCH_CAMPAIGN;
      const masterPlan = {
        id: window.CHURCH_CAMPAIGN_ID, globalPlanId: window.CHURCH_CAMPAIGN_ID,
        presetKey: window.CHURCH_CAMPAIGN_PRESET_KEY, planKind: "church_campaign",
        name: "教會階段規則設定", description: "僅供管理員編輯階段規則，不是可加入的讀經計畫。",
        startDate: masterDefinition.startDate, endDate: masterDefinition.endDate,
        books: Array.from(new Set(masterDefinition.segments.flatMap(segment => segment.readings.map(reading => reading.book)))),
        isHidden: true, isFixed: true, is_fixed: true,
        ruleVersion: Number(masterDefinition.version || 1), campaignDefinition: window.cloneChurchCampaign(masterDefinition)
      };
      return [masterPlan, ...presetPlans, ...customPlans].map(plan => ({
        ...plan,
        isHidden: Boolean(plan.isHidden || plan.is_hidden),
        isFixed: plan.isFixed !== false,
        is_fixed: plan.isFixed !== false
      }));
    };

    const localGlobal = localStorage.getItem("global_plans_presets");
    if (localGlobal) {
      const localList = JSON.parse(localGlobal);
      state.globalPlans = mergeWithPresets(localList);
    } else {
      state.globalPlans = mergeWithPresets([]);
      localStorage.setItem("global_plans_presets", JSON.stringify(state.globalPlans));
    }
  },

  async publishCampaignRules(plan, definition) {
    const validation = window.validateChurchCampaign(definition, BIBLE_BOOKS);
    if (!validation.valid) {
      showToast(validation.errors[0] || "計畫規則不完整。");
      return { success: false, validation };
    }

    const nextDefinition = window.cloneChurchCampaign(definition);
    nextDefinition.id = plan.id || window.CHURCH_CAMPAIGN_ID;
    nextDefinition.presetKey = window.CHURCH_CAMPAIGN_PRESET_KEY;
    nextDefinition.planKind = "church_campaign";
    const campaignId = plan.id || window.CHURCH_CAMPAIGN_ID;
    let persistenceVerified = false;
    let persistenceVerificationError = null;
    let storage = "local";

    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      storage = "supabase";
      const { data, error } = await state.supabase.rpc("publish_global_plan_rules", {
        p_plan_id: campaignId,
        p_expected_version: Number(plan.ruleVersion || 1),
        p_definition: nextDefinition
      });
      if (error) {
        console.error("Failed to publish campaign rules:", error);
        showToast(error.message && error.message.includes("version_conflict")
          ? "計畫已被其他管理員更新，請重新載入後再修改。"
          : "發布失敗：" + (error.message || error));
        return { success: false, validation, error };
      }
      nextDefinition.version = Number(data || plan.ruleVersion + 1);

      const parseStoredRules = value => {
        if (!value || typeof value !== "string") return value || {};
        try { return JSON.parse(value); } catch (_) { return {}; }
      };
      const expectedStageNumbers = nextDefinition.stages.map(stage => Number(stage.stageNo)).sort((a, b) => a - b);
      const masterResult = await state.supabase
        .from("global_plans")
        .select("id, rules, rule_version")
        .eq("id", campaignId)
        .single();
      const stageResult = await state.supabase
        .from("global_plans")
        .select("id, rules, rule_version, plan_kind")
        .eq("plan_kind", "church_campaign_stage");

      const storedRules = parseStoredRules(masterResult.data && masterResult.data.rules);
      const storedStageNumbers = Array.isArray(storedRules.stages)
        ? storedRules.stages.map(stage => Number(stage.stageNo)).sort((a, b) => a - b)
        : [];
      const materializedStageNumbers = (stageResult.data || []).map(item => ({
        item,
        rules: parseStoredRules(item.rules)
      })).filter(entry => String(entry.rules.parentCampaignId || "") === String(campaignId))
        .map(entry => Number(entry.rules.stageNo))
        .sort((a, b) => a - b);
      const sameStageNumbers = list => list.length === expectedStageNumbers.length
        && list.every((stageNo, index) => stageNo === expectedStageNumbers[index]);

      persistenceVerified = !masterResult.error
        && !stageResult.error
        && Number(masterResult.data && masterResult.data.rule_version) === nextDefinition.version
        && sameStageNumbers(storedStageNumbers)
        && sameStageNumbers(materializedStageNumbers);
      if (!persistenceVerified) {
        persistenceVerificationError = masterResult.error || stageResult.error || new Error("campaign_persistence_verification_failed");
        console.error("Campaign rules were published but Supabase verification did not match:", {
          persistenceVerificationError,
          expectedStageNumbers,
          storedStageNumbers,
          materializedStageNumbers
        });
      }
    } else {
      nextDefinition.version = Number(plan.ruleVersion || 1) + 1;
      localStorage.setItem("church_campaign_override", JSON.stringify(nextDefinition));
      window.CHURCH_CAMPAIGN = window.cloneChurchCampaign(nextDefinition);
      window.createChurchCampaignStageDefinitions(nextDefinition).forEach(stage => {
        const preset = CHURCH_PLAN_PRESETS[stage.presetKey];
        if (preset) Object.assign(preset, stage, { campaignDefinition: window.cloneChurchCampaign(stage) });
      });
      persistenceVerified = true;
    }

    this._userDataPromise = null;
    await this.loadGlobalPlans();
    return { success: true, validation, version: nextDefinition.version, storage, persistenceVerified, persistenceVerificationError };
  },

  async saveGlobalPlan(plan) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      try {
        const payload = {
          name: plan.name,
          start_date: plan.startDate,
          end_date: plan.endDate,
          target_books: plan.books,
          is_fixed: plan.isFixed !== false
        };

        let error;
        if (plan.id && plan.id.length > 5 && plan.id.includes('-')) {
          const res = await state.supabase
            .from("global_plans")
            .update(payload)
            .eq("id", plan.id);
          error = res.error;

          if (!error) {
            // 💡 同步更新所有使用者對應的全域計畫 copy
            const updatePayload = {
              name: payload.name,
              target_books: payload.target_books,
              is_fixed: payload.is_fixed
            };
            if (payload.is_fixed) {
              updatePayload.start_date = payload.start_date;
              updatePayload.end_date = payload.end_date;
            }
            const syncRes = await state.supabase
              .from("reading_plans")
              .update(updatePayload)
              .eq("global_plan_id", plan.id);
            if (syncRes.error) {
              console.error("Failed to sync updates to user reading_plans:", syncRes.error);
            }
          }
        } else {
          const res = await state.supabase
            .from("global_plans")
            .insert(payload);
          error = res.error;
        }

        if (error) {
          console.error("Failed to save global plan in Supabase:", error);
          showToast(`儲存計畫失敗: ${error.message || error}`);
          return false;
        }
      } catch (e) {
        console.error("Error saving global plan in Supabase:", e);
        showToast(`儲存計畫出錯: ${e.message || e}`);
        return false;
      }
    } else {
      // LocalStorage mode — only persist CUSTOM plans (presets are always injected by loadGlobalPlans)
      const presetKeys = Object.keys(CHURCH_PLAN_PRESETS);
      const localGlobal = localStorage.getItem("global_plans_presets");
      let list = localGlobal ? JSON.parse(localGlobal) : [];
      // Strip preset entries from the stored list so we only track custom plans
      list = list.filter(p => !presetKeys.includes(p.presetKey) && !presetKeys.includes(p.id));
      if (plan.id && !presetKeys.includes(plan.id)) {
        list = list.map(p => p.id === plan.id ? plan : p);
      } else if (!plan.id) {
        plan.id = "local_" + Date.now();
        plan.presetKey = plan.id;
        list.push(plan);
      }
      localStorage.setItem("global_plans_presets", JSON.stringify(list));
    }

    this._userDataPromise = null; // 💡 關鍵修復：清除資料加載快取以使快取失效
    await this.loadGlobalPlans();
    return true;
  },

  async setGlobalPlanHidden(plan, isHidden) {
    const key = String(plan.id || plan.globalPlanId || plan.presetKey || "");
    if (!key) return false;

    const usesRemoteDatabase = state.isSupabaseMode
      && state.supabase
      && !(state.currentUser && state.currentUser.is_demo)
      && key.includes("-");

    if (usesRemoteDatabase) {
      try {
        const { data, error } = await state.supabase
          .from("global_plans")
          .update({ is_hidden: Boolean(isHidden) })
          .eq("id", key)
          .select("id, is_hidden")
          .maybeSingle();

        if (error || !data || Boolean(data.is_hidden) !== Boolean(isHidden)) {
          console.error("Global plan visibility update was not verified:", error || data);
          return false;
        }
      } catch (error) {
        console.error("Global plan visibility update failed:", error);
        return false;
      }
    } else {
      let overrides = {};
      try {
        const stored = JSON.parse(localStorage.getItem("global_plan_visibility_overrides") || "{}");
        if (stored && typeof stored === "object" && !Array.isArray(stored)) overrides = stored;
      } catch (error) {
        overrides = {};
      }
      overrides[key] = Boolean(isHidden);
      localStorage.setItem("global_plan_visibility_overrides", JSON.stringify(overrides));

      // Keep the previous hidden-key storage synchronized for older app versions.
      const hiddenKeys = JSON.parse(localStorage.getItem("hidden_global_plan_keys") || "[]");
      const nextHiddenKeys = isHidden
        ? Array.from(new Set([...hiddenKeys, key]))
        : hiddenKeys.filter(item => item !== key);
      localStorage.setItem("hidden_global_plan_keys", JSON.stringify(nextHiddenKeys));
    }

    if (state.globalPlans) {
      state.globalPlans = state.globalPlans.map(item => {
        const matches = [item.id, item.presetKey, item.globalPlanId].filter(Boolean).map(String).includes(key);
        return matches ? { ...item, isHidden: Boolean(isHidden), is_hidden: Boolean(isHidden) } : item;
      });
    }

    this._userDataPromise = null;
    await this.loadGlobalPlans();
    const refreshedPlan = (state.globalPlans || []).find(item =>
      [item.id, item.presetKey, item.globalPlanId].filter(Boolean).map(String).includes(key)
    );
    return Boolean(refreshedPlan) && isPlanHidden(refreshedPlan) === Boolean(isHidden);
  },

  async deleteGlobalPlan(planId) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      try {
        const { error } = await state.supabase
          .from("global_plans")
          .delete()
          .eq("id", planId);

        if (error) {
          console.error("Failed to delete global plan in Supabase:", error);
          showToast(`刪除計畫失敗: ${error.message || error}`);
          return false;
        }
      } catch (e) {
        console.error("Error deleting global plan in Supabase:", e);
        showToast(`刪除計畫出錯: ${e.message || e}`);
        return false;
      }
    } else {
      // LocalStorage mode
      const localGlobal = localStorage.getItem("global_plans_presets");
      if (localGlobal) {
        let list = JSON.parse(localGlobal);
        list = list.filter(p => p.id !== planId);
        localStorage.setItem("global_plans_presets", JSON.stringify(list));
      }
    }

    this._userDataPromise = null; // 💡 關鍵修復：清除資料加載快取以使快取失效
    await this.loadGlobalPlans();
    return true;
  },

  async fetchAnnouncements() {
    const CACHE_KEY = "church_announcements";
    const CACHE_TS_KEY = "church_announcements_fetched_at";
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分鐘內不重新拉取

    // 共用：從 localStorage 讀取快取公告
    const getLocalCache = () => {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    };

    // 共用：預設公告（全部快取失效時的退退模式）
    const FALLBACK_DEFAULT = [
      {
        id: 'default-welcome',
        title: '歡迎使用速讀挑戰系統！',
        content: '親愛的弟兄姊妹平安，歡迎加入教會季度速讀挑戰。讓我們一起藉著每日讀經，更加認識神、親近神！如有任何問題，請洽詢教會同工。',
        created_at: new Date().toISOString()
      }
    ];

    if (state.isSupabaseMode && state.supabase) {
      // 如果快取尚在 TTL 內，直接回傳 localStorage 中的版本
      const cachedTs = Number(localStorage.getItem(CACHE_TS_KEY) || 0);
      if (Date.now() - cachedTs < CACHE_TTL_MS) {
        const cached = getLocalCache();
        if (cached && cached.length > 0) return cached;
      }

      try {
        const { data, error } = await state.supabase
          .from('church_announcements')
          .select('id, title, content, is_published, published_at, created_at, updated_at')
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) {
          const isDegraded =
            error?.code === 'SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED' ||
            String(error?.message).toLowerCase().includes('503') ||
            String(error?.message).toLowerCase().includes('unavailable');
          if (isDegraded) {
            console.warn("[Announcements] Edge Runtime 暫時中斷，使用本地快取公告");
          } else {
            console.error("Error fetching announcements from Supabase:", error);
          }
          return getLocalCache() || FALLBACK_DEFAULT;
        }

        const result = data || [];
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(result));
          localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
        } catch { /* localStorage 滿了時靜默失效 */ }
        return result;

      } catch (e) {
        const isDegraded =
          String(e?.message).includes('503') ||
          String(e?.message).toLowerCase().includes('unavailable');
        if (isDegraded) {
          console.warn("[Announcements] Edge Runtime 503，從本地快取讀取公告");
        } else {
          console.error("Error fetching announcements:", e);
        }
        return getLocalCache() || FALLBACK_DEFAULT;
      }
    } else {
      return getLocalCache() || FALLBACK_DEFAULT;
    }
  },

  async saveAnnouncement(title, content) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      try {
        const user = await this.getCurrentDbUser();
        const userId = user ? user.id : (state.currentUser ? state.currentUser.id : null);
        const { error } = await state.supabase
          .from('church_announcements')
          .insert([{ title, content, created_by: userId }]);
        if (error) {
          console.error("Error saving announcement in Supabase:", error);
          showToast(`發布公告失敗: ${error.message || error}`);
          return false;
        }
        return true;
      } catch (e) {
        console.error("Error saving announcement:", e);
        return false;
      }
    } else {
      const current = await this.fetchAnnouncements();
      const newAnn = {
        id: Date.now().toString(),
        title,
        content,
        created_at: new Date().toISOString()
      };
      current.unshift(newAnn);
      localStorage.setItem("church_announcements", JSON.stringify(current));
      return true;
    }
  },

  async deleteAnnouncement(id) {
    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      try {
        const { error } = await state.supabase
          .from('church_announcements')
          .delete()
          .eq('id', id);
        if (error) {
          console.error("Error deleting announcement in Supabase:", error);
          showToast(`刪除公告失敗: ${error.message || error}`);
          return false;
        }
        return true;
      } catch (e) {
        console.error("Error deleting announcement:", e);
        return false;
      }
    } else {
      let current = await this.fetchAnnouncements();
      current = current.filter(a => a.id !== id);
      localStorage.setItem("church_announcements", JSON.stringify(current));
      return true;
    }
  },

  async getFeatureSetting(key, fallback = false) {
    const allowedKeys = new Set(["pastoral_sharing_wall", "daily_quiz"]);
    if (!allowedKeys.has(key)) {
      return { enabled: Boolean(fallback), error: new Error("unknown_feature_setting") };
    }

    if (state.isSupabaseMode && state.supabase && !(state.currentUser && state.currentUser.is_demo)) {
      try {
        const { data, error } = await state.supabase
          .from("app_feature_settings")
          .select("key, enabled")
          .eq("key", key)
          .maybeSingle();
        if (error) return { enabled: Boolean(fallback), error };
        return { enabled: data ? data.enabled === true : Boolean(fallback), error: null };
      } catch (error) {
        return { enabled: Boolean(fallback), error };
      }
    }

    const stored = localStorage.getItem(`nlc_feature_${key}`);
    return {
      enabled: stored === null ? Boolean(fallback) : stored === "true",
      error: null
    };
  },

  async updateFeatureSetting(key, enabled) {
    const allowedKeys = new Set(["pastoral_sharing_wall", "daily_quiz"]);
    if (!allowedKeys.has(key)) return { error: new Error("unknown_feature_setting") };
    if (!state.currentUser || getUserRoleCode(state.currentUser) !== "admin") {
      return { error: new Error("admin_required") };
    }

    const normalized = enabled === true;
    if (state.isSupabaseMode && state.supabase && !state.currentUser.is_demo) {
      try {
        const { data, error } = await state.supabase
          .from("app_feature_settings")
          .upsert({
            key,
            enabled: normalized,
            updated_by: state.currentProfileId || state.currentUser.id || null
          }, { onConflict: "key" })
          .select("key, enabled")
          .single();
        if (error) return { error };
        return { data, error: null };
      } catch (error) {
        return { error };
      }
    }

    localStorage.setItem(`nlc_feature_${key}`, String(normalized));
    return { data: { key, enabled: normalized }, error: null };
  },

  async fetchCareReminders() {
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' ||
                        hostname === '::1' || hostname.startsWith('192.168.') ||
                        hostname.startsWith('10.') || hostname.startsWith('172.') ||
                        hostname.endsWith('.local');

    // 🔒 安全防護：虛擬關心提醒資料僅限 localhost 測試環境
    if (state.currentUser && state.currentUser.is_demo) {
      if (!isLocalhost) {
        // Production demo mode: never expose mock care data
        return { data: [], error: null };
      }
      // localhost + demo: use getMockCareReminders() from mock_stats.js
      if (typeof window.getMockCareReminders === 'function') {
        return { data: window.getMockCareReminders(), error: null };
      }
      return { data: [], error: null };
    }

    // Real Supabase mode
    if (state.isSupabaseMode && state.supabase) {
      try {
        const profileId = state.currentProfileId;
        if (!profileId) return { data: [], error: null };
        const { data, error } = await state.supabase
          .from("care_reminders")
          .select(`
            id,
            reason,
            message,
            status,
            sent_on,
            plan_key,
            sender:profiles!sender_id (
              name,
              role_id,
              role_definition:role_definitions!profiles_role_definition_fkey (code, label)
            )
          `)
          .eq("recipient_id", profileId)
          .eq("status", "unread")
          .order("created_at", { ascending: false });
        return { data: data || [], error };
      } catch (e) {
        return { data: [], error: e };
      }
    }
    return { data: [], error: null };
  },

  async acknowledgeCareReminder(reminderId) {
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' ||
                        hostname === '::1' || hostname.startsWith('192.168.') ||
                        hostname.startsWith('10.') || hostname.startsWith('172.') ||
                        hostname.endsWith('.local');

    if (state.currentUser && state.currentUser.is_demo) {
      if (isLocalhost && typeof window.dismissMockCareReminder === 'function') {
        window.dismissMockCareReminder(reminderId);
      }
      return { error: null };
    } else if (state.isSupabaseMode && state.supabase) {
      try {
        const { error } = await state.supabase
          .from("care_reminders")
          .update({ status: "read", read_at: new Date().toISOString() })
          .eq("id", reminderId);
        return { error };
      } catch (e) {
        return { error: e };
      }
    }
    return { error: null };
  },

  async fetchAllNotifications() {
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' ||
                        hostname === '::1' || hostname.startsWith('192.168.') ||
                        hostname.startsWith('10.') || hostname.startsWith('172.') ||
                        hostname.endsWith('.local');

    if (state.currentUser && state.currentUser.is_demo) {
      if (!isLocalhost) {
        return { data: [], error: null };
      }
      if (typeof window.getMockCareReminders === 'function') {
        return { data: window.getMockCareReminders(), error: null };
      }
      return { data: [], error: null };
    }

    if (state.isSupabaseMode && state.supabase) {
      try {
        const profileId = state.currentProfileId;
        if (!profileId) return { data: [], error: null };
        const { data, error } = await state.supabase
          .from("care_reminders")
          .select(`
            id,
            reason,
            message,
            status,
            sent_on,
            plan_key,
            sender:profiles!sender_id (
              name,
              role_id,
              role_definition:role_definitions!profiles_role_definition_fkey (code, label)
            )
          `)
          .eq("recipient_id", profileId)
          .order("created_at", { ascending: false })
          .limit(20);
        return { data: data || [], error };
      } catch (e) {
        return { data: [], error: e };
      }
    }
    return { data: [], error: null };
  },

  async acknowledgeAllCareReminders() {
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' ||
                        hostname === '::1' || hostname.startsWith('192.168.') ||
                        hostname.startsWith('10.') || hostname.startsWith('172.') ||
                        hostname.endsWith('.local');

    if (state.currentUser && state.currentUser.is_demo) {
      if (isLocalhost && typeof window.getMockCareReminders === 'function') {
        const mockData = window.getMockCareReminders();
        if (Array.isArray(mockData)) {
          mockData.forEach(item => {
            if (typeof window.dismissMockCareReminder === 'function') {
              window.dismissMockCareReminder(item.id);
            }
          });
        }
      }
      return { error: null };
    }

    if (state.isSupabaseMode && state.supabase) {
      try {
        const profileId = state.currentProfileId;
        if (!profileId) return { error: new Error("未登入") };
        const { error } = await state.supabase
          .from("care_reminders")
          .update({ status: "read", read_at: new Date().toISOString() })
          .eq("recipient_id", profileId)
          .eq("status", "unread");
        return { error };
      } catch (e) {
        return { error: e };
      }
    }
    return { error: null };
  },

  // 💌 sendCareReminder – 領袖對組員傳送關心提醒
  // recipientId: 收件人 profile ID (UUID)
  // reason: 'behind' | 'inactive' | 'care' | 'encouragement'
  // message: 關心訊息文字 (最多 300 字)
  // planKey: 計畫識別碼 (presetKey 或 globalPlanId)
  async sendCareReminder({ recipientId, reason, message, planKey = "" }) {
    // 輸入驗證
    const validReasons = ["behind", "inactive", "care", "encouragement"];
    if (!recipientId || typeof recipientId !== "string" || !recipientId.trim()) {
      return { error: new Error("收件人 ID 不可為空") };
    }
    if (!validReasons.includes(reason)) {
      return { error: new Error(`無效的關心原因：${reason}`) };
    }
    const trimmedMsg = String(message || "").trim();
    if (!trimmedMsg) {
      return { error: new Error("關心訊息不可為空") };
    }
    if (trimmedMsg.length > 300) {
      return { error: new Error("訊息不能超過 300 字") };
    }

    // Demo 模式：僅模擬，不真正寫入
    if (state.currentUser && state.currentUser.is_demo) {
      console.info("[Demo] sendCareReminder (simulated):", { recipientId, reason, message: trimmedMsg });
      return { error: null };
    }

    // 生產模式：透過 nlc-data 的 send_care_reminder action 安全送出（server 端強制 sender_id）
    if (state.isSupabaseMode && state.supabase) {
      try {
        if (typeof auth === "undefined" || !auth.isLoggedIn()) {
          return { error: new Error("請先登入後再傳送關心提醒") };
        }
        const cfg = state.supabaseConfig || {};
        const accessToken = await auth.getValidAccessToken();
        const response = await fetch(
          cfg.url.replace(/\/+$/, "") + "/functions/v1/nlc-data",
          {
            method: "POST",
            headers: {
              apikey: cfg.anonKey,
              Authorization: "Bearer " + accessToken,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              action: "send_care_reminder",
              payload: {
                recipient_id: recipientId,
                reason: reason,
                message: trimmedMsg,
                plan_key: String(planKey || "")
              }
            })
          }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (payload.code === "23505" || response.status === 409) {
            return { error: new Error("今日已傳送過關心提醒給此成員，明日再試") };
          }
          if (response.status === 403 || payload.code === "42501" || (payload.error && payload.error.includes("policy"))) {
            return { error: new Error("此成員不在您的牧養範圍內") };
          }
          return { error: new Error(payload.error || "傳送失敗") };
        }
        return { error: null };
      } catch (e) {
        return { error: e };
      }
    }
    return { error: new Error("目前為離線模式，無法傳送關心提醒") };
  },

  // 📊 syncRegistrationStatisticsToSheet – 將報名與註冊統計覆寫到 Google 試算表
  // 透過 nlc-data 的 sync_registration_stats_sheet action（server 端驗證 admin 身分後轉發到 Apps Script Web App）
  async syncRegistrationStatisticsToSheet({ planName, greatRegions, pastoralZones, summary } = {}) {
    if (state.currentUser && state.currentUser.is_demo) {
      return { success: false, message: "示範模式無法同步至 Google 試算表。" };
    }
    if (typeof auth === "undefined" || !auth.isLoggedIn()) {
      return { success: false, message: "請先登入後再試。" };
    }
    try {
      const cfg = state.supabaseConfig || {};
      const accessToken = await auth.getValidAccessToken();
      const response = await fetch(
        cfg.url.replace(/\/+$/, "") + "/functions/v1/nlc-data",
        {
          method: "POST",
          headers: {
            apikey: cfg.anonKey,
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            action: "sync_registration_stats_sheet",
            payload: {
              plan_name: String(planName || ""),
              great_regions: Array.isArray(greatRegions) ? greatRegions : [],
              pastoral_zones: Array.isArray(pastoralZones) ? pastoralZones : [],
              summary: summary || {}
            }
          })
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { success: false, message: result.error || "更新到 Google 試算表失敗" };
      }
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message || "更新到 Google 試算表失敗" };
    }
  }
};

window.db = db;
