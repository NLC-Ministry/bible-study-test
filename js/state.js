// Global configuration presets, state object, router, loader, theme switcher, and local settings loader.

// 9 Categories of Bible Books
const BIBLE_CATEGORIES = {
  cat1: { name: "摩西五經", books: ["創世記", "出埃及記", "利未記", "民數記", "申命記"] },
  cat2: { name: "歷史書", books: ["約書亞記", "士師記", "路得記", "撒母耳記上", "撒母耳記下", "列王紀上", "列王紀下", "歷代志上", "歷代志下", "以斯拉記", "尼希米記", "以斯帖記"] },
  cat3: { name: "詩歌智慧書", books: ["約伯記", "詩篇 1-110", "詩篇 111-150", "箴言", "傳道書", "雅歌"] },
  cat4: { name: "大先知書", books: ["以賽亞書", "耶利米書", "耶利米哀歌", "以西結書", "但以理書"] },
  cat5: { name: "小先知書", books: ["何西阿書", "約珥書", "阿摩司書", "俄巴底亞書", "約拿書", "彌迦書", "那鴻書", "哈巴谷書", "西番雅書", "哈該書", "撒迦利亞書", "瑪拉基書"] },
  cat6: { name: "福音書+徒", books: ["馬太福音", "馬可福音", "路加福音", "約翰福音", "使徒行傳"] },
  cat7: { name: "保羅書信一", books: ["羅馬書", "哥林多前書", "哥林多後書", "加拉太書", "以弗所書", "腓立比書"] },
  cat8: { name: "保羅書信二", books: ["歌羅西書", "帖撒羅尼迦前書", "帖撒羅尼迦後書", "提摩太前書", "提摩太後書", "提多書", "腓利門書"] },
  cat9: { name: "普通書信+啟", books: ["希伯來書", "雅各書", "彼得前書", "彼得後書", "約翰一書", "約翰二書", "約翰三書", "猶大書", "啟示錄"] }
};

window.BIBLE_CATEGORIES = BIBLE_CATEGORIES;

const defaultChurchCampaign = window.cloneChurchCampaign();
const defaultChurchStagePlans = window.createChurchCampaignStageDefinitions(defaultChurchCampaign);
const CHURCH_PLAN_PRESETS = Object.fromEntries(defaultChurchStagePlans.map(stage => [
  stage.presetKey,
  {
    id: stage.id,
    parentCampaignId: stage.parentCampaignId,
    name: stage.name,
    description: stage.description,
    startDate: stage.startDate,
    endDate: stage.endDate,
    books: stage.books,
    planKind: "church_campaign_stage",
    isFixed: true,
    isHidden: stage.isHidden,
    discoverWhenLocked: stage.discoverWhenLocked,
    stageNo: stage.stageNo,
    roundNo: stage.roundNo,
    phase: stage.phase,
    awardName: stage.awardName,
    examDate: stage.examDate,
    campaignDefinition: stage
  }
]));
// 💡 0毫秒秒開優化：讀取首屏 Profile 本地快照
let initialCachedUser = {
  name: "",
  great_region: "",
  pastoral_zone: "",
  small_group: "",
  role_id: null,
  role_definition: null,
  chapters_read: 0,
  plan_progress: 0,
  streak: 0,
  last_read: null,
  member_context_synced_at: "",
  member_context_sync_attempted_at: "",
  member_context_sync_status: "",
  member_context_sync_error: "",
  member_context_contract_version: "",
  member_context_membership_lifecycle_state: "",
  member_context_placement_state: "",
  member_context_placement_workflow_state: "",
  member_context_has_required_placement: "",
  member_context_required_action: "",
  member_context_required_action_url: ""
};
try {
  const profileRaw = localStorage.getItem("cached_user_profile");
  if (profileRaw) {
    const parsedProfile = JSON.parse(profileRaw);
    if (parsedProfile && parsedProfile.name) {
      Object.assign(initialCachedUser, parsedProfile);
    }
  }
} catch (e) {
  console.warn("Fast startup cache read skipped:", e);
}

// Global Application State
const state = {
  theme: "light",
  isSupabaseMode: false,
  offlineMode: false,
  supabase: null,

  roleDefinitions: [], // Supabase role definitions, keyed by immutable UUID
  /** True while profile tab / boot is waiting on Member Hub identity sync */
  profileIdentityLoading: false,
  currentUser: initialCachedUser,
  globalPlans: [],
  orgStructure: {
    regions: [],
    zones: {},  // regionName -> array of zoneNames
    groups: {}  // zoneName -> array of groupNames
  },
  activePlan: null,
  planDetailOpen: false,
  activePlans: [], // Array of multiple joined plans
  readingLogs: [], // Array of { book: string, chapter: number, read_at: string, plan_id?: string, presetKey?: string }
  readerState: {
    bookId: 1, // Genesis
    chapter: 1,
    fontSize: 20,
    selectedVerseNum: null
  },
  speechSettings: (() => {
    try {
      const raw = localStorage.getItem("nlc_speech_settings");
      return raw ? JSON.parse(raw) : { rate: 1.0, gender: "auto", voiceURI: "" };
    } catch (_e) {
      return { rate: 1.0, gender: "auto", voiceURI: "" };
    }
  })(),
  highlights: {}, // Mapping of "Book_Chapter_Verse" to color hex
  highlightTimestamps: {}, // Mapping of "Book_Chapter_Verse" to ISO timestamp, for "我的螢光＆筆記" recency sort only
  verseNotes: {}, // Mapping of "Book_Chapter_Verse" to note content, for the currently loaded chapter only
  profileDetailOpen: null, // null = profile-view root menu; otherwise the open subpage key ("highlights-notes"/"exams"/"badges"/"preferences")
  statsCharts: {
    rank: null,
    progress: null,
    group: null,
    growth: null
  }
};

function getUserRoleCode(user = state.currentUser) {
  if (typeof user === "string") return user;
  if (!user) return "member";
  const leadershipLabel = String(user.member_context_leadership_display_label || "").trim();
  if (leadershipLabel === "組織架構管理員" || leadershipLabel.includes("系統管理員") || leadershipLabel.includes("組織架構管理員")) {
    return "admin";
  }
  if (leadershipLabel === "教會牧者" || leadershipLabel.includes("主任牧師") || leadershipLabel.includes("教會牧者") || leadershipLabel.includes("牧者")) {
    return "pastor";
  }
  if (leadershipLabel === "大區長" || leadershipLabel.includes("大區同工")) {
    return "great_zone_leader";
  }
  if (leadershipLabel === "區長" || leadershipLabel.includes("牧區長") || leadershipLabel.includes("區同工")) {
    return "zone_leader";
  }
  if (leadershipLabel === "小組長" || leadershipLabel.includes("副小組長") || leadershipLabel.includes("小組同工")) {
    return "group_leader";
  }

  const HARDCODED_ROLES = {
    "10000000-0000-4000-8000-000000000001": "member",
    "10000000-0000-4000-8000-000000000002": "group_leader",
    "10000000-0000-4000-8000-000000000003": "zone_leader",
    "10000000-0000-4000-8000-000000000004": "great_zone_leader",
    "10000000-0000-4000-8000-000000000005": "pastor",
    "10000000-0000-4000-8000-000000000006": "admin"
  };
  const roleId = String(user.role_id || "").toLowerCase();
  return user.role_definition?.code
    || (roleId ? HARDCODED_ROLES[roleId] : null)
    || getRoleDefinition(user.role_id)?.code
    || user.role_code
    || user.role
    || "member";
}

function hasWholeChurchPlanScope(userOrRole = state.currentUser) {
  const role = getUserRoleCode(userOrRole);
  return role === "admin" || role === "pastor";
}

function getRoleDefinition(roleOrId) {
  const value = String(roleOrId || "").trim();
  return (state.roleDefinitions || []).find(definition =>
    definition.id === value || definition.code === value
  ) || null;
}

function getRoleLabel(roleOrId) {
  const definition = getRoleDefinition(roleOrId);
  return definition?.label || String(roleOrId || "");
}

function getActivePlanContextId(plan = state.activePlan) {
  if (!plan) return null;
  return plan.id || plan.globalPlanId || plan.presetKey || null;
}

function syncActivePlanContext(plan = state.activePlan) {
  const planId = getActivePlanContextId(plan);
  window.currentActivePlanId = planId;
  window.currentActivePlanKey = planId ? (plan.presetKey || plan.globalPlanId || plan.id || null) : null;
  return planId;
}

function findPlanByContextId(planId) {
  if (!planId) return state.activePlan || null;
  return (state.activePlans || []).find(plan =>
    plan.id === planId ||
    plan.globalPlanId === planId ||
    plan.presetKey === planId
  ) || null;
}
// Router for Switching Views
const appRouter = {
  currentTab: "dashboard-view",
  tabScrollPositions: Object.create(null),
  isTabTransitioning: false,

  getScrollContainer() {
    return document.querySelector(".main-content") || document.scrollingElement || window;
  },

  getScrollTop() {
    const container = this.getScrollContainer();
    if (container === window) return window.scrollY || 0;
    return Number(container && container.scrollTop) || 0;
  },

  captureTabScroll(tabId = this.currentTab) {
    if (!tabId) return;
    this.tabScrollPositions[tabId] = this.getScrollTop();
  },

  prefersReducedMotion() {
    return typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  },

  setScrollTop(top, behavior = "auto") {
    const container = this.getScrollContainer();
    const resolvedBehavior = this.prefersReducedMotion() ? "auto" : behavior;
    const position = Math.max(0, Number(top) || 0);

    if (container && typeof container.scrollTo === "function") {
      container.scrollTo({ top: position, behavior: resolvedBehavior });
    } else if (container && container !== window) {
      container.scrollTop = position;
    } else if (typeof window.scrollTo === "function") {
      window.scrollTo({ top: position, behavior: resolvedBehavior });
    }
  },

  restoreTabScroll(tabId) {
    const position = this.tabScrollPositions[tabId] || 0;
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.setScrollTop(position, "auto");
          resolve();
        });
      });
    });
  },

  scrollActiveTabToTop(options = {}) {
    const behavior = options.behavior || "smooth";
    this.tabScrollPositions[this.currentTab] = 0;
    this.setScrollTop(0, behavior);
  },

  isTabAtRoot(tabId) {
    if (tabId === "plan-view") {
      const route = String(window.currentPlanViewState || "LIST").toUpperCase();
      const inlineReaderOpen = !!(state.inlineReader && state.inlineReader.active);
      return route === "LIST" && !state.planDetailOpen && !inlineReaderOpen;
    }

    if (tabId === "profile-view") {
      const badgeDetail = document.getElementById("badge-detail-page");
      const badgeDetailOpen = !!(badgeDetail && !badgeDetail.classList.contains("hidden"));
      return !badgeDetailOpen && !state.profileDetailOpen;
    }

    return true;
  },

  async resetTabToRoot(tabId) {
    if (tabId === "plan-view") {
      if (state.inlineReader && state.inlineReader.active && typeof window.closePlanInlineReader === "function") {
        window.closePlanInlineReader();
      }

      if (typeof window.setPlanState === "function") {
        await window.setPlanState("LIST");
      } else {
        window.currentPlanViewState = "LIST";
        state.planDetailOpen = false;
        if (typeof window.renderPlanView === "function") await window.renderPlanView();
      }
      return;
    }

    if (tabId === "profile-view") {
      if (typeof window.closeBadgeDetailPage === "function") window.closeBadgeDetailPage();
      if (typeof window.closeProfileDetail === "function") window.closeProfileDetail();
    }
  },

  async handleTabClick(tabId) {
    if (!tabId) return;
    if (this.isTabTransitioning) return;

    if (tabId !== this.currentTab) {
      await this.switchTab(tabId, { fromTabBar: true, restoreTabScroll: true });
      return;
    }

    if (!this.isTabAtRoot(tabId)) {
      await this.resetTabToRoot(tabId);
      this.scrollActiveTabToTop({ behavior: "auto" });
      return;
    }

    this.scrollActiveTabToTop({ behavior: "smooth" });
  },

  init() {
    const tabs = document.querySelectorAll(".tab-btn, .mobile-nav-btn");
    tabs.forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const target = btn.getAttribute("data-target");
        if (target) {
          this.handleTabClick(target);
        }
      });
    });

    const backBtn = document.getElementById("global-back-btn");
    if (backBtn) {
      backBtn.addEventListener("click", (e) => {
        e.preventDefault();
        this.goBack();
      });
    }

    const brandLogo = document.getElementById("brand-logo");
    if (brandLogo) {
      brandLogo.addEventListener("click", (e) => {
        e.preventDefault();
        this.switchTab("dashboard-view");
      });
    }

    // top-bar-back-btn is handled via inline onclick; plan detail tabs are controlled by PlanPageController.

    this.updateNavigationChrome();
  },

  getTabLabel(tabId) {
    const labels = {
      "dashboard-view": "首頁",
      "reader-view": "讀經",
      "plan-view": "計畫",
      "stats-view": "統計",
      "profile-view": "個人",
      "admin-view": "管理"
    };
    return labels[tabId] || "首頁";
  },

  updateNavigationChrome() {
    const backBtn = document.getElementById("global-back-btn");
    const backLabel = document.getElementById("global-back-label");
    const brandLogo = document.getElementById("brand-logo");
    const titleEl = document.querySelector(".brand-text");
    
    const topBarBackBtn = document.getElementById("top-bar-back-btn");
    const topBarGroupTrigger = document.getElementById("top-bar-group-trigger");
    const topBarPlanName = document.getElementById("top-bar-plan-name");
    const topBarSubMode = document.getElementById("top-bar-sub-mode");

    const isPlanDetail = this.currentTab === "plan-view" && state.activePlan && state.planDetailOpen;

    if (isPlanDetail) {
      // Hide brand mark and normal back button
      if (brandLogo) brandLogo.style.display = "none";
      if (backBtn) backBtn.style.display = "none";
      if (titleEl) titleEl.style.display = "none";

      // Show plan specific navigation elements
      if (topBarBackBtn) {
        topBarBackBtn.style.display = "flex";
        topBarBackBtn.classList.remove("hidden");
      }
      if (topBarGroupTrigger) {
        topBarGroupTrigger.style.display = "none";
        topBarGroupTrigger.classList.add("hidden");
      }
      if (topBarPlanName && state.activePlan) {
        topBarPlanName.textContent = state.activePlan.name;

        topBarPlanName.style.display = "block";
        topBarPlanName.classList.remove("hidden");
      }
      if (topBarSubMode) topBarSubMode.innerHTML = "";
    } else {
      // Show brand mark and normal back button
      if (brandLogo) brandLogo.style.display = "";
      if (backBtn) backBtn.style.display = "";
      if (titleEl) {
        titleEl.style.display = "";
        titleEl.textContent = this.getTabLabel(this.currentTab);
      }

      // Hide plan specific navigation elements
      if (topBarBackBtn) {
        topBarBackBtn.style.display = "none";
        topBarBackBtn.classList.add("hidden");
      }
      if (topBarGroupTrigger) {
        topBarGroupTrigger.style.display = "none";
        topBarGroupTrigger.classList.add("hidden");
      }
      if (topBarPlanName) {
        topBarPlanName.style.display = "none";
        topBarPlanName.classList.add("hidden");
      }
    }

    // Every joined plan detail exposes the same top-right options menu.
    const optionsContainer = document.getElementById("global-plan-options-container");
    if (optionsContainer) {
      optionsContainer.classList.toggle("hidden", !isPlanDetail);
      optionsContainer.hidden = !isPlanDetail;
      optionsContainer.style.display = isPlanDetail ? "flex" : "none";
      if (!isPlanDetail) {
        const dropdown = document.getElementById("plan-options-dropdown");
        if (dropdown) dropdown.classList.add("hidden");
      }
    }

    const isReaderPage = this.currentTab === "reader-view";
    document.body.classList.toggle("reader-page", isReaderPage);
    const appLayout = document.querySelector(".app-layout");
    if (appLayout) appLayout.classList.toggle("reader-mode", isReaderPage);
    
    // In reader-view: do NOT hard-hide the nav bar here.
    // bible.js scroll handler adds/removes body.reader-nav-hidden which controls
    // visibility via CSS (see .reader-nav-hidden .mobile-nav-bar rule).
    // On tap the nav bar reappears — that behaviour lives entirely in CSS+bible.js.
    const mobileNavBar = document.querySelector(".mobile-nav-bar");
    if (mobileNavBar) {
      mobileNavBar.setAttribute("aria-hidden", isReaderPage ? "true" : "false");
    }
    if (!backBtn || !backLabel) return;

    // 管理分頁的手機 drill-in：子頁打開時，頂 bar 顯示返回鍵、標題換成該功能名。
    const isAdminSectionDrill = this.currentTab === "admin-view"
      && document.body.classList.contains("admin-section-open");
    if (isAdminSectionDrill && titleEl) {
      titleEl.style.display = "";
      titleEl.textContent = window.__adminSectionLabel || "管理";
    }

    // Back button rules:
    // - reader-view: always show (returns to previous tab)
    // - admin-view + drill-in: show (returns to the function list)
    // - plan-detail: hidden here (handled by topBarBackBtn above)
    // - all other tabs: HIDE — bottom nav handles all tab switching
    const showBackBtn = isReaderPage || isAdminSectionDrill;
    backBtn.classList.toggle("is-home", !showBackBtn);
    backBtn.style.display = showBackBtn ? "" : "none";
    backLabel.textContent = "返回";
    backBtn.title = "返回上一層";
  },

  goBack() {
    // 管理分頁手機 drill-in：返回鍵先關子頁、回功能清單。
    if (this.currentTab === "admin-view" && document.body.classList.contains("admin-section-open")) {
      if (typeof window.closeAdminSection === "function") window.closeAdminSection();
      else document.body.classList.remove("admin-section-open");
      this.updateNavigationChrome();
      return;
    }

    if (this.currentTab === "reader-view") {
      if (state.readerState && state.readerState.returnTab === "plan-view") {
        state.readerState.returnTab = null;
        this.switchTab("plan-view", { keepPlanDetail: true });
        return;
      }
    }

    if (this.currentTab === "plan-view") {
      if (state.inlineReader && state.inlineReader.active && typeof window.closePlanInlineReader === "function") {
        window.closePlanInlineReader();
        this.updateNavigationChrome();
        return;
      }

      if (state.activePlan && state.planDetailOpen) {
        state.planDetailOpen = false;
        // Directly await renderPlanView so chrome update happens AFTER render.
        if (typeof window.renderPlanView === "function") {
          window.renderPlanView().then(() => {
            this.updateNavigationChrome();
          });
        } else {
          this.updateNavigationChrome();
        }
        return;
      }
    }

    if (this.currentTab !== "dashboard-view") {
      this.switchTab("dashboard-view");
      return;
    }

    if (typeof updateDashboardView === "function") updateDashboardView();
    this.updateNavigationChrome();
  },

  switchTab(tabId, options = {}) {
    // ── DELEGATE to the async switchTab override in app.js ──
    // The async version in app.js handles: module loading, full render await,
    // and the single authoritative updateNavigationChrome() call.
    // This sync stub exists only for backwards-compatibility with any legacy
    // code that calls appRouter.switchTab synchronously before app.js loads.
    if (typeof appRouter.switchTab === 'function' && appRouter.switchTab !== this.switchTab) {
      return appRouter.switchTab(tabId, options);
    }

    // Fallback (should never be reached in production):
    this.currentTab = tabId;
    this.updateNavigationChrome();
  }
};

// Loader helpers — full-screen overlay removed; use in-place skeletons instead.
const loader = {
  show() {},
  hide() {}
};

// Theme Management
function setBodyThemeClass(themeName) {
  document.body.classList.remove("light-theme", "warm-theme", "dark-theme", "dark");
  document.body.classList.add(themeName + "-theme");
  if (themeName === "dark") {
    document.body.classList.add("dark");
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function applyAppTheme(themeName) {
  const allowedThemes = new Set(["light", "warm", "dark"]);
  const nextTheme = allowedThemes.has(themeName) ? themeName : "light";
  state.theme = nextTheme;
  setBodyThemeClass(nextTheme);
  const isReaderPage = window.appRouter && window.appRouter.currentTab === "reader-view";
  document.body.classList.toggle("reader-page", Boolean(isReaderPage));
  const appLayout = document.querySelector(".app-layout");
  if (appLayout) appLayout.classList.toggle("reader-mode", Boolean(isReaderPage));
  localStorage.setItem("app_theme", nextTheme);

  document.querySelectorAll("[data-profile-theme]").forEach(button => {
    const isActive = button.dataset.profileTheme === nextTheme;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-checked", String(isActive));
  });
  document.querySelectorAll("#reader-settings-dropdown .theme-btn, .theme-option").forEach(button => {
    button.classList.toggle("active", button.dataset.theme === nextTheme);
  });
  if (typeof renderBadgeWall === "function") {
    renderBadgeWall("badges-grid");
  }

  window.dispatchEvent(new CustomEvent("app:themeChanged", {
    detail: { theme: nextTheme }
  }));
}

window.applyAppTheme = applyAppTheme;

function initTheme() {
  const storedTheme = localStorage.getItem("app_theme");
  const savedTheme = ["light", "warm", "dark"].includes(storedTheme) ? storedTheme : "light";
  state.theme = savedTheme;
  setBodyThemeClass(savedTheme);
}

// Local Settings & State Loading
function loadLocalSettings() {
  // Load local reader preferences
  const readerFontSizes = [16, 18, 20, 22, 24];
  const savedReaderFontSize = Number.parseInt(localStorage.getItem("reader_font_size"), 10);
  state.readerState.fontSize = Number.isFinite(savedReaderFontSize)
    ? readerFontSizes.reduce((closest, size) =>
      Math.abs(size - savedReaderFontSize) < Math.abs(closest - savedReaderFontSize) ? size : closest, 20)
    : 20;
  const sizeLabel = document.getElementById("font-size-label");
  if (sizeLabel) sizeLabel.textContent = state.readerState.fontSize + "px";
  
  // Load local Bible translation version preference
  state.readerState.version = localStorage.getItem("reader_bible_version") || "CUNP";
  const versionBtn = document.getElementById("reader-nav-version-btn");
  if (versionBtn) {
    const label = state.readerState.version === "RCUVTS" ? "RCUV" : state.readerState.version;
    const span = versionBtn.querySelector("span");
    if (span) span.textContent = label;
    const navBadge = document.getElementById("bible-nav-version-badge");
    if (navBadge) navBadge.textContent = label;
  }
  
  const savedReader = localStorage.getItem("reader_state");
  if (savedReader) {
    state.readerState = { ...state.readerState, ...JSON.parse(savedReader) };
  }

  // Load highlights
  const savedHighlights = localStorage.getItem("bible_highlights");
  if (savedHighlights) {
    state.highlights = JSON.parse(savedHighlights);
  }
  const savedHighlightTimestamps = localStorage.getItem("bible_highlight_timestamps");
  if (savedHighlightTimestamps) {
    try { state.highlightTimestamps = JSON.parse(savedHighlightTimestamps) || {}; } catch (_) { state.highlightTimestamps = {}; }
  }
}

// HTML Sanitization / Escaping to prevent XSS (Script Injection) attacks
function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  if (typeof str !== 'string') str = String(str);
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// React state simulator for compatibility and audit compliance
state.dataVersion = 0;
const [dataVersion, setDataVersion] = (function() {
  return [
    () => state.dataVersion || 0,
    (updater) => {
      const oldVal = state.dataVersion || 0;
      const newVal = typeof updater === 'function' ? updater(oldVal) : Number(updater);
      state.dataVersion = newVal;
      // Dispatch CustomEvent to notify all components
      const event = new CustomEvent("planDataChanged", { detail: { dataVersion: state.dataVersion } });
      window.dispatchEvent(event);
    }
  ];
})();
window.dataVersion = dataVersion;
window.setDataVersion = setDataVersion;

window.state = state;
window.getUserRoleCode = getUserRoleCode;
window.getRoleDefinition = getRoleDefinition;
window.getRoleLabel = getRoleLabel;
window.hasWholeChurchPlanScope = hasWholeChurchPlanScope;
window.currentActivePlanId = getActivePlanContextId();
window.currentActivePlanKey = null;
window.getActivePlanContextId = getActivePlanContextId;
window.syncActivePlanContext = syncActivePlanContext;
window.findPlanByContextId = findPlanByContextId;
window.CHURCH_PLAN_PRESETS = CHURCH_PLAN_PRESETS;
window.appRouter = appRouter;
window.initTheme = initTheme;
window.loadLocalSettings = loadLocalSettings;
window.setBodyThemeClass = setBodyThemeClass;
window.escapeHTML = escapeHTML;
window.loader = loader;
