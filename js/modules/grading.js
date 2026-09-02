// js/modules/grading.js — 「線上簡答批改」工作區（grade.html）
// 設計文件：docs/exam-online-grading-design.md
//
// 一頁一位作答者：逐題右側分數框、右上即時總分、底部整卷評語。
// 「送出這一張」／「送出全部待送」。三層防遺失：
//   L1 localStorage 鏡射（每次輸入 debounce）
//   L2 伺服器草稿 exam_save_grading_draft（切人 / 每 20 秒 / 切背景 / 按鈕）
//   L3 正式送出 exam_grade_attempt(_bulk)
// 樂觀鎖：每張帶 rev，伺服器較新 → exam_grading_stale → 讓使用者選覆蓋 / 重載。

const esc = (s) => (typeof window.escapeHTML === "function"
  ? window.escapeHTML(String(s ?? ""))
  : String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
const toast = (m) => (typeof window.showToast === "function" ? window.showToast(m) : null);
const icon = (name) => (typeof window.renderIcon === "function"
  ? window.renderIcon(name, { size: "sm", className: "nlc-icon" }) : "");
const LS_PREFIX = "exam_grade_";
const STALE_MS = 21 * 24 * 60 * 60 * 1000;
const DRAFT_DEBOUNCE_MS = 20000;
const MIRROR_DEBOUNCE_MS = 600;

function pruneStaleMirrors() {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX)) continue;
      let saved = 0;
      try { saved = Number(JSON.parse(localStorage.getItem(k) || "{}").__savedAt) || 0; } catch (_) {}
      if (!saved || now - saved > STALE_MS) localStorage.removeItem(k);
    }
  } catch (_) {}
}

function fmtTime(v) {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-TW", { hour12: false });
}
function fmtClock(ms) {
  const d = new Date(ms || Date.now());
  return d.toLocaleTimeString("zh-TW", { hour12: false });
}

class GradingWorkspace {
  constructor({ paperId, attemptId }) {
    this.root = document.getElementById("grade-root");
    this.paperId = paperId;
    this.wantAttemptId = attemptId || null;
    this.paper = null;
    this.roster = [];
    this.currentId = null;
    this.sheetCache = new Map();     // attemptId -> { questions, examinee, attemptStatus }
    this.working = null;             // { scores:{qid:val}, overall:str }
    this.baseRev = 0;                // 目前這張的 rev（樂觀鎖基準）
    this.dirty = new Set();          // 有「本機未送出修改」的 attemptId
    this.draftSavedAt = new Map();   // attemptId -> ms（伺服器草稿最後存檔）
    this.submitting = false;
    this._mirrorTimer = null;
    this._draftTimer = null;
    this._retryTimer = null;
    this._authExpiredShown = false;
    // 切背景 / 關頁：先把當下輸入同步寫進 localStorage（不靠網路），再試著存伺服器草稿
    this._onHide = () => { this._readInputs(); this._mirror(); this._flushDraft("hide"); };
    this._onBeforeUnload = () => { this._readInputs(); this._mirror(); };
  }

  // 掃 localStorage：這份試卷、名單內、還有本機鏡射的 attempt = 有「還沒送出的批改」。
  // token 失效被登出 → 重新登入回來後，靠這個把未送出的卷標成 ⚠、算進「送出全部待送」。
  _scanLocalDrafts() {
    try {
      const prefix = `${LS_PREFIX}${this.paperId}_`;
      const ids = new Set(this.roster.map((r) => r.attemptId));
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix) && ids.has(k.slice(prefix.length))) this.dirty.add(k.slice(prefix.length));
      }
    } catch (_) {}
  }

  async boot() {
    pruneStaleMirrors();
    this.root.innerHTML = '<div class="grade-loading">正在載入批改名單…</div>';
    const res = await window.db.getGradingWorkspace(this.paperId);
    if (!res.success) {
      if (res.authExpired) { this._showAuthExpiredBanner(); this.root.innerHTML = ""; return; }
      this.root.innerHTML = `<div class="grade-error">
        <p>${esc(res.message || "無法載入批改頁。")}</p>
        <p class="grade-error__hint">若你確定有被指派批改，請重新整理；或向管理員確認指派。</p>
      </div>`;
      return;
    }
    this.paper = res.data.paper || {};
    this.roster = Array.isArray(res.data.roster) ? res.data.roster.slice() : [];
    this.roster.forEach((r) => { if (r.hasDraft) this.draftSavedAt.set(r.attemptId, 0); });
    this._scanLocalDrafts();

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this._onHide();
    });
    window.addEventListener("beforeunload", this._onBeforeUnload);
    window.addEventListener("online", () => { this._flushDraft("online"); });

    if (!this.roster.length) {
      this.root.innerHTML = `<div class="grade-error">
        <p>目前沒有指派給你批改的考卷。</p>
        <p class="grade-error__hint">《${esc(this.paper.title || "測驗")}》</p>
      </div>`;
      return;
    }

    let start = this.roster.find((r) => r.attemptId === this.wantAttemptId);
    if (!start) start = this.roster.find((r) => (r.shortGraded || 0) < (r.shortQuestions || 0)) || this.roster[0];
    await this.openAttempt(start.attemptId);
  }

  destroy() {
    window.removeEventListener("beforeunload", this._onBeforeUnload);
    if (this._mirrorTimer) clearTimeout(this._mirrorTimer);
    if (this._draftTimer) clearTimeout(this._draftTimer);
    if (this._retryTimer) clearTimeout(this._retryTimer);
  }

  // ── localStorage 鏡射 ────────────────────────────────────────────────
  _lsKey(id) { return `${LS_PREFIX}${this.paperId}_${id}`; }
  _loadLocal(id) {
    try {
      const raw = localStorage.getItem(this._lsKey(id));
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o !== "object") return null;
      return o;
    } catch (_) { return null; }
  }
  _mirror() {
    if (!this.currentId || !this.working) return;
    try {
      localStorage.setItem(this._lsKey(this.currentId), JSON.stringify({
        scores: this.working.scores || {},
        overall: this.working.overall || "",
        __savedAt: Date.now(),
        __baseRev: this.baseRev
      }));
    } catch (_) {}
  }
  _clearLocal(id) {
    try { localStorage.removeItem(this._lsKey(id)); } catch (_) {}
  }

  // ── 開一張卷 ─────────────────────────────────────────────────────────
  async openAttempt(id, opts = {}) {
    if (this.currentId && this.currentId !== id) {
      this._readInputs();
      this._mirror();
      await this._flushDraft("switch");
    }
    if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }

    this.currentId = id;
    this.root.innerHTML = '<div class="grade-loading">正在載入這一張…</div>';
    const res = await window.db.getGradingSheet(id);
    if (!res.success) {
      if (res.authExpired) { this._showAuthExpiredBanner(); this.root.innerHTML = ""; return; }
      this.root.innerHTML = `<div class="grade-error"><p>${esc(res.message || "載入失敗")}</p>
        <button type="button" class="secondary-btn" data-g-retry-open>重新載入</button></div>`;
      this.root.querySelector("[data-g-retry-open]")?.addEventListener("click", () => this.openAttempt(id));
      return;
    }
    const d = res.data || {};
    const questions = Array.isArray(d.questions) ? d.questions : [];
    this.baseRev = Number(d.rev) || 0;
    this.sheetCache.set(id, {
      questions, examinee: d.examinee || {}, attemptStatus: d.attemptStatus,
      resultsPublished: !!d.resultsPublished, rev: this.baseRev
    });
    this._readonly = !!d.resultsPublished;

    // ── 合併：server baseline → 伺服器草稿 → 本機鏡射（取最新）──
    const serverScores = {};
    questions.forEach((q) => { serverScores[q.questionId] = (q.awardedPoints == null ? null : Number(q.awardedPoints)); });
    const base = { scores: serverScores, overall: d.overallComment || "" };

    const draft = d.draft && d.draft.payload ? d.draft : null;
    const draftMs = draft ? (Date.parse(draft.savedAt) || 0) : 0;
    if (draftMs) this.draftSavedAt.set(id, draftMs);
    const local = opts.discardLocal ? null : this._loadLocal(id);
    const localMs = local ? (Number(local.__savedAt) || 0) : 0;

    let src = "server";
    let working = base;
    if (localMs && localMs > draftMs) {
      working = { scores: { ...serverScores, ...(local.scores || {}) }, overall: local.overall || "" };
      src = "local";
    } else if (draft) {
      working = { scores: { ...serverScores, ...(draft.payload.scores || {}) }, overall: draft.payload.overall || "" };
      src = "draft";
    }
    // 正規化：只留這張卷有的題。未作答的題預設 0 分（可再改），這樣整卷只剩
    // 「有作答」的要人工給分。
    const scores = {};
    questions.forEach((q) => {
      const v = working.scores ? working.scores[q.questionId] : null;
      const num = (v === "" || v == null || Number.isNaN(Number(v))) ? null : Number(v);
      const unanswered = !(typeof q.response === "string" && q.response.trim() !== "");
      scores[q.questionId] = num == null && unanswered ? 0 : num;
    });
    this.working = { scores, overall: working.overall || "" };
    this._mergeSource = src;
    if (src === "local") this.dirty.add(id); else this.dirty.delete(id);

    this.render();
  }

  _row(id) { return this.roster.find((r) => r.attemptId === id); }
  _index() { return this.roster.findIndex((r) => r.attemptId === this.currentId); }

  // ── 讀 DOM → this.working ────────────────────────────────────────────
  _readInputs() {
    if (!this.working) return;
    this.root.querySelectorAll("[data-q-score]").forEach((el) => {
      const qid = el.getAttribute("data-q-score");
      const raw = String(el.value ?? "").trim();
      this.working.scores[qid] = raw === "" ? null : Number(raw);
    });
    const ov = this.root.querySelector("[data-overall]");
    if (ov) this.working.overall = ov.value || "";
  }

  _total() {
    const cache = this.sheetCache.get(this.currentId);
    const qs = cache ? cache.questions : [];
    let sum = 0, missing = 0, invalid = 0, max = 0;
    qs.forEach((q) => {
      max += Number(q.points) || 0;
      const v = this.working.scores[q.questionId];
      if (v == null || Number.isNaN(v)) { missing++; return; }
      if (v < 0 || v > (Number(q.points) || 0)) invalid++;
      sum += v;
    });
    return { sum, missing, invalid, max, count: qs.length };
  }

  // ── render ──────────────────────────────────────────────────────────
  render() {
    const cache = this.sheetCache.get(this.currentId) || {};
    const qs = cache.questions || [];
    const ex = cache.examinee || {};
    const row = this._row(this.currentId) || {};
    const idx = this._index();
    const t = this._total();
    const canSubmit = !this._readonly && t.missing === 0 && t.invalid === 0 && !this.submitting;

    const totalCls = "grade-total" + (t.invalid ? " grade-total--bad" : (t.missing ? " grade-total--wait" : ""));
    const totalNote = t.invalid ? "・有分數超出配分" : (t.missing ? `・尚缺 ${t.missing} 題` : "");

    const orgLine = [ex.greatRegion, ex.pastoralZone, ex.smallGroup].filter(Boolean).join("・") || "—";

    const qHtml = qs.map((q) => {
      const v = this.working.scores[q.questionId];
      const bad = v != null && (v < 0 || v > (Number(q.points) || 0));
      // 卡片只留：題目 ＋ 這位作答者的作答 ＋ 分數框。不顯示參考答案 / 評分要點
      //（那些對每個人都一樣，會被誤讀成「大家都填了 AI 的答案」）。
      const answered = typeof q.response === "string" && q.response.trim() !== "";
      const scoreInput = `<label class="grade-q__score">得分
        <input type="number" inputmode="decimal" step="0.5" min="0" max="${q.points}"
          data-q-score="${esc(q.questionId)}" value="${v == null ? "" : v}"
          ${this._readonly ? "disabled" : ""} aria-label="第 ${q.position} 題得分">
        <span class="grade-q__of">/ ${q.points}</span>
      </label>`;
      // 未作答：收成一行（題號 + 未作答標籤 + 分數框），不佔版面
      if (!answered) {
        return `<section class="grade-q grade-q--blank${bad ? " grade-q--bad" : ""}">
          <div class="grade-q__head">
            <span class="grade-q__no">第 ${q.position} 題（${q.points} 分）</span>
            <span class="grade-q__blanktag">未作答</span>
            ${scoreInput}
          </div>
        </section>`;
      }
      return `<section class="grade-q${bad ? " grade-q--bad" : ""}">
        <div class="grade-q__head">
          <span class="grade-q__no">第 ${q.position} 題（${q.points} 分）</span>
          ${scoreInput}
        </div>
        ${q.stem ? `<p class="grade-q__stem">${esc(q.stem)}</p>` : ""}
        <div class="grade-q__resp">${esc(q.response)}</div>
      </section>`;
    }).join("");

    this.root.innerHTML = `
      <div class="grade-wrap">
        <header class="grade-head">
          <div class="grade-head__nav">
            <button type="button" class="grade-navbtn" data-g-prev ${idx <= 0 ? "disabled" : ""}>${icon("chevronLeft")}上一位</button>
            <span class="grade-head__pos">${idx + 1} / ${this.roster.length}</span>
            <button type="button" class="grade-navbtn" data-g-next ${idx >= this.roster.length - 1 ? "disabled" : ""}>下一位${icon("chevronRight")}</button>
            <span class="${totalCls}">總分 <b>${t.sum}</b> / ${t.max}<span class="grade-total__note">${totalNote}</span></span>
          </div>
          <div class="grade-head__who">
            <b>${esc(ex.name || "（未命名）")}</b>
            <span class="grade-head__org">${esc(orgLine)}</span>
          </div>
          <div class="grade-head__meta">
            ${this._statusBadge(row)} ・ 送出 ${esc(fmtTime(ex.submittedAt))}
            ${this._readonly ? ' ・ <span class="grade-lock">成績已公布，唯讀</span>' : ""}
          </div>
          ${this._mergeSource === "local" ? '<div class="grade-banner">本機有較新的未送出修改（尚未送到伺服器）。</div>' : ""}
          <div class="grade-conflict hidden" data-g-conflict></div>
        </header>

        <div class="grade-body">
          ${qHtml || '<p class="grade-loading">這張卷沒有簡答題。</p>'}
          <section class="grade-overall">
            <label class="grade-overall__label">整卷評語<span>（個別題目的講評也寫這裡）</span></label>
            <textarea data-overall rows="5" ${this._readonly ? "disabled" : ""}
              placeholder="給這位作答者的整體回饋…">${esc(this.working.overall || "")}</textarea>
          </section>
        </div>

        <footer class="grade-foot">
          <div class="grade-foot__status" data-g-status>${this._statusLine()}</div>
          <div class="grade-foot__btns">
            ${(row.shortGraded > 0 || row.attemptStatus === "graded") && !this._readonly
              ? '<button type="button" class="secondary-btn grade-danger" data-g-reset>重設為待批</button>' : ""}
            <button type="button" class="secondary-btn" data-g-draft ${this._readonly ? "disabled" : ""}>儲存此張草稿</button>
            <button type="button" class="primary-btn" data-g-submit ${canSubmit ? "" : "disabled"}>送出這一張</button>
          </div>
        </footer>

        ${this._batchBar()}
        ${this._rosterPanel()}
      </div>`;

    this._wire();
  }

  _statusBadge(row) {
    const total = row.shortQuestions ?? row.shortTotal ?? 0;
    const graded = row.shortGraded ?? 0;
    if (this.dirty.has(row.attemptId)) return '<span class="grade-badge grade-badge--dirty">⚠ 有未存修改</span>';
    if (row.attemptStatus === "graded" || (total > 0 && graded >= total)) return '<span class="grade-badge grade-badge--done">已送出</span>';
    if (graded > 0) return '<span class="grade-badge grade-badge--partial">部分</span>';
    if (this.draftSavedAt.has(row.attemptId)) return '<span class="grade-badge grade-badge--draft">有草稿</span>';
    return '<span class="grade-badge">待批</span>';
  }

  _statusLine() {
    const mms = (() => { try { return Number(JSON.parse(localStorage.getItem(this._lsKey(this.currentId)) || "{}").__savedAt) || 0; } catch (_) { return 0; } })();
    const dms = this.draftSavedAt.get(this.currentId) || 0;
    const parts = [];
    parts.push(mms ? `已存本機 ${fmtClock(mms)}` : "尚未變更");
    if (dms) parts.push(`伺服器草稿 ${fmtClock(dms)}`);
    return parts.join(" ・ ");
  }

  _batchBar() {
    const pend = [...this.dirty];
    if (!pend.length) return "";
    return `<div class="grade-batchbar">
      <span>有 ${pend.length} 張已改未送</span>
      <button type="button" class="primary-btn" data-g-batch>送出全部待送（${pend.length}）</button>
    </div>`;
  }

  _rosterPanel() {
    const rows = this.roster.map((r) => {
      const org = [r.pastoralZone, r.smallGroup].filter(Boolean).join("・") || "—";
      return `<button type="button" class="grade-rrow${r.attemptId === this.currentId ? " grade-rrow--on" : ""}" data-g-open="${esc(r.attemptId)}">
        <span class="grade-rrow__name">${esc(r.name || "（未命名）")}</span>
        <span class="grade-rrow__org">${esc(org)}</span>
        ${this._statusBadge(r)}
      </button>`;
    }).join("");
    return `<details class="grade-roster">
      <summary>名單（${this.roster.length}）</summary>
      <div class="grade-roster__list">${rows}</div>
    </details>`;
  }

  _wire() {
    const r = this.root;
    r.querySelector("[data-g-prev]")?.addEventListener("click", () => this._nav(-1));
    r.querySelector("[data-g-next]")?.addEventListener("click", () => this._nav(1));
    r.querySelectorAll("[data-g-open]").forEach((b) =>
      b.addEventListener("click", () => this.openAttempt(b.getAttribute("data-g-open"))));

    const onEdit = () => {
      this._readInputs();
      this.dirty.add(this.currentId);
      if (this._mirrorTimer) clearTimeout(this._mirrorTimer);
      this._mirrorTimer = setTimeout(() => { this._mirror(); this._refreshStatusLine(); }, MIRROR_DEBOUNCE_MS);
      if (this._draftTimer) clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => this._flushDraft("timer"), DRAFT_DEBOUNCE_MS);
      this._refreshTotalsAndButtons();
    };
    r.querySelectorAll("[data-q-score]").forEach((el) => {
      el.addEventListener("input", onEdit);
      el.addEventListener("change", onEdit);
    });
    r.querySelector("[data-overall]")?.addEventListener("input", onEdit);

    r.querySelector("[data-g-draft]")?.addEventListener("click", async (e) => {
      this._readInputs(); this._mirror();
      e.currentTarget.disabled = true;
      await this._flushDraft("button", { force: true });
      e.currentTarget.disabled = this._readonly;
      toast("已儲存草稿");
    });
    r.querySelector("[data-g-submit]")?.addEventListener("click", () => this._submitOne());
    r.querySelector("[data-g-batch]")?.addEventListener("click", () => this._submitBatch());
    r.querySelector("[data-g-reset]")?.addEventListener("click", () => this._resetCurrent());
  }

  // ── 重設為待批：清空這張卷的評分，退回「已送出、尚未批改」──────────────
  async _resetCurrent() {
    if (this.submitting) return;
    const ex = (this.sheetCache.get(this.currentId) || {}).examinee || {};
    const confirmed = typeof window.showConfirmDialog === "function"
      ? await window.showConfirmDialog({
          title: `確定要把「${ex.name || "這位作答者"}」的批改重設為待批嗎？`,
          message: "這張卷目前已經打的分數與整卷評語都會被清空，且無法復原。",
          confirmText: "重設為待批",
          cancelText: "取消",
          isDestructive: true
        })
      : window.confirm("確定要重設為待批嗎？目前的分數與評語都會被清空，且無法復原。");
    if (!confirmed) return;
    this.submitting = true;
    this._refreshTotalsAndButtons();
    let res;
    try {
      res = await window.db.resetAttemptGrading(this.currentId);
    } catch (e) {
      res = { success: false, message: "重設失敗（網路）" };
    }
    this.submitting = false;
    if (res && res.authExpired) { this._showAuthExpiredBanner(); this._refreshTotalsAndButtons(); return; }
    if (!res || !res.success) {
      toast((res && res.message) || "重設失敗，請稍後再試");
      this._refreshTotalsAndButtons();
      return;
    }
    // 伺服器已清空分數；本機鏡射跟草稿快取也要一起清掉，不然重開這張時
    // 又會被本機殘留的舊分數蓋回去。
    this._clearLocal(this.currentId);
    this.dirty.delete(this.currentId);
    this.draftSavedAt.delete(this.currentId);
    const row = this._row(this.currentId);
    if (row) { row.shortGraded = 0; row.attemptStatus = "submitted"; }
    toast("已重設為待批");
    await this.openAttempt(this.currentId, { discardLocal: true });
  }

  _refreshStatusLine() {
    const el = this.root.querySelector("[data-g-status]");
    if (el) el.textContent = this._statusLine();
  }
  _refreshTotalsAndButtons() {
    const t = this._total();
    const totEl = this.root.querySelector(".grade-total");
    if (totEl) {
      totEl.className = "grade-total" + (t.invalid ? " grade-total--bad" : (t.missing ? " grade-total--wait" : ""));
      totEl.innerHTML = `總分 <b>${t.sum}</b> / ${t.max}<span class="grade-total__note">${t.invalid ? "・有分數超出配分" : (t.missing ? `・尚缺 ${t.missing} 題` : "")}</span>`;
    }
    this.root.querySelectorAll(".grade-q").forEach((secEl) => {
      const inp = secEl.querySelector("[data-q-score]");
      if (!inp) return;
      const qid = inp.getAttribute("data-q-score");
      const max = Number(inp.max) || 0;
      const v = this.working.scores[qid];
      secEl.classList.toggle("grade-q--bad", v != null && (v < 0 || v > max));
    });
    const sub = this.root.querySelector("[data-g-submit]");
    if (sub) sub.disabled = !(!this._readonly && t.missing === 0 && t.invalid === 0 && !this.submitting);
    // 批次列可能剛從無到有
    const wrap = this.root.querySelector(".grade-wrap");
    const existing = this.root.querySelector(".grade-batchbar");
    const wanted = this._batchBar();
    if (wrap && !existing && wanted) {
      const roster = this.root.querySelector(".grade-roster");
      roster ? roster.insertAdjacentHTML("beforebegin", wanted) : wrap.insertAdjacentHTML("beforeend", wanted);
      this.root.querySelector("[data-g-batch]")?.addEventListener("click", () => this._submitBatch());
    } else if (existing) {
      const n = this.dirty.size;
      if (!n) existing.remove();
      else {
        existing.querySelector("span").textContent = `有 ${n} 張已改未送`;
        existing.querySelector("[data-g-batch]").textContent = `送出全部待送（${n}）`;
      }
    }
  }

  async _nav(dir) {
    const i = this._index();
    const ni = i + dir;
    if (ni < 0 || ni >= this.roster.length) return;
    await this.openAttempt(this.roster[ni].attemptId);
  }

  // ── 登入已過期（連續期都被拒） ──────────────────────────────────────
  // 跟一般錯誤（分數超出配分、網路暫時不通）不同：重試沒有用，唯一的出路是
  // 重新登入。這裡直接給一個按鈕，點下去才跳頁——不是叫使用者自己重新整理
  // 或去別的地方找登入頁。網址帶 return，登入完會自動跳回同一張卷；本機
  // localStorage 鏡射跟登入狀態無關，跳頁前後都還在，不用重打。
  _showAuthExpiredBanner() {
    if (this._authExpiredShown) return;
    this._authExpiredShown = true;
    this._readInputs();
    this._mirror();
    const box = document.createElement("div");
    box.className = "grade-auth-expired";
    box.innerHTML = `<p>登入已過期，需要重新登入才能繼續批改。你目前的分數已經存在這台裝置上，重新登入後會自動回到這一張。</p>
      <button type="button" class="primary-btn" data-g-relogin>重新登入</button>`;
    box.querySelector("[data-g-relogin]").addEventListener("click", () => {
      this._readInputs();
      this._mirror();
      const back = encodeURIComponent(location.pathname + location.search);
      location.href = "/?return=" + back;
    });
    document.body.appendChild(box);
  }

  // ── L2 草稿 ─────────────────────────────────────────────────────────
  async _flushDraft(reason, opts = {}) {
    if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
    const id = this.currentId;
    if (!id || this._readonly) return;
    if (!opts.force && !this.dirty.has(id)) return;
    this._readInputs();
    const payload = { scores: this.working.scores || {}, overall: this.working.overall || "" };
    let res;
    try {
      res = await window.db.saveGradingDraft(id, payload, this.baseRev);
    } catch (e) {
      res = { success: false, message: "草稿存檔失敗（網路）" };
    }
    if (res && res.success) {
      this.draftSavedAt.set(id, Date.now());
      if (res.data && res.data.rev) this.baseRev = Number(res.data.rev) || this.baseRev;
      if (id === this.currentId) this._refreshStatusLine();
    } else if (res && res.authExpired) {
      this._showAuthExpiredBanner();
    } else if (res && /exam_grading_stale/.test((res.error && (res.error.message || res.error)) || res.message || "")) {
      if (id === this.currentId) this._showConflict("draft");
    } else if (reason === "button") {
      toast((res && res.message) || "草稿存檔失敗，稍後會再試");
    }
  }

  // ── 衝突 ────────────────────────────────────────────────────────────
  _showConflict(pendingAction) {
    const box = this.root.querySelector("[data-g-conflict]");
    if (!box) return;
    box.classList.remove("hidden");
    box.innerHTML = `這張考卷剛剛被別人（或你的另一個分頁）改過。
      <button type="button" class="secondary-btn" data-g-reload>重新載入這張</button>
      <button type="button" class="secondary-btn grade-danger" data-g-overwrite>用我的內容覆蓋</button>`;
    box.querySelector("[data-g-reload]")?.addEventListener("click", () => this.openAttempt(this.currentId, { discardLocal: true }));
    box.querySelector("[data-g-overwrite]")?.addEventListener("click", async () => {
      this.baseRev = 0; // 下一次呼叫略過樂觀鎖
      box.classList.add("hidden");
      if (pendingAction === "submit") this._submitOne();
      else this._flushDraft("button", { force: true });
    });
  }

  // ── L3 送出 ─────────────────────────────────────────────────────────
  _gradesFor(id) {
    const cache = this.sheetCache.get(id);
    if (!cache) return null;
    const src = id === this.currentId
      ? this.working
      : (() => { const l = this._loadLocal(id); return l ? { scores: l.scores || {}, overall: l.overall || "" } : null; })();
    if (!src) return null;
    const grades = [];
    for (const q of cache.questions) {
      const v = src.scores ? src.scores[q.questionId] : null;
      if (v == null || Number.isNaN(Number(v))) return null; // 未改完
      if (v < 0 || v > (Number(q.points) || 0)) return null;
      grades.push({ questionId: q.questionId, points: Number(v) });
    }
    return { grades, overall: src.overall || "" };
  }

  async _submitOne(attempt = 0) {
    if (this.submitting) return;
    this._readInputs(); this._mirror();
    const t = this._total();
    if (t.missing || t.invalid) { toast(t.invalid ? "有分數超出配分" : `還有 ${t.missing} 題沒給分`); return; }
    this.submitting = true;
    this._refreshTotalsAndButtons();
    await this._flushDraft("pre-submit", { force: true });

    const g = this._gradesFor(this.currentId);
    if (!g) { this.submitting = false; this._refreshTotalsAndButtons(); toast("這張的分數不完整"); return; }

    let res;
    try {
      res = await window.db.gradeExamAttempt(this.currentId, g.grades, g.overall, this.baseRev);
    } catch (e) {
      res = { success: false, message: "送出失敗（網路）", _network: true };
    }
    this.submitting = false;

    if (res && res.success) {
      this._clearLocal(this.currentId);
      this.dirty.delete(this.currentId);
      this.draftSavedAt.delete(this.currentId);
      const row = this._row(this.currentId);
      if (row) { row.shortGraded = row.shortQuestions ?? row.shortTotal ?? g.grades.length; row.attemptStatus = "graded"; }
      if (res.data && res.data.rev) {
        this.baseRev = Number(res.data.rev) || this.baseRev;
        const c = this.sheetCache.get(this.currentId);
        if (c) c.rev = this.baseRev;
      }
      toast("已送出這一張");
      const i = this._index();
      if (i < this.roster.length - 1) await this.openAttempt(this.roster[i + 1].attemptId);
      else this.render();
      return;
    }
    if (res && res.authExpired) { this._showAuthExpiredBanner(); this._refreshTotalsAndButtons(); return; }
    const emsg = (res && ((res.error && (res.error.message || res.error)) || res.message)) || "";
    if (/exam_grading_stale/.test(emsg)) { this._showConflict("submit"); this._refreshTotalsAndButtons(); return; }
    if (res && res._network && attempt < 4) {
      const wait = 1000 * Math.pow(2, attempt);
      toast(`送出失敗，${Math.round(wait / 1000)} 秒後自動重試…`);
      this._retryTimer = setTimeout(() => this._submitOne(attempt + 1), wait);
      return;
    }
    toast((res && res.message) || "送出失敗，內容已留在本機");
    this._refreshTotalsAndButtons();
  }

  async _submitBatch() {
    if (this.submitting) return;
    this._readInputs(); this._mirror();
    const ids = [...this.dirty];
    const items = [];
    let incomplete = 0;
    for (const id of ids) {
      // 重新登入後，dirty 裡可能有這次還沒開過的卷（題目沒在 sheetCache）→ 先補抓一次
      if (!this.sheetCache.has(id)) {
        try {
          const sr = await window.db.getGradingSheet(id);
          if (sr && sr.success && sr.data) {
            this.sheetCache.set(id, {
              questions: sr.data.questions || [], examinee: sr.data.examinee || {},
              attemptStatus: sr.data.attemptStatus, resultsPublished: !!sr.data.resultsPublished,
              rev: Number(sr.data.rev) || 0
            });
          }
        } catch (_) {}
      }
      const g = this._gradesFor(id);
      if (!g) { incomplete++; continue; }
      const cached = this.sheetCache.get(id);
      const baseRev = id === this.currentId ? this.baseRev : ((cached && cached.rev) || 0);
      items.push({ attemptId: id, grades: g.grades, overallComment: g.overall, baseRev });
    }
    if (!items.length) { toast(incomplete ? `有 ${incomplete} 張還沒改完，沒有可送出的` : "沒有待送出的"); return; }
    this.submitting = true;
    this._refreshTotalsAndButtons();
    let res;
    try {
      res = await window.db.gradeExamAttemptsBulk(items);
    } catch (e) {
      res = { success: false, message: "批次送出失敗（網路）" };
    }
    this.submitting = false;
    if (res && res.authExpired) { this._showAuthExpiredBanner(); this._refreshTotalsAndButtons(); return; }
    if (!res || !res.success || !res.data || !Array.isArray(res.data.results)) {
      toast((res && res.message) || "批次送出失敗，內容都還在本機");
      this._refreshTotalsAndButtons();
      return;
    }
    let ok = 0, fail = 0;
    res.data.results.forEach((r) => {
      if (r.ok) {
        ok++;
        this._clearLocal(r.attemptId);
        this.dirty.delete(r.attemptId);
        this.draftSavedAt.delete(r.attemptId);
        const row = this._row(r.attemptId);
        if (row) { row.shortGraded = row.shortQuestions ?? row.shortTotal ?? 0; row.attemptStatus = "graded"; }
      } else { fail++; }
    });
    toast(`已送出 ${ok} 張${fail ? `，${fail} 張失敗（留在本機）` : ""}${incomplete ? `，另有 ${incomplete} 張未改完` : ""}`);
    // 重新載入目前這張以取得新 rev / 狀態
    await this.openAttempt(this.currentId, { discardLocal: !this.dirty.has(this.currentId) });
  }
}

export function mountGradingWorkspace(opts) {
  const ws = new GradingWorkspace(opts || {});
  window.__gradingWorkspace = ws;
  ws.boot();
  return ws;
}

export default { mountGradingWorkspace };
