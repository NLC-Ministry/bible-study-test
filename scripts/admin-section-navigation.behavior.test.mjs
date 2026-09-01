import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

let dom;

beforeEach(async () => {
  vi.resetModules();
  dom = new JSDOM(`<!doctype html><body>
    <nav id="admin-section-nav"></nav>
    <div id="admin-section-content">
      <div id="admin-section-users" class="admin-section-panel"></div>
      <div id="admin-section-permissions" class="admin-section-panel hidden"></div>
      <div id="admin-section-registrations" class="admin-section-panel hidden"></div>
      <div id="admin-section-reports" class="admin-section-panel hidden"></div>
      <div id="admin-section-announcements" class="admin-section-panel hidden"></div>
      <div id="admin-section-settings" class="admin-section-panel hidden"></div>
      <div id="admin-plan-context" class="hidden"></div>
      <div id="admin-section-join-status" class="admin-section-panel hidden"></div>
      <div id="admin-section-members" class="admin-section-panel hidden"></div>
      <div id="admin-section-teams" class="admin-section-panel hidden"></div>
      <div id="admin-section-statistics" class="admin-section-panel hidden"></div>
      <div id="admin-section-quizzes" class="admin-section-panel hidden"></div>
      <div id="admin-section-exam" class="admin-section-panel hidden"></div>
    </div>
  </body>`, { url: "https://example.test" });

  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
  vi.stubGlobal("state", { currentUser: { role: "admin" }, activePlan: null });
  vi.stubGlobal("getUserRoleCode", () => "admin");
  vi.stubGlobal("escapeHTML", value => String(value));
  vi.stubGlobal("hydrateIcons", () => {});
  vi.stubGlobal("requestAnimationFrame", callback => callback());
  dom.window.scrollTo = vi.fn();
  Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(dom.window, "scrollY", { configurable: true, value: 100 });
  await import("../js/modules/admin.js?admin-section-navigation");
});

afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("unified admin section navigation", () => {
  it("opens 公告管理 when its generated navigation button is clicked", () => {
    window.renderAdminSectionNav();
    const button = document.querySelector('[data-admin-section="announcements"]');
    expect(button).toBeTruthy();

    button.click();

    const announcementPanel = document.getElementById("admin-section-announcements");
    expect(announcementPanel.style.display).toBe("flex");
    expect(announcementPanel.classList.contains("hidden")).toBe(false);
  });

  it("moves a below-the-fold mobile panel into view after a user click", () => {
    window.renderAdminSectionNav();
    const announcementPanel = document.getElementById("admin-section-announcements");
    announcementPanel.getBoundingClientRect = () => ({ top: 1000, bottom: 1400, left: 0, right: 400, width: 400, height: 400 });

    document.querySelector('[data-admin-section="announcements"]').click();

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 1016, behavior: "smooth" });
  });
});
