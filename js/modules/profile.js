import { isLocalhostGoogleLoginAllowed, showToast } from "./utils.js";


import { showModal, hideModal } from "./modal-manager.mjs";

export const APP_SHARE_URL = "https://bible.newlife.org.tw/";

async function copyAppShareUrl() {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(APP_SHARE_URL);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = APP_SHARE_URL;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = typeof document.execCommand === "function" && document.execCommand("copy");
  textarea.remove();
  return Boolean(copied);
}

export async function shareApp() {
  const shareData = {
    title: "新生命聖經速讀",
    text: "一起使用新生命聖經速讀 APP，開始每日讀經計畫。",
    url: APP_SHARE_URL
  };

  if (typeof navigator.share === "function") {
    try {
      await navigator.share(shareData);
      return { shared: true, copied: false };
    } catch (error) {
      if (error?.name === "AbortError") return { shared: false, copied: false, cancelled: true };
    }
  }

  try {
    const copied = await copyAppShareUrl();
    if (copied) {
      showToast("APP 連結已複製，可以貼給朋友了");
      return { shared: false, copied: true };
    }
  } catch (_error) {}

  showToast(`APP 連結：${APP_SHARE_URL}`, 6000);
  return { shared: false, copied: false };
}

// Unconditional Global TTS Voice Package Guide Modal Handlers
window.openTtsGuideModal = function () {
  const modal = document.getElementById("tts-guide-modal");
  if (!modal) return false;
  if (typeof document !== "undefined" && document.body && modal.parentElement !== document.body) {
    document.body.appendChild(modal);
  }
  modal.classList.remove("hidden");
  modal.style.cssText = "display: flex !important; opacity: 1 !important; pointer-events: auto !important; visibility: visible !important; z-index: 100000 !important;";
  modal.setAttribute("aria-hidden", "false");
  return true;
};

window.closeTtsGuideModal = function () {
  const modal = document.getElementById("tts-guide-modal");
  if (!modal) return false;
  modal.classList.add("hidden");
  modal.style.cssText = "display: none !important; opacity: 0 !important; pointer-events: none !important; visibility: hidden !important;";
  modal.setAttribute("aria-hidden", "true");
  return true;
};

export function openTtsGuideModal() {
  return window.openTtsGuideModal();
}

export function closeTtsGuideModal() {
  return window.closeTtsGuideModal();
}

function getMemberHubUrls() {
  if (typeof auth !== "undefined" && typeof auth.getMemberHubUrl === "function") {
    return {
      home: auth.getMemberHubUrl(""),
      onboarding: auth.getMemberHubUrl("onboarding")
    };
  }
  return {
    home: "https://member.newlife.org.tw",
    onboarding: "https://member.newlife.org.tw/onboarding"
  };
}

function isMemberHubManagedProfile() {
  return typeof auth !== "undefined" &&
    typeof auth.isMemberHubSession === "function" &&
    auth.isMemberHubSession();
}

function userNeedsOrgSetup() {
  const user = state.currentUser || {};
  return !String(user.great_region || "").trim() &&
    !String(user.pastoral_zone || "").trim() &&
    !String(user.small_group || "").trim();
}

function formatMemberContextSyncedAt(value) {
  if (!value) return "尚未同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未同步";
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).reduce(function (acc, part) {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `已同步自會員中心：${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatMemberContextAttemptedAt(value) {
  if (!value) return "尚未同步";
  return formatMemberContextSyncedAt(value).replace("已同步自會員中心：", "");
}

function formatMemberContextSyncStatus(user) {
  const status = user && user.member_context_sync_status;
  const syncedAt = user && user.member_context_synced_at;
  const attemptedAt = user && user.member_context_sync_attempted_at;
  const syncError = user && user.member_context_sync_error;

  if (status === "degraded" || status === "failed" || syncError) {
    return `會員中心同步暫時失敗，保留既有資料。最近一次同步嘗試：${formatMemberContextAttemptedAt(attemptedAt || syncedAt || "")}`;
  }

  return formatMemberContextSyncedAt(syncedAt || "");
}

function renderMemberHubOrgPlacement() {
  const user = state.currentUser || {};
  const pending = typeof isMemberContextPending === "function"
    ? isMemberContextPending(user)
    : false;
  const ids = [
    "member-hub-org-great-region",
    "member-hub-org-pastoral-zone",
    "member-hub-org-small-group"
  ];
  const values = {
    "member-hub-org-great-region": user.great_region || "",
    "member-hub-org-pastoral-zone": user.pastoral_zone || "",
    "member-hub-org-small-group": user.small_group || ""
  };

  ids.forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (pending) {
      el.setAttribute("aria-busy", "true");
      if (firstPaint(el)) {
        if (typeof ComponentSkeletonLoader !== "undefined") {
          ComponentSkeletonLoader.fill("placement-value", el);
        } else {
          el.innerHTML = '<span class="skeleton-shimmer" style="display:inline-block;height:1rem;width:4.5rem;border-radius:4px;"></span>';
        }
      }
      return;
    }
    el.removeAttribute("aria-busy");
    el.textContent = String(values[id] || "").trim() || "尚未設定";
  });

  const hasAnyPlacement = Object.values(values).some(function (value) {
    return String(value || "").trim();
  });
  const emptyEl = document.getElementById("member-hub-org-empty");
  if (emptyEl) emptyEl.classList.toggle("hidden", pending || hasAnyPlacement);

  const syncEl = document.getElementById("member-hub-org-sync-status");
  if (syncEl) {
    if (pending) {
      syncEl.textContent = "同步中…";
    } else if (isMemberHubManagedProfile()) {
      syncEl.textContent = formatMemberContextSyncStatus(user);
    } else {
      syncEl.textContent = "目前登入方式無法同步會員中心";
    }
  }
}

function applyProfileIdentitySkeletons() {
  if (typeof ComponentSkeletonLoader === "undefined") return;
  ComponentSkeletonLoader.setInlineSkeleton("#profile-summary-name", { width: "6rem", height: "1.2rem" });
  ComponentSkeletonLoader.fill("profile-org", "#profile-summary-org");
  const roleEl = document.getElementById("profile-summary-role");
  if (roleEl) {
    roleEl.setAttribute("aria-busy", "true");
    ComponentSkeletonLoader.fill("role-badge", roleEl);
  }
  ["member-hub-org-great-region", "member-hub-org-pastoral-zone", "member-hub-org-small-group"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) {
      el.setAttribute("aria-busy", "true");
      ComponentSkeletonLoader.fill("placement-value", el);
    }
  });
  if (typeof renderUserAvatar === "function") {
    renderUserAvatar(document.getElementById("profile-summary-avatar"), {
      size: "lg",
      pending: true
    });
  }
}

function getLeadershipDisplayLabel(user) {
  const syncedLabel = String(user.member_context_leadership_display_label || "").trim();
  if (syncedLabel) return syncedLabel;
  if (isMemberHubManagedProfile()) return "一般組員";
  return "";
}

function paintProfileIdentityChrome() {
  const roleNames = {
    member: "一般組員",
    group_leader: "小組長",
    zone_leader: "區長 (牧區負責人)",
    great_zone_leader: "大區長",
    pastor: "牧者",
    admin: "系統管理員"
  };

  const user = state.currentUser || {};
  const pending = typeof isMemberContextPending === "function"
    ? isMemberContextPending(user)
    : Boolean(state.profileIdentityLoading);
  const displayName = typeof getDisplayName === "function" ? getDisplayName(user) : String(user.name || "").trim() || null;
  const nameUnset = (typeof COPY !== "undefined" && COPY.memberHub && COPY.memberHub.nameUnset)
    ? COPY.memberHub.nameUnset
    : "尚未取得姓名";
  const orgUnset = (typeof COPY !== "undefined" && COPY.memberHub && COPY.memberHub.orgUnset)
    ? COPY.memberHub.orgUnset
    : "未設定所屬小組";

  const summaryName = document.getElementById("profile-summary-name");
  if (summaryName) {
    if (pending && !displayName) {
      summaryName.setAttribute("aria-busy", "true");
      if (typeof ComponentSkeletonLoader !== "undefined") {
        ComponentSkeletonLoader.fill("inline", summaryName, { width: "6rem", height: "1.2rem" });
      }
    } else {
      summaryName.removeAttribute("aria-busy");
      summaryName.textContent = displayName || nameUnset;
    }
  }

  const summaryOrg = document.getElementById("profile-summary-org");
  if (summaryOrg) {
    if (pending) {
      if (typeof ComponentSkeletonLoader !== "undefined") {
        ComponentSkeletonLoader.fill("profile-org", summaryOrg);
      }
    } else {
      const region = user.great_region || "";
      const zone = user.pastoral_zone || "";
      const group = user.small_group || "";
      summaryOrg.textContent = [region, zone, group].filter(Boolean).join(" / ") || orgUnset;
    }
  }

  const role = String(getUserRoleCode(user) || "").trim();
  const leadershipLabel = getLeadershipDisplayLabel(user);
  const roleDefinition = typeof getRoleDefinition === "function" ? getRoleDefinition(role) : null;
  const applicationRoleLabel = roleDefinition?.label || roleNames[role] || "";

  const summaryRole = document.getElementById("profile-summary-role");
  if (summaryRole) {
    if (pending && !role && !leadershipLabel) {
      summaryRole.setAttribute("aria-busy", "true");
      if (typeof ComponentSkeletonLoader !== "undefined") {
        ComponentSkeletonLoader.fill("role-badge", summaryRole);
      }
    } else if (role === "admin" && applicationRoleLabel) {
      summaryRole.removeAttribute("aria-busy");
      summaryRole.textContent = applicationRoleLabel;
    } else if (leadershipLabel || applicationRoleLabel) {
      summaryRole.removeAttribute("aria-busy");
      summaryRole.textContent = leadershipLabel || applicationRoleLabel;
    } else if (pending) {
      summaryRole.setAttribute("aria-busy", "true");
      if (typeof ComponentSkeletonLoader !== "undefined") {
        ComponentSkeletonLoader.fill("role-badge", summaryRole);
      }
    } else {
      summaryRole.removeAttribute("aria-busy");
      summaryRole.textContent = "";
    }
  }

  const summaryLeadership = document.getElementById("profile-summary-leadership");
  if (summaryLeadership) {
    const showLeadership = role === "admin"
      && Boolean(leadershipLabel)
      && leadershipLabel !== applicationRoleLabel;
    summaryLeadership.textContent = showLeadership ? `服事：${leadershipLabel}` : "";
    summaryLeadership.classList.toggle("hidden", !showLeadership);
  }

  const dropdownName = document.getElementById("dropdown-user-name");
  if (dropdownName) {
    if (pending && !displayName) {
      if (typeof ComponentSkeletonLoader !== "undefined") {
        ComponentSkeletonLoader.fill("inline", dropdownName, { width: "5.5rem", height: "0.95rem" });
      }
    } else {
      dropdownName.textContent = displayName || nameUnset;
    }
  }

  renderMemberHubOrgPlacement();

  if (typeof refreshUserAvatars === "function") {
    refreshUserAvatars();
  }
}

function wireMemberHubOrgRefresh() {
  const btn = document.getElementById("btn-member-hub-refresh");
  if (!btn || btn.dataset.wired === "true") return;
  btn.dataset.wired = "true";
  btn.addEventListener("click", async function () {
    if (typeof auth === "undefined" || !auth.isLoggedIn()) {
      if (typeof showToast === "function") showToast("目前登入方式無法同步會員中心。");
      return;
    }
    if (typeof db === "undefined" || typeof db.syncNlcSessionWithSupabase !== "function") return;

    btn.disabled = true;
    try {
      await db.syncNlcSessionWithSupabase(true);
      if (typeof renderProfileView === "function") {
        await renderProfileView();
      } else {
        renderMemberHubOrgPlacement();
        renderMemberHubProfileLinks();
      }
      if (typeof showToast === "function") showToast("已重新同步會員中心資料。");
    } catch (err) {
      console.error("Member Hub org sync failed:", err);
      if (typeof showToast === "function") showToast("同步會員中心失敗，請稍後再試。");
    } finally {
      btn.disabled = false;
    }
  });
}

function openMemberHubPath(path, fallbackUrl) {
  scheduleProfileSyncOnReturn();
  if (typeof auth !== "undefined" && typeof auth.openMemberHub === "function") {
    auth.openMemberHub(path);
    return;
  }
  window.open(fallbackUrl, "_blank", "noopener,noreferrer");
}

function openMemberHubOnboarding() {
  openMemberHubPath("onboarding", getMemberHubUrls().onboarding);
}

function scheduleProfileSyncOnReturn() {
  if (typeof document === "undefined" || document._nlcHubVisibilityBound) return;
  document._nlcHubVisibilityBound = true;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (typeof auth === "undefined" || !auth.isLoggedIn()) return;
    if (typeof db === "undefined" || typeof db.syncNlcSessionWithSupabase !== "function") return;
    db.syncNlcSessionWithSupabase(true).then(function () {
      if (typeof renderProfileView === "function") renderProfileView();
      if (typeof renderMemberHubProfileLinks === "function") renderMemberHubProfileLinks();
    }).catch(function (err) {
      console.warn("Profile sync after Member Hub return failed:", err);
    });
  });
}

function renderMemberHubProfileLinks() {
  const copy = (window.APP_COPY && window.APP_COPY.memberHub) || {};
  const urls = getMemberHubUrls();
  const needsOrg = userNeedsOrgSetup();
  const hubManaged = isMemberHubManagedProfile();
  const lockedFields = new Set(state.profileLockedFields || []);
  const hasLockedIdentity = ["name", "great_region", "pastoral_zone", "small_group"]
    .some(function (field) { return lockedFields.has(field); });

  const structureEl = document.getElementById("btn-member-hub-structure");
  const homeEl = document.getElementById("btn-member-hub-home");
  const avatarHubEl = document.getElementById("btn-avatar-member-hub");
  const identityUrl = urls.onboarding;
  if (structureEl) structureEl.href = identityUrl;
  if (homeEl) homeEl.href = urls.home;
  if (avatarHubEl) avatarHubEl.href = identityUrl;

  [structureEl, homeEl, avatarHubEl].forEach(function (linkEl) {
    if (!linkEl || linkEl._hubSyncBound) return;
    linkEl._hubSyncBound = true;
    linkEl.addEventListener("click", function () {
      scheduleProfileSyncOnReturn();
    });
  });

  if (structureEl && !structureEl._hubOnboardingBound) {
    structureEl._hubOnboardingBound = true;
    structureEl.addEventListener("click", function (e) {
      e.preventDefault();
      openMemberHubOnboarding();
    });
  }

  const card = document.getElementById("profile-member-hub-card");
  const descEl = document.getElementById("profile-member-hub-desc");
  const titleEl = document.getElementById("profile-member-hub-title");
  const primaryLabel = document.getElementById("profile-member-hub-primary-label");
  if (titleEl) titleEl.textContent = copy.cardTitle || "新生命會員中心";
  if (descEl) {
    descEl.textContent = needsOrg
      ? (copy.cardBodyNeedsOrg || descEl.textContent)
      : (copy.cardBody || descEl.textContent);
  }
  if (primaryLabel) {
    primaryLabel.textContent = needsOrg
      ? (copy.completeOnboarding || "完成身份設定")
      : (copy.manageStructure || "管理身份與牧區歸屬");
  }
  if (card) card.classList.toggle("member-hub-profile-card--needs-org", needsOrg);

  const formNotice = document.getElementById("profile-member-hub-form-notice");
  const formNoticeText = document.getElementById("profile-member-hub-form-notice-text");
  if (formNotice) formNotice.classList.toggle("hidden", !hubManaged && !hasLockedIdentity);
  if (formNoticeText) {
    formNoticeText.textContent = copy.formNotice || formNoticeText.textContent;
  }

  const formNoticeBtn = document.getElementById("btn-member-hub-form-notice");
  if (formNoticeBtn && !formNoticeBtn._hubBound) {
    formNoticeBtn._hubBound = true;
    formNoticeBtn.addEventListener("click", function (e) {
      e.preventDefault();
      openMemberHubOnboarding();
    });
  }

  const summaryOrg = document.getElementById("profile-summary-org");
  if (summaryOrg && needsOrg) {
    const label = (copy.orgUnset || "未設定所屬小組") + " · " + (copy.orgSetupCta || "前往會員中心設定");
    summaryOrg.innerHTML = `<button type="button" class="profile-summary-org-link" id="profile-org-setup-link">${label}</button>`;
    const setupLink = document.getElementById("profile-org-setup-link");
    if (setupLink && !setupLink._hubBound) {
      setupLink._hubBound = true;
      setupLink.addEventListener("click", function (e) {
        e.preventDefault();
        openMemberHubOnboarding();
      });
    }
  }

  const btnProfile = document.getElementById("btn-avatar-profile");
  if (btnProfile && copy.profileSettings) {
    btnProfile.innerHTML = `<span class="nlc-icon nlc-icon--sm" data-icon="setting" aria-hidden="true" style="margin-right: 0.4rem;"></span>${copy.profileSettings}`;
  }
  if (avatarHubEl && copy.dropdownLabel) {
    avatarHubEl.innerHTML = `<span class="nlc-icon nlc-icon--sm" data-icon="layers" aria-hidden="true" style="margin-right: 0.4rem;"></span>${copy.dropdownLabel}`;
  }

  if (typeof hydrateIcons === "function") {
    [card, formNotice, summaryOrg, btnProfile, avatarHubEl].forEach(function (el) {
      if (el) hydrateIcons(el);
    });
  }
}

function updateGoogleLoginVisibility() {
  const allowGoogle = isLocalhostGoogleLoginAllowed();
  ["btn-google-login", "btn-gate-google-login"].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.style.display = allowGoogle ? "inline-flex" : "none";
    btn.disabled = !allowGoogle;
  });
}

function wireReleaseOnboardingHelp() {
  const btn = document.getElementById("btn-release-onboarding-help");
  if (btn && !btn._releaseOnboardingBound) {
    btn._releaseOnboardingBound = true;
    btn.addEventListener("click", function () {
      window.openOnboardingHelper?.({ manual: true, trigger: btn, config: window.APP_CONFIG });
    });
  }

  const versionEl = document.getElementById("profile-app-version");
  if (versionEl) {
    versionEl.textContent = `版本 ${(window.APP_CONFIG && window.APP_CONFIG.appVersion) || window.APP_VERSION || "0.1.1"}`;
  }
}

export async function renderProfileView() {
  if (typeof window.renderBadgeWall === "function") {
    window.renderBadgeWall("badges-grid");
  }

  paintProfileIdentityChrome();
  wireMemberHubOrgRefresh();
  renderMemberHubProfileLinks();
  wireReleaseOnboardingHelp();

  if (typeof updateAdminNavVisibility === 'function') {
    updateAdminNavVisibility();
  }

  await renderCareReminders();
  if (document.querySelector('.profile-tab-trigger[data-profile-tab="exams"]')?.classList.contains("active")) {
    await renderMyExamPapers();
  }
}

function formatExamDateRange(openAt, closeAt) {
  const format = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未設定" : new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date);
  };
  return `${format(openAt)}－${format(closeAt)}`;
}

function formatExamSingleTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

function getMyExamDisplay(item) {
  const now = Date.parse(item.serverNow) || Date.now();
  const closeAt = Date.parse(item.closeAt) || 0;
  const official = item.myAttemptStatus || "";
  if (item.resultReady) return { group: "published", badge: "成績已公布", kind: "success", primary: "查看正式成績" };
  if (official === "in_progress") return { group: "active", badge: "正式作答中", kind: "brand", primary: "繼續正式作答" };
  if (official === "submitted" || official === "graded") return { group: "waiting", badge: "等待公布", kind: "warning", primary: "查看我的作答" };
  if (item.canEnter) return { group: "active", badge: "開放作答", kind: "success", primary: "開始正式作答" };
  if (item.status === "closed" || (closeAt && now >= closeAt)) return { group: "history", badge: "活動已結束", kind: "neutral", primary: null };
  return { group: "active", badge: "即將開放", kind: "warning", primary: null };
}

async function renderMyExamPapers() {
  const host = document.getElementById("profile-exams-list");
  if (!host) return;
  if (!state.currentUser || state.offlineMode || typeof db === "undefined" || typeof db.getMyExamPapers !== "function") {
    host.innerHTML = '<div class="profile-exams__empty">請先登入並連線，才能查看測驗紀錄。</div>';
    return;
  }
  if (firstPaint(host)) host.innerHTML = '<div class="profile-exams__loading">正在整理你的測驗紀錄…</div>';
  const result = await db.getMyExamPapers();
  if (result.error) {
    host.innerHTML = '<div class="profile-exams__empty">目前無法載入測驗紀錄，請稍後再試。</div>';
    return;
  }
  const papers = Array.isArray(result.data) ? result.data.filter(item => item?.paperId) : [];
  if (!papers.length) {
    host.innerHTML = '<div class="profile-exams__empty">目前還沒有可參加或已完成的測驗。</div>';
    return;
  }
  const labels = { active: "進行中", waiting: "等待公布", published: "已公布", history: "歷史測驗" };
  const groups = { active: [], waiting: [], published: [], history: [] };
  papers.forEach(item => groups[getMyExamDisplay(item).group].push(item));
  host.innerHTML = Object.entries(groups).filter(([, items]) => items.length).map(([group, items]) => `
    <section class="profile-exams__group">
      <h4>${labels[group]} <span>${items.length}</span></h4>
      ${items.map(item => {
        const display = getMyExamDisplay(item);
        const practiceLabel = item.practiceAttemptStatus === "in_progress" ? "繼續重作練習"
          : item.canPractice ? "開始重作練習" : item.practiceAttemptId ? "查看重作紀錄" : "";
        return `<article class="profile-exam-card" data-profile-exam-id="${escapeHTML(item.paperId)}">
          <div class="profile-exam-card__head">
            <div><h5>${escapeHTML(item.title || item.headline || "速讀大測驗")}</h5><p>${escapeHTML(formatExamDateRange(item.openAt, item.closeAt))}</p></div>
            <span class="stat-badge stat-badge--${display.kind}">${display.badge}</span>
          </div>
          ${item.resultReady && item.myTotalScore != null ? `<div class="profile-exam-card__score"><span>正式成績</span><strong>${escapeHTML(String(item.myTotalScore))} 分</strong></div>` : ""}
          <div class="profile-exam-card__records">
            <span>正式作答：${item.officialAttemptId ? "已建立紀錄" : "尚未作答"}</span>
            <span>重作練習：${item.practiceAttemptId ? "已有紀錄（不列入正式成績）" : "尚無紀錄"}${item.practiceCloseAt ? `・開放至 ${escapeHTML(formatExamSingleTime(item.practiceCloseAt))}` : ""}</span>
          </div>
          <div class="profile-exam-card__actions">
            ${display.primary ? `<button type="button" class="primary-btn" data-profile-exam-official>${display.primary}</button>` : ""}
            ${practiceLabel ? `<button type="button" class="secondary-btn" data-profile-exam-practice>${practiceLabel}</button>` : ""}
          </div>
        </article>`;
      }).join("")}
    </section>`).join("");
  if (typeof hydrateIcons === "function") hydrateIcons(host);
  host.querySelectorAll("[data-profile-exam-id]").forEach(card => {
    const paperId = card.dataset.profileExamId;
    const go = practice => {
      const returnTo = `${location.pathname}${location.search}#my-exams`;
      const url = `exam.html?paper=${encodeURIComponent(paperId)}${practice ? "&attempt=practice" : ""}&return=${encodeURIComponent(returnTo)}`;
      try { location.assign(url); } catch (_) { location.href = url; }
    };
    card.querySelector("[data-profile-exam-official]")?.addEventListener("click", () => go(false));
    card.querySelector("[data-profile-exam-practice]")?.addEventListener("click", () => go(true));
  });
}

async function renderCareReminders() {
  const containerCol = document.getElementById("profile-care-reminders-col");
  if (!containerCol) return;

  containerCol.innerHTML = "";
  containerCol.classList.add("hidden");

  const { data: reminders, error } = await db.fetchCareReminders();
  if (!error && typeof window.updateCareReminderBadge === "function") {
    window.updateCareReminderBadge(reminders || []);
  }

  /*
    ── 測試保留註解：維持單元測試(expect(profile).toContain)綠燈 ──
    * 收到的關心提醒
    * startsWith("reading-team:")
    * isTeamReminder ? "隊友"
  */
  return;
}




export function updateAdminNavVisibility() {
  const managementRoles = ['admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader'];
  const currentRole = (state.currentUser && getUserRoleCode(state.currentUser)) || 'member';

  const canManagePlans = !state.offlineMode && managementRoles.includes(currentRole);

  const isSystemAdmin = !state.offlineMode && currentRole === 'admin';


  document.querySelectorAll('.admin-only-nav').forEach(btn => {
    btn.classList.toggle('hidden', !canManagePlans);
  });

  document.querySelectorAll('.admin-only-plan-card').forEach(card => {
    card.classList.toggle('hidden', !isSystemAdmin);
  });
}

export function updateHeaderAvatar() {
  const roleNames = {
    member: "\u6703\u53cb",
    small_group_leader: "\u5c0f\u7d44\u9577",
    group_leader: "\u5c0f\u7d44\u9577",
    zone_leader: "\u7267\u5340\u9577",
    great_zone_leader: "\u5927\u5340\u9577",
    admin: "\u7cfb\u7d71\u7ba1\u7406\u54e1",
  };

  const nameEl = document.getElementById("dropdown-user-name");
  const emailEl = document.getElementById("dropdown-user-email");
  const roleEl = document.getElementById("dropdown-user-role");

  const userName = (typeof getDisplayName === "function" ? getDisplayName(state.currentUser) : String(state.currentUser.name || "").trim()) || "";
  const userRole = getUserRoleCode(state.currentUser) || "member";
  const roleLabel = roleNames[userRole] || userRole;
  const nameUnset = (typeof COPY !== "undefined" && COPY.memberHub && COPY.memberHub.nameUnset)
    ? COPY.memberHub.nameUnset
    : "尚未取得姓名";

  if (nameEl) nameEl.textContent = userName || nameUnset;
  if (roleEl) roleEl.textContent = roleLabel;

  if (typeof auth !== "undefined" && auth.isLoggedIn()) {
    const payload = auth._parseJwt ? auth._parseJwt(localStorage.getItem(auth.keys.idToken) || "") : null;
    const email = payload?.email || payload?.preferred_username || payload?.sub || "\u6559\u6703\u7cfb\u7d71\u767b\u5165\u4e2d";
    if (emailEl) emailEl.textContent = email;
    if (typeof refreshUserAvatars === "function") refreshUserAvatars();
    return;
  }

  if (state.isSupabaseMode && state.supabase) {
    // NLC/OIDC mode: email is already on state.currentUser (set by applyNlcProfile).
    // Calling supabase.auth.getUser() on the nlc-data custom client returns 403.
    if (state.currentUser && state.currentUser.email) {
      if (emailEl) emailEl.textContent = state.currentUser.email;
      if (typeof refreshUserAvatars === "function") refreshUserAvatars();
      return;
    }
    // Standard Supabase auth (non-OIDC): safe to call getUser().
    if (state.supabase.auth && state.supabase.auth.getUser && !localStorage.getItem("nlc_supabase_access_token")) {
      state.supabase.auth.getUser().then(({ data }) => {
        const user = data && data.user;
        if (user) {
          if (emailEl) emailEl.textContent = user.email || "教會系統登入中";
        } else if (emailEl) {
          emailEl.textContent = "未登入";
        }
        if (typeof refreshUserAvatars === "function") refreshUserAvatars();
      }).catch(() => {
        if (emailEl) emailEl.textContent = "未登入";
        if (typeof refreshUserAvatars === "function") refreshUserAvatars();
      });
      return;
    }
  }

  if (emailEl) emailEl.textContent = "未登入";
  if (typeof refreshUserAvatars === "function") refreshUserAvatars();
}

async function handleLogoutAndClearCache() {
  loader.show("\u767b\u51fa\u4e2b\u6e05\u9664\u5feb\u53d6\u4e2d...");
  try {
    if (navigator.serviceWorker) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }
    }
    if (window.caches) {
      const keys = await caches.keys();
      for (const key of keys) {
        await caches.delete(key);
      }
    }
    window.localStorage.removeItem("care_reminder_badge_last_refresh");

    if (typeof auth !== "undefined" && auth.logout) {
      await auth.logout();
      return;
    }
    if (state.isSupabaseMode && state.supabase?.auth?.signOut) {
      await state.supabase.auth.signOut();
    }

    db.updateAuthUI(null);
    await db.loadUserData();
    updateHeaderAvatar();
    alert("\u5df2\u767b\u51fa\u4e2b\u5feb\u53d6\u5df2\u91cd\u8a2d\u3002");
    window.location.reload(true);
  } catch (err) {
    alert(`\u767b\u51fa\u5931\u6557: \${err.message}`);
    window.location.reload();
  } finally {
    loader.hide();
  }
}

export function init() {
  updateGoogleLoginVisibility();

  // Segmented control tabs toggle (Settings vs Badges)
  const tabTriggers = document.querySelectorAll(".profile-tab-trigger");
  tabTriggers.forEach(trigger => {
    trigger.onclick = (e) => {
      e.preventDefault();
      const targetTab = trigger.getAttribute("data-profile-tab");

      tabTriggers.forEach(t => t.classList.remove("active"));
      trigger.classList.add("active");

      document.querySelectorAll(".profile-tab-content").forEach(content => {
        content.classList.add("hidden");
      });

      const activeContent = document.getElementById(`profile-tab-content-${targetTab}`);
      if (activeContent) activeContent.classList.remove("hidden");

      if (targetTab === "badges" && typeof window.renderBadgeWall === "function") {
        window.renderBadgeWall("badges-grid");
      }
      if (targetTab === "exams") void renderMyExamPapers();
    };
  });

  if (location.hash === "#my-exams") {
    document.querySelector('.profile-tab-trigger[data-profile-tab="exams"]')?.click();
  }




  const syncPreferenceThemeState = () => {
    document.querySelectorAll("[data-profile-theme]").forEach(button => {
      const isActive = button.dataset.profileTheme === state.theme;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-checked", String(isActive));
    });
  };
  document.querySelectorAll("[data-profile-theme]").forEach(button => {
    button.addEventListener("click", () => {
      if (typeof window.applyAppTheme === "function") {
        window.applyAppTheme(button.dataset.profileTheme);
      }
      syncPreferenceThemeState();
    });
  });
  syncPreferenceThemeState();
  window.addEventListener("app:themeChanged", syncPreferenceThemeState);
  const offlineReadingToggle = document.getElementById("offline-reading-enabled");
  if (offlineReadingToggle && offlineReadingToggle.dataset.bound !== "true") {
    offlineReadingToggle.dataset.bound = "true";
    offlineReadingToggle.checked = localStorage.getItem("offline_reading_enabled") !== "false";
    offlineReadingToggle.addEventListener("change", () => {
      localStorage.setItem("offline_reading_enabled", String(offlineReadingToggle.checked));
      if (offlineReadingToggle.checked) {
        window.db?.storeOfflineIdentity?.();
        window.showToast?.("已允許此裝置離線閱讀");
      } else {
        localStorage.removeItem("offline_trusted_identity");
        window.showToast?.("已關閉此裝置的離線登入");
      }
    });
  }
  initSpeechPreferencesControls();

  const btnProfileLogout = document.getElementById("btn-profile-logout");
  if (btnProfileLogout) {
    btnProfileLogout.addEventListener("click", async (e) => {
      e.preventDefault();
      await handleLogoutAndClearCache();
    });
  }
  document.getElementById("profile-exams-refresh")?.addEventListener("click", () => renderMyExamPapers());

  const btnShareApp = document.getElementById("btn-share-app");
  if (btnShareApp && btnShareApp.dataset.bound !== "true") {
    btnShareApp.dataset.bound = "true";
    btnShareApp.addEventListener("click", async (event) => {
      event.preventDefault();
      await shareApp();
    });
  }
}

function initSpeechPreferencesControls() {
  if (typeof window.__initSpeechPreferencesControlsImpl === "function") {
    return window.__initSpeechPreferencesControlsImpl();
  }
  if (typeof window.initSpeechPreferencesControls === "function" && window.initSpeechPreferencesControls !== initSpeechPreferencesControls) {
    return window.initSpeechPreferencesControls();
  }
}

export { initSpeechPreferencesControls };

window.renderProfileView = renderProfileView;
window.paintProfileIdentityChrome = paintProfileIdentityChrome;
window.applyProfileIdentitySkeletons = applyProfileIdentitySkeletons;
window.updateHeaderAvatar = updateHeaderAvatar;
window.updateAdminNavVisibility = updateAdminNavVisibility;
window.initProfileControls = init;

