import {
  detectAuthenticationEnvironment,
  shouldGateInteractiveAuth
} from "./auth-environment.js";

export const BIBLE_HUB_CONTINUE_RETURN_TO = "/?resume=plan";

function hubContinueQuery() {
  return `member/continue?satellite=bible-app&returnTo=${encodeURIComponent(BIBLE_HUB_CONTINUE_RETURN_TO)}`;
}

export function consumeBibleHubResume(search) {
  try {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    return params.get("resume") === "plan";
  } catch {
    return false;
  }
}

export function getLoginGateCopy(block, { hasTokens } = {}) {
  if (!hasTokens) {
    return {
      enterApp: false,
      title: "新生命聖經速讀計畫",
      subtitle: "跟弟兄姊妹一起速讀聖經，登入後進度會自動同步。",
      button: "使用 NLC 身份登入 (SSO)",
      mode: "sso",
    };
  }
  if (!block) {
    return { enterApp: true, title: "", subtitle: "", button: "", mode: "enter" };
  }
  if (block.reason === "member_profile_required") {
    return {
      enterApp: false,
      title: "請先填寫姓名",
      subtitle: "帳號已建立，但會員中心還沒有姓名。請到會員中心完成資料。這不是登入失敗。",
      button: "前往會員中心填寫姓名",
      mode: "hub-continue",
    };
  }
  if (block.reason === "membership_application_required") {
    return {
      enterApp: false,
      title: "請先完成會籍登記",
      subtitle: "請先送出正式會籍申請。牧者審核可以稍後完成，送出後即可使用聖經速讀。",
      button: "前往會員中心填寫會籍",
      mode: "hub-continue",
    };
  }
  if (block.reason === "member_context_unavailable") {
    return {
      enterApp: false,
      title: "正在確認會員資料",
      subtitle: "登入已完成，但會員中心暫時無法同步。請重試，不需要重新註冊。支援代碼：MEMBER_CONTEXT_UNAVAILABLE",
      button: "重新確認會員資料",
      mode: "retry-sync",
    };
  }
  if (block.reason === "inactive_membership") {
    return {
      enterApp: false,
      title: "目前無法使用聖經速讀",
      subtitle: "如果會員中心已有正確資料，可能是目前畫面尚未更新，可先重新整理最新版；若仍顯示此訊息，請到會員中心查看或聯繫教會同工。",
      button: "前往會員中心",
      mode: "hub-continue",
    };
  }
  return {
    enterApp: false,
    title: "需要在會員中心繼續",
    subtitle: "請由會員中心安全地繼續。不要重複註冊帳號。",
    button: "前往會員中心",
    mode: "hub-continue",
  };
}

export function hubContinueHref(auth) {
  const path = hubContinueQuery();
  if (auth && typeof auth.getMemberHubUrl === "function") {
    return auth.getMemberHubUrl(path);
  }
  return `https://member.newlife.org.tw/${path}`;
}

export function launchMemberHubContinue(auth) {
  const href = hubContinueHref(auth);
  const embedded = shouldGateInteractiveAuth(detectAuthenticationEnvironment(), {
    authEnvironmentAcknowledged: false
  });
  if (embedded && auth && typeof auth._addBrowserLaunchTransportParams === "function") {
    window.location.href = auth._addBrowserLaunchTransportParams(href);
    return;
  }
  window.location.assign(href);
}

export function applyLoginGateView({
  block,
  hasTokens,
  loginGate,
  appLayout,
  titleEl,
  subtitleEl,
  buttonEl,
  refreshActionsEl,
} = {}) {
  const copy = getLoginGateCopy(block, { hasTokens });
  if (copy.enterApp) {
    if (loginGate) loginGate.classList.add("hidden");
    if (appLayout) appLayout.classList.remove("hidden");
    if (refreshActionsEl) refreshActionsEl.classList.add("hidden");
    return copy;
  }
  if (loginGate) loginGate.classList.remove("hidden");
  if (appLayout) appLayout.classList.add("hidden");
  if (titleEl) titleEl.textContent = copy.title;
  if (subtitleEl) subtitleEl.textContent = copy.subtitle;
  if (buttonEl) {
    buttonEl.textContent = copy.button;
    buttonEl.dataset.loginGateMode = copy.mode;
  }
  if (refreshActionsEl) {
    if (hasTokens && block) refreshActionsEl.classList.remove("hidden");
    else refreshActionsEl.classList.add("hidden");
  }
  return copy;
}
