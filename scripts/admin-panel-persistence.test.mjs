import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("unified admin section persistence", () => {
  const admin = readFileSync("js/modules/admin.js", "utf8");

  it("persists and restores one selected_admin_section key", () => {
    expect(admin).toContain("sessionStorage.setItem('selected_admin_section', section.id)");
    expect(admin).toContain("sessionStorage.getItem('selected_admin_section')");
  });

  it("does not retain legacy tab persistence", () => {
    expect(admin).not.toContain("selected_admin_panel");
    expect(admin).not.toContain("selected_admin_system_subtab");
    expect(admin).not.toContain("selected_admin_plan_subtab");
  });
});
