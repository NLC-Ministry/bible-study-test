// js/grade-entry.js — 「線上簡答批改」獨立頁 (grade.html) 的進入點。
// 設計文件：docs/exam-online-grading-design.md
//
// 批改人員 = 一般 NLC 會友（不需 admin 角色）。連結：/grade?paper=<id>。
// 點進來 → SSO 登入 → 只看到指派給自己的名單。
// 只載入需要的核心（config / state / auth / db），不載 app 的 router / views /
// PWA / Tailwind / Chart。與 js/exam-entry.js 同一套前置。

import '../config.js';
import './data/bible_data.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './data/bible_verse_counts.js';
import './copy/zh-Hant.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './data/church_campaign.js?v=20260901_round_schedule_restore';
import './design/design-tokens.js';
import './design/design-system-helpers.js?v=20260901_round_schedule_restore';
import './design/icon-registry.js?v=20260826_quiz_remove_duplicate_scope_filter';
import './design/icons.js';
import './state.js?v=20260901_highlights_notes_review';
import './auth.js?v=20260903_login_continuation_return_fix';
import './auth-launch.mjs';
import './db.js?v=20260903_exam_grading_fixes';
import './utils.js?v=20260903_score_input_validation';
import './gamification.js?v=20260826_quiz_remove_duplicate_scope_filter';
import { mountGradingWorkspace } from './modules/grading.js?v=20260903_login_continuation_return_fix';

const boot = document.getElementById('grade-boot');
const setBoot = (msg) => { if (boot) boot.textContent = msg; };

(async () => {
  try { window.initTheme?.(); } catch (_) {}

  try {
    await window.db.init();
  } catch (err) {
    console.warn('[grade-entry] db.init failed', err);
  }

  // 獨立頁沒有 app.js 的主動續期；批改可能一坐就是一兩小時 → 主動排程續期。
  try { window.auth?.scheduleProactiveRefresh?.(); } catch (_) {}

  const loggedIn = typeof window.auth?.isLoggedIn === 'function' ? window.auth.isLoggedIn() : false;
  if (!loggedIn) {
    setBoot('尚未登入，正在前往登入頁…');
    // 直接帶著「登入完回這一頁」的 continuation 走正規登入管道——不要再組一個
    // 沒人讀的 ?return= 網址參數，登入完只會停在首頁，回不到這張卷。
    if (typeof window.auth?.startInteractiveLogin === 'function') {
      await window.auth.startInteractiveLogin({ intent: 'login', returnTo: location.pathname + location.search });
    } else {
      location.replace('/');
    }
    return;
  }

  try {
    if (typeof window.db.loadUserData === 'function') await window.db.loadUserData(true);
  } catch (err) {
    console.warn('[grade-entry] loadUserData failed', err);
  }

  const qs = new URLSearchParams(location.search);
  const paperId = qs.get('paper') || null;
  const attemptId = qs.get('attempt') || null;
  if (!paperId) {
    setBoot('連結缺少試卷代碼（?paper=…）。請向管理員索取正確的批改連結。');
    return;
  }
  boot?.remove();
  mountGradingWorkspace({ paperId, attemptId });
})();
