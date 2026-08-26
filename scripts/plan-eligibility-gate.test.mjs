import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const utils = read("js/utils.js");
const app = read("js/app.js");
const homeModule = read("js/modules/home.js");
const planModule = read("js/modules/plan.js");
const html = read("index.html");
const css = read("index.css");
const adminCss = read("css/admin-registration-statistics.css");
const admin = read("js/modules/admin.js");
const db = read("js/db.js");
const nlcData = read("supabase/functions/nlc-data/index.ts");
const migration = read("supabase/migrations/0069_name_review_approval.sql");

describe("profile name heuristic (js/utils.js)", () => {
  it("merges the placeholder-name lists and exports them for reuse", () => {
    expect(utils).toContain("尚未取得姓名");
    expect(utils).toContain("未命名使用者");
    expect(utils).toContain("教會肢體");
    expect(utils).toContain("window.INVENTED_DISPLAY_NAMES = INVENTED_DISPLAY_NAMES");
  });

  it("flags digits, emoji, and gibberish English, and exports isProfileNameValid", () => {
    expect(utils).toContain("function getProfileNameFlags(name)");
    expect(utils).toContain("PROFILE_NAME_DIGIT_PATTERN.test(trimmed)) flags.push(\"digits\")");
    expect(utils).toContain("PROFILE_NAME_EMOJI_PATTERN.test(trimmed)) flags.push(\"emoji\")");
    expect(utils).toContain("looksLikeGibberishEnglish");
    expect(utils).toContain("function isProfileNameValid(name)");
    expect(utils).toContain("window.getProfileNameFlags = getProfileNameFlags");
    expect(utils).toContain("window.isProfileNameValid = isProfileNameValid");
  });

  it("evaluates gibberish heuristic correctly for representative tokens", () => {
    const fn = new Function(`
      ${utils.match(/function looksLikeGibberishEnglish[\s\S]*?\n}/)[0]}
      return looksLikeGibberishEnglish;
    `)();
    expect(fn("bxfgh")).toBe(true); // no vowel
    expect(fn("aaaaa")).toBe(true); // tripled letter
    expect(fn("asdfgh")).toBe(true); // 5+ consonant run (asdfgh has no vowel anyway, still flagged)
    expect(fn("David")).toBe(false);
    expect(fn("Grace")).toBe(false);
    expect(fn("a")).toBe(false); // too short to judge
  });

  it("defines getPlanEligibilityBlock using the same user-completion predicate as the login card", () => {
    expect(utils).toContain("function getPlanEligibilityBlock(user)");
    const fnMatch = utils.match(/function getPlanEligibilityBlock\(user\) \{[\s\S]*?\nwindow\.getPlanEligibilityBlock/);
    expect(fnMatch, "getPlanEligibilityBlock source").toBeTruthy();
    const fn = fnMatch[0];
    expect(fn).toMatch(/getUserOnboardingBlock\(u\)|getCanonicalMemberPrerequisiteBlock\(u\)/);
    expect(fn).not.toContain('!String(u.pastoral_zone || "").trim()');
    // Hub-complete (null canonical block) wins over local name flags, and is
    // remembered so a later stale-timestamp block doesn't re-interrupt an
    // already-verified session.
    expect(fn).toMatch(/if \(!canonicalBlock\) \{[\s\S]*?return null;[\s\S]*?\}/);
    expect(fn).toContain("planEligibilityVerifiedThisSession");
    expect(fn).not.toContain("getProfileNameFlags");
    expect(utils).toContain("window.getPlanEligibilityBlock = getPlanEligibilityBlock");
    // Demo accounts must not be locked out of a feature they use for local/dev testing.
    expect(utils).toMatch(/if \(!u \|\| u\.is_demo\) return null;/);
  });
});

describe("plan-entry blocking gate (js/app.js + index.html + index.css)", () => {
  it("checks eligibility before loading the plan module on plan-view entry", () => {
    const planBranch = app.match(/\} else if \(tabId === "plan-view"\) \{[\s\S]*?\n {4}\} else if \(tabId === "stats-view"\)/);
    expect(planBranch, "plan-view switchTab branch").toBeTruthy();
    expect(planBranch[0]).toContain("getPlanEligibilityBlock(state.currentUser)");
    expect(planBranch[0]).toContain("renderPlanEligibilityGate(eligibilityBlock)");
    expect(planBranch[0]).toContain("hidePlanEligibilityGate()");
    // The gate must short-circuit before the (large) plan module is fetched.
    const gatedIndex = planBranch[0].indexOf("if (eligibilityBlock)");
    const loadIndex = planBranch[0].indexOf("loadModule('plan'");
    expect(gatedIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeGreaterThan(gatedIndex);
  });

  it("blocks dashboard reading shortcuts and every direct plan reader entry", () => {
    expect(homeModule).toMatch(/openActivePlanFromDashboard[\s\S]*guardPlanEligibility\(\)/);
    expect(homeModule).toMatch(/startReadingCurrentChapter[\s\S]*guardPlanEligibility\(\)/);
    expect(planModule).toMatch(/openPlanChapterInReader[\s\S]*guardPlanEligibility\(\)/);
    expect(planModule).toMatch(/openPlanInlineReader[\s\S]*guardPlanEligibility\(\)/);
  });

  it("returns blocked members to the plan root before showing the explanation", () => {
    expect(app).toContain("function resetPlanNavigationForEligibilityGate()");
    expect(app).toContain('window.currentPlanViewState = "LIST"');
    expect(app).toContain("state.planDetailOpen = false");
    expect(app).toContain("if (state.inlineReader) state.inlineReader.active = false");
    expect(app).toContain("resetPlanNavigationForEligibilityGate();");
    expect(app).toContain("appRouter.updateNavigationChrome();");
  });

  it("re-syncs from Member Hub on return and never offers a local edit form", () => {
    expect(app).toContain("function bindPlanEligibilityHubReturnSync");
    expect(app).toContain("db.syncNlcSessionWithSupabase(true)");
    expect(app).toContain("launchMemberHubContinue");
    expect(app).toContain("BIBLE_HUB_CONTINUE_RETURN_TO");
    expect(app).toContain("consumeBibleHubResume");
    expect(app).toContain('switchTab(resumePlan ? "plan-view" : "dashboard-view")');
    expect(app).not.toContain('getMemberHubUrl("onboarding")');
    expect(app).toContain("window.renderPlanEligibilityGate = renderPlanEligibilityGate");
    expect(app).toContain("window.hidePlanEligibilityGate = hidePlanEligibilityGate");
    // Regression guard: the gate is read-only. Members fix their own data
    // exclusively through the Member Hub, never through an in-app form —
    // js/db.js syncProfileStatsToSupabase() must not be reachable from here.
    expect(app).not.toContain("bindPlanEligibilityNameForm");
    expect(app).not.toContain("plan-eligibility-gate-name-save");
    expect(app).not.toContain("db.syncProfileStatsToSupabase()");
  });

  it("keeps fail-closed copy and the Member Hub continue link, without coaching 牧區", () => {
    const copyMatch = app.match(/function getPlanEligibilityGateCopy\(block\) \{[\s\S]*?\nfunction resetPlanNavigationForEligibilityGate/);
    expect(copyMatch, "getPlanEligibilityGateCopy").toBeTruthy();
    const src = copyMatch[0];
    expect(src).toContain('block.reason === "member_context_unavailable"');
    expect(src).toContain('block.reason === "inactive_membership"');
    expect(src).toContain('block.reason === "unknown_member_hub_action"');
    expect(src).toContain('block.reason === "unknown_member_hub_state"');
    expect(src).toContain('block.reason === "membership_record_inconsistent"');
    expect(src).not.toContain('block.reason === "missing_zone"');
    expect(src).not.toContain('block.reason === "missing_name"');
    expect(src).not.toContain("完成會員資料後即可進入計畫");
    expect(src).not.toContain("牧區");
    expect(app).toContain("BIBLE_HUB_CONTINUE_RETURN_TO");
    expect(app).not.toContain('auth.getMemberHubUrl("member/continue?satellite=bible-app&returnTo=%2F")');
    // Unlike the old design, the hub link is unconditional — no per-reason toggle.
    expect(app).not.toContain("showHubLink");
    expect(app).not.toContain("showNameForm");
  });

  it("renders read-only gate markup inside #plan-view with only a Member Hub link, no editable fields", () => {
    const gateMarkup = html.slice(
      html.indexOf('id="plan-eligibility-gate"'),
      html.indexOf('id="plan-eligibility-gate-hub-link"') + 400
    );
    expect(html).toContain('<section id="plan-view" class="view-pane hidden">');
    expect(html).toContain('id="plan-eligibility-gate"');
    expect(html).toContain('id="plan-eligibility-gate-hub-link"');
    expect(gateMarkup).toContain("member/continue?satellite=bible-app");
    expect(gateMarkup).toContain("resume%3Dplan");
    expect(gateMarkup).not.toContain('target="_blank"');
    expect(html).not.toContain('id="plan-eligibility-gate-name-input"');
    expect(html).not.toContain('id="plan-eligibility-gate-name-save"');
    expect(html).not.toContain('id="plan-eligibility-gate-name-form"');
  });

  it("hides every other plan-view child while gated, using theme tokens only", () => {
    const rule = css.match(/#plan-view\.plan-view--gated > \*:not\(#plan-eligibility-gate\) \{[^}]+\}/);
    expect(rule, "#plan-view.plan-view--gated rule").toBeTruthy();
    expect(rule[0]).toContain("display: none !important");
    const gateBlock = css.match(/\.plan-eligibility-gate__desc \{[^}]+\}/);
    expect(gateBlock[0]).toMatch(/var\(--text-secondary\)/);
  });
});

describe("admin name-review console (js/modules/admin.js + index.html)", () => {
  it("adds a name-review filter checkbox next to the existing incomplete-profile filters", () => {
    expect(html).toContain('id="admin-user-directory-filter-name-review"');
  });

  it("computes review status from the shared heuristic, excluding merely-empty names", () => {
    expect(admin).toContain("function getNameReviewFlags(profile)");
    expect(admin).toContain('getProfileNameFlags(profile.name).filter(flag => flag !== "empty")');
    expect(admin).toContain("function profileNameNeedsReview(profile)");
    expect(admin).toContain("profile.name_review_approved !== true");
  });

  it("reuses the merged placeholder set instead of a third hardcoded list", () => {
    expect(admin).toContain("window.INVENTED_DISPLAY_NAMES");
  });

  it("wires an approve action and an edit-and-approve action per flagged card", () => {
    expect(admin).toContain("admin-user-directory__name-review-approve");
    expect(admin).toContain("admin-user-directory__name-review-save");
    expect(admin).toContain("db.approveProfileName(profileId)");
    expect(admin).toContain("db.adminOverwriteProfileName(");
    expect(admin).toContain("function bindAdminUserDirectoryNameReviewActions(list)");
    expect(admin).toContain("bindAdminUserDirectoryNameReviewActions(list)");
  });

  it("styles the disabled/needs-review status badge (regression: --disabled had no matching CSS rule)", () => {
    expect(adminCss).toContain(".admin-user-directory__status--disabled");
  });
});

describe("admin write path for name review (js/db.js)", () => {
  it("requires the admin role for both approve and overwrite actions", () => {
    const approveFn = db.match(/async approveProfileName\(profileId\) \{[\s\S]*?\n {2}\},/);
    const overwriteFn = db.match(/async adminOverwriteProfileName\(profileId, name\) \{[\s\S]*?\n {2}\},/);
    expect(approveFn, "approveProfileName").toBeTruthy();
    expect(overwriteFn, "adminOverwriteProfileName").toBeTruthy();
    expect(approveFn[0]).toContain('getUserRoleCode(state.currentUser) !== "admin"');
    expect(overwriteFn[0]).toContain('getUserRoleCode(state.currentUser) !== "admin"');
    expect(approveFn[0]).toContain("name_review_approved: true");
    expect(overwriteFn[0]).toContain("name_review_approved: true");
  });
});

describe("name_review_approved column (migration 0069 + nlc-data)", () => {
  it("adds the column as NOT NULL DEFAULT false, consistent with the other profile flags", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS name_review_approved BOOLEAN NOT NULL DEFAULT false");
  });

  it("exposes the column through PROFILE_SELECT so the client can read it", () => {
    const selects = [...nlcData.matchAll(/select\("([^"]*name_review_approved[^"]*)"\)/g)];
    expect(nlcData).toContain("name_review_approved");
    expect(nlcData.match(/PROFILE_SELECT = "[^"]*name_review_approved/)).toBeTruthy();
  });

  it("loads and applies the approval flag to every current-user profile path", () => {
    expect(db).toMatch(/from\("profiles"\)\.select\("[^"]*name_review_approved[^"]*"\)/);
    expect(db).toContain("state.currentUser.name_review_approved = profile.name_review_approved === true");
    expect(db).toContain("state.currentUser.name_review_approved = false");
  });

  it("resets the approval on self-service name changes so a stale approval cannot survive an edit", () => {
    const start = nlcData.indexOf('if (action === "save_profile")');
    const end = nlcData.indexOf('if (action === "insert"', start);
    expect(start, "save_profile branch start").toBeGreaterThan(-1);
    expect(end, "save_profile branch end").toBeGreaterThan(start);
    const saveProfileBranch = nlcData.slice(start, end);
    expect(saveProfileBranch).toContain("nameChanged");
    expect(saveProfileBranch).toContain("updatePayload.name_review_approved = false");
  });
});
