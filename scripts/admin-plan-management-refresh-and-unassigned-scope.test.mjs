import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const html = read("index.html");
const admin = read("js/modules/admin.js");
const plan = read("js/modules/plan.js");

describe("計劃管理: explicit refresh button", () => {
  it("adds a 更新 button next to the shared org filter in the unified plan context", () => {
    const panelStart = html.indexOf('id="admin-plan-context"');
    const filterCardStart = html.indexOf('id="admin-plan-filter-title"', panelStart);
    const firstPanelStart = html.indexOf('id="admin-section-join-status"', filterCardStart);
    const filterArea = html.slice(filterCardStart, firstPanelStart);
    expect(filterArea).toContain('id="admin-plan-refresh-btn"');
    expect(filterArea).toContain(">更新<");
  });

  it("wires the button to force a genuine reload of the currently selected plan's data", () => {
    expect(admin).toContain("getElementById('admin-plan-refresh-btn')");
    const btnStart = admin.indexOf("const refreshBtn = document.getElementById('admin-plan-refresh-btn');");
    const btnEnd = admin.indexOf("if (typeof hydrateIcons === 'function') hydrateIcons(document.getElementById('admin-view'));", btnStart);
    const btnBlock = admin.slice(btnStart, btnEnd);
    // Regression for: clicking 更新 looked like it did nothing unless the org
    // filter was also toggled. window._cachedAllUsersList is keyed by plan
    // only, so selectManagementPlan() silently reused the stale list — the
    // button must clear that cache and force a real refetch, not just re-run
    // the same render against whatever's cached.
    expect(btnBlock).toContain("window._cachedAllUsersList = null;");
    expect(btnBlock).toContain("window._cachedAllUsersListKey = null;");
    expect(btnBlock).toContain("await selectManagementPlan(currentSelect.value, true);");
    expect(btnBlock).toContain("renderAdminOrgPermissionsOverview()");
  });

  it("selectManagementPlan threads forceRefresh into the visible-subtab loader", () => {
    const start = admin.indexOf("async function selectManagementPlan(planKey, forceRefresh = false) {");
    expect(start).toBeGreaterThan(-1);
    const end = admin.indexOf("\n}", start) + 2;
    const fnBlock = admin.slice(start, end);
    expect(fnBlock).toContain("await loadActiveAdminPlanSubtab(forceRefresh)");

    const loaderStart = admin.indexOf("async function loadActiveAdminPlanSubtab(forceRefresh = false)");
    const loaderEnd = admin.indexOf("\nexport async function renderAdminPlanManagement()", loaderStart);
    const loaderBlock = admin.slice(loaderStart, loaderEnd);
    expect(loaderBlock).toContain("renderAdminTeamRegistrationStatus(forceRefresh, 3, 'admin-team-status-content')");
    expect(loaderBlock).toContain("renderAdminTeamRegistrationStatus(false, 6, 'admin-team-status-content-6')");
    expect(loaderBlock).toContain("renderAdminJoinedPlanMembers(forceRefresh)");
  });
});

describe("計劃管理: leaders with no org placement get a clear message instead of a silent blank filter", () => {
  // Regression for: a group_leader whose managed_groups AND small_group were
  // both blank saw a disabled dropdown with an unlabeled "小組：" option and
  // no way to load their data — nothing to click, no explanation why.
  it("shows an explicit ⚠️ 尚未設定...歸屬 sentinel for great_zone_leader / zone_leader / group_leader with zero assigned units", () => {
    expect(plan).toContain('new Option("⚠️ 尚未設定大區歸屬，請聯絡系統管理員", "unassigned")');
    expect(plan).toContain('new Option("⚠️ 尚未設定牧區歸屬，請聯絡系統管理員", "unassigned")');
    expect(plan).toContain('new Option("⚠️ 尚未設定小組歸屬，請聯絡系統管理員", "unassigned")');
  });

  it("still handles the normal single-assignment case (no regression from adding the unassigned branch)", () => {
    expect(plan).toContain("zoneSelect.options.add(new Option(`牧區：${myZones[0]}`, myZones[0]));");
    expect(plan).toContain("groupSelect.options.add(new Option(`小組：${myGroups[0]}`, myGroups[0]));");
  });

  it("treats the unassigned sentinel as no-selection in every place a filter value is read, not as a literal group/zone/region name", () => {
    const sites = [
      "const selectedGroup = groupSelect.value === \"unassigned\" ? \"\" : groupSelect.value;",
      "const selectedZone = zoneSelect.value === \"unassigned\" ? \"\" : zoneSelect.value;",
      "const selectedRegion = regionSelect.value === \"unassigned\" ? \"\" : regionSelect.value;"
    ];
    for (const site of sites) {
      expect(plan.match(new RegExp(site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBeGreaterThanOrEqual(2);
    }
    expect(admin).toContain('value === "unassigned" ? "" : value;');
  });
});

describe("計劃管理: a leadership assignment counts as org data even when the leader's own placement is blank", () => {
  // A leader's ROLE (e.g. group_leader) and their personal org PLACEMENT
  // (great_region/pastoral_zone/small_group) sync from two different Member
  // Hub fields (leadershipIdentity.assignments vs. organization). Someone can
  // legitimately have a leadership assignment for a unit without their own
  // placement being filled in — so "尚未設定歸屬" must only fire after also
  // checking member_context_leadership_assignments, not just managed_* / own org fields.
  it("falls back to member_context_leadership_assignments before declaring a leader unassigned, at every scope-resolution site", () => {
    expect(plan.match(/getLeadershipAssignmentNodeNames\(state\.currentUser, "大區"\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(plan.match(/getLeadershipAssignmentNodeNames\(state\.currentUser, "牧區"\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(plan.match(/getLeadershipAssignmentNodeNames\(state\.currentUser, "小組"\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("resolves the correct node name from a real leadership-assignment shape (extracted, directly executed)", () => {
    const start = plan.indexOf("function getLeadershipAssignmentNodeNames(user, levelName) {");
    const end = plan.indexOf("\n}", start) + 2;
    const fnSrc = plan.slice(start, end);
    // eslint-disable-next-line no-new-func
    const getLeadershipAssignmentNodeNames = new Function(`${fnSrc}\nreturn getLeadershipAssignmentNodeNames;`)();

    const user = {
      managed_groups: "",
      small_group: "",
      member_context_leadership_assignments: [
        { levelName: "牧區", nodeName: "青年牧區", isPrimary: false },
        { levelName: "小組", nodeName: "大安小組", isPrimary: true },
        { levelName: "小組", nodeName: "副組指派小組", isPrimary: false }
      ]
    };

    // Prefers the primary assignment when there are multiple at the same level.
    expect(getLeadershipAssignmentNodeNames(user, "小組")).toBe("大安小組");
    expect(getLeadershipAssignmentNodeNames(user, "牧區")).toBe("青年牧區");
    // No matching-level assignment at all -> genuinely unassigned.
    expect(getLeadershipAssignmentNodeNames(user, "大區")).toBe("");
    expect(getLeadershipAssignmentNodeNames({}, "小組")).toBe("");
    expect(getLeadershipAssignmentNodeNames(null, "小組")).toBe("");
  });
});
