import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), "utf8");

const html = read("index.html");
const stateJs = read("js/state.js");
const utilsJs = read("js/utils.js");
const profileJs = read("js/modules/profile.js");
const dbJs = read("js/db.js");
const authJs = read("js/auth.js");
const appJs = read("js/app.js");
const nlcSession = read("supabase/functions/nlc-session/index.ts");
const copyJs = read("js/copy/zh-Hant.js");

describe("No invented display-name fallbacks", () => {
  it("does not ship static 新使用者 on the profile name", () => {
    expect(html).not.toMatch(/id="profile-summary-name"[^>]*>\s*新使用者/);
    expect(html).toMatch(/id="profile-summary-name"[^>]*aria-busy="true"/);
  });

  it("defines getDisplayName and rejects known invented placeholders", () => {
    expect(utilsJs).toContain("function getDisplayName");
    expect(utilsJs).toContain("INVENTED_DISPLAY_NAMES");
    expect(utilsJs).toContain("新使用者");
    expect(utilsJs).toContain("NLC User");
    expect(utilsJs).toContain("function isMemberContextPending");
  });

  it("does not invent names in apply/create/auth/session paths", () => {
    expect(profileJs).not.toMatch(/\|\|\s*["']新使用者["']/);
    expect(profileJs).not.toMatch(/\|\|\s*["']NLC User["']/);
    expect(dbJs).not.toMatch(/\|\|\s*["']NLC User["']/);
    expect(dbJs).not.toMatch(/\|\|\s*["']新使用者["']/);
    expect(dbJs).not.toMatch(/name:\s*["']訪客["']/);
    expect(authJs).not.toMatch(/\|\|\s*["']NLC User["']/);
    expect(nlcSession).not.toMatch(/firstValue\([^)]*["']NLC User["']/);
  });

  it("neutralizes demo state.currentUser identity defaults", () => {
    expect(stateJs).not.toMatch(/name:\s*["']系統管理員["']/);
    expect(stateJs).not.toMatch(/great_region:\s*["']東區["']/);
    expect(stateJs).not.toMatch(/pastoral_zone:\s*["']大安1["']/);
    expect(stateJs).not.toMatch(/small_group:\s*["']馬鈴["']/);
    expect(stateJs).toContain("profileIdentityLoading");
  });
});

describe("Profile identity skeleton lifecycle", () => {
  it("ships the profile-header org breadcrumb as skeleton markup before sync settles", () => {
    // Org placement is shown once, in the profile header (#profile-summary-org).
    expect(html).toMatch(/id="profile-summary-org"[\s\S]*?skeleton-wrapper/);
    expect(html).not.toContain('id="member-hub-org-great-region"');
  });

  it("gates the Member Hub sync-status caption on pending state", () => {
    expect(profileJs).toContain("isMemberContextPending");
    expect(profileJs).toContain("member-hub-org-sync-status");
    expect(profileJs).toContain("同步中");
    expect(profileJs).toContain("applyProfileIdentitySkeletons");
    expect(profileJs).toContain("paintProfileIdentityChrome");
  });

  it("does not restore invented boot HTML when clearing inline skeletons", () => {
    expect(utilsJs).toContain("clearBootInlineSkeletons");
    expect(utilsJs).toContain("paintProfileIdentityChrome");
    expect(utilsJs).not.toMatch(/clearBootInlineSkeletons\(\)\s*\{[^}]*restoreInlineSkeleton\("#profile-summary-name"\)/s);
  });

  it("renders profile view directly without auto-syncing on tab switch", () => {
    expect(appJs).toContain('tabId === "profile-view"');
    expect(appJs).not.toContain("await db.syncNlcSessionWithSupabase(true)");
  });

  it("exposes approved empty name copy after sync", () => {
    expect(copyJs).toContain("nameUnset");
    expect(copyJs).toContain("尚未取得姓名");
    expect(profileJs).toContain("nameUnset");
  });
});
