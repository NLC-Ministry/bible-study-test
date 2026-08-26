import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const html = read("index.html");
const admin = read("js/modules/admin.js");
const db = read("js/db.js");
const edge = read("supabase/functions/nlc-data/index.ts");
const migration = read("supabase/migrations/0073_get_joined_plan_members.sql");

describe("plan management: 4-tab restructure", () => {
  it("puts a prominent feature menu above the shared plan + org filters", () => {
    const panelStart = html.indexOf('id="admin-plans-panel"');
    const panelEnd = html.indexOf("</main>", panelStart);
    const panel = html.slice(panelStart, panelEnd);

    expect(panel).toContain('id="admin-management-plan-select"');
    expect(panel).toContain('id="admin-plan-org-filter-slot"');
    expect(panel).toContain('id="admin-plan-subtabs"');

    const subtabs = ["join-status", "members", "teams", "statistics"];
    for (const subtab of subtabs) {
      expect(panel).toContain(`data-plan-subtab="${subtab}"`);
      expect(panel).toContain(`id="admin-plan-subtab-${subtab}"`);
    }

    expect(panel).toContain('id="admin-plan-feature-menu-title">功能列表</h2>');
    expect(panel).toContain('aria-label="計畫管理功能列表"');

    // The feature menu must appear before filters so it cannot be buried by them.
    const filterIndex = panel.indexOf('id="admin-plan-org-filter-slot"');
    const tabsIndex = panel.indexOf('id="admin-plan-subtabs"');
    expect(tabsIndex).toBeLessThan(filterIndex);
    for (const subtab of subtabs) {
      expect(panel.indexOf(`id="admin-plan-subtab-${subtab}"`)).toBeGreaterThan(tabsIndex);
    }
  });

  it("shows the feature menu as a non-scrolling two-column grid on mobile", () => {
    const css = read("index.css");
    expect(css).toContain(".admin-plan-feature-menu .admin-plan-subtabs");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(css).toContain("overflow: visible;");
    expect(css).toContain("border-top: 3px solid var(--color-brand);");
  });

  it("maps 加入計畫狀況 to 已加入計畫 (new) + 尚未加入計畫", () => {
    const panelStart = html.indexOf('id="admin-plan-subtab-join-status"');
    const panelEnd = html.indexOf('id="admin-plan-subtab-members"', panelStart);
    const panel = html.slice(panelStart, panelEnd);

    expect(panel).toContain('id="admin-joined-plan-section"');
    expect(panel).toContain('id="admin-joined-plan-count"');
    expect(panel).toContain('id="admin-joined-plan-members"');
    expect(panel).toContain("已加入計畫");
    // Collapsible like 尚未加入計畫 below (id="admin-unjoined-toggle-arrow"),
    // via the same shared .admin-unjoined-toggle-arrow class the click
    // handler in admin.js queries generically per-card.
    expect(panel).toContain('id="admin-joined-toggle-arrow" class="admin-unjoined-toggle-arrow"');
    // 尚未加入計畫 is not native HTML here — mountPlanManagementSections()
    // moves the existing #admin-unjoined-plan-section into this panel at
    // runtime, appending after the native 已加入計畫 card.
    expect(panel).not.toContain('id="admin-unjoined-plan-section"');
    expect(admin).toContain("if (joinStatusPanel && unjoinedSection) {");
    expect(admin).toContain("joinStatusPanel.appendChild(unjoinedSection)");
  });

  it("maps 組員總覽 to the existing 參與者總覽 slot", () => {
    const panelStart = html.indexOf('id="admin-plan-subtab-members"');
    const panelEnd = html.indexOf('id="admin-plan-subtab-teams"', panelStart);
    const panel = html.slice(panelStart, panelEnd);
    expect(panel).toContain(">參與者總覽<");
    expect(panel).toContain('id="admin-plan-participants-slot"');
  });

  it("maps 組隊狀況 to 尚未加入團隊 (renamed) + the 3人/6人 sections", () => {
    const panelStart = html.indexOf('id="admin-plan-subtab-teams"');
    const panelEnd = html.indexOf('id="admin-plan-subtab-statistics"', panelStart);
    const panel = html.slice(panelStart, panelEnd);
    expect(panel).toContain('id="admin-team-placements-card-wrap"');
    expect(panel).toContain("尚未加入團隊");
    expect(panel).not.toContain("成員組隊與團隊狀態查詢");
    expect(panel).toContain('id="admin-team-status-card-wrap"');
    expect(panel).toContain("3 人團隊報名狀況");
    expect(panel).toContain("6 人團隊報名狀況");
  });

  it("maps 計畫統計 to the existing 各種統計 slot", () => {
    const panelStart = html.indexOf('id="admin-plan-subtab-statistics"');
    const panelEnd = html.indexOf("</div>\n        </div>\n      </section>", panelStart);
    const panel = html.slice(panelStart, panelEnd > panelStart ? panelEnd : panelStart + 500);
    expect(panel).toContain(">各種統計<");
    expect(panel).toContain('id="admin-plan-statistics-slot"');
  });

  it("wires tab-switching to show exactly one panel and persist the selection", () => {
    expect(admin).toContain("function setAdminPlanSubtab(subtab, loadData = true)");
    expect(admin).toContain("function initAdminPlanSubtabs()");
    expect(admin).toContain("sessionStorage.setItem('selected_admin_plan_subtab', requested)");
    expect(admin).toContain("panel.classList.toggle('hidden', name !== requested)");
    expect(admin).toContain("void loadActiveAdminPlanSubtab(false)");
    expect(admin).toContain("initAdminPlanSubtabs();");
    expect(admin).toContain("const hideSharedOrgFilter = requested === 'quizzes'");
    expect(admin).toContain("sharedOrgFilter.classList.toggle('hidden', hideSharedOrgFilter)");
    expect(admin).toContain("sharedOrgFilter.style.display = hideSharedOrgFilter ? 'none' : 'flex'");
  });

  it("lazy-loads only the visible subtab and parallelizes the two first-screen member lists", () => {
    const start = admin.indexOf("async function loadActiveAdminPlanSubtab(forceRefresh = false)");
    const end = admin.indexOf("\nexport async function renderAdminPlanManagement()", start);
    const loader = admin.slice(start, end);

    expect(loader).toContain("activeAdminPlanSubtab === 'join-status'");
    expect(loader).toContain("Promise.allSettled([");
    expect(loader).toContain("renderAdminJoinedPlanMembers(forceRefresh)");
    expect(loader).toContain("renderAdminUnjoinedPlanMembers(forceRefresh)");
    expect(loader).toContain("activeAdminPlanSubtab === 'members' || activeAdminPlanSubtab === 'statistics'");
    expect(loader).toContain("activeAdminPlanSubtab === 'teams'");

    const selectStart = admin.indexOf("async function selectManagementPlan(planKey, forceRefresh = false)");
    const selectEnd = admin.indexOf("\nasync function loadActiveAdminPlanSubtab", selectStart);
    const selectFn = admin.slice(selectStart, selectEnd);
    expect(selectFn).toContain("await loadActiveAdminPlanSubtab(forceRefresh)");
    expect(selectFn).not.toContain("renderAdminTeamPlacementLookup(plan)");
    expect(selectFn).not.toContain("renderPlanMembersView()");
  });

  it("moves the shared org filter controls above the tabs, not into one tab's panel", () => {
    const mountFn = admin.slice(
      admin.indexOf("function mountPlanManagementSections()"),
      admin.indexOf("const ADMIN_PLAN_SUBTABS")
    );
    expect(mountFn).toContain("const orgFilterSlot = document.getElementById('admin-plan-org-filter-slot')");
    expect(mountFn).toContain("const orgControls = document.getElementById('members-organization-controls')");
    expect(mountFn).toContain("orgFilterSlot.appendChild(orgControls)");
    // Regression guard for the old behavior this replaced: the whole
    // #plan-org-stats-header (filters + unjoined card bundled together)
    // must no longer be moved as one unit.
    expect(mountFn).not.toContain("plan-org-stats-header");
  });

  it("populates the shared org filter selects on every subtab load, not only when 組員總覽/計畫統計 happens to run renderPlanMembersView()", () => {
    // Regression: members-organization-controls (大區/牧區/小組 selects) is
    // shared across all four subtabs, but only got populated as a side
    // effect of renderPlanMembersView(), which only runs for the
    // 'members'/'statistics' subtabs. Since the default subtab on a fresh
    // session is 'join-status', the selects stayed empty (no <option>s at
    // all — not just unselected) until the admin manually switched tabs.
    const start = admin.indexOf("async function loadActiveAdminPlanSubtab(forceRefresh = false)");
    const end = admin.indexOf("\nexport async function renderAdminPlanManagement()", start);
    const loader = admin.slice(start, end);
    const populateCallIndex = loader.indexOf("window.populateMembersSelector()");
    const joinStatusIndex = loader.indexOf("activeAdminPlanSubtab === 'join-status'");
    expect(populateCallIndex).toBeGreaterThan(-1);
    expect(joinStatusIndex).toBeGreaterThan(-1);
    // Must run before the per-subtab dispatch, not nested inside only one branch.
    expect(populateCallIndex).toBeLessThan(joinStatusIndex);
    expect(loader).toContain("typeof window.populateMembersSelector === 'function'");

    const plan = read("js/modules/plan.js");
    expect(plan).toContain("window.populateMembersSelector = populateMembersSelector;");
  });

  it("refreshes only the currently visible org-filtered panel", () => {
    const fnStart = admin.indexOf("async function refreshAdminTeamRegistrationFilters()");
    const fnEnd = admin.indexOf("}", fnStart);
    const fn = admin.slice(fnStart, fnEnd);
    expect(fn).toContain("loadActiveAdminPlanSubtab(false)");
    expect(fn).not.toContain("renderAdminTeamRegistrationStatus");
  });
});

describe("plan management: 已加入計畫 (get_joined_plan_members)", () => {
  it("defines get_joined_plan_members mirroring get_unjoined_plan_members with an inverted join and full management-role + values_overlap scoping", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.get_joined_plan_members(");
    expect(migration).toContain("JOIN public.reading_plans AS joined_plan");
    expect(migration).toContain("actor_role := public.role_code(actor_profile.role_id);");
    expect(migration).toContain("IN ('admin', 'senior_pastor', 'great_zone_leader', 'zone_leader', 'group_leader')");
    expect(migration).toContain("public.values_overlap(candidate.great_region,");
    expect(migration).toContain("public.values_overlap(candidate.pastoral_zone,");
    expect(migration).toContain("public.values_overlap(candidate.small_group,");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.get_joined_plan_members(UUID, TEXT, UUID) TO authenticated, service_role;");
  });

  it("registers get_joined_plan_members in nlc-data's RPC and management-scope allowlists", () => {
    const teamRpcBlock = edge.slice(
      edge.indexOf("const TEAM_RPC_FUNCTIONS = new Set(["),
      edge.indexOf("]);", edge.indexOf("const TEAM_RPC_FUNCTIONS = new Set(["))
    );
    const planManagementBlock = edge.slice(
      edge.indexOf("const PLAN_MANAGEMENT_RPC_FUNCTIONS = new Set(["),
      edge.indexOf("]);", edge.indexOf("const PLAN_MANAGEMENT_RPC_FUNCTIONS = new Set(["))
    );
    expect(teamRpcBlock).toContain('"get_joined_plan_members"');
    expect(planManagementBlock).toContain('"get_joined_plan_members"');
  });

  it("provides db.js getJoinedPlanMembers with a scoped client-side fallback", () => {
    expect(db).toContain("async getJoinedPlanMembers(plan)");
    expect(db).toContain('this._callReadingTeamRpc("get_joined_plan_members"');
    expect(db).toContain("async _getJoinedPlanMembersFallback(plan, planId = null)");
    // The fallback must keep candidates who HAVE joined (inverted from the
    // unjoined fallback, which filters out anyone in joinedByUserId).
    expect(db).toContain(".filter(candidate => joinedByUserId.has(String(candidate.id)))");
  });

  it("renders the joined-members list without an invite action (they already joined)", () => {
    expect(admin).toContain("async function renderAdminJoinedPlanMembers(forceRefresh = false)");
    expect(admin).toContain('document.getElementById("admin-joined-plan-members")');
    expect(admin).toContain('document.getElementById("admin-joined-plan-count")');
    expect(admin).not.toContain('admin-joined-plan-invite');
    expect(admin).toContain("window.renderAdminJoinedPlanMembers = renderAdminJoinedPlanMembers;");
  });
});
