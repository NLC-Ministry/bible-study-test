import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const stateSource = readFileSync("js/state.js", "utf8");
const appSource = readFileSync("js/app.js", "utf8");
const htmlSource = readFileSync("index.html", "utf8");

describe("primary tab navigation lifecycle", () => {
  it("routes tab-bar clicks through the reselect-aware handler", () => {
    expect(stateSource).toContain("this.handleTabClick(target)");
    expect(stateSource).toContain("if (tabId !== this.currentTab)");
    expect(stateSource).toContain("if (this.isTabTransitioning) return");
    expect(stateSource).toContain("restoreTabScroll: true");
  });

  it("keeps an independent scroll position for each tab", () => {
    expect(stateSource).toContain("tabScrollPositions: Object.create(null)");
    expect(stateSource).toContain("captureTabScroll(tabId = this.currentTab)");
    expect(appSource).toContain("this.captureTabScroll(previousTab)");
    expect(appSource).toContain("await this.restoreTabScroll(tabId)");
  });

  it("returns nested plan and profile screens to their tab roots", () => {
    expect(stateSource).toContain('tabId === "plan-view"');
    expect(stateSource).toContain('await window.setPlanState("LIST")');
    expect(stateSource).toContain('tabId === "profile-view"');
    expect(stateSource).toContain("window.closeBadgeDetailPage()");
    expect(stateSource).toContain("window.closeProfileDetail()");
  });

  it("scrolls an already-rooted active tab to the top", () => {
    expect(stateSource).toContain('this.scrollActiveTabToTop({ behavior: "smooth" })');
    expect(stateSource).toContain('(prefers-reduced-motion: reduce)');
    expect(stateSource).not.toMatch(/window\.scrollTo\(\{\s*top:\s*0,\s*behavior:\s*["']smooth["']\s*\}\)/);
  });

  it("waits for rendering before restoring the target tab scroll", () => {
    const renderComplete = appSource.indexOf("this.updateNavigationChrome()", appSource.indexOf("appRouter.switchTab = async"));
    const restore = appSource.indexOf("await this.restoreTabScroll(tabId)");
    expect(renderComplete).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(renderComplete);
  });

  it("bumps the app entry cache version", () => {
    expect(htmlSource).toMatch(/js\/app\.js\?v=2026\d{4}_/);
    expect(appSource).toMatch(/\.\/db\.js\?v=2026\d{4}_/);
    expect(appSource).toMatch(/\.\/utils\.js\?v=2026\d{4}_/);
  });
});
