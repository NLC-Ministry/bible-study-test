import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const app = readFileSync("js/app.js", "utf8");
const home = readFileSync("js/modules/home.js", "utf8");

describe("startup performance contract", () => {
  it("keeps React issue-report UI out of the initial app bundle", () => {
    expect(app).not.toContain("import React from 'react'");
    expect(app).not.toContain("from 'react-dom/client'");
    expect(app).not.toContain("../components/issue-report/IssueReportFab.tsx");
    expect(app).toContain("loadIssueReportUi");
    expect(app).toContain("ISSUE_REPORT_UI_MODULE_PATH");
    expect(app).toContain("import(path)");
  });

  it("uses the injected production build id instead of cache-busting every launch", () => {
    expect(app).toContain('if (!/^\\d{14}$/.test(buildVersion))');
    expect(app).not.toContain('buildVersion.includes("__BUILD_VERSION__")');
  });

  it("schedules the issue report UI before PWA initialization can delay it", () => {
    const reportSchedule = app.lastIndexOf("scheduleIssueReportUiLoad({ includeAdmin: false })");
    const pwaInitialization = app.indexOf("await initializePwa()");

    expect(reportSchedule).toBeGreaterThan(-1);
    expect(pwaInitialization).toBeGreaterThan(-1);
    expect(reportSchedule).toBeLessThan(pwaInitialization);
    expect(app).toContain("window.setTimeout(() => {");
    expect(app).toContain("window.requestIdleCallback(load, { timeout: 5000 })");
    expect(app).toContain("}, 3000)");
  });

  it("keeps registration helper modules lazy until their surfaces need them", () => {
    expect(app).not.toContain("import './modules/campaign-rule-editor.js");
    expect(app).not.toContain("import './modules/team-registration.js");
    expect(app).toContain("ensurePlanFeatureModulesLoaded");
    expect(app).toContain("ensureAdminFeatureModulesLoaded");
  });

  it("renders plan management before loading secondary admin bundles", () => {
    const adminBranch = app.slice(
      app.indexOf('} else if (tabId === "admin-view")'),
      app.indexOf("// ── 6. updateNavigationChrome", app.indexOf('} else if (tabId === "admin-view")'))
    );
    const planRender = adminBranch.indexOf("await mod.renderAdminPlanManagement()");
    const secondaryLoad = adminBranch.indexOf("void Promise.all([");

    expect(planRender).toBeGreaterThan(-1);
    expect(secondaryLoad).toBeGreaterThan(planRender);
    expect(adminBranch).not.toContain("await loadIssueReportUi({ includeAdmin: true })");
    expect(adminBranch).not.toContain("await ensureAdminFeatureModulesLoaded()");
  });

  it("does not block first dashboard render on care reminder fetches", () => {
    const forcedReminder = app.lastIndexOf("refreshCareReminderBadge({ force: true })");
    const firstTab = app.indexOf('await appRouter.switchTab(resumePlan ? "plan-view" : "dashboard-view")');

    expect(forcedReminder).toBeGreaterThan(-1);
    expect(firstTab).toBeGreaterThan(-1);
    expect(forcedReminder).toBeGreaterThan(firstTab);
  });

  it("does not block first dashboard render on organization-directory loading", () => {
    const firstTab = app.indexOf('await appRouter.switchTab(resumePlan ? "plan-view" : "dashboard-view")');
    const orgLoad = app.lastIndexOf("db.loadOrgStructure()");

    expect(firstTab).toBeGreaterThan(-1);
    expect(orgLoad).toBeGreaterThan(firstTab);
  });

  it("defers secondary dashboard widgets after the core dashboard card renders", () => {
    expect(home).toContain("scheduleDashboardSecondaryWork");
    expect(home).not.toContain("calculateAndRenderPersonalRankings();\n  renderPastoralZoneRankingList();\n  loadTodayDevotional();");
  });
});
