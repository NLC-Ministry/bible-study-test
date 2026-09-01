import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));
const html = fs.readFileSync(join(root, "index.html"), "utf8");
const home = fs.readFileSync(join(root, "js/modules/home.js"), "utf8");
const admin = fs.readFileSync(join(root, "js/modules/admin.js"), "utf8");
const db = fs.readFileSync(join(root, "js/db.js"), "utf8");

describe("公告管理區塊", () => {
  it("與大測驗分離並提供新增與編輯文案", () => {
    expect(html).toContain('dashboard-panel-card__title-text">教會公告');
    expect(html).toContain('id="admin-section-announcements"');
    expect(admin).toContain("{ id: 'announcements', group: '內容管理',   label: '公告管理'");
    expect(html).toContain('<option value="general">一般公告</option>');
    expect(html).toContain('<option value="urgent">重要／緊急公告</option>');
    expect(admin).toContain('type === "urgent" ? "【緊急】" : "【一般】"');
    expect(admin).toContain("重要／緊急公告請設定顯示到期時間");
    expect(home).toContain("return aUrgent ? -1 : 1");
    expect(home).toContain("expiresAt > now");
    expect(home).not.toContain("openAnnouncementForm");
    expect(html).not.toContain("btn-show-announcement-form");
  });

  it("編輯時更新原公告並使公告快取失效", () => {
    expect(db).toContain("async updateAnnouncement(id, title, content, expiresAt = null)");
    expect(db).toMatch(/from\('church_announcements'\)[\s\S]*?\.update\(\{ title, content, expires_at: expiresAt \|\| null \}\)[\s\S]*?\.eq\('id', id\)/);
    expect(db).toContain('localStorage.removeItem("church_announcements_fetched_at")');
  });
});
