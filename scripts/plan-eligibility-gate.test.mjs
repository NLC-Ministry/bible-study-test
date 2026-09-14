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

describe("profile name handling (js/utils.js)", () => {
  it("no longer maintains a frontend placeholder-name detection list — Member Hub is the sole source of truth, getDisplayName just trusts stored values", () => {
    expect(utils).not.toContain("INVENTED_DISPLAY_NAMES");
    expect(utils).not.toContain("function getProfileNameFlags(");
    expect(utils).not.toContain("function isProfileNameValid(");
    expect(utils).not.toContain("function looksLikeGibberishEnglish(");
    expect(utils).not.toContain("PROFILE_NAME_DIGIT_PATTERN");
    expect(utils).not.toContain("PROFILE_NAME_EMOJI_PATTERN");
  });

  it("no longer defines a plan-tab eligibility gate — the check moved to login", () => {
    // 計畫資格改成只在登入時判斷（db.init → getUserOnboardingBlock → getLoginGateCopy）。
    expect(utils).not.toContain("function getPlanEligibilityBlock(");
    expect(utils).not.toContain("window.getPlanEligibilityBlock");
    expect(utils).not.toContain("getPlanEligibilitySoftState");
    expect(utils).not.toContain("planEligibilityVerifiedThisSession");
    expect(utils).not.toContain("plan_elig_hub_verified");
  });
});

describe("plan entry: eligibility judged at login only (js/app.js + js/db.js)", () => {
  it("plan-view switchTab branch renders the plan module directly, no eligibility re-check", () => {
    const planBranch = app.match(/\} else if \(tabId === "plan-view"\) \{[\s\S]*?\n {4}\} else if \(tabId === "stats-view"\)/);
    expect(planBranch, "plan-view switchTab branch").toBeTruthy();
    expect(planBranch[0]).not.toContain("getPlanEligibilityBlock");
    expect(planBranch[0]).not.toContain("renderPlanEligibilityGate");
    expect(planBranch[0]).not.toContain("getPlanEligibilitySoftState");
    expect(planBranch[0]).toContain("hidePlanEligibilityGate()");
    expect(planBranch[0]).toContain("loadModule('plan'");
  });

  it("guardPlanEligibility is a no-op so its existing call sites never block", () => {
    expect(app).toMatch(/function guardPlanEligibility\(\)\s*\{\s*return false;\s*\}/);
    expect(app).toContain("window.guardPlanEligibility = guardPlanEligibility");
    // Call sites stay (harmless no-op) — no need to touch home.js / plan.js.
    expect(homeModule).toMatch(/openActivePlanFromDashboard[\s\S]*guardPlanEligibility\(\)/);
    expect(planModule).toMatch(/openPlanChapterInReader[\s\S]*guardPlanEligibility\(\)/);
  });

  it("removes the dead plan-eligibility gate machinery from app.js", () => {
    expect(app).not.toContain("function renderPlanEligibilityGate");
    expect(app).not.toContain("function retryPlanEligibilityQuietly");
    expect(app).not.toContain("function getPlanEligibilityGateCopy");
    expect(app).not.toContain("function resetPlanNavigationForEligibilityGate");
    expect(app).not.toContain("function bindPlanEligibilityHubReturnSync");
    expect(app).not.toContain("resyncPlanEligibilityAfterHubReturn");
  });

  it("db.init evaluates the login gate right after a fresh member-context sync", () => {
    // 登入流程：同步 → getUserOnboardingBlock → getLoginGateCopy → 進 App 或停在登入卡
    const initSlice = db.slice(db.indexOf("if (auth.isLoggedIn())"), db.indexOf("if (auth.isLoggedIn())") + 2000);
    expect(initSlice).toContain("await this.syncNlcSessionWithSupabase(true)");
    expect(initSlice).toContain("const block = getUserOnboardingBlock(state.currentUser)");
    expect(initSlice).toContain("getLoginGateCopy(block");
    expect(initSlice).toContain("applyLoginGateView");
  });

  it("login gate copy still covers every fail-closed member-hub reason", () => {
    const gate = read("js/login-onboarding-gate.mjs");
    expect(gate).toContain('block.reason === "member_profile_required"');
    expect(gate).toContain('block.reason === "membership_application_required"');
    expect(gate).toContain('block.reason === "member_context_unavailable"');
    expect(gate).toContain('block.reason === "inactive_membership"');
  });
});

describe("name-review feature removed (admin.js + index.html + db.js + nlc-data + nlc-session)", () => {
  it("no longer shows a name-review filter or badge in the admin user directory", () => {
    expect(html).not.toContain('id="admin-user-directory-filter-name-review"');
    expect(admin).not.toContain("getNameReviewFlags");
    expect(admin).not.toContain("profileNameNeedsReview");
    expect(admin).not.toContain("NAME_FLAG_LABELS");
    expect(admin).not.toContain("admin-user-directory__name-review");
    expect(admin).not.toContain("bindAdminUserDirectoryNameReviewActions");
    expect(adminCss).not.toContain(".admin-user-directory__name-review");
    // --status--disabled stays: it's shared with the account-active-status badge.
    expect(adminCss).toContain(".admin-user-directory__status--disabled");
  });

  it("no longer exposes admin write paths for approving/overwriting a name", () => {
    expect(db).not.toContain("approveProfileName");
    expect(db).not.toContain("adminOverwriteProfileName");
    expect(admin).not.toContain("db.approveProfileName");
    expect(admin).not.toContain("db.adminOverwriteProfileName");
  });

  it("name_review_approved is gone from every select/write path and superseded by a drop migration", () => {
    expect(db).not.toContain("name_review_approved");
    expect(nlcData).not.toContain("name_review_approved");
    const nlcSession = read("supabase/functions/nlc-session/index.ts");
    expect(nlcSession).not.toContain("name_review_approved");
    const dropMigration = read("supabase/migrations/0172_drop_name_review_approved.sql");
    expect(dropMigration).toContain("DROP COLUMN IF EXISTS name_review_approved");
  });
});
