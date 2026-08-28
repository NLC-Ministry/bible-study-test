// js/modules/exam.js — 速讀「大測驗」P1：滿版作答頁（宣示 gate → server 計時 → 六題型
// → 送出鎖定 → 成績）。出題與批改 UI 在 P2。不含自動計分，一切以 server 為準。
//
// 設計重點：
//  · 滿版獨立頁：#exam-fullscreen 掛在 <body>，蓋掉 app chrome，不受換 tab / 重繪影響
//  · 計時以 server 的 deadlineAt（絕對時間）為準，背景暫停 / 裝置休眠回來仍正確
//  · 每 15 秒 + 切到背景 flush 到 server；同時鏡射到 localStorage，重整 / 當掉不丟答案
//  · 切 App / 螢幕鎖回來（visibilitychange / pageshow）→ resync：重抓 attempt、
//    校正剩餘時間、補回 server 已存的答案；若已被送出則切到成績頁
//  · token 刷新由 db.js 透明處理；送出失敗自動重試數次
//
// 依賴全域：state、db（js/db.js）、escapeHTML、hydrateIcons、window.showToast

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 「目前有一份作答中的大測驗」的旗標 —— 讓 app 重整 / iOS 背景回收後能自動重開滿版頁
const ACTIVE_KEY = "exam_active_paper";
const setActiveExam = (id) => { try { localStorage.setItem(ACTIVE_KEY, String(id)); } catch (_) {} };
const clearActiveExam = () => { try { localStorage.removeItem(ACTIVE_KEY); } catch (_) {} };
const getActiveExam = () => { try { return localStorage.getItem(ACTIVE_KEY); } catch (_) { return null; } };

// app 啟動 / 前景喚醒時呼叫：若有作答中的測驗且滿版頁不在，就自動重開
export async function maybeResumeExam() {
  if (document.getElementById("exam-fullscreen")) return null;
  const paperId = getActiveExam();
  if (!paperId) return null;
  return mountExamRunner({ paperId });
}

// ══════════════════════════════════════════════════════════════ 後台面板（P2：題庫編輯 + 批改）
const SECTION_TARGET_DEFAULT = { truefalse: 20, single: 20, multiple: 10, matching: 10, ordering: 10, shortanswer: 3 };
let examAdminSubview = "bank";          // notice | bank | meta | grade | stats
let examAdminGradeFilter = "pending";   // pending | graded | all
let examAdminPaperId = null;            // 目前選中的試卷（null = 最新那份）

const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const lines = (t) => String(t || "").split("\n").map((s) => s.trim()).filter(Boolean);
const parseIdText = (arr) => arr.map((r) => {
  const i = r.indexOf("|");
  return i < 0 ? { id: r.trim(), text: "" } : { id: r.slice(0, i).trim(), text: r.slice(i + 1).trim() };
});

export async function renderExamPanel(root) {
  if (!root) return;

  // 外殼只建一次；重繪時不清空整塊（避免整頁閃動），並記住捲動位置最後還原
  let body = root.querySelector("#exam-admin-body");
  if (!body) {
    root.innerHTML = `
      <section class="admin-management-section exam-admin">
        <div class="exam-admin__row">
          <div>
            <h3 class="card-title" style="margin:0;">大測驗（速讀測驗）</h3>
            <p class="exam-admin__hint">功能開關在「系統管理 → 功能開放設定」。這裡負責出題、發佈、批改與預覽。</p>
          </div>
        </div>
        <div id="exam-admin-body" style="margin-top:1rem;"><div class="admin-user-directory__empty">載入大測驗設定…</div></div>
      </section>`;
    body = root.querySelector("#exam-admin-body");
  }
  const _scrollY = window.scrollY;
  const keepScroll = () => requestAnimationFrame(() => window.scrollTo(0, _scrollY));

  const feature = await db.getFeatureSetting("speed_reading_exam", false);
  if (feature.error || feature.enabled !== true) {
    body.innerHTML = '<div class="admin-user-directory__empty">「大測驗」功能未開啟。請到「系統管理 → 功能開放設定」開啟後再回來。</div>';
    return;
  }

  const paperRes = await db.getExamPaperAdmin(examAdminPaperId);
  if (!paperRes.success) {
    body.innerHTML = `<div class="admin-user-directory__empty">${esc(paperRes.message || "無法載入試卷")}${
      paperRes.error ? "（請確認 migration 0096～0100 與 nlc-data 已部署）" : ""}</div>`;
    return;
  }
  const papers = (paperRes.data && paperRes.data.papers) || [];
  const paper = paperRes.data && paperRes.data.paper;
  const questions = (paperRes.data && paperRes.data.questions) || [];
  const attemptCount = paperRes.data?.attemptCount || 0;
  // 目前選中的試卷已被刪 → 退回最新那份
  if (examAdminPaperId && !paper) { examAdminPaperId = null; renderExamPanel(root); return; }
  if (paper) examAdminPaperId = paper.id;

  const rerender = () => renderExamPanel(root);
  const createPaper = async () => {
    const res = await db.upsertExamPaper({ title: "速讀測驗", mode: "test", section_targets: SECTION_TARGET_DEFAULT });
    if (!res.success) { toast(res.message || "建立失敗"); return; }
    examAdminPaperId = res.data?.id || null;
    rerender();
  };
  const statusZh = { draft: "草稿", published: "進行中", closed: "已關閉" };
  const pickerBar = `
    <div class="exam-admin__picker">
      <label>試卷
        <select class="form-control" id="exam-paper-picker">
          ${papers.map((p) => `<option value="${esc(p.id)}" ${p.id === (paper && paper.id) ? "selected" : ""}>${p.mode === "live" ? "【正式】" : "【測試】"}${esc(p.title)}｜${esc(statusZh[p.status] || p.status)}｜${p.questionCount} 題${p.attemptCount ? "｜作答 " + p.attemptCount : ""}</option>`).join("")}
        </select>
      </label>
      <button type="button" class="secondary-btn" id="exam-create-paper">＋ 建立新試卷</button>
    </div>
    <p class="exam-admin__meta">測試版 →（改好題目）→「推上正式版」→ 在上方下拉切到【正式】那份，才能編預告文、發佈給會友。</p>`;
  const wirePicker = () => {
    body.querySelector("#exam-paper-picker")?.addEventListener("change", (e) => {
      examAdminPaperId = e.target.value || null; rerender();
    });
    body.querySelector("#exam-create-paper")?.addEventListener("click", createPaper);
  };

  if (!paper) {
    body.innerHTML = `${papers.length ? pickerBar : ""}
      <div class="exam-admin__paper">
        <p class="exam-admin__meta">${papers.length ? "請從上方選一份試卷，或" : "目前沒有試卷。"}建立一份後即可開始出題。</p>
        ${papers.length ? "" : '<button type="button" class="primary-btn" id="exam-create-paper">建立新試卷</button>'}
      </div>`;
    wirePicker();
    body.querySelector(".exam-admin__paper #exam-create-paper")?.addEventListener("click", createPaper);
    return;
  }

  const isLive = paper.mode === "live";
  const isTest = !isLive;
  const who = isLive ? "全體會友" : "僅系統管理員（演練用，不會出現在會友端）";
  const hasShortSection = !!examSectionCfg(paper).shortanswer;   // 沒選「簡答題」→ 隱藏批改分頁
  const canEditPaper = isTest;   // 正式版不提供編輯，題目與設定一律由測試版「推上正式版」
  const hasNotice = isLive;      // 測試版不用預告文（預告文只給會友端的正式版）
  if (examAdminSubview === "grade" && !hasShortSection) examAdminSubview = "bank";
  if (!canEditPaper && (examAdminSubview === "bank" || examAdminSubview === "meta")) examAdminSubview = "notice";
  if (!hasNotice && examAdminSubview === "notice") examAdminSubview = "bank";
  const annPub = paper.announcement_published === true;
  const noticeReady = !!((paper.announcement || {}).headline || "").trim() && !!((paper.announcement || {}).body || "").trim();

  const badge = paper.status === "published" ? "success" : "neutral";
  const statusLabel = { draft: "草稿（可編輯）", published: "測驗進行中", closed: "已關閉" }[paper.status] || paper.status;
  const modeBadge = `　<span class="stat-badge stat-badge--${isLive ? "brand" : "neutral"}">${isLive ? "正式版" : "測試版"}</span>`;
  const annBadge = annPub
    ? '　<span class="stat-badge stat-badge--brand">預告文已發佈</span>'
    : '　<span class="stat-badge stat-badge--neutral">預告文未發佈</span>';

  const actions = [
    `<a class="secondary-btn" href="exam.html?paper=${encodeURIComponent(paper.id)}&preview=1" target="_blank" rel="noopener">預覽試卷</a>`
  ];
  const hints = [];

  // ── 預告文（只有正式版有；獨立於 status，不鎖題庫）──
  if (hasNotice) {
    if (!annPub && paper.status !== "closed") {
      if (noticeReady) {
        actions.push('<button type="button" class="primary-btn" data-exam-act="announce">發佈預告文</button>');
        hints.push(`發佈預告文後，${who}的首頁會出現預告區塊。`);
      } else {
        hints.push("在「預告文」分頁填好標題與內容後，這裡才會出現「發佈預告文」按鈕。");
      }
    } else if (annPub) {
      actions.push('<button type="button" class="secondary-btn" data-exam-act="unannounce">撤下預告文</button>');
    }
  }

  // 「改回草稿」只在「已關閉」狀態才出現（測驗進行中不提供——要改題請先按「關閉測驗」）；
  // 且正式卷若已有作答紀錄仍不給（避免動到已計分結果），測試卷則不限。
  const canRevert = paper.status === "closed" && (paper.mode === "test" || attemptCount === 0);

  // ── 測驗本身（status）── 正式版要先發預告文才能發佈；測試版直接發佈
  if (paper.status === "draft") {
    if (isTest || annPub) {
      actions.push(`<button type="button" class="primary-btn" data-exam-act="publish">${isTest ? "發佈（開放測試作答）" : "發佈測驗"}</button>`);
      hints.push(isTest
        ? "測試版發佈後，管理員可從「測試作答」走完整流程；不會出現在會友端。"
        : "按「發佈測驗」後，開放時間內全體會友即可作答（發佈後題庫鎖定）。");
    } else {
      hints.push("正式版要先「發佈預告文」才能發佈測驗。");
    }
  } else if (paper.status === "published") {
    actions.push(`<a class="primary-btn" href="exam.html?paper=${encodeURIComponent(paper.id)}" target="_blank" rel="noopener">${isLive ? "正式作答" : "測試作答"}</a>`);
    actions.push('<button type="button" class="secondary-btn" data-exam-act="close">關閉測驗</button>');
    hints.push("測驗進行中，開放時間內即可作答。要改題目，請先按「關閉測驗」再改回草稿。");
  } else if (paper.status === "closed") {
    if (canRevert) actions.push('<button type="button" class="secondary-btn" data-exam-act="reopen">改回草稿</button>');
    hints.push(isLive && !canRevert
      ? "正式測驗已結束，請在「簡答批改」「統計」分頁進行結算與成績公布。"
      : "測驗已關閉，不再接受作答。");
  }

  // 清除作答紀錄：只有測試卷、且有紀錄時提供（獨立於「改回草稿」，方便不改題目直接重測）
  if (isTest && attemptCount > 0) {
    actions.push(`<button type="button" class="secondary-btn" data-exam-act="reset">清除作答紀錄（${attemptCount}）</button>`);
    hints.push("「清除作答紀錄」只作用在測試卷，清掉後可從宣示畫面重新測試（不影響題目與設定）。");
  }

  // 推上正式版 / 前往對應的另一份。
  const liveOf = isTest ? papers.find((p) => p.mode === "live" && p.pushedFromId === paper.id) : null;
  if (isTest) {
    actions.push('<button type="button" class="primary-btn" data-exam-act="push">推上正式版</button>');
    if (liveOf) actions.push(`<button type="button" class="secondary-btn" data-exam-act="goto" data-goto="${esc(liveOf.id)}">前往正式版 →</button>`);
    hints.push(liveOf
      ? "「推上正式版」會把最新的題目與設定同步到正式版；正式版若已發佈會退回草稿要重新發佈。要編正式版的預告文 / 發佈給會友，按「前往正式版」。"
      : "題目改好後按「推上正式版」，系統會自動建立對應的正式版，並切過去讓你編預告文、發佈給會友。");
  } else if (paper.pushed_from_id) {
    actions.push(`<button type="button" class="secondary-btn" data-exam-act="goto" data-goto="${esc(paper.pushed_from_id)}">← 前往測試版</button>`);
    hints.push("這份正式版的題目由測試版「推上正式版」而來，只能在此編預告文與發佈；要改題請回測試版。");
  }
  const actionHint = hints.join(" ");

  body.innerHTML = `
    ${pickerBar}
    <div class="exam-admin__paper">
      <p><strong>${esc(paper.title)}</strong>${modeBadge}　<span class="stat-badge stat-badge--${badge}">${esc(statusLabel)}</span>${annBadge}</p>
      <div class="exam-admin__actions">${actions.join("")}</div>
      ${actionHint ? `<p class="exam-admin__meta">${esc(actionHint)}</p>` : ""}
    </div>
    <nav class="exam-admin__subnav">
      ${hasNotice ? `<button type="button" data-exam-sub="notice" class="${examAdminSubview === "notice" ? "active" : ""}">預告文</button>` : ""}
      ${canEditPaper ? `<button type="button" data-exam-sub="bank" class="${examAdminSubview === "bank" ? "active" : ""}">題庫編輯</button>
      <button type="button" data-exam-sub="meta" class="${examAdminSubview === "meta" ? "active" : ""}">試卷設定</button>` : ""}
      ${hasShortSection ? `<button type="button" data-exam-sub="grade" class="${examAdminSubview === "grade" ? "active" : ""}">簡答批改</button>` : ""}
      <button type="button" data-exam-sub="stats" class="${examAdminSubview === "stats" ? "active" : ""}">統計</button>
    </nav>
    <div id="exam-admin-sub"></div>`;

  wirePicker();

  // 子分頁切換：只換 #exam-admin-sub 這一塊 + 切 nav 的 active，不整塊重繪、不重打 API
  const renderSub = () => {
    const sub = body.querySelector("#exam-admin-sub");
    if (!sub) return;
    if (examAdminSubview === "notice") renderExamNoticeForm(sub, paper, rerender);
    else if (examAdminSubview === "grade") renderExamGrading(sub, paper.id);
    else if (examAdminSubview === "stats") renderExamStats(sub, paper.id, hasShortSection);
    else if (!canEditPaper) sub.innerHTML = '<div class="admin-user-directory__empty">正式版的題目與試卷設定不提供編輯，一律由對應的測試版按「推上正式版」維護。要查看題目請用上方「預覽試卷」。</div>';
    else if (examAdminSubview === "meta") renderExamMetaForm(sub, paper, rerender);
    else renderExamQuestionBank(sub, paper, questions, rerender);
  };
  body.querySelectorAll("[data-exam-sub]").forEach((b) => b.addEventListener("click", () => {
    if (examAdminSubview === b.dataset.examSub) return;
    examAdminSubview = b.dataset.examSub;
    body.querySelectorAll("[data-exam-sub]").forEach((x) => x.classList.toggle("active", x === b));
    renderSub();
  }));
  body.querySelectorAll("[data-exam-act]").forEach((b) => b.addEventListener("click", async () => {
    const act = b.dataset.examAct;
    if (act === "goto") {
      examAdminPaperId = b.dataset.goto || null;
      examAdminSubview = "bank";
      rerender();
      return;
    }
    if (act === "push") {
      if (!confirm("把這份測試卷的題目與試卷設定複製到對應的正式版？\n（正式版的預告文與發佈狀態不受影響；若正式版已發佈會退回草稿。）")) return;
      b.disabled = true;
      const r = await db.pushExamToLive(paper.id);
      b.disabled = false;
      if (!r.success) { toast(r.message || "推送失敗"); return; }
      toast((r.data && r.data.created) ? "已建立正式版並帶入內容"
        : (r.data && r.data.reverted) ? "正式版已更新，並退回草稿（請重新發佈）" : "正式版內容已更新");
      if (r.data && r.data.livePaperId) examAdminPaperId = r.data.livePaperId;
      rerender();
      return;
    }
    if (act === "announce" && !confirm("將把這份預告文發佈到全體會友的首頁。確定？")) return;
    if (act === "unannounce" && !confirm("撤下後，會友首頁就不會再顯示這份測驗的預告區塊。確定？")) return;
    if (act === "publish" && !confirm(isTest
      ? "將開放「測試作答」——只有系統管理員能進入，不會出現在會友端。發佈後題庫會鎖定。確定？"
      : "將開放作答（開放時間內全體會友可作答），發佈後題庫會鎖定。確定？")) return;
    if (act === "reopen" && !confirm("把已關閉的測驗改回草稿以便修改題目？（預告文仍保留在首頁）")) return;
    if (act === "reset" && !confirm(`確定清除這份測試卷的 ${attemptCount} 筆作答紀錄？（無法復原）`)) return;
    b.disabled = true;
    let res;
    if (act === "announce") res = await db.publishExamAnnouncement(paper.id);
    else if (act === "unannounce") res = await db.unpublishExamAnnouncement(paper.id);
    else if (act === "publish") res = await db.publishExam(paper.id);
    else if (act === "close") res = await db.setExamStatus(paper.id, "closed");
    else if (act === "reset") res = await db.resetExamAttempts(paper.id);
    else if (act === "reopen") {
      res = await db.setExamStatus(paper.id, "draft");
      // 測試卷改回草稿後，順手問要不要一併清掉舊作答紀錄（題目一改，舊分數就對不上了）
      if (res.success && paper.mode === "test" && attemptCount > 0
          && confirm(`已改回草稿。要一併清除舊的 ${attemptCount} 筆作答紀錄嗎？（改完題目建議清除，否則新舊分數會混在一起）`)) {
        const r2 = await db.resetExamAttempts(paper.id);
        if (!r2.success) toast(r2.message || "作答紀錄清除失敗");
      }
    }
    b.disabled = false;
    if (!res.success) { toast(res.message || "操作失敗"); return; }
    toast(
      act === "announce" ? "預告文已發佈到會友首頁"
      : act === "unannounce" ? "已撤下預告文"
      : act === "publish" ? (isTest ? "已開放測試作答（僅系統管理員）" : "測驗已發佈，開放時間內可作答")
      : act === "close" ? "測驗已關閉"
      : act === "reset" ? `已清除 ${res.data?.deletedAttempts ?? ""} 筆作答紀錄`
      : "已改回草稿"
    );
    rerender();
  }));

  renderSub();
  keepScroll();
}

// ── 預告文編輯（首頁 8/30 宣示 banner 的內容來源）──
function renderExamNoticeForm(host, paper, rerender) {
  const a = paper.announcement || {};
  const locked = paper.status === "closed";
  const annPub = paper.announcement_published === true;
  const openTxt = paper.open_at ? toLocalInput(paper.open_at).replace("T", " ") : "（尚未設定）";
  const closeTxt = paper.close_at ? toLocalInput(paper.close_at).replace("T", " ") : "（尚未設定）";
  host.innerHTML = `
    <div class="exam-admin__form">
      <p class="exam-admin__hint">這裡的內容會顯示在會友首頁的「速讀測驗」置頂區塊。${
        locked ? "測驗已關閉，預告文已鎖定。"
        : annPub ? "預告文已發佈、正在首頁顯示，仍可在此微調文案並儲存。"
        : "填好標題與內容後，回上方按「發佈預告文」即可上線（不影響試卷草稿狀態）。"}</p>
      <label>標題（必填）
        <input class="form-control" data-n="headline" maxlength="40" value="${esc(a.headline || "")}" ${locked ? "disabled" : ""}></label>
      <label>內容（必填）
        <textarea class="form-control" data-n="body" rows="4" ${locked ? "disabled" : ""} placeholder="例：8/30 00:00 起開放 24 小時，作答限時 75 分鐘。開始前請先詳閱測驗宣示規則。">${esc(a.body || "")}</textarea></label>
      <label>入口按鈕文字（選填，預設「進入測驗」）
        <input class="form-control" data-n="ctaLabel" maxlength="12" value="${esc(a.ctaLabel || "")}" ${locked ? "disabled" : ""}></label>
      <p class="exam-admin__meta">開放時間：${esc(openTxt)} ～ ${esc(closeTxt)}（於「試卷設定」分頁調整）</p>
      ${locked ? "" : '<button type="button" class="primary-btn" id="exam-notice-save">儲存預告文</button>'}
    </div>`;
  if (locked) return;
  host.querySelector("#exam-notice-save")?.addEventListener("click", async (e) => {
    const payload = {
      headline: host.querySelector('[data-n="headline"]').value.trim(),
      body: host.querySelector('[data-n="body"]').value.trim(),
      ctaLabel: host.querySelector('[data-n="ctaLabel"]').value.trim()
    };
    e.target.disabled = true;
    const res = await db.saveExamAnnouncement(paper.id, payload);
    e.target.disabled = false;
    if (!res.success) { toast(res.message || "儲存失敗"); return; }
    toast("預告文已儲存");
    rerender();
  });
}

// ── 統計報表（整體 / 大區 / 牧區 / 小組 / 逐題正確率 / 名單）──
async function renderExamStats(host, paperId, hasShort = true) {
  host.innerHTML = '<div class="admin-user-directory__empty">載入統計…</div>';
  const res = await db.getExamStats(paperId);
  if (!res.success) { host.innerHTML = `<div class="admin-user-directory__empty">${esc(res.message || "載入失敗")}</div>`; return; }
  const d = res.data || {};
  const o = d.overall || {};
  const num = (v) => (v == null ? "—" : v);
  const rateBar = (r) => {
    const pct = Math.round((r || 0) * 100);
    return `<span class="exam-stats__bar"><span class="exam-stats__bar-fill" style="width:${pct}%"></span></span> ${pct}%`;
  };
  const tbl = (rows, cols) => `<table class="exam-stats__table"><thead><tr>${cols.map((c) => `<th>${esc(c.h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${c.f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

  host.innerHTML = `
    <div class="exam-stats__tiles">
      <div class="exam-stats__tile"><span>作答</span><strong>${num(o.submitted)}</strong></div>
      <div class="exam-stats__tile"><span>已批改</span><strong>${num(o.graded)}</strong></div>
      <div class="exam-stats__tile"><span>作答中</span><strong>${num(o.inProgress)}</strong></div>
      ${hasShort ? `<div class="exam-stats__tile"><span>平均（自動）</span><strong>${num(o.avgAuto)}</strong></div>` : ""}
      <div class="exam-stats__tile"><span>平均${hasShort ? "（總分）" : ""}</span><strong>${num(hasShort ? o.avgTotal : o.avgAuto)}</strong></div>
      <div class="exam-stats__tile"><span>最高／最低</span><strong>${num(o.maxTotal)} / ${num(o.minTotal)}</strong></div>
    </div>

    <details class="exam-stats__sec" open><summary>各大區</summary>
      ${tbl(d.byRegion || [], [
        { h: "大區", f: (r) => esc(r.name) }, { h: "作答", f: (r) => r.count },
        { h: "已批", f: (r) => r.graded }, { h: "平均總分", f: (r) => num(r.avgTotal) }])}
    </details>
    <details class="exam-stats__sec"><summary>各牧區</summary>
      ${tbl(d.byZone || [], [
        { h: "大區", f: (r) => esc(r.region) }, { h: "牧區", f: (r) => esc(r.name) },
        { h: "作答", f: (r) => r.count }, { h: "已批", f: (r) => r.graded }, { h: "平均總分", f: (r) => num(r.avgTotal) }])}
    </details>
    <details class="exam-stats__sec"><summary>各小組</summary>
      ${tbl(d.byGroup || [], [
        { h: "牧區", f: (r) => esc(r.zone) }, { h: "小組", f: (r) => esc(r.name) },
        { h: "作答", f: (r) => r.count }, { h: "已批", f: (r) => r.graded }, { h: "平均總分", f: (r) => num(r.avgTotal) }])}
    </details>
    <details class="exam-stats__sec" open><summary>個人／組隊</summary>
      ${tbl(d.byDivision || [], [
        { h: "類別", f: (r) => esc(r.label) },
        { h: "作答", f: (r) => r.count }, { h: "已批", f: (r) => r.graded },
        { h: "平均總分", f: (r) => num(r.avgTotal) }])}
    </details>
    <details class="exam-stats__sec"><summary>各組隊（${(d.byTeam || []).length} 隊）</summary>
      ${tbl(d.byTeam || [], [
        { h: "隊名", f: (r) => esc(r.name || "") },
        { h: "組別", f: (r) => (r.division ? `${r.division} 人` : "—") },
        { h: "作答", f: (r) => r.members }, { h: "已批", f: (r) => r.graded },
        { h: "平均總分", f: (r) => num(r.avgTotal) },
        { h: "總分和", f: (r) => num(r.totalSum) },
        { h: "最高／最低", f: (r) => `${num(r.maxTotal)} / ${num(r.minTotal)}` }])}
    </details>
    <details class="exam-stats__sec"><summary>逐題正確率（自動計分題）</summary>
      ${tbl(d.byQuestion || [], [
        { h: "大題", f: (r) => esc((SECTION_TITLE[r.section] || r.section).slice(0, 3)) },
        { h: "題", f: (r) => r.position },
        { h: "作答數", f: (r) => r.answered },
        { h: "正確率", f: (r) => rateBar(r.correctRate) }])}
    </details>
    <details class="exam-stats__sec" open><summary>作答名單（${(d.roster || []).length} 人）</summary>
      <div class="exam-stats__toolbar"><button type="button" class="secondary-btn" id="exam-stats-csv">匯出 CSV</button></div>
      <div class="exam-stats__roster">${tbl(d.roster || [], [
        { h: "姓名", f: (r) => esc(r.name) },
        { h: "大區", f: (r) => esc(r.greatRegion || "") },
        { h: "牧區", f: (r) => esc(r.pastoralZone || "") },
        { h: "小組", f: (r) => esc(r.smallGroup || "") },
        { h: "組隊", f: (r) => esc(r.team || (r.teamDivision ? `${r.teamDivision} 人組` : "個人")) },
        ...(hasShort ? [
          { h: "自動", f: (r) => num(r.autoScore) },
          { h: "簡答", f: (r) => num(r.manualScore) },
          { h: "總分", f: (r) => (r.status === "graded" ? `<strong>${num(r.totalScore)}</strong>` : "待批改") }
        ] : [
          { h: "分數", f: (r) => (r.status === "graded" ? `<strong>${num(r.totalScore ?? r.autoScore)}</strong>` : "計分中") }
        ])])}</div>
    </details>`;

  host.querySelector("#exam-stats-csv")?.addEventListener("click", () => {
    const rows = d.roster || [];
    const head = hasShort
      ? ["姓名", "大區", "牧區", "小組", "組隊", "組別", "狀態", "自動", "簡答", "總分", "送出時間"]
      : ["姓名", "大區", "牧區", "小組", "組隊", "組別", "狀態", "分數", "送出時間"];
    const csv = [head.join(",")].concat(rows.map((r) => (hasShort ? [
      r.name, r.greatRegion, r.pastoralZone, r.smallGroup,
      r.team || (r.teamDivision ? `${r.teamDivision}人組` : "個人"),
      r.teamDivision ? `${r.teamDivision}人` : "個人",
      r.status, r.autoScore, r.manualScore, r.totalScore, r.submittedAt
    ] : [
      r.name, r.greatRegion, r.pastoralZone, r.smallGroup,
      r.team || (r.teamDivision ? `${r.teamDivision}人組` : "個人"),
      r.teamDivision ? `${r.teamDivision}人` : "個人",
      r.status, r.totalScore ?? r.autoScore, r.submittedAt
    ]).map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `exam_${(d.paper && d.paper.title) || "results"}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

// 把 paper.sections（[{type,count,pointsPer}]）轉成 {type: {count,pointsPer}}
function examSectionCfg(paper) {
  const map = {};
  (Array.isArray(paper.sections) ? paper.sections : []).forEach((s) => {
    if (s && s.type) map[s.type] = { count: Number(s.count) || 0, pointsPer: Number(s.pointsPer) || 1 };
  });
  return map;
}

// ── 試卷設定表單（含題型與配分）──
function renderExamMetaForm(host, paper, rerender) {
  const p = paper;
  const rules = ((p.pledge || {}).rules || []).join("\n");
  const cfg = examSectionCfg(p);
  const secRows = SECTION_ORDER.map((t) => {
    const on = !!cfg[t];
    const c = cfg[t] || { count: SECTION_TARGET_DEFAULT[t] || 0, pointsPer: t === "shortanswer" ? 10 : 1 };
    return `<div class="exam-admin__sec-row" data-sec-type="${t}">
      <label class="exam-admin__sec-on"><input type="checkbox" data-s="on" ${on ? "checked" : ""}> ${esc(SECTION_TITLE[t])}</label>
      <label>題數<input type="number" min="0" class="form-control" data-s="count" value="${c.count}"></label>
      <label>每題配分<input type="number" min="0" step="0.5" class="form-control" data-s="pts" value="${c.pointsPer}"></label>
      <span class="exam-admin__sec-sub" data-s="sub">小計 ${c.count * c.pointsPer}</span>
    </div>`;
  }).join("");

  host.innerHTML = `
    <div class="exam-admin__form">
      <label>標題<input class="form-control" data-f="title" value="${esc(p.title)}"></label>
      <p class="exam-admin__meta">測試版與正式版是兩份獨立的卷。測試版改好後，用上方「推上正式版」把題目與設定複製過去。</p>
      <div class="exam-admin__form-row">
        <label>開放起<input type="datetime-local" class="form-control" data-f="open_at" value="${esc(toLocalInput(p.open_at))}"></label>
        <label>開放迄<input type="datetime-local" class="form-control" data-f="close_at" value="${esc(toLocalInput(p.close_at))}"></label>
      </div>
      <label>限時（分）<input type="number" class="form-control" data-f="duration_minutes" value="${p.duration_minutes}"></label>

      <fieldset class="exam-admin__sec-cfg">
        <legend>題型與配分</legend>
        <p class="exam-admin__meta">勾選要納入這份測驗的題型，設定各題型題數與每題配分。滿分自動加總。</p>
        ${secRows}
        <p class="exam-admin__sec-total">滿分：<strong data-s="total">${p.total_points}</strong> 分</p>
      </fieldset>

      <label>宣示：開放說明<input class="form-control" data-f="pledge_open" value="${esc((p.pledge || {}).openText || "")}"></label>
      <label>宣示：規則（每行一條）<textarea class="form-control" rows="6" data-f="pledge_rules">${esc(rules)}</textarea></label>
      <label>宣示：確認句（{name} 會代入姓名）<input class="form-control" data-f="pledge_consent" value="${esc((p.pledge || {}).consentTemplate || "{name} 清楚以上測驗規則，亦會遵守規則來完成本次測驗。")}"></label>
      <button type="button" class="primary-btn" id="exam-meta-save">儲存試卷設定</button>
    </div>`;

  const collectSections = () => [...host.querySelectorAll(".exam-admin__sec-row")]
    .filter((r) => r.querySelector('[data-s="on"]').checked)
    .map((r) => ({
      type: r.dataset.secType,
      count: Math.max(0, Number(r.querySelector('[data-s="count"]').value) || 0),
      pointsPer: Math.max(0, Number(r.querySelector('[data-s="pts"]').value) || 0)
    }));
  const refreshTotals = () => {
    let total = 0;
    host.querySelectorAll(".exam-admin__sec-row").forEach((r) => {
      const on = r.querySelector('[data-s="on"]').checked;
      const c = Number(r.querySelector('[data-s="count"]').value) || 0;
      const pp = Number(r.querySelector('[data-s="pts"]').value) || 0;
      r.querySelector('[data-s="sub"]').textContent = on ? `小計 ${c * pp}` : "（不納入）";
      r.classList.toggle("is-off", !on);
      if (on) total += c * pp;
    });
    host.querySelector('[data-s="total"]').textContent = total;
  };
  host.querySelectorAll('.exam-admin__sec-row input').forEach((i) => i.addEventListener("input", refreshTotals));
  refreshTotals();

  host.querySelector("#exam-meta-save").addEventListener("click", async (e) => {
    const g = (f) => host.querySelector(`[data-f="${f}"]`).value;
    const sections = collectSections();
    if (!sections.length) { toast("至少要有一個題型"); return; }
    e.target.disabled = true;
    const res = await db.upsertExamPaper({
      id: p.id, title: g("title"),
      open_at: fromLocalInput(g("open_at")), close_at: fromLocalInput(g("close_at")),
      duration_minutes: Number(g("duration_minutes")) || 75,
      sections,
      pledge: { openText: g("pledge_open"), rules: lines(g("pledge_rules")), consentTemplate: g("pledge_consent") }
    });
    e.target.disabled = false;
    if (!res.success) { toast(res.message || "儲存失敗"); return; }
    toast("已儲存");
    rerender();
  });
}

// ── 題庫編輯（依試卷啟用的題型，每題可存 / 刪 / 新增）──
function renderExamQuestionBank(host, paper, questions, rerender) {
  if (paper.status !== "draft") {
    host.innerHTML = `<div class="admin-user-directory__empty">試卷已${paper.status === "published" ? "發佈" : "關閉"}，題目已鎖定。要改題請先「改回草稿」（會影響已作答的人，請謹慎）。</div>`;
    return;
  }
  const cfg = examSectionCfg(paper);
  const activeSections = SECTION_ORDER.filter((s) => cfg[s]);
  if (!activeSections.length) {
    host.innerHTML = '<div class="admin-user-directory__empty">這份試卷還沒設定題型。請先到「試卷設定」勾選要哪些題型。</div>';
    return;
  }
  const bySection = {};
  questions.forEach((q) => { (bySection[q.section] ||= []).push(q); });
  activeSections.forEach((s) => (bySection[s] ||= []).sort((a, b) => a.position - b.position));

  host.innerHTML = activeSections.map((sec) => `
    <section class="exam-admin__bank-sec" data-section="${sec}">
      <h4>${esc(SECTION_TITLE[sec])}　<span class="exam-admin__meta">${bySection[sec].length}／${cfg[sec].count} 題・每題 ${cfg[sec].pointsPer} 分</span></h4>
      <div class="exam-admin__q-list">${bySection[sec].map((q) => qEditCard(sec, q, cfg[sec])).join("")}</div>
      <button type="button" class="secondary-btn" data-add-q="${sec}">＋ 新增${SECTION_TITLE[sec].slice(2)}</button>
    </section>`).join("");

  const wire = (card) => {
    const sec = card.closest("[data-section]").dataset.section;
    card.querySelector("[data-q-save]").addEventListener("click", async (e) => {
      const built = collectQCard(card, sec, cfg[sec]);
      if (built.error) { toast(built.error); return; }
      e.target.disabled = true;
      const res = await db.upsertExamQuestion({
        id: card.dataset.qid || undefined, paper_id: paper.id, section: sec,
        position: Number(card.dataset.qpos) || undefined,
        points: built.points, payload: built.payload, answer_key: built.answer_key
      });
      e.target.disabled = false;
      if (!res.success) { toast(res.message || "儲存失敗"); return; }
      toast("已儲存"); rerender();
    });
    card.querySelector("[data-q-del]")?.addEventListener("click", async () => {
      if (!confirm("刪除這一題？")) return;
      const res = await db.deleteExamQuestion(card.dataset.qid);
      if (!res.success) { toast(res.message || "刪除失敗"); return; }
      rerender();
    });
  };
  host.querySelectorAll(".exam-admin__q-card").forEach(wire);
  host.querySelectorAll("[data-add-q]").forEach((b) => b.addEventListener("click", () => {
    const sec = b.dataset.addQ;
    const list = b.closest("[data-section]").querySelector(".exam-admin__q-list");
    list.insertAdjacentHTML("beforeend", qEditCard(sec, null, cfg[sec]));
    wire(list.lastElementChild);
    list.lastElementChild.scrollIntoView({ block: "center" });
  }));
}

function qEditCard(sec, q, secCfg) {
  const pl = (q && q.payload) || {};
  const ak = q ? q.answer_key : undefined;
  const idAttr = q ? `data-qid="${esc(q.id)}" data-qpos="${q.position}"` : "";
  let body = `<label>題幹<textarea class="form-control" data-p="stem" rows="2">${esc(pl.stem || "")}</textarea></label>`;

  if (sec === "truefalse") {
    body += `<label>正解<select class="form-control" data-a="tf">
      <option value="true" ${ak === true ? "selected" : ""}>O（對）</option>
      <option value="false" ${ak === false ? "selected" : ""}>X（錯）</option></select></label>`;
  } else if (sec === "single" || sec === "multiple") {
    const opts = pl.options || ["", "", "", ""];
    const ansArr = sec === "multiple" ? (Array.isArray(ak) ? ak : []) : [];
    body += `<div class="exam-admin__opts">${opts.map((o, i) => `
      <div class="exam-admin__opt">
        <input type="${sec === "multiple" ? "checkbox" : "radio"}" name="ak-${q ? q.id : "new"}" data-a="opt" value="${i}"
          ${sec === "multiple" ? (ansArr.includes(i) ? "checked" : "") : (ak === i ? "checked" : "")}>
        <input class="form-control" data-p="opt" value="${esc(o)}">
      </div>`).join("")}</div>
      <button type="button" class="exam-admin__link" data-opt-add>＋ 選項</button>`;
  } else if (sec === "matching") {
    body += `<label>左欄（每行 id|文字）<textarea class="form-control" rows="4" data-p="left">${esc((pl.left || []).map((x) => x.id + "|" + x.text).join("\n"))}</textarea></label>
      <label>右欄（每行 id|文字，數量須與左欄相等）<textarea class="form-control" rows="4" data-p="right">${esc((pl.right || []).map((x) => x.id + "|" + x.text).join("\n"))}</textarea></label>
      <label>正解（每行 左id=右id）<textarea class="form-control" rows="4" data-a="match">${esc(Object.entries(ak || {}).map(([l, r]) => l + "=" + r).join("\n"))}</textarea></label>`;
  } else if (sec === "ordering") {
    body += `<label>事件（每行 id|文字，＝待排序區呈現順序）<textarea class="form-control" rows="5" data-p="items">${esc((pl.items || []).map((x) => x.id + "|" + x.text).join("\n"))}</textarea></label>
      <label>正確順序（id 以逗號分隔）<input class="form-control" data-a="order" value="${esc((Array.isArray(ak) ? ak : []).join(","))}"></label>`;
  } else if (sec === "shortanswer") {
    body += `<label>參考答案<textarea class="form-control" rows="3" data-p="ref">${esc(pl.referenceAnswer || "")}</textarea></label>
      <label>評分要點（每行一項）<textarea class="form-control" rows="3" data-p="rubric">${esc((pl.rubric || []).join("\n"))}</textarea></label>
      <p class="exam-admin__meta">配分 ${(secCfg && secCfg.pointsPer) ?? 10} 分（在「試卷設定 → 題型與配分」調整）</p>`;
  }
  return `<div class="exam-admin__q-card" ${idAttr}>
    ${body}
    <div class="exam-admin__q-actions">
      <button type="button" class="primary-btn" data-q-save>儲存此題</button>
      ${q ? '<button type="button" class="exam-admin__link exam-admin__link--danger" data-q-del>刪除</button>' : ""}
    </div>
  </div>`;
}

function collectQCard(card, sec, secCfg) {
  const stem = card.querySelector('[data-p="stem"]').value.trim();
  if (!stem) return { error: "題幹不能空白" };
  let payload = { stem };
  let answer_key = null;
  let points = (secCfg && Number(secCfg.pointsPer)) || (sec === "shortanswer" ? 10 : 1);

  if (sec === "truefalse") {
    answer_key = card.querySelector('[data-a="tf"]').value === "true";
  } else if (sec === "single" || sec === "multiple") {
    const opts = [...card.querySelectorAll('[data-p="opt"]')].map((i) => i.value.trim());
    payload.options = opts;
    const checked = [...card.querySelectorAll('[data-a="opt"]')].filter((i) => i.checked).map((i) => Number(i.value));
    if (sec === "single") {
      if (checked.length !== 1) return { error: "單選題請選 1 個正解" };
      answer_key = checked[0];
    } else {
      if (checked.length < 2) return { error: "複選題至少 2 個正解" };
      answer_key = checked.sort((a, b) => a - b);
    }
  } else if (sec === "matching") {
    const left = parseIdText(lines(card.querySelector('[data-p="left"]').value));
    const right = parseIdText(lines(card.querySelector('[data-p="right"]').value));
    payload.left = left; payload.right = right;
    answer_key = {};
    lines(card.querySelector('[data-a="match"]').value).forEach((r) => {
      const [l, rr] = r.split("=");
      if (l && rr) answer_key[l.trim()] = rr.trim();
    });
    if (Object.keys(answer_key).length !== left.length) return { error: "連連看：正解組數要等於左欄項數" };
  } else if (sec === "ordering") {
    const items = parseIdText(lines(card.querySelector('[data-p="items"]').value));
    payload.items = items;
    answer_key = card.querySelector('[data-a="order"]').value.split(",").map((s) => s.trim()).filter(Boolean);
    if (answer_key.length !== items.length) return { error: "排序題：正解 id 數要等於事件數" };
  } else if (sec === "shortanswer") {
    payload.referenceAnswer = card.querySelector('[data-p="ref"]').value.trim();
    payload.rubric = lines(card.querySelector('[data-p="rubric"]').value);
    payload.maxPoints = points;
    answer_key = null;
  }
  return { payload, answer_key, points };
}

// ── 簡答批改佇列（分數 + 評語）──
async function renderExamGrading(host, paperId) {
  host.innerHTML = '<div class="admin-user-directory__empty">載入批改清單…</div>';
  const res = await db.getExamGradingQueue(paperId, examAdminGradeFilter);
  if (!res.success) { host.innerHTML = `<div class="admin-user-directory__empty">${esc(res.message || "載入失敗")}</div>`; return; }
  const { summary = {}, items = [] } = res.data || {};

  host.innerHTML = `
    <div class="exam-admin__grade-head">
      <span class="exam-admin__meta">待批 ${summary.pending ?? "?"}／已批 ${summary.graded ?? "?"}／共 ${summary.total ?? "?"}</span>
      <span class="exam-admin__filter">
        ${["pending", "graded", "all"].map((f) => `<button type="button" data-gf="${f}" class="${examAdminGradeFilter === f ? "active" : ""}">${{ pending: "待批", graded: "已批", all: "全部" }[f]}</button>`).join("")}
      </span>
    </div>
    ${items.length ? items.map(gradeCard).join("") : '<div class="admin-user-directory__empty">沒有符合的簡答作答。</div>'}`;

  host.querySelectorAll("[data-gf]").forEach((b) => b.addEventListener("click", () => {
    examAdminGradeFilter = b.dataset.gf; renderExamGrading(host, paperId);
  }));
  host.querySelectorAll(".exam-admin__grade-card").forEach((card) => {
    card.querySelector("[data-grade-save]").addEventListener("click", async (e) => {
      const pts = Number(card.querySelector('[data-g="points"]').value);
      const cmt = card.querySelector('[data-g="comment"]').value;
      if (isNaN(pts)) { toast("請輸入分數"); return; }
      e.target.disabled = true;
      const r = await db.gradeExamAnswer(card.dataset.answerId, pts, cmt);
      e.target.disabled = false;
      if (!r.success) { toast(r.message || "儲存失敗"); return; }
      toast(r.data?.attemptFinalized ? "已批改，該生總分已結算" : "已儲存");
      renderExamGrading(host, paperId);
    });
  });
}

function gradeCard(it) {
  const who = [it.greatRegion, it.pastoralZone, it.smallGroup].filter(Boolean).join(" / ");
  return `<div class="exam-admin__grade-card" data-answer-id="${esc(it.answerId)}">
    <p class="exam-admin__grade-who"><strong>${esc(it.examineeName || "（未具名）")}</strong>${who ? `　<span class="exam-admin__meta">${esc(who)}</span>` : ""}
      ${it.awardedPoints != null ? `　<span class="stat-badge stat-badge--success">已批 ${it.awardedPoints}</span>` : '　<span class="stat-badge stat-badge--warning">待批</span>'}</p>
    <p class="exam-admin__grade-stem">第 ${it.position} 題（${it.points} 分）：${esc(it.stem || "")}</p>
    <details><summary class="exam-admin__link">參考答案／評分要點</summary>
      <p class="exam-admin__meta">${esc(it.referenceAnswer || "—")}</p>
      <ul class="exam-admin__rubric">${(it.rubric || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    </details>
    <div class="exam-admin__grade-resp">${esc(it.response || "（未作答）")}</div>
    <div class="exam-admin__grade-inputs">
      <label>分數（0～${it.points}）<input type="number" step="0.5" min="0" max="${it.points}" class="form-control" data-g="points" value="${it.awardedPoints ?? ""}"></label>
      <label>評語（會回饋給作答者）<textarea class="form-control" rows="2" data-g="comment">${esc(it.graderComment || "")}</textarea></label>
      <button type="button" class="primary-btn" data-grade-save>儲存</button>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────── 滿版作答頁
export function mountExamRunner({ paperId = null, standalone = false, preview = false } = {}) {
  document.getElementById("exam-fullscreen")?.remove();
  const host = document.createElement("div");
  host.id = "exam-fullscreen";
  host.className = "exam-fullscreen";
  host.innerHTML = `
    <div class="exam-fullscreen__bar">
      <p class="exam-fullscreen__title" id="exam-fs-title">大測驗</p>
      <div class="exam-fullscreen__bar-right">
        <span class="exam-timer" id="exam-timer" hidden></span>
        <button type="button" class="secondary-btn" id="exam-back">返回</button>
      </div>
    </div>
    <div class="exam-fullscreen__inner" id="exam-fs-inner"></div>`;
  document.body.appendChild(host);
  try { document.body.dataset.examOpen = "1"; document.body.style.overflow = "hidden"; } catch (_) {}

  const runner = new ExamRunner(host, paperId, standalone, preview);
  host.querySelector("#exam-back").addEventListener("click", () => runner.requestExit());
  runner.boot();
  return runner;
}

class ExamRunner {
  constructor(host, paperId, standalone = false, preview = false) {
    this.host = host;
    this.standalone = standalone;
    this.preview = !!preview;
    this.el = host.querySelector("#exam-fs-inner");
    this.titleEl = host.querySelector("#exam-fs-title");
    this.timerEl = host.querySelector("#exam-timer");
    this.paperId = paperId;
    this.paper = null;
    this.attempt = null;
    this.deadlineTs = 0;
    this.questionsById = {};
    this.RESP = {};
    this.lsKey = null;
    this.timerId = null;
    this.saveTimer = null;
    this.persistTimer = null;
    this.dirty = false;
    this.submitting = false;
    this.resyncing = false;
    this._matchResize = null;
    this._onVis = () => {
      if (document.visibilityState === "hidden") { this.persistLocal(); this.flushSave(); }
      else this.resync();
    };
    this._onPageShow = (e) => { if (!e || e.persisted || e.type !== "pageshow") this.resync(); };
    this._onOnline = () => { this.flushSave(); this.resync(); };   // 斷線恢復：立刻補推 + 校時
    this._onBeforeUnload = (e) => {
      if (this.attempt && this.attempt.status === "in_progress" && !this.submitting) {
        e.preventDefault(); e.returnValue = ""; return "";
      }
    };
  }

  async boot() {
    this.el.innerHTML = '<div class="admin-user-directory__empty">載入測驗…</div>';
    const res = await db.getExamForAttempt(this.paperId, { preview: this.preview });
    if (!res.success) {
      // 網路 / 功能未開等錯誤：不清 active 旗標，保留稍後自動重試的機會
      this.el.innerHTML = `<div class="admin-user-directory__empty">${esc(res.message)}
        <br><button type="button" class="secondary-btn" id="exam-retry" style="margin-top:.6rem;">重試</button></div>`;
      this.el.querySelector("#exam-retry")?.addEventListener("click", () => this.boot());
      return;
    }
    const d = res.data || {};
    if (d.state === "no_paper") { clearActiveExam(); this.el.innerHTML = '<div class="admin-user-directory__empty">目前沒有可作答的試卷。</div>'; return; }
    this.paper = d.paper;
    this.openState = d.state;
    if (this.titleEl && this.paper) this.titleEl.textContent = this.paper.title;

    // 後台預覽：唯讀呈現整卷題目，不建 attempt、不倒數、不送出、不跳結果畫面
    // （不動 exam_active_paper 旗標，以免影響使用者自己可能進行中的作答續作）
    if (this.preview || d.preview) {
      this.attempt = { status: "preview", paperSnapshot: { questions: d.previewQuestions || [] }, layout: {} };
      this.deadlineTs = 0;
      this.hydrateFromAttempt();
      this.renderRunner();
      return;
    }

    if (d.attempt) {
      this.attempt = d.attempt;
      this.deadlineTs = 0;
      this._anchorDeadline(this.attempt.secondsRemaining, this.attempt.deadlineAt);
      this.lsKey = "exam_resp_" + this.attempt.id;
      this.hydrateFromAttempt();
      this.mergeLocal();
      if (this.attempt.status === "in_progress") {
        setActiveExam(this.paper.id);       // 作答中 → 記住，app 重整後自動重開
        this.attachLifecycle();
        this.renderRunner();
        this.persistLocal();
        void this.flushSave();              // 把 localStorage-only 的答案推上去
      } else {
        clearActiveExam();                  // 已送出 / 已批改 → 不再自動重開
        await this.renderResult();
      }
      return;
    }
    if (this.openState === "not_open") { clearActiveExam(); this.el.innerHTML = this.closedCard("測驗尚未開放作答。"); return; }
    if (this.openState === "closed") { clearActiveExam(); this.el.innerHTML = this.closedCard("測驗已結束。"); return; }
    this.renderPledge();
  }

  // ── 生命週期監聽（只在 in_progress 掛，離開時全部拆掉） ──
  attachLifecycle() {
    document.addEventListener("visibilitychange", this._onVis);
    window.addEventListener("pageshow", this._onPageShow);
    window.addEventListener("beforeunload", this._onBeforeUnload);
    window.addEventListener("online", this._onOnline);
    if (!this.saveTimer) this.saveTimer = setInterval(() => this.flushSave(), 15000);
    if (!this.persistTimer) this.persistTimer = setInterval(() => this.persistLocal(), 3000);
  }
  detachLifecycle() {
    document.removeEventListener("visibilitychange", this._onVis);
    window.removeEventListener("pageshow", this._onPageShow);
    window.removeEventListener("beforeunload", this._onBeforeUnload);
    window.removeEventListener("online", this._onOnline);
    if (this._matchResize) { window.removeEventListener("resize", this._matchResize); this._matchResize = null; }
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null; }
    if (this._timeoutRetry) { clearTimeout(this._timeoutRetry); this._timeoutRetry = null; }
    this.stopTimer();
  }

  destroy() {
    this.detachLifecycle();
    try { delete document.body.dataset.examOpen; document.body.style.overflow = ""; } catch (_) {}
    this.host?.remove();
    if (this.standalone) this._leaveStandalone();
  }

  // 關閉獨立測驗頁：優先「上一頁」回到進入前的分頁（bfcache 會原樣還原 SPA 狀態），
  // 沒有可回的歷史才退而求其次用 ?return= 或首頁。不開新分頁、不強制回首頁。
  _leaveStandalone() {
    try {
      let internalRef = true;
      if (document.referrer) {
        try { internalRef = new URL(document.referrer).origin === location.origin; } catch (_) { internalRef = false; }
      }
      if (window.history.length > 1 && internalRef) { window.history.back(); return; }
    } catch (_) {}
    try {
      const ret = new URLSearchParams(location.search).get("return");
      if (ret && /^\/(?!\/)/.test(ret)) { location.replace(ret); return; }
    } catch (_) {}
    try { location.replace("/"); } catch (_) {}
  }

  requestExit() {
    if (this.attempt && this.attempt.status === "in_progress" && !this.submitting) {
      if (!confirm("測驗仍在進行，計時不會停止。要先離開嗎？（稍後回來可從原處續作）")) return;
      this.persistLocal(); this.flushSave();
    }
    this.destroy();
  }

  // ── 切 App / 螢幕鎖回來：重抓 attempt、校正時間、補答案 ──
  async resync() {
    if (this.resyncing || this.submitting || !this.attempt || this.attempt.status !== "in_progress") return;
    this.resyncing = true;
    try {
      const res = await db.getExamForAttempt(this.paperId);
      if (!res.success || !res.data) return;
      const a = res.data.attempt;
      if (!a) return;
      if (a.status !== "in_progress") {           // 已在別處送出 / 被自動收卷
        this.attempt.status = a.status;
        clearActiveExam();
        this.detachLifecycle();
        await this.renderResult();
        return;
      }
      this._anchorDeadline(a.secondsRemaining, a.deadlineAt);
      const saved = a.savedAnswers || {};
      let filled = false;
      Object.keys(saved).forEach((qid) => {
        if (this.RESP[qid] === undefined) { this.RESP[qid] = saved[qid]; filled = true; }
      });
      this.tickTimer();
      if (this.deadlineTs && Date.now() >= this.deadlineTs) { this.submit("timeout"); return; }
      if (filled) this.renderRunner();           // 有補回答案才整頁重繪
    } finally {
      this.resyncing = false;
    }
  }

  closedCard(msg) {
    return `<div class="glass-card exam-closed-card"><h3>${esc(this.paper?.title || "速讀測驗")}</h3><p>${esc(msg)}</p></div>`;
  }

  hydrateFromAttempt() {
    const snap = this.attempt.paperSnapshot || {};
    (snap.questions || []).forEach((q) => { this.questionsById[q.id] = q; });
    const saved = this.attempt.savedAnswers || {};
    Object.keys(saved).forEach((qid) => { this.RESP[qid] = saved[qid]; });
  }

  mergeLocal() {
    if (!this.lsKey) return;
    try {
      const raw = localStorage.getItem(this.lsKey);
      if (!raw) return;
      const local = JSON.parse(raw);
      Object.keys(local || {}).forEach((qid) => { this.RESP[qid] = local[qid]; }); // 本地最新，覆蓋
    } catch (_) {}
  }
  persistLocal() {
    if (!this.lsKey) return;
    try { localStorage.setItem(this.lsKey, JSON.stringify(this.collectAnswers())); } catch (_) {}
  }
  clearLocal() { try { if (this.lsKey) localStorage.removeItem(this.lsKey); } catch (_) {} }

  // ── 宣示 gate ──
  renderPledge() {
    if (this.timerEl) this.timerEl.hidden = true;
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
    if (!res.success) { toast(res.message || "無法開始"); this.renderPledge(); return; }
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

    const bar = this.preview
      ? `<div class="exam-submit-bar">
           <p class="exam-q__note">預覽模式：此畫面僅供檢視題目，不會計時、不會建立作答紀錄。</p>
           <button type="button" id="exam-preview-close" class="secondary-btn" style="width:100%;">關閉預覽</button>
         </div>`
      : `<div class="exam-submit-bar">
           <button type="button" id="exam-submit" class="primary-btn" style="width:100%;">送出答案</button>
         </div>`;
    this.el.innerHTML = `<div id="exam-questions">${sectionsHtml}</div>${bar}`;

    if (typeof hydrateIcons === "function") hydrateIcons(this.el);
    this.el.querySelectorAll("[data-exam-q]").forEach((node) => this.bindQuestion(node, layout));

    if (this.preview) {
      if (this.timerEl) this.timerEl.hidden = true;
      this.el.querySelector("#exam-preview-close")?.addEventListener("click", () => this.destroy());
      return;
    }

    if (this.timerEl) this.timerEl.hidden = false;
    this.el.querySelector("#exam-submit").addEventListener("click", () => this.submit("manual"));
    this.startTimer();
  }

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

  // ── 計時：以 server 的絕對截止時間為準（背景暫停 / 休眠回來仍正確） ──
  // 倒數一律以「本機時鐘 + server 回報的剩餘秒數」為錨點：固定的裝置時鐘偏移在
  // 開場就被吸收；只有偏移明顯（改時區 / 長時間背景凍結）才重新校正，避免每次
  // floor 少 1 秒累積提前。server 沒回 secondsRemaining 時才退回用絕對 deadline。
  _anchorDeadline(secondsRemaining, deadlineAtIso) {
    const s = Number(secondsRemaining);
    if (Number.isFinite(s) && s >= 0) {
      const serverTs = Date.now() + s * 1000;
      if (!this.deadlineTs || Math.abs(serverTs - this.deadlineTs) > 10000) this.deadlineTs = serverTs;
      return;
    }
    if (!this.deadlineTs && deadlineAtIso) {
      const t = Date.parse(deadlineAtIso);
      if (t) this.deadlineTs = t;
    }
  }

  startTimer() {
    this.stopTimer();
    this.tickTimer();
    this.timerId = setInterval(() => this.tickTimer(), 1000);
  }
  stopTimer() { if (this.timerId) clearInterval(this.timerId); this.timerId = null; }
  tickTimer() {
    // 防線：若 app 重繪把滿版頁從 DOM 拔掉，作答中就把它接回去
    if (this.host && !this.host.isConnected && this.attempt && this.attempt.status === "in_progress") {
      document.body.appendChild(this.host);
      try { document.body.dataset.examOpen = "1"; document.body.style.overflow = "hidden"; } catch (_) {}
    }
    if (!this.deadlineTs) return;   // 還沒錨定倒數（不該發生）→ 先不動作，等下次校時
    const left = Math.max(0, Math.round((this.deadlineTs - Date.now()) / 1000));
    if (this.timerEl) {
      const mm = String(Math.floor(left / 60)).padStart(2, "0");
      const ss = String(left % 60).padStart(2, "0");
      this.timerEl.textContent = `剩餘 ${mm}:${ss}`;
      this.timerEl.classList.toggle("exam-timer--low", left < 300);
    }
    if (left <= 0 && this.attempt && this.attempt.status === "in_progress" && !this.submitting) {
      this.stopTimer();
      this.submit("timeout");
    }
  }

  // ── 暫存 ──
  markDirty() { if (this.preview) return; this.dirty = true; this.persistLocal(); }
  async flushSave() {
    if (!this.dirty || !this.attempt || this.attempt.status !== "in_progress" || this.submitting) return;
    this.dirty = false;
    const res = await db.saveExamProgress(this.attempt.id, this.collectAnswers());
    if (!res.success) {
      this.dirty = true;   // 任何失敗（斷線 / 500 …）都留著下個週期重試
      // 伺服器說作答已鎖 / 逾時：拉一次 resync 讓畫面切到正確狀態
      if (res.error && /exam_attempt_locked|exam_time_up|exam_attempt_not_found/.test(String(res.error?.message || res.message || ""))) {
        this.resync();
      }
      return;
    }
    // 用 server 回報的剩餘秒數校正倒數（每 15 秒一次，免得只靠切背景才校時）
    this._anchorDeadline(res.data?.secondsRemaining, this.attempt.deadlineAt);
    if (this.deadlineTs && Date.now() >= this.deadlineTs) this.submit("timeout");
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

  // ── 送出（失敗自動重試） ──
  async submit(reason) {
    if (this.submitting) return;
    if (reason === "manual" && !confirm("確定送出？送出後即鎖定，記錄以第一次為準、不可重作。")) return;
    this.submitting = true;
    this.stopTimer();
    const btn = this.el.querySelector("#exam-submit");
    if (btn) { btn.disabled = true; btn.textContent = "送出中…"; }

    let res = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      res = await db.submitExamAttempt(this.attempt.id, this.collectAnswers(), reason);
      if (res.success) break;
      if (attempt < 4) { toast("送出未成功，重試中…"); await sleep(1500 * attempt); }
    }
    if (!res || !res.success) {
      this.submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = "送出答案"; }
      if (reason !== "manual") {
        // 逾時自動送出失敗（多半是斷線）→ 每 20 秒重試一次，不重開 1 秒倒數以免狂打
        if (this._timeoutRetry) clearTimeout(this._timeoutRetry);
        this._timeoutRetry = setTimeout(() => {
          this._timeoutRetry = null;
          if (this.attempt && this.attempt.status === "in_progress") this.submit("timeout");
        }, 20000);
        if (this.timerEl) { this.timerEl.hidden = false; this.timerEl.textContent = "時間到，送出中…"; }
      }
      toast((res && res.message) || "送出失敗，請檢查網路後再試一次");
      return;
    }
    if (this._timeoutRetry) { clearTimeout(this._timeoutRetry); this._timeoutRetry = null; }
    this.clearLocal();
    clearActiveExam();
    this.attempt.status = res.data?.status || "submitted";
    this.detachLifecycle();
    await this.renderResult(res.data);
  }

  // ── 成績 / 已送出 ──
  async renderResult(submitData) {
    this.detachLifecycle();
    if (this.timerEl) this.timerEl.hidden = true;

    const res = await db.getMyExamResult(this.paper.id);
    const d = res.success ? (res.data || {}) : {};
    const graded = d.state === "graded";
    const auto = d.autoScore ?? submitData?.autoScore ?? "—";
    const total = d.totalScore ?? submitData?.totalScore;
    const answers = (Array.isArray(d.answers) ? d.answers.slice() : []).sort((a, b) => {
      const ra = a.sectionRank ?? (SECTION_ORDER.indexOf(a.section) + 1 || 99);
      const rb = b.sectionRank ?? (SECTION_ORDER.indexOf(b.section) + 1 || 99);
      return ra - rb || (a.position || 0) - (b.position || 0);
    });

    const wrongCount = answers.filter((a) => a.section !== "shortanswer" && a.autoCorrect === false).length;
    const hasShort = answers.some((a) => a.section === "shortanswer");
    const autoLabel = hasShort ? "自動計分（一～五大題）" : "得分";

    this.el.innerHTML = `
      <div class="glass-card" style="padding:1.4rem 1.5rem;">
        <h3 style="margin:0 0 .5rem;">${esc(this.paper.title)}</h3>
        <div class="exam-result__banner">
          測驗已送出，記錄以第一次為準、不可重作。<br>
          ${esc(autoLabel)}：<strong>${auto}</strong> 分
          ${!graded
            ? "<br>簡答題（第六大題）待管理員人工評分，成績公布後即可在此查看完整解答與正解。"
            : hasShort
              ? `　｜　簡答題：<strong>${d.manualScore ?? "—"}</strong> 分　｜　總分：<strong>${total ?? "—"}</strong> 分`
              : ""}
        </div>
        ${!answers.length ? "" : graded ? `
          <p class="exam-result__hint">成績已公布。${hasShort ? "一～五大題" : ""}答錯 ${wrongCount} 題，點開可看題目、你的作答與正解。</p>
          <details open>
            <summary class="exam-result__summary">逐題檢討（依大題順序）</summary>
            <div class="exam-result__list">${answers.map((a) => examResultRow(a, true)).join("")}</div>
          </details>` : `
          <details>
            <summary class="exam-result__summary">先看一～五大題對錯</summary>
            <div class="exam-result__list">${answers.map((a) => examResultRow(a, false)).join("")}</div>
          </details>`}
        <button type="button" class="secondary-btn" id="exam-result-close" style="margin-top:1rem;">關閉</button>
      </div>`;
    this.el.querySelector("#exam-result-close")?.addEventListener("click", () => this.destroy());
  }
}

// ── 成績檢討：把 canonical 作答 / 正解翻成看得懂的文字 ──
function describeExamValue(section, payload, value) {
  const p = payload || {};
  if (value === undefined || value === null) return "（未作答）";
  if (section === "truefalse") return value === true ? "O（對）" : value === false ? "X（錯）" : "（未作答）";
  if (section === "single") {
    const t = (p.options || [])[value];
    return t == null ? "（未作答）" : esc(t);
  }
  if (section === "multiple") {
    const arr = Array.isArray(value) ? value : [];
    if (!arr.length) return "（未作答）";
    return arr.map((i) => esc((p.options || [])[i] ?? i)).join("、");
  }
  if (section === "matching") {
    const lt = Object.fromEntries((p.left || []).map((x) => [x.id, x.text]));
    const rt = Object.fromEntries((p.right || []).map((x) => [x.id, x.text]));
    const ent = Object.entries(value || {});
    if (!ent.length) return "（未作答）";
    return ent.map(([l, r]) => `${esc(lt[l] ?? l)} → ${esc(rt[r] ?? r)}`).join("；");
  }
  if (section === "ordering") {
    const it = Object.fromEntries((p.items || []).map((x) => [x.id, x.text]));
    const arr = Array.isArray(value) ? value : [];
    if (!arr.length) return "（未作答）";
    return arr.map((id) => esc(it[id] ?? id)).join(" → ");
  }
  return esc(String(value)); // shortanswer：作答全文
}

function examResultRow(a, graded) {
  const head = `${esc(SECTION_TITLE[a.section] || a.section)}　第 ${a.position} 題`;

  if (a.section === "shortanswer") {
    const scored = a.awardedPoints != null;
    const ref = graded && a.payload && a.payload.referenceAnswer
      ? `<p class="exam-result__ln"><span class="exam-result__k">參考答案：</span>${esc(a.payload.referenceAnswer)}</p>` : "";
    const rubric = graded && a.payload && (a.payload.rubric || []).length
      ? `<p class="exam-result__ln"><span class="exam-result__k">評分要點：</span>${(a.payload.rubric).map(esc).join("／")}</p>` : "";
    return `<div class="exam-result__row">
      <p class="exam-result__q">${head}（${a.points} 分）</p>
      <p class="exam-result__ln"><span class="exam-result__k">你的作答：</span>${esc(a.response || "（未作答）")}</p>
      <p class="exam-result__ln"><span class="exam-result__k">得分：</span>${scored ? `<strong>${a.awardedPoints} / ${a.points}</strong>` : "待批改"}</p>
      ${a.graderComment ? `<p class="exam-result__ln"><span class="exam-result__k">評語：</span>${esc(a.graderComment)}</p>` : ""}
      ${ref}${rubric}
    </div>`;
  }

  const ok = a.autoCorrect === true;
  if (!graded || ok) {
    return `<div class="exam-result__row"><span class="exam-result__q-inline">${head}：</span>${
      ok ? '<span class="exam-ok">✓ 答對</span>' : '<span class="exam-bad">✗ 答錯</span>'}</div>`;
  }
  // graded 且答錯 → 展開題目、你的作答、正解
  return `<div class="exam-result__row exam-result__row--wrong">
    <p class="exam-result__q">${head}　<span class="exam-bad">✗ 答錯</span></p>
    ${a.payload && a.payload.stem ? `<p class="exam-result__ln">${esc(a.payload.stem)}</p>` : ""}
    <p class="exam-result__ln"><span class="exam-result__k">你的作答：</span>${describeExamValue(a.section, a.payload, a.response)}</p>
    <p class="exam-result__ln exam-ok"><span class="exam-result__k">正　　解：</span>${describeExamValue(a.section, a.payload, a.answerKey)}</p>
  </div>`;
}

export default { renderExamPanel, mountExamRunner };
