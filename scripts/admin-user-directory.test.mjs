import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = relativePath => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("read-only admin user directory", () => {
  it("renders a user management section with only non-destructive static controls", () => {
    const html = read("index.html");
    const start = html.indexOf('id="admin-user-directory-col"');
    const end = html.indexOf('id="admin-managed-scopes-col"');
    const section = html.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(section).toContain('<section class="glass-card admin-user-directory"');
    expect(section).toContain('aria-label="使用者基本資料"');
    expect(section).not.toContain("使用者管理");
    expect(section).not.toContain('<h3 class="card-title" id="admin-user-directory-title">使用者基本資料</h3>');
    expect(section).not.toContain("本區不會修改帳號");
    expect(section).toContain('class="admin-user-directory__toolbar"');
    expect(section).toContain('id="admin-user-directory-search"');
    expect(section).toContain('id="admin-user-directory-filter-region"');
    expect(section).toContain('id="admin-user-directory-filter-zone"');
    expect(section).toContain('id="admin-user-directory-filter-group"');
    expect(section).toContain("組織架構篩選");
    expect(section).toContain('id="admin-user-directory-filter-region-options"');
    expect(section).toContain('id="admin-user-directory-filter-zone-options"');
    expect(section).toContain('id="admin-user-directory-filter-group-options"');
    expect(section).toContain('id="admin-user-directory-filter-incomplete"');
    expect(section).toContain("未填會員資料（沒有牧區或沒有名稱）");
    expect(section).toContain('id="admin-user-directory-filter-stage-one"');
    expect(section).toContain("未加入第一階段計畫");
    expect(section).not.toContain('id="admin-user-directory-filter-name-review"');
    // The only static button here is the CSV export (a read, not a write) —
    // this directory has no write action at all.
    const staticButtons = [...section.matchAll(/<button[^>]*id="([^"]+)"/g)].map(match => match[1]);
    expect(staticButtons).toEqual(["admin-user-directory-export-btn"]);
  });

  it("wires cascading organization filters into the same filtered directory and CSV result", () => {
    const admin = read("js/modules/admin.js");
    const directory = admin.slice(
      admin.indexOf("function getAdminUserDirectoryOrgFilters"),
      admin.indexOf("let managedScopeProfiles")
    );

    expect(directory).toContain("buildAdminUserDirectoryOrgOptions");
    expect(directory).toContain("matchesAdminUserDirectoryOrgFilters(profile, orgFilters)");
    expect(directory).toContain("refreshAdminUserDirectoryOrgFilterOptions()");
    expect(directory).toContain("bindAdminUserDirectoryOrgFilterActions");
    expect(directory).toContain('input[data-org-filter-key]');
    expect(directory).toContain("new Set(adminUserDirectoryOrgFilterState[stateKey])");
    expect(directory).toContain("dataset.orgFilterClear");
    expect(directory).toContain("adminUserDirectoryFilteredProfiles = filteredProfiles");
    expect(admin).toContain("const target = Array.isArray(profiles) ? profiles : adminUserDirectoryProfiles");
  });

  it("loads every real profile through an admin-only read query", () => {
    const db = read("js/db.js");
    const start = db.indexOf("async fetchAdminUserProfiles()");
    const end = db.indexOf("async fetchManagedScopeProfiles()");
    const method = db.slice(start, end);

    expect(method).toContain('getUserRoleCode(state.currentUser) !== "admin"');
    expect(method).toContain('.from("profiles")');
    expect(method).toContain('member_context_synced_at');
    expect(method).toContain('.eq("is_demo", false)');
    expect(method).not.toContain('.eq("is_active", true)');
    expect(method).not.toContain(".update(");
    expect(method).not.toContain(".delete(");
    expect(method).not.toContain(".upsert(");
    expect(method).toContain('const firstStageGlobalPlanId = "00000000-0000-0000-c026-000000000001"');
    expect(method).toContain('.from("reading_plans")');
    expect(method).toContain('const firstStagePresetKey = "church_stage_01"');
    expect(method).toContain('.or(`global_plan_id.eq.${firstStageGlobalPlanId},preset_key.eq.${firstStagePresetKey}`)');
    expect(method).toContain("joined_stage_one:");
  });

  it("computes is_joined_team / team_name from reading_team_members — regression for the always-false 未加入團隊 filter", () => {
    // Previously fetchAdminUserProfiles() never queried team membership at
    // all, so profile.is_joined_team was always undefined. The 未加入團隊
    // checkbox checks `profile.is_joined_team === true`, which was therefore
    // always false and never excluded anyone — the filter silently did
    // nothing, and every user's card showed "未加入團隊" regardless of
    // their real team status.
    const db = read("js/db.js");
    const start = db.indexOf("async fetchAdminUserProfiles()");
    const end = db.indexOf("async fetchManagedScopeProfiles()");
    const method = db.slice(start, end);

    expect(method).toContain('.from("reading_team_members")');
    expect(method).toContain('.select("user_id, team_id, member_role")');
    expect(method).toContain('.from("reading_teams")');
    expect(method).toContain("is_joined_team: teamMembershipByUser.has(String(profile.id))");
    expect(method).toContain("team_name:");
    expect(method).toContain("member_role:");
    // Still read-only, same guarantee as the rest of this method.
    expect(method).not.toContain(".update(");
    expect(method).not.toContain(".delete(");
    expect(method).not.toContain(".upsert(");
  });

  it("escapes profile data and stays entirely read-only, no write action anywhere", () => {
    const admin = read("js/modules/admin.js");
    const start = admin.indexOf("function renderAdminUserDirectoryList");
    const end = admin.indexOf("let managedScopeProfiles");
    const directory = admin.slice(start, end);

    expect(directory).toContain("db.fetchAdminUserProfiles()");
    expect(directory).toContain("escapeHTML(name)");
    expect(directory).toContain("escapeHTML(email)");
    expect(directory).toContain("escapeHTML(roleLabel)");
    expect(directory).toContain('<details class="admin-user-directory__card">');
    expect(directory).toContain('class="admin-user-directory__card-summary"');
    expect(directory).toContain("escapeHTML(pastoralZone)");
    expect(directory).toContain("missingRequiredProfile");
    // The incomplete-profile filter now only judges emptiness — no
    // placeholder-name detection list on the frontend anymore.
    expect(directory).not.toContain("INVENTED_DISPLAY_NAMES");
    expect(directory).not.toContain("placeholderNames");
    expect(directory).toContain("notJoinedStageOneOnly");
    expect(directory).toContain("statusClass");
    expect(directory).toContain("第一階段計畫");
    // No write action anywhere in this directory (the old name-review
    // approve/edit action was removed entirely, not just hidden).
    expect(directory).not.toContain("db.update");
    expect(directory).not.toContain("db.approveProfileName");
    expect(directory).not.toContain("db.adminOverwriteProfileName");
    // HTML inline-attribute handlers, not JS property assignment (the outer
    // renderAdminUserDirectory() legitimately sets exportBtn.onclick = ...).
    expect(directory).not.toContain('onclick="');
    expect(directory).not.toContain("needsNameReview");
  });
});
