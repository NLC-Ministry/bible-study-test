// js/exam-entry.js — 「速讀測驗」獨立頁 (exam.html) 的進入點。
// 只載入測驗需要的核心（config / state / auth / db），不載 app 的 router / views /
// PWA / Tailwind / Chart。這是一個真正獨立的網頁，不會被 app 的重繪或框架限制。

// 與 js/app.js 相同的核心前置（state.js 在 module-eval 時就需要 church_campaign /
// design token 等全域）。不含 app 的 router / views / PWA / Tailwind / badge-service.ts。
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
import './auth.js?v=20260904_highlights_cross_user_leak_fix';
import './auth-launch.mjs';
import './db.js?v=20260904_highlights_cross_user_leak_fix';
import './utils.js?v=20260905_r1final_badge_puzzle';
import './gamification.js?v=20260826_quiz_remove_duplicate_scope_filter';
import { mountExamRunner } from './modules/exam.js?v=20260905_exam_assign_range_pick';

const boot = document.getElementById('exam-boot');
const setBoot = (msg) => { if (boot) boot.textContent = msg; };

(async () => {
  try { window.initTheme?.(); } catch (_) {}

  // 建立 / 還原 session：沿用 app 的 db.init()。exam.html 沒有 login-gate 的 DOM，
  // 相關 getElementById 會回 null、對應 wiring 安靜略過。
  try {
    await window.db.init();
  } catch (err) {
    console.warn('[exam-entry] db.init failed', err);
  }

  // 獨立測驗頁自己沒有 app.js 的主動續期，作答時又不會切分頁 → token 會在
  // 75 分鐘測驗途中（~60 分）過期，害送出當下失敗。這裡主動排程續期。
  try { window.auth?.scheduleProactiveRefresh?.(); } catch (_) {}

  const loggedIn = typeof window.auth?.isLoggedIn === 'function' ? window.auth.isLoggedIn() : false;
  if (!loggedIn) {
    setBoot('尚未登入，正在前往登入頁…');
    // 直接帶著「登入完回這一頁」的 continuation 走正規登入管道——不要再組一個
    // 沒人讀的 ?return= 網址參數，登入完只會停在首頁，回不到這份測驗。
    if (typeof window.auth?.startInteractiveLogin === 'function') {
      await window.auth.startInteractiveLogin({ intent: 'login', returnTo: location.pathname + location.search });
    } else {
      location.replace('/');
    }
    return;
  }

  // 取得 state.currentUser（宣示畫面要顯示姓名）；失敗不致命。
  try {
    if (typeof window.db.loadUserData === 'function') await window.db.loadUserData(true);
  } catch (err) {
    console.warn('[exam-entry] loadUserData failed', err);
  }

  const qs = new URLSearchParams(location.search);
  const paperId = qs.get('paper') || null;
  const preview = qs.get('preview') === '1' || qs.get('preview') === 'true';
  const attemptKind = qs.get('attempt') === 'practice' ? 'practice' : 'official';
  boot?.remove();
  mountExamRunner({ paperId, standalone: true, preview, attemptKind });
})();
