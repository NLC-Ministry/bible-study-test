import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const css = readFileSync("index.css", "utf8");

describe("profile action hierarchy", () => {
  it("shows the sync-status line before all member-center actions", () => {
    const syncIndex = html.indexOf('id="member-hub-org-sync-status"');
    const manageIndex = html.indexOf('id="btn-member-hub-structure"');
    const refreshIndex = html.indexOf('id="btn-member-hub-refresh"');
    expect(syncIndex).toBeGreaterThan(-1);
    expect(manageIndex).toBeGreaterThan(syncIndex);
    expect(refreshIndex).toBeGreaterThan(manageIndex);
  });

  it("groups APP sharing and help below the member-center section", () => {
    const syncIndex = html.indexOf('id="member-hub-org-sync-status"');
    const appHelpIndex = html.indexOf('class="profile-settings-section-label">APP 與協助');
    expect(syncIndex).toBeGreaterThan(-1);
    expect(appHelpIndex).toBeGreaterThan(syncIndex);
    expect(html.indexOf('id="btn-share-app"')).toBeGreaterThan(appHelpIndex);
    expect(html.indexOf('id="btn-release-onboarding-help"')).toBeGreaterThan(appHelpIndex);
    expect(css).toContain(".profile-settings-section-label");
  });

  it("uses chevrons only for navigation rows, not immediate actions", () => {
    const shareStart = html.indexOf('id="btn-share-app"');
    const helpStart = html.indexOf('id="btn-release-onboarding-help"');
    const shareMarkup = html.slice(shareStart, helpStart);
    const refreshStart = html.indexOf('id="btn-member-hub-refresh"');
    const refreshMarkup = html.slice(refreshStart, html.indexOf('</button>', refreshStart));
    expect(shareMarkup).not.toContain("app-settings-item__chevron");
    expect(refreshMarkup).not.toContain("app-settings-item__chevron");
    expect(html.slice(helpStart, html.indexOf('</button>', helpStart))).toContain("app-settings-item__chevron");
  });
});
