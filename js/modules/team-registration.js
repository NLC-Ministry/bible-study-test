import { getMemberOverallPlanProgress, getTeamOverallPlanProgress } from "./team-progress-metrics.mjs";
import { isCampaignStageKind } from "../data/campaign-stage-kinds.mjs";

// Independent 3-person / 6-person competition team registration.
// Organisation small-group and pastoral-zone scopes are deliberately not used here.
(function () {
  const getPlanId = plan => {
    if (!plan) return "";
    if (plan.globalPlanId && /^[0-9a-f-]{36}$/i.test(plan.globalPlanId)) {
      return String(plan.globalPlanId);
    }
    const linked = (state.globalPlans || []).find(item =>
      item.id === plan.globalPlanId || item.presetKey === plan.presetKey || item.name === plan.name
    );
    if (linked) {
      const idVal = linked.globalPlanId || linked.id;
      if (idVal && /^[0-9a-f-]{36}$/i.test(idVal)) return String(idVal);
    }
    if (plan.presetKey && typeof CHURCH_PLAN_PRESETS !== "undefined" && CHURCH_PLAN_PRESETS[plan.presetKey]) {
      const preset = CHURCH_PLAN_PRESETS[plan.presetKey];
      if (preset.id && /^[0-9a-f-]{36}$/i.test(preset.id)) return String(preset.id);
    }
    let stageNo = plan.stageNo;
    if (!stageNo && plan.presetKey) {
      const m = plan.presetKey.match(/\d+/);
      if (m) stageNo = Number(m[0]);
    }
    if (!stageNo && plan.name) {
      if (plan.name.includes("第一輪") || plan.name.includes("第1階段") || plan.name.includes("第一階段")) stageNo = 1;
      else if (plan.name.includes("第二輪") || plan.name.includes("第2階段") || plan.name.includes("第二階段")) stageNo = 2;
    }
    if (stageNo) {
      return "00000000-0000-0000-c026-" + String(Number(stageNo) || 0).padStart(12, "0");
    }
    return String(plan.id || "");
  };

  const isSupportedPlan = plan => {
    if (!plan) return false;
    if (!/^[0-9a-f-]{36}$/i.test(getPlanId(plan))) return false;
    // 主判斷：正式階段 or 大區延後梯次（唯一定義在 data/campaign-stage-kinds.mjs）。
    if (isCampaignStageKind(plan)) return true;
    // planKind 遺失時的保底辨識（church_stage_cohort_NN 也吃 church_stage_ 前綴）。
    const key = String(plan.presetKey || "");
    if (key.startsWith("church_stage_") || key.startsWith("preset-stage-")) return true;
    const name = String(plan.name || "");
    return name.includes("熱身賽") || name.includes("第一輪") || name.includes("第二輪");
  };
  const getTeamContexts = context => {
    if (Array.isArray(context && context.teams)) {
      return context.teams
        .filter(item => item && item.team)
        .sort((left, right) => Number(left.team.division) - Number(right.team.division));
    }
    return context && context.team ? [context] : [];
  };

  function removeOverlay(overlay) {
    overlay?.remove();
    if (!document.querySelector(".reading-team-overlay")) {
      document.body.classList.remove("reading-team-modal-open");
    }
  }

  function createOverlay(id, labelledBy) {
    removeOverlay(document.getElementById(id));
    const overlay = document.createElement("div");
    overlay.id = id;
    overlay.className = "modal-overlay reading-team-overlay";
    // Critical positioning is inline so a stale optional stylesheet can never place the dialog inside page flow.
    overlay.style.cssText = "position:fixed;inset:0;display:flex;z-index:var(--z-modal,700);";
    overlay.innerHTML = `<section class="reading-team-dialog glass-card" role="dialog" aria-modal="true" aria-labelledby="${labelledBy}"></section>`;
    document.body.classList.add("reading-team-modal-open");
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeOnBackdrop(overlay, close) {
    overlay.addEventListener("click", event => {
      if (event.target === overlay) close();
    });
  }

  function hydrate(root) {
    if (typeof hydrateIcons === "function") hydrateIcons(root);
  }

  window.offerReadingTeamParticipation = function offerReadingTeamParticipation(plan) {
    if (!isSupportedPlan(plan)) return Promise.resolve(null);
    return new Promise(resolve => {
      const overlay = createOverlay("reading-team-choice-dialog", "reading-team-choice-title");
      const panel = overlay.firstElementChild;
      panel.classList.add("reading-team-dialog--choice");
      panel.setAttribute("aria-describedby", "reading-team-choice-description");
      panel.innerHTML = `
        <header class="reading-team-dialog__header">
          <div><p class="reading-team-eyebrow">${escapeHTML(plan.name || "教會讀經計畫")}</p><h3 id="reading-team-choice-title">和夥伴一起讀嗎？</h3></div>
          <button type="button" class="reading-team-close dialog-close-button icon-button icon-button--subtle" data-team-close aria-label="關閉"><span class="nlc-icon nlc-icon--sm" data-icon="close" aria-hidden="true"></span></button>
        </header>
        <p class="reading-team-dialog__intro" id="reading-team-choice-description">計畫已加入。你的章節進度只需勾選一次；加入團隊後，系統會直接以這份個人進度計算共同完成狀況。</p>
        <div class="reading-team-choice-grid">
          <button type="button" class="reading-team-choice" data-team-skip>
            <span class="reading-team-choice__icon"><span class="nlc-icon nlc-icon--md" data-icon="user" aria-hidden="true"></span></span>
            <span class="reading-team-choice__body"><strong>先自己開始</strong><span class="reading-team-choice__description">之後可從計畫選單加入團隊</span></span><span class="reading-team-choice__arrow"><span class="nlc-icon nlc-icon--sm" data-icon="chevronRight" aria-hidden="true"></span></span>
          </button>
          <button type="button" class="reading-team-choice" data-team-division="3">
            <span class="reading-team-choice__icon"><span class="nlc-icon nlc-icon--md" data-icon="people" aria-hidden="true"></span></span>
            <span class="reading-team-choice__body"><strong>參加 3 人團隊</strong><span class="reading-team-choice__description">固定三人，滿員後完成組隊</span></span><span class="reading-team-choice__arrow"><span class="nlc-icon nlc-icon--sm" data-icon="chevronRight" aria-hidden="true"></span></span>
          </button>
          <button type="button" class="reading-team-choice" data-team-division="6">
            <span class="reading-team-choice__icon"><span class="nlc-icon nlc-icon--md" data-icon="people" aria-hidden="true"></span></span>
            <span class="reading-team-choice__body"><strong>參加 6 人團隊</strong><span class="reading-team-choice__description">固定六人，滿員後完成組隊</span></span><span class="reading-team-choice__arrow"><span class="nlc-icon nlc-icon--sm" data-icon="chevronRight" aria-hidden="true"></span></span>
          </button>
        </div>`;
      const finish = value => { removeOverlay(overlay); resolve(value); };
      panel.querySelector("[data-team-close]").onclick = () => finish(null);
      panel.querySelector("[data-team-skip]").onclick = () => finish(null);
      panel.querySelectorAll("[data-team-division]").forEach(button => {
        button.onclick = () => finish(Number(button.dataset.teamDivision));
      });
      closeOnBackdrop(overlay, () => finish(null));
      hydrate(overlay);
      panel.querySelector("[data-team-skip]")?.focus();
    });
  };

  function formatLastRead(value) {
    if (!value) return "尚未開始";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "尚未開始";
    return new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(date);
  }

  function getMemberProgress(member, totalChapters) {
    const metrics = getMemberOverallPlanProgress(member, totalChapters);
    return {
      read: metrics.currentRoundRead,
      completedRead: metrics.completedChapters,
      journeyChapters: metrics.journeyChapters,
      progress: metrics.progress
    };
  }

  function renderMember(member, totalChapters, plan, options = {}) {
    const { read, progress } = getMemberProgress(member, totalChapters);
    const canRemind = Boolean(member.userId && !member.isMe);
    const canRemove = Boolean(options.canRemoveMembers && member.userId && !member.isMe && member.role !== "captain");
    const canTransferCaptain = Boolean(options.canTransferCaptain && member.userId && !member.isMe && member.role !== "captain");

    let isBehind = false;
    if (plan && Number(member.currentRound || 1) === 1) {
      const expectedChapters = getExpectedChapters(plan, totalChapters);
      isBehind = Number(member.chaptersRead || 0) < expectedChapters;
    }

    const memberLabel = String(member.name || "").trim() || "—";
    const memberActions = [
      canRemind ? `<button type="button" class="reading-team-remind-btn icon-button" data-team-remind-user="${escapeHTML(member.userId)}" aria-label="戳一下 ${escapeHTML(memberLabel)}提醒讀經" title="戳一下提醒讀經"><span class="nlc-icon nlc-icon--sm" data-icon="poke" aria-hidden="true"></span><span class="reading-team-remind-btn__label">戳一下</span></button>` : "",
      canTransferCaptain ? `<button type="button" class="reading-team-transfer-captain-btn icon-button" data-team-transfer-captain-user="${escapeHTML(member.userId)}" aria-label="將隊長轉移給 ${escapeHTML(memberLabel)}" title="設為隊長"><span class="nlc-icon nlc-icon--sm" data-icon="crown" aria-hidden="true"></span></button>` : "",
      canRemove ? `<button type="button" class="reading-team-remove-btn icon-button" data-team-remove-user="${escapeHTML(member.userId)}" aria-label="將 ${escapeHTML(memberLabel)} 移出團隊" title="移出團隊"><span class="nlc-icon nlc-icon--sm" data-icon="logout" aria-hidden="true"></span></button>` : ""
    ].join("");
    return `<article class="reading-team-member${member.isMe ? " reading-team-member--me" : ""}${isBehind ? " reading-team-member--behind" : ""}">
      <div class="reading-team-member__avatar">${escapeHTML(memberLabel.slice(0, 1))}</div>
      <div class="reading-team-member__body">
        <div class="reading-team-member__title"><strong>${escapeHTML(memberLabel)}</strong>${member.role === "captain" ? '<span class="stat-badge stat-badge--brand">隊長</span>' : ""}${member.isMe ? '<span class="reading-team-me">你</span>' : ""}</div>
        <div class="reading-team-member__meta"><span>${member.hasJoinedPlan ? `第 ${Number(member.currentRound || 1)} 遍・${read} 章` : "尚未加入本計畫"}</span><span>最後閱讀：${escapeHTML(formatLastRead(member.lastReadAt))}</span></div>
        <div class="reading-team-progress" role="progressbar" aria-label="${escapeHTML(memberLabel)}進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div>
      </div>
      <strong class="reading-team-member__percent">${progress}%</strong>
      ${memberActions ? `<div class="reading-team-member__actions">${memberActions}</div>` : ""}
    </article>`;
  }
  function bindTeamReminderButtons(container, team, members, totalChapters) {
    if (!container || !team) return;
    container.querySelectorAll("[data-team-remind-user]").forEach(button => {
      button.addEventListener("click", () => {
        const member = members.find(item => String(item.userId) === String(button.dataset.teamRemindUser));
        if (!member || typeof window.openCareReminderDialog !== "function") return;
        const { read, progress } = getMemberProgress(member, totalChapters);
        window.openCareReminderDialog({
          ...member,
          id: member.userId,
          completed: read,
          statusStr: progress >= 100 ? "已完成本遍" : progress > 0 ? `已完成 ${progress}%` : "尚未開始",
          statusColor: progress >= 100 ? "var(--color-success-foreground)" : progress > 0 ? "var(--color-brand)" : "var(--text-muted)",
          isBehind: progress > 0 && progress < 100,
          isNotStarted: progress === 0,
          readingTeamId: team.id,
          readingTeamPlanId: team.globalPlanId
        });
      });
    });
  }

  function bindTeamMemberRemovalButtons(container, team, members, onRemoved) {
    if (!container || !team) return;
    container.querySelectorAll("[data-team-remove-user]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const member = members.find(item => String(item.userId) === String(button.dataset.teamRemoveUser));
        if (!member) return;
        const memberName = String(member.name || "").trim() || "這位隊員";
        const confirmed = await window.showConfirmDialog({
          title: "將隊員移出團隊？",
          message: `確定要將「${memberName}」移出團隊嗎？移出後會空出一個名額。`,
          confirmText: "移出隊員",
          cancelText: "取消",
          isDestructive: true
        });
        if (!confirmed) return;

        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        let result;
        try {
          result = await db.removeReadingTeamMember(team.id, member.userId);
        } catch (error) {
          result = { success: false, error, message: error && error.message };
        } finally {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }

        if (!result || !result.success) {
          showToast("移除隊員失敗：" + ((result && (result.message || result.error && result.error.message)) || "未知錯誤"));
          return;
        }
        showToast(`已將 ${memberName} 移出團隊`);
        if (typeof onRemoved === "function") await onRemoved();
      });
    });
  }

  function bindTeamCaptainTransferButtons(container, team, members, onTransferred) {
    if (!container || !team) return;
    container.querySelectorAll("[data-team-transfer-captain-user]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const member = members.find(item => String(item.userId) === String(button.dataset.teamTransferCaptainUser));
        if (!member) return;
        const memberName = String(member.name || "").trim() || "這位隊員";
        const confirmed = await window.showConfirmDialog({
          title: "轉移隊長？",
          message: `確定要將隊長轉移給「${memberName}」嗎？轉移後你會成為一般隊員，只有新隊長能管理名單與再次轉移隊長。`,
          confirmText: "確認轉移",
          cancelText: "取消"
        });
        if (!confirmed) return;

        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        let result;
        try {
          result = await db.transferReadingTeamCaptain(team.id, member.userId);
        } catch (error) {
          result = { success: false, error, message: error && error.message };
        } finally {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }

        if (!result || !result.success) {
          showToast("轉移隊長失敗：" + ((result && (result.message || result.error && result.error.message)) || "未知錯誤"), "error");
          return;
        }
        showToast(`已將隊長轉移給 ${memberName}`, "success");
        if (typeof onTransferred === "function") await onTransferred();
      });
    });
  }
  function getExpectedChapters(plan, totalChapters) {
    const days = Array.isArray(plan && plan.days) ? plan.days : [];
    const start = new Date(`${plan && plan.startDate || ""}T00:00:00`);
    if (!days.length || Number.isNaN(start.getTime())) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const elapsedDays = Math.max(0, Math.min(days.length, Math.floor((today - start) / 86400000) + 1));
    return Math.min(totalChapters, days.slice(0, elapsedDays)
      .reduce((sum, day) => sum + (Array.isArray(day.chapters) ? day.chapters.length : 0), 0));
  }

  function toLocalDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getTeamMemberRosterMetrics(member, plan) {
    const days = Array.isArray(plan && plan.days) ? plan.days : [];
    const logs = Array.isArray(member.readingLogs) ? member.readingLogs : [];
    const roundOneLogs = logs.filter(log => Number(log.round || 1) === 1);
    const currentRound = Number(member.currentRound || 1);
    const start = new Date(`${plan && plan.startDate || ""}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expectedDays = Number.isNaN(start.getTime())
      ? 0
      : Math.max(0, Math.min(days.length, Math.floor((today - start) / 86400000) + 1));

    const completedDetails = days.map((day, index) => {
      const chapters = Array.isArray(day.chapters) ? day.chapters : [];
      if (!chapters.length) return null;
      const matchedLogs = chapters.map(chapter => roundOneLogs.find(log =>
        String(log.book) === String(chapter.book) && Number(log.chapter) === Number(chapter.chapter)
      ));
      if (matchedLogs.some(log => !log)) return null;
      const scheduled = new Date(start);
      scheduled.setDate(start.getDate() + index);
      const latestRead = matchedLogs.reduce((latest, log) => {
        const key = toLocalDateKey(log.readAt);
        return key > latest ? key : latest;
      }, "");
      return { scheduled: toLocalDateKey(scheduled), latestRead };
    }).filter(Boolean);

    const readingDayCount = days.filter(day => Array.isArray(day.chapters) && day.chapters.length > 0).length;
    const completedDays = currentRound > 1 ? readingDayCount : completedDetails.length;
    const completed = Number(member.chaptersRead || 0);
    const makeup = completedDetails.filter(item => item.latestRead > item.scheduled).length;
    const diff = completedDays - expectedDays;
    const currentProgress = Number(member.chaptersRead || 0);
    let statusStr = "未開始";
    let statusClass = "reading-team-status--muted";

    if (member.hasJoinedPlan && currentRound > 1) {
      statusStr = `超前第${currentRound}遍`;
      statusClass = "reading-team-status--ahead";
    } else if (member.hasJoinedPlan && currentProgress > 0 && diff > 0) {
      statusStr = `超前 ${diff} 天`;
      statusClass = "reading-team-status--ahead";
    } else if (member.hasJoinedPlan && currentProgress > 0 && diff < 0) {
      statusStr = diff === -1 ? "今日未完成" : `落後 ${Math.abs(diff)} 天`;
      statusClass = "reading-team-status--behind";
    } else if (member.hasJoinedPlan && currentProgress > 0) {
      statusStr = "在進度上";
      statusClass = "reading-team-status--current";
    }

    return {
      streak: Number(member.longestStreak || 0),
      completed,
      makeup,
      statusStr,
      statusClass
    };
  }

  function renderTeamMemberRoster(members, plan, options = {}) {
    const rows = members.map(member => ({ member, metrics: getTeamMemberRosterMetrics(member, plan) }))
      .sort((left, right) => right.metrics.completed - left.metrics.completed || right.metrics.streak - left.metrics.streak);
    return `<div class="reading-team-roster-scroll">
      <div class="reading-team-roster">
        <div class="reading-team-roster__head" aria-hidden="true">
          <span>成員</span><span>最高連續</span><span>累計完成</span><span>補讀</span><span>進度狀態</span><span>操作</span>
        </div>
        ${rows.map(({ member, metrics }) => {
          const canRemove = Boolean(options.canRemoveMembers && member.userId && !member.isMe && member.role !== "captain");
          const canTransferCaptain = Boolean(options.canTransferCaptain && member.userId && !member.isMe && member.role !== "captain");
          const actions = [
            member.isMe ? "" : `<button type="button" class="reading-team-remind-btn icon-button" data-team-remind-user="${escapeHTML(member.userId)}" aria-label="戳一下 ${escapeHTML(member.name || "隊員")}提醒讀經" title="戳一下提醒讀經"><span class="nlc-icon nlc-icon--sm" data-icon="poke" aria-hidden="true"></span><span class="reading-team-remind-btn__label">戳一下</span></button>`,
            canTransferCaptain ? `<button type="button" class="reading-team-transfer-captain-btn icon-button" data-team-transfer-captain-user="${escapeHTML(member.userId)}" aria-label="將隊長轉移給 ${escapeHTML(member.name || "隊員")}" title="設為隊長"><span class="nlc-icon nlc-icon--sm" data-icon="crown" aria-hidden="true"></span></button>` : "",
            canRemove ? `<button type="button" class="reading-team-remove-btn icon-button" data-team-remove-user="${escapeHTML(member.userId)}" aria-label="將 ${escapeHTML(member.name || "隊員")} 移出團隊" title="移出團隊"><span class="nlc-icon nlc-icon--sm" data-icon="logout" aria-hidden="true"></span></button>` : ""
          ].join("");
          return `<article class="reading-team-roster__row${member.isMe ? " reading-team-roster__row--me" : ""}${metrics.statusClass === "reading-team-status--behind" ? " reading-team-roster__row--behind" : ""}">
            <div class="reading-team-roster__person"><strong>${escapeHTML(String(member.name || "").trim() || "—")}</strong>${member.role === "captain" ? '<span class="stat-badge stat-badge--brand">隊長</span>' : ""}${member.isMe ? '<span class="reading-team-me">你</span>' : ""}</div>
            <strong class="reading-team-roster__streak">${metrics.streak}</strong>
            <strong class="reading-team-roster__completed">${metrics.completed}</strong>
            <strong class="reading-team-roster__makeup">${metrics.makeup}</strong>
            <span class="reading-team-roster__status ${metrics.statusClass}">${metrics.statusStr}</span>
            ${actions ? `<div class="reading-team-roster__actions">${actions}</div>` : '<span class="reading-team-roster__self">—</span>'}
          </article>`;
        }).join("")}
      </div>
    </div>`;
  }
  function renderTeamStatGrid(members, totalChapters, plan) {
    const { completedChapters: totalRead } = getTeamOverallPlanProgress(members, totalChapters);
    const activeToday = members.filter(member => Number(member.todayRead || 0) > 0).length;
    const expectedChapters = getExpectedChapters(plan, totalChapters);
    const behindCount = members.filter(member => Number(member.currentRound || 1) === 1 && Number(member.chaptersRead || 0) < expectedChapters).length;
    const rereadCount = members.filter(member => Number(member.currentRound || 1) > 1).length;

    return `<div class="reading-team-stat-grid" aria-label="團隊讀經統計">
      <article class="reading-team-stat-card"><span>總閱讀章數</span><strong>${totalRead}<small>章</small></strong><span class="nlc-icon" data-icon="bookOpen" aria-hidden="true"></span></article>
      <article class="reading-team-stat-card"><span>今日活躍</span><strong>${activeToday}<small>人</small></strong><span class="nlc-icon" data-icon="lightning" aria-hidden="true"></span></article>
      <article class="reading-team-stat-card"><span>進度落後</span><strong>${behindCount}<small>人</small></strong><span class="nlc-icon" data-icon="hourglass" aria-hidden="true"></span></article>
      <article class="reading-team-stat-card"><span>進入複讀</span><strong>${rereadCount}<small>人</small></strong><span class="nlc-icon" data-icon="refresh" aria-hidden="true"></span></article>
    </div>`;
  }

  window.openReadingTeamDialog = async function openReadingTeamDialog(plan, options = {}) {
    if (!isSupportedPlan(plan)) {
      showToast("此計畫不使用競賽團隊報名。");
      return null;
    }
    const overlay = createOverlay("reading-team-dialog", "reading-team-dialog-title");
    const panel = overlay.firstElementChild;
    let preferredDivision = [3, 6].includes(Number(options.preferredDivision)) ? Number(options.preferredDivision) : 3;
    let returnDivision = null;
    let closed = false;

    const close = () => { closed = true; removeOverlay(overlay); };
    closeOnBackdrop(overlay, close);

    const renderLoading = () => {
      panel.innerHTML = `<div class="reading-team-loading"><span class="nlc-icon nlc-icon--md" data-icon="people" aria-hidden="true"></span><span>正在載入我的團隊…</span></div>`;
      hydrate(panel);
    };

    const renderEmpty = (joinedContexts = []) => {
      const joinedDivisions = new Set(joinedContexts.map(context => Number(context.team.division)));
      const availableDivisions = [3, 6].filter(division => !joinedDivisions.has(division));
      if (!availableDivisions.includes(preferredDivision)) preferredDivision = availableDivisions[0] || 3;
      const divisionChoices = availableDivisions.map(division => {
        const isSelected = division === preferredDivision;
        const helper = division === 3
          ? "適合小組內固定三人彼此提醒"
          : "適合較大的朋友群或牧區小隊一起完成";
        return `
          <button
            type="button"
            class="reading-team-division-choice${isSelected ? " is-selected" : ""}"
            data-division-choice="${division}"
            aria-pressed="${isSelected}"
          >
            <span class="reading-team-choice__icon"><span class="nlc-icon nlc-icon--md" data-icon="people" aria-hidden="true"></span></span>
            <span class="reading-team-choice__body"><strong>${division} 人團隊</strong><span class="reading-team-choice__description">${helper}</span></span>
          </button>
        `;
      }).join("");
      panel.innerHTML = `
        <header class="reading-team-dialog__header">
          <div>
            ${joinedContexts.length ? `<button type="button" class="reading-team-back-button" data-team-back><span class="nlc-icon nlc-icon--sm" data-icon="chevronLeft" aria-hidden="true"></span><span>返回我的團隊</span></button>` : ""}
            <p class="reading-team-eyebrow">${escapeHTML(plan.name || "教會讀經計畫")}</p>
            <h3 id="reading-team-dialog-title">我的團隊</h3>
          </div>
          <button type="button" class="reading-team-close dialog-close-button icon-button icon-button--subtle" data-team-close aria-label="關閉"><span class="nlc-icon nlc-icon--sm" data-icon="close" aria-hidden="true"></span></button>
        </header>
        <p class="reading-team-dialog__intro">${joinedContexts.length ? `你已加入 ${Array.from(joinedDivisions).join("、")} 人團隊，還可以建立另一種人數的團隊。` : "你可以同時參加 3 人團隊與 6 人團隊，章節進度只需打卡一次。"}</p>
        <div class="reading-team-division-choice-grid" role="group" aria-label="選擇團隊人數">
          ${divisionChoices}
        </div>

        <form id="reading-team-create-form" class="reading-team-form-card" role="tabpanel" style="display: flex; flex-direction: column; gap: 1rem;">
          <div class="reading-team-registration-panel__heading" style="display: flex; gap: 12px; align-items: center; margin-bottom: 0.4rem;">
            <span class="reading-team-form-card__icon" style="display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; background: var(--color-brand-subtle); color: var(--color-brand);"><span class="nlc-icon nlc-icon--md" data-icon="plus" aria-hidden="true"></span></span>
            <div><h4 style="margin: 0; font-size: 0.95rem; font-weight: 600;">建立新團隊</h4><p style="margin: 0; font-size: 0.875rem; color: var(--text-muted);">設定團隊名稱即可建立，你會成為隊長。</p></div>
          </div>
          <div>
            <span class="reading-team-field-label" style="display: block; font-size: 0.875rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 0.4rem;">團隊人數組別</span>
            <div style="font-size: 0.95rem; font-weight: 600; color: var(--color-brand); margin-bottom: 1.1rem; padding: 0.2rem 0; display: flex; align-items: center; gap: 0.35rem;">
              <span class="nlc-icon nlc-icon--sm" data-icon="people" aria-hidden="true"></span>
              <span><span data-division-form-label>${preferredDivision}</span> 人組團隊</span>
            </div>
          </div>
          <div>
            <label for="reading-team-name" style="display: block; font-size: 0.875rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 0.4rem;">團隊名稱</label>
            <input id="reading-team-name" class="form-control" maxlength="40" required placeholder="例如：恩典同行隊" style="width: 100%;">
          </div>
          <button type="submit" class="primary-btn reading-team-submit" style="width: 100%; margin-top: 0.5rem;">建立 <span data-division-label>${preferredDivision}</span> 人團隊並產生邀請碼</button>
          <span class="reading-team-form-hint" style="font-size: 0.875rem; color: var(--text-muted); display: block; margin-top: 0.4rem;">建立成功後，你將獲得團隊邀請碼，可分享給其他夥伴加入。</span>
        </form>
        <p class="reading-team-registration-privacy" style="font-size: 0.875rem; color: var(--text-muted); margin-top: 1rem; text-align: center;">加入後，你可以查看自己的團隊與夥伴進度；其他隊伍的資料不會顯示。</p>
        <p class="reading-team-form-error" data-team-error role="alert" hidden></p>`;
      const error = panel.querySelector("[data-team-error]");
      const showError = message => { error.textContent = message; error.hidden = false; };
      panel.querySelector("[data-team-close]").onclick = close;
      panel.querySelector("[data-team-back]")?.addEventListener("click", () => {
        const returnContext = joinedContexts.find(context =>
          Number(context.team.division) === Number(returnDivision)
        ) || joinedContexts[0];
        if (returnContext) renderTeam(returnContext, joinedContexts);
      });
      panel.querySelectorAll("[data-division-choice]").forEach(button => {
        button.addEventListener("click", () => {
          preferredDivision = Number(button.dataset.divisionChoice);
          panel.querySelectorAll("[data-division-choice]").forEach(item => {
            const isSelected = item === button;
            item.classList.toggle("is-selected", isSelected);
            item.setAttribute("aria-pressed", String(isSelected));
          });
          panel.querySelector("[data-division-label]").textContent = preferredDivision;
          const formLabel = panel.querySelector("[data-division-form-label]");
          if (formLabel) formLabel.textContent = preferredDivision;
        });
      });
      panel.querySelector("#reading-team-create-form").onsubmit = async event => {
        event.preventDefault();
        error.hidden = true;
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        const result = await db.createReadingTeam(plan, preferredDivision, panel.querySelector("#reading-team-name").value.trim());
        button.disabled = false;
        if (!result.success) return showError(result.message || "建立隊伍失敗，請稍後再試。");
        await refresh();
      };
      hydrate(panel);
    };

    const renderTeam = (context, allContexts = [context]) => {
      const team = context.team;
      returnDivision = Number(team.division);
      const members = Array.isArray(context.members) ? context.members : [];
      const totalChapters = Number(plan.currentRoundTotalChapters || plan.totalChapters || 0);
      const { averageProgress } = getTeamOverallPlanProgress(members, totalChapters);
      const currentUserId = String((state.currentUser && (state.currentUser.id || state.currentProfileId)) || state.currentProfileId || "");
      const captainId = String(team.captainId || team.captain_id || "");
      const isCaptain = Boolean(currentUserId && captainId && currentUserId === captainId);
      const isAdminUser = Boolean(state.currentUser && typeof getUserRoleCode === "function" && (getUserRoleCode(state.currentUser) === "admin" || state.currentUser.role === "admin"));
      const canEditTeamName = isCaptain || isAdminUser;
      const isReady = team.status === "ready" || Number(team.memberCount) === Number(team.capacity);
      const joinedDivisions = new Set(allContexts.map(item => Number(item && item.team && item.team.division)));
      const availableDivisions = [3, 6].filter(division => !joinedDivisions.has(division));
      const nextAvailableDivision = availableDivisions[0] || null;
      panel.innerHTML = `
        <header class="reading-team-dialog__header">
          <div>
            <p class="reading-team-eyebrow">${escapeHTML(plan.name || "教會讀經計畫")}</p>
            <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
              <h3 id="reading-team-dialog-title" style="margin: 0; font-size: 1.15rem; font-weight: 700;">${escapeHTML(team.name)}</h3>
              ${canEditTeamName ? `<button type="button" class="btn btn--subtle btn--xs" data-rename-team title="修改團隊名稱" aria-label="修改團隊名稱" style="display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.2rem 0.5rem; font-size: 0.875rem; font-weight: 500; border-radius: 6px; border: 1px solid var(--border-card); background: var(--bg-input); color: var(--color-brand); cursor: pointer;"><span class="nlc-icon nlc-icon--sm" data-icon="pencil" aria-hidden="true"></span><span>修改名稱</span></button>` : ""}
            </div>
          </div>
          <button type="button" class="reading-team-close dialog-close-button icon-button icon-button--subtle" data-team-close aria-label="關閉"><span class="nlc-icon nlc-icon--sm" data-icon="close" aria-hidden="true"></span></button>
        </header>
        ${allContexts.length > 1 ? `<div class="reading-team-registration-tabs" role="tablist" aria-label="切換我的團隊">${allContexts.map(item => `<button type="button" role="tab" data-team-view-division="${Number(item.team.division)}" aria-selected="${item === context}">${Number(item.team.division)} 人團隊</button>`).join("")}</div>` : ""}
        <div class="reading-team-summary">
          <div><span class="stat-badge stat-badge--brand">${Number(team.division)} 人組</span><strong>${Number(team.memberCount)} / ${Number(team.capacity)} 人</strong><span>${isReady ? "隊伍已完成" : "等待隊員加入"}</span></div>
          <div class="reading-team-summary__progress"><span>團隊平均進度</span><strong>${averageProgress}%</strong></div>
        </div>
        ${!isReady ? `<div class="reading-team-invite"><div><span>隊伍邀請碼</span><strong>${escapeHTML(team.inviteCode)}</strong></div><button type="button" class="secondary-btn" data-copy-team-code><span class="nlc-icon nlc-icon--sm" data-icon="share" aria-hidden="true"></span>複製邀請碼</button></div>` : `<div class="reading-team-ready"><span class="nlc-icon nlc-icon--sm" data-icon="checkCircle" aria-hidden="true"></span><span>名單已滿員並鎖定，團隊統計會固定以 ${Number(team.capacity)} 人計算。</span></div>`}
        <section class="reading-team-members" aria-labelledby="reading-team-members-title">
          <div class="reading-team-section-title"><h4 id="reading-team-members-title">隊員狀況</h4><span>只有同隊成員可查看</span></div>
          <div class="reading-team-member-list">${members.map(member => renderMember(member, totalChapters, plan, { canRemoveMembers: isCaptain, canTransferCaptain: isCaptain })).join("")}</div>
        </section>
        <footer class="reading-team-dialog__footer">
          ${isCaptain
            ? '<button type="button" class="reading-team-danger-link" data-disband-team>解散團隊</button>'
            : ""}
          ${nextAvailableDivision ? `<button type="button" class="secondary-btn" data-add-other-team>建立另一種人數團隊（${nextAvailableDivision} 人）</button>` : ""}
          <button type="button" class="primary-btn" data-team-close-footer>關閉</button>
        </footer>
        <p class="reading-team-form-error" data-team-error role="alert" hidden></p>`;
      panel.querySelector("[data-team-close]").onclick = close;
      panel.querySelector("[data-team-close-footer]").onclick = close;
      bindTeamReminderButtons(panel, team, members, totalChapters);
      bindTeamMemberRemovalButtons(panel, team, members, refresh);
      bindTeamCaptainTransferButtons(panel, team, members, refresh);
      panel.querySelectorAll("[data-team-view-division]").forEach(button => {
        button.onclick = () => {
          const selected = allContexts.find(item => Number(item.team.division) === Number(button.dataset.teamViewDivision));
          if (selected) renderTeam(selected, allContexts);
        };
      });
      panel.querySelector("[data-rename-team]")?.addEventListener("click", async () => {
        let newName = null;
        if (typeof window.showPromptDialog === "function") {
          newName = await window.showPromptDialog({
            title: "修改團隊名稱",
            message: "請輸入新的團隊名稱（1~40 字元）：",
            defaultValue: team.name,
            placeholder: "請輸入團隊名稱",
            confirmText: "儲存修改",
            cancelText: "取消"
          });
        } else {
          newName = window.prompt("請輸入新的團隊名稱：", team.name);
        }

        if (newName === null) return;
        const trimmed = String(newName).trim();
        if (!trimmed) {
          showToast("團隊名稱不可為空白。");
          return;
        }
        if (trimmed === team.name) return;

        const result = await db.renameReadingTeam(team.id, trimmed);
        if (!result.success) {
          const error = panel.querySelector("[data-team-error]");
          if (error) {
            error.textContent = result.message || "修改團隊名稱失敗。";
            error.hidden = false;
          } else {
            showToast(result.message || "修改團隊名稱失敗。", "error");
          }
          return;
        }
        if (typeof showToast === "function") {
          showToast(`團隊名稱已成功修改為：「${trimmed}」`, "success");
        }
        await refresh();
      });
      panel.querySelector("[data-add-other-team]")?.addEventListener("click", () => {
        returnDivision = Number(team.division);
        preferredDivision = nextAvailableDivision || (Number(team.division) === 3 ? 6 : 3);
        renderEmpty(allContexts);
      });
      const copyBtn = panel.querySelector("[data-copy-team-code]");
      if (copyBtn) {
        copyBtn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(team.inviteCode);
            const originalHtml = copyBtn.innerHTML;
            copyBtn.innerHTML = `<span class="nlc-icon nlc-icon--sm" data-icon="checkCircle" aria-hidden="true"></span>已複製`;
            hydrate(copyBtn);
            copyBtn.disabled = true;
            setTimeout(() => {
              copyBtn.innerHTML = originalHtml;
              hydrate(copyBtn);
              copyBtn.disabled = false;
            }, 2000);
          } catch (_) {
            showToast(`邀請碼：${team.inviteCode}`);
          }
        });
      }
      panel.querySelector("[data-disband-team]")?.addEventListener("click", async () => {
        const confirmed = await window.showConfirmDialog({
          title: "確定解散這支隊伍嗎？",
          message: "只有隊長可以執行此操作。解散後所有隊員都會回到尚未組隊狀態，邀請碼將會失效。",
          confirmText: "解散團隊",
          cancelText: "返回",
          isDestructive: true
        });
        if (!confirmed) return;
        const result = await db.disbandReadingTeam(team.id);
        if (!result.success) {
          const error = panel.querySelector("[data-team-error]");
          error.textContent = result.message || "解散隊伍失敗。";
          error.hidden = false;
          return;
        }
        await refresh();
      });
      hydrate(panel);
    };

    const refresh = async () => {
      renderLoading();
      const result = await db.getMyReadingTeam(plan);
      if (closed) return;
      if (!result.success) {
        const isAuthExpired = result.message && (result.message.includes("登入狀態已失效") || result.message.includes("重新登入") || result.message.includes("會員資料"));
        panel.innerHTML = `<header class="reading-team-dialog__header"><h3 id="reading-team-dialog-title">團隊報名</h3><button type="button" class="reading-team-close dialog-close-button icon-button icon-button--subtle" data-team-close aria-label="關閉"><span class="nlc-icon nlc-icon--sm" data-icon="close" aria-hidden="true"></span></button></header><div class="reading-team-empty-error"><p>${escapeHTML(result.message || "目前無法載入團隊資料。")}</p><button type="button" class="secondary-btn" data-team-retry>${isAuthExpired ? "重新登入" : "重新載入"}</button></div>`;
        panel.querySelector("[data-team-close]").onclick = close;
        panel.querySelector("[data-team-retry]").onclick = isAuthExpired ? () => {
          close();
          if (typeof authLaunch !== "undefined" && typeof authLaunch.startInteractiveAuth === "function") {
            authLaunch.startInteractiveAuth({ intent: "login", returnTo: "/" });
          } else if (typeof auth !== "undefined") {
            auth.login();
          }
        } : refresh;
        hydrate(panel);
        return;
      }
      const contexts = getTeamContexts(result.context);
      const targetContext = contexts.find(item => Number(item.team.division) === preferredDivision);
      if (targetContext) {
        renderTeam(targetContext, contexts);
      } else {
        renderEmpty(contexts);
      }
      window.dispatchEvent(new CustomEvent("readingTeam:updated", {
        detail: {
          planId: String(plan && (plan.globalPlanId || plan.id || plan.presetKey) || "")
        }
      }));
    };

    await refresh();
    return overlay;
  };

  async function refreshInlineReadingTeam(container, plan, team, mode) {
    const result = await db.getMyReadingTeam(plan);
    if (!result || !result.success) {
      showToast(result && result.message || "團隊名單更新失敗，請稍後再試。");
      return;
    }

    const contexts = getJoinedReadingTeamContexts(result.context);
    const refreshedContext = contexts.find(item =>
      String(item.team && item.team.id || "") === String(team && team.id || "")
      || Number(item.team && item.team.division) === Number(team && team.division)
    );
    if (!refreshedContext) {
      container.innerHTML = "";
      container.classList.add("hidden");
      return;
    }

    window.renderMyReadingTeamInline(container, plan, refreshedContext, mode);
    window.dispatchEvent(new CustomEvent("readingTeam:updated", {
      detail: {
        planId: String(plan && (plan.globalPlanId || plan.id || plan.presetKey) || ""),
        teamId: String(refreshedContext.team.id || "")
      }
    }));
  }

  window.renderMyReadingTeamInline = function renderMyReadingTeamInline(container, plan, context, mode = "members") {
    if (!container || !context || !context.team) return;
    const team = context.team;
    const members = Array.isArray(context.members) ? context.members : [];
    const totalChapters = Number(plan && (plan.currentRoundTotalChapters || plan.totalChapters) || 0);
    const {
      averageProgress,
      currentRoundReadChapters: totalRead,
      currentRoundTargetChapters: totalJourneyChapters
    } = getTeamOverallPlanProgress(members, totalChapters);
    const currentMember = members.find(member => member.isMe);
    const currentUserId = state.currentUser && (state.currentUser.id || state.currentProfileId) || state.currentProfileId;
    const captainId = team.captainId || team.captain_id;
    const isCurrentUserCaptain = Boolean((currentMember && currentMember.role === "captain")
      || (currentUserId && captainId && String(captainId) === String(currentUserId)));
    const isAdminUser = Boolean(state.currentUser && typeof getUserRoleCode === "function" && (getUserRoleCode(state.currentUser) === "admin" || state.currentUser.role === "admin"));
    const canEditTeamNameInline = isCurrentUserCaptain || isAdminUser;
    const summary = mode === "stats" ? `
      <div class="reading-team-summary" style="justify-content: center; text-align: center;">
        <div style="align-items: center;"><span>團隊完成狀況</span><strong>${averageProgress}%</strong><span>${totalRead} / ${totalJourneyChapters} 章</span></div>
      </div>` : "";
    container.classList.toggle("reading-team-inline--stats", mode === "stats");
    container.innerHTML = `
      <div class="reading-team-inline__header">
        <div>
          <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
            <h3 style="margin: 0; font-size: 1.1rem; font-weight: 700;">${escapeHTML(team.name || "我的團隊")}</h3>
            ${canEditTeamNameInline ? `<button type="button" class="btn btn--subtle btn--xs" data-rename-team-inline title="修改團隊名稱" aria-label="修改團隊名稱" style="display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.2rem 0.5rem; font-size: 0.875rem; font-weight: 500; border-radius: 6px; border: 1px solid var(--border-card); background: var(--bg-input); color: var(--color-brand); cursor: pointer;"><span class="nlc-icon nlc-icon--sm" data-icon="pencil" aria-hidden="true"></span><span>修改名稱</span></button>` : ""}
          </div>
          <p style="margin-top: 0.2rem;">${Number(team.division)} 人團隊・一起查看彼此的讀經進度</p>
        </div>
        <span class="stat-badge stat-badge--brand">${mode === "stats" ? "團隊統計" : "組員狀況"}</span>
      </div>
      ${summary}
      <div class="glass-card-upgrade pilgrimage-card" id="team-pilgrimage-card" style="display: flex; flex-direction: column; margin: 0.8rem 0; border: 1px solid var(--border-card); border-radius: 12px; padding: 0.8rem; background: var(--bg-card);">
        <div class="card-header-flex" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem;">
          <h3 class="card-title" style="margin-bottom: 0; font-size: 0.95rem; font-weight: 500; display: flex; align-items: center; gap: 0.25rem; color: var(--text-primary);">
            團隊賽道地圖 (${Number(team.division)}人組)
          </h3>
          <div id="team-pilgrimage-legend" class="text-[10px] space-x-2 text-slate-400 dark:text-zinc-500" style="display: flex; align-items: center; gap: 8px; font-size: 0.875rem;"></div>
        </div>
        <div class="trail-scroll-wrapper" style="overflow: auto; max-height: 380px; background: var(--bg-input); border-radius: 12px; border: 1px solid var(--border-card); padding: 0.5rem; position: relative;">
          <div id="team-pilgrimage-trail-board" style="position: relative; transform-origin: top left; transition: transform 0.2s ease; display: inline-block;">
            <canvas id="team-pilgrimage-canvas" style="display: block;"></canvas>
          </div>
        </div>
      </div>
      ${mode === "stats" ? renderTeamStatGrid(members, totalChapters, plan) : ""}
      <section class="reading-team-members" aria-label="團隊成員">
        ${mode === "members" ? renderTeamMemberRoster(members, plan, { canRemoveMembers: isCurrentUserCaptain, canTransferCaptain: isCurrentUserCaptain }) : `<div class="reading-team-member-list">${members.map(member => renderMember(member, totalChapters, plan, { canRemoveMembers: isCurrentUserCaptain, canTransferCaptain: isCurrentUserCaptain })).join("")}</div>`}
      </section>`;

    // Only the captain may manage the roster or dissolve the whole team.

    if (isCurrentUserCaptain) {
      container.innerHTML += `
        <div class="reading-team-inline-actions" style="margin-top: 1.2rem; display: flex; justify-content: flex-end; border-top: 1px dashed rgba(255,255,255,0.06); padding-top: 0.8rem;">
          <button type="button" class="text-xs text-danger" data-disband-team-inline style="background:none; border:none; padding:0.5rem; cursor:pointer; display:inline-flex; align-items:center; gap:0.25rem; font-size:0.875rem; font-weight:500; opacity:0.7;"><span class="nlc-icon nlc-icon--sm" data-icon="trash"></span><span>解散團隊</span></button>
        </div>`;

      const disbandBtn = container.querySelector("[data-disband-team-inline]");
      disbandBtn.addEventListener("click", async () => {
        const confirmed = await window.showConfirmDialog({
          title: "解散團隊",
          message: `確定要解散團隊「${team.name || ""}」嗎？\n此動作不可復原，所有隊員都會被移除。`,
          confirmText: "解散團隊",
          cancelText: "取消",
          isDestructive: true
        });
        if (!confirmed) return;

        disbandBtn.disabled = true;
        loader.show("解散團隊中...");
        const result = await db.disbandReadingTeam(team.id);
        loader.hide();
        disbandBtn.disabled = false;

        if (result && result.success) {
          alert("已解散團隊。");
          window.location.reload(true);
        } else {
          alert("解散團隊失敗: " + ((result && (result.message || result.error && result.error.message)) || "未知錯誤"));
        }
      });
    }

    container.querySelector("[data-rename-team-inline]")?.addEventListener("click", async () => {
      let newName = null;
      if (typeof window.showPromptDialog === "function") {
        newName = await window.showPromptDialog({
          title: "修改團隊名稱",
          message: "請輸入新的團隊名稱（1~40 字元）：",
          defaultValue: team.name || "",
          placeholder: "請輸入團隊名稱",
          confirmText: "儲存修改",
          cancelText: "取消"
        });
      } else {
        newName = window.prompt("請輸入新的團隊名稱：", team.name || "");
      }

      if (newName === null) return;
      const trimmed = String(newName).trim();
      if (!trimmed) {
        if (typeof showToast === "function") showToast("團隊名稱不可為空白。", "warning");
        else alert("團隊名稱不可為空白。");
        return;
      }
      if (trimmed === team.name) return;

      const result = await db.renameReadingTeam(team.id, trimmed);
      if (!result || !result.success) {
        const errorMsg = (result && result.message) || "修改團隊名稱失敗。";
        if (typeof showToast === "function") showToast(errorMsg, "error");
        else alert(errorMsg);
        return;
      }
      if (typeof showToast === "function") {
        showToast(`團隊名稱已成功修改為：「${trimmed}」`, "success");
      }
      if (typeof refreshInlineReadingTeam === "function") {
        refreshInlineReadingTeam(container, plan, team, mode);
      } else if (typeof window.refreshCurrentTab === "function") {
        window.refreshCurrentTab();
      } else {
        window.location.reload();
      }
    });

    bindTeamReminderButtons(container, team, members, totalChapters);
    bindTeamMemberRemovalButtons(container, team, members, () => refreshInlineReadingTeam(container, plan, team, mode));
    bindTeamCaptainTransferButtons(container, team, members, () => refreshInlineReadingTeam(container, plan, team, mode));
    setTimeout(() => {
      const renderFn = typeof window.renderPilgrimageTrail === "function" ? window.renderPilgrimageTrail : (typeof renderPilgrimageTrail === "function" ? renderPilgrimageTrail : null);
      if (renderFn) {
        const enrichedMembers = members.map(m => {
          const stats = typeof getMemberOverallPlanProgress === "function" ? getMemberOverallPlanProgress(m, totalChapters) : null;
          const readCount = stats ? stats.completedChapters : (m.chapters_read ?? m.completedChapters ?? m.completed ?? m.readChapters ?? 0);
          return {
            ...m,
            name: m.name || m.displayName || (m.profile && m.profile.name) || "隊友",
            chapters_read: Number(readCount || 0)
          };
        });
        renderFn(enrichedMembers, plan);
      }
    }, 100);
    hydrate(container);
  };

  function getJoinedReadingTeamContexts(context) {
    if (Array.isArray(context && context.teams)) {
      return context.teams
        .filter(item => item && item.team)
        .sort((left, right) => Number(left.team.division) - Number(right.team.division));
    }
    return context && context.team ? [context] : [];
  }

  window.renderReadingTeamRegistrationInline = async function renderReadingTeamRegistrationInline(container, plan, options = {}) {
    if (!container || !isSupportedPlan(plan)) return;

    // Get existing team memberships first
    const result = await db.getMyReadingTeam(plan);
    const joinedContexts = result && result.success ? getJoinedReadingTeamContexts(result.context) : [];

    const joinedDivisions = new Set(joinedContexts.map(context => Number(context.team.division)));
    const availableDivisions = [3, 6].filter(division => !joinedDivisions.has(division));

    let preferredDivision = [3, 6].includes(Number(options.preferredDivision)) ? Number(options.preferredDivision) : 3;
    if (!availableDivisions.includes(preferredDivision)) preferredDivision = availableDivisions[0] || 3;

    if (availableDivisions.length === 0) {
      container.innerHTML = `<div class="p-6 text-center text-muted"><p>你已加入所有組別的團隊（3 人與 6 人團隊）。</p></div>`;
      return;
    }

    container.innerHTML = `
      <div class="reading-team-registration-card" style="padding: 1.2rem; background: var(--bg-card); border-radius: 16px; border: 1px solid var(--border-card); box-shadow: var(--shadow-sm); margin-bottom: 1rem;">
        <p class="reading-team-dialog__intro" style="font-size: 0.88rem; color: var(--text-secondary); margin-bottom: 1.2rem;">
          ${joinedContexts.length ? `你已加入 ${Array.from(joinedDivisions).join("、")} 人團隊，還可以建立另一種人數的團隊。` : "你可以同時參加一支 3 人團隊與一支 6 人團隊。建立新團隊即可加入此計畫之團隊。"}
        </p>

        <form id="reading-team-create-form-inline" class="reading-team-form-card" role="tabpanel" style="display: flex; flex-direction: column; gap: 1rem;">
          <div class="reading-team-registration-panel__heading" style="display: flex; gap: 12px; align-items: center; margin-bottom: 0.4rem;">
            <span class="reading-team-form-card__icon" style="display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; background: var(--color-brand-subtle); color: var(--color-brand);"><span class="nlc-icon nlc-icon--md" data-icon="plus" aria-hidden="true"></span></span>
            <div><h4 style="margin: 0; font-size: 0.95rem; font-weight: 600;">建立新團隊</h4><p style="margin: 0; font-size: 0.875rem; color: var(--text-muted);">選擇人數並命名，你會成為隊長。</p></div>
          </div>
          <div>
            <span class="reading-team-field-label" style="display: block; font-size: 0.875rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 0.4rem;">團隊人數</span>
            <div class="reading-team-division-switch" role="radiogroup" aria-label="選擇團隊組別" style="display: flex; gap: 8px;">
              ${availableDivisions.map(division => `<button type="button" class="secondary-btn" data-division="${division}" aria-checked="${preferredDivision === division}" style="flex: 1; padding: 0.5rem 0.8rem; font-size: 0.875rem;">${division} 人團隊</button>`).join("")}
            </div>
          </div>
          <div>
            <label for="reading-team-name-inline" style="display: block; font-size: 0.875rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 0.4rem;">團隊名稱</label>
            <input id="reading-team-name-inline" class="form-control" maxlength="40" required placeholder="例如：恩典同行隊" style="width: 100%;">
          </div>
          <button type="submit" class="primary-btn reading-team-submit" style="width: 100%; margin-top: 0.5rem;">建立 <span data-division-label>${preferredDivision}</span> 人團隊並產生邀請碼</button>
        </form>

        <p class="reading-team-registration-privacy" style="font-size: 0.875rem; color: var(--text-muted); margin-top: 1rem; text-align: center;">加入後，你可以查看自己的團隊與夥伴進度；其他隊伍的資料不會顯示。</p>
        <p class="reading-team-form-error" data-team-error role="alert" hidden style="color: var(--color-danger); font-size: 0.875rem; margin-top: 0.8rem; text-align: center;"></p>
      </div>`;

    const error = container.querySelector("[data-team-error]");
    const showError = message => { error.textContent = message; error.hidden = false; };

    // Bind division switches
    const divisionButtons = container.querySelectorAll("[data-division]");
    divisionButtons.forEach(button => {
      if (Number(button.dataset.division) === preferredDivision) {
        button.classList.add("active");
        button.style.background = "var(--color-brand-subtle)";
        button.style.borderColor = "var(--primary-color)";
        button.style.color = "var(--primary-color)";
      }
      button.onclick = () => {
        preferredDivision = Number(button.dataset.division);
        divisionButtons.forEach(item => {
          const isSelected = item === button;
          item.classList.toggle("active", isSelected);
          item.style.background = isSelected ? "var(--color-brand-subtle)" : "";
          item.style.borderColor = isSelected ? "var(--primary-color)" : "";
          item.style.color = isSelected ? "var(--primary-color)" : "";
        });
        container.querySelector("[data-division-label]").textContent = preferredDivision;
      };
    });

    // Handle submit events
    container.querySelector("#reading-team-create-form-inline").onsubmit = async event => {
      event.preventDefault();
      error.hidden = true;
      const submitBtn = event.currentTarget.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      const nameInput = container.querySelector("#reading-team-name-inline").value.trim();
      const result = await db.createReadingTeam(plan, preferredDivision, nameInput);
      submitBtn.disabled = false;
      if (!result.success) return showError(result.message || "建立隊伍失敗，請稍後再試。");
      showToast("團隊建立成功！");
      // Trigger plan view update to stats mode
      if (window.PlanPageController) {
        await window.PlanPageController.switchPage(PLAN_PAGE.GROUP, { forceReload: true });
      }
    };

    hydrate(container);
  };

  window.isReadingTeamPlan = isSupportedPlan;
})();
