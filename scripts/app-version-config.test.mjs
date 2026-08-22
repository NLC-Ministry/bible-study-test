import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const buildConfig = readFileSync("build-config.js", "utf8");
const sw = readFileSync("sw.js", "utf8");
const app = readFileSync("js/app.js", "utf8");
const db = readFileSync("js/db.js", "utf8");
const indexHtml = readFileSync("index.html", "utf8");

describe("Bible app release version contract", () => {
  it("declares product version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("keeps package-lock metadata aligned with package.json", () => {
    expect(lockfile.version).toBe(pkg.version);
    expect(lockfile.packages[""].version).toBe(pkg.version);
  });

  it("generates runtime APP_CONFIG and APP_VERSION for browser support", () => {
    expect(buildConfig).toContain('const APP_CONFIG = {');
    expect(buildConfig).toContain('appVersion:');
    expect(buildConfig).toContain('onboardingVersion:');
    expect(buildConfig).toContain("window.APP_CONFIG = APP_CONFIG");
    expect(buildConfig).toContain("window.APP_VERSION = APP_CONFIG.appVersion");
  });

  it("injects a unique service worker cache version during every build", () => {
    expect(sw).toContain('const VERSION = "__BUILD_VERSION__"');
    expect(sw).toContain('const BUILD_CSS_PATH = "__BUILD_CSS_PATH__"');
    expect(sw).toContain('const BUILD_JS_PATH = "__BUILD_JS_PATH__"');
    expect(sw).toContain('version: VERSION');
  });

  it("keeps the static profile fallback version aligned with the release", () => {
    expect(indexHtml).toMatch(/版本\s*\d+\.\d+\.\d+/);
  });
});

describe("release onboarding startup timing", () => {
  it("keeps the onboarding UI module out of the app entry's static imports", () => {
    expect(app).toContain("maybeShowReleaseOnboarding");
    expect(app).toContain("RELEASE_ONBOARDING_MODULE_PATH");
    expect(app).toContain("import(RELEASE_ONBOARDING_MODULE_PATH)");
    expect(app).not.toContain("import { maybeShowReleaseOnboarding } from './modules/onboarding-helper.js");
  });

  it("captures install prompt cheaply before the lazy helper loads", () => {
    expect(app).toContain("window.__bibleDeferredInstallPrompt");
    expect(app).toContain('window.addEventListener("beforeinstallprompt"');
  });

  it("checks onboarding only after initial data load and dashboard render", () => {
    const loadUserData = app.indexOf("db.loadUserData(true)");
    const firstTab = app.indexOf('await appRouter.switchTab(resumePlan ? "plan-view" : "dashboard-view")');
    const onboarding = app.indexOf("maybeShowReleaseOnboarding({");

    expect(loadUserData).toBeGreaterThan(-1);
    expect(firstTab).toBeGreaterThan(loadUserData);
    expect(onboarding).toBeGreaterThan(firstTab);
  });

  it("only marks the initial session sync successful after a Logto profile sync", () => {
    expect(db).toContain("sessionSync = await this.syncNlcSessionWithSupabase(true)");
  });

  it("does not auto-show after a failed initial sync and does auto-show after both startup syncs succeed", () => {
    expect(app).toContain("let initialSessionSyncSucceeded = false");
    expect(app).toContain("initialSessionSyncSucceeded = await db.init() === true");
    expect(app).toContain("initialDataLoadSucceeded");
    expect(app).toContain("syncComplete: initialSessionSyncSucceeded && initialDataLoadSucceeded === true");
    expect(app).not.toContain("syncComplete: true");
  });
});
