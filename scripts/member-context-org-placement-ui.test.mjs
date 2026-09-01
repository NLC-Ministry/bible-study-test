import { describe, expect, it } from "vitest";
import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("index.css", "utf8");
const profileJs = fs.readFileSync("js/modules/profile.js", "utf8");

describe("Member Hub org placement UI", () => {
  it("shows 大區/牧區/小組 only in the profile header, not a duplicate placement box", () => {
    // Org placement lives solely in the header breadcrumb (#profile-summary-org).
    expect(html).toContain('id="profile-summary-org"');
    expect(html).toContain('id="member-hub-org-sync-status"');
    // The old standalone placement box must not come back (it duplicated the header).
    expect(html).not.toContain('id="member-hub-org-placement"');
    expect(html).not.toContain('id="member-hub-org-great-region"');
    expect(html).not.toContain('id="member-hub-org-pastoral-zone"');
    expect(html).not.toContain('id="member-hub-org-small-group"');
    expect(html).not.toContain('id="member-hub-org-empty"');
  });

  it("styles the sync-status caption without a bordered placement box", () => {
    expect(css).toContain(".member-hub-sync-caption");
    expect(css).not.toContain(".member-hub-org-placement");
  });

  it("keeps the Member Hub sync timestamp / failure formatting", () => {
    expect(profileJs).toContain("function formatMemberContextSyncedAt");
    expect(profileJs).toContain("function formatMemberContextSyncStatus");
    expect(profileJs).toContain("function renderMemberHubOrgPlacement");
    expect(profileJs).toContain("已同步自會員中心");
    expect(profileJs).toContain("會員中心同步暫時失敗");
    expect(profileJs).toContain("最近一次同步嘗試");
    expect(profileJs).toContain("member_context_sync_error");
  });
});

describe("Member Hub org placement refresh", () => {
  it("wires the refresh button to force a Member Hub session sync and re-render", () => {
    expect(html).toContain('id="btn-member-hub-refresh"');
    expect(profileJs).toContain('document.getElementById("btn-member-hub-refresh")');
    expect(profileJs).toContain("syncNlcSessionWithSupabase(true)");
    expect(profileJs).toContain("renderProfileView()");
  });

  it("keeps Hub-owned organization fields locked for Logto users", () => {
    expect(profileJs).toContain('"great_region"');
    expect(profileJs).toContain('"pastoral_zone"');
    expect(profileJs).toContain('"small_group"');
    expect(profileJs).toContain("lockedFields.has");
  });

  it("routes identity management to Member Hub onboarding, not pastoral admin", () => {
    expect(profileJs).toContain('getMemberHubUrl("onboarding")');
    expect(profileJs).toContain("identityUrl = urls.onboarding");
    expect(profileJs).not.toContain("pastoral/structure");
  });

  it("styles the profile logout action with theme-aware danger tokens", () => {
    expect(html).toContain('class="profile-logout-btn"');
    expect(css).toContain("--color-danger-foreground");
    expect(css).toContain("--color-danger-muted");
    expect(css).toContain(".profile-logout-btn");
    expect(html).not.toContain("hover:text-danger");
  });
});
