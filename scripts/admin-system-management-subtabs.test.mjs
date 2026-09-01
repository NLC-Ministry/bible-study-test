import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const html = read("index.html");
const admin = read("js/modules/admin.js");

describe("system management: category sub-tabs", () => {
  it("puts the tab bar above every system-management category, inside admin-system-panel, so navigation is visible before any single tab's content", () => {
    // Regression for: 功能開放設定 used to sit above the tab bar as an
    // always-visible block, pushing the tabs below the fold and making users
    // miss that later tabs existed at all. It's now its own tab instead of a
    // standing header card, and the tab bar itself leads the panel.
    const panelStart = html.indexOf('id="admin-system-panel"');
    const panelEnd = html.indexOf('id="admin-plans-panel"', panelStart);
    const panel = html.slice(panelStart, panelEnd);

    expect(panel).toContain("功能開放設定");
    expect(panel).toContain('id="admin-system-subtabs"');

    const subtabs = [
      ["users", "使用者基本資料"],
      ["permissions", "權限管理"],
      ["registrations", "報名註冊統計"],
      ["reports", "回報管理"],
      ["announcements", "公告管理"],
      ["settings", "功能開放設定"]
    ];
    for (const [key, label] of subtabs) {
      expect(panel).toContain(`data-system-subtab="${key}"`);
      expect(panel).toContain(`id="admin-system-subtab-${key}"`);
      expect(panel).toContain(label);
    }

    // The tab bar must precede every subtab panel, including 功能開放設定's.
    const tabsIndex = panel.indexOf('id="admin-system-subtabs"');
    for (const [key] of subtabs) {
      expect(panel.indexOf(`id="admin-system-subtab-${key}"`)).toBeGreaterThan(tabsIndex);
    }
  });

  it("groups each existing section under the right category tab", () => {
    const panelStart = html.indexOf('id="admin-system-panel"');
    const panelEnd = html.indexOf('id="admin-plans-panel"', panelStart);
    const panel = html.slice(panelStart, panelEnd);

    const usersStart = panel.indexOf('id="admin-system-subtab-users"');
    const permissionsStart = panel.indexOf('id="admin-system-subtab-permissions"');
    const registrationsStart = panel.indexOf('id="admin-system-subtab-registrations"');
    const reportsStart = panel.indexOf('id="admin-system-subtab-reports"');
    const announcementsStart = panel.indexOf('id="admin-system-subtab-announcements"');
    const settingsStart = panel.indexOf('id="admin-system-subtab-settings"');

    const usersSection = panel.slice(usersStart, permissionsStart);
    const permissionsSection = panel.slice(permissionsStart, registrationsStart);
    const registrationsSection = panel.slice(registrationsStart, reportsStart);
    const reportsSection = panel.slice(reportsStart, announcementsStart);
    const announcementsSection = panel.slice(announcementsStart, settingsStart);
    const settingsSection = panel.slice(settingsStart);

    expect(usersSection).toContain('id="admin-user-directory-col"');
    // 組織架構權限總覽 + 管理範圍設定 both live under 權限管理.
    expect(permissionsSection).toContain('id="admin-org-permissions-col"');
    expect(permissionsSection).toContain('id="admin-managed-scopes-col"');
    expect(registrationsSection).toContain('id="admin-registration-statistics-col"');
    expect(reportsSection).toContain('id="admin-reports-root"');
    expect(announcementsSection).toContain('id="admin-announcements-title"');
    expect(announcementsSection).toContain('id="admin-announcement-editor"');
    expect(announcementsSection).toContain('id="admin-announcements-list"');
    expect(settingsSection).toContain('class="glass-card admin-feature-settings-card"');
    expect(settingsSection).toContain('id="admin-pastoral-wall-toggle"');
    expect(settingsSection).toContain('id="admin-daily-quiz-feature-toggle"');
  });

  it("fixes the 報名與註冊統計 card's mislabeled 權限管理 eyebrow", () => {
    const cardStart = html.indexOf('id="admin-registration-statistics-col"');
    const cardEnd = html.indexOf("</section>", cardStart);
    const card = html.slice(cardStart, cardEnd);
    expect(card).toContain('<p class="admin-registration-statistics__eyebrow">報名註冊統計</p>');
    expect(card).not.toContain('<p class="admin-registration-statistics__eyebrow">權限管理</p>');
  });

  it("gives every subtab panel its own grid-column span, since admin-system-panel uses CSS Grid (unlike admin-plans-panel)", () => {
    // #admin-system-panel has class="grid-layout" (display:grid, 12 columns) —
    // a direct child with no grid-column span auto-places into a single 1/12
    // column, which is exactly what happened here: the whole panel content
    // rendered squeezed into a narrow column with wrapping text. #admin-plans-panel
    // (計畫管理) uses a different, non-grid layout, so its subtab panels never
    // needed this — copying its .admin-plan-subtab-panel class alone was not
    // enough inside the grid-based system panel.
    const subtabs = ["users", "permissions", "registrations", "reports", "announcements", "settings"];
    for (const key of subtabs) {
      const divTag = html.match(new RegExp(`<div id="admin-system-subtab-${key}" class="([^"]*)"`));
      expect(divTag).toBeTruthy();
      expect(divTag[1]).toContain("card-col");
      expect(divTag[1]).toContain("span-12");
      expect(divTag[1]).toContain("admin-plan-subtab-panel");
    }
  });

  it("wires tab-switching in admin.js, mirroring the 計畫管理 tab pattern", () => {
    expect(admin).toContain("const ADMIN_SYSTEM_SUBTABS = ['users', 'permissions', 'registrations', 'reports', 'announcements', 'settings'];");
    expect(admin).toContain("function setAdminSystemSubtab(subtab)");
    expect(admin).toContain("function initAdminSystemSubtabs()");
    expect(admin).toContain("'selected_admin_system_subtab'");
    expect(admin).toContain("#admin-system-subtabs [data-system-subtab]");

    const initStart = admin.indexOf("export function init()");
    const initEnd = admin.indexOf("\n}", initStart);
    const initBody = admin.slice(initStart, initEnd);
    expect(initBody).toContain("initAdminSystemSubtabs();");
  });
});
