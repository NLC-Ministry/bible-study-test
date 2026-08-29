// js/modules/admin.js

import {
  sendBulkPlanInvitations,
  wasPlanInviteRemindedToday
} from "./admin-bulk-plan-invite.mjs";
import { buildAdminRegistrationStatisticsPlans } from "./admin-registration-plan-options.mjs";
import { resolveAdminRegistrationSummary } from "./admin-registration-summary.mjs";
import {
  ADMIN_ORG_UNASSIGNED,
  buildAdminUserDirectoryOrgOptions,
  matchesAdminUserDirectoryOrgFilters
} from "./admin-user-directory-filter.mjs";
import {
  formatTaiwanDate,
  prependTaiwanExportTime
} from "./export-time.mjs";
// Keep the ?v= in sync with any change to exam.js so a deploy isn't masked by a
// Service Worker that cached /modules/exam.js at its bare (unversioned) URL.
import { renderExamPanel } from "./exam.js?v=20260830_exam_p5p";

function updatePastoralWallControl(enabled, options = {}) {
  const toggle = document.getElementById("admin-pastoral-wall-toggle");
  const status = document.getElementById("admin-pastoral-wall-status");
  if (!toggle || !status) return;
  toggle.setAttribute("aria-checked", enabled ? "true" : "false");
  toggle.setAttribute("aria-label", enabled ? "牧區分享牆功能已開啟" : "牧區分享牆功能已關閉");
  toggle.disabled = options.disabled === true;
  status.textContent = enabled ? "已開啟：所有堂會成員皆可在首頁看見「牧區分享牆」，進行靈修分享與互動。" : "已關閉：首頁將隱藏「牧區分享牆」，僅保留個人靈修進度紀錄與團隊功能。";
}

function updateDailyQuizFeatureControl(enabled, options = {}) {
  const toggle = document.getElementById("admin-daily-quiz-feature-toggle");
  const status = document.getElementById("admin-daily-quiz-feature-status");
  if (!toggle || !status) return;
  toggle.setAttribute("aria-checked", enabled ? "true" : "false");
  toggle.setAttribute("aria-label", enabled ? "每日小測驗功能已開啟" : "每日小測驗功能已關閉");
  toggle.disabled = options.disabled === true;
  status.textContent = enabled
    ? "已開啟：顯示小測驗入口，並允許每日生成、審核、發佈與作答。"
    : "已關閉：隱藏所有小測驗入口並暫停生成；既有題目與作答資料保留。";
}

function applyAdminDailyQuizFeatureVisibility(enabled) {
  const tab = document.querySelector('#admin-plan-subtabs [data-plan-subtab="quizzes"]');
  const panel = document.getElementById("admin-plan-subtab-quizzes");
  tab?.classList.toggle("hidden", !enabled);
  if (tab) tab.style.display = enabled ? "" : "none";
  if (!enabled && activeAdminPlanSubtab === "quizzes") setAdminPlanSubtab("join-status");
  if (!enabled && panel) panel.classList.add("hidden");
}

function updateExamFeatureControl(enabled, options = {}) {
  const toggle = document.getElementById("admin-exam-feature-toggle");
  const status = document.getElementById("admin-exam-feature-status");
  if (!toggle || !status) return;
  toggle.setAttribute("aria-checked", enabled ? "true" : "false");
  toggle.setAttribute("aria-label", enabled ? "大測驗（速讀測驗）功能已開啟" : "大測驗（速讀測驗）功能已關閉");
  toggle.disabled = options.disabled === true;
  status.textContent = enabled
    ? "已開啟：計劃管理會出現「大測驗」分頁，可出題、發佈、批改與作答。"
    : "已關閉：隱藏「大測驗」分頁並停止作答；既有試卷、題目與成績都會保留。";
}

// 「大測驗」計劃管理分頁：系統管理員 + speed_reading_exam 功能開啟時才顯示。
function applyAdminExamVisibility(enabled) {
  // 系統管理員：完整後台（出題 / 發佈 / 批改 / 統計）。
  // 牧者 / 牧區長 / 區長 / 小組長：只看統計（renderExamPanel 內部判斷，統計依委派範圍）。
  const roleCode = state.currentUser && typeof getUserRoleCode === "function"
    ? getUserRoleCode(state.currentUser) : null;
  const canSee = ["admin", "pastor", "great_zone_leader", "zone_leader", "group_leader"].includes(roleCode);
  const show = canSee && enabled === true;
  const tab = document.querySelector('#admin-plan-subtabs [data-plan-subtab="exam"]');
  const panel = document.getElementById("admin-plan-subtab-exam");
  if (tab) { tab.classList.toggle("hidden", !show); tab.style.display = show ? "" : "none"; }
  if (!show && activeAdminPlanSubtab === "exam") setAdminPlanSubtab("join-status");
  if (!show && panel) panel.classList.add("hidden");
}

export async function renderAdminFeatureSettings() {
  const card = document.querySelector(".admin-feature-settings-card")?.closest(".card-col");
  const toggle = document.getElementById("admin-pastoral-wall-toggle");
  const feedback = document.getElementById("admin-pastoral-wall-feedback");
  const quizToggle = document.getElementById("admin-daily-quiz-feature-toggle");
  const quizFeedback = document.getElementById("admin-daily-quiz-feature-feedback");
  if (!card || !toggle || !feedback || !quizToggle || !quizFeedback) return;

  const examToggle = document.getElementById("admin-exam-feature-toggle");
  const examFeedback = document.getElementById("admin-exam-feature-feedback");

  const isAdmin = state.currentUser && getUserRoleCode(state.currentUser) === "admin";
  card.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) {
    const [quizResult, examResult] = await Promise.all([
      db.getFeatureSetting("daily_quiz", false),
      db.getFeatureSetting("speed_reading_exam", false)
    ]);
    const quizEnabled = !quizResult.error && quizResult.enabled === true;
    window.dailyQuizFeatureEnabled = quizEnabled;
    applyAdminDailyQuizFeatureVisibility(quizEnabled);
    const examEnabled = !examResult.error && examResult.enabled === true;
    window.speedReadingExamFeatureEnabled = examEnabled;
    applyAdminExamVisibility(examEnabled);
    return;
  }

  feedback.classList.add("hidden");
  feedback.textContent = "";
  updatePastoralWallControl(false, { disabled: true });
  quizFeedback.classList.add("hidden");
  quizFeedback.textContent = "";
  updateDailyQuizFeatureControl(false, { disabled: true });
  if (examFeedback) { examFeedback.classList.add("hidden"); examFeedback.textContent = ""; }
  updateExamFeatureControl(false, { disabled: true });

  const [result, quizResult, examResult] = await Promise.all([
    db.getFeatureSetting("pastoral_sharing_wall", false),
    db.getFeatureSetting("daily_quiz", false),
    db.getFeatureSetting("speed_reading_exam", false)
  ]);
  if (result.error) {
    updatePastoralWallControl(false, { disabled: true });
    feedback.textContent = "無法載入設定：從伺服器獲取牧區分享牆設定失敗。";
    feedback.classList.remove("hidden");
  } else {
    updatePastoralWallControl(result.enabled === true);
  }
  if (quizResult.error) {
    updateDailyQuizFeatureControl(false, { disabled: true });
    quizFeedback.textContent = "無法載入設定：從伺服器獲取每日小測驗設定失敗。";
    quizFeedback.classList.remove("hidden");
  } else {
    const quizEnabled = quizResult.enabled === true;
    window.dailyQuizFeatureEnabled = quizEnabled;
    updateDailyQuizFeatureControl(quizEnabled);
    applyAdminDailyQuizFeatureVisibility(quizEnabled);
  }
  if (examResult.error) {
    updateExamFeatureControl(false, { disabled: true });
    if (examFeedback) {
      examFeedback.textContent = "無法載入設定：從伺服器獲取大測驗設定失敗。";
      examFeedback.classList.remove("hidden");
    }
  } else {
    const examEnabled = examResult.enabled === true;
    window.speedReadingExamFeatureEnabled = examEnabled;
    updateExamFeatureControl(examEnabled);
    applyAdminExamVisibility(examEnabled);
  }

  if (examToggle && !examToggle.dataset.featureSettingBound) {
    examToggle.dataset.featureSettingBound = "true";
    examToggle.addEventListener("click", async () => {
      const currentEnabled = examToggle.getAttribute("aria-checked") === "true";
      const nextEnabled = !currentEnabled;
      updateExamFeatureControl(currentEnabled, { disabled: true });
      examFeedback?.classList.add("hidden");
      const saveResult = await db.updateFeatureSetting("speed_reading_exam", nextEnabled);
      if (saveResult.error) {
        updateExamFeatureControl(currentEnabled);
        if (examFeedback) {
          examFeedback.textContent = "更新設定失敗：無法將設定儲存至伺服器。";
          examFeedback.classList.remove("hidden");
        }
        return;
      }
      window.speedReadingExamFeatureEnabled = nextEnabled;
      updateExamFeatureControl(nextEnabled);
      applyAdminExamVisibility(nextEnabled);
      if (typeof showToast === "function") {
        showToast(nextEnabled ? "大測驗功能已開啟！" : "大測驗功能已關閉。");
      }
    });
  }

  if (!toggle.dataset.featureSettingBound) {
    toggle.dataset.featureSettingBound = "true";
    toggle.addEventListener("click", async () => {
      const currentEnabled = toggle.getAttribute("aria-checked") === "true";
      const nextEnabled = !currentEnabled;
      updatePastoralWallControl(currentEnabled, { disabled: true });
      feedback.classList.add("hidden");

      const saveResult = await db.updateFeatureSetting("pastoral_sharing_wall", nextEnabled);
      if (saveResult.error) {
        updatePastoralWallControl(currentEnabled);
        feedback.textContent = "更新設定失敗：無法將設定儲存至伺服器。";
        feedback.classList.remove("hidden");
        return;
      }

      updatePastoralWallControl(nextEnabled);
      if (typeof showToast === "function") {
        showToast(nextEnabled ? "牧區分享牆功能已開啟！" : "牧區分享牆功能已關閉。");
      }
      window.dispatchEvent(new CustomEvent("pastoral-sharing-wall-changed", {
        detail: { enabled: nextEnabled }
      }));
    });
  }

  if (!quizToggle.dataset.featureSettingBound) {
    quizToggle.dataset.featureSettingBound = "true";
    quizToggle.addEventListener("click", async () => {
      const currentEnabled = quizToggle.getAttribute("aria-checked") === "true";
      const nextEnabled = !currentEnabled;
      updateDailyQuizFeatureControl(currentEnabled, { disabled: true });
      quizFeedback.classList.add("hidden");
      const saveResult = await db.updateFeatureSetting("daily_quiz", nextEnabled);
      if (saveResult.error) {
        updateDailyQuizFeatureControl(currentEnabled);
        quizFeedback.textContent = "更新設定失敗：無法將設定儲存至伺服器。";
        quizFeedback.classList.remove("hidden");
        return;
      }
      window.dailyQuizFeatureEnabled = nextEnabled;
      updateDailyQuizFeatureControl(nextEnabled);
      applyAdminDailyQuizFeatureVisibility(nextEnabled);
      if (nextEnabled) {
        adminDailyQuizDashboardCache.clear();
        const quizRoot = document.getElementById("admin-daily-quiz-root");
        if (quizRoot) {
          delete quizRoot.dataset.quizDashboardKey;
          delete quizRoot.dataset.quizDate;
          quizRoot.innerHTML = '<div class="admin-user-directory__empty">小測驗已重新開啟，切換至小測驗分頁後會載入原有資料。</div>';
        }
      }
      window.dispatchEvent(new CustomEvent("daily-quiz-feature-changed", { detail: { enabled: nextEnabled } }));
      if (typeof showToast === "function") showToast(nextEnabled ? "每日小測驗功能已開啟！" : "每日小測驗功能已關閉。資料仍完整保留。");
    });
  }

  if (typeof hydrateIcons === "function") hydrateIcons(card);
}

let adminUserDirectoryProfiles = [];

function formatAdminUserSyncTime(value) {
  if (!value) return "尚未同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未同步";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

let adminUserDirectoryFilteredProfiles = [];

// Fixed display order for church org units, used by every CSV export that
// includes 大區 or 牧區 data — matches the order leadership actually uses on
// printed rosters, not alphabetical/insertion order. Anything outside these
// lists is still exported, just sorted after the known names (never
// silently dropped) and alphabetized among itself for determinism.
const CHURCH_GREAT_REGION_ORDER = ["東區", "西區", "南區", "北區", "青少年", "慶典", "創藝", "花蓮", "桃園"];
const CHURCH_PASTORAL_ZONE_ORDER = [
  "大安1", "大安2", "大安3", "大安4", "大安6", "大安7", "大安8", "大安9", "大安10", "大安11", "大安12",
  "中正1", "中正2", "中正3", "中正4", "中正5",
  "中山1", "中山2", "中山3", "中山5",
  "信義2", "信義3",
  "士林",
  "松山1", "松山2",
  "南港", "內湖", "文山",
  "新烏1", "新烏2", "新烏3", "新烏4",
  "中永和", "三重",
  "青少年教會",
  "慶典1", "慶典2",
  "創藝",
  "新莊1", "新莊2", "新莊3",
  "花蓮", "桃園", "桃1",
  "未設定牧區"
];

function compareByChurchOrgOrder(orderList) {
  const orderIndex = new Map(orderList.map((name, i) => [name, i]));
  return (aLabel, bLabel) => {
    const a = String(aLabel || "").trim();
    const b = String(bLabel || "").trim();
    const aIndex = orderIndex.has(a) ? orderIndex.get(a) : Infinity;
    const bIndex = orderIndex.has(b) ? orderIndex.get(b) : Infinity;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.localeCompare(b, "zh-Hant");
  };
}
const compareGreatRegions = compareByChurchOrgOrder(CHURCH_GREAT_REGION_ORDER);
const comparePastoralZones = compareByChurchOrgOrder(CHURCH_PASTORAL_ZONE_ORDER);

function sortByChurchOrgOrder(items, orderComparator, extractLabel) {
  return [...items].sort((a, b) => orderComparator(extractLabel(a), extractLabel(b)));
}

function sortProfilesByChurchOrgOrder(profiles) {
  return [...profiles].sort((a, b) => {
    const regionCompare = compareGreatRegions(a.great_region, b.great_region);
    if (regionCompare !== 0) return regionCompare;
    const zoneCompare = comparePastoralZones(a.pastoral_zone, b.pastoral_zone);
    if (zoneCompare !== 0) return zoneCompare;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
  });
}

export function convertUserDirectoryToCSV(profiles, exportedAt = new Date()) {
  if (!profiles || profiles.length === 0) return "";
  const headers = ["大區", "牧區", "小組", "姓名", "電子信箱", "角色", "組隊狀態", "帳號狀態"];
  const rows = sortProfilesByChurchOrgOrder(profiles).map(p => [
    p.great_region || "未設定",
    p.pastoral_zone || "未設定牧區",
    p.small_group || "未設定",
    p.name || "尚未取得姓名",
    p.email || "",
    p.role_definition?.label || p.role_definition?.code || "一般會友",
    p.team_name ? `${p.member_role === "leader" ? "[隊長] " : ""}${p.team_name}` : "未加入團隊 (個人速讀中)",
    p.is_active === false ? "已停用" : "啟用中"
  ]);

  return prependTaiwanExportTime([
    headers.join(","),
    ...rows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(","))
  ].join("\n"), exportedAt);
}

export function exportUserDirectoryCSV(profiles = adminUserDirectoryFilteredProfiles) {
  const target = Array.isArray(profiles) ? profiles : adminUserDirectoryProfiles;
  if (!target || target.length === 0) {
    if (typeof showToast === "function") showToast("沒有符合條件的使用者可供匯出。");
    return;
  }
  const csvContent = convertUserDirectoryToCSV(target);
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const today = formatTaiwanDate();
  link.setAttribute("href", url);
  link.setAttribute("download", `member_directory_${today}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function convertOrgStructureToCSV(orgStructure = state.orgStructure, exportedAt = new Date()) {
  if (!orgStructure) return "";
  const headers = ["大區", "牧區", "小組"];
  const rows = [];

  const regions = sortByChurchOrgOrder(orgStructure.regions || [], compareGreatRegions, region => region);
  const zonesMap = orgStructure.zones || {};
  const groupsMap = orgStructure.groups || {};

  regions.forEach(region => {
    const zones = sortByChurchOrgOrder(zonesMap[region] || [], comparePastoralZones, zone => zone);
    if (zones.length === 0) {
      rows.push([region, "無下屬牧區", "無下屬小組"]);
    } else {
      zones.forEach(zone => {
        const groups = groupsMap[zone] || [];
        if (groups.length === 0) {
          rows.push([region, zone, "無下屬小組"]);
        } else {
          groups.forEach(group => {
            rows.push([region, zone, group]);
          });
        }
      });
    }
  });

  if (rows.length === 0) return "";
  return prependTaiwanExportTime([
    headers.join(","),
    ...rows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(","))
  ].join("\n"), exportedAt);
}

export async function exportOrgStructureCSV() {
  if (!state.orgStructure || !Array.isArray(state.orgStructure.regions) || state.orgStructure.regions.length === 0) {
    if (typeof db.loadOrgStructure === "function") {
      await db.loadOrgStructure();
    }
  }
  const csvContent = convertOrgStructureToCSV(state.orgStructure);
  if (!csvContent) {
    if (typeof showToast === "function") showToast("目前沒有可供匯出的組織架構資料。");
    return;
  }
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const today = formatTaiwanDate();
  link.setAttribute("href", url);
  link.setAttribute("download", `church_org_structure_${today}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Non-"empty" reasons getProfileNameFlags() can return — a name that's suspicious but present. */
function getNameReviewFlags(profile) {
  if (typeof getProfileNameFlags !== "function") return [];
  return getProfileNameFlags(profile.name).filter(flag => flag !== "empty");
}

function profileNameNeedsReview(profile) {
  return getNameReviewFlags(profile).length > 0 && profile.name_review_approved !== true;
}

const NAME_FLAG_LABELS = {
  placeholder: "系統預設暱稱",
  digits: "含數字",
  emoji: "含表情符號",
  gibberish_english: "疑似亂打的英文"
};

let adminUserDirectoryOrgFilterState = { regions: [], zones: [], groups: [] };

const ADMIN_USER_DIRECTORY_ORG_PICKERS = {
  regions: {
    pickerId: "admin-user-directory-filter-region",
    optionsId: "admin-user-directory-filter-region-options",
    summaryId: "admin-user-directory-filter-region-summary",
    allLabel: "全部大區",
    countLabel: "個大區",
    comparator: compareGreatRegions
  },
  zones: {
    pickerId: "admin-user-directory-filter-zone",
    optionsId: "admin-user-directory-filter-zone-options",
    summaryId: "admin-user-directory-filter-zone-summary",
    allLabel: "全部牧區",
    countLabel: "個牧區",
    comparator: comparePastoralZones
  },
  groups: {
    pickerId: "admin-user-directory-filter-group",
    optionsId: "admin-user-directory-filter-group-options",
    summaryId: "admin-user-directory-filter-group-summary",
    allLabel: "全部小組",
    countLabel: "個小組"
  }
};

function getAdminUserDirectoryOrgFilters() {
  return {
    regions: [...adminUserDirectoryOrgFilterState.regions],
    zones: [...adminUserDirectoryOrgFilterState.zones],
    groups: [...adminUserDirectoryOrgFilterState.groups]
  };
}

function sortAdminUserDirectoryOrgValues(values, comparator) {
  return [...values].sort((a, b) => {
    if (a === ADMIN_ORG_UNASSIGNED) return 1;
    if (b === ADMIN_ORG_UNASSIGNED) return -1;
    return comparator ? comparator(a, b) : a.localeCompare(b, "zh-Hant");
  });
}

function renderAdminUserDirectoryOrgPicker(stateKey, values) {
  const config = ADMIN_USER_DIRECTORY_ORG_PICKERS[stateKey];
  const optionsContainer = document.getElementById(config.optionsId);
  const summary = document.getElementById(config.summaryId);
  if (!optionsContainer || !summary) return;

  const sortedValues = sortAdminUserDirectoryOrgValues(values, config.comparator);
  const selectedValues = adminUserDirectoryOrgFilterState[stateKey];
  optionsContainer.replaceChildren();

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "admin-user-directory__org-clear";
  clearButton.dataset.orgFilterClear = stateKey;
  clearButton.textContent = config.allLabel;
  optionsContainer.appendChild(clearButton);

  sortedValues.forEach(value => {
    const label = document.createElement("label");
    label.className = "admin-user-directory__org-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = value;
    checkbox.dataset.orgFilterKey = stateKey;
    checkbox.checked = selectedValues.includes(value);
    const text = document.createElement("span");
    text.textContent = value === ADMIN_ORG_UNASSIGNED ? "未設定" : value;
    label.append(checkbox, text);
    optionsContainer.appendChild(label);
  });

  if (selectedValues.length === 0) {
    summary.textContent = config.allLabel;
  } else if (selectedValues.length === 1) {
    summary.textContent = selectedValues[0] === ADMIN_ORG_UNASSIGNED ? "未設定" : selectedValues[0];
  } else {
    summary.textContent = `${selectedValues.length} ${config.countLabel}`;
  }
}

function refreshAdminUserDirectoryOrgFilterOptions() {
  let options = buildAdminUserDirectoryOrgOptions(adminUserDirectoryProfiles, adminUserDirectoryOrgFilterState);
  adminUserDirectoryOrgFilterState.regions = adminUserDirectoryOrgFilterState.regions
    .filter(value => options.regions.includes(value));
  options = buildAdminUserDirectoryOrgOptions(adminUserDirectoryProfiles, adminUserDirectoryOrgFilterState);
  adminUserDirectoryOrgFilterState.zones = adminUserDirectoryOrgFilterState.zones
    .filter(value => options.zones.includes(value));
  options = buildAdminUserDirectoryOrgOptions(adminUserDirectoryProfiles, adminUserDirectoryOrgFilterState);
  adminUserDirectoryOrgFilterState.groups = adminUserDirectoryOrgFilterState.groups
    .filter(value => options.groups.includes(value));

  renderAdminUserDirectoryOrgPicker("regions", options.regions);
  renderAdminUserDirectoryOrgPicker("zones", options.zones);
  renderAdminUserDirectoryOrgPicker("groups", options.groups);
}

function bindAdminUserDirectoryOrgFilterActions(root, search) {
  if (!root || root.dataset.orgFilterBound === "true") return;
  root.dataset.orgFilterBound = "true";
  root.addEventListener("change", event => {
    const checkbox = event.target.closest("input[data-org-filter-key]");
    if (!checkbox) return;
    const stateKey = checkbox.dataset.orgFilterKey;
    const selected = new Set(adminUserDirectoryOrgFilterState[stateKey]);
    if (checkbox.checked) selected.add(checkbox.value);
    else selected.delete(checkbox.value);
    adminUserDirectoryOrgFilterState[stateKey] = [...selected];
    refreshAdminUserDirectoryOrgFilterOptions();
    renderAdminUserDirectoryList(search.value);
  });
  root.addEventListener("click", event => {
    const clearButton = event.target.closest("[data-org-filter-clear]");
    if (!clearButton) return;
    adminUserDirectoryOrgFilterState[clearButton.dataset.orgFilterClear] = [];
    refreshAdminUserDirectoryOrgFilterOptions();
    renderAdminUserDirectoryList(search.value);
  });
}

function renderAdminUserDirectoryList(query = "") {
  const list = document.getElementById("admin-user-directory-list");
  const count = document.getElementById("admin-user-directory-count");
  if (!list || !count) return;
  const incompleteOnly = document.getElementById("admin-user-directory-filter-incomplete")?.checked === true;
  const notJoinedStageOneOnly = document.getElementById("admin-user-directory-filter-stage-one")?.checked === true;
  const unjoinedTeamOnly = document.getElementById("admin-user-directory-filter-unjoined-team")?.checked === true;
  const nameReviewOnly = document.getElementById("admin-user-directory-filter-name-review")?.checked === true;
  const orgFilters = getAdminUserDirectoryOrgFilters();
  const currentProfileId = String(state.currentProfileId || state.currentUser?.id || "");
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-Hant");
  const placeholderNames = (typeof window !== "undefined" && window.INVENTED_DISPLAY_NAMES)
    || new Set(["NLC User", "尚未取得姓名", "未命名使用者", "教會肢體"]);
  const filteredProfiles = adminUserDirectoryProfiles.filter(profile => {
    const normalizedName = String(profile.name || "").trim();
    const missingRequiredProfile = !normalizedName || placeholderNames.has(normalizedName)
      || !String(profile.pastoral_zone || "").trim();
    if (incompleteOnly && !missingRequiredProfile) return false;
    const eligibleForStageOneInvitation = profile.is_active === true
      && String(profile.id || "") !== currentProfileId;
    if (notJoinedStageOneOnly && (profile.joined_stage_one === true || !eligibleForStageOneInvitation)) return false;
    if (unjoinedTeamOnly && profile.is_joined_team === true) return false;
    if (nameReviewOnly && !profileNameNeedsReview(profile)) return false;
    if (!matchesAdminUserDirectoryOrgFilters(profile, orgFilters)) return false;
    const roleLabel = profile.role_definition?.label || profile.role_definition?.code || "一般會友";
    return [profile.name, profile.email, roleLabel, profile.great_region, profile.pastoral_zone, profile.small_group, profile.team_name]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-Hant")
      .includes(normalizedQuery);
  });
  adminUserDirectoryFilteredProfiles = filteredProfiles;
  const hasOrgFilter = Object.values(orgFilters).some(values => values.length > 0);
  count.textContent = normalizedQuery || incompleteOnly || notJoinedStageOneOnly || unjoinedTeamOnly || nameReviewOnly || hasOrgFilter
    ? `${filteredProfiles.length} / ${adminUserDirectoryProfiles.length} 人`
    : `${adminUserDirectoryProfiles.length} 人`;
  if (filteredProfiles.length === 0) {
    list.innerHTML = '<div class="admin-user-directory__empty">沒有符合條件的使用者。</div>';
    return;
  }

  list.innerHTML = filteredProfiles.map(profile => {
    const name = String(profile.name || "").trim() || "尚未取得姓名";
    const email = String(profile.email || "").trim() || "未提供電子信箱";
    const roleLabel = profile.role_definition?.label || profile.role_definition?.code || "一般會友";
    const greatRegion = String(profile.great_region || "").trim() || "未設定";
    const pastoralZone = String(profile.pastoral_zone || "").trim() || "未設定牧區";
    const smallGroup = String(profile.small_group || "").trim() || "未設定";
    const syncStatus = String(profile.member_context_sync_status || "").trim();
    const syncLabel = syncStatus === "success"
      ? "已同步"
      : (syncStatus === "degraded" || syncStatus === "failed" ? "同步異常" : "尚未同步");
    const config = getManagedScopeConfig(profile);
    const defaultScopes = getProfileDefaultManagedScopes(profile, config);
    const managedScopeText = config.role === "admin" || config.role === "pastor"
      ? "全教會"
      : (defaultScopes.join("、") || "僅本人");
    const statusClass = profile.is_active === false ? "disabled" : "active";
    const teamText = profile.team_name
      ? `${profile.member_role === "leader" ? "👑 [隊長] " : ""}${escapeHTML(profile.team_name)}`
      : "未加入團隊 (個人速讀中)";
    const nameReviewFlags = getNameReviewFlags(profile);
    const needsNameReview = nameReviewFlags.length > 0 && profile.name_review_approved !== true;
    const nameReviewReasons = nameReviewFlags.map(flag => NAME_FLAG_LABELS[flag] || flag).join("、");
    const profileIdAttr = escapeHTML(String(profile.id || ""));

    return `
      <details class="admin-user-directory__card">
        <summary class="admin-user-directory__card-summary">
          <span class="admin-user-directory__identity">
            <strong>${escapeHTML(name)}</strong>
            <span>${escapeHTML(pastoralZone)}</span>
          </span>
          ${needsNameReview ? '<span class="admin-user-directory__status admin-user-directory__status--disabled">姓名待審核</span>' : ""}
        </summary>
        <div class="admin-user-directory__detail-panel">
          <dl class="admin-user-directory__details">
            <div><dt>帳號狀態</dt><dd><span class="admin-user-directory__status admin-user-directory__status--${statusClass}">${profile.is_active === false ? "已停用" : "啟用中"}</span></dd></div>
            <div><dt>電子信箱</dt><dd>${escapeHTML(email)}</dd></div>
            <div><dt>角色</dt><dd>${escapeHTML(roleLabel)}</dd></div>
            <div><dt>權限管理範圍</dt><dd>${escapeHTML(managedScopeText)}</dd></div>
            <div><dt>大區</dt><dd>${escapeHTML(greatRegion)}</dd></div>
            <div><dt>牧區</dt><dd>${escapeHTML(pastoralZone)}</dd></div>
            <div><dt>小組</dt><dd>${escapeHTML(smallGroup)}</dd></div>
            <div><dt>團隊組隊狀態</dt><dd>${teamText}</dd></div>
            <div><dt>第一階段計畫</dt><dd>${profile.joined_stage_one === true ? "已加入" : "未加入"}</dd></div>
            <div><dt>會員中心同步</dt><dd>${escapeHTML(syncLabel)}・${escapeHTML(formatAdminUserSyncTime(profile.member_context_synced_at))}</dd></div>
          </dl>
          ${needsNameReview ? `
          <div class="admin-user-directory__name-review">
            <p class="admin-user-directory__name-review-reason">此姓名待審核（${escapeHTML(nameReviewReasons)}），審核通過前該使用者無法進入讀經計畫。</p>
            <div class="admin-user-directory__name-review-actions">
              <input type="text" class="form-control admin-user-directory__name-review-input" value="${escapeHTML(name)}" maxlength="40">
              <button type="button" class="secondary-btn admin-user-directory__name-review-save" data-profile-id="${profileIdAttr}">修改並核准</button>
              <button type="button" class="primary-btn admin-user-directory__name-review-approve" data-profile-id="${profileIdAttr}">核准現有姓名</button>
            </div>
          </div>` : ""}
        </div>
      </details>`;
  }).join("");
}

function bindAdminUserDirectoryNameReviewActions(list) {
  if (!list || list.dataset.nameReviewBound === "true") return;
  list.dataset.nameReviewBound = "true";
  list.addEventListener("click", async event => {
    const approveBtn = event.target.closest(".admin-user-directory__name-review-approve");
    const saveBtn = event.target.closest(".admin-user-directory__name-review-save");
    const btn = approveBtn || saveBtn;
    if (!btn) return;
    const profileId = btn.dataset.profileId;
    if (!profileId) return;

    btn.disabled = true;
    try {
      const result = saveBtn
        ? await db.adminOverwriteProfileName(
            profileId,
            btn.closest(".admin-user-directory__name-review")?.querySelector(".admin-user-directory__name-review-input")?.value
          )
        : await db.approveProfileName(profileId);

      if (result.error) {
        if (typeof showToast === "function") showToast(result.error.message || "操作失敗，請稍後再試。");
        btn.disabled = false;
        return;
      }
      const target = adminUserDirectoryProfiles.find(candidate => String(candidate.id) === String(profileId));
      if (target && result.data) {
        target.name = result.data.name ?? target.name;
        target.name_review_approved = result.data.name_review_approved ?? true;
      }
      if (typeof showToast === "function") showToast("已更新姓名審核狀態。");
      renderAdminUserDirectoryList(document.getElementById("admin-user-directory-search")?.value || "");
    } catch (err) {
      if (typeof showToast === "function") showToast(err?.message || "操作失敗，請稍後再試。");
      btn.disabled = false;
    }
  });
}

export async function renderAdminUserDirectory() {
  const column = document.getElementById("admin-user-directory-col");
  const search = document.getElementById("admin-user-directory-search");
  const list = document.getElementById("admin-user-directory-list");
  const count = document.getElementById("admin-user-directory-count");
  const incompleteFilter = document.getElementById("admin-user-directory-filter-incomplete");
  const stageOneFilter = document.getElementById("admin-user-directory-filter-stage-one");
  const unjoinedTeamFilter = document.getElementById("admin-user-directory-filter-unjoined-team");
  const nameReviewFilter = document.getElementById("admin-user-directory-filter-name-review");
  const orgFiltersRoot = document.querySelector(".admin-user-directory__org-filters");
  if (!column || !search || !list || !count || !incompleteFilter || !stageOneFilter
    || !orgFiltersRoot) return;
  const isAdmin = state.currentUser && getUserRoleCode(state.currentUser) === "admin";
  column.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) return;
  search.disabled = true;
  incompleteFilter.disabled = true;
  stageOneFilter.disabled = true;
  if (unjoinedTeamFilter) unjoinedTeamFilter.disabled = true;
  if (nameReviewFilter) nameReviewFilter.disabled = true;
  orgFiltersRoot.setAttribute("aria-disabled", "true");
  count.textContent = "讀取中…";
  if (firstPaint(list)) list.innerHTML = '<div class="admin-user-directory__empty">正在載入使用者資料…</div>';
  const result = await db.fetchAdminUserProfiles();
  if (result.error) {
    count.textContent = "0 人";
    list.innerHTML = '<div class="admin-user-directory__empty">目前無法載入使用者基本資料。</div>';
    return;
  }
  adminUserDirectoryProfiles = result.data || [];
  search.disabled = false;
  incompleteFilter.disabled = false;
  stageOneFilter.disabled = false;
  if (unjoinedTeamFilter) unjoinedTeamFilter.disabled = false;
  if (nameReviewFilter) nameReviewFilter.disabled = false;
  orgFiltersRoot.setAttribute("aria-disabled", "false");
  refreshAdminUserDirectoryOrgFilterOptions();
  bindAdminUserDirectoryOrgFilterActions(orgFiltersRoot, search);
  bindAdminUserDirectoryNameReviewActions(list);
  const exportBtn = document.getElementById("admin-user-directory-export-btn");
  if (exportBtn) {
    exportBtn.onclick = () => exportUserDirectoryCSV();
  }
  const orgExportBtn = document.getElementById("admin-export-org-structure-btn");
  if (orgExportBtn) {
    orgExportBtn.onclick = () => exportOrgStructureCSV();
  }
  window.exportUserDirectoryCSV = exportUserDirectoryCSV;
  window.convertUserDirectoryToCSV = convertUserDirectoryToCSV;
  window.exportOrgStructureCSV = exportOrgStructureCSV;
  window.convertOrgStructureToCSV = convertOrgStructureToCSV;
  search.oninput = () => renderAdminUserDirectoryList(search.value);
  incompleteFilter.onchange = () => renderAdminUserDirectoryList(search.value);
  stageOneFilter.onchange = () => renderAdminUserDirectoryList(search.value);
  if (unjoinedTeamFilter) unjoinedTeamFilter.onchange = () => renderAdminUserDirectoryList(search.value);
  if (nameReviewFilter) nameReviewFilter.onchange = () => renderAdminUserDirectoryList(search.value);
  renderAdminUserDirectoryList(search.value);
}

let managedScopeProfiles = [];

function splitManagedScope(value) {
  return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}

function getManagedScopeConfig(profile) {
  const role = getUserRoleCode(profile) || "member";
  if (role === "great_zone_leader") {
    return { role, field: "managed_regions", payloadField: "managedRegions", label: "大區", options: state.orgStructure.rawRegions || [] };
  }
  if (role === "zone_leader") {
    return { role, field: "managed_zones", payloadField: "managedZones", label: "牧區", options: state.orgStructure.rawZones || [] };
  }
  if (role === "group_leader") {
    return { role, field: "managed_groups", payloadField: "managedGroups", label: "小組", options: state.orgStructure.rawGroups || [] };
  }
  return { role, field: null, payloadField: null, label: "", options: [] };
}

function getProfileDefaultManagedScopes(profile, config) {
  const explicitScopes = config.field ? splitManagedScope(profile[config.field]) : [];
  if (explicitScopes.length > 0) return explicitScopes;

  if (config.role === "great_zone_leader" && profile.great_region) {
    return [String(profile.great_region).trim()];
  }
  if (config.role === "zone_leader" && profile.pastoral_zone) {
    return [String(profile.pastoral_zone).trim()];
  }
  if (config.role === "group_leader" && profile.small_group) {
    return [String(profile.small_group).trim()];
  }
  return [];
}

function renderManagedScopeProfile(profile) {
  const summary = document.getElementById("admin-managed-scopes-summary");
  const optionsRoot = document.getElementById("admin-managed-scopes-options");
  const selectAll = document.getElementById("admin-managed-scopes-select-all");
  const clear = document.getElementById("admin-managed-scopes-clear");
  const save = document.getElementById("admin-managed-scopes-save");
  if (!summary || !optionsRoot || !selectAll || !clear || !save) return;
  if (!profile) {
    summary.innerHTML = "";
    optionsRoot.innerHTML = '<div class="admin-managed-scopes__empty">找不到可設定的人員。</div>';
    selectAll.disabled = true;
    clear.disabled = true;
    save.disabled = true;
    return;
  }

  const config = getManagedScopeConfig(profile);
  const roleLabel = profile.role_definition?.label || config.role;
  const placement = [profile.great_region, profile.pastoral_zone, profile.small_group].filter(Boolean).join(" / ") || "尚未設定";
  const email = String(profile.email || "").trim() || "未提供電子信箱";
  const defaultScopes = getProfileDefaultManagedScopes(profile, config);
  const effectiveScope = config.role === "admin" || config.role === "pastor"
    ? "全教會"
    : (defaultScopes.join("、") || "僅本人");
  summary.innerHTML = `
    <span>姓名<strong>${escapeHTML(profile.name || "尚未取得姓名")}</strong></span>
    <span>電子信箱<strong>${escapeHTML(email)}</strong></span>
    <span>會員中心角色<strong>${escapeHTML(roleLabel)}</strong></span>
    <span>牧養歸屬<strong>${escapeHTML(placement)}</strong></span>
    <span>目前有效範圍<strong>${escapeHTML(effectiveScope)}</strong></span>`;

  const optionNames = Array.from(new Set([
    ...config.options.map(option => String(option?.name || option?.id || "").trim()),
    ...defaultScopes
  ].filter(Boolean))).sort((left, right) => left.localeCompare(right, "zh-Hant"));

  if (!config.field) {
    const message = config.role === "admin" || config.role === "pastor"
      ? "此角色固定擁有全教會範圍，不需要另外設定 managed_*。"
      : "此角色只有本人範圍，不使用 managed_*。";
    optionsRoot.innerHTML = `<div class="admin-managed-scopes__empty">${message}</div>`;
  } else if (optionNames.length === 0) {
    optionsRoot.innerHTML = `<div class="admin-managed-scopes__empty">目前沒有可選擇的${config.label}資料。</div>`;
  } else {
    const selected = new Set(defaultScopes);
    optionsRoot.innerHTML = optionNames.map(name => `
      <label class="admin-managed-scopes__option">
        <input type="checkbox" value="${escapeHTML(name)}" ${selected.has(name) ? "checked" : ""}>
        <span>${escapeHTML(name)}</span>
      </label>`).join("");
  }
  optionsRoot.dataset.scopeField = config.payloadField || "";
  selectAll.disabled = !config.field || optionNames.length === 0;
  clear.disabled = !config.field;
  save.disabled = !config.field;
}

function getSelectedManagedScopeProfile() {
  const select = document.getElementById("admin-managed-scopes-profile");
  return managedScopeProfiles.find(profile => String(profile.id) === String(select?.value)) || null;
}

function setManagedScopeFeedback(message, isError = false) {
  const feedback = document.getElementById("admin-managed-scopes-feedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle("hidden", !message);
  feedback.style.color = isError ? "var(--color-danger-foreground)" : "var(--color-success-foreground)";
}

export async function renderAdminManagedScopes() {
  const column = document.getElementById("admin-managed-scopes-col");
  const profileSelect = document.getElementById("admin-managed-scopes-profile");
  const optionsRoot = document.getElementById("admin-managed-scopes-options");
  const selectAll = document.getElementById("admin-managed-scopes-select-all");
  const clear = document.getElementById("admin-managed-scopes-clear");
  const save = document.getElementById("admin-managed-scopes-save");
  if (!column || !profileSelect || !optionsRoot || !selectAll || !clear || !save) return;

  const isAdmin = state.currentUser && getUserRoleCode(state.currentUser) === "admin";
  column.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) return;
  setManagedScopeFeedback("");
  profileSelect.disabled = true;
  if (firstPaint(optionsRoot)) optionsRoot.innerHTML = '<div class="admin-managed-scopes__empty">正在載入管理範圍…</div>';

  if (!Array.isArray(state.orgStructure.rawRegions) || state.orgStructure.rawRegions.length === 0) {
    await db.loadOrgStructure();
  }
  const result = await db.fetchManagedScopeProfiles();
  if (result.error) {
    optionsRoot.innerHTML = '<div class="admin-managed-scopes__empty">無法載入管理範圍資料。</div>';
    setManagedScopeFeedback(result.error.message || "無法載入管理範圍資料。", true);
    return;
  }
  managedScopeProfiles = (result.data || []).filter(profile => getUserRoleCode(profile) !== "member");
  profileSelect.innerHTML = "";
  managedScopeProfiles.forEach(profile => {
    const roleLabel = profile.role_definition?.label || getUserRoleCode(profile) || "一般會友";
    profileSelect.options.add(new Option(`${profile.name || "尚未取得姓名"}（${roleLabel}）`, String(profile.id)));
  });
  profileSelect.disabled = managedScopeProfiles.length === 0;
  profileSelect.onchange = () => {
    setManagedScopeFeedback("");
    renderManagedScopeProfile(getSelectedManagedScopeProfile());
  };
  selectAll.onclick = () => optionsRoot.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = true; });
  clear.onclick = () => optionsRoot.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = false; });
  save.onclick = async () => {
    const profile = getSelectedManagedScopeProfile();
    const config = getManagedScopeConfig(profile);
    if (!profile || !config.payloadField) return;
    const values = Array.from(optionsRoot.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
    const payload = { managedRegions: [], managedZones: [], managedGroups: [], [config.payloadField]: values };
    save.disabled = true;
    setManagedScopeFeedback("正在儲存…");
    const updateResult = await db.updateManagedScopes(profile.id, payload);
    save.disabled = false;
    if (updateResult.error) {
      setManagedScopeFeedback(updateResult.error.message || "儲存失敗。", true);
      return;
    }
    profile.managed_regions = (updateResult.data?.managedRegions || []).join(",");
    profile.managed_zones = (updateResult.data?.managedZones || []).join(",");
    profile.managed_groups = (updateResult.data?.managedGroups || []).join(",");
    renderManagedScopeProfile(profile);
    setManagedScopeFeedback("管理範圍已儲存。");
    if (typeof showToast === "function") showToast("管理範圍已儲存");
    void renderAdminOrgPermissionsOverview();
  };
  renderManagedScopeProfile(managedScopeProfiles[0] || null);
}

let orgPermissionsProfiles = [];

function jumpToManagedScopeEditor(profileId) {
  const column = document.getElementById("admin-managed-scopes-col");
  const select = document.getElementById("admin-managed-scopes-profile");
  if (!column || !select) return;
  const profile = orgPermissionsProfiles.find(candidate => String(candidate.id) === String(profileId));
  if (!profile) return;
  select.value = String(profileId);
  setManagedScopeFeedback("");
  renderManagedScopeProfile(profile);
  column.scrollIntoView({ behavior: "smooth", block: "start" });
}
window.jumpToManagedScopeEditor = jumpToManagedScopeEditor;

function renderLeaderChips(leaders) {
  if (!leaders || leaders.length === 0) {
    return '<span class="admin-org-permissions__unassigned">尚未指派</span>';
  }
  return leaders.map(profile => {
    const name = escapeHTML(String(profile.name || "").trim() || "尚未取得姓名");
    const id = escapeHTML(String(profile.id || ""));
    return `<button type="button" class="admin-org-permissions__leader-chip" data-jump-profile-id="${id}">${name}</button>`;
  }).join("");
}

export async function renderAdminOrgPermissionsOverview() {
  const column = document.getElementById("admin-org-permissions-col");
  const tree = document.getElementById("admin-org-permissions-tree");
  const count = document.getElementById("admin-org-permissions-count");
  if (!column || !tree || !count) return;

  const isAdmin = state.currentUser && getUserRoleCode(state.currentUser) === "admin";
  column.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) return;

  count.textContent = "讀取中…";
  if (firstPaint(tree)) tree.innerHTML = '<div class="admin-user-directory__empty">正在載入組織架構…</div>';

  if (!Array.isArray(state.orgStructure.regions) || state.orgStructure.regions.length === 0) {
    await db.loadOrgStructure();
  }
  const result = await db.fetchManagedScopeProfiles();
  if (result.error) {
    tree.innerHTML = '<div class="admin-user-directory__empty">無法載入權限總覽。</div>';
    count.textContent = "";
    return;
  }
  orgPermissionsProfiles = (result.data || []).filter(profile => getUserRoleCode(profile) !== "member");

  const WHOLE_CHURCH_ROLE_ORDER = ["admin", "pastor"];
  const WHOLE_CHURCH_ROLE_LABELS = { admin: "系統管理員", pastor: "牧者" };
  const wholeChurchLeadersByRole = new Map(WHOLE_CHURCH_ROLE_ORDER.map(role => [role, []]));
  const regionLeaders = new Map();
  const zoneLeaders = new Map();
  const groupLeaders = new Map();

  orgPermissionsProfiles.forEach(profile => {
    const role = getUserRoleCode(profile);
    if (wholeChurchLeadersByRole.has(role)) {
      wholeChurchLeadersByRole.get(role).push(profile);
      return;
    }
    const config = getManagedScopeConfig(profile);
    const scopes = getProfileDefaultManagedScopes(profile, config);
    const bucket = role === "great_zone_leader" ? regionLeaders
      : role === "zone_leader" ? zoneLeaders
      : role === "group_leader" ? groupLeaders
      : null;
    if (!bucket) return;
    scopes.forEach(scopeName => {
      if (!bucket.has(scopeName)) bucket.set(scopeName, []);
      bucket.get(scopeName).push(profile);
    });
  });

  const regions = state.orgStructure.regions || [];
  const zonesMap = state.orgStructure.zones || {};
  const groupsMap = state.orgStructure.groups || {};

  const unassignedCount = regions.filter(r => !regionLeaders.has(r)).length
    + Object.values(zonesMap).flat().filter(z => !zoneLeaders.has(z)).length
    + Object.values(groupsMap).flat().filter(g => !groupLeaders.has(g)).length;
  count.textContent = unassignedCount > 0 ? `${unassignedCount} 個單位尚未指派` : "全部已指派";

  const wholeChurchHtml = WHOLE_CHURCH_ROLE_ORDER.map(role => `
    <div class="admin-org-permissions__whole-church">
      <span>${escapeHTML(WHOLE_CHURCH_ROLE_LABELS[role])}（全教會範圍）</span>
      <div class="admin-org-permissions__leaders">${renderLeaderChips(wholeChurchLeadersByRole.get(role))}</div>
    </div>`).join("");

  const regionsHtml = regions.length === 0
    ? '<div class="admin-user-directory__empty">目前沒有任何大區資料。</div>'
    : regions.map(region => {
      const zones = zonesMap[region] || [];
      const zonesHtml = zones.map(zone => {
        const groups = groupsMap[zone] || [];
        const groupsHtml = groups.length === 0 ? "" : `
          <ul class="admin-org-permissions__groups">
            ${groups.map(group => `
              <li class="admin-org-permissions__group-row">
                <span class="admin-org-permissions__unit-name">${escapeHTML(group)}</span>
                <div class="admin-org-permissions__leaders">${renderLeaderChips(groupLeaders.get(group))}</div>
              </li>`).join("")}
          </ul>`;
        return `
          <details class="admin-org-permissions__zone">
            <summary>
              <span class="admin-org-permissions__unit-name">${escapeHTML(zone)}</span>
              <div class="admin-org-permissions__leaders">${renderLeaderChips(zoneLeaders.get(zone))}</div>
            </summary>
            ${groupsHtml}
          </details>`;
      }).join("");
      return `
        <details class="admin-org-permissions__region" open>
          <summary>
            <span class="admin-org-permissions__unit-name">${escapeHTML(region)}</span>
            <div class="admin-org-permissions__leaders">${renderLeaderChips(regionLeaders.get(region))}</div>
          </summary>
          ${zonesHtml || '<div class="admin-user-directory__empty">此大區目前沒有牧區資料。</div>'}
        </details>`;
    }).join("");

  tree.innerHTML = wholeChurchHtml + regionsHtml;

  if (!tree.dataset.jumpBound) {
    tree.dataset.jumpBound = "true";
    tree.addEventListener("click", event => {
      const chip = event.target.closest("[data-jump-profile-id]");
      if (!chip) return;
      jumpToManagedScopeEditor(chip.dataset.jumpProfileId);
    });
  }
}

let adminRegistrationStatistics = null;

function getAdminRegistrationStatisticsPlans() {
  return buildAdminRegistrationStatisticsPlans(Array.isArray(state.globalPlans) ? state.globalPlans : [],
    typeof CHURCH_PLAN_PRESETS !== "undefined" ? CHURCH_PLAN_PRESETS : {});
}

function renderAdminRegistrationStatisticsTable(title, label, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const body = safeRows.length > 0
    ? safeRows.map(row => `
        <tr>
          <td>${escapeHTML(row.label || "未設定")}</td>
          <td>${Number(row.signupCount || 0)}</td>
          <td>${Number(row.registeredCount || 0)}</td>
          <td>${Number(row.team3Count || 0)}</td>
          <td>${Number(row.team6Count || 0)}</td>
        </tr>`).join("")
    : `<tr><td colspan="5" class="admin-registration-statistics__empty">目前沒有資料</td></tr>`;
  return `
    <section class="admin-registration-statistics__table-section">
      <h4>${title}</h4>
      <div class="admin-registration-statistics__table-scroll">
        <table>
          <thead>
            <tr>
              <th>${label}</th>
              <th>報名人數</th>
              <th>註冊人數</th>
              <th>3 人團隊人數</th>
              <th>6 人團隊人數</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>`;
}

function sanitizeRegistrationStatisticsText(value) {
  return String(value || "未設定")
    .replaceAll("/", "／")
    .replace(/[\r\n]+/g, " ")
    .trim() || "未設定";
}

function getAdminRegistrationStatisticsSummary(context) {
  return resolveAdminRegistrationSummary(context);
}

function renderAdminRegistrationStatisticsSummary(context) {
  const summary = getAdminRegistrationStatisticsSummary(context);
  const items = [
    ["無牧區資料未加入計畫", summary.withoutPastoralZoneNotJoined],
    ["無牧區資料已加入計畫", summary.withoutPastoralZoneJoined],
    ["有牧區資料未加入計畫", summary.withPastoralZoneNotJoined],
    ["有牧區資料已加入計畫", summary.withPastoralZoneJoined],
    ["總參加人數", summary.totalJoined, true],
    ["總註冊人數", summary.totalRegistered, true]
  ];
  return `
    <section class="admin-registration-statistics__summary" aria-labelledby="admin-registration-statistics-summary-title">
      <h4 id="admin-registration-statistics-summary-title">牧區資料與計畫參加總覽</h4>
      <div class="admin-registration-statistics__summary-grid">
        ${items.map(([label, value, isTotal]) => `
          <div class="admin-registration-statistics__summary-item${isTotal ? " admin-registration-statistics__summary-item--total" : ""}">
            <span>${label}</span>
            <strong>${Number(value || 0)}</strong>
          </div>`).join("")}
      </div>
    </section>`;
}

export function convertAdminRegistrationStatisticsToCSV(context, exportedAt = new Date()) {
  const greatRegions = Array.isArray(context && context.greatRegions) ? context.greatRegions : [];
  const pastoralZones = Array.isArray(context && context.pastoralZones) ? context.pastoralZones : [];
  const summary = getAdminRegistrationStatisticsSummary(context);
  const esc = val => `"${String(val ?? "").replace(/"/g, '""')}"`;
  const formatRows = rows => rows.map(row => [
    esc(sanitizeRegistrationStatisticsText(row.label)),
    esc(Number(row.signupCount || 0)),
    esc(Number(row.registeredCount || 0)),
    esc(Number(row.team3Count || 0)),
    esc(Number(row.team6Count || 0))
  ].join(","));

  return prependTaiwanExportTime([
    [esc("統計項目"), esc("人數")].join(","),
    [esc("無牧區資料未加入計畫"), esc(Number(summary.withoutPastoralZoneNotJoined || 0))].join(","),
    [esc("無牧區資料已加入計畫"), esc(Number(summary.withoutPastoralZoneJoined || 0))].join(","),
    [esc("有牧區資料未加入計畫"), esc(Number(summary.withPastoralZoneNotJoined || 0))].join(","),
    [esc("有牧區資料已加入計畫"), esc(Number(summary.withPastoralZoneJoined || 0))].join(","),
    [esc("總參加人數"), esc(Number(summary.totalJoined || 0))].join(","),
    [esc("總註冊人數"), esc(Number(summary.totalRegistered || 0))].join(","),
    "",
    [esc("大區"), esc("報名人數"), esc("註冊人數"), esc("3 人團隊人數"), esc("6 人團隊人數")].join(","),
    ...formatRows(sortByChurchOrgOrder(greatRegions, compareGreatRegions, row => row.label)),
    "",
    [esc("牧區"), esc("報名人數"), esc("註冊人數"), esc("3 人團隊人數"), esc("6 人團隊人數")].join(","),
    ...formatRows(sortByChurchOrgOrder(pastoralZones, comparePastoralZones, row => row.label))
  ].join("\n"), exportedAt);
}

function exportAdminRegistrationStatistics() {
  if (!adminRegistrationStatistics) return;
  const csvContent = convertAdminRegistrationStatisticsToCSV(adminRegistrationStatistics);
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const planName = String(adminRegistrationStatistics.planName || "讀經計畫")
    .replace(/[\\/:*?"<>|]/g, "-");
  anchor.href = url;
  const todayTW = formatTaiwanDate();
  anchor.download = `報名與註冊統計-${planName}-${todayTW}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Zone leaders come from the org-permissions data source (managed_zones/pastoral_zone), not the registration-stats RPC — it has no leader field. */
async function buildPastoralZoneLeaderNameMap() {
  const map = new Map();
  const result = await db.fetchManagedScopeProfiles();
  if (result.error) return map;
  (result.data || []).forEach(profile => {
    if (getUserRoleCode(profile) !== "zone_leader") return;
    const config = getManagedScopeConfig(profile);
    const scopes = getProfileDefaultManagedScopes(profile, config);
    const name = String(profile.name || "").trim();
    if (!name) return;
    scopes.forEach(zoneName => {
      const existing = map.get(zoneName);
      map.set(zoneName, existing ? `${existing}、${name}` : name);
    });
  });
  return map;
}

export async function buildAdminRegistrationStatisticsSheetPayload(context) {
  const greatRegions = Array.isArray(context && context.greatRegions) ? context.greatRegions : [];
  const pastoralZones = Array.isArray(context && context.pastoralZones) ? context.pastoralZones : [];
  const summary = getAdminRegistrationStatisticsSummary(context);
  const leaderNameByZone = await buildPastoralZoneLeaderNameMap();

  const toRow = row => ({
    label: sanitizeRegistrationStatisticsText(row.label),
    signupCount: Number(row.signupCount || 0),
    registeredCount: Number(row.registeredCount || 0),
    team3Count: Number(row.team3Count || 0),
    team6Count: Number(row.team6Count || 0)
  });

  return {
    planName: String(context && context.planName || ""),
    greatRegions: sortByChurchOrgOrder(greatRegions, compareGreatRegions, row => row.label).map(toRow),
    pastoralZones: sortByChurchOrgOrder(pastoralZones, comparePastoralZones, row => row.label).map(row => ({
      ...toRow(row),
      leaderName: leaderNameByZone.get(sanitizeRegistrationStatisticsText(row.label)) || ""
    })),
    summary: {
      withoutPastoralZoneNotJoined: Number(summary.withoutPastoralZoneNotJoined || 0),
      withoutPastoralZoneJoined: Number(summary.withoutPastoralZoneJoined || 0),
      withPastoralZoneNotJoined: Number(summary.withPastoralZoneNotJoined || 0),
      withPastoralZoneJoined: Number(summary.withPastoralZoneJoined || 0),
      totalJoined: Number(summary.totalJoined || 0),
      totalRegistered: Number(summary.totalRegistered || 0)
    }
  };
}

async function syncAdminRegistrationStatisticsToSheet() {
  if (!adminRegistrationStatistics) return;
  const button = document.getElementById("admin-registration-statistics-sheet-sync");
  if (button) {
    button.disabled = true;
    button.textContent = "更新中…";
  }
  try {
    const payload = await buildAdminRegistrationStatisticsSheetPayload(adminRegistrationStatistics);
    const result = await db.syncRegistrationStatisticsToSheet(payload);
    if (typeof showToast === "function") {
      showToast(result && result.success ? "已更新到 Google 試算表。" : (result && result.message) || "更新到 Google 試算表失敗，請稍後再試。");
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "更新到 Google 試算表";
    }
  }
}

async function loadAdminRegistrationStatistics(globalPlanId) {
  const content = document.getElementById("admin-registration-statistics-content");
  const exportButton = document.getElementById("admin-registration-statistics-export");
  const sheetSyncButton = document.getElementById("admin-registration-statistics-sheet-sync");
  if (!content || !exportButton) return;
  adminRegistrationStatistics = null;
  exportButton.disabled = true;
  if (sheetSyncButton) sheetSyncButton.disabled = true;
  if (firstPaint(content)) content.innerHTML = '<div class="admin-registration-statistics__empty">讀取統計資料中…</div>';

  const result = await db.getAdminRegistrationStatistics(globalPlanId);
  if (!result || !result.success) {
    content.innerHTML = `
      <div class="admin-registration-statistics__empty" role="status">
        ${escapeHTML(result && result.message || "目前無法載入報名與註冊統計。")}
      </div>`;
    return;
  }

  adminRegistrationStatistics = result.context;
  content.innerHTML = `
    ${renderAdminRegistrationStatisticsSummary(result.context)}
    <div class="admin-registration-statistics__tables">
      ${renderAdminRegistrationStatisticsTable("大區統計", "大區", result.context.greatRegions)}
      ${renderAdminRegistrationStatisticsTable("牧區統計", "牧區", result.context.pastoralZones)}
    </div>`;
  exportButton.disabled = false;
  if (sheetSyncButton) sheetSyncButton.disabled = false;
}

export async function renderAdminRegistrationStatistics() {
  const column = document.getElementById("admin-registration-statistics-col");
  const planSelect = document.getElementById("admin-registration-statistics-plan");
  const exportButton = document.getElementById("admin-registration-statistics-export");
  if (!column || !planSelect || !exportButton) return;

  const isAdmin = state.currentUser && getUserRoleCode(state.currentUser) === "admin";
  column.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) return;

  const plans = getAdminRegistrationStatisticsPlans();
  planSelect.innerHTML = "";
  if (plans.length === 0) {
    planSelect.options.add(new Option("目前沒有可統計的讀經計畫", ""));
    planSelect.disabled = true;
    document.getElementById("admin-registration-statistics-content").innerHTML =
      '<div class="admin-registration-statistics__empty">目前沒有可統計的讀經計畫。</div>';
    return;
  }

  plans.forEach(plan => planSelect.options.add(new Option(plan.name || "未命名計畫", String(plan.id))));
  // Default to the first phase plan (containing "第一期" or "第1期" in name, or fallback to the oldest plan)
  let defaultPlan = plans.find(plan => (plan.name || "").includes("第1階段") || (plan.name || "").includes("第一輪"));
  if (!defaultPlan && plans.length > 0) {
    defaultPlan = plans[plans.length - 1]; // plans is sorted descending by startDate, so the last is the oldest
  }
  if (defaultPlan && Array.from(planSelect.options).some(option => option.value === String(defaultPlan.id))) {
    planSelect.value = String(defaultPlan.id);
  }
  planSelect.onchange = () => loadAdminRegistrationStatistics(planSelect.value);
  exportButton.onclick = exportAdminRegistrationStatistics;
  const sheetSyncButton = document.getElementById("admin-registration-statistics-sheet-sync");
  if (sheetSyncButton) sheetSyncButton.onclick = syncAdminRegistrationStatisticsToSheet;
  await loadAdminRegistrationStatistics(planSelect.value);
  if (typeof hydrateIcons === "function") hydrateIcons(column);
}

const ADMIN_SYSTEM_SUBTABS = ['users', 'permissions', 'registrations', 'reports', 'settings'];
let activeAdminSystemSubtab = ADMIN_SYSTEM_SUBTABS[0];

function setAdminSystemSubtab(subtab) {
  const requested = ADMIN_SYSTEM_SUBTABS.includes(subtab) ? subtab : ADMIN_SYSTEM_SUBTABS[0];
  activeAdminSystemSubtab = requested;
  try {
    sessionStorage.setItem('selected_admin_system_subtab', requested);
  } catch (_e) {}

  document.querySelectorAll('#admin-system-subtabs [data-system-subtab]').forEach(button => {
    const active = button.dataset.systemSubtab === requested;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  ADMIN_SYSTEM_SUBTABS.forEach(name => {
    const panel = document.getElementById(`admin-system-subtab-${name}`);
    if (!panel) return;
    panel.classList.toggle('hidden', name !== requested);
    panel.style.display = name === requested ? 'flex' : 'none';
  });
}

function initAdminSystemSubtabs() {
  const nav = document.getElementById('admin-system-subtabs');
  if (!nav || nav.dataset.listenerBound) return;
  nav.dataset.listenerBound = 'true';
  nav.querySelectorAll('[data-system-subtab]').forEach(button => {
    button.addEventListener('click', () => setAdminSystemSubtab(button.dataset.systemSubtab));
  });
  let savedSubtab = ADMIN_SYSTEM_SUBTABS[0];
  try {
    savedSubtab = sessionStorage.getItem('selected_admin_system_subtab') || ADMIN_SYSTEM_SUBTABS[0];
  } catch (_e) {}
  setAdminSystemSubtab(savedSubtab);
}

export function init() {
  void renderAdminFeatureSettings();
  void renderAdminUserDirectory();
  void renderAdminOrgPermissionsOverview();
  initAdminSystemSubtabs();
  void renderAdminManagedScopes();
  void renderAdminRegistrationStatistics();
  initAdminTeamRegistration();

  // Bind collapse toggles for every 加入計畫狀況 card (已加入計畫 and 尚未加入計畫
  // both use the same .admin-unjoined-plan-card markup) — each header toggles
  // only its own card, resolved via closest()/scoped querySelector rather than
  // hardcoded ids, so this works uniformly no matter how many such cards exist.
  document.querySelectorAll(".admin-unjoined-plan-card__header").forEach(header => {
    if (header.dataset.listenerBound) return;
    header.dataset.listenerBound = "true";
    header.addEventListener("click", (event) => {
      if (event.target.closest?.("button")) return;
      const section = header.closest(".admin-unjoined-plan-card");
      if (!section) return;
      const arrow = header.querySelector(".admin-unjoined-toggle-arrow");
      const membersList = section.querySelector(".admin-unjoined-plan-members");
      const desc = header.querySelector(".admin-unjoined-plan-desc");

      const isCollapsed = section.classList.toggle("collapsed");
      if (isCollapsed) {
        if (membersList) membersList.style.display = "none";
        if (desc) desc.style.display = "none";
        if (arrow) arrow.style.transform = "rotate(-90deg)";
      } else {
        if (membersList) membersList.style.display = "";
        if (desc) desc.style.display = "";
        if (arrow) arrow.style.transform = "rotate(0deg)";
      }
    });
  });
}

const MANAGEMENT_ROLES = ['admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader'];
let managementPlanSelectionInitialized = false;

function isSystemAdministrator() {
  const role = (state.currentUser && getUserRoleCode(state.currentUser)) || 'member';

  return role === 'admin';
}

let currentActiveAdminPanel = null;

function setAdminPrimaryPanel(panelName) {
  const isAdmin = isSystemAdministrator();
  const requested = panelName === 'system' && isAdmin ? 'system' : 'plans';
  currentActiveAdminPanel = requested;
  try {
    sessionStorage.setItem('selected_admin_panel', requested);
  } catch (_e) {}
  const tabs = document.getElementById('admin-primary-tabs');
  const systemPanel = document.getElementById('admin-system-panel');
  const plansPanel = document.getElementById('admin-plans-panel');
  if (tabs) tabs.classList.toggle('hidden', !isAdmin);
  if (systemPanel) {
    systemPanel.classList.toggle('hidden', requested !== 'system');
    systemPanel.style.display = requested === 'system' ? 'grid' : 'none';
  }
  if (plansPanel) {
    plansPanel.classList.remove('hidden');
    plansPanel.style.display = requested === 'plans' ? 'block' : 'none';
    plansPanel.style.visibility = 'visible';
    plansPanel.style.opacity = '1';
  }
  document.querySelectorAll('[data-admin-panel]').forEach(button => {
    const active = button.dataset.adminPanel === requested;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function mountPlanManagementSections() {
  const orgFilterSlot = document.getElementById('admin-plan-org-filter-slot');
  const joinStatusPanel = document.getElementById('admin-plan-subtab-join-status');
  const participantSlot = document.getElementById('admin-plan-participants-slot');
  const statisticsSlot = document.getElementById('admin-plan-statistics-slot');
  const orgControls = document.getElementById('members-organization-controls');
  const unjoinedSection = document.getElementById('admin-unjoined-plan-section');
  const memberList = document.getElementById('member-list-container');
  const statsSection = document.getElementById('stats-group-section');

  if (participantSlot) {
    participantSlot.classList.remove('hidden');
    participantSlot.style.display = 'block';
  }

  if (statisticsSlot) {
    statisticsSlot.classList.remove('hidden');
    statisticsSlot.style.display = 'block';
  }

  // The region/zone/group filters are shared across all four plan-management
  // tabs, so they move into the filter slot above the tab bar rather than
  // into any one tab's panel.
  if (orgFilterSlot && orgControls) {
    if (orgControls.parentElement !== orgFilterSlot) orgFilterSlot.appendChild(orgControls);
    orgControls.classList.remove('hidden');
    orgControls.style.display = 'flex';
  }

  // 尚未加入計畫 sits in the 加入計畫狀況 tab, below the (native) 已加入計畫 card.
  if (joinStatusPanel && unjoinedSection) {
    if (unjoinedSection.parentElement !== joinStatusPanel) joinStatusPanel.appendChild(unjoinedSection);
    unjoinedSection.classList.remove('hidden');
    unjoinedSection.style.display = 'block';
  }

  if (participantSlot && memberList) {
    if (memberList.parentElement !== participantSlot) participantSlot.appendChild(memberList);
    memberList.classList.remove('hidden');
    memberList.style.display = 'block';
  }

  if (statisticsSlot && statsSection) {
    if (statsSection.parentElement !== statisticsSlot) statisticsSlot.appendChild(statsSection);
    statsSection.classList.remove('hidden');
    statsSection.style.display = 'flex';
  }
}

const ADMIN_PLAN_SUBTABS = ['join-status', 'members', 'teams', 'statistics', 'quizzes', 'exam'];
let activeAdminPlanSubtab = ADMIN_PLAN_SUBTABS[0];
const adminDailyQuizDashboardCache = new Map();

function setAdminPlanSubtab(subtab, loadData = true) {
  const requested = ADMIN_PLAN_SUBTABS.includes(subtab) ? subtab : ADMIN_PLAN_SUBTABS[0];
  activeAdminPlanSubtab = requested;
  try {
    sessionStorage.setItem('selected_admin_plan_subtab', requested);
  } catch (_e) {}

  document.querySelectorAll('#admin-plan-subtabs [data-plan-subtab]').forEach(button => {
    const active = button.dataset.planSubtab === requested;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  ADMIN_PLAN_SUBTABS.forEach(name => {
    const panel = document.getElementById(`admin-plan-subtab-${name}`);
    if (!panel) return;
    panel.classList.toggle('hidden', name !== requested);
    panel.style.display = name === requested ? 'flex' : 'none';
  });
  // 小測驗的「發布範圍」已經在發布面板內提供完整的大區／牧區／小組
  // 選擇器；隱藏共用查看範圍，避免畫面上下出現兩組相同篩選器。
  const sharedOrgFilter = document.querySelector('.admin-plan-filter-card--org');
  if (sharedOrgFilter) {
    const hideSharedOrgFilter = requested === 'quizzes' || requested === 'exam';
    sharedOrgFilter.classList.toggle('hidden', hideSharedOrgFilter);
    sharedOrgFilter.style.display = hideSharedOrgFilter ? 'none' : 'flex';
  }
  // 大測驗有自己的「試卷清單」下拉，不吃共用的「計畫篩選」。
  const sharedPlanFilter = document.querySelector('.admin-plan-filter-card:not(.admin-plan-filter-card--org)');
  if (sharedPlanFilter) {
    const hidePlanFilter = requested === 'exam';
    sharedPlanFilter.classList.toggle('hidden', hidePlanFilter);
    sharedPlanFilter.style.display = hidePlanFilter ? 'none' : 'flex';
  }
  if (loadData && state.activePlan) {
    void loadActiveAdminPlanSubtab(false);
  }
}

function initAdminPlanSubtabs() {
  const nav = document.getElementById('admin-plan-subtabs');
  if (!nav || nav.dataset.listenerBound) return;
  nav.dataset.listenerBound = 'true';
  nav.querySelectorAll('[data-plan-subtab]').forEach(button => {
    button.addEventListener('click', () => setAdminPlanSubtab(button.dataset.planSubtab));
  });
  let savedSubtab = ADMIN_PLAN_SUBTABS[0];
  try {
    savedSubtab = sessionStorage.getItem('selected_admin_plan_subtab') || ADMIN_PLAN_SUBTABS[0];
  } catch (_e) {}
  // The selected plan is resolved immediately afterwards by
  // renderAdminPlanManagement(). Avoid starting a stale/duplicate request
  // against whatever plan happened to be active before opening Admin.
  // Tab visibility is (re)asserted authoritatively by renderAdminFeatureSettings()
  // once the speed_reading_exam flag is known; use the cached value meanwhile.
  applyAdminExamVisibility(window.speedReadingExamFeatureEnabled === true);
  setAdminPlanSubtab(savedSubtab, false);
}

function getManagementPlanStageNo(plan) {
  const presetMatch = String(plan && plan.presetKey || '').match(/^church_stage_(\d+)$/);
  return Number(plan && plan.stageNo || (presetMatch && presetMatch[1]) || 0);
}

function getManagementPlanStatus(plan, today = new Date()) {
  const startValue = plan && (plan.startDate || plan.start_date);
  const endValue = plan && (plan.endDate || plan.end_date);
  const startDate = startValue ? new Date(`${String(startValue).slice(0, 10)}T00:00:00`) : null;
  const endDate = endValue ? new Date(`${String(endValue).slice(0, 10)}T23:59:59`) : null;
  if (!startDate || !endDate || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 'unknown';
  if (today < startDate) return 'upcoming';
  if (today > endDate) return 'completed';
  return 'ongoing';
}

function getManagementPlans() {
  const seen = new Set();
  const plans = [...(state.activePlans || []), ...(state.globalPlans || [])].reduce((result, sourcePlan) => {
    const key = String(sourcePlan.globalPlanId || sourcePlan.id || sourcePlan.presetKey || sourcePlan.name || '');
    if (!key || seen.has(key) || sourcePlan.planKind === 'church_campaign') return result;
    seen.add(key);

    let plan = sourcePlan;
    if ((!Array.isArray(plan.days) || plan.days.length === 0) && typeof generatePlanObject === 'function') {
      const books = plan.books || plan.target_books || [];
      if (books.length > 0) {
        plan = generatePlanObject(plan.name, plan.startDate || plan.start_date, plan.endDate || plan.end_date, books, plan.presetKey || plan.id, plan.level || 'normal', plan.isFixed !== false && plan.is_fixed !== false);
        plan.globalPlanId = sourcePlan.globalPlanId || sourcePlan.id;
        plan.id = sourcePlan.id || plan.id;
        plan.name = sourcePlan.name || plan.name;
        plan.planKind = sourcePlan.planKind;
        plan.stageNo = sourcePlan.stageNo;
      }
    }
    const status = getManagementPlanStatus(plan);
    const hidden = typeof isPlanHidden === 'function' && isPlanHidden(plan);
    // A future fixed plan can accept enrollments before its official start date.
    // Once it is released (not hidden), leaders must be able to inspect its join
    // status too. Keep unreleased future stages out of this people-facing report.
    const isOpenEarlyEnrollment = status === 'upcoming' && !hidden;
    if ((status === 'ongoing' || status === 'completed' || isOpenEarlyEnrollment)
      && !(hidden && !canManageHiddenPlans())) {
      result.push({ ...plan, managementStatus: status });
    }
    return result;
  }, []);

  const statusPriority = { ongoing: 0, upcoming: 1, completed: 2 };
  return plans.sort((left, right) => {
    const statusDifference = (statusPriority[left.managementStatus] ?? 3) - (statusPriority[right.managementStatus] ?? 3);
    if (statusDifference !== 0) return statusDifference;
    const leftEnd = String(left.endDate || left.end_date || '');
    const rightEnd = String(right.endDate || right.end_date || '');
    return rightEnd.localeCompare(leftEnd);
  });
}

async function selectManagementPlan(planKey, forceRefresh = false) {
  try {
    const plans = getManagementPlans();
    const plan = plans.find(item => [item.globalPlanId, item.id, item.presetKey, item.name].filter(Boolean).map(String).includes(String(planKey))) || plans[0] || null;
    if (!plan) return;
    state.activePlan = plan;
    if (typeof window.syncActivePlanContext === 'function') window.syncActivePlanContext(plan);
    localStorage.setItem('selected_plan_key', String(plan.presetKey || plan.globalPlanId || plan.id || ''));
    window.currentPlanViewState = 'ORG_STATS';
    await loadActiveAdminPlanSubtab(forceRefresh);
  } catch (err) {
    console.error("[AdminManagement] Error in selectManagementPlan:", err);
  }
}

function adminQuizDateToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function adminDailyQuizDashboardCacheKey(plan, quizDate) {
  const planKey = plan?.globalPlanId || plan?.id || plan?.presetKey || plan?.name || 'unknown-plan';
  return `${String(planKey)}:${String(quizDate)}`;
}

function adminQuizEscape(value) {
  return typeof escapeHTML === 'function' ? escapeHTML(String(value ?? '')) : String(value ?? '');
}

function adminQuizPublisherLabel(role) {
  return ({
    admin: '系統管理員', pastor: '牧者', great_zone_leader: '大區長',
    zone_leader: '區長', group_leader: '小組長'
  })[role] || '管理者';
}

function renderAdminQuizQuestionEditor(quiz, locked = false) {
  const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
  if (questions.length !== 5) return '<p class="admin-daily-quiz-empty">題目尚未生成完成。</p>';
  return `<div class="admin-daily-quiz-editor" data-quiz-carousel>
    <div class="admin-daily-quiz-carousel-status">
      <strong data-quiz-slide-label>第 1 題／共 5 題</strong>
      <div class="admin-daily-quiz-carousel-dots" aria-label="題目進度">
        ${questions.map((_, index) => `<button type="button" data-quiz-slide-dot="${index}" class="${index === 0 ? 'active' : ''}" aria-label="前往第 ${index + 1} 題" ${index === 0 ? 'aria-current="step"' : ''}></button>`).join('')}
      </div>
    </div>
    <div class="admin-daily-quiz-carousel-track" data-quiz-slide-track>
    ${questions.map((question, questionIndex) => `
      <fieldset class="admin-daily-quiz-question admin-daily-quiz-question-slide" data-question-index="${questionIndex}">
        <legend>第 ${questionIndex + 1} 題</legend>
        <label>題目<textarea class="form-control" data-field="question" rows="2" ${locked ? 'readonly' : ''}>${adminQuizEscape(question.question)}</textarea></label>
        <div class="admin-daily-quiz-options">
          ${(question.options || []).map((option, optionIndex) => `
            <label>選項 ${optionIndex + 1}<input class="form-control" data-option-index="${optionIndex}" value="${adminQuizEscape(option)}" ${locked ? 'readonly' : ''}></label>
          `).join('')}
        </div>
        <div class="admin-daily-quiz-answer-row">
          <label>正確答案<select class="form-control" data-field="correctIndex" ${locked ? 'disabled' : ''}>
            ${[0, 1, 2, 3].map(index => `<option value="${index}" ${Number(question.correctIndex) === index ? 'selected' : ''}>選項 ${index + 1}</option>`).join('')}
          </select></label>
          <label>經文出處<input class="form-control" data-field="verseRef" value="${adminQuizEscape(question.verseRef)}" ${locked ? 'readonly' : ''}></label>
        </div>
        <label>解說<textarea class="form-control" data-field="explanation" rows="2" ${locked ? 'readonly' : ''}>${adminQuizEscape(question.explanation)}</textarea></label>
      </fieldset>
    `).join('')}
    </div>
    ${locked ? '<p class="admin-daily-quiz-note">此版本已審核鎖定，僅供滑動檢視。</p>' : ''}
    <div class="admin-daily-quiz-carousel-actions">
      <button type="button" class="secondary-btn" data-quiz-slide="previous" disabled>上一題</button>
      <button type="button" class="primary-btn" data-quiz-slide="next">下一題</button>
      ${locked ? '' : `<button type="button" class="primary-btn" data-quiz-action="save" data-quiz-id="${adminQuizEscape(quiz.id)}" data-quiz-slide-save hidden>儲存五題並重新送審</button>`}
    </div>
  </div>`;
}

function bindAdminQuizCarousels(root) {
  root.querySelectorAll('[data-quiz-carousel]').forEach(carousel => {
    if (carousel.dataset.carouselBound === 'true') return;
    carousel.dataset.carouselBound = 'true';
    const track = carousel.querySelector('[data-quiz-slide-track]');
    const slides = Array.from(carousel.querySelectorAll('[data-question-index]'));
    const label = carousel.querySelector('[data-quiz-slide-label]');
    const dots = Array.from(carousel.querySelectorAll('[data-quiz-slide-dot]'));
    const previous = carousel.querySelector('[data-quiz-slide="previous"]');
    const next = carousel.querySelector('[data-quiz-slide="next"]');
    const save = carousel.querySelector('[data-quiz-slide-save]');
    if (!track || slides.length === 0) return;
    let activeIndex = 0;
    let scrollFrame = 0;

    const update = (index, shouldScroll = false) => {
      activeIndex = Math.max(0, Math.min(slides.length - 1, Number(index) || 0));
      if (label) label.textContent = `第 ${activeIndex + 1} 題／共 ${slides.length} 題`;
      dots.forEach((dot, dotIndex) => {
        dot.classList.toggle('active', dotIndex === activeIndex);
        if (dotIndex === activeIndex) dot.setAttribute('aria-current', 'step');
        else dot.removeAttribute('aria-current');
      });
      if (previous) previous.disabled = activeIndex === 0;
      if (next) next.hidden = activeIndex === slides.length - 1;
      if (save) save.hidden = activeIndex !== slides.length - 1;
      if (shouldScroll) track.scrollTo({ left: slides[activeIndex].offsetLeft, behavior: 'smooth' });
    };

    previous?.addEventListener('click', () => update(activeIndex - 1, true));
    next?.addEventListener('click', () => update(activeIndex + 1, true));
    dots.forEach((dot, index) => dot.addEventListener('click', () => update(index, true)));
    track.addEventListener('scroll', () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        const closestIndex = slides.reduce((best, slide, index) => (
          Math.abs(slide.offsetLeft - track.scrollLeft) < Math.abs(slides[best].offsetLeft - track.scrollLeft) ? index : best
        ), 0);
        update(closestIndex, false);
      });
    }, { passive: true });
    const editorWrap = carousel.closest('[data-editor-for]');
    const markDirty = event => {
      if (editorWrap && event.target.matches('input, textarea, select')) editorWrap.dataset.dirty = 'true';
    };
    carousel.addEventListener('input', markDirty);
    carousel.addEventListener('change', markDirty);
    carousel._updateQuizSlide = update;
    update(0, false);
  });
}

function renderAdminQuizReviewCards(context) {
  if (!context.canReview) return '';
  const quizzes = Array.isArray(context.reviewQuizzes) ? context.reviewQuizzes : [];
  const variants = ['A', 'B'];
  return `<section class="glass-card admin-daily-quiz-block">
    <div class="admin-daily-quiz-heading">
      <div><p class="admin-registration-statistics__eyebrow">牧者審核</p><h2 id="admin-quizzes-title">今日共用題庫</h2></div>
      <span class="admin-daily-quiz-request-count">AI 生成請求共 ${Number(context.automaticRequestCount || 0)} 次</span>
    </div>
    <div class="admin-daily-quiz-versions">
      ${variants.map(variant => {
        const quiz = quizzes.find(item => item.variant === variant);
        if (!quiz) return `<article class="admin-daily-quiz-version" data-quiz-version="${variant}">
          <div class="admin-daily-quiz-version-title"><strong>版本 ${variant}</strong><span class="role-badge">尚未生成</span></div>
          <div class="admin-daily-quiz-version-actions">
            <button type="button" class="secondary-btn" disabled>生成後才能編輯</button>
            <button type="button" class="primary-btn" data-quiz-action="regenerate" data-quiz-variant="${variant}">生成題目</button>
          </div>
        </article>`;
        const ready = quiz.generationStatus === 'ready';
        const approved = quiz.reviewStatus === 'approved';
        return `<article class="admin-daily-quiz-version" data-quiz-card="${adminQuizEscape(quiz.id)}" data-quiz-version="${variant}">
          <div class="admin-daily-quiz-version-title">
            <strong>版本 ${variant}</strong>
            <span class="role-badge ${approved ? 'approved' : ''}">${approved ? '已審核' : ready ? '待審核' : quiz.generationStatus === 'failed' ? '生成失敗' : '生成中'}</span>
          </div>
          ${quiz.generationError ? `<p class="admin-daily-quiz-error">${adminQuizEscape(quiz.generationError)}</p>` : ''}
          ${ready ? `<div class="admin-daily-quiz-version-actions">
            <button type="button" class="secondary-btn" data-quiz-action="toggle-edit" data-quiz-id="${adminQuizEscape(quiz.id)}">${approved ? '檢視題目' : '編輯題目'}</button>
            ${approved
              ? '<button type="button" class="secondary-btn" disabled>已審核鎖定</button>'
              : `<button type="button" class="secondary-btn" data-quiz-action="regenerate" data-quiz-id="${adminQuizEscape(quiz.id)}" data-quiz-variant="${variant}">更換題目</button>
                 <button type="button" class="primary-btn" data-quiz-action="review" data-quiz-id="${adminQuizEscape(quiz.id)}" data-approved="true">審核通過</button>`}
          </div>
          <div class="admin-daily-quiz-editor-wrap hidden" data-editor-for="${adminQuizEscape(quiz.id)}" role="dialog" aria-modal="true" aria-labelledby="admin-quiz-editor-title-${variant}">
            <div class="admin-daily-quiz-editor-shell">
              <header class="admin-daily-quiz-editor-header">
                <div><p class="admin-registration-statistics__eyebrow">${approved ? '審核後檢視' : '題目編輯'}</p><h2 id="admin-quiz-editor-title-${variant}">版本 ${variant}・五題選擇題</h2></div>
                <button type="button" class="icon-button icon-button--subtle" data-quiz-action="toggle-edit" data-quiz-id="${adminQuizEscape(quiz.id)}" data-quiz-editor-close aria-label="關閉版本 ${variant} 編輯畫面"><span class="nlc-icon" data-icon="close" aria-hidden="true"></span></button>
              </header>
              <div class="admin-daily-quiz-editor-scroll">${renderAdminQuizQuestionEditor(quiz, approved)}</div>
            </div>
          </div>`
          : quiz.generationStatus === 'failed'
            ? `<div class="admin-daily-quiz-version-actions">
                <button type="button" class="secondary-btn" disabled>生成後才能編輯</button>
                <button type="button" class="primary-btn" data-quiz-action="regenerate" data-quiz-id="${adminQuizEscape(quiz.id)}" data-quiz-variant="${variant}">重新生成題目</button>
                <button type="button" class="primary-btn" disabled>生成完成後審核</button>
              </div>`
            : `<div class="admin-daily-quiz-version-actions">
                <button type="button" class="secondary-btn" disabled>生成後才能編輯</button>
                <button type="button" class="primary-btn" disabled>生成完成後審核</button>
              </div>`}
        </article>`;
      }).join('')}
    </div>
    <p class="admin-daily-quiz-note">生成失敗可手動重試；生成成功但尚未審核時，確認後可以更換。審核通過後題目永久鎖定。</p>
  </section>`;
}

function adminQuizGroupMatchesScope(group, scope) {
  if (!scope || scope.scopeType === 'all') return true;
  if (scope.scopeType === 'group') return group.name === scope.scopeName;
  if (scope.scopeType === 'zone') return group.pastoralZone === scope.scopeName;
  if (scope.scopeType === 'region') return group.greatRegion === scope.scopeName;
  return true;
}

function renderAdminQuizScopeResults(context, scope) {
  const groups = (Array.isArray(context.managedGroups) ? context.managedGroups : [])
    .filter(group => adminQuizGroupMatchesScope(group, scope));
  if (!groups.length) return '<p class="admin-daily-quiz-empty">此範圍內目前沒有可管理的小組。</p>';
  return `<div class="admin-daily-quiz-groups">
    ${groups.map(group => {
      const publication = group.publication;
      const members = Array.isArray(group.members) ? group.members : [];
      const completed = Number(group.completedCount || 0);
      return `<details class="admin-daily-quiz-group">
        <summary>
          <span><strong>${adminQuizEscape(group.name)}</strong><small>${adminQuizEscape(group.greatRegion)}／${adminQuizEscape(group.pastoralZone)}</small></span>
          <span class="admin-daily-quiz-group-status">${publication
            ? `已由${adminQuizPublisherLabel(publication.publisherRole)}發佈版本 ${adminQuizEscape(publication.variant)} · ${completed}／${Number(group.memberCount || 0)} 完成`
            : '尚未發佈'}</span>
        </summary>
        ${publication ? `<div class="admin-daily-quiz-results">
          <div class="admin-daily-quiz-metrics"><span>已發佈 <strong>${Number(group.memberCount || 0)} 人</strong></span><span>已完成 <strong>${completed} 人</strong></span><span>平均 <strong>${group.averageScore == null ? '—' : Number(group.averageScore).toFixed(1)}</strong></span></div>
          <div class="admin-daily-quiz-member-list">
            ${members.map(member => `<div><span>${adminQuizEscape(member.name)}</span><span>${member.completed ? `已完成 · ${Number(member.score || 0)}／${Number(member.total || 0)}` : '尚未作答'}</span></div>`).join('')}
          </div>
        </div>` : '<p class="admin-daily-quiz-empty">發佈後才會顯示組員作答狀況。</p>'}
      </details>`;
    }).join('')}
  </div>`;
}

function renderAdminQuizScopeSelectorHtml(prefix) {
  return `<div class="admin-daily-quiz-scope-row" id="${prefix}-scope-row">
    <select id="${prefix}-region-select" class="form-control"></select>
    <select id="${prefix}-zone-select" class="form-control"></select>
    <select id="${prefix}-group-select" class="form-control"></select>
    <select id="${prefix}-master-select" class="hidden" style="display:none;"></select>
  </div>`;
}

function getAdminQuizScope(prefix) {
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

function renderAdminQuizCustomQuestionBlock(index, question = {}) {
  return `<fieldset class="admin-daily-quiz-question admin-quiz-custom-question" data-question-index="${index}">
    <legend>第 ${index + 1} 題 <button type="button" class="icon-button icon-button--subtle" data-quiz-custom-remove aria-label="刪除第 ${index + 1} 題"><span class="nlc-icon" data-icon="close" aria-hidden="true"></span></button></legend>
    <label>題目<textarea class="form-control" data-field="question" rows="2">${adminQuizEscape(question.question || '')}</textarea></label>
    <div class="admin-daily-quiz-options">
      ${[0, 1, 2, 3].map(optionIndex => `<label>選項 ${optionIndex + 1}<input class="form-control" data-option-index="${optionIndex}" value="${adminQuizEscape((question.options || [])[optionIndex] || '')}"></label>`).join('')}
    </div>
    <div class="admin-daily-quiz-answer-row">
      <label>正確答案<select class="form-control" data-field="correctIndex">
        ${[0, 1, 2, 3].map(optionIndex => `<option value="${optionIndex}" ${Number(question.correctIndex) === optionIndex ? 'selected' : ''}>選項 ${optionIndex + 1}</option>`).join('')}
      </select></label>
      <label>經文出處<input class="form-control" data-field="verseRef" value="${adminQuizEscape(question.verseRef || '')}"></label>
    </div>
    <label>解說<textarea class="form-control" data-field="explanation" rows="2">${adminQuizEscape(question.explanation || '')}</textarea></label>
  </fieldset>`;
}

function renderAdminQuizCustomEditorHtml(context) {
  const reviewQuizzes = Array.isArray(context?.reviewQuizzes) ? context.reviewQuizzes : [];
  const canCopy = variant => reviewQuizzes.some(item => item.variant === variant && Array.isArray(item.questions) && item.questions.length > 0);
  return `<div class="admin-daily-quiz-editor admin-quiz-custom-editor" data-quiz-custom-editor>
    <div class="admin-quiz-custom-copy-row">
      <span class="admin-quiz-custom-copy-label">從既有版本開始：</span>
      <button type="button" class="secondary-btn" data-quiz-custom-copy="A" ${canCopy('A') ? '' : 'disabled'}>複製 A 版題目</button>
      <button type="button" class="secondary-btn" data-quiz-custom-copy="B" ${canCopy('B') ? '' : 'disabled'}>複製 B 版題目</button>
    </div>
    <div class="admin-quiz-custom-questions" data-quiz-custom-questions>
      ${[0, 1].map(index => renderAdminQuizCustomQuestionBlock(index)).join('')}
    </div>
    <div class="admin-daily-quiz-carousel-actions">
      <button type="button" class="secondary-btn" data-quiz-custom-add>新增題目</button>
    </div>
    <p class="admin-daily-quiz-note">自訂題目 2～10 題，發佈者自行負責內容，不需牧者審核，也不會出現在牧者共用審核清單。可先複製 A／B 版題目再修改。</p>
  </div>`;
}

function bindAdminQuizCustomEditor(container, onChange) {
  const list = container.querySelector('[data-quiz-custom-questions]');
  const addBtn = container.querySelector('[data-quiz-custom-add]');
  if (!list || !addBtn || container.dataset.customBound === 'true') return;
  container.dataset.customBound = 'true';
  const renumber = () => {
    Array.from(list.children).forEach((block, index) => {
      block.dataset.questionIndex = String(index);
      const legend = block.querySelector('legend');
      if (legend && legend.firstChild) legend.firstChild.textContent = `第 ${index + 1} 題 `;
      const removeBtn = block.querySelector('[data-quiz-custom-remove]');
      if (removeBtn) removeBtn.disabled = list.children.length <= 2;
    });
    addBtn.disabled = list.children.length >= 10;
  };
  container._quizCustomRenumber = renumber;
  addBtn.addEventListener('click', () => {
    if (list.children.length >= 10) return;
    list.insertAdjacentHTML('beforeend', renderAdminQuizCustomQuestionBlock(list.children.length));
    renumber();
    if (typeof hydrateIcons === 'function') hydrateIcons(list.lastElementChild);
    if (typeof onChange === 'function') onChange();
  });
  list.addEventListener('click', event => {
    const removeBtn = event.target.closest('[data-quiz-custom-remove]');
    if (!removeBtn || list.children.length <= 2) return;
    removeBtn.closest('[data-question-index]')?.remove();
    renumber();
    if (typeof onChange === 'function') onChange();
  });
  list.addEventListener('input', () => { if (typeof onChange === 'function') onChange(); });
  renumber();
}

function bindAdminQuizCustomCopyButtons(container, context, onChange) {
  const list = container.querySelector('[data-quiz-custom-questions]');
  if (!list) return;
  container.querySelectorAll('[data-quiz-custom-copy]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const variant = button.dataset.quizCustomCopy;
      const source = (context.reviewQuizzes || []).find(item => item.variant === variant && Array.isArray(item.questions) && item.questions.length);
      if (!source) return;
      const hasContent = collectAdminQuizCustomQuestions(container).some(question =>
        question.question || question.verseRef || question.explanation || question.options.some(Boolean));
      if (hasContent && !window.confirm(`複製版本 ${variant} 的題目會覆蓋目前已輸入的自訂題目，確定要複製嗎？`)) return;
      list.innerHTML = source.questions.map((question, index) => renderAdminQuizCustomQuestionBlock(index, question)).join('');
      if (typeof container._quizCustomRenumber === 'function') container._quizCustomRenumber();
      if (typeof hydrateIcons === 'function') hydrateIcons(list);
      if (typeof onChange === 'function') onChange();
    });
  });
}

function collectAdminQuizCustomQuestions(container) {
  const list = container.querySelector('[data-quiz-custom-questions]');
  if (!list) return [];
  return Array.from(list.querySelectorAll('[data-question-index]')).map((field, index) => ({
    id: `c${index + 1}`,
    question: field.querySelector('[data-field="question"]')?.value.trim() || '',
    options: [0, 1, 2, 3].map(optionIndex => field.querySelector(`[data-option-index="${optionIndex}"]`)?.value.trim() || ''),
    correctIndex: Number(field.querySelector('[data-field="correctIndex"]')?.value || 0),
    explanation: field.querySelector('[data-field="explanation"]')?.value.trim() || '',
    verseRef: field.querySelector('[data-field="verseRef"]')?.value.trim() || ''
  }));
}

function adminQuizCustomQuestionsAreValid(questions) {
  if (!Array.isArray(questions) || questions.length < 2 || questions.length > 10) return false;
  return questions.every(question =>
    question.question && question.verseRef && question.explanation
    && Array.isArray(question.options) && question.options.length === 4 && question.options.every(option => option)
  );
}

function renderAdminQuizPublishPanel(context) {
  const approvedVariants = Array.isArray(context.approvedVariants) ? context.approvedVariants : [];
  const hasApproved = variant => approvedVariants.some(item => item.variant === variant);
  return `<section class="glass-card admin-daily-quiz-block" id="admin-quiz-publish-panel">
    <div class="admin-daily-quiz-heading">
      <div><p class="admin-registration-statistics__eyebrow">組織發佈</p><h2>發佈小測驗</h2></div>
    </div>
    <div class="admin-quiz-publish-step">
      <p class="admin-quiz-publish-step-label">1. 發佈範圍</p>
      ${renderAdminQuizScopeSelectorHtml('admin-quiz-publish')}
    </div>
    <div class="admin-quiz-publish-step">
      <p class="admin-quiz-publish-step-label">2. 題目版本</p>
      <div class="admin-quiz-version-choice" role="radiogroup" aria-label="題目版本">
        <button type="button" class="secondary-btn admin-quiz-version-btn" data-quiz-version-choice="A" ${hasApproved('A') ? '' : 'disabled'}>版本 A</button>
        <button type="button" class="secondary-btn admin-quiz-version-btn" data-quiz-version-choice="B" ${hasApproved('B') ? '' : 'disabled'}>版本 B</button>
        <button type="button" class="secondary-btn admin-quiz-version-btn" data-quiz-version-choice="C">自訂題目</button>
      </div>
      <div class="admin-quiz-custom-editor-slot hidden" data-quiz-custom-slot></div>
    </div>
    <div class="admin-quiz-publish-step">
      <button type="button" class="primary-btn" id="admin-quiz-publish-btn" disabled>發佈</button>
    </div>
    <div id="admin-quiz-publish-results" aria-live="polite"></div>
  </section>`;
}

function updateAdminQuizPublishState(root, context, selectedVersion) {
  const scope = getAdminQuizScope('admin-quiz-publish');
  const resultsEl = root.querySelector('#admin-quiz-publish-results');
  if (resultsEl) resultsEl.innerHTML = renderAdminQuizScopeResults(context, scope);
  const publishBtn = root.querySelector('#admin-quiz-publish-btn');
  if (!publishBtn) return;
  let ready = false;
  if (selectedVersion === 'A' || selectedVersion === 'B') {
    ready = (context.approvedVariants || []).some(item => item.variant === selectedVersion);
  } else if (selectedVersion === 'C') {
    const slot = root.querySelector('[data-quiz-custom-slot]');
    ready = slot ? adminQuizCustomQuestionsAreValid(collectAdminQuizCustomQuestions(slot)) : false;
  }
  publishBtn.disabled = !ready;
}

function bindAdminQuizPublishPanel(root, context, quizDate) {
  const panel = root.querySelector('#admin-quiz-publish-panel');
  if (!panel) return;
  if (typeof window.setupCascadingSelectors === 'function') {
    window.setupCascadingSelectors('admin-quiz-publish-region-select', 'admin-quiz-publish-zone-select', 'admin-quiz-publish-group-select', 'admin-quiz-publish-master-select');
  }
  let selectedVersion = null;
  const versionButtons = Array.from(panel.querySelectorAll('[data-quiz-version-choice]'));
  const customSlot = panel.querySelector('[data-quiz-custom-slot]');
  const refresh = () => updateAdminQuizPublishState(root, context, selectedVersion);

  ['region', 'zone', 'group'].forEach(part => {
    panel.querySelector(`#admin-quiz-publish-${part}-select`)?.addEventListener('change', refresh);
  });

  versionButtons.forEach(button => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      selectedVersion = button.dataset.quizVersionChoice;
      versionButtons.forEach(other => other.classList.toggle('active', other === button));
      if (selectedVersion === 'C') {
        if (!customSlot.dataset.rendered) {
          customSlot.innerHTML = renderAdminQuizCustomEditorHtml(context);
          customSlot.dataset.rendered = 'true';
          bindAdminQuizCustomEditor(customSlot, refresh);
          bindAdminQuizCustomCopyButtons(customSlot, context, refresh);
          if (typeof hydrateIcons === 'function') hydrateIcons(customSlot);
        }
        customSlot.classList.remove('hidden');
      } else {
        customSlot.classList.add('hidden');
      }
      refresh();
    });
  });

  panel.querySelector('#admin-quiz-publish-btn')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!selectedVersion) return;
    const scope = getAdminQuizScope('admin-quiz-publish');
    const scopeLabel = scope.scopeType === 'all' ? '你負責的全部小組' : scope.scopeName;
    let selection;
    if (selectedVersion === 'C') {
      const questions = collectAdminQuizCustomQuestions(customSlot);
      if (!adminQuizCustomQuestionsAreValid(questions)) {
        if (typeof showToast === 'function') showToast('自訂題目需要 2 至 10 題，且每題都要填寫完整。');
        return;
      }
      selection = { customQuestions: questions };
    } else {
      selection = { variant: selectedVersion };
    }
    if (!window.confirm(`確定發佈${selectedVersion === 'C' ? '自訂題目' : `版本 ${selectedVersion}`}給「${scopeLabel}」嗎？`)) return;
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = '發佈中…';
    const result = await db.publishDailyQuiz(state.activePlan, quizDate, scope, selection);
    if (typeof showToast === 'function') {
      showToast(result.success ? `已發佈給 ${result.data.publishedCount} 個小組` : result.message || '發佈失敗');
    }
    if (typeof window.refreshCareReminderBadge === 'function') void window.refreshCareReminderBadge({ force: true });
    if (result.success) {
      await renderAdminDailyQuizManagement(true, quizDate);
    } else {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });

  refresh();
}

function collectAdminQuizQuestions(root, quizId, originalQuestions) {
  const editor = Array.from(root.querySelectorAll('[data-editor-for]'))
    .find(element => element.dataset.editorFor === String(quizId));
  if (!editor) return null;
  return Array.from(editor.querySelectorAll('[data-question-index]')).map((field, index) => ({
    id: String(originalQuestions?.[index]?.id || `q${index + 1}`),
    question: field.querySelector('[data-field="question"]')?.value.trim() || '',
    options: [0, 1, 2, 3].map(optionIndex => field.querySelector(`[data-option-index="${optionIndex}"]`)?.value.trim() || ''),
    correctIndex: Number(field.querySelector('[data-field="correctIndex"]')?.value || 0),
    explanation: field.querySelector('[data-field="explanation"]')?.value.trim() || '',
    verseRef: field.querySelector('[data-field="verseRef"]')?.value.trim() || ''
  }));
}

async function waitForAdminQuizRegeneration(quizDate, variant, previousQuiz = null) {
  let sawGenerating = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const result = await db.getDailyQuizDashboard(state.activePlan, quizDate);
    if (!result.success) continue;
    const quiz = (result.context?.reviewQuizzes || []).find(item => item.variant === variant);
    if (quiz?.generationStatus === 'generating') {
      sawGenerating = true;
      continue;
    }
    const newlyReady = quiz?.generationStatus === 'ready'
      && (!previousQuiz || previousQuiz.generationStatus !== 'ready' || quiz.generatedAt !== previousQuiz.generatedAt);
    const newlyFailed = quiz?.generationStatus === 'failed'
      && (sawGenerating || !previousQuiz || quiz.generationError !== previousQuiz.generationError);
    if (newlyReady || newlyFailed) {
      if (typeof showToast === 'function') {
        showToast(newlyReady ? `版本 ${variant} 題目已生成，請審核內容` : `版本 ${variant} 生成失敗，請查看錯誤訊息`);
      }
      await renderAdminDailyQuizManagement(true, quizDate);
      return;
    }
  }
  await renderAdminDailyQuizManagement(true, quizDate);
}

async function bindAdminDailyQuizActions(root, context, quizDate) {
  root.querySelector('#admin-daily-quiz-date')?.addEventListener('change', event => {
    root.dataset.quizDate = event.target.value;
    void renderAdminDailyQuizManagement(false, event.target.value);
  });
  root.querySelectorAll('[data-quiz-action]').forEach(button => {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.quizAction;
      const quizId = button.dataset.quizId;
      if (action === 'toggle-edit') {
        const editor = Array.from(root.querySelectorAll('[data-editor-for]'))
          .find(element => element.dataset.editorFor === String(quizId));
        if (!editor) return;
        const opening = editor.classList.contains('hidden');
        if (!opening && editor.dataset.dirty === 'true') {
          const shouldSave = window.confirm('目前有尚未儲存的題目修改。按「確定」會先儲存再關閉；按「取消」則繼續編輯。');
          if (!shouldSave) return;
          const saveButton = editor.querySelector('[data-quiz-action="save"]');
          if (saveButton) {
            saveButton.click();
            return;
          }
        }
        editor.classList.toggle('hidden', !opening);
        document.body.classList.toggle('admin-quiz-editor-open', opening);
        if (opening) {
          editor.querySelector('[data-quiz-carousel]')?._updateQuizSlide?.(0, false);
          const editorTrack = editor.querySelector('[data-quiz-slide-track]');
          if (editorTrack) editorTrack.scrollLeft = 0;
          editor._escapeController?.abort();
          editor._escapeController = new AbortController();
          document.addEventListener('keydown', keyEvent => {
            if (keyEvent.key !== 'Escape') return;
            editor.querySelector('[data-quiz-editor-close]')?.click();
          }, { signal: editor._escapeController.signal });
          requestAnimationFrame(() => editor.querySelector('[data-quiz-editor-close]')?.focus());
        } else {
          document.body.classList.remove('admin-quiz-editor-open');
          editor._escapeController?.abort();
        }
        return;
      }
      if (action === 'regenerate') {
        const variant = String(button.dataset.quizVariant || '').toUpperCase();
        const previousQuiz = (context.reviewQuizzes || []).find(item => item.variant === variant) || null;
        const replacing = previousQuiz?.generationStatus === 'ready';
        const prompt = replacing
          ? `版本 ${variant} 已生成。更換後會清除目前題目並重新生成，且仍需重新審核。確定更換嗎？`
          : `確定要${previousQuiz ? '重新' : ''}生成版本 ${variant} 的題目嗎？`;
        if (!window.confirm(prompt)) return;
        button.disabled = true;
        const originalLabel = button.textContent;
        button.textContent = '已送出，生成中…';
        const result = await db.regenerateDailyQuiz(state.activePlan, quizDate, [variant]);
        if (!result.success) {
          button.disabled = false;
          button.textContent = originalLabel;
          if (typeof showToast === 'function') showToast(result.message || '題目生成請求失敗');
          return;
        }
        if (typeof showToast === 'function') showToast(`版本 ${variant} 已送出生成，請稍候`);
        void waitForAdminQuizRegeneration(quizDate, variant, previousQuiz);
        return;
      }
      if (action === 'review') {
        button.disabled = true;
        const result = await db.reviewDailyQuiz(quizId, button.dataset.approved === 'true');
        if (!result.success && typeof showToast === 'function') showToast(result.message || '審核失敗');
        await renderAdminDailyQuizManagement(true, quizDate);
        return;
      }
      if (action === 'save') {
        const quiz = (context.reviewQuizzes || []).find(item => String(item.id) === String(quizId));
        const questions = collectAdminQuizQuestions(root, quizId, quiz?.questions || []);
        button.disabled = true;
        const originalLabel = button.textContent;
        button.textContent = '儲存中…';
        const result = await db.updateDailyQuizQuestions(quizId, questions);
        if (typeof showToast === 'function') showToast(result.success ? '題目已更新，請重新審核' : result.message || '儲存失敗');
        if (result.success) {
          const editor = button.closest('[data-editor-for]');
          if (editor) editor.dataset.dirty = 'false';
          await renderAdminDailyQuizManagement(true, quizDate);
        } else {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }
    });
  });
}

async function renderAdminDailyQuizManagement(forceRefresh = false, requestedDate = '', prefetchedResult = null) {
  const root = document.getElementById('admin-daily-quiz-root');
  if (!root || !state.activePlan) return;
  const quizDate = /^\d{4}-\d{2}-\d{2}$/.test(String(requestedDate || ''))
    ? String(requestedDate)
    : (root.dataset.quizDate || adminQuizDateToday());
  const cacheKey = adminDailyQuizDashboardCacheKey(state.activePlan, quizDate);

  // Returning to the quiz tab for the same plan/date should reveal the DOM
  // that is already on screen. Do not re-render it and do not issue another
  // dashboard request. New data is fetched only by an explicit refresh,
  // regeneration action, date/plan change without a cache entry, or first load.
  if (!forceRefresh && !prefetchedResult && root.dataset.quizDashboardKey === cacheKey) return;

  root.querySelectorAll('[data-editor-for]').forEach(editor => editor._escapeController?.abort());
  document.body.classList.remove('admin-quiz-editor-open');
  root.dataset.quizDate = quizDate;
  let result = prefetchedResult;
  if (!result && !forceRefresh) result = adminDailyQuizDashboardCache.get(cacheKey) || null;
  if (!result) {
    if (firstPaint(root)) root.innerHTML = '<div class="admin-user-directory__empty">正在載入小測驗資料…</div>';
    result = await db.getDailyQuizDashboard(state.activePlan, quizDate);
  }
  adminDailyQuizDashboardCache.set(cacheKey, result);
  root.dataset.quizDashboardKey = cacheKey;
  if (!result.success) {
    const message = result.message || '目前無法載入小測驗資料，請稍後再試。';
    const timedOut = message.includes('逾時');
    root.innerHTML = `
      <div class="admin-daily-quiz-toolbar">
        <label for="admin-daily-quiz-date">測驗日期<input id="admin-daily-quiz-date" class="form-control" type="date" value="${adminQuizEscape(quizDate)}"></label>
        <span>版本狀態載入未完成</span>
      </div>
      <section class="glass-card admin-daily-quiz-block" aria-labelledby="admin-quiz-load-error-title">
        <div class="admin-daily-quiz-heading">
          <div><p class="admin-registration-statistics__eyebrow">題目審核</p><h2 id="admin-quiz-load-error-title">每日兩版題目</h2></div>
        </div>
        <div class="admin-daily-quiz-load-error" role="alert">
          <span class="admin-daily-quiz-load-error__icon" aria-hidden="true"><span class="nlc-icon" data-icon="refresh"></span></span>
          <div class="admin-daily-quiz-load-error__content">
            <h3>${timedOut ? '版本狀態載入逾時' : '暫時無法取得版本狀態'}</h3>
            <p>${adminQuizEscape(message)} 已保留原有題目與審核狀態。</p>
          </div>
        </div>
        <div class="admin-daily-quiz-versions">
          ${['A', 'B'].map(variant => `<article class="admin-daily-quiz-version admin-daily-quiz-version--load-failed" data-quiz-version="${variant}">
            <div class="admin-daily-quiz-version-title"><strong>版本 ${variant}</strong><span class="role-badge">狀態載入失敗</span></div>
            <p class="admin-daily-quiz-empty">暫時無法確認生成與審核狀態。</p>
            <div class="admin-daily-quiz-version-actions">
              <button type="button" class="secondary-btn" data-quiz-load-retry data-quiz-variant="${variant}">重試載入</button>
              <button type="button" class="secondary-btn" disabled>載入後才可編輯</button>
              <button type="button" class="primary-btn" disabled>載入後才可審核</button>
            </div>
          </article>`).join('')}
        </div>
      </section>`;
    root.querySelector('#admin-daily-quiz-date')?.addEventListener('change', event => {
      void renderAdminDailyQuizManagement(false, event.target.value);
    });
    root.querySelectorAll('[data-quiz-load-retry]').forEach(button => {
      button.addEventListener('click', () => {
        button.disabled = true;
        button.textContent = '載入中…';
        void renderAdminDailyQuizManagement(true, quizDate);
      });
    });
    if (typeof hydrateIcons === 'function') hydrateIcons(root);
    return;
  }
  const context = result.context || {};
  const approvedCount = Array.isArray(context.approvedVariants) ? context.approvedVariants.length : 0;
  root.innerHTML = `
    <div class="admin-daily-quiz-toolbar">
      <label for="admin-daily-quiz-date">測驗日期<input id="admin-daily-quiz-date" class="form-control" type="date" value="${adminQuizEscape(quizDate)}"></label>
      <span>${approvedCount} 版已審核</span>
    </div>
    ${renderAdminQuizReviewCards(context)}
    ${renderAdminQuizPublishPanel(context)}`;
  await bindAdminDailyQuizActions(root, context, quizDate);
  bindAdminQuizCarousels(root);
  bindAdminQuizPublishPanel(root, context, quizDate);
  if (typeof hydrateIcons === 'function') hydrateIcons(root);
}

async function loadActiveAdminPlanSubtab(forceRefresh = false) {
  const warnRejected = (label, result) => {
    if (result.status === 'rejected') console.warn(`[Admin] ${label} error caught:`, result.reason);
  };

  // The 大區/牧區/小組 org filter bar (members-organization-controls) is
  // shared across all four subtabs (mountPlanManagementSections() moves it
  // above the tab bar, outside any one tab's panel), but it only used to get
  // populated as a side effect of renderPlanMembersView() — which only runs
  // for the 'members'/'statistics' subtabs. On a fresh session the default
  // subtab is 'join-status', so the filter selects stayed empty (no
  // <option>s at all) until the user manually switched tabs. Populate them
  // here unconditionally instead — it's a cheap, synchronous DOM operation
  // (reads already-loaded state.orgStructure/state.currentUser, no network
  // call) and is idempotent (its change-listener bindings are dataset-guarded).
  if (activeAdminPlanSubtab !== 'quizzes' && activeAdminPlanSubtab !== 'exam' && typeof window.populateMembersSelector === 'function') {
    try { window.populateMembersSelector(); } catch (e) { console.warn('[Admin] populateMembersSelector error caught:', e); }
  }

  if (activeAdminPlanSubtab === 'join-status') {
    // These two independent RPCs are the only data needed for the first
    // visible subtab. Run them together instead of adding both network
    // latencies to the critical path.
    const results = await Promise.allSettled([
      renderAdminJoinedPlanMembers(forceRefresh),
      renderAdminUnjoinedPlanMembers(forceRefresh)
    ]);
    warnRejected('renderAdminJoinedPlanMembers', results[0]);
    warnRejected('renderAdminUnjoinedPlanMembers', results[1]);
    return;
  }

  if (activeAdminPlanSubtab === 'members' || activeAdminPlanSubtab === 'statistics') {
    if (typeof window.renderPlanMembersView === 'function') {
      try { await window.renderPlanMembersView(); } catch (e) { console.warn('[Admin] renderPlanMembersView error caught:', e); }
    }
    return;
  }

  if (activeAdminPlanSubtab === 'quizzes') {
    await renderAdminDailyQuizManagement(forceRefresh);
    return;
  }

  if (activeAdminPlanSubtab === 'exam') {
    const root = document.getElementById('admin-exam-root');
    if (root) {
      try { await renderExamPanel(root); } catch (e) { console.warn('[Admin] renderExamPanel error caught:', e); }
    }
    return;
  }

  if (activeAdminPlanSubtab === 'teams') {
    const results = await Promise.allSettled([
      renderAdminTeamPlacementLookup(state.activePlan, forceRefresh),
      (async () => {
        // Both divisions use the same overview payload. The first call may
        // refresh it; the second renders from the cache populated above.
        await renderAdminTeamRegistrationStatus(forceRefresh, 3, 'admin-team-status-content');
        await renderAdminTeamRegistrationStatus(false, 6, 'admin-team-status-content-6');
      })()
    ]);
    warnRejected('renderAdminTeamPlacementLookup', results[0]);
    warnRejected('renderAdminTeamRegistrationStatus', results[1]);
  }
}

export async function renderAdminPlanManagement() {
  try {
    const role = (state.currentUser && getUserRoleCode(state.currentUser)) || 'member';
    if (!MANAGEMENT_ROLES.includes(role)) {
      setAdminPrimaryPanel('plans');
      const plansPanel = document.getElementById('admin-plans-panel');
      if (plansPanel) {
        plansPanel.innerHTML = '<div class="admin-unjoined-plan-empty" style="padding: 2rem; text-align: center;">您目前沒有計畫管理權限。</div>';
      }
      return;
    }
    let savedPanel = 'plans';
    try {
      savedPanel = sessionStorage.getItem('selected_admin_panel') || currentActiveAdminPanel || 'plans';
    } catch (_e) {}
    setAdminPrimaryPanel(savedPanel);
    mountPlanManagementSections();
    initAdminPlanSubtabs();

    const select = document.getElementById('admin-management-plan-select');
    const plans = getManagementPlans();
    if (select) {
      select.innerHTML = '';
      if (plans.length === 0) {
        select.options.add(new Option('目前沒有可管理的計畫', ''));
        select.disabled = true;
      } else {
        select.disabled = false;
        plans.forEach(plan => {
          const statusLabel = plan.managementStatus === 'upcoming' ? '（提前報名）' : '';
          select.options.add(new Option(`${plan.name || '未命名計畫'}${statusLabel}`, String(plan.globalPlanId || plan.id || plan.presetKey || plan.name)));
        });
        const activeKeys = state.activePlan ? [state.activePlan.globalPlanId, state.activePlan.id, state.activePlan.presetKey, state.activePlan.name].filter(Boolean).map(String) : [];
        const matchingOption = Array.from(select.options).find(option => activeKeys.includes(option.value));
        const ongoingPlan = plans.find(plan => plan.managementStatus === 'ongoing');
        const defaultPlan = (matchingOption ? plans.find(p => String(p.globalPlanId || p.id || p.presetKey || p.name) === matchingOption.value) : null) || ongoingPlan || plans[0];
        const defaultPlanKey = String(defaultPlan.globalPlanId || defaultPlan.id || defaultPlan.presetKey || defaultPlan.name);
        select.value = !managementPlanSelectionInitialized
          ? defaultPlanKey
          : (matchingOption ? matchingOption.value : defaultPlanKey);
        managementPlanSelectionInitialized = true;
        select.onchange = () => selectManagementPlan(select.value);
        await selectManagementPlan(select.value);
      }
    }

    document.querySelectorAll('[data-admin-panel]').forEach(button => {
      button.onclick = () => setAdminPrimaryPanel(button.dataset.adminPanel);
    });

    const refreshBtn = document.getElementById('admin-plan-refresh-btn');
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = 'true';
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        try {
          // Clicking "更新" must force a genuine reload, not just re-run the
          // same render against whatever's cached. window._cachedAllUsersList
          // is keyed by plan only (not by the org filter), so without
          // clearing it here selectManagementPlan() silently reuses the
          // stale list — the button only *looked* like it worked before if
          // the org filter also happened to change and show a different
          // slice of that same stale data.
          window._cachedAllUsersList = null;
          window._cachedAllUsersListKey = null;
          const currentSelect = document.getElementById('admin-management-plan-select');
          if (currentSelect && currentSelect.value) {
            await selectManagementPlan(currentSelect.value, true);
          }
          if (typeof renderAdminOrgPermissionsOverview === 'function') void renderAdminOrgPermissionsOverview();
          if (typeof showToast === 'function') showToast('資料已更新');
        } finally {
          refreshBtn.disabled = false;
        }
      });
    }

    if (typeof hydrateIcons === 'function') hydrateIcons(document.getElementById('admin-view'));
  } catch (err) {
    console.error("[AdminManagement] Error rendering admin plan management:", err);
  }
}

// Bind to window for global access compatibility
window.renderAdminFeatureSettings = renderAdminFeatureSettings;
window.renderAdminPlanManagement = renderAdminPlanManagement;
let activeTeamDivision = 3;
let cachedTeamsData = null;
let cachedTeamsDataKey = "";
let lastRenderedTeamPlans = { 3: [], 6: [] };

function formatTeamPlanDate(value) {
  if (!value) return "";
  return formatTaiwanDate(value).replace(/-/g, "/");
}

export function convertTeamRegistrationStatusToCSV(plans, division, exportedAt = new Date()) {
  if (!Array.isArray(plans) || plans.length === 0) return "";
  const esc = val => `"${String(val ?? "").replace(/"/g, '""')}"`;
  const memberHeaders = [];
  for (let i = 2; i <= Number(division); i++) memberHeaders.push(`隊員${i}`);
  const lines = [];

  plans.forEach((item, index) => {
    const teams = Array.isArray(item.teams) ? item.teams : [];
    const planName = item.plan?.name || item.name || "（無名稱）";
    const planStart = formatTeamPlanDate(item.plan?.startDate || item.startDate);
    const planEnd = formatTeamPlanDate(item.plan?.endDate || item.endDate);
    const planPeriod = planStart && planEnd ? `${planStart}－${planEnd}` : "";
    const signupCount = teams.filter(team => team.status === "forming").length;
    const readyCount = teams.filter(team => team.status === "ready").length;
    const totalMembers = teams.reduce((acc, team) => acc + (team.memberCount || 0), 0);

    if (index > 0) lines.push("");
    lines.push([esc("計畫"), esc(planName)].join(","));
    if (planPeriod) lines.push([esc("計畫期間"), esc(planPeriod)].join(","));
    lines.push([esc("招募中"), esc(`${signupCount} 隊`)].join(","));
    lines.push([esc("已成隊"), esc(`${readyCount} 隊`)].join(","));
    lines.push([esc("總報名人數"), esc(`${totalMembers} 人`)].join(","));
    lines.push("");
    lines.push([esc("隊長所屬牧區"), esc("隊名"), esc("狀態"), esc("人數"), esc("隊長"), ...memberHeaders.map(esc)].join(","));

    const sortedTeams = sortByChurchOrgOrder(teams, comparePastoralZones, team => {
      const members = Array.isArray(team.members) ? team.members : [];
      const captain = members.find(member => member.role === "captain") || {};
      return team.captainPastoralZone || captain.pastoralZone || "";
    });
    sortedTeams.forEach(team => {
      const members = Array.isArray(team.members) ? team.members : [];
      const captain = members.find(member => member.role === "captain") || {};
      const captainZone = team.captainPastoralZone || captain.pastoralZone || "未設定";
      const otherMembers = members.filter(member => member.role !== "captain");
      const teamStatus = team.status === "ready" ? "已成隊" : "招募中";
      const memberCount = Number(team.memberCount || members.length || 0);
      const row = [captainZone, team.name || "（無名稱）", teamStatus, `${memberCount}/${division} 人`, captain.name || "-"];
      for (let i = 0; i < Number(division) - 1; i++) {
        const member = otherMembers[i];
        row.push(member && member.name ? `${member.name}${member.pastoralZone ? `（${member.pastoralZone}）` : ""}` : "-");
      }
      lines.push(row.map(esc).join(","));
    });
  });

  return prependTaiwanExportTime(lines.join("\n"), exportedAt);
}

export function exportTeamRegistrationStatusCSV(division) {
  const plans = lastRenderedTeamPlans[Number(division)] || [];
  const hasAnyTeam = plans.some(item => Array.isArray(item.teams) && item.teams.length > 0);
  if (!hasAnyTeam) {
    if (typeof showToast === "function") showToast("目前沒有可供匯出的團隊報名資料。");
    return;
  }
  const csvContent = convertTeamRegistrationStatusToCSV(plans, division);
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const today = formatTaiwanDate();
  link.setAttribute("href", url);
  link.setAttribute("download", `team_registration_${division}person_${today}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
window.convertTeamRegistrationStatusToCSV = convertTeamRegistrationStatusToCSV;
window.exportTeamRegistrationStatusCSV = exportTeamRegistrationStatusCSV;
let cachedUnjoinedPlanKey = "";
let cachedUnjoinedPlanMembers = [];
let unjoinedPlanRequestId = 0;
let bulkPlanInviteInProgress = false;

function getSelectedManagementOrgFilter() {
  const role = (state.currentUser && getUserRoleCode(state.currentUser)) || "member";
  // "unassigned" is the sentinel shown when a leader has no org placement at
  // all (see setupCascadingSelectors in plan.js) — treat it as no selection.
  const readScope = id => {
    const value = document.getElementById(id)?.value || "";
    return value === "unassigned" ? "" : value;
  };
  const region = readScope("members-admin-region-select");
  const zone = readScope("members-admin-zone-select");
  const group = readScope("members-admin-group-select");
  if (group) return { type: "group", value: group };
  if (zone) return { type: "zone", value: zone };
  if (region) return { type: "region", value: region.replace(/^region:/, "") };
  if (role === "group_leader") return { type: "all_groups", value: "" };
  if (role === "zone_leader") return { type: "all_zones", value: "" };
  if (role === "great_zone_leader") return { type: "all_regions", value: "" };
  return { type: "all", value: "" };
}

function teamMatchesManagementOrgFilter(team, filter = getSelectedManagementOrgFilter()) {
  if (!filter || filter.type.startsWith("all")) return true;
  const members = Array.isArray(team && team.members) ? team.members : [];
  const field = filter.type === "region" ? "greatRegion" : filter.type === "zone" ? "pastoralZone" : "smallGroup";
  return members.some(member => String(member && (member[field] || member[
    field === "greatRegion" ? "great_region" : field === "pastoralZone" ? "pastoral_zone" : "small_group"
  ]) || "").split(",").map(value => value.trim()).filter(Boolean).includes(filter.value));
}

function memberMatchesManagementOrgFilter(member, filter = getSelectedManagementOrgFilter()) {
  if (!filter || filter.type.startsWith("all")) return true;
  const field = filter.type === "region" ? "greatRegion" : filter.type === "zone" ? "pastoralZone" : "smallGroup";
  const fallbackField = field === "greatRegion" ? "great_region" : field === "pastoralZone" ? "pastoral_zone" : "small_group";
  return String(member && (member[field] || member[fallbackField]) || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .includes(filter.value);
}

function setBulkPlanInviteButton(button, members, options = {}) {
  if (!button) return [];
  const eligibleMembers = (Array.isArray(members) ? members : [])
    .filter(member => !wasPlanInviteRemindedToday(member));
  const busy = options.busy === true;
  const total = Number(options.total ?? eligibleMembers.length);
  button.disabled = busy || eligibleMembers.length === 0;
  button.textContent = busy
    ? `發送中 ${Number(options.completed || 0)}/${total}`
    : (eligibleMembers.length > 0 ? `全部戳一下（${eligibleMembers.length}）` : "今天皆已提醒");
  return eligibleMembers;
}

async function renderAdminUnjoinedPlanMembers(forceRefresh = false) {
  const container = document.getElementById("admin-unjoined-plan-members");
  const count = document.getElementById("admin-unjoined-plan-count");
  const inviteAllButton = document.getElementById("admin-unjoined-plan-invite-all");
  if (!container || !count || !inviteAllButton) return;

  const currentUser = state.currentUser || {};
  const plan = state.activePlan;
  if (!MANAGEMENT_ROLES.includes(getUserRoleCode(currentUser)) || !plan) {
    count.textContent = "0 人";
    setBulkPlanInviteButton(inviteAllButton, []);
    container.innerHTML = '<div class="admin-unjoined-plan-empty">目前沒有可查看的資料。</div>';
    return;
  }

  const cacheKey = [
    currentUser.id || currentUser.name || "anonymous",
    getUserRoleCode(currentUser) || "member",
    currentUser.managed_regions || currentUser.great_region || "",
    currentUser.managed_zones || currentUser.pastoral_zone || "",
    plan.globalPlanId || plan.id || "",
    plan.presetKey || plan.preset_key || ""
  ].join("|");

  if (forceRefresh || cachedUnjoinedPlanKey !== cacheKey) {
    const requestId = ++unjoinedPlanRequestId;
    cachedUnjoinedPlanKey = cacheKey;
    cachedUnjoinedPlanMembers = [];
    count.textContent = "讀取中";
    inviteAllButton.disabled = true;
    inviteAllButton.textContent = "讀取中…";
    if (firstPaint(container)) container.innerHTML = '<div class="admin-unjoined-plan-empty">讀取尚未加入的人員中...</div>';

    const result = await db.getUnjoinedPlanMembers(plan);
    if (requestId !== unjoinedPlanRequestId) return;
    if (!result || !result.success) {
      console.warn("Unable to load unjoined plan members", result && (result.error || result.message));
      count.textContent = "0 人";
      setBulkPlanInviteButton(inviteAllButton, []);
      container.innerHTML = `
        <div class="admin-unjoined-plan-empty" role="status">
          <div>目前沒有可顯示的尚未加入人員。</div>
          <button type="button" class="secondary-btn" id="admin-unjoined-plan-retry" style="margin-top:0.75rem;">重新整理</button>
        </div>`;
      const retryButton = document.getElementById("admin-unjoined-plan-retry");
      if (retryButton) retryButton.onclick = () => renderAdminUnjoinedPlanMembers(true);
      return;
    }
    cachedUnjoinedPlanMembers = Array.isArray(result.context && result.context.members)
      ? result.context.members
      : [];
  }

  const visibleMembers = cachedUnjoinedPlanMembers.filter(member => memberMatchesManagementOrgFilter(member));
  count.textContent = `${visibleMembers.length} 人`;
  const eligibleMembers = setBulkPlanInviteButton(inviteAllButton, visibleMembers);
  if (visibleMembers.length === 0) {
    container.innerHTML = '<div class="admin-unjoined-plan-empty">目前篩選範圍內沒有尚未加入所選計畫的人員。</div>';
    return;
  }

  container.innerHTML = visibleMembers.map(member => {
    const memberId = escapeHTML(String(member.id || ""));
    const memberName = escapeHTML(member.name || "未命名使用者");
    const scope = [
      member.greatRegion || member.great_region,
      member.pastoralZone || member.pastoral_zone,
      member.smallGroup || member.small_group
    ].filter(Boolean).map(value => escapeHTML(String(value))).join("・") || "尚未設定牧養資料";
    const reminded = wasPlanInviteRemindedToday(member);
    return `
      <div class="admin-unjoined-plan-member">
        <div class="admin-unjoined-plan-member__identity">
          <div class="admin-unjoined-plan-member__name">${memberName}</div>
          <div class="admin-unjoined-plan-member__scope">${scope}</div>
        </div>
        <button type="button" class="secondary-btn admin-plan-invite-btn icon-button" data-plan-invite-member-id="${memberId}" ${reminded ? "disabled" : ""} title="${reminded ? "今天已提醒" : "戳一下提醒"}" aria-label="${reminded ? "今天已提醒" : "戳一下"}">
          ${reminded ? "今天已提醒" : '<span class="nlc-icon nlc-icon--sm" data-icon="poke" aria-hidden="true"></span>'}
        </button>
      </div>`;
  }).join("");
  if (typeof hydrateIcons === "function") hydrateIcons(container);

  inviteAllButton.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (bulkPlanInviteInProgress || eligibleMembers.length === 0) return;
    const planAtStart = state.activePlan;
    const confirmed = window.confirm(
      `確定要提醒目前篩選範圍內的 ${eligibleMembers.length} 人加入「${planAtStart?.name || "所選計畫"}」嗎？`
    );
    if (!confirmed) return;

    bulkPlanInviteInProgress = true;
    container.querySelectorAll("[data-plan-invite-member-id]").forEach(button => { button.disabled = true; });
    let bulkResult = null;
    try {
      bulkResult = await sendBulkPlanInvitations({
        members: eligibleMembers,
        plan: planAtStart,
        sendInvitation: (targetPlan, memberId) => db.sendPlanJoinInvitation(targetPlan, memberId),
        onProgress: progress => setBulkPlanInviteButton(inviteAllButton, eligibleMembers, {
          busy: true,
          completed: progress.completed,
          total: progress.total
        })
      });
    } finally {
      bulkPlanInviteInProgress = false;
    }

    const {
      sentCount = 0,
      duplicateCount = 0,
      failedMembers = []
    } = bulkResult || {};
    await renderAdminUnjoinedPlanMembers(false);
    const summary = [
      `成功 ${sentCount} 人`,
      duplicateCount > 0 ? `今天已提醒 ${duplicateCount} 人` : "",
      failedMembers.length > 0 ? `失敗 ${failedMembers.length} 人` : ""
    ].filter(Boolean).join("、");
    if (typeof showToast === "function") showToast(`批次提醒完成：${summary}`);
    if (failedMembers.length > 0) {
      console.warn("Bulk plan invitation failures", { planId: planAtStart?.id, members: failedMembers });
    }
  };

  container.querySelectorAll("[data-plan-invite-member-id]").forEach(button => {
    button.onclick = async () => {
      if (button.disabled) return;
      const memberId = button.dataset.planInviteMemberId;
      const member = cachedUnjoinedPlanMembers.find(item => String(item.id) === String(memberId));
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "提醒中...";
      const result = await db.sendPlanJoinInvitation(state.activePlan, memberId);
      if (!result || !result.success) {
        button.disabled = false;
        button.textContent = originalText;
        if (typeof showToast === "function") showToast(result && result.message ? result.message : "提醒傳送失敗，請稍後再試。");
        return;
      }
      if (member) member.remindedToday = true;
      button.textContent = "今天已提醒";
      if (typeof showToast === "function") showToast(`已提醒 ${member && member.name || "這位夥伴"} 加入「${state.activePlan && state.activePlan.name || "所選計畫"}」`);
    };
  });
}
let cachedJoinedPlanKey = "";
let cachedJoinedPlanMembers = [];
let joinedPlanRequestId = 0;

function formatAdminJoinedPlanDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
}

async function renderAdminJoinedPlanMembers(forceRefresh = false) {
  const container = document.getElementById("admin-joined-plan-members");
  const count = document.getElementById("admin-joined-plan-count");
  if (!container || !count) return;

  const currentUser = state.currentUser || {};
  const plan = state.activePlan;
  if (!MANAGEMENT_ROLES.includes(getUserRoleCode(currentUser)) || !plan) {
    count.textContent = "0 人";
    container.innerHTML = '<div class="admin-unjoined-plan-empty">目前沒有可查看的資料。</div>';
    return;
  }

  const cacheKey = [
    currentUser.id || currentUser.name || "anonymous",
    getUserRoleCode(currentUser) || "member",
    currentUser.managed_regions || currentUser.great_region || "",
    currentUser.managed_zones || currentUser.pastoral_zone || "",
    plan.globalPlanId || plan.id || "",
    plan.presetKey || plan.preset_key || ""
  ].join("|");

  if (forceRefresh || cachedJoinedPlanKey !== cacheKey) {
    const requestId = ++joinedPlanRequestId;
    cachedJoinedPlanKey = cacheKey;
    cachedJoinedPlanMembers = [];
    count.textContent = "讀取中";
    if (firstPaint(container)) container.innerHTML = '<div class="admin-unjoined-plan-empty">讀取已加入計畫的人員中...</div>';

    const result = await db.getJoinedPlanMembers(plan);
    if (requestId !== joinedPlanRequestId) return;
    if (!result || !result.success) {
      console.warn("Unable to load joined plan members", result && (result.error || result.message));
      count.textContent = "0 人";
      container.innerHTML = `
        <div class="admin-unjoined-plan-empty" role="status">
          <div>目前沒有可顯示的已加入人員。</div>
          <button type="button" class="secondary-btn" id="admin-joined-plan-retry" style="margin-top:0.75rem;">重新整理</button>
        </div>`;
      const retryButton = document.getElementById("admin-joined-plan-retry");
      if (retryButton) retryButton.onclick = () => renderAdminJoinedPlanMembers(true);
      return;
    }
    cachedJoinedPlanMembers = Array.isArray(result.context && result.context.members)
      ? result.context.members
      : [];
  }

  const visibleMembers = cachedJoinedPlanMembers.filter(member => memberMatchesManagementOrgFilter(member));
  count.textContent = `${visibleMembers.length} 人`;
  if (visibleMembers.length === 0) {
    container.innerHTML = '<div class="admin-unjoined-plan-empty">目前篩選範圍內沒有已加入所選計畫的人員。</div>';
    return;
  }

  container.innerHTML = visibleMembers.map(member => {
    const memberName = escapeHTML(member.name || "未命名使用者");
    const scope = [
      member.greatRegion || member.great_region,
      member.pastoralZone || member.pastoral_zone,
      member.smallGroup || member.small_group
    ].filter(Boolean).map(value => escapeHTML(String(value))).join("・") || "尚未設定牧養資料";
    const joinedDate = formatAdminJoinedPlanDate(member.joinedAt);
    const round = Number(member.currentRound) || 1;
    return `
      <div class="admin-unjoined-plan-member">
        <div class="admin-unjoined-plan-member__identity">
          <div class="admin-unjoined-plan-member__name">${memberName}</div>
          <div class="admin-unjoined-plan-member__scope">${scope}</div>
        </div>
        <div class="admin-joined-plan-member__meta">
          ${joinedDate ? `<span>${escapeHTML(joinedDate)} 加入</span>` : ""}
          ${round > 1 ? `<span>第 ${round} 遍</span>` : ""}
        </div>
      </div>`;
  }).join("");
}

async function refreshAdminTeamRegistrationFilters() {
  // Re-render only what the user can currently see. Other subtabs render
  // from their cached raw data when opened, so org-filter changes no longer
  // trigger hidden network/DOM work.
  await loadActiveAdminPlanSubtab(false);
}

export async function renderAdminTeamRegistrationStatus(forceRefresh = false, division = 3, contentId = division === 6 ? "admin-team-status-content-6" : "admin-team-status-content") {
  const contentEl = document.getElementById(contentId);
  if (!contentEl) return;

  const currentUser = state.currentUser || {};
  const role = getUserRoleCode(currentUser);
  if (!MANAGEMENT_ROLES.includes(role)) return;

  const scopeCacheKey = [
    currentUser.id || currentUser.name || "anonymous",
    role,
    currentUser.managed_regions || currentUser.great_region || "",
    currentUser.managed_zones || currentUser.pastoral_zone || "",
    currentUser.managed_groups || currentUser.small_group || ""
  ].join("|");
  if (cachedTeamsDataKey !== scopeCacheKey) {
    cachedTeamsData = null;
    cachedTeamsDataKey = scopeCacheKey;
  }

  if (!cachedTeamsData || forceRefresh) {
    contentEl.innerHTML = `
      <div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.875rem;">
        讀取團隊報名資料中...
      </div>
    `;

    const result = await db.getReadingTeamRegistrationOverview();
    if (!result || !result.success) {
      const message = escapeHTML(result && result.message ? result.message : "團隊報名資料讀取失敗，請稍後再試。");
      contentEl.innerHTML = `
        <div class="admin-team-status-empty" role="status" style="padding:2rem; display:flex; flex-direction:column; align-items:center; gap:0.75rem; text-align:center; color:var(--text-secondary);">
          <strong>目前無法載入團隊報名資料</strong>
          <span>${message}</span>
          <button type="button" class="secondary-btn" id="admin-team-status-retry">重新整理</button>
        </div>
      `;
      const retryButton = document.getElementById("admin-team-status-retry");
      if (retryButton) retryButton.onclick = () => renderAdminTeamRegistrationStatus(true, division, contentId);
      return;
    }
    cachedTeamsData = result.context || { summary: {}, plans: [] };
  }

  let overviewPlans = Array.isArray(cachedTeamsData.plans) ? cachedTeamsData.plans : [];
  const selectedPlan = state.activePlan;
  if (selectedPlan) {
    const selectedKeys = [selectedPlan.globalPlanId, selectedPlan.id, selectedPlan.presetKey, selectedPlan.name]
      .filter(Boolean).map(String);
    overviewPlans = overviewPlans.filter(item => selectedKeys.includes(String(item.id)) || selectedKeys.includes(String(item.name)));
  }
  const processedPlans = overviewPlans.map(item => {
    const allTeams = Array.isArray(item.teams) ? item.teams : [];
    const activeOrgFilter = getSelectedManagementOrgFilter();
    const teams = allTeams.filter(team => Number(team.division) === Number(division))
      .filter(team => teamMatchesManagementOrgFilter(team, activeOrgFilter));
    return {
      ...item,
      plan: item,
      teams
    };
  });

  lastRenderedTeamPlans[Number(division)] = processedPlans;
  const exportBtn = document.getElementById(Number(division) === 6 ? "admin-team-status-export-btn-6" : "admin-team-status-export-btn");
  if (exportBtn) exportBtn.onclick = () => exportTeamRegistrationStatusCSV(division);

  if (processedPlans.length === 0) {
    contentEl.innerHTML = `
      <div style="padding: 2rem; text-align: center; color: var(--text-muted); font-size: 0.875rem;">
        目前尚無任何計畫的團隊報名資料。
      </div>
    `;
    return;
  }

  let html = "";
  processedPlans.forEach(item => {
    const planName = escapeHTML(item.plan.name || "（無名稱）");
    const planStart = formatTeamPlanDate(item.plan.startDate);
    const planEnd = formatTeamPlanDate(item.plan.endDate);
    const planPeriod = planStart && planEnd ? `${planStart}－${planEnd}` : "";
    const signupCount = item.teams.filter(team => team.status === "forming").length;
    const readyCount = item.teams.filter(t => t.status === "ready").length;
    const totalMembers = item.teams.reduce((acc, t) => acc + (t.memberCount || 0), 0);

    html += `
      <div class="team-plan-section" style="margin-bottom: 2rem;">
        <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 0.4rem;">
          <span class="nlc-icon nlc-icon--sm" data-icon="layers" aria-hidden="true" style="color: var(--primary-color);"></span>
          計畫：${planName}
        </h4>
        ${planPeriod ? `<p style="margin: 0 0 0.65rem; color: var(--text-muted); font-size: 0.875rem;">計畫期間：${planPeriod}</p>` : ""}
        <div style="display: flex; gap: 1rem; font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
          <span>招募中：<strong style="color: var(--primary-color);">${signupCount}</strong> 隊</span>
          <span>已成隊：<strong style="color: var(--color-success-foreground);">${readyCount}</strong> 隊</span>
          <span>總報名人數：<strong>${totalMembers}</strong> 人</span>
        </div>
    `;

    if (item.teams.length === 0) {
      html += `
        <div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.875rem; background: var(--bg-input); border-radius: 8px; border: 1px dashed var(--border-card);">
          此計畫目前無 ${division} 人團隊的報名資料。
        </div>
      </div>
      `;
    } else {
      html += `
        <div class="admin-team-table-scroll" style="overflow: auto; max-height: min(60vh, 32rem); background: var(--bg-input); border-radius: 8px; border: 1px solid var(--border-card);">
          <table class="w-full" style="border-collapse: collapse; text-align: left; font-size: 0.875rem; min-width: 600px;">
            <thead style="position: sticky; top: 0; z-index: 2; background: var(--bg-input);">
              <tr style="border-bottom: 1px solid var(--border-card); background: rgba(255,255,255,0.02);">
                ${Number(division) === 3 ? `
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊長所屬牧區</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊名</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊長</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊員2</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊員3</th>
                ` : `
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊長所屬牧區</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊名</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊長</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊員2</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊員3</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊員4</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊員5</th>
                  <th style="padding: 0.6rem 0.8rem; font-weight: 600; color: var(--text-secondary);">隊員6</th>
                `}
              </tr>
            </thead>
            <tbody>
      `;

      item.teams.forEach(team => {
        const members = Array.isArray(team.members) ? team.members : [];
        const captain = members.find(member => member.role === "captain") || {};
        const captainZone = escapeHTML(team.captainPastoralZone || captain.pastoralZone || "未設定");
        const otherMembers = members.filter(member => member.role !== "captain");
        const teamName = escapeHTML(team.name || "（無名稱）");
        const captainName = captain.name ? escapeHTML(captain.name) : "-";
        const teamStatus = team.status === "ready" ? "已成隊" : "招募中";
        const memberCount = Number(team.memberCount || members.length || 0);

        let membersCells = "";
        for (let i = 0; i < Number(division) - 1; i++) {
          const m = otherMembers[i];
          const memberName = m && m.name ? escapeHTML(m.name) : "-";
          const memberZone = m && m.pastoralZone ? `<small style="display:block; margin-top:0.2rem; color:var(--text-muted);">${escapeHTML(m.pastoralZone)}</small>` : "";
          membersCells += `<td style="padding: 0.75rem 0.8rem; color: var(--text-secondary);">${memberName}${memberZone}</td>`;
        }

        html += `
          <tr style="border-bottom: 1px solid var(--border-card); transition: background-color 0.2s;">
            <td style="padding: 0.75rem 0.8rem; font-weight: 500; color: var(--text-primary);">${captainZone}</td>
            <td style="padding: 0.75rem 0.8rem; font-weight: 500; color: var(--text-primary);">
              ${teamName}
              <small style="display:block; margin-top:0.2rem; color:var(--text-muted); font-weight:400;">${teamStatus} · ${memberCount}/${division} 人</small>
            </td>
            <td style="padding: 0.75rem 0.8rem; color: var(--text-primary);">${captainName}</td>
            ${membersCells}
          </tr>
        `;
      });

      html += `
            </tbody>
          </table>
        </div>
      </div>
      `;
    }
  });

  contentEl.innerHTML = html;

  if (typeof hydrateIcons === "function") {
    hydrateIcons(contentEl);
  }
}

export function initAdminTeamRegistration() {
  const tab3 = document.getElementById("admin-team-tab-3");
  const tab6 = document.getElementById("admin-team-tab-6");

  if (tab3 && tab6) {
    tab3.onclick = (e) => {
      e.preventDefault();
      if (activeTeamDivision === 3) return;
      activeTeamDivision = 3;
      tab3.classList.add("active");
      tab6.classList.remove("active");
      renderAdminTeamRegistrationStatus();
    };

    tab6.onclick = (e) => {
      e.preventDefault();
      if (activeTeamDivision === 6) return;
      activeTeamDivision = 6;
      tab6.classList.add("active");
      tab3.classList.remove("active");
      renderAdminTeamRegistrationStatus();
    };
  }
}

let adminTeamPlacementsData = [];
let adminTeamPlacementsDataKey = "";

export async function renderAdminTeamPlacementLookup(selectedPlan, forceRefresh = false) {
  const contentEl = document.getElementById("admin-team-placements-content");
  const searchInput = document.getElementById("admin-team-placement-search");
  if (!contentEl) return;

  if (searchInput && !searchInput.dataset.placementBound) {
    searchInput.dataset.placementBound = "true";
    searchInput.addEventListener("input", () => {
      renderAdminTeamPlacementList();
    });
  }

  const currentUser = state.currentUser || {};
  const dataKey = [
    currentUser.id || currentUser.name || 'anonymous',
    currentUser.managed_regions || currentUser.great_region || '',
    currentUser.managed_zones || currentUser.pastoral_zone || '',
    currentUser.managed_groups || currentUser.small_group || '',
    selectedPlan && (selectedPlan.globalPlanId || selectedPlan.id || selectedPlan.presetKey || selectedPlan.name) || ''
  ].join('|');
  if (!forceRefresh && adminTeamPlacementsDataKey === dataKey) {
    renderAdminTeamPlacementList();
    return;
  }

  if (firstPaint(contentEl)) contentEl.innerHTML = '<div class="admin-user-directory__empty">正在載入尚未加入團隊的人員…</div>';

  const res = await db.getAdminMemberTeamPlacements(selectedPlan);
  if (!res.success) {
    contentEl.innerHTML = '<div class="admin-user-directory__empty">無法取得成員組隊狀態。</div>';
    return;
  }

  adminTeamPlacementsData = res.data || [];
  adminTeamPlacementsDataKey = dataKey;
  renderAdminTeamPlacementList();
}

function renderAdminTeamPlacementList() {
  const contentEl = document.getElementById("admin-team-placements-content");
  const searchInput = document.getElementById("admin-team-placement-search");
  if (!contentEl) return;

  const query = (searchInput?.value || "").trim().toLocaleLowerCase("zh-Hant");
  const unjoinedMembers = adminTeamPlacementsData.filter(item => item.isJoined !== true);

  const filtered = unjoinedMembers
    .filter(item => memberMatchesManagementOrgFilter(item))
    .filter(item => {
      if (!query) return true;
      const text = [item.name, item.email, item.pastoralZone, item.smallGroup]
        .filter(Boolean).join(" ").toLocaleLowerCase("zh-Hant");
      return text.includes(query);
    });

  if (filtered.length === 0) {
    contentEl.innerHTML = '<div class="admin-user-directory__empty">目前篩選範圍內沒有尚未加入團隊的人員。</div>';
    return;
  }

  const html = `
    <div style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
      共顯示 ${filtered.length} / ${unjoinedMembers.length} 位尚未加入團隊的人員
    </div>
    <div style="display: flex; flex-direction: column; gap: 0.5rem;">
      ${filtered.map(item => {
        const name = escapeHTML(item.name || "未命名");
        const zone = escapeHTML([item.pastoralZone, item.smallGroup].filter(Boolean).join("・") || "未設定歸屬");
        return `
          <div style="background: var(--bg-input); border: 1px solid var(--border-card); border-radius: 10px; padding: 0.75rem 1rem;">
            <strong>${name}</strong>
            <span style="font-size: 0.875rem; font-weight: normal; color: var(--text-secondary);">(${zone})</span>
          </div>
        `;
      }).join("")}
    </div>
  `;

  contentEl.innerHTML = html;
  if (typeof hydrateIcons === "function") hydrateIcons(contentEl);
}

window.renderAdminUnjoinedPlanMembers = renderAdminUnjoinedPlanMembers;
window.renderAdminJoinedPlanMembers = renderAdminJoinedPlanMembers;
window.renderAdminTeamPlacementLookup = renderAdminTeamPlacementLookup;
window.renderAdminTeamRegistrationStatus = renderAdminTeamRegistrationStatus;
window.refreshAdminTeamRegistrationFilters = refreshAdminTeamRegistrationFilters;
window.initAdminTeamRegistration = initAdminTeamRegistration;
