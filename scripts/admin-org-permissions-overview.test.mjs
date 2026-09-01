import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const html = read("index.html");
const admin = read("js/modules/admin.js");
const css = read("css/admin-registration-statistics.css");

describe("admin org structure permissions overview (管理 → 權限管理)", () => {
  it("mounts a collapsible section in the unified permissions destination, above the existing 管理範圍設定 editor it links into", () => {
    const panelStart = html.indexOf('id="admin-section-permissions"');
    const overviewIndex = html.indexOf('id="admin-org-permissions-col"', panelStart);
    const editorIndex = html.indexOf('id="admin-managed-scopes-col"', panelStart);
    expect(overviewIndex).toBeGreaterThan(-1);
    expect(editorIndex).toBeGreaterThan(overviewIndex);
    expect(html).toContain('id="admin-org-permissions-tree"');
    expect(html).toContain('id="admin-org-permissions-count"');
  });

  it("builds a reverse index of leaders per region/zone/group from the same profiles used by the person-centric editor", () => {
    expect(admin).toContain("export async function renderAdminOrgPermissionsOverview()");
    expect(admin).toContain("await db.fetchManagedScopeProfiles()");
    // admin/pastor are whole-church, never bucketed under a single region/zone/group.
    expect(admin).toMatch(/wholeChurchLeadersByRole\.has\(role\)[\s\S]{0,80}wholeChurchLeadersByRole\.get\(role\)\.push/);
    expect(admin).toContain('role === "great_zone_leader" ? regionLeaders');
    expect(admin).toContain('role === "zone_leader" ? zoneLeaders');
    expect(admin).toContain('role === "group_leader" ? groupLeaders');
    // Reuses the exact same scope-resolution helpers as the editor (role→field
    // mapping, and the managed_* → own-org-fallback logic), instead of a second,
    // possibly-divergent copy of that logic.
    expect(admin).toContain("getManagedScopeConfig(profile)");
    expect(admin).toContain("getProfileDefaultManagedScopes(profile, config)");
  });

  it("shows 系統管理員/牧者 as two separate whole-church rows — senior_pastor was retired as a distinct role, not just relabeled in the UI", () => {
    expect(admin).toContain('const WHOLE_CHURCH_ROLE_ORDER = ["admin", "pastor"];');
    expect(admin).toContain('const WHOLE_CHURCH_ROLE_LABELS = { admin: "系統管理員", pastor: "牧者" };');
    expect(admin).toContain("WHOLE_CHURCH_ROLE_ORDER.map(role =>");
    expect(admin).toContain("（全教會範圍）");
    expect(admin).not.toContain("系統管理員／教會牧者（全教會範圍）");
    expect(admin).not.toContain("senior_pastor");
  });

  it("renders the org tree from state.orgStructure (regions -> zones -> groups), not a separate query", () => {
    expect(admin).toContain("state.orgStructure.regions");
    expect(admin).toContain("state.orgStructure.zones");
    expect(admin).toContain("state.orgStructure.groups");
    expect(admin).toContain("await db.loadOrgStructure();");
  });

  it("shows an unassigned badge per unit and a church-wide unassigned count", () => {
    expect(admin).toContain("尚未指派");
    expect(admin).toContain("unassignedCount");
    expect(css).toContain(".admin-org-permissions__unassigned");
  });

  it("clicking a leader chip jumps into the existing 管理範圍設定 editor and pre-selects that person", () => {
    expect(admin).toContain("function jumpToManagedScopeEditor(profileId)");
    expect(admin).toContain('select.value = String(profileId)');
    expect(admin).toContain("renderManagedScopeProfile(profile)");
    expect(admin).toContain('column.scrollIntoView({ behavior: "smooth", block: "start" })');
    expect(admin).toContain('data-jump-profile-id');
    expect(admin).toContain('jumpToManagedScopeEditor(chip.dataset.jumpProfileId)');
  });

  it("refreshes the overview after a managed-scope save so the tree reflects the new assignment immediately", () => {
    const saveHandlerStart = admin.indexOf("save.onclick = async () => {");
    const saveHandlerEnd = admin.indexOf("renderManagedScopeProfile(managedScopeProfiles[0] || null);", saveHandlerStart);
    const saveHandler = admin.slice(saveHandlerStart, saveHandlerEnd);
    expect(saveHandler).toContain("renderAdminOrgPermissionsOverview()");
  });

  it("is wired into the admin module's init() alongside the other admin renderers", () => {
    const initStart = admin.indexOf("export function init()");
    const initEnd = admin.indexOf("\n}", initStart);
    const initBody = admin.slice(initStart, initEnd);
    expect(initBody).toContain("renderAdminOrgPermissionsOverview()");
  });

  it("hides the section from non-admin roles, matching the other admin-only panels", () => {
    const fnStart = admin.indexOf("export async function renderAdminOrgPermissionsOverview()");
    const fnEnd = admin.indexOf("\nlet adminRegistrationStatistics", fnStart);
    const fnBody = admin.slice(fnStart, fnEnd);
    expect(fnBody).toContain('getUserRoleCode(state.currentUser) === "admin"');
    expect(fnBody).toContain('column.classList.toggle("hidden", !isAdmin)');
    expect(fnBody).toMatch(/if \(!isAdmin\) return;/);
  });
});
