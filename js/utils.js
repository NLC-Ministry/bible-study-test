import { segmentScheduleDaysForRoundCount } from "./data/current-round-progress.mjs";
import {
  getUserOnboardingBlock
} from "./member-journey.mjs";

// ============================================================
// utils.js — Shared utilities used across all view controllers
// ============================================================
// iconLabel / renderIcon / hydrateIcons live in js/icons.js

// ── Toast Notification ──────────────────────────────────────
/**
 * Show a brief toast notification at the bottom of the screen.
 * @param {string} message - Text to display
 * @param {number} [duration=2500] - Duration in milliseconds
 */
function showToast(message, duration = 2500) {
  let toast = document.getElementById("app-auto-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-auto-toast";
    toast.style.cssText = `
      position: fixed;
      bottom: 85px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(30,30,46,0.95);
      color: #fff;
      padding: 0.7rem 1.4rem;
      border-radius: 24px;
      font-size: 0.88rem;
      font-weight: 500;
      box-shadow: ${(window.NLC_SHADOW && window.NLC_SHADOW.lg) || "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)"};
      z-index: 9999;
      opacity: 0;
      transition: opacity 0.3s ease, transform 0.3s ease;
      pointer-events: none;
      white-space: nowrap;
      max-width: 90vw;
      text-align: center;
    `;
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.opacity = "1";
  toast.style.transform = "translateX(-50%) translateY(0)";

  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-50%) translateY(20px)";
  }, duration);
}

// ── App-style Confirmation Dialog ──────────────────────────
/**
 * Show a premium app-like custom confirmation dialog.
 * @param {object} options - Options object
 * @param {string} options.title - Dialog title
 * @param {string} options.message - Dialog body message
 * @param {string} [options.confirmText="確認"] - Confirm button text
 * @param {string} [options.cancelText="取消"] - Cancel button text
 * @param {boolean} [options.isDestructive=false] - Whether it is a destructive action
 * @returns {Promise<boolean>} Resolves to true if confirmed, false if cancelled
 */
function showConfirmDialog({ title, message, confirmText = "確認", cancelText = "取消", isDestructive = false } = {}) {
  return new Promise((resolve) => {
    let overlay = document.getElementById("app-custom-confirm-overlay");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "app-custom-confirm-overlay";
    overlay.className = "custom-confirm-overlay";
    overlay.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:var(--z-critical,900);padding:20px;opacity:0;transition:opacity 0.2s ease;";

    const safeEscape = (str) => typeof escapeHTML === "function" ? escapeHTML(str) : String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

    overlay.innerHTML = `
      <div class="custom-confirm-card" role="dialog" aria-modal="true">
        <div class="custom-confirm-content">
          <h3 class="custom-confirm-title">${safeEscape(title)}</h3>
          <p class="custom-confirm-desc">${safeEscape(message)}</p>
        </div>
        <div class="custom-confirm-actions">
          <button type="button" class="custom-confirm-btn-cancel secondary-btn">${safeEscape(cancelText)}</button>
          <button type="button" class="custom-confirm-btn-confirm ${isDestructive ? 'danger-btn' : 'primary-btn'}">${safeEscape(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Force style recalculation for animations
    overlay.offsetWidth;

    overlay.style.opacity = "1";
    overlay.classList.add("active");

    const cleanup = (value) => {
      overlay.style.opacity = "0";
      overlay.classList.remove("active");
      setTimeout(() => {
        overlay.remove();
        resolve(value);
      }, 200);
    };

    overlay.querySelector(".custom-confirm-btn-cancel").onclick = () => cleanup(false);
    overlay.querySelector(".custom-confirm-btn-confirm").onclick = () => cleanup(true);

    overlay.onclick = (e) => {
      if (e.target === overlay) cleanup(false);
    };

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        cleanup(false);
        document.removeEventListener("keydown", handleKeyDown);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
  });
}
window.showConfirmDialog = showConfirmDialog;

function showPromptDialog({ title, message = "", defaultValue = "", placeholder = "請輸入...", confirmText = "確認", cancelText = "取消" } = {}) {
  return new Promise((resolve) => {
    let overlay = document.getElementById("app-custom-prompt-overlay");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "app-custom-prompt-overlay";
    overlay.className = "custom-confirm-overlay";
    overlay.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:var(--z-critical,900);padding:20px;opacity:0;transition:opacity 0.2s ease;";

    const safeEscape = (str) => typeof escapeHTML === "function" ? escapeHTML(str) : String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

    overlay.innerHTML = `
      <div class="custom-confirm-card" role="dialog" aria-modal="true">
        <div class="custom-confirm-content">
          <h3 class="custom-confirm-title">${safeEscape(title)}</h3>
          ${message ? `<p class="custom-confirm-desc">${safeEscape(message)}</p>` : ""}
          <div style="margin-top: 0.75rem;">
            <input type="text" class="custom-prompt-input" value="${safeEscape(defaultValue)}" placeholder="${safeEscape(placeholder)}"
              style="width:100%;padding:0.5rem 0.75rem;border:1px solid var(--border-card);border-radius:8px;background:var(--bg-input);color:var(--text-primary);font-size:1rem;" />
          </div>
        </div>
        <div class="custom-confirm-actions" style="margin-top: 1.25rem;">
          <button type="button" class="custom-confirm-btn-cancel secondary-btn">${safeEscape(cancelText)}</button>
          <button type="button" class="custom-confirm-btn-confirm primary-btn">${safeEscape(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.offsetWidth;
    overlay.style.opacity = "1";
    overlay.classList.add("active");

    const input = overlay.querySelector(".custom-prompt-input");
    if (input) {
      input.focus();
      input.select();
    }

    const cleanup = (value) => {
      overlay.style.opacity = "0";
      overlay.classList.remove("active");
      setTimeout(() => {
        overlay.remove();
        resolve(value);
      }, 200);
    };

    const submit = () => {
      const val = input ? input.value : "";
      cleanup(val);
    };

    overlay.querySelector(".custom-confirm-btn-cancel").onclick = () => cleanup(null);
    overlay.querySelector(".custom-confirm-btn-confirm").onclick = submit;

    if (input) {
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      };
    }

    overlay.onclick = (e) => {
      if (e.target === overlay) cleanup(null);
    };

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        cleanup(null);
        document.removeEventListener("keydown", handleKeyDown);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
  });
}
window.showPromptDialog = showPromptDialog;

// ── User Avatar (shadcn-inspired: image + initials fallback) ──

/** Known invented placeholders — never treat as a real display name. */
const INVENTED_DISPLAY_NAMES = new Set([
  "新使用者",
  "NLC User",
  "系統管理員",
  "訪客",
  "尚未取得姓名",
  "未命名使用者",
  "教會肢體"
]);

/** Emoji / pictograph ranges commonly seen in joke or spam profile names. */
const PROFILE_NAME_EMOJI_PATTERN = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/u;
const PROFILE_NAME_DIGIT_PATTERN = /[0-9]/;

/**
 * Heuristic only: a run of Latin letters with no vowel, a long consonant
 * run, or a tripled letter reads as keyboard-mash rather than a real word.
 * False positives are expected (e.g. genuine short romanized names) — this
 * is a first-pass filter for the admin review queue, not a hard reject.
 * @param {string} token
 */
function looksLikeGibberishEnglish(token) {
  if (!/^[a-zA-Z]+$/.test(token) || token.length < 2) return false;
  const lower = token.toLowerCase();
  if (!/[aeiouy]/.test(lower)) return true;
  if (/([a-z])\1{2,}/.test(lower)) return true;
  if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(lower)) return true;
  return false;
}

/**
 * Returns the list of reasons a profile name looks incomplete or
 * suspicious, or [] if it looks like a normal display name.
 * @param {string|null|undefined} name
 * @returns {string[]} subset of "empty" | "placeholder" | "digits" | "emoji" | "gibberish_english"
 */
function getProfileNameFlags(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return ["empty"];
  const flags = [];
  if (INVENTED_DISPLAY_NAMES.has(trimmed)) flags.push("placeholder");
  if (PROFILE_NAME_DIGIT_PATTERN.test(trimmed)) flags.push("digits");
  if (PROFILE_NAME_EMOJI_PATTERN.test(trimmed)) flags.push("emoji");
  const latinTokens = trimmed.match(/[a-zA-Z]+/g) || [];
  if (latinTokens.some(looksLikeGibberishEnglish)) flags.push("gibberish_english");
  return flags;
}

/**
 * @param {string|null|undefined} name
 * @returns {boolean} true when the name has none of the suspicious flags above
 */
function isProfileNameValid(name) {
  return getProfileNameFlags(name).length === 0;
}
window.INVENTED_DISPLAY_NAMES = INVENTED_DISPLAY_NAMES;
window.getProfileNameFlags = getProfileNameFlags;
window.isProfileNameValid = isProfileNameValid;

/**
 * Whether a profile is complete enough to enter reading plans.
 * Uses the same user-completion predicate as the login card; pending
 * members without confirmed placement are not blocked here.
 * @param {object|null} [user]
 * @returns {{reason: string, flags?: string[], requiredAction?: string, requiredActionUrl?: string|null}|null}
 */
// Once the Hub context has been confirmed fine at least once in this
// session, a later member_context_unavailable (the background sync
// timestamp merely looking stale) shouldn't interrupt the user again —
// only a genuine data issue (missing profile, unsubmitted membership,
// inactive membership, etc.) should. Resets naturally on logout/reload
// since auth.logout() does a full page navigation.
let planEligibilityVerifiedThisSession = false;

function getPlanEligibilityBlock(user) {
  const u = user || (typeof state !== "undefined" ? state.currentUser : null) || {};
  if (!u || u.is_demo) return null;
  const canonicalBlock = getUserOnboardingBlock(u);
  if (!canonicalBlock) {
    planEligibilityVerifiedThisSession = true;
    return null;
  }
  if (canonicalBlock.reason === "member_context_unavailable" && planEligibilityVerifiedThisSession) {
    return null;
  }
  return canonicalBlock;
}
window.getPlanEligibilityBlock = getPlanEligibilityBlock;

/**
 * Resolve a displayable person name. Returns null when missing or invented.
 * @param {string|{name?: string}|null|undefined} source
 * @returns {string|null}
 */
function getDisplayName(source) {
  const raw = typeof source === "string"
    ? source
    : (source && typeof source === "object" ? source.name : "");
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  if (INVENTED_DISPLAY_NAMES.has(trimmed)) return null;
  return trimmed;
}

/**
 * True while Member Hub identity/org should still show skeletons.
 * @param {object} [user]
 */
function isMemberContextPending(user) {
  if (typeof state !== "undefined" && state.profileIdentityLoading) return true;
  const u = user || (typeof state !== "undefined" ? state.currentUser : null) || {};
  const hubSession = typeof auth !== "undefined" &&
    typeof auth.isLoggedIn === "function" &&
    auth.isLoggedIn() &&
    typeof auth.isMemberHubSession === "function" &&
    auth.isMemberHubSession();
  if (!hubSession) return false;
  const status = String(u.member_context_sync_status || "").trim();
  return !status;
}

function getUserAvatarInitial(name) {
  const trimmed = String(getDisplayName(name) || "").trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase();
}

function normalizeAvatarUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return "";
}

function getUserAvatarContext() {
  const name = getDisplayName(state.currentUser) || "";
  let avatarUrl = normalizeAvatarUrl(state.currentUser?.avatar_url);

  if (!avatarUrl && typeof auth !== "undefined" && auth.isLoggedIn() && typeof auth._parseJwt === "function") {
    const payload = auth._parseJwt(localStorage.getItem(auth.keys.idToken) || "");
    avatarUrl = normalizeAvatarUrl(payload?.picture);
  }

  return { name, avatarUrl };
}

function resolveUserAvatarContext(done) {
  const base = getUserAvatarContext();
  if (base.avatarUrl) {
    done(base);
    return;
  }

  if (typeof auth !== "undefined" && auth.isLoggedIn()) {
    done(base);
    return;
  }

  if (state.isSupabaseMode && state.supabase?.auth?.getUser) {
    state.supabase.auth.getUser().then(({ data }) => {
      const user = data?.user;
      const avatarUrl = normalizeAvatarUrl(
        user?.user_metadata?.avatar_url || user?.user_metadata?.picture
      );
      done({
        name: getDisplayName(state.currentUser) || getDisplayName(user?.email) || "",
        avatarUrl
      });
    }).catch(() => done(base));
    return;
  }

  done(base);
}

/**
 * Render avatar into a container (header button or profile summary).
 * @param {HTMLElement|null} container
 * @param {{ size?: "header"|"lg"|"sm", name?: string, avatarUrl?: string, pending?: boolean }} [options]
 */
function renderUserAvatar(container, options) {
  if (!container) return;

  const opts = options || {};
  const ctx = getUserAvatarContext();
  const name = getDisplayName(opts.name != null ? opts.name : ctx.name) || "";
  const avatarUrl = opts.avatarUrl != null ? normalizeAvatarUrl(opts.avatarUrl) : ctx.avatarUrl;
  const pending = opts.pending === true ||
    (opts.pending !== false && isMemberContextPending() && !name && !avatarUrl);
  const size = opts.size || "sm";
  const sizeClass = size === "header"
    ? " nlc-avatar--header"
    : size === "lg"
      ? " nlc-avatar--lg"
      : " nlc-avatar--sm";

  container.innerHTML = "";

  if (pending) {
    const skel = document.createElement("span");
    skel.className = "nlc-avatar nlc-avatar--skeleton" + sizeClass;
    skel.setAttribute("aria-busy", "true");
    skel.setAttribute("aria-label", "載入中");
    skel.innerHTML = '<span class="skeleton-shimmer" style="display:block;width:100%;height:100%;border-radius:50%;"></span>';
    container.appendChild(skel);
    return;
  }

  const initial = getUserAvatarInitial(name) || "·";
  const root = document.createElement("span");
  root.className = "nlc-avatar" + sizeClass;
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", name || "使用者");

  const fallback = document.createElement("span");
  fallback.className = "nlc-avatar__fallback";
  fallback.textContent = initial;
  root.appendChild(fallback);

  if (avatarUrl) {
    const img = document.createElement("img");
    img.className = "nlc-avatar__image";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.onload = function () {
      img.classList.add("nlc-avatar__image--loaded");
    };
    img.onerror = function () {
      img.remove();
    };
    img.src = avatarUrl;
    root.insertBefore(img, fallback);
  }

  container.appendChild(root);
}

function refreshUserAvatars() {
  resolveUserAvatarContext(function (ctx) {
    renderUserAvatar(document.getElementById("user-avatar-btn"), {
      size: "header",
      name: ctx.name,
      avatarUrl: ctx.avatarUrl
    });
    renderUserAvatar(document.getElementById("profile-summary-avatar"), {
      size: "lg",
      name: ctx.name,
      avatarUrl: ctx.avatarUrl
    });
  });
}

// ── User Scope Filtering ─────────────────────────────────────
/**
 * Returns true if the user has administrator access.
 * @param {object} user
 */
function getIsAdmin(user) {
  if (!user) return false;
  const role = getUserRoleCode(user) || "member";
  return role === "admin";
}

/**
 * Filter a list of users based on the current user's role.
 * - admin                → all users
 * - great_zone_leader   → same great_region
 * - zone_leader         → same pastoral_zone
 * - group_leader        → same pastoral_zone + small_group
 * - member              → only themselves
 *
 * @param {Array} allUsers - Unfiltered user list
 * @param {object} currentUser - The logged-in user object
 * @returns {Array}
 */
function getScopedUsers(allUsers, currentUser) {
  if (!currentUser) return allUsers;
  const role = getUserRoleCode(currentUser) || "member";

  if (hasWholeChurchPlanScope(role)) {
    return allUsers;
  }
  if (role === "great_zone_leader") {
    const assignedRegions = (currentUser.managed_regions || currentUser.great_region || "").split(",").map(s => s.trim()).filter(Boolean);
    return allUsers.filter(u => assignedRegions.includes(u.great_region));
  }
  if (role === "zone_leader") {
    const assignedZones = (currentUser.managed_zones || currentUser.pastoral_zone || "").split(",").map(s => s.trim()).filter(Boolean);
    return allUsers.filter(u => assignedZones.includes(u.pastoral_zone));
  }
  if (role === "group_leader") {
    const assignedGroups = (currentUser.managed_groups || currentUser.small_group || "").split(",").map(s => s.trim()).filter(Boolean);
    return allUsers.filter(u => assignedGroups.includes(u.small_group));
  }
  // member — only themselves
  return allUsers.filter(u => u.name === currentUser.name);
}

// ── Heatmap Grid Builder ─────────────────────────────────────
/**
 * Build and render a 365-day heatmap grid into a container element.
 *
 * @param {string}  containerId  - ID of the container element
 * @param {object}  logsByDate   - Map of { "YYYY-MM-DD": count }
 * @param {number}  [teamSize=1] - Used to scale colour intensity (1 = personal)
 * @param {string}  [label="章"] - Word appended to count in tooltip
 */
function buildHeatmapGrid(containerId, logsByDate, teamSize = 1, label = "章", planStartDate = null, planEndDate = null) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";

  let startDate, endDate;

  if (planStartDate && planEndDate) {
    startDate = new Date(planStartDate);
    startDate.setUTCHours(12, 0, 0, 0);

    endDate = new Date(planEndDate);
    endDate.setUTCHours(12, 0, 0, 0);
  } else {
    startDate = new Date();
    startDate.setUTCHours(12, 0, 0, 0);
    startDate.setUTCDate(startDate.getUTCDate() - 30);

    endDate = new Date();
    endDate.setUTCHours(12, 0, 0, 0);
  }

  const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const wrapper = document.createElement("div");
  wrapper.className = "calendar-heatmap";

  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1, 12));
  const lastMonth = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1, 12));

  while (cursor <= lastMonth) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const firstDay = new Date(Date.UTC(year, month, 1, 12));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();

    const monthBlock = document.createElement("section");
    monthBlock.className = "calendar-month";

    const title = document.createElement("div");
    title.className = "calendar-month-title";
    title.textContent = `${year} ${monthNames[month]}`;
    monthBlock.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "calendar-month-grid";

    weekdays.forEach(day => {
      const labelEl = document.createElement("div");
      labelEl.className = "calendar-weekday";
      labelEl.textContent = day;
      grid.appendChild(labelEl);
    });

    for (let i = 0; i < firstDay.getUTCDay(); i++) {
      const blank = document.createElement("div");
      blank.className = "calendar-day blank";
      grid.appendChild(blank);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const currentDate = new Date(Date.UTC(year, month, day, 12));
      const dateStr = currentDate.toISOString().substring(0, 10);
      const count = logsByDate[dateStr] || 0;
      const inPlanRange = currentDate >= startDate && currentDate <= endDate;

      const cell = document.createElement("div");
      cell.className = "calendar-day";
      cell.setAttribute("data-date", dateStr);
      cell.setAttribute("data-count", count);
      cell.textContent = day;

      let level = 0;
      if (count > 0) {
        const maxCount = Math.max(2, Math.round(teamSize * 1.5));
        const ratio = count / maxCount;
        if (ratio <= 0.1) level = 1;
        else if (ratio <= 0.3) level = 2;
        else if (ratio <= 0.6) level = 3;
        else level = 4;
      }
      cell.dataset.level = String(level);
      if (!inPlanRange) cell.classList.add("out-of-range");
      cell.title = `${dateStr}: ${count} ${label}`;
      grid.appendChild(cell);
    }

    monthBlock.appendChild(grid);
    wrapper.appendChild(monthBlock);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  container.appendChild(wrapper);
}

function getCampaignStageCompletedRounds(stageNo) {
  const target = Number(stageNo || 0);
  const storageKey = `church_stage_completed_rounds_${target}`;

  let liveCompletedRounds = null;
  (state.activePlans || []).forEach(plan => {
    if (!plan) return;
    const planStageNo = Number(plan.stageNo || (plan.campaignDefinition && plan.campaignDefinition.stageNo) || 0);
    if (plan.planKind !== "church_campaign_stage" || planStageNo !== target) return;
    const currentRound = Math.max(1, Number(plan.currentRound || 1));
    const completed = Number(plan.progress || 0) >= 100 ? currentRound : currentRound - 1;
    liveCompletedRounds = Math.max(liveCompletedRounds ?? 0, completed);
  });

  // A currently active plan for this stage is the source of truth — never
  // let a stale localStorage value (e.g. left over from earlier testing, or
  // from before a self/admin progress reset) keep a badge lit past what the
  // live plan actually shows. Self-heal the cache to match while we're here.
  if (liveCompletedRounds !== null) {
    localStorage.setItem(storageKey, String(liveCompletedRounds));
    return liveCompletedRounds;
  }

  // No active plan for this stage right now (e.g. it has rotated out of
  // state.activePlans) — fall back to the last known value so a genuinely
  // earned badge doesn't un-light just because the plan isn't loaded.
  return Number(localStorage.getItem(storageKey) || 0);
}

function getCampaignStageCurrentRound(stageNo) {
  const target = Number(stageNo || 0);
  return (state.activePlans || []).reduce((maxRound, plan) => {
    if (!plan) return maxRound;
    const planStageNo = Number(plan.stageNo || (plan.campaignDefinition && plan.campaignDefinition.stageNo) || 0);
    if (plan.planKind !== "church_campaign_stage" || planStageNo !== target) return maxRound;
    return Math.max(maxRound, Number(plan.currentRound || 1));
  }, 1);
}

function getBadgeMilestoneConfig(badgeId) {
  if (badgeId && badgeId.startsWith("church_stage_award_")) {
    const stageNo = Number(badgeId.replace("church_stage_award_", ""));
    return { levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], unit: "遍", getValue: () => getCampaignStageCompletedRounds(stageNo) };
  }
  return { levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], unit: "遍", getValue: () => 0 };
}

function getBadgeProgressValue(badgeId) {
  const conf = getBadgeMilestoneConfig(badgeId);
  return typeof conf.getValue === "function" ? Number(conf.getValue() || 0) : 0;
}

function getBadgeStarState(badge) {
  const conf = getBadgeMilestoneConfig(badge && badge.id);
  const currentValue = getBadgeProgressValue(badge && badge.id);
  const ascendingLevels = [...conf.levels].sort((a, b) => a - b);
  const maxStars = Math.max(1, Math.min(Number((badge && badge.maxStars) || 5), ascendingLevels.length));
  const achievedStars = Math.min(maxStars, ascendingLevels.filter(level => currentValue >= level).length);
  let displayedStars = Math.max(1, achievedStars);
  if (badge && badge.campaignStageNo) {
    displayedStars = Math.min(maxStars, Math.max(1, getCampaignStageCurrentRound(badge.campaignStageNo)));
  }
  return { level: achievedStars, displayedStars, currentValue, levels: ascendingLevels, unit: conf.unit };
}

function renderBadgeStars(badge, compact = false) {
  const starState = getBadgeStarState(badge);
  const roundCount = (badge && badge.campaignStageNo)
    ? Math.max(1, getCampaignStageCurrentRound(badge.campaignStageNo))
    : starState.displayedStars;

  if (roundCount === 6) {
    const items = `<span class="badge-diamond"><span class="nlc-icon" data-icon="gemFill" aria-hidden="true"></span></span>`;
    return `<span class="badge-stars ${compact ? "badge-stars--compact" : ""}" aria-label="第 6 遍：1 顆鑽石榮譽">${items}</span>`;
  }
  if (roundCount === 7) {
    const items = Array.from({ length: 2 }, () => `<span class="badge-diamond"><span class="nlc-icon" data-icon="gemFill" aria-hidden="true"></span></span>`).join("");
    return `<span class="badge-stars ${compact ? "badge-stars--compact" : ""}" aria-label="第 7 遍：2 顆鑽石榮譽">${items}</span>`;
  }
  if (roundCount === 8) {
    const items = Array.from({ length: 3 }, () => `<span class="badge-diamond"><span class="nlc-icon" data-icon="gemFill" aria-hidden="true"></span></span>`).join("");
    return `<span class="badge-stars ${compact ? "badge-stars--compact" : ""}" aria-label="第 8 遍：3 顆鑽石榮譽">${items}</span>`;
  }
  if (roundCount === 9) {
    const items = `<span class="badge-crown"><span class="nlc-icon" data-icon="crownFill" aria-hidden="true"></span></span>`;
    return `<span class="badge-stars ${compact ? "badge-stars--compact" : ""}" aria-label="第 9 遍：1 個皇冠榮譽">${items}</span>`;
  }
  if (roundCount === 10) {
    const items = Array.from({ length: 2 }, () => `<span class="badge-crown"><span class="nlc-icon" data-icon="crownFill" aria-hidden="true"></span></span>`).join("");
    return `<span class="badge-stars ${compact ? "badge-stars--compact" : ""}" aria-label="第 10 遍：2 個皇冠榮譽">${items}</span>`;
  }
  if (roundCount > 10) {
    const items = Array.from({ length: 3 }, () => `<span class="badge-crown"><span class="nlc-icon" data-icon="crownFill" aria-hidden="true"></span></span>`).join("");
    return `<span class="badge-stars ${compact ? "badge-stars--compact" : ""}" aria-label="第 ${roundCount} 遍：3 個皇冠最高榮譽">${items}</span>`;
  }

  // 1 ~ 5 Rounds (Stars)
  const displayCount = Math.min(5, starState.displayedStars);
  const stars = Array.from({ length: displayCount }, (_, index) => {
    const isLit = index < starState.level;
    return `<span class="badge-star ${isLit ? "badge-star--lit" : "badge-star--unlit"}"><span class="nlc-icon" data-icon="${isLit ? "starFill" : "star"}" aria-hidden="true"></span></span>`;
  }).join("");
  return `<span class="badge-stars ${compact ? "badge-stars--compact" : ""}" aria-label="已點亮 ${starState.level} 顆，共顯示 ${displayCount} 顆">${stars}</span>`;
}

function updateBadgeWallSummary(unlockedCount, total) {
  const summaryEl = document.getElementById("badge-wall-summary");
  if (summaryEl) {
    summaryEl.textContent = `${unlockedCount} / ${total}`;
  }
}



function attachBadgeOpenHandlers(element, badge, isUnlocked) {
  const openDetail = function () {
    if (typeof window.openBadgeDetailPage === "function") {
      const isDark = state.theme === "dark" || document.body.classList.contains("dark-theme");
      window.openBadgeDetailPage(badge, isUnlocked, isDark);
    }
  };
  element.onclick = openDetail;
  element.onkeydown = function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDetail();
    }
  };
}

const CAMPAIGN_MEDAL_FRAME_CLASSES = Array.from({ length: 10 }, (_, index) =>
  `campaign-medal-stage-${index + 1}`
);

const CAMPAIGN_MEDAL_FILENAMES = Object.freeze({
  1: "rock-badge.svg",
  2: "iron-badge.svg",
  3: "copper-badge.svg",
  4: "bronze-badge.svg",
  5: "silver-badge.svg",
  6: "gold-badge.svg",
  7: "adamantine-badge.svg",
  8: "ophir-gold-badge.svg",
  9: "fire-gold-badge.svg",
  10: "new-jerusalem-badge.svg"
});

function getCampaignMedalPath(stageNo) {
  const filename = CAMPAIGN_MEDAL_FILENAMES[Number(stageNo)];
  return filename ? `assets/badges/complete/${filename}?v=20260730_badge_vector_quality` : "";
}

function getBadgeFrameClass(badge) {
  const stageNo = Number(badge && badge.campaignStageNo || 0);
  if (stageNo >= 1 && stageNo <= CAMPAIGN_MEDAL_FRAME_CLASSES.length) {
    return `campaign-medal-stage-${stageNo}`;
  }
  return "";
}

function renderBadgeWall(containerId) {
  console.log('[Badge Debug] renderBadgeWall initialized with containerId:', containerId);
  const container = document.getElementById("badges-grid") || document.getElementById(containerId);
  console.log('[Badge Debug] Target container element:', container);
  if (!container) {
    console.warn('[Badge Debug] Target container not found in DOM!');
    return;
  }
  container.innerHTML = "";

  try {
    const list = window.ACHIEVEMENTS || (typeof ACHIEVEMENTS !== "undefined" ? ACHIEVEMENTS : null);
    console.log('[Badge Debug] Achievements list data:', list);
    if (!list || list.length === 0) {
      console.warn('[Badge Debug] Achievements list is empty or undefined!');
      container.innerHTML = `<div class="badge-wall__empty" style="text-align: center; padding: 2rem; color: var(--text-muted);">暫無徽章 (清單未載入或為空)</div>`;
      return;
    }

    if (container.id === "badges-grid") {
      const unlockedCount = list.filter(badge => {
        const starState = getBadgeStarState(badge);
        return starState.level > 0;
      }).length;
      console.log('[Badge Debug] Unlocked badges count:', unlockedCount, 'out of', list.length);
      updateBadgeWallSummary(unlockedCount, list.length);
    }

    const getClasses = typeof getHonorBadgeItemClasses === "function"
      ? getHonorBadgeItemClasses
      : unlocked => (unlocked ? "honor-badge-item unlocked" : "honor-badge-item locked");

    list.forEach((badge, index) => {
      const starState = getBadgeStarState(badge);
      const isUnlocked = starState.level > 0;
      console.log(`[Badge Debug] Processing badge [${index}]:`, badge.title, 'isUnlocked:', isUnlocked, 'starState:', starState);
      const badgeItem = document.createElement("div");
      badgeItem.className = getClasses(isUnlocked) + " honor-badge-item--tile";
      badgeItem.setAttribute("role", "button");
      badgeItem.setAttribute("tabindex", "0");
      badgeItem.setAttribute("aria-label", (isUnlocked ? "已點亮：" : "尚未點亮：") + badge.title);
      const safeTitle = typeof escapeHTML === "function" ? escapeHTML(badge.title) : badge.title;
      
      let iconContent = "";
      let shellStyle = "height: auto; aspect-ratio: 200/240; display: flex; align-items: center; justify-content: center; position: relative;";

      if (badge.campaignStageNo) {
        const medalPath = getCampaignMedalPath(badge.campaignStageNo);
        const lockStateClass = isUnlocked ? "honor-badge-hex--unlocked" : "honor-badge-hex--locked";
        
        const imgFilterStyle = !isUnlocked
          ? "filter: grayscale(1) saturate(0) brightness(0.75) contrast(1.05); opacity: 0.75;"
          : "";
          
        iconContent = `<img width="200" height="240" class="campaign-medal-image campaign-medal-stage-${badge.campaignStageNo} ${lockStateClass}" src="${medalPath}" loading="lazy" decoding="async" style="${imgFilterStyle}" alt="${safeTitle}" />`;
        
        // ── 覆蓋 CSS 變數，關閉 ::after 背景圖渲染，防止與 <img> 產生重疊重影 ──
        shellStyle += " --campaign-medal-frame: none !important;";
      } else {
        const hexState = isUnlocked ? "honor-badge-hex--unlocked" : "honor-badge-hex--locked";
        iconContent = `
          <div class="honor-badge-hex ${hexState}">
            <span class="nlc-icon nlc-icon--md" data-icon="${badge.iconKey || "award"}" aria-hidden="true"></span>
          </div>
        `;
      }

      const titleHtml = badge.campaignStageNo ? "" : `<span class="honor-badge-item__title">${safeTitle}</span>`;

      badgeItem.innerHTML = `
        ${!isUnlocked ? `<div class="honor-badge-item__lock"><span class="nlc-icon nlc-icon--sm" data-icon="lock" aria-hidden="true"></span></div>` : ""}
        <div class="honor-badge-item__icon-wrap honor-badge-hex-shell" style="${shellStyle}">
          ${iconContent}
          ${isUnlocked ? `<span class="honor-badge-hex__check" aria-hidden="true" style="z-index: 5;"><span class="nlc-icon nlc-icon--sm" data-icon="checkCircle"></span></span>` : ""}
        </div>
        ${titleHtml}
        ${renderBadgeStars(badge)}
      `;
      attachBadgeOpenHandlers(badgeItem, badge, isUnlocked);
      container.appendChild(badgeItem);
    });

    if (typeof hydrateIcons === "function") {
      console.log('[Badge Debug] Hydrating icons inside badge container');
      hydrateIcons(container);
    }
    bindBadgeDetailControls();
    console.log('[Badge Debug] renderBadgeWall completed successfully!');
  } catch (err) {
    console.error('[Badge Debug] Critical error in renderBadgeWall execution:', err);
  }
}



window.navigateToBadgeWall = function () {
  if (typeof appRouter !== "undefined" && typeof appRouter.switchTab === "function") {
    appRouter.switchTab("profile-view");
  }
  requestAnimationFrame(function () {
    const badgesTrigger = document.querySelector('.profile-tab-trigger[data-profile-tab="badges"]');
    if (badgesTrigger) {
      badgesTrigger.click();
    }
    const target = document.getElementById("profile-badges-inner-card");
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
};



window.getBadgeMilestoneConfig = getBadgeMilestoneConfig;
window.getBadgeProgressValue = getBadgeProgressValue;
window.getCampaignStageCompletedRounds = getCampaignStageCompletedRounds;
window.getCampaignStageCurrentRound = getCampaignStageCurrentRound;
window.getBadgeStarState = getBadgeStarState;
window.renderBadgeStars = renderBadgeStars;

// YouVersion high-grade full-screen detail subpage controller
function closeBadgeDetailPage() {
  const page = document.getElementById("badge-detail-page");
  if (!page) return;
  page.classList.add("hidden");
  page.setAttribute("aria-hidden", "true");
  document.body.classList.remove("badge-detail-open");
}

function bindBadgeDetailControls() {
  const backBtn = document.getElementById("badge-page-back-btn");
  if (backBtn && !backBtn._hasBackListener) {
    backBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeBadgeDetailPage();
    });
    backBtn._hasBackListener = true;
  }
}

window.closeBadgeDetailPage = closeBadgeDetailPage;

window.openBadgeDetailPage = function(badge, isUnlocked, isDark) {
  const page = document.getElementById("badge-detail-page");
  const hero = document.getElementById("badge-detail-hero");
  const shield = document.getElementById("detail-shield");
  const icon = document.getElementById("detail-icon");
  const medalImage = document.getElementById("detail-medal-image");
  const title = document.getElementById("detail-title");
  const desc = document.getElementById("detail-desc");
  const timeline = document.getElementById("detail-timeline-container");
  const levelPill = document.getElementById("detail-level-pill");
  const shareBtn = document.getElementById("badge-page-share-btn");
  
  if (!page) return;
  bindBadgeDetailControls();

  const badgeStarState = getBadgeStarState(badge);
  isUnlocked = badgeStarState.level > 0;

  page.style.background = "";
  page.style.color = "";
  page.style.borderColor = "";
  if (hero) {
    hero.style.background = "";
    hero.style.borderColor = "";
    hero.style.color = "";
  }

  // Render text contents
  const starsText = badgeStarState.level > 0
    ? `（${badgeStarState.level} 顆星）`
    : "（第一顆星待點亮）";
  title.textContent = badge.title + starsText;
  desc.textContent = badge.description;

  const triggerEl = document.getElementById("detail-trigger-text");
  const triggerCard = document.getElementById("detail-trigger-card");
  const triggerCopy = badge.triggerText || badge.description;
  if (triggerEl) {
    triggerEl.textContent = triggerCopy;
  }
  if (triggerCard) {
    triggerCard.classList.toggle("hidden", !triggerCopy);
  }

  const campaignMedalPath = getCampaignMedalPath(badge.campaignStageNo);
  if (icon) {
    icon.className = "nlc-icon";
    if (campaignMedalPath) icon.classList.add("hidden");
    icon.style.fontSize = "3rem";
    icon.setAttribute("data-icon", badge.iconKey || "award");
    icon.innerHTML = typeof renderIcon === "function"
      ? renderIcon(badge.iconKey || "award", { size: "hero", className: "nlc-icon" })
      : "";
  }
  if (medalImage) {
    medalImage.className = "campaign-medal-image";
    if (campaignMedalPath) {
      medalImage.classList.add(getBadgeFrameClass(badge));
      medalImage.src = campaignMedalPath;
      medalImage.alt = badge.title || "";
      medalImage.fetchPriority = "high";
      medalImage.style.filter = isUnlocked
        ? ""
        : "grayscale(1) saturate(0) brightness(0.75) contrast(1.05)";
      medalImage.style.opacity = isUnlocked ? "" : "0.75";
    } else {
      medalImage.classList.add("hidden");
      medalImage.removeAttribute("src");
      medalImage.alt = "";
      medalImage.style.filter = "";
      medalImage.style.opacity = "";
    }
  }

  // Apply Shield styles based on unlock state (theme via CSS)
  if (shield) {
    shield.classList.remove("badge-shield--unlocked", "badge-shield--locked", "holographic-shine");
    shield.classList.add(isUnlocked ? "badge-shield--unlocked" : "badge-shield--locked");
    if (isUnlocked) {
      shield.classList.add("holographic-shine");
    }
    const hexInner = shield.querySelector(".honor-badge-hex");
    if (hexInner) {
      hexInner.classList.remove(
        "honor-badge-hex--unlocked", "honor-badge-hex--locked",
        ...CAMPAIGN_MEDAL_FRAME_CLASSES
      );
      hexInner.classList.add(isUnlocked ? "honor-badge-hex--unlocked" : "honor-badge-hex--locked");
      const frameClass = getBadgeFrameClass(badge);
      if (frameClass) hexInner.classList.add(frameClass);
    }
    shield.style.background = "";
    shield.style.borderColor = "";
    shield.style.borderStyle = "";
    shield.style.borderWidth = "";
    shield.style.color = "";
    if (campaignMedalPath) {
      shield.style.setProperty("--campaign-medal-frame", "none", "important");
    } else {
      shield.style.removeProperty("--campaign-medal-frame");
    }
  }

  // Dynamic milestone configurations for YouVersion level circles
  const conf = typeof getBadgeMilestoneConfig === "function"
    ? getBadgeMilestoneConfig(badge.id)
    : { levels: [1], unit: "次", getValue: () => (isUnlocked ? 1 : 0) };
  const currentVal = typeof getBadgeProgressValue === "function"
    ? getBadgeProgressValue(badge.id)
    : (typeof conf.getValue === "function" ? conf.getValue() : 0);

  // Determine highest unlocked level
  let highestUnlockedLevel = 0;
  conf.levels.forEach(lvl => {
    if (currentVal >= lvl) {
      highestUnlockedLevel = Math.max(highestUnlockedLevel, lvl);
    }
  });

  function getMilestoneRatingLabel(lvl) {
    if (lvl <= 5) return `第 ${lvl} 遍完成 (${lvl} 顆星)`;
    if (lvl === 6) return `第 6 遍完成 (1 顆鑽石榮譽)`;
    if (lvl === 7) return `第 7 遍完成 (2 顆鑽石榮譽)`;
    if (lvl === 8) return `第 8 遍完成 (3 顆鑽石榮譽)`;
    if (lvl === 9) return `第 9 遍完成 (1 個皇冠榮譽)`;
    if (lvl === 10) return `第 10 遍完成 (2 個皇冠榮譽)`;
    return `第 ${lvl} 遍完成 (3 個皇冠至尊榮譽)`;
  }

  // Update star-level display pill
  if (levelPill) {
    const roundCount = currentVal || Math.max(1, badgeStarState.level);
    let ratingText = `★ ${roundCount} 遍`;
    if (roundCount === 6) ratingText = "1 鑽石";
    if (roundCount === 7) ratingText = "2 鑽石";
    if (roundCount === 8) ratingText = "3 鑽石";
    if (roundCount === 9) ratingText = "1 皇冠";
    if (roundCount === 10) ratingText = "2 皇冠";
    if (roundCount > 10) ratingText = "3 皇冠";
    levelPill.textContent = ratingText;
    levelPill.style.display = "block";
    levelPill.classList.toggle("is-unlit", badgeStarState.level === 0);
  }

  // Populate milestone items dynamically
  timeline.innerHTML = "";
  conf.levels.forEach(lvl => {
    const isLvlUnlocked = currentVal >= lvl;
    const milestoneTitle = getMilestoneRatingLabel(lvl);
    
    const item = document.createElement("div");
    item.className = "badge-milestone-item";
    
    const circle = document.createElement("div");
    circle.className = `badge-milestone-circle ${isLvlUnlocked ? "badge-milestone-circle--unlocked" : "badge-milestone-circle--locked"}`;
    circle.textContent = lvl;
    
    const contentBox = document.createElement("div");
    contentBox.style.cssText = "flex: 1; display: flex; flex-direction: column; justify-content: center;";
    
    if (isLvlUnlocked) {
      let dateStr = localStorage.getItem(`date_unlocked_${badge.id}_lvl_${lvl}`);
      if (!dateStr) {
        const today = new Date();
        dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
        localStorage.setItem(`date_unlocked_${badge.id}_lvl_${lvl}`, dateStr);
      }
      contentBox.innerHTML = `
        <div style="font-size: 0.875rem; font-weight: 600; color: var(--text-primary); margin-bottom: 2px;">${milestoneTitle}</div>
        <div class="badge-milestone-done">完成於 ${dateStr}</div>
      `;
    } else {
      const diff = lvl - currentVal;
      const pct = Math.min(100, Math.floor((currentVal / lvl) * 100));
      contentBox.innerHTML = `
        <div style="font-size: 0.875rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 2px;">${milestoneTitle}</div>
        <div class="badge-milestone-remaining">還差 ${diff} ${conf.unit}</div>
        <div class="badge-milestone-track">
          <div class="badge-milestone-fill" style="width: ${pct}%;"></div>
        </div>
      `;
    }
    
    item.appendChild(circle);
    item.appendChild(contentBox);
    timeline.appendChild(item);
  });

  // Bind share button
  if (shareBtn) {
    shareBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (navigator.share) {
        navigator.share({
          title: `我解鎖了「${badge.title}」榮譽徽章！`,
          text: `我正在進行聖經速讀挑戰，解鎖了「${badge.title}」勳章！\n${badge.description}`,
          url: window.location.href
        }).catch(err => console.log(err));
      } else {
        if (typeof showToast === "function") {
          showToast(`已複製「${badge.title}」分享文字，快傳送給朋友吧！`);
        } else {
          alert(`已解鎖「${badge.title}」徽章！`);
        }
      }
    };
  }

  // Display page
  page.classList.remove("hidden");
  page.setAttribute("aria-hidden", "false");
  document.body.classList.add("badge-detail-open");
};

// Compatibility aliases
window.openBadgeModal = function(badge, isUnlocked, isDark) {
  window.openBadgeDetailPage(badge, isUnlocked, isDark);
};

window.closeBadgeModal = closeBadgeDetailPage;

window.showBadgeDetail = function(title, description, isUnlocked) {
  const isDark = state.theme === "dark" || document.body.classList.contains("dark-theme");
  const badgeObj = ACHIEVEMENTS.find(b => b.title === title) || { title, description };
  window.openBadgeDetailPage(badgeObj, isUnlocked, isDark);
};

// ── Global Premium Skeleton UI Loader ──────────────────────
const ComponentSkeletonLoader = {
  _bar(width, height = "16px", radius = "6px", extra = "") {
    return `<div class="skeleton-shimmer" style="height:${height};width:${width};border-radius:${radius};${extra}"></div>`;
  },

  _cardShell(content, extraStyle = "") {
    return `<div class="skeleton-card" style="${extraStyle}">${content}</div>`;
  },

  setInlineSkeleton(element, options = {}) {
    const el = typeof element === "string" ? document.querySelector(element) : element;
    if (!el) return;
    if (el.dataset.inlineOriginalHtml === undefined) {
      el.dataset.inlineOriginalHtml = el.innerHTML;
    }
    el.innerHTML = this.getHtml("inline", options);
  },

  restoreInlineSkeleton(element) {
    const el = typeof element === "string" ? document.querySelector(element) : element;
    if (!el || el.dataset.inlineOriginalHtml === undefined) return;
    el.innerHTML = el.dataset.inlineOriginalHtml;
    delete el.dataset.inlineOriginalHtml;
  },

  applyBootSkeletons() {
    this.show("dashboard-plan", "#active-plan-summary");
    this.fill("announcement", "#church-announcements-list", { count: 2 });
    this.fill("plan-list", "#joined-plans-list", { count: 2 });
    this.fill("profile-org", "#profile-summary-org");
    this.setInlineSkeleton("#profile-summary-name", { width: "6rem", height: "1.2rem" });
    this.setInlineSkeleton("#dropdown-user-name", { width: "5.5rem", height: "0.95rem" });
    const rankingList = document.getElementById("pastoral-ranking-list-container");
    if (rankingList && !rankingList.innerHTML.trim()) {
      this.fill("ranking", rankingList, { count: 5 });
    }
  },

  clearBootInlineSkeletons() {
    // Do not restore cached HTML — it often contains invented names like「新使用者」.
    ["#profile-summary-name", "#dropdown-user-name"].forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      delete el.dataset.inlineOriginalHtml;
    });
    if (typeof window.paintProfileIdentityChrome === "function") {
      window.paintProfileIdentityChrome();
    }
    // Clear the plan list skeleton so it doesn't persist if user hasn't visited the plan tab yet.
    // renderJoinedPlansList() (called by renderPlanView) will repopulate it with real data.
    const joinedList = document.getElementById("joined-plans-list");
    if (joinedList) joinedList.innerHTML = "";
  },

  _memberRow() {
    return `
      <div style="height:64px;width:100%;border-radius:12px;display:flex;align-items:center;gap:1rem;padding:0.75rem;background:var(--bg-card);border:1px solid var(--border-card);">
        ${this._bar("40px", "40px", "50%")}
        <div style="flex:1;display:flex;flex-direction:column;gap:0.4rem;min-width:0;">
          ${this._bar("35%", "16px", "4px")}
          ${this._bar("55%", "12px", "4px")}
        </div>
      </div>
    `;
  },

  /**
   * Returns skeleton HTML for a given layout type.
   * @param {string} type
   * @param {{ count?: number, cols?: number }} options
   */
  getHtml(type, options = {}) {
    const count = options.count || 1;

    if (type === "dashboard-plan") {
      return `
        <div class="skeleton-wrapper" style="display:flex;flex-direction:column;gap:1rem;padding:0.25rem 0;">
          ${this._bar("62%", "18px", "6px")}
          ${this._bar("88%", "12px", "4px")}
          ${this._bar("100%", "10px", "999px")}
          <div style="display:flex;justify-content:space-around;gap:0.75rem;padding:0.85rem 0.5rem;border-radius:12px;border:1px solid var(--border-card);background:var(--color-brand-muted);">
            ${Array.from({ length: 3 }, () => `
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:0.35rem;">
                ${this._bar("3.5rem", "16px", "4px")}
                ${this._bar("2.8rem", "10px", "4px")}
              </div>
            `).join("")}
          </div>
          <div style="display:flex;gap:0.75rem;margin-top:0.25rem;">
            ${this._bar("50%", "40px", "10px")}
            ${this._bar("50%", "40px", "10px")}
          </div>
        </div>
      `;
    }

    if (type === "reader") {
      return `
        <div class="skeleton-wrapper" style="padding:1.5rem 0.2rem;display:flex;flex-direction:column;gap:1.2rem;">
          ${this._bar("75%", "32px", "8px", "margin-bottom:0.5rem;")}
          ${this._bar("100%", "24px", "6px")}
          ${this._bar("91%", "24px", "6px")}
          ${this._bar("100%", "24px", "6px")}
          ${this._bar("83%", "24px", "6px")}
          ${this._bar("60%", "24px", "6px")}
        </div>
      `;
    }

    if (type === "plan") {
      return `
        <div class="skeleton-wrapper" style="padding:1rem 0.5rem;display:flex;flex-direction:column;gap:1.5rem;">
          ${this._bar("100%", "120px", "16px")}
          <div style="display:flex;gap:0.75rem;overflow:hidden;padding:0.25rem 0;">
            ${Array.from({ length: 7 }, () => this._bar("48px", "48px", "12px", "flex-shrink:0;")).join("")}
          </div>
          <div style="display:flex;flex-direction:column;gap:0.75rem;">
            ${this._bar("100%", "56px", "12px")}
            ${this._bar("100%", "56px", "12px")}
          </div>
        </div>
      `;
    }

    if (type === "members" || type === "member-progress") {
      const rows = type === "members" ? 5 : (count || 4);
      return `
        <div class="skeleton-wrapper" style="display:flex;flex-direction:column;gap:1rem;padding:1rem 0;">
          ${Array.from({ length: rows }, () => this._memberRow()).join("")}
        </div>
      `;
    }

    if (type === "announcement") {
      return `
        <div class="skeleton-wrapper announcements-list__skeleton">
          ${Array.from({ length: count || 2 }, () => `
            <div class="skeleton-card announcement-item announcement-item--skeleton">
              ${this._bar("38%", "14px", "4px")}
              ${this._bar("92%", "12px", "4px")}
              ${this._bar("72%", "12px", "4px")}
            </div>
          `).join("")}
        </div>
      `;
    }

    if (type === "ranking") {
      return `
        <div class="skeleton-wrapper" style="display:flex;flex-direction:column;gap:0.65rem;">
          ${Array.from({ length: count || 5 }, (_, index) => `
            <div style="display:flex;align-items:center;gap:0.75rem;padding:0.55rem 0.2rem;">
              ${this._bar("28px", "28px", "50%", "flex-shrink:0;")}
              ${this._bar(index % 2 === 0 ? "58%" : "46%", "14px", "4px")}
              <div style="margin-left:auto;">${this._bar("52px", "14px", "4px")}</div>
            </div>
          `).join("")}
        </div>
      `;
    }

    if (type === "plan-list") {
      return `
        <div class="skeleton-wrapper" style="display:flex;flex-direction:column;gap:1rem;padding:1rem 0;">
          ${Array.from({ length: count || 2 }, () => `
            <div class="skeleton-row">
              ${this._bar("72px", "72px", "12px", "flex-shrink:0;")}
              <div style="flex:1;display:flex;flex-direction:column;gap:0.45rem;min-width:0;">
                ${this._bar("55%", "16px", "4px")}
                ${this._bar("78%", "12px", "4px")}
                ${this._bar("42%", "10px", "4px")}
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }

    if (type === "table-rows") {
      const cols = options.cols || 3;
      return `
        <div class="skeleton-wrapper" style="display:flex;flex-direction:column;gap:0.55rem;padding:0.35rem 0;">
          ${Array.from({ length: count || 3 }, () => `
            <div style="display:grid;grid-template-columns:repeat(${cols}, minmax(0, 1fr));gap:0.75rem;align-items:center;padding:0.45rem 0.25rem;">
              ${Array.from({ length: cols }, (_, colIndex) => this._bar(colIndex === 0 ? "72%" : "58%", "14px", "4px")).join("")}
            </div>
          `).join("")}
        </div>
      `;
    }

    if (type === "bar-race") {
      return `
        <div class="skeleton-wrapper" style="display:flex;flex-direction:column;gap:0.75rem;padding:0.5rem 0;">
          ${Array.from({ length: count || 4 }, (_, index) => `
            <div style="display:flex;align-items:center;gap:0.65rem;">
              ${this._bar("24px", "24px", "6px", "flex-shrink:0;")}
              <div style="flex:1;display:flex;flex-direction:column;gap:0.35rem;">
                ${this._bar(index % 2 === 0 ? "42%" : "36%", "12px", "4px")}
                ${this._bar(`${Math.max(35, 88 - index * 12)}%`, "10px", "999px")}
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }

    if (type === "stats") {
      return `
        <div class="skeleton-wrapper" style="display:flex;flex-direction:column;gap:1rem;padding:0.5rem 0;">
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.75rem;">
            ${this._bar("100%", "88px", "14px", "grid-column:span 2;")}
            ${this._bar("100%", "72px", "14px")}
            ${this._bar("100%", "72px", "14px")}
            ${this._bar("100%", "72px", "14px")}
            ${this._bar("100%", "72px", "14px")}
          </div>
          ${this._bar("100%", "140px", "14px")}
          ${this._bar("100%", "180px", "14px")}
          ${this._bar("100%", "220px", "12px")}
        </div>
      `;
    }

    if (type === "verse-card") {
      return `
        <div class="skeleton-wrapper skeleton-on-dark verse-card-skeleton" style="display:flex;flex-direction:column;gap:1rem;height:100%;min-height:268px;justify-content:space-between;">
          <div style="display:flex;flex-direction:column;gap:0.5rem;">
            ${this._bar("32%", "10px", "4px")}
            ${this._bar("24%", "12px", "4px")}
          </div>
          <div style="display:flex;flex-direction:column;gap:0.65rem;flex:1;justify-content:center;padding:1rem 0;">
            ${this._bar("96%", "20px", "6px")}
            ${this._bar("88%", "20px", "6px")}
            ${this._bar("64%", "20px", "6px")}
          </div>
          <div style="display:flex;justify-content:space-between;gap:0.5rem;border-top:1px solid rgba(255,255,255,0.08);padding-top:0.75rem;">
            ${this._bar("28%", "36px", "8px")}
            ${this._bar("28%", "36px", "8px")}
            ${this._bar("28%", "36px", "8px")}
          </div>
        </div>
      `;
    }

    if (type === "inline") {
      return `<span class="skeleton-shimmer skeleton-inline" style="display:inline-block;width:${options.width || "4.5rem"};height:${options.height || "0.85em"};border-radius:4px;vertical-align:middle;"></span>`;
    }

    if (type === "task-list") {
      return `
        <div class="skeleton-wrapper" style="display:flex;flex-direction:column;gap:0.75rem;padding:0.25rem 0;">
          ${Array.from({ length: count || 3 }, () => this._bar("100%", "56px", "12px")).join("")}
        </div>
      `;
    }

    if (type === "profile-org") {
      return `
        <span class="skeleton-wrapper" style="display:inline-flex;flex-direction:column;gap:0.35rem;min-width:8rem;">
          ${this._bar("9rem", "12px", "4px")}
          ${this._bar("6.5rem", "10px", "4px")}
        </span>
      `;
    }

    if (type === "placement-value") {
      return `<span class="skeleton-wrapper" style="display:inline-block;min-width:3.5rem;">${this._bar(options.width || "4.5rem", options.height || "1rem", "4px")}</span>`;
    }

    if (type === "role-badge") {
      return `<span class="skeleton-wrapper" style="display:inline-block;">${this._bar(options.width || "4rem", options.height || "1.25rem", "999px")}</span>`;
    }

    return "";
  },

  /**
   * Sets skeleton HTML without caching the original content.
   */
  fill(type, container, options = {}) {
    const parent = typeof container === "string" ? document.querySelector(container) : container;
    if (!parent) return;
    parent.innerHTML = this.getHtml(type, options);
  },

  /**
   * Renders a shimmer skeleton layout inside the specified container.
   * @param {string} type
   * @param {HTMLElement|string} container
   * @param {{ count?: number, cols?: number }} options
   */
  show(type, container, options = {}) {
    const parent = typeof container === "string" ? document.querySelector(container) : container;
    if (!parent) return;

    if (!parent.dataset.originalHtml) {
      parent.dataset.originalHtml = parent.innerHTML;
    }

    parent.innerHTML = this.getHtml(type, options);
  },

  /**
   * Hides the skeleton loader and restores the cached HTML.
   * @param {HTMLElement|string} container
   */
  hide(container) {
    const parent = typeof container === "string" ? document.querySelector(container) : container;
    if (!parent) return;
    if (parent.dataset.originalHtml !== undefined) {
      parent.innerHTML = parent.dataset.originalHtml;
      delete parent.dataset.originalHtml;
    }
  }
};
window.ComponentSkeletonLoader = ComponentSkeletonLoader;

window.showToast = showToast;
window.getDisplayName = getDisplayName;
window.isMemberContextPending = isMemberContextPending;
window.getUserAvatarInitial = getUserAvatarInitial;
window.normalizeAvatarUrl = normalizeAvatarUrl;
window.getUserAvatarContext = getUserAvatarContext;
window.resolveUserAvatarContext = resolveUserAvatarContext;
window.renderUserAvatar = renderUserAvatar;
window.refreshUserAvatars = refreshUserAvatars;
window.getIsAdmin = getIsAdmin;
window.getScopedUsers = getScopedUsers;
window.buildHeatmapGrid = buildHeatmapGrid;
window.renderBadgeWall = renderBadgeWall;


// === Moved Plan Helpers ===
function getPlanLevelRounds(level) {
  if (level === "breakthrough") return 2;
  if (level === "super") return 3;
  if (typeof level === "string" && level.startsWith("level")) {
    const num = parseInt(level.substring(5), 10);
    if (!isNaN(num)) return num;
  }
  const num = parseInt(level, 10);
  if (!isNaN(num)) return num;
  return 1;
}

function getPlanLevelLabel(level) {
  if (level === "breakthrough") return "突破";
  if (level === "super") return "興盛";
  if (level === "normal") return "一般";
  const rounds = getPlanLevelRounds(level);
  if (rounds > 3) return `Level ${rounds}`;
  return "一般";
}

function getPlanLevelOrder(level) {
  return getPlanLevelRounds(level);
}

function addDaysIso(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function getDowngradeLockedUntil(plan) {
  return (plan && plan.downgradeLockedUntil) || (typeof getLocalPlanDowngradeLock === "function" ? getLocalPlanDowngradeLock(plan) : null);
}

function isPlanUpgradeLocked(plan) {
  const lockedUntil = getDowngradeLockedUntil(plan);
  if (!lockedUntil) return false;
  return new Date(lockedUntil).getTime() > Date.now();
}

function formatLockDate(lockedUntil) {
  const date = new Date(lockedUntil);
  if (isNaN(date)) return "兩週後";
  return date.getFullYear() + "/" + String(date.getMonth() + 1).padStart(2, "0") + "/" + String(date.getDate()).padStart(2, "0");
}

async function persistPlanLevelState(plan) {
  if (!plan) return;
  if (typeof setLocalPlanDowngradeLock === "function") {
    setLocalPlanDowngradeLock(plan, plan.downgradeLockedUntil || null);
  }

  if (state.isSupabaseMode && state.supabase && plan.id) {
    const payload = {
      level: plan.level,
      current_round: plan.currentRound || getPlanLevelOrder(plan.level),
      was_downgraded: !!plan.wasDowngraded,
      downgrade_locked_until: plan.downgradeLockedUntil || null,
      upgrade_prompt_handled: !!plan.upgradePromptHandled,
      current_round_started_at: plan.currentRoundStartedAt || null
    };
    const { error } = await state.supabase.from("reading_plans").update(payload).eq("id", plan.id);
    if (error) {
      console.warn("Failed to persist downgrade lock column, retrying without it", error);
      const { error: retryError } = await state.supabase.from("reading_plans")
        .update({
          level: plan.level,
          current_round: plan.currentRound || getPlanLevelOrder(plan.level),
          was_downgraded: !!plan.wasDowngraded,
          upgrade_prompt_handled: !!plan.upgradePromptHandled
        })
        .eq("id", plan.id);
      if (retryError) throw retryError;
    }
  } else if (!state.isSupabaseMode) {
    localStorage.setItem("active_reading_plans", JSON.stringify(state.activePlans || []));
  }
}

function expandChaptersForLevel(chapters, level) {
  const rounds = getPlanLevelRounds(level);
  const expanded = [];
  for (let round = 1; round <= rounds; round++) {
    chapters.forEach(ch => expanded.push({ ...ch, round }));
  }
  return expanded;
}

function distributeChaptersAcrossDays(chapters, readingDays) {
  if (typeof readingDays !== 'number' || isNaN(readingDays) || readingDays <= 0) {
    return [];
  }
  const dailyChapters = Array.from({ length: readingDays }, () => []);
  const chsPerDay = Math.floor(chapters.length / readingDays);
  let remainder = chapters.length % readingDays;
  let chIdx = 0;

  for (let d = 0; d < readingDays; d++) {
    const todayCount = chsPerDay + (remainder > 0 ? 1 : 0);
    remainder--;
    for (let c = 0; c < todayCount; c++) {
      if (chIdx < chapters.length) {
        dailyChapters[d].push(chapters[chIdx]);
        chIdx++;
      }
    }
  }

  return dailyChapters;
}

function normalizePlanScheduleSettings(isFixed, readingDaysPerWeek = 7, restWeekdays = []) {

  const normalizedRestDays = Array.from(new Set((Array.isArray(restWeekdays) ? restWeekdays : [])
    .map(Number)
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)))
    .sort((a, b) => a - b);
  const requestedDays = Math.max(1, Math.min(7, Number(readingDaysPerWeek) || 7));

  if (normalizedRestDays.length !== 7 - requestedDays) {
    return { readingDaysPerWeek: 7 - normalizedRestDays.length, restWeekdays: normalizedRestDays };
  }

  return { readingDaysPerWeek: requestedDays, restWeekdays: normalizedRestDays };
}

function rebuildPlanScheduleForLevel(plan, level) {
  if (!plan) return plan;
  const rebuilt = generatePlanObject(
    plan.name,
    plan.startDate,
    plan.endDate,
    plan.target_books || plan.targetBooks || [],
    plan.presetKey,
    level,
    plan.isFixed !== false && plan.is_fixed !== false,
    {
      readingDaysPerWeek: plan.readingDaysPerWeek || plan.reading_days_per_week,
      restWeekdays: plan.restWeekdays || plan.rest_weekdays,
      planId: plan.id,
      presetKey: plan.presetKey,
      currentRoundStartedAt: plan.currentRoundStartedAt || plan.current_round_started_at || null
    }
  );
  Object.assign(plan, {
    totalDays: rebuilt.totalDays,
    totalChapters: rebuilt.totalChapters,
    days: rebuilt.days,
    level,
    currentRound: getPlanLevelOrder(level),
    target_books: plan.target_books || rebuilt.target_books,
    targetBooks: plan.targetBooks || rebuilt.targetBooks,
    isFixed: rebuilt.isFixed,
    is_fixed: rebuilt.is_fixed,
    readingDaysPerWeek: rebuilt.readingDaysPerWeek,
    reading_days_per_week: rebuilt.reading_days_per_week,
    restWeekdays: rebuilt.restWeekdays,
    rest_weekdays: rebuilt.rest_weekdays
  });
  return plan;
}
function resolveChurchCampaignDefinition(presetKey, name) {
  const globalPlan = (state.globalPlans || []).find(plan =>
    plan.id === presetKey
    || plan.globalPlanId === presetKey
    || plan.presetKey === presetKey
    || (["church_campaign", "church_campaign_stage"].includes(plan.planKind) && plan.name === name)
  );
  if (globalPlan && ["church_campaign", "church_campaign_stage"].includes(globalPlan.planKind)) {
    return window.cloneChurchCampaign(globalPlan.campaignDefinition || window.CHURCH_CAMPAIGN);
  }
  if (presetKey === window.CHURCH_CAMPAIGN_PRESET_KEY || presetKey === window.CHURCH_CAMPAIGN_ID) {
    return window.cloneChurchCampaign();
  }
  const preset = presetKey && CHURCH_PLAN_PRESETS[presetKey];
  if (preset && preset.planKind === "church_campaign_stage") {
    return window.cloneChurchCampaign(preset.campaignDefinition);
  }
  const stage = window.createChurchCampaignStageDefinitions().find(item =>
    item.id === presetKey || item.presetKey === presetKey || item.name === name
  );
  return stage ? window.cloneChurchCampaign(stage) : null;
}

function generateChurchCampaignPlanObject(definition, presetKey, scheduleSettings = null, level = "normal") {
  const weeklySchedule = normalizePlanScheduleSettings(
    false,
    scheduleSettings && scheduleSettings.readingDaysPerWeek,
    scheduleSettings && scheduleSettings.restWeekdays
  );
  const baseDays = window.buildChurchCampaignDays(definition, BIBLE_BOOKS, weeklySchedule.restWeekdays);
  const roundCount = getPlanLevelRounds(level);
  const startDate = new Date(`${definition.startDate}T00:00:00`);
  const lastOffset = Math.max(0, baseDays.length - 1);
  const completedRoundCount = Math.max(0, roundCount - 1);
  const baseChapterKeys = new Set(baseDays.flatMap(day => (day.chapters || []).map(chapter =>
    `${chapter.book}_${chapter.chapter}`
  )));
  const planId = scheduleSettings && scheduleSettings.planId;
  const planPresetKey = scheduleSettings && scheduleSettings.presetKey || presetKey;
  const matchingLogs = (state.readingLogs || []).filter(log => {
    const chapterKey = `${log.book}_${log.chapter}`;
    if (!baseChapterKeys.has(chapterKey)) return false;
    const logPlanId = log.plan_id || null;
    const logPresetKey = log.presetKey || log.preset_key || null;
    if (planId && logPlanId) return String(logPlanId) === String(planId);
    if (planPresetKey && logPresetKey) return String(logPresetKey) === String(planPresetKey);
    return !logPlanId && !logPresetKey;
  });
  const nowForCampaignRounds = new Date();
  const todayLocalStrForCampaignRounds = nowForCampaignRounds.getFullYear() + '-'
    + String(nowForCampaignRounds.getMonth() + 1).padStart(2, '0') + '-'
    + String(nowForCampaignRounds.getDate()).padStart(2, '0');
  const todayOffsetForCampaignRounds = Math.max(0, Math.min(
    lastOffset,
    Math.floor((new Date(todayLocalStrForCampaignRounds + "T00:00:00") - startDate) / 86400000)
  ));

  // 目前正在進行中的那次「確認進入下一輪」，優先用使用者點選當下記錄的
  // current_round_started_at，而不是下一輪第一次打卡的日期或今天——只有
  // 舊資料還沒有這個欄位時才退回舊邏輯。
  const confirmedRoundEntryAtCampaign = scheduleSettings && scheduleSettings.currentRoundStartedAt
    ? new Date(String(scheduleSettings.currentRoundStartedAt).slice(0, 10) + "T00:00:00")
    : null;
  const hasConfirmedRoundEntryCampaign = confirmedRoundEntryAtCampaign && !Number.isNaN(confirmedRoundEntryAtCampaign.getTime());
  const confirmedRoundEntryOffsetCampaign = hasConfirmedRoundEntryCampaign
    ? Math.max(0, Math.min(lastOffset, Math.floor((confirmedRoundEntryAtCampaign - startDate) / 86400000)))
    : null;

  const completedChapterOffsets = [];
  const roundEndOffsets = [];
  for (let round = 1; round <= completedRoundCount; round += 1) {
    const offsets = new Map();
    matchingLogs.filter(log => Number(log.round || 1) === round).forEach(log => {
      const readDate = new Date(String(log.read_at || log.readAt || "").slice(0, 10) + "T00:00:00");
      if (Number.isNaN(readDate.getTime())) return;
      const offset = Math.max(0, Math.min(lastOffset, Math.floor((readDate - startDate) / 86400000)));
      offsets.set(`${log.book}_${log.chapter}`, offset);
    });
    completedChapterOffsets.push(offsets);

    // 這一輪的結束界線：目前這次的下一輪(round+1 === roundCount)優先用
    // 確認進入下一輪的時間點；再往前的歷史交界，仍用下一輪第一次打卡
    // 那天決定，而不是這一輪自己最後一次打卡的隔天。
    const prevBoundary = roundEndOffsets.length > 0 ? roundEndOffsets[roundEndOffsets.length - 1] : -1;
    const isCurrentActiveTransitionCampaign = (round + 1) === roundCount;
    let boundary;
    if (isCurrentActiveTransitionCampaign && hasConfirmedRoundEntryCampaign) {
      boundary = confirmedRoundEntryOffsetCampaign - 1;
    } else {
      const nextRoundOffsets = matchingLogs
        .filter(log => Number(log.round || 1) === round + 1)
        .map(log => {
          const readDate = new Date(String(log.read_at || log.readAt || "").slice(0, 10) + "T00:00:00");
          if (Number.isNaN(readDate.getTime())) return null;
          return Math.max(0, Math.min(lastOffset, Math.floor((readDate - startDate) / 86400000)));
        })
        .filter(offset => offset !== null);
      boundary = nextRoundOffsets.length > 0
        ? Math.min(...nextRoundOffsets) - 1
        : todayOffsetForCampaignRounds - 1;
    }
    roundEndOffsets.push(Math.max(prevBoundary + 1, boundary));
  }
  const days = segmentScheduleDaysForRoundCount(
    baseDays,
    roundCount,
    roundEndOffsets,
    completedChapterOffsets
  );
  days.forEach(day => {
    day.chapters.forEach(chapter => {
      chapter.key = chapter.book + "_" + chapter.chapter + "_" + (chapter.round || 1);
    });
  });
  const targetBooks = Array.from(new Set(definition.segments.flatMap(segment =>
    segment.readings.map(reading => reading.book)
  )));
  const currentRoundTotalChapters = baseDays.reduce((sum, day) => sum + day.chapters.length, 0);
  const totalChapters = currentRoundTotalChapters * roundCount;
  return {
    name: definition.name,
    description: definition.description || "",
    startDate: definition.startDate,
    endDate: definition.endDate,
    totalDays: days.length,
    totalChapters,
    currentRoundTotalChapters,
    completedChapters: 0,
    progress: 0,
    days,
    presetKey,
    target_books: targetBooks,
    targetBooks,
    level,
    currentRound: roundCount,
    wasDowngraded: false,
    isFixed: true,
    is_fixed: true,
    planKind: definition.planKind || (definition.stageNo ? "church_campaign_stage" : "church_campaign"),
    stageNo: Number(definition.stageNo) || null,
    roundNo: Number(definition.roundNo) || null,
    awardName: definition.awardName || null,
    campaignDefinition: window.cloneChurchCampaign(definition),
    campaignStages: definition.stages,
    campaignRules: definition.rules,
    ruleVersion: Number(definition.version || 1),
    readingDaysPerWeek: weeklySchedule.readingDaysPerWeek,
    reading_days_per_week: weeklySchedule.readingDaysPerWeek,
    restWeekdays: weeklySchedule.restWeekdays,
    rest_weekdays: weeklySchedule.restWeekdays
  };
}

function generatePlanObject(name, startDate, endDate, selectedBooks, presetKey = null, level = "normal", isFixed = true, scheduleSettings = null) {
  const preset = presetKey ? CHURCH_PLAN_PRESETS[presetKey] : null;
  const campaignDefinition = resolveChurchCampaignDefinition(presetKey, name);
  const weeklySchedule = normalizePlanScheduleSettings(
    isFixed,
    scheduleSettings && scheduleSettings.readingDaysPerWeek,
    scheduleSettings && scheduleSettings.restWeekdays
  );
  if (campaignDefinition) {
    return generateChurchCampaignPlanObject(
      campaignDefinition,
      presetKey || window.CHURCH_CAMPAIGN_PRESET_KEY,
      {
        ...weeklySchedule,
        planId: scheduleSettings && scheduleSettings.planId,
        presetKey: scheduleSettings && scheduleSettings.presetKey || presetKey
      },
      level
    );
  }
  const restWeekdaySet = new Set(weeklySchedule.restWeekdays);

  // 1. Calculate parseLocalDate
  const parseLocalDate = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') {
      return new Date();
    }
    const parts = dateStr.split('-');
    if (parts.length < 3) {
      return new Date();
    }
    const [year, month, day] = parts.map(Number);
    return new Date(year, month - 1, day);
  };
  const start = parseLocalDate(startDate || '');
  const end = parseLocalDate(endDate || '');
  const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

  // 2. If level is normal AND it is a preset plan, use the original month-by-month calendar grid
  if (isFixed && level === "normal" && preset && preset.months) {
    const days = [];
    let dayNumCounter = 1;
    let totalChaptersCount = 0;

    preset.months.forEach(mSpec => {
      const allChapters = [];
      mSpec.books.forEach(bookName => {
        if (bookName === "詩篇 1-110") {
          for (let i = 1; i <= 110; i++) {
            allChapters.push({ book: "詩篇", chapter: i });
          }
        } else if (bookName === "詩篇 111-150") {
          for (let i = 111; i <= 150; i++) {
            allChapters.push({ book: "詩篇", chapter: i });
          }
        } else {
          const book = BIBLE_BOOKS.find(b => b.name === bookName);
          if (book) {
            for (let i = 1; i <= book.chapters; i++) {
              allChapters.push({ book: book.name, chapter: i });
            }
          }
        }
      });

      const expandedChapters = expandChaptersForLevel(allChapters, level);
      totalChaptersCount += expandedChapters.length;

      const readingDays = mSpec.readingDays;
      const dailyChapters = distributeChaptersAcrossDays(expandedChapters, readingDays);
      const daysInMonth = new Date(mSpec.year, mSpec.month, 0).getDate();

      for (let dayOffset = 0; dayOffset < daysInMonth; dayOffset++) {
        const dayDate = new Date(mSpec.year, mSpec.month - 1, dayOffset + 1);
        const mm = String(dayDate.getMonth() + 1).padStart(2, '0');
        const dd = String(dayDate.getDate()).padStart(2, '0');
        const dateStr = `${mm}/${dd}`;

        let chapters = [];
        if (dayOffset < readingDays) {
          chapters = dailyChapters[dayOffset].map(ch => ({
            book: ch.book,
            chapter: ch.chapter,
            key: `${ch.book}_${ch.chapter}_${ch.round || 1}`,
            round: ch.round || 1
          }));
        }

        days.push({
          dayNum: dayNumCounter++,
          date: dateStr,
          year: mSpec.year,
          month: mSpec.month,
          chapters: chapters
        });
      }
    });

    const planStart = parseLocalDate(startDate || preset.startDate);
    days.forEach((day, index) => {
      const dayDate = new Date(planStart);
      dayDate.setDate(planStart.getDate() + index);
      const mm = String(dayDate.getMonth() + 1).padStart(2, '0');
      const dd = String(dayDate.getDate()).padStart(2, '0');
      day.date = `${mm}/${dd}`;
      day.year = dayDate.getFullYear();
      day.month = dayDate.getMonth() + 1;
    });

    return {
      name: preset.name,
      startDate: startDate || preset.startDate,
      endDate: endDate || preset.endDate,
      totalDays: days.length,
      totalChapters: totalChaptersCount,
      completedChapters: 0,
      progress: 0,
      days,
      presetKey,
      target_books: selectedBooks,
      targetBooks: selectedBooks,
      level,
      currentRound: 1,
      wasDowngraded: false,
      isFixed,
      is_fixed: isFixed,
      readingDaysPerWeek: weeklySchedule.readingDaysPerWeek,
      reading_days_per_week: weeklySchedule.readingDaysPerWeek,
      restWeekdays: weeklySchedule.restWeekdays,
      rest_weekdays: weeklySchedule.restWeekdays
    };
  }

  // 3. Otherwise (custom plans, or upgraded preset plans), use the new segmented round-distribution logic!
  const allChapters = [];
  const booksToUse = (preset && preset.months ? preset.months.flatMap(m => m.books) : selectedBooks) || [];
  booksToUse.forEach(bookName => {
    if (bookName === "詩篇 1-110") {
      for (let i = 1; i <= 110; i++) {
        allChapters.push({ book: "詩篇", chapter: i });
      }
    } else if (bookName === "詩篇 111-150") {
      for (let i = 111; i <= 150; i++) {
        allChapters.push({ book: "詩篇", chapter: i });
      }
    } else {
      const book = BIBLE_BOOKS.find(b => b.name === bookName);
      if (book) {
        for (let i = 1; i <= book.chapters; i++) {
          allChapters.push({ book: book.name, chapter: i });
        }
      }
    }
  });

  // Calculate round completion days dynamically from reading logs
  const maxRounds = getPlanLevelRounds(level);
  const roundCompletionDays = []; // index 0 for round 1, index 1 for round 2, etc. (up to maxRounds-1)

  // 下一遍的排程起點，優先用「使用者點選確認進入下一遍」當下記錄的
  // current_round_started_at 時間點——不是讀完上一遍的隔天，也不是下一遍
  // 第一次打卡的日期，避免確認進入前的空檔被當成落後。舊資料還沒有這個
  // 欄位時，才退回「今天」當起點（同樣不會把等待期算成落後），確保這段
  // 邏輯對還沒跑過遷移的既有計畫也不會壞掉。
  start.setHours(0, 0, 0, 0);
  const todayZeroForRounds = new Date();
  todayZeroForRounds.setHours(0, 0, 0, 0);
  const todayOffsetForRounds = Math.max(1, Math.floor((todayZeroForRounds - start) / (1000 * 60 * 60 * 24)) + 1);
  const confirmedRoundEntryAt = scheduleSettings && scheduleSettings.currentRoundStartedAt
    ? new Date(String(scheduleSettings.currentRoundStartedAt).slice(0, 10) + "T00:00:00")
    : null;
  const hasConfirmedRoundEntry = confirmedRoundEntryAt && !Number.isNaN(confirmedRoundEntryAt.getTime());

  for (let r = 1; r < maxRounds; r++) {
    const isCurrentActiveTransition = (r + 1) === maxRounds;
    const prevD = r > 1 ? roundCompletionDays[r - 2] : 0;
    let d_r = null;
    if (isCurrentActiveTransition && hasConfirmedRoundEntry) {
      d_r = Math.max(1, Math.floor((confirmedRoundEntryAt - start) / (1000 * 60 * 60 * 24)) + 1);
      d_r = Math.max(d_r, prevD + 1);
    } else {
      const nextRoundLogs = (state.readingLogs || []).filter(l => (l.round || 1) === r + 1);
      if (nextRoundLogs.length > 0) {
        const minDateStr = nextRoundLogs.reduce((min, log) => log.read_at < min ? log.read_at : min, nextRoundLogs[0].read_at);
        const minDate = new Date(minDateStr.substring(0, 10));
        minDate.setHours(0, 0, 0, 0);
        d_r = Math.max(1, Math.floor((minDate - start) / (1000 * 60 * 60 * 24)) + 1);
        d_r = Math.max(d_r, prevD + 1);
      } else {
        d_r = Math.max(todayOffsetForRounds, prevD + 1);
      }
    }
    d_r = Math.min(d_r, totalDays - (maxRounds - r));
    roundCompletionDays.push(d_r);
  }

  let dailyChapters = Array.from({ length: totalDays }, () => []);
  const allEligibleOffsets = Array.from({ length: totalDays }, (_, index) => index)
    .filter(dayOffset => {
      const date = new Date(start);
      date.setDate(start.getDate() + dayOffset);
      return !restWeekdaySet.has(date.getDay());
    });

  for (let r = 1; r <= maxRounds; r++) {
    const roundChapters = allChapters.map(ch => ({ ...ch, round: r }));
    const roundStartDay = r > 1 ? roundCompletionDays[r - 2] : 0;
    const roundEndDay = r < maxRounds ? roundCompletionDays[r - 1] : totalDays;
    const calendarOffsets = Array.from(
      { length: Math.max(0, roundEndDay - roundStartDay) },
      (_, index) => roundStartDay + index
    );
    const eligibleOffsets = calendarOffsets.filter(dayOffset => allEligibleOffsets.includes(dayOffset));
    const readingOffsets = eligibleOffsets.length > 0 ? eligibleOffsets : allEligibleOffsets;

    if (readingOffsets.length > 0) {
      const rDaily = distributeChaptersAcrossDays(roundChapters, readingOffsets.length);
      for (let i = 0; i < readingOffsets.length; i++) {
        const dayOffset = readingOffsets[i];
        dailyChapters[dayOffset] = dailyChapters[dayOffset].concat(rDaily[i]);
      }
    }
  }

  const days = dailyChapters.map((chapters, index) => {
    const dayDate = new Date(start);
    dayDate.setDate(start.getDate() + index);
    const mm = String(dayDate.getMonth() + 1).padStart(2, '0');
    const dd = String(dayDate.getDate()).padStart(2, '0');
    const dateStr = `${mm}/${dd}`;

    return {
      dayNum: index + 1,
      date: dateStr,
      year: dayDate.getFullYear(),
      month: dayDate.getMonth() + 1,
      isRestDay: restWeekdaySet.has(dayDate.getDay()),
      chapters: chapters.map(ch => ({
        book: ch.book,
        chapter: ch.chapter,
        key: `${ch.book}_${ch.chapter}_${ch.round || 1}`,
        round: ch.round || 1
      }))
    };
  });

  return {
    name,
    startDate,
    endDate,
    totalDays,
    totalChapters: allChapters.length * getPlanLevelRounds(level),
    completedChapters: 0,
    progress: 0,
    days,
    presetKey,
    target_books: selectedBooks,
    level,
    currentRound: getPlanLevelRounds(level),
    wasDowngraded: false,
    isFixed,
    is_fixed: isFixed,
    readingDaysPerWeek: weeklySchedule.readingDaysPerWeek,
    reading_days_per_week: weeklySchedule.readingDaysPerWeek,
    restWeekdays: weeklySchedule.restWeekdays,
    rest_weekdays: weeklySchedule.restWeekdays
  };
}

function calculatePlanProgress() {
  calculateAllPlansProgress();
  if (state.activePlan && state.activePlans) {
    const currentInList = state.activePlans.find(p => p && p.presetKey === state.activePlan.presetKey);
    if (currentInList) {
      state.activePlan = currentInList;
    }
  }
}

function toLocalYYYYMMDD(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
window.toLocalYYYYMMDD = toLocalYYYYMMDD;

function isPlanStarted(plan) {
  if (!plan) return false;
  if (plan.isFixed === false || plan.is_fixed === false) return true;
  const todayStr = toLocalYYYYMMDD(new Date());
  return todayStr >= plan.startDate;
}

function isPlanExpired(plan) {
  if (!plan || !plan.endDate) return false;
  if (plan.isFixed === false || plan.is_fixed === false) return false;
  const todayStr = toLocalYYYYMMDD(new Date());
  return todayStr > plan.endDate;
}

function selectMostRecentActivePlan(plans, currentDate = new Date()) {
  const visiblePlans = getVisiblePlans(plans || []).filter(Boolean);
  if (visiblePlans.length === 0) return null;

  const toDateKey = (value, fallback) => {
    if (!value) return fallback;
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return toLocalYYYYMMDD(raw) || fallback;
  };
  const todayKey = toDateKey(currentDate, toLocalYYYYMMDD(new Date()));
  const datedPlans = visiblePlans.map(plan => {
    const startKey = toDateKey(plan.startDate || plan.start_date, "0000-00-00");
    const endKey = toDateKey(plan.endDate || plan.end_date, startKey || "9999-12-31");
    return { plan, startKey, endKey };
  });
  const currentPlans = datedPlans.filter(plan => plan.startKey <= todayKey && plan.endKey >= todayKey);
  if (currentPlans.length > 0) {
    return [...currentPlans].sort((a, b) => b.startKey.localeCompare(a.startKey))[0]?.plan || null;
  }
  const upcomingPlans = datedPlans.filter(plan => plan.startKey > todayKey);
  if (upcomingPlans.length > 0) {
    return [...upcomingPlans].sort((a, b) => a.startKey.localeCompare(b.startKey))[0]?.plan || null;
  }
  return [...datedPlans].sort((a, b) => b.endKey.localeCompare(a.endKey))[0]?.plan || null;
}

function calculateAllPlansProgress() {
  const visibleActivePlans = getVisiblePlans(state.activePlans || []);

  if (visibleActivePlans.length === 0) {
    state.activePlan = null;
    return;
  }

  visibleActivePlans.forEach(plan => {
    if (!plan) return;
    // 💡 數據一致性修正：直接從打卡日誌計算實際讀過的最大遍數
    let maxReadRound = plan.currentRound || 1;
    if (state.readingLogs) {
      state.readingLogs.forEach(l => {
        const logPlanId = l.plan_id || null;
        const logPresetKey = l.presetKey || l.preset_key || null;
        const isPlanMatch =
          (plan.id && logPlanId && logPlanId === plan.id) ||
          (plan.presetKey && logPresetKey && logPresetKey === plan.presetKey) ||
          ((plan.id || plan.presetKey) && !logPlanId && !logPresetKey) ||
          (!plan.id && !plan.presetKey && !logPlanId && !logPresetKey);
        
        if (isPlanMatch) {
          maxReadRound = Math.max(maxReadRound, l.round || 1);
        }
      });
    }

    const currentLevelOrder = getPlanLevelOrder(plan.level || "normal");
    if (maxReadRound > currentLevelOrder) {
      let newLevel = "normal";
      if (maxReadRound === 2) newLevel = "breakthrough";
      else if (maxReadRound === 3) newLevel = "super";
      else newLevel = "level" + maxReadRound;

      console.log(`[進度校正] 偵測到使用者已讀到第 ${maxReadRound} 遍，但計畫等級為 ${plan.level || "normal"}。自動修正等級為 ${newLevel}。`);
      plan.level = newLevel;
      plan.currentRound = maxReadRound;
      // 異步儲存到資料庫/localStorage，避免資料不一致
      if (typeof persistPlanLevelState === "function") {
        persistPlanLevelState(plan).catch(console.error);
      } else {
        if (!state.isSupabaseMode) localStorage.setItem("active_reading_plans", JSON.stringify(state.activePlans || []));
      }
    }

    if (!plan.days || !Array.isArray(plan.days) || plan.days.length === 0) {
      rebuildPlanScheduleForLevel(plan, plan.level || "normal");
    }
    if (!plan.days || !Array.isArray(plan.days)) return;

    const targetRounds = getPlanLevelRounds(plan.level || "normal");
    const hasMatchingRoundSchedule = plan.days.some(day => day && day.chapters && day.chapters.some(ch => (ch.round || 1) === targetRounds));
    if (!hasMatchingRoundSchedule && targetRounds > 1) {
      rebuildPlanScheduleForLevel(plan, plan.level || "normal");
    }
    if (!plan.days || !Array.isArray(plan.days)) return;

    // 💡 效能關鍵升級：建立 logSet 雜湊比對表 (O(1))，代替巨量迴圈重複比對
    const logSet = new Set();
    if (Array.isArray(state.readingLogs)) {
      for (let i = 0; i < state.readingLogs.length; i++) {
        const l = state.readingLogs[i];
        const r = l.round || 1;
        const b = l.book;
        const c = l.chapter;
        if (l.plan_id) logSet.add(`${l.plan_id}_${r}_${b}_${c}`);
        if (l.global_plan_id) logSet.add(`${l.global_plan_id}_${r}_${b}_${c}`);
        if (l.presetKey) logSet.add(`${l.presetKey}_${r}_${b}_${c}`);
        if (l.preset_key) logSet.add(`${l.preset_key}_${r}_${b}_${c}`);
        logSet.add(`*_${r}_${b}_${c}`);
      }
    }

    let completed = 0;
    plan.days.forEach(day => {
      if (!day || !Array.isArray(day.chapters)) return;
      day.chapters.forEach(ch => {
        const pId = plan.id || "";
        const pGlobalId = plan.globalPlanId || plan.global_plan_id || "";
        const pKey = plan.presetKey || plan.preset_key || "";

        const checkRoundLog = (rTarget) => {
          return (pId && logSet.has(`${pId}_${rTarget}_${ch.book}_${ch.chapter}`)) ||
                 (pGlobalId && logSet.has(`${pGlobalId}_${rTarget}_${ch.book}_${ch.chapter}`)) ||
                 (pKey && logSet.has(`${pKey}_${rTarget}_${ch.book}_${ch.chapter}`)) ||
                 logSet.has(`*_${rTarget}_${ch.book}_${ch.chapter}`);
        };

        const totalRounds = Math.max(plan.currentRound || 1, maxReadRound || 1, 3);
        for (let r = 1; r <= totalRounds; r++) {
          ch[`isReadR${r}`] = checkRoundLog(r);
        }

        const targetRound = ch.round || plan.currentRound || 1;
        const isRead = Boolean(ch["isReadR" + targetRound]);
        ch.isRead = isRead;
        if (isRead) completed++;
      });
    });
    plan.completedChapters = completed;
    const firstRoundTotalChapters = plan.days.reduce((sum, day) => {
      return sum + ((day.chapters || []).filter(ch => (ch.round || 1) === 1).length);
    }, 0) || plan.totalChapters;
    const firstRoundCompletedChapters = plan.days.reduce((sum, day) => {
      return sum + ((day.chapters || []).filter(ch => (ch.round || 1) === 1 && ch.isReadR1).length);
    }, 0);
    plan.firstRoundCompletedChapters = firstRoundCompletedChapters;
    plan.firstRoundTotalChapters = firstRoundTotalChapters;
    plan.isPlanCompleted = firstRoundTotalChapters > 0 && firstRoundCompletedChapters >= firstRoundTotalChapters;

    // Calculate current round progress dynamically
    const currentRoundTotal = plan.days.reduce((sum, day) => {
      return sum + ((day.chapters || []).filter(ch => (ch.round || 1) === plan.currentRound).length);
    }, 0) || plan.totalChapters;
    const currentRoundCompleted = plan.days.reduce((sum, day) => {
      const isCompleted = (ch) => {
        return Boolean(ch["isReadR" + plan.currentRound]);
      };
      return sum + ((day.chapters || []).filter(ch => (ch.round || 1) === plan.currentRound && isCompleted(ch)).length);
    }, 0);

    plan.currentRoundTotalChapters = currentRoundTotal;
    plan.completedChapters = currentRoundCompleted;

    const isCurrentRoundCompleted = currentRoundTotal > 0 && currentRoundCompleted >= currentRoundTotal;
    plan.progress = isCurrentRoundCompleted
      ? 100
      : (Math.round((currentRoundCompleted / currentRoundTotal) * 100) || 0);

    if (!plan.isPlanCompleted) plan.upgradePromptHandled = false;

    // Track second-round completion for the round-2 → round-3 upgrade prompt
    const secondRoundChapters = plan.days.reduce((sum, day) => {
      return sum + ((day.chapters || []).filter(ch => (ch.round || 1) === 2).length);
    }, 0);
    const secondRoundCompleted = plan.days.reduce((sum, day) => {
      return sum + ((day.chapters || []).filter(ch => (ch.round || 1) === 2 && ch.isReadR2).length);
    }, 0);
    plan.isRound2Completed = secondRoundChapters > 0 && secondRoundCompleted >= secondRoundChapters;
    if (!plan.isRound2Completed) plan.round2UpgradePromptHandled = false;

    // Clear downgrade lock in memory if the current round is completed
    if (isCurrentRoundCompleted) {
      plan.wasDowngraded = false;
      plan.downgradeLockedUntil = null;
    }
  });

  if (!state.isSupabaseMode) {
    localStorage.setItem("active_reading_plans", JSON.stringify(state.activePlans));
  }
}



function getPlanVisibilityKey(plan) {
  return plan ? String(plan.id || plan.presetKey || plan.globalPlanId || plan.name || '') : '';
}

function getHiddenPlanKeys() {
  try {
    return JSON.parse(localStorage.getItem('hidden_global_plan_keys') || '[]');
  } catch (e) {
    return [];
  }
}

function getPlanVisibilityOverrides() {
  try {
    const parsed = JSON.parse(localStorage.getItem("global_plan_visibility_overrides") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function getPlanVisibilityOverride(plan) {
  if (!plan || state.isSupabaseMode) return undefined;
  const overrides = getPlanVisibilityOverrides();
  const keys = [plan.id, plan.presetKey, plan.globalPlanId, plan.name].filter(Boolean).map(String);
  const matchedKey = keys.find(key => Object.prototype.hasOwnProperty.call(overrides, key));
  return matchedKey ? Boolean(overrides[matchedKey]) : undefined;
}

function isPlanHidden(plan) {
  if (!plan) return false;
  const localOverride = getPlanVisibilityOverride(plan);
  if (typeof localOverride === "boolean") return localOverride;
  const hiddenKeys = getHiddenPlanKeys();
  const keys = [plan.id, plan.presetKey, plan.globalPlanId, plan.name].filter(Boolean).map(String);
  return Boolean(plan.isHidden || plan.is_hidden || keys.some(key => hiddenKeys.includes(key)));
}

function isCampaignStageLocked(plan) {
  return Boolean(plan && plan.planKind === "church_campaign_stage" && isPlanHidden(plan));
}

function canManageHiddenPlans() {
  const role = (state.currentUser && getUserRoleCode(state.currentUser)) || 'member';

  return ['admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader'].includes(role);
}

function getVisiblePlans(plans) {
  const list = plans || [];
  if (canManageHiddenPlans()) return list;
  return list.filter(plan => !isPlanHidden(plan));
}

// ── Admin Nav Visibility ─────────────────────────────────────
// Defined here (in utils.js, which loads early) so db.init() and other
// early callers don't have to wait for profile.js to lazy-load.
function updateAdminNavVisibility() {
  const managementRoles = ['admin', 'pastor', 'great_zone_leader', 'zone_leader', 'group_leader'];
  const currentRole = (state.currentUser && getUserRoleCode(state.currentUser)) || 'member';

  const canManagePlans = managementRoles.includes(currentRole);

  const isSystemAdmin = currentRole === 'admin';


  document.querySelectorAll('.admin-only-nav').forEach(btn => {
    btn.classList.toggle('hidden', !canManagePlans);
  });

  document.querySelectorAll('.admin-only-plan-card').forEach(card => {
    card.classList.toggle('hidden', !isSystemAdmin);
  });
}

window.getPlanLevelRounds = getPlanLevelRounds;
window.getPlanLevelLabel = getPlanLevelLabel;
window.getPlanLevelOrder = getPlanLevelOrder;
window.addDaysIso = addDaysIso;
window.getDowngradeLockedUntil = getDowngradeLockedUntil;
window.isPlanUpgradeLocked = isPlanUpgradeLocked;
window.formatLockDate = formatLockDate;
window.persistPlanLevelState = persistPlanLevelState;
window.expandChaptersForLevel = expandChaptersForLevel;
window.distributeChaptersAcrossDays = distributeChaptersAcrossDays;
window.rebuildPlanScheduleForLevel = rebuildPlanScheduleForLevel;
window.generatePlanObject = generatePlanObject;
window.normalizePlanScheduleSettings = normalizePlanScheduleSettings;
window.calculatePlanProgress = calculatePlanProgress;
window.isPlanStarted = isPlanStarted;
window.isPlanExpired = isPlanExpired;
window.selectMostRecentActivePlan = selectMostRecentActivePlan;
window.calculateAllPlansProgress = calculateAllPlansProgress;
window.isPlanHidden = isPlanHidden;
window.isCampaignStageLocked = isCampaignStageLocked;
window.canManageHiddenPlans = canManageHiddenPlans;
window.getVisiblePlans = getVisiblePlans;
window.updateAdminNavVisibility = updateAdminNavVisibility;

window.openTtsGuideModal = function () {
  const modal = document.getElementById("tts-guide-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.style.display = "flex";
  }
};

window.closeTtsGuideModal = function () {
  const modal = document.getElementById("tts-guide-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.display = "none";
  }
};

/**
 * 🇹🇼 Taiwan Timezone (Asia/Taipei, UTC+8) Utility Functions
 */
export function toTaiwanISODate(dateInput) {
  if (!dateInput) return "";
  const date = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getTaiwanTodayISO(dateInput = new Date()) {
  return toTaiwanISODate(dateInput);
}

export function formatTaiwanDateTime(dateInput, options = {}) {
  if (!dateInput) return "";
  const date = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return String(dateInput);

  if (options.relative) {
    const now = new Date();
    const diffMs = now - date;
    const diffHours = diffMs / (1000 * 60 * 60);

    const dateTW = toTaiwanISODate(date);
    const todayTW = toTaiwanISODate(now);

    const timeParts = new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date).reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
    const timeStr = `${timeParts.hour}:${timeParts.minute}`;

    if (dateTW === todayTW) {
      if (diffHours < 1 && diffMs > 0) {
        const diffMins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
        return `🔥 ${diffMins} 分鐘前`;
      }
      return `🔥 今天 ${timeStr}`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (dateTW === toTaiwanISODate(yesterday)) {
      return `昨天 ${timeStr}`;
    }

    if (diffHours > 0 && diffHours < 24 * 7) {
      const daysAgo = Math.max(2, Math.floor(diffHours / 24));
      return `${daysAgo} 天前`;
    }
  }

  const fmtParts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: options.includeSeconds ? "2-digit" : undefined,
    hour12: false
  }).formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  let result = `${fmtParts.year}-${fmtParts.month}-${fmtParts.day} ${fmtParts.hour}:${fmtParts.minute}`;
  if (options.includeSeconds && fmtParts.second) {
    result += `:${fmtParts.second}`;
  }
  return result;
}

export function toTaiwanISOString(dateInput = new Date()) {
  const date = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

window.toTaiwanISODate = toTaiwanISODate;
window.getTaiwanTodayISO = getTaiwanTodayISO;
window.formatTaiwanDateTime = formatTaiwanDateTime;
window.toTaiwanISOString = toTaiwanISOString;

// Unconditional Global TTS Voice Package Guide Modal Handlers
export function openTtsGuideModal() {
  const modal = document.getElementById("tts-guide-modal");
  if (!modal) return false;
  if (typeof document !== "undefined" && document.body && modal.parentElement !== document.body) {
    document.body.appendChild(modal);
  }
  modal.classList.remove("hidden");
  modal.style.cssText = "display: flex !important; opacity: 1 !important; pointer-events: auto !important; visibility: visible !important; z-index: 100000 !important;";
  modal.setAttribute("aria-hidden", "false");
  return true;
}

export function closeTtsGuideModal() {
  const modal = document.getElementById("tts-guide-modal");
  if (!modal) return false;
  modal.classList.add("hidden");
  modal.style.cssText = "display: none !important; opacity: 0 !important; pointer-events: none !important; visibility: hidden !important;";
  modal.setAttribute("aria-hidden", "true");
  return true;
}

window.openTtsGuideModal = openTtsGuideModal;
window.closeTtsGuideModal = closeTtsGuideModal;

if (typeof document !== "undefined") {
  document.addEventListener("click", function (e) {
    const btn = e.target && e.target.closest ? e.target.closest("#btn-show-tts-guide, [data-action='open-tts-guide'], [data-open-tts-guide]") : null;
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      openTtsGuideModal();
    }
    const closeBtn = e.target && e.target.closest ? e.target.closest("#btn-close-tts-guide, #btn-confirm-tts-guide, [data-action='close-tts-guide'], [data-close-tts-guide]") : null;
    if (closeBtn) {
      e.preventDefault();
      e.stopPropagation();
      closeTtsGuideModal();
    }
  });
}

export function openTypographySheet() {
  const backdrop = document.getElementById("typography-settings-backdrop");
  if (!backdrop) return false;
  backdrop.classList.remove("hidden");
  backdrop.style.removeProperty("display");
  backdrop.style.removeProperty("opacity");
  backdrop.style.pointerEvents = "auto";
  backdrop.style.visibility = "visible";
  backdrop.setAttribute("aria-hidden", "false");
  document.body.classList.add("reader-modal-open");

  if (typeof window.initSpeechPreferencesControls === "function") {
    window.initSpeechPreferencesControls();
  }
  return true;
}

window.openTypographySheet = openTypographySheet;

let previewSessionId = 0;

export function initSpeechPreferencesControls() {
  const rateSlider = document.getElementById("speech-rate-slider");
  const rateLabel = document.getElementById("speech-rate-val");
  const voiceSelect = document.getElementById("speech-voice-select");
  const btnPreviewSpeech = document.getElementById("btn-preview-speech");

  if (!rateSlider && !voiceSelect && !btnPreviewSpeech) return;

  if (typeof state !== "undefined") {
    state.speechSettings = state.speechSettings || {
      rate: 1.0,
      gender: "auto",
      voiceURI: ""
    };
  }

  const getSpeechSetting = (key, fallback) => {
    return (typeof state !== "undefined" && state.speechSettings && state.speechSettings[key] !== undefined)
      ? state.speechSettings[key]
      : fallback;
  };

  const setSpeechSetting = (key, value) => {
    if (typeof state !== "undefined") {
      state.speechSettings = state.speechSettings || { rate: 1.0, gender: "auto", voiceURI: "" };
      state.speechSettings[key] = value;
    }
    saveSpeechSettings();
  };

  function saveSpeechSettings() {
    try {
      if (typeof state !== "undefined" && state.speechSettings) {
        localStorage.setItem("nlc_speech_settings", JSON.stringify(state.speechSettings));
      }
    } catch (_e) {}
  }

  function updateRateLabel(val) {
    if (!rateLabel) return;
    const num = parseFloat(val);
    let desc = "標準";
    if (num < 0.85) desc = "沉靜慢速";
    else if (num > 1.35) desc = "疾速";
    else if (num > 1.1) desc = "流暢快速";
    rateLabel.textContent = `${num.toFixed(2)}x (${desc})`;
  }

  // 1. Rate Slider
  if (rateSlider && rateLabel) {
    rateSlider.value = getSpeechSetting("rate", 1.0);
    updateRateLabel(rateSlider.value);
    if (!rateSlider.dataset.bound) {
      rateSlider.dataset.bound = "true";
      rateSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        setSpeechSetting("rate", val);
        updateRateLabel(val);
      });
    }
  }

  // 2. Populate Voices
  function populateVoices(autoPreviewAfterPopulate = false) {
    if (!voiceSelect || typeof window.speechSynthesis === "undefined") return;
    const voices = window.speechSynthesis.getVoices() || [];
    
    // Strict Chinese Language Filter: zh / Chinese, no English
    const chineseVoices = voices.filter(v => {
      const lang = String(v.lang || "").toLowerCase();
      const name = String(v.name || "").toLowerCase();
      if (lang.startsWith("en") || /english|uk english|us english|united states|united kingdom/.test(name)) {
        return false;
      }
      return lang.startsWith("zh") || lang.includes("hant") || lang.includes("cmn") || name.includes("國語") || name.includes("中文") || name.includes("taiwan");
    });

    const currentURI = getSpeechSetting("voiceURI", "");

    const isFemaleVoice = (v) => {
      const name = String(v.name || "").toLowerCase();
      return /female|hsiaochen|hsiao-chen|mei-jia|meijia|ting-ting|tingting|sin-ji|sinji|yating|hanhan|szuchin|xiaoxiao|xiaoyi/.test(name);
    };

    const isMaleVoice = (v) => {
      const name = String(v.name || "").toLowerCase();
      return /yunjhe|yun-jhe|yun-lin|yunlin|yunfeng|yunhao|kangkang|male/.test(name);
    };

    // Show every installed Chinese-family voice (Mandarin AND Cantonese) so
    // users who installed extra voice packs actually see them in the list —
    // this used to be narrowed down to only a Google-branded or OS-"default"
    // voice (falling back to just chineseVoices[0] otherwise), which is why
    // the picker could show a single Cantonese option even with a Taiwan
    // Mandarin pack installed: the other voices were filtered out of the
    // list entirely, not merely deprioritized.
    const filteredVoices = chineseVoices;

    const formatVoiceLabel = (v) => {
      const name = String(v.name || "");
      const lower = name.toLowerCase();
      if (lower.includes("mei-jia") || lower.includes("meijia")) return "美佳 (台灣女聲)";
      if (lower.includes("hsiaochen") || lower.includes("hsiao-chen")) return "曉臻 (台灣女聲)";
      if (lower.includes("ting-ting") || lower.includes("tingting")) return "婷婷 (台灣女聲)";
      if (lower.includes("sin-ji") || lower.includes("sinji")) return "心怡 (台灣女聲)";
      if (lower.includes("yating")) return "雅婷 (台灣女聲)";
      if (lower.includes("hanhan")) return "涵涵 (台灣女聲)";
      if (lower.includes("yunjhe") || lower.includes("yun-jhe")) return "允哲 (台灣男聲)";
      if (lower.includes("yun-lin") || lower.includes("yunlin")) return "雲林 (台灣男聲)";
      if (lower.includes("google") && (lower.includes("國語") || lower.includes("taiwan") || lower.includes("zh-tw"))) return "Google 國語 (台灣)";

      // Region tag comes from the voice's own lang — must not hardcode
      // "(台灣)" onto every voice, or a Cantonese/Hong Kong voice ends up
      // mislabeled as Taiwanese (e.g. "粵語 香港(台灣)").
      const lang = String(v.lang || "").toLowerCase();
      let region = "";
      if (lang === "zh-hk" || lang === "yue-hk" || /cantonese|hong ?kong/i.test(name)) region = "香港";
      else if (lang === "zh-tw" || lang.includes("hant") || /taiwan/i.test(name)) region = "台灣";
      else if (lang === "zh-cn" || lang === "zh-hans" || lang === "zh-sg") region = "中國";
      const genderTag = isFemaleVoice(v) ? "女聲" : (isMaleVoice(v) ? "男聲" : "");
      const tag = [region, genderTag].filter(Boolean).join("");
      return tag ? `${name} (${tag})` : name;
    };

    voiceSelect.innerHTML = "";
    if (filteredVoices.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "找不到可用的中文語音，請確認手機已安裝中文語音包";
      voiceSelect.appendChild(opt);
      return;
    }

    // An explicit past choice wins if it's still installed; otherwise defer
    // to the app's shared voice-quality scoring (selectPreferredChineseVoice
    // — Mandarin/Taiwan preferred, Natural/Neural boosted, Cantonese treated
    // as a last resort) instead of picking whatever the OS happened to list
    // first or flag as "default".
    let preselected = currentURI
      ? filteredVoices.find(v => v.voiceURI === currentURI || v.name === currentURI)
      : null;
    if (!preselected && typeof window.selectPreferredChineseVoice === "function") {
      preselected = window.selectPreferredChineseVoice(filteredVoices);
    }
    if (!preselected) preselected = filteredVoices[0];

    filteredVoices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.voiceURI || v.name;
      opt.textContent = formatVoiceLabel(v);
      opt.selected = v === preselected;
      voiceSelect.appendChild(opt);
    });

    voiceSelect.value = preselected.voiceURI || preselected.name;
    setSpeechSetting("voiceURI", voiceSelect.value);

    if (autoPreviewAfterPopulate) {
      playPreviewSpeech();
    }
  }

  if (typeof window.speechSynthesis !== "undefined") {
    populateVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = () => populateVoices();
    }
  }

  if (voiceSelect && !voiceSelect.dataset.bound) {
    voiceSelect.dataset.bound = "true";
    voiceSelect.addEventListener("change", (e) => {
      setSpeechSetting("voiceURI", e.target.value);
      playPreviewSpeech();
    });
  }

  // 3. Preview Button Toggle
  let isPreviewSpeaking = false;

  if (btnPreviewSpeech && !btnPreviewSpeech.dataset.bound) {
    btnPreviewSpeech.dataset.bound = "true";
    btnPreviewSpeech.addEventListener("click", () => {
      if (isPreviewSpeaking || (window.speechSynthesis && window.speechSynthesis.speaking)) {
        stopPreviewSpeech();
      } else {
        playPreviewSpeech();
      }
    });
  }

  function stopPreviewSpeech() {
    previewSessionId++;
    if (typeof window.speechSynthesis !== "undefined") {
      try { window.speechSynthesis.cancel(); } catch (_e) {}
    }
    isPreviewSpeaking = false;
    updatePreviewBtnUI(false);
  }

  function updatePreviewBtnUI(speaking) {
    if (!btnPreviewSpeech) return;
    const btnIcon = document.getElementById("btn-preview-icon");
    const accessibleLabel = speaking ? "暫停試聽" : "播放試聽語音";

    if (speaking) {
      if (btnIcon) btnIcon.setAttribute("data-icon", "pause");
      btnPreviewSpeech.classList.add("shadcn-speech-btn--playing");
    } else {
      if (btnIcon) btnIcon.setAttribute("data-icon", "volume2");
      btnPreviewSpeech.classList.remove("shadcn-speech-btn--playing");
    }
    btnPreviewSpeech.setAttribute("aria-label", accessibleLabel);
    btnPreviewSpeech.setAttribute("title", accessibleLabel);
    if (btnIcon) btnIcon.replaceChildren();
    if (typeof window.hydrateIcons === "function") {
      window.hydrateIcons(btnPreviewSpeech);
    }
  }

  function playPreviewSpeech() {
    if (typeof window.speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
      if (typeof showToast === "function") showToast("您的瀏覽器不支援語音播放", "warning");
      return;
    }

    stopPreviewSpeech();
    const currentSession = ++previewSessionId;

    const text = "神愛世人，甚至將祂的獨生子賜給他們，叫一切信祂的不致滅亡，反得永生。";
    const utterance = new SpeechSynthesisUtterance(text);

    const voices = window.speechSynthesis.getVoices() || [];
    const selectedURI = getSpeechSetting("voiceURI", "");

    let targetVoice = null;
    if (selectedURI) {
      targetVoice = voices.find(v => v.voiceURI === selectedURI || v.name === selectedURI);
    }
    if (!targetVoice && typeof window.selectPreferredChineseVoice === "function") {
      targetVoice = window.selectPreferredChineseVoice(voices);
    }
    if (targetVoice) {
      utterance.voice = targetVoice;
      utterance.lang = targetVoice.lang || "zh-TW";
    } else {
      utterance.lang = "zh-TW";
    }

    utterance.rate = getSpeechSetting("rate", 1.0);

    utterance.pitch = 1.0;

    utterance.onstart = () => {
      if (currentSession !== previewSessionId) return;
      isPreviewSpeaking = true;
      updatePreviewBtnUI(true);
    };

    utterance.onend = () => {
      if (currentSession !== previewSessionId) return;
      isPreviewSpeaking = false;
      updatePreviewBtnUI(false);
    };

    utterance.onerror = () => {
      if (currentSession !== previewSessionId) return;
      isPreviewSpeaking = false;
      updatePreviewBtnUI(false);
    };

    window.speechSynthesis.speak(utterance);
    if (typeof showToast === "function") showToast(`正在試聽：${targetVoice ? targetVoice.name : "Google 國語 (台灣)"}`, "info");
  }
}

window.__initSpeechPreferencesControlsImpl = initSpeechPreferencesControls;
window.initSpeechPreferencesControls = initSpeechPreferencesControls;

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initSpeechPreferencesControls());
  } else {
    initSpeechPreferencesControls();
  }
}



