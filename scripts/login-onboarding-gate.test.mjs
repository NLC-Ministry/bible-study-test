import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyLoginGateView,
  consumeBibleHubResume,
  getLoginGateCopy,
  hubContinueHref,
} from "../js/login-onboarding-gate.mjs";

const db = readFileSync("js/db.js", "utf8");
const html = readFileSync("index.html", "utf8");

function makeEl(initialClass = "") {
  const classes = new Set(initialClass.split(/\s+/).filter(Boolean));
  return {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    textContent: "",
    dataset: {},
  };
}

describe("login gate copy", () => {
  it("asks anonymous users to start SSO", () => {
    const copy = getLoginGateCopy(null, { hasTokens: false });
    expect(copy.button).toBe("使用 NLC 身份登入 (SSO)");
    expect(copy.enterApp).toBe(false);
  });

  it("keeps the card up for a missing name", () => {
    const copy = getLoginGateCopy({
      reason: "member_profile_required",
      requiredActionUrl: "https://member.newlife.org.tw/member/continue",
    }, { hasTokens: true });
    expect(copy.enterApp).toBe(false);
    expect(copy.button).toContain("會員中心");
    expect(copy.subtitle).toContain("姓名");
  });

  it("keeps the card up until the official form is submitted", () => {
    const copy = getLoginGateCopy({
      reason: "membership_application_required",
    }, { hasTokens: true });
    expect(copy.enterApp).toBe(false);
    expect(copy.subtitle).toContain("會籍");
  });

  it("enters the app when Hub says user work is done", () => {
    expect(getLoginGateCopy(null, { hasTokens: true }).enterApp).toBe(true);
  });

  it("keeps the card up when member context cannot sync", () => {
    const copy = getLoginGateCopy({
      reason: "member_context_unavailable",
    }, { hasTokens: true });
    expect(copy.enterApp).toBe(false);
    expect(copy.mode).toBe("retry-sync");
    expect(copy.subtitle).toContain("MEMBER_CONTEXT_UNAVAILABLE");
    expect(copy.button).toBe("重新確認會員資料");
  });

  it("keeps the card up for inactive membership", () => {
    const copy = getLoginGateCopy({
      reason: "inactive_membership",
    }, { hasTokens: true });
    expect(copy.enterApp).toBe(false);
    expect(copy.mode).toBe("hub-continue");
    expect(copy.button).toBe("前往會員中心");
  });
});

describe("login gate view", () => {
  it("keeps #login-gate visible for a token session with a Hub block", () => {
    const loginGate = makeEl("login-gate hidden");
    const appLayout = makeEl("app-layout");
    const titleEl = makeEl();
    const subtitleEl = makeEl();
    const buttonEl = makeEl();
    const refreshActionsEl = makeEl("hidden");

    const copy = applyLoginGateView({
      block: { reason: "member_profile_required" },
      hasTokens: true,
      loginGate,
      appLayout,
      titleEl,
      subtitleEl,
      buttonEl,
      refreshActionsEl,
    });

    expect(copy.enterApp).toBe(false);
    expect(loginGate.classList.contains("hidden")).toBe(false);
    expect(appLayout.classList.contains("hidden")).toBe(true);
    expect(subtitleEl.textContent).toContain("姓名");
    expect(buttonEl.textContent).toContain("會員中心");
    expect(buttonEl.dataset.loginGateMode).toBe("hub-continue");
    expect(refreshActionsEl.classList.contains("hidden")).toBe(false);
  });

  it("hides the card only when Hub says user work is done", () => {
    const loginGate = makeEl("login-gate");
    const appLayout = makeEl("app-layout hidden");

    applyLoginGateView({
      block: null,
      hasTokens: true,
      loginGate,
      appLayout,
      titleEl: makeEl(),
      subtitleEl: makeEl(),
      buttonEl: makeEl(),
      refreshActionsEl: makeEl(),
    });

    expect(loginGate.classList.contains("hidden")).toBe(true);
    expect(appLayout.classList.contains("hidden")).toBe(false);
  });

  it("builds the Hub continue URL with satellite return", () => {
    expect(hubContinueHref({
      getMemberHubUrl(path) { return `https://member.example/${path}`; },
    })).toBe("https://member.example/member/continue?satellite=bible-app&returnTo=%2F%3Fresume%3Dplan");
    expect(hubContinueHref(null)).toBe(
      "https://member.newlife.org.tw/member/continue?satellite=bible-app&returnTo=%2F%3Fresume%3Dplan"
    );
  });

  it("treats Hub resume=plan as a plan-tab return", () => {
    expect(consumeBibleHubResume("?resume=plan")).toBe(true);
    expect(consumeBibleHubResume("resume=plan")).toBe(true);
    expect(consumeBibleHubResume("?foo=1")).toBe(false);
  });
});

describe("login gate wiring", () => {
  it("gives the login-card subtitle an id so JS can replace it", () => {
    expect(html).toContain('id="login-gate-subtitle"');
    expect(html).toContain('id="btn-gate-nlc-login"');
    expect(html).toContain('id="login-gate-refresh-latest"');
    expect(html).toContain('href="/repair?source=login-gate"');
    expect(html).toContain("重新整理最新版");
  });

  it("calls getUserOnboardingBlock or getLoginGateCopy before updateAuthUI hides the gate", () => {
    const loggedInBlock = db.match(/if \(auth\.isLoggedIn\(\)\) \{[\s\S]*?return Boolean\(userId/);
    expect(loggedInBlock, "auth.isLoggedIn token path").toBeTruthy();
    const src = loggedInBlock[0];
    const predicateIdx = ["getUserOnboardingBlock", "getLoginGateCopy"]
      .map((token) => src.indexOf(token))
      .filter((idx) => idx >= 0)
      .sort((a, b) => a - b)[0];
    expect(predicateIdx, "token path must consult Hub onboarding before hiding the gate").toBeGreaterThan(-1);
    expect(src.indexOf("updateAuthUI")).toBeGreaterThan(predicateIdx);
    expect(src).toContain("copy.enterApp");
    expect(src).not.toContain("_applyTokenProfileFallback");
  });

  it("does not add hidden to #login-gate for a token session with a block", () => {
    expect(db).toContain("applyLoginGateView");
    expect(db).toMatch(/if \(copy\.enterApp\)/);
    expect(db).toMatch(/loginGate\.classList\.remove\(["']hidden["']\)|applyLoginGateView\(/);
    expect(db).toContain('dataset.loginGateMode');
  });

  it("routes the gate button through SSO, Hub continue, and retry-sync", () => {
    expect(db).toContain("auth.shouldRepairBeforeLogin?.()");
    expect(db).toContain("auth.startLoginRepair()");
    expect(db).toContain('authLaunch.startInteractiveAuth({ intent: "login", returnTo: "/" })');
    expect(db).toContain('"hub-continue"');
    expect(db).toContain("launchMemberHubContinue");
    expect(db).toContain('"retry-sync"');
    expect(db).toContain("syncNlcSessionWithSupabase(true)");
  });

  it("re-applies the predicate on visibilitychange when the gate is still up", () => {
    expect(db).toContain('document.addEventListener("visibilitychange"');
    expect(db).toMatch(/visibilitychange[\s\S]*login-gate[\s\S]*syncNlcSessionWithSupabase\(true\)|visibilitychange[\s\S]*syncNlcSessionWithSupabase\(true\)[\s\S]*login-gate/);
  });
});
