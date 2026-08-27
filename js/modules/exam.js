// js/modules/exam.js — 速讀「大測驗」P1：作答流程（宣示 gate → server 計時 → 六題型
// → 送出鎖定 → 成績）。出題與批改 UI 在 P2。此模組不含自動計分，一切以 server 為準。
//
// 依賴全域：state、db（js/db.js）、escapeHTML、hydrateIcons、window.showToast
// 樣式在 index.css 的「大測驗（速讀測驗）作答 UI」區塊。

const SECTION_ORDER = ["truefalse", "single", "multiple", "matching", "ordering", "shortanswer"];
const SECTION_TITLE = {
  truefalse: "一、是非題", single: "二、單選題", multiple: "三、複選題",
  matching: "四、連連看", ordering: "五、事件排序題", shortanswer: "六、簡答題"
};
const SECTION_HINT = {
  truefalse: "正確請選 O，錯誤請選 X。",
  single: "每題僅一個最佳答案。",
  multiple: "每題有兩個以上正確答案，全部選對才得分。",
  matching: "點左邊項目再點右邊項目即可連線，再點一次可取消。整組全對才得 1 分。",
  ordering: "把事件拖進「作答區」依時間先後排列，整題順序全對才得 1 分。",
  shortanswer: "每題以完整句子作答，由管理員人工評分。"
};

const esc = (s) => (typeof escapeHTML === "function" ? escapeHTML(String(s ?? "")) : String(s ?? "")
  .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
const toast = (m) => (typeof window.showToast === "function" ? window.showToast(m) : null);
const cssAttr = (v) => String(v).replace(/["\\]/g, "\\$&");

// ────────────────────────────────────────────────────────────── 後台面板（P1 精簡）
export async function renderExamPanel(root) {
  if (!root) return;
  root.innerHTML = '<div class="admin-user-directory__empty">載入大測驗設定…</div>';

  const feature = await db.getFeatureSetting("speed_reading_exam", false);
  const enabled = !feature.error && feature.enabled === true;

  root.innerHTML = `
    <section class="admin-management-section exam-admin">
      <div class="exam-admin__row">
        <div>
          <h3 class="card-title" style="margin:0;">大測驗（速讀測驗）</h3>
          <p class="exam-admin__hint">測試期功能：僅系統管理員可見。開啟後才會啟用出題、作答與批改。</p>
        </div>
        <button type="button" id="exam-feature-toggle"
          class="${enabled ? "secondary-btn" : "primary-btn"}">${enabled ? "關閉功能" : "開啟功能"}</button>
      </div>
      <div id="exam-admin-body" style="margin-top:1rem;"></div>
    </section>`;

  root.querySelector("#exam-feature-toggle").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const res = await db.updateFeatureSetting("speed_reading_exam", !enabled);
    btn.disabled = false;
    if (res.error) { toast("更新設定失敗"); return; }
    renderExamPanel(root);
  });

  const body = root.querySelector("#exam-admin-body");
  if (!enabled) {
    body.innerHTML = '<div class="admin-user-directory__empty">功能未開啟。開啟後可建立試卷並預覽作答流程。</div>';
    return;
  }

  const paperRes = await db.getExamPaperAdmin();
  if (!paperRes.success) {
    body.innerHTML = `<div class="admin-user-directory__empty">${esc(paperRes.message || "無法載入試卷")}${
      paperRes.error ? "（請確認 migration 0096 與 nlc-data 已部署）" : ""}</div>`;
    return;
  }
  const paper = paperRes.data && paperRes.data.paper;
  const questions = (paperRes.data && paperRes.data.questions) || [];
  const counts = {};
  questions.forEach((q) => { counts[q.section] = (counts[q.section] || 0) + 1; });
  const badge = paper && (paper.status === "published" ? "success" : paper.status === "closed" ? "neutral" : "warning");

  body.innerHTML = `
    ${paper ? `
      <div class="exam-admin__paper">
        <p><strong>${esc(paper.title)}</strong>　<span class="stat-badge stat-badge--${badge}">${esc(paper.status)}</span>　<span class="exam-admin__meta">${esc(paper.mode)}</span></p>
        <p class="exam-admin__meta">開放：${paper.open_at ? esc(paper.open_at) : "未設定"} ～ ${paper.close_at ? esc(paper.close_at) : "未設定"}
          ・限時 ${paper.duration_minutes} 分・滿分 ${paper.total_points}・作答 ${paperRes.data.attemptCount} 人</p>
        <p class="exam-admin__meta">題數：${SECTION_ORDER.map((s) => `${SECTION_TITLE[s].slice(2)} ${counts[s] || 0}`).join("　")}</p>
        <div style="display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.5rem;">
          <button type="button" class="primary-btn" id="exam-preview-run">以我的帳號預覽作答</button>
        </div>
      </div>` : `
      <div class="admin-user-directory__empty">目前沒有試卷。P2 會加入題庫編輯器；現在可先用 SQL 建立一份 <code>mode='test'</code> 的試卷。</div>`}
    <div id="exam-runner-slot" style="margin-top:1rem;"></div>`;

  const runBtn = body.querySelector("#exam-preview-run");
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      mountExamRunner(body.querySelector("#exam-runner-slot"), { paperId: paper.id });
    });
  }
}

// ────────────────────────────────────────────────────────────── 作答流程
export async function mountExamRunner(container, { paperId = null } = {}) {
  if (!container) return;
  const runner = new ExamRunner(container, paperId);
  await runner.boot();
  return runner;
}

class ExamRunner {
  constructor(container, paperId) {
    this.el = container;
    this.paperId = paperId;
    this.paper = null;
    this.attempt = null;
    this.questionsById = {};
    this.RESP = {};
    this.timerId = null;
    this.saveTimer = null;
    this.dirty = false;
    this.submitting = false;
    this._matchResize = null;
    this._onVis = () => { if (document.visibilityState === "hidden") this.flushSave(); };
  }

  async boot() {
    this.el.innerHTML = '<div class="admin-user-directory__empty">載入測驗…</div>';
    const res = await db.getExamForAttempt(this.paperId);
    if (!res.success) { this.el.innerHTML = `<div class="admin-user-directory__empty">${esc(res.message)}</div>`; return; }
    const d = res.data || {};
    if (d.state === "no_paper") { this.el.innerHTML = '<div class="admin-user-directory__empty">目前沒有可作答的試卷。</div>'; return; }
    this.paper = d.paper;
    this.openState = d.state;

    if (d.attempt) {
      this.attempt = d.attempt;
      this.hydrateFromAttempt();
      if (this.attempt.status === "in_progress") this.renderRunner();
      else await this.renderResult();
      return;
    }
    if (this.openState === "not_open") { this.el.innerHTML = this.closedCard("測驗尚未開放作答。"); return; }
    if (this.openState === "closed") { this.el.innerHTML = this.closedCard("測驗已結束。"); return; }
    this.renderPledge();
  }

  closedCard(msg) {
    return `<div class="glass-card exam-closed-card">
      <h3>${esc(this.paper?.title || "速讀測驗")}</h3>
      <p>${esc(msg)}</p></div>`;
  }

  hydrateFromAttempt() {
    const snap = this.attempt.paperSnapshot || {};
    (snap.questions || []).forEach((q) => { this.questionsById[q.id] = q; });
    const saved = this.attempt.savedAnswers || {};
    Object.keys(saved).forEach((qid) => { this.RESP[qid] = saved[qid]; });
  }

  // ── 宣示 gate（規則 1〜6，姓名自動帶入） ──
  renderPledge() {
    const pledge = this.paper.pledge || {};
    const rules = Array.isArray(pledge.rules) ? pledge.rules : [];
    const name = (typeof getDisplayName === "function" ? getDisplayName(state.currentUser) : null)
      || state.currentUser?.name || "";
    const consent = String(pledge.consentTemplate || "{name} 已詳閱並同意以上規則。").replace("{name}", "").trim();

    this.el.innerHTML = `
      <div class="glass-card exam-pledge">
        <h3>✅ ${esc(this.paper.title)}｜測驗宣示</h3>
        <p class="exam-pledge__open">${esc(pledge.openText || "")}</p>
        <ol class="exam-pledge__rules">${rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>
        <div class="exam-pledge__consent">
          <input type="text" id="exam-pledge-name" class="exam-pledge__name" value="${esc(name)}" placeholder="您的姓名">
          ${esc(consent)}
        </div>
        <label class="exam-pledge__agree">
          <input type="checkbox" id="exam-pledge-agree">
          我已詳閱並同意以上全部規則，且了解送出後將以第一次記錄為準、不可重作。
        </label>
        <button type="button" id="exam-pledge-start" class="primary-btn" style="width:100%;" disabled>
          開始作答（${this.paper.durationMinutes} 分鐘）
        </button>
        ${this.openState === "preview" ? '<p class="exam-pledge__note">（預覽模式：測驗尚未正式發佈）</p>' : ""}
      </div>`;

    const nameEl = this.el.querySelector("#exam-pledge-name");
    const agree = this.el.querySelector("#exam-pledge-agree");
    const startBtn = this.el.querySelector("#exam-pledge-start");
    const sync = () => { startBtn.disabled = !(agree.checked && nameEl.value.trim()); };
    nameEl.addEventListener("input", sync);
    agree.addEventListener("change", sync);
    startBtn.addEventListener("click", () => this.start(nameEl.value.trim()));
  }

  async start(pledgeName) {
    this.el.innerHTML = '<div class="admin-user-directory__empty">開始作答…</div>';
    const teamId = state.myReadingTeam?.team?.id || state.readingTeam?.team?.id || null;
    const res = await db.startExamAttempt(this.paper.id, pledgeName, teamId);
    if (!res.success) { this.el.innerHTML = `<div class="admin-user-directory__empty">${esc(res.message)}</div>`; return; }
    return this.boot();
  }

  // ── 作答畫面 ──
  renderRunner() {
    const snap = this.attempt.paperSnapshot || {};
    const layout = this.attempt.layout || {};
    const qOrder = layout.questionOrder || {};
    const bySection = {};
    (snap.questions || []).forEach((q) => { (bySection[q.section] ||= []).push(q); });

    const sectionsHtml = SECTION_ORDER.map((sec) => {
      const list = bySection[sec] || [];
      if (!list.length) return "";
      const order = Array.isArray(qOrder[sec]) && qOrder[sec].length
        ? qOrder[sec] : list.slice().sort((a, b) => a.position - b.position).map((q) => q.id);
      const items = order.map((qid, i) => this.renderQuestion(this.questionsById[qid], i, layout)).join("");
      return `<section class="exam-section">
        <h2 class="exam-section__title">${esc(SECTION_TITLE[sec])}</h2>
        <p class="exam-section__hint">${esc(SECTION_HINT[sec])}</p>
        ${items}
      </section>`;
    }).join("");

    this.el.innerHTML = `
      <div class="exam-timer-bar" id="exam-timer-bar"></div>
      <div id="exam-questions">${sectionsHtml}</div>
      <div class="exam-submit-bar">
        <button type="button" id="exam-submit" class="primary-btn" style="width:100%;">送出答案</button>
      </div>`;

    if (typeof hydrateIcons === "function") hydrateIcons(this.el);
    this.el.querySelectorAll("[data-exam-q]").forEach((node) => this.bindQuestion(node, layout));
    this.el.querySelector("#exam-submit").addEventListener("click", () => this.submit("manual"));

    this.startTimer();
    document.addEventListener("visibilitychange", this._onVis);
    this.scheduleSave();
  }

  // ── 逐題渲染（用 canonical id/index；layout 只決定顯示順序） ──
  renderQuestion(q, idx, layout) {
    if (!q) return "";
    const head = `<p class="exam-q__stem"><span class="exam-q__num">${idx + 1}.</span>${esc(q.payload?.stem || "")}</p>`;
    const wrap = (inner) => `<div class="glass-card exam-q" data-exam-q="${esc(q.id)}" data-section="${q.section}" data-qidx="${idx}">${head}${inner}</div>`;

    if (q.section === "truefalse") {
      const v = this.RESP[q.id];
      return wrap(`<div class="exam-tf-row">
        <label><input type="radio" name="q_${esc(q.id)}" value="true" ${v === true ? "checked" : ""}> O 對</label>
        <label><input type="radio" name="q_${esc(q.id)}" value="false" ${v === false ? "checked" : ""}> X 錯</label>
      </div>`);
    }
    if (q.section === "single" || q.section === "multiple") {
      const opts = q.payload?.options || [];
      const order = (layout.optionOrder || {})[q.id] || opts.map((_, i) => i);
      const multi = q.section === "multiple";
      const cur = multi ? (Array.isArray(this.RESP[q.id]) ? this.RESP[q.id] : []) : this.RESP[q.id];
      const rows = order.map((ci) => {
        const checked = multi ? cur.includes(ci) : String(cur) === String(ci);
        return `<label class="exam-opt">
          <input type="${multi ? "checkbox" : "radio"}" name="q_${esc(q.id)}" value="${ci}" ${checked ? "checked" : ""}>
          <span>${esc(opts[ci])}</span></label>`;
      }).join("");
      return wrap(rows + (multi ? '<p class="exam-q__note">（複選・全對才給分）</p>' : ""));
    }
    if (q.section === "matching") {
      const left = q.payload?.left || [];
      const right = q.payload?.right || [];
      const rOrder = (layout.matchRightOrder || {})[q.id] || right.map((r) => r.id);
      const node = (side, id, text) => `<button type="button" class="exam-match-node" data-side="${side}" data-id="${esc(id)}">
        <span class="exam-match-dot"></span><span class="exam-match-node__label">${esc(text)}</span></button>`;
      const rightById = Object.fromEntries(right.map((r) => [r.id, r.text]));
      return wrap(`
        <div class="exam-match-board" data-qid="${esc(q.id)}">
          <div class="exam-match-col exam-match-col--left">${left.map((l) => node("L", l.id, l.text)).join("")}</div>
          <div class="exam-match-col exam-match-col--right">${rOrder.map((rid) => node("R", rid, rightById[rid])).join("")}</div>
        </div>
        <button type="button" class="exam-match-clear secondary-btn">清除連線</button>`);
    }
    if (q.section === "ordering") {
      const items = q.payload?.items || [];
      const poolOrder = (layout.orderPoolOrder || {})[q.id] || items.map((it) => it.id);
      const byId = Object.fromEntries(items.map((it) => [it.id, it.text]));
      const placed = Array.isArray(this.RESP[q.id]) ? this.RESP[q.id] : [];
      const pool = poolOrder.filter((id) => !placed.includes(id));
      const chip = (id, inAns, k) => `<div class="exam-order-chip" data-id="${esc(id)}">
        ${inAns ? `<span class="exam-order-num">${k + 1}</span>` : '<span class="exam-order-chip__grip">⠿</span>'}
        <span class="exam-order-chip__text">${esc(byId[id])}</span>
        ${inAns ? '<button type="button" class="exam-chip-remove" aria-label="移回待排序">✕</button>' : ""}
      </div>`;
      return wrap(`
        <p class="exam-order-hint">把下方事件拖進「作答區」，並在作答區內拖動調整順序（點一下也可加入）。</p>
        <div class="exam-order-answer" data-qid="${esc(q.id)}">
          ${placed.length ? placed.map((id, k) => chip(id, true, k)).join("") : '<span class="exam-order-empty">拖曳事件到這裡排序</span>'}
        </div>
        <p class="exam-order-sub">待排序事件</p>
        <div class="exam-order-pool" data-qid="${esc(q.id)}">
          ${pool.length ? pool.map((id) => chip(id, false)).join("") : '<span class="exam-order-empty">已全部放入作答區</span>'}
        </div>`);
    }
    if (q.section === "shortanswer") {
      const max = q.payload?.maxPoints ?? q.points ?? 10;
      return wrap(`
        <p class="exam-q__note">（${max} 分・人工評分）</p>
        <textarea class="form-control" data-sa="${esc(q.id)}" rows="5" placeholder="請在此作答" style="width:100%;">${esc(this.RESP[q.id] || "")}</textarea>`);
    }
    return "";
  }

  bindQuestion(node, layout) {
    const qid = node.dataset.examQ;
    const sec = node.dataset.section;
    if (sec === "truefalse") {
      node.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => {
        this.RESP[qid] = inp.value === "true"; this.markDirty();
      }));
    } else if (sec === "single") {
      node.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => {
        this.RESP[qid] = Number(inp.value); this.markDirty();
      }));
    } else if (sec === "multiple") {
      node.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => {
        const set = new Set(Array.isArray(this.RESP[qid]) ? this.RESP[qid] : []);
        inp.checked ? set.add(Number(inp.value)) : set.delete(Number(inp.value));
        this.RESP[qid] = [...set].sort((a, b) => a - b); this.markDirty();
      }));
    } else if (sec === "matching") {
      this.bindMatch(node, qid);
    } else if (sec === "ordering") {
      this.bindOrder(node, qid);
    } else if (sec === "shortanswer") {
      const ta = node.querySelector("textarea");
      ta.addEventListener("input", () => { this.RESP[qid] = ta.value; this.markDirty(); });
    }
  }

  // ── 連連看：拉線 ──
  bindMatch(node, qid) {
    const board = node.querySelector(".exam-match-board");
    const cur = (this.RESP[qid] && typeof this.RESP[qid] === "object") ? this.RESP[qid] : (this.RESP[qid] = {});
    let pending = null;
    const paint = () => {
      board.querySelectorAll(".exam-match-node").forEach((n) => {
        const id = n.dataset.id, side = n.dataset.side;
        const linked = side === "L" ? !!cur[id] : Object.values(cur).includes(id);
        n.classList.toggle("is-linked", linked);
        n.classList.toggle("is-active", side === "L" && pending === id);
      });
      this.drawMatchLines(board, qid);
    };
    board.addEventListener("click", (ev) => {
      const n = ev.target.closest(".exam-match-node"); if (!n) return;
      const id = n.dataset.id;
      if (n.dataset.side === "L") {
        pending = (pending === id) ? null : id;
      } else {
        const usedBy = Object.keys(cur).find((l) => cur[l] === id);
        if (pending) {
          if (cur[pending] === id) delete cur[pending];
          else { if (usedBy) delete cur[usedBy]; cur[pending] = id; }
          pending = null;
        } else if (usedBy) delete cur[usedBy];
      }
      this.markDirty(); paint();
    });
    node.querySelector(".exam-match-clear").addEventListener("click", () => {
      Object.keys(cur).forEach((k) => delete cur[k]); pending = null; this.markDirty(); paint();
    });
    paint();
    if (!this._matchResize) {
      this._matchResize = () => this.el.querySelectorAll(".exam-match-board").forEach((b) => this.drawMatchLines(b, b.dataset.qid));
      window.addEventListener("resize", this._matchResize);
    }
  }

  drawMatchLines(board, qid) {
    // 連線用 createElementNS 動態建立（避免在原始碼放 SVG 字面標記）
    const NS = "http://www.w3.org/2000/svg";
    let svg = board.querySelector(".match-lines");
    if (!svg) {
      svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "match-lines");
      board.insertBefore(svg, board.firstChild);
    }
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const cur = (this.RESP[qid] && typeof this.RESP[qid] === "object") ? this.RESP[qid] : {};
    const br = board.getBoundingClientRect();
    const dot = (side, id) => board.querySelector(`.exam-match-node[data-side="${side}"][data-id="${cssAttr(id)}"] .exam-match-dot`);
    Object.entries(cur).forEach(([l, r]) => {
      const la = dot("L", l), rb = dot("R", r); if (!la || !rb) return;
      const a = la.getBoundingClientRect(), b = rb.getBoundingClientRect();
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", a.left + a.width / 2 - br.left);
      line.setAttribute("y1", a.top + a.height / 2 - br.top);
      line.setAttribute("x2", b.left + b.width / 2 - br.left);
      line.setAttribute("y2", b.top + b.height / 2 - br.top);
      line.setAttribute("stroke", "var(--color-brand)");
      line.setAttribute("stroke-width", "2.5");
      line.setAttribute("stroke-linecap", "round");
      svg.appendChild(line);
    });
  }

  // ── 事件排序：積木拖曳 ──
  bindOrder(node, qid) {
    const list = Array.isArray(this.RESP[qid]) ? this.RESP[qid] : (this.RESP[qid] = []);
    let drag = null;
    const zoneAt = (x, y) => { const t = document.elementFromPoint(x, y); return t && t.closest(".exam-order-answer, .exam-order-pool"); };
    const idxAt = (zone, y, skip) => {
      const chips = [...zone.querySelectorAll(".exam-order-chip")].filter((c) => c.dataset.id !== skip);
      for (let k = 0; k < chips.length; k++) {
        const r = chips[k].getBoundingClientRect();
        if (y < r.top + r.height / 2) return k;
      }
      return chips.length;
    };
    node.querySelectorAll(".exam-order-chip").forEach((chipEl) => {
      chipEl.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest(".exam-chip-remove")) return;
        ev.preventDefault();
        const rect = chipEl.getBoundingClientRect();
        drag = { id: chipEl.dataset.id, sx: ev.clientX, sy: ev.clientY, moved: false, ghost: null,
          dx: ev.clientX - rect.left, dy: ev.clientY - rect.top, w: rect.width };
        drag.fromPool = !!chipEl.closest(".exam-order-pool");
        try { chipEl.setPointerCapture(ev.pointerId); } catch (_) {}
      });
      chipEl.addEventListener("pointermove", (ev) => {
        if (!drag || drag.id !== chipEl.dataset.id) return;
        if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 6) return;
        if (!drag.moved) {
          drag.moved = true;
          const g = chipEl.cloneNode(true);
          g.classList.add("is-ghost");
          g.style.width = drag.w + "px";
          document.body.appendChild(g); drag.ghost = g;
          chipEl.classList.add("is-placeholder");
        }
        drag.ghost.style.left = (ev.clientX - drag.dx) + "px";
        drag.ghost.style.top = (ev.clientY - drag.dy) + "px";
      });
      const finish = (ev) => {
        if (!drag || drag.id !== chipEl.dataset.id) return;
        const id = drag.id, cur = list.indexOf(id);
        if (!drag.moved) {
          if (drag.fromPool) list.push(id);
        } else {
          const zone = zoneAt(ev.clientX, ev.clientY);
          if (zone && zone.classList.contains("exam-order-answer")) {
            let i = idxAt(zone, ev.clientY, id);
            if (cur !== -1) { list.splice(cur, 1); if (cur < i) i--; }
            list.splice(i, 0, id);
          } else if (zone && zone.classList.contains("exam-order-pool")) {
            if (cur !== -1) list.splice(cur, 1);
          }
        }
        if (drag.ghost) drag.ghost.remove();
        drag = null;
        this.markDirty();
        this.rerenderOrder(qid);
      };
      chipEl.addEventListener("pointerup", finish);
      chipEl.addEventListener("pointercancel", finish);
    });
    node.querySelectorAll(".exam-chip-remove").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const id = btn.closest(".exam-order-chip").dataset.id;
      const k = list.indexOf(id); if (k !== -1) list.splice(k, 1);
      this.markDirty(); this.rerenderOrder(qid);
    }));
  }

  rerenderOrder(qid) {
    const node = this.el.querySelector(`[data-exam-q="${cssAttr(qid)}"]`);
    if (!node) return;
    const q = this.questionsById[qid];
    const idx = Number(node.dataset.qidx) || 0;
    const fresh = document.createElement("div");
    fresh.innerHTML = this.renderQuestion(q, idx, this.attempt.layout || {});
    node.replaceWith(fresh.firstElementChild);
    this.bindQuestion(this.el.querySelector(`[data-exam-q="${cssAttr(qid)}"]`), this.attempt.layout || {});
  }

  // ── 計時（server 權威） ──
  startTimer() {
    const started = Date.now();
    const base = Number(this.attempt.secondsRemaining || 0);
    const tick = () => {
      const left = Math.max(0, base - Math.floor((Date.now() - started) / 1000));
      const bar = this.el.querySelector("#exam-timer-bar");
      if (bar) {
        const mm = String(Math.floor(left / 60)).padStart(2, "0");
        const ss = String(left % 60).padStart(2, "0");
        bar.textContent = `剩餘時間　${mm}:${ss}`;
        bar.classList.toggle("exam-timer-bar--low", left < 300);
      }
      if (left <= 0) { this.stopTimer(); this.submit("timeout"); }
    };
    tick();
    this.timerId = setInterval(tick, 1000);
  }
  stopTimer() { if (this.timerId) clearInterval(this.timerId); this.timerId = null; }

  // ── 自動暫存 ──
  markDirty() { this.dirty = true; }
  scheduleSave() { this.saveTimer = setInterval(() => this.flushSave(), 20000); }
  async flushSave() {
    if (!this.dirty || !this.attempt || this.attempt.status !== "in_progress" || this.submitting) return;
    this.dirty = false;
    const res = await db.saveExamProgress(this.attempt.id, this.collectAnswers());
    if (!res.success && res.error) this.dirty = true;
  }

  collectAnswers() {
    const out = {};
    Object.keys(this.RESP).forEach((qid) => {
      const v = this.RESP[qid];
      if (v === undefined || v === null || v === "") return;
      if (Array.isArray(v) && !v.length) return;
      if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) return;
      out[qid] = v;
    });
    return out;
  }

  // ── 送出 ──
  async submit(reason) {
    if (this.submitting) return;
    if (reason === "manual" && !confirm("確定送出？送出後即鎖定，記錄以第一次為準、不可重作。")) return;
    this.submitting = true;
    this.stopTimer();
    if (this.saveTimer) clearInterval(this.saveTimer);
    const btn = this.el.querySelector("#exam-submit");
    if (btn) { btn.disabled = true; btn.textContent = "送出中…"; }
    const res = await db.submitExamAttempt(this.attempt.id, this.collectAnswers(), reason);
    document.removeEventListener("visibilitychange", this._onVis);
    if (!res.success) {
      this.submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = "送出答案"; }
      toast(res.message || "送出失敗");
      return;
    }
    this.attempt.status = res.data?.status || "submitted";
    await this.renderResult(res.data);
  }

  // ── 成績 / 已送出 ──
  async renderResult(submitData) {
    this.stopTimer();
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    if (this._matchResize) { window.removeEventListener("resize", this._matchResize); this._matchResize = null; }
    document.removeEventListener("visibilitychange", this._onVis);

    const res = await db.getMyExamResult(this.paper.id);
    const d = res.success ? (res.data || {}) : {};
    const graded = d.state === "graded";
    const auto = d.autoScore ?? submitData?.autoScore ?? "—";
    const total = d.totalScore ?? submitData?.totalScore;

    this.el.innerHTML = `
      <div class="glass-card" style="padding:1.4rem 1.5rem;">
        <h3 style="margin:0 0 .5rem;">${esc(this.paper.title)}</h3>
        <div class="exam-result__banner">
          測驗已送出，記錄以第一次為準、不可重作。<br>
          自動計分（一～五大題）：<strong>${auto}</strong> 分
          ${graded ? `　｜　簡答題：<strong>${d.manualScore ?? "—"}</strong> 分　｜　總分：<strong>${total ?? "—"}</strong> 分`
                   : "<br>簡答題（第六大題）待管理員人工評分，完成後會通知你。"}
        </div>
        ${Array.isArray(d.answers) && d.answers.length ? `
          <details>
            <summary class="exam-result__summary">查看逐題結果</summary>
            <div class="exam-result__list">
              ${d.answers.map((a) => `<div class="exam-result__row">
                第 ${a.position} 題（${esc(SECTION_TITLE[a.section]?.slice(2) || a.section)}）：
                ${a.section === "shortanswer"
                  ? `${a.awardedPoints != null ? `<strong>${a.awardedPoints} 分</strong>` : "待批改"}${
                      a.graderComment ? `<br>評語：${esc(a.graderComment)}` : ""}`
                  : (a.autoCorrect ? '<span class="exam-ok">✓ 答對</span>' : '<span class="exam-bad">✗ 答錯</span>')}
              </div>`).join("")}
            </div>
          </details>` : ""}
      </div>`;
  }
}

export default { renderExamPanel, mountExamRunner };
