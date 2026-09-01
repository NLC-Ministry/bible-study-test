import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const html = read("index.html");
const admin = read("js/modules/admin.js");

describe("system management: unified section architecture", () => {
  const sections = [
    ["users", "使用者基本資料"], ["permissions", "權限管理"],
    ["registrations", "報名註冊統計"], ["reports", "回報管理"],
    ["announcements", "公告管理"], ["settings", "功能開放設定"]
  ];

  it("uses one navigation list and one content host without legacy tab wrappers", () => {
    expect(html).toContain('id="admin-section-nav"');
    expect(html).toContain('id="admin-section-content"');
    for (const id of ["admin-primary-tabs", "admin-system-panel", "admin-system-subtabs", "admin-plans-panel", "admin-plan-subtabs"]) {
      expect(html).not.toContain(`id="${id}"`);
    }
  });

  it("mounts every system destination as a unified section panel", () => {
    for (const [key, label] of sections) {
      const tag = html.match(new RegExp(`<div id="admin-section-${key}" class="([^"]*)"`));
      expect(tag).toBeTruthy();
      expect(tag[1]).toContain("admin-section-panel");
      expect(admin).toContain(`label: '${label}'`);
    }
  });

  it("keeps each system feature under the correct destination", () => {
    const slice = (startId, endId) => {
      const start = html.indexOf(`id="admin-section-${startId}"`);
      const end = endId ? html.indexOf(`id="admin-section-${endId}"`, start) : html.indexOf('id="admin-plan-context"', start);
      return html.slice(start, end);
    };
    expect(slice("users", "permissions")).toContain('id="admin-user-directory-col"');
    expect(slice("permissions", "registrations")).toContain('id="admin-managed-scopes-col"');
    expect(slice("registrations", "reports")).toContain('id="admin-registration-statistics-col"');
    expect(slice("reports", "announcements")).toContain('id="admin-reports-root"');
    expect(slice("announcements", "settings")).toContain('id="admin-announcement-editor"');
    expect(slice("settings")).toContain('id="admin-daily-quiz-feature-toggle"');
  });

  it("directly toggles unified panels and persists one section key", () => {
    expect(admin).toContain("function setAdminSection(id, options = {})");
    expect(admin).toContain("document.querySelectorAll('#admin-section-content > .admin-section-panel')");
    expect(admin).toContain("panel.id === targetId");
    expect(admin).toContain("sessionStorage.setItem('selected_admin_section', section.id)");
    expect(admin).not.toContain("setAdminPrimaryPanel");
    expect(admin).not.toContain("setAdminSystemSubtab");
    expect(admin).not.toContain("setAdminPlanSubtab");
  });
});
