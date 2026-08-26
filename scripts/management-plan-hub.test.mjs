import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const admin = readFileSync("js/modules/admin.js", "utf8");
const utils = readFileSync("js/utils.js", "utf8");
const app = readFileSync("js/app.js", "utf8");
const plan = readFileSync("js/modules/plan.js", "utf8");
const profile = readFileSync("js/modules/profile.js", "utf8");
const edge = readFileSync("supabase/functions/nlc-data/index.ts", "utf8");
const css = readFileSync("index.css", "utf8");

describe("management plan hub", () => {
  it("puts the requested plan management sections in discovery order", () => {
    const planPanel = html.slice(html.indexOf('id="admin-plans-panel"'), html.indexOf('    </main>', html.indexOf('id="admin-plans-panel"')));
    const labels = ["\u8a08\u756b\u7be9\u9078", "\u53c3\u8207\u8005\u7e3d\u89bd", "3 \u4eba\u5718\u968a\u5831\u540d\u72c0\u6cc1", "6 \u4eba\u5718\u968a\u5831\u540d\u72c0\u6cc1", "\u5404\u7a2e\u7d71\u8a08"];
    const positions = labels.map(label => planPanel.indexOf(label));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("places a clearly labelled feature list before plan and organization filters", () => {
    const planPanel = html.slice(html.indexOf('id="admin-plans-panel"'), html.indexOf('    </main>', html.indexOf('id="admin-plans-panel"')));
    const featureMenuIndex = planPanel.indexOf('id="admin-plan-feature-menu-title"');
    const planFilterIndex = planPanel.indexOf('id="admin-plan-filter-title"');
    const orgFilterIndex = planPanel.indexOf('id="admin-plan-filter-disclosure"');
    expect(featureMenuIndex).toBeGreaterThan(-1);
    expect(featureMenuIndex).toBeLessThan(planFilterIndex);
    expect(featureMenuIndex).toBeLessThan(orgFilterIndex);
  });

  it("gives system administrators system and plan tabs", () => {
    expect(html).toContain('data-admin-panel="system">\u7cfb\u7d71\u7ba1\u7406</button>');
    expect(html).toContain('data-admin-panel="plans">\u8a08\u756b\u7ba1\u7406</button>');
    expect(html).not.toContain('id="admin-users-accordion-root"');
    expect(html).toContain('id="admin-reports-root"');
    expect(admin).toContain("panelName === 'system' && isAdmin");
  });

  it("keeps plan management available for management roles down to group_leader", () => {
    const adminRoles = admin.match(/const MANAGEMENT_ROLES = \[(.*?)\];/)?.[1] || "";
    const utilsRoles = utils.match(/const managementRoles = \[(.*?)\];/)?.[1] || "";
    const profileRoles = profile.match(/const managementRoles = \[(.*?)\];/)?.[1] || "";
    for (const roles of [adminRoles, utilsRoles, profileRoles]) {
      expect(roles).toContain("admin");
      expect(roles).toContain("pastor");
      expect(roles).toContain("great_zone_leader");
      expect(roles).toContain("zone_leader");
      expect(roles).toContain("group_leader");
    }
    expect(edge).toContain('return ["admin", "pastor", "great_zone_leader", "zone_leader", "group_leader"].includes(getProfileRoleCode(profile));');
  });

  it("defaults to the ongoing plan and also lists released plans open for early enrollment", () => {
    // Superseded the earlier "always default to stage one" design (see
    // scripts/admin-ongoing-plan-selection.test.mjs) once the campaign moved
    // past stage one — defaulting to the plan actually running now is more
    // useful for admins than always landing on a stage that may have ended.
    expect(admin).toContain("const ongoingPlan = plans.find(plan => plan.managementStatus === 'ongoing')");
    expect(admin).not.toContain("const stageOnePlan =");
    expect(admin).not.toContain("const isStageOneBootstrap =");
    expect(admin).toContain("!managementPlanSelectionInitialized");
    expect(admin).toContain("const isOpenEarlyEnrollment = status === 'upcoming' && !hidden");
    expect(admin).toContain("status === 'ongoing' || status === 'completed' || isOpenEarlyEnrollment");
    expect(admin).toContain("plan.managementStatus === 'upcoming' ? '（提前報名）' : ''");
    expect(admin).toContain("const statusPriority = { ongoing: 0, upcoming: 1, completed: 2 }");
    expect(admin).toContain("sourcePlan.planKind === 'church_campaign'");
  });

  it("keeps the plan filter in the document flow", () => {
    const filterRule = css.slice(css.indexOf(".admin-plan-filter-card {"), css.indexOf("}", css.indexOf(".admin-plan-filter-card {")));
    expect(filterRule).not.toContain("position: sticky");
    expect(filterRule).not.toContain("top:");
  });

  it("renders both team divisions and reuses the existing participant and statistics views", () => {
    expect(admin).toContain("renderAdminTeamRegistrationStatus(forceRefresh, 3, 'admin-team-status-content')");
    expect(admin).toContain("renderAdminTeamRegistrationStatus(false, 6, 'admin-team-status-content-6')");
    expect(admin).toContain("participantSlot.appendChild(memberList)");
    expect(admin).toContain("statisticsSlot.appendChild(statsSection)");
    expect(app).toContain("renderAdminPlanManagement");
  });

  it("applies organization filters to participants, statistics, and complete teams", () => {
    expect(plan).toContain("state.currentUser.managed_regions || state.currentUser.great_region");
    expect(plan).toContain("state.currentUser.managed_zones || state.currentUser.pastoral_zone");
    expect(plan).toContain("state.currentUser.managed_groups || state.currentUser.small_group");
    expect(plan).toContain('return "all_zones"');
    expect(plan).toContain('return "all_groups"');
    // Regression: window.refreshAdminTeamRegistrationFilters() (re-renders
    // the 3人/6人 team panels) used to be wired only to #members-zone-selector,
    // a legacy `class="hidden" style="display:none"` element (index.html)
    // the user can never actually interact with. The three real, visible
    // dropdowns (#members-admin-region/zone/group-select) only called
    // renderPlanMembersView() — so changing the filter updated the
    // participant list but silently left the 3人/6人 team panels showing
    // stale data. Both listeners must call it.
    const directListenerBlock = plan.slice(
      plan.indexOf("[regionSelect, zoneSelect, groupSelect].forEach(el => {"),
      plan.indexOf("const membersZoneSelector")
    );
    expect(directListenerBlock).toContain("await renderPlanMembersView();");
    expect(directListenerBlock).toContain("window.refreshAdminTeamRegistrationFilters");
    expect(plan).toContain("window.refreshAdminTeamRegistrationFilters");
    expect(admin).toContain("teamMatchesManagementOrgFilter");
    expect(admin).toContain("members.some(member =>");
    expect(admin).toContain(".filter(team => teamMatchesManagementOrgFilter(team, activeOrgFilter))");
  });
});
