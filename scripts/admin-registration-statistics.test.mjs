import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/0052_admin_registration_statistics.sql", "utf8");
const summaryMigration = readFileSync("supabase/migrations/0055_admin_registration_summary.sql", "utf8");
const teamCountsMigration = readFileSync("supabase/migrations/0080_admin_registration_team_counts.sql", "utf8");
const orgSortOrderMigration = readFileSync("supabase/migrations/0133_org_display_sort_order.sql", "utf8");
const edge = readFileSync("supabase/functions/nlc-data/index.ts", "utf8");
const db = readFileSync("js/db.js", "utf8");
const admin = readFileSync("js/modules/admin.js", "utf8");
const html = readFileSync("index.html", "utf8");
const css = readFileSync("css/admin-registration-statistics.css", "utf8");

describe("admin registration statistics", () => {
  it("aggregates active real accounts and selected-plan signups by great region and pastoral zone", () => {
    expect(migration).toContain("get_admin_registration_statistics");
    expect(migration).toContain("profile.is_active = TRUE");
    expect(migration).toContain("profile.is_demo = FALSE");
    expect(migration).toContain("reading_plan.global_plan_id = p_global_plan_id");
    expect(migration).toContain("BTRIM(profile.great_region)");
    expect(migration).toContain("BTRIM(profile.pastoral_zone)");
    expect(migration).toContain("'greatRegions'");
    expect(migration).toContain("'未設定牧區'");
    expect(migration).toContain("'pastoralZones'");
  });

  it("keeps the report admin-only across direct and Member Hub auth paths", () => {
    expect(migration).toContain("actor_role IS DISTINCT FROM 'admin'");
    expect(migration).toContain("registration_statistics_admin_required");
    expect(edge).toContain('"get_admin_registration_statistics"');
    expect(edge).toContain("ADMIN_RPC_FUNCTIONS.has(functionName) && !isAdmin(profile)");
    expect(edge).toContain("ADMIN_RPC_FUNCTIONS.has(functionName)");
  });

  it("renders both summaries in system permission management", () => {
    expect(html).toContain('id="admin-registration-statistics-col"');
    expect(html).toContain("權限管理");
    expect(html).toContain("報名與註冊統計");
    expect(admin).toContain('renderAdminRegistrationStatisticsTable("大區統計", "大區"');
    expect(admin).toContain('renderAdminRegistrationStatisticsTable("牧區統計", "牧區"');
    expect(db).toContain('getAdminRegistrationStatistics(globalPlanId)');
    expect(css).toContain(".admin-registration-statistics__tables");
  });

  it("adds the pastoral-zone completeness and plan participation summary", () => {
    expect(summaryMigration).toContain("'withoutPastoralZoneNotJoined'");
    expect(summaryMigration).toContain("'withoutPastoralZoneJoined'");
    expect(summaryMigration).toContain("'withPastoralZoneNotJoined'");
    expect(summaryMigration).toContain("'withPastoralZoneJoined'");
    expect(summaryMigration).toContain("'totalJoined'");
    expect(summaryMigration).toContain("'totalRegistered'");
    expect(summaryMigration).toContain("NULLIF(BTRIM(profile.pastoral_zone), '') IS NOT NULL");
    expect(admin).toContain("無牧區資料未加入計畫");
    expect(admin).toContain("總參加人數");
    expect(css).toContain(".admin-registration-statistics__summary-grid");
  });

  it("always offers the first stage even before global plans finish loading", () => {
    expect(admin).toContain("buildAdminRegistrationStatisticsPlans(");
    expect(admin).not.toContain('typeof isUuid !== "function"');
  });

  it("exports UTF-8 CSV instead of a plain-text slash-delimited file", () => {
    expect(admin).toContain("export function convertAdminRegistrationStatisticsToCSV(context, exportedAt = new Date())");
    expect(admin).toContain('new Blob(["\\uFEFF" + csvContent]');
    expect(admin).toContain('type: "text/csv;charset=utf-8;"');
    expect(admin).toContain("prependTaiwanExportTime");
    expect(admin).toContain("const todayTW = formatTaiwanDate()");
    expect(admin).toContain("報名與註冊統計-${planName}-${todayTW}.csv");
    expect(html).toContain("匯出 CSV");
    expect(html).not.toContain("匯出文字檔");
  });

  it("orders great regions and pastoral zones by sort_order read live from state.orgStructure, not a hardcoded array", () => {
    // The roster order used to be two hardcoded arrays duplicated in this
    // file — now the database (great_regions/pastoral_zones.sort_order,
    // migration 0133) is the single source of truth, loaded once by
    // db.js's loadOrgStructure() into state.orgStructure.regionSortOrder /
    // zoneSortOrder. Updating the roster order only ever means updating
    // that column, never chasing a second array that could drift out of
    // sync with it.
    expect(admin).not.toContain("CHURCH_GREAT_REGION_ORDER");
    expect(admin).not.toContain("CHURCH_PASTORAL_ZONE_ORDER");
    expect(admin).toContain("function compareByOrgOrder(sortOrderMap, aLabel, bLabel)");
    expect(admin).toContain("window.compareByOrgDisplayOrder(sortOrderMap || {})(a, b)");
    expect(admin).toContain('typeof state !== "undefined" ? state.orgStructure : null');
    expect(admin).toContain("orgStructure && orgStructure.regionSortOrder");
    expect(admin).toContain("orgStructure && orgStructure.zoneSortOrder");
    expect(admin).toContain("sortByChurchOrgOrder(greatRegions, compareGreatRegions, row => row.label)");
    expect(db).toContain("function compareByOrgDisplayOrder(sortOrderMap)");
    // Rows outside the known roster must still be exported, not silently
    // dropped — sorted after via Infinity.
    expect(db).toContain("? sortOrderMap[a] : Infinity");
  });

  it("db.js populates state.orgStructure's region/zone sort order from great_regions/pastoral_zones.sort_order", () => {
    expect(db).toContain('state.supabase.from("great_regions").select("name, sort_order")');
    expect(db).toContain('state.supabase.from("pastoral_zones").select("name, sort_order")');
    expect(db).toContain("nextOrgStructure.regionSortOrder = regionSortOrder;");
    expect(db).toContain("nextOrgStructure.zoneSortOrder = zoneSortOrder;");
    expect(db).toContain("nextOrgStructure.regions = Array.from(regionsSet).sort(compareByOrgDisplayOrder(regionSortOrder));");
  });

  it("pins the exact great-region/pastoral-zone roster order the user provided 2026-08-31 in the sort_order migration (松山1 before 松山2, plus 花蓮/桃園/未設定牧區 at the tail, no 桃1)", () => {
    // Locked to the literal VALUES list text so any future edit that
    // reorders/drops an entry here fails loudly instead of silently
    // drifting from the roster again — this migration is now the one and
    // only place this roster order is allowed to live.
    const regionStart = orgSortOrderMigration.indexOf("WITH great_region_order(name, display_order) AS (");
    const regionEnd = orgSortOrderMigration.indexOf("UPDATE public.great_regions", regionStart);
    const regionSource = orgSortOrderMigration.slice(regionStart, regionEnd);
    const regions = [...regionSource.matchAll(/'([^']+)'/g)].map(m => m[1]);
    expect(regions).toEqual(["東區", "西區", "南區", "北區", "青少年", "慶典", "創藝", "花蓮", "桃園", "未設定"]);

    const zoneStart = orgSortOrderMigration.indexOf("WITH pastoral_zone_order(name, display_order) AS (");
    const zoneEnd = orgSortOrderMigration.indexOf("UPDATE public.pastoral_zones", zoneStart);
    const zoneSource = orgSortOrderMigration.slice(zoneStart, zoneEnd);
    const zones = [...zoneSource.matchAll(/'([^']+)'/g)].map(m => m[1]);
    expect(zones).toEqual([
      "大安1", "大安2", "大安3", "大安4", "大安6", "大安7", "大安8", "大安9", "大安10", "大安11", "大安12",
      "中正1", "中正2", "中正3", "中正4", "中正5",
      "中山1", "中山2", "中山3", "中山5",
      "信義2", "信義3",
      "士林",
      "松山1", "松山2",
      "南港", "內湖", "文山",
      "新烏1", "新烏2", "新烏3", "新烏4",
      "中永和", "三重",
      "青少年教會",
      "慶典1", "慶典2",
      "創藝",
      "新莊1", "新莊2", "新莊3",
      "花蓮", "桃園",
      "未設定牧區"
    ]);
  });

  it("applies the same fixed 大區/牧區 order to every other CSV export (users, org structure, team registration)", () => {
    expect(admin).toContain("function sortProfilesByChurchOrgOrder(profiles)");
    expect(admin).toContain("const rows = sortProfilesByChurchOrgOrder(profiles).map(p => [");
    expect(admin).toContain('const regions = sortByChurchOrgOrder(orgStructure.regions || [], compareGreatRegions, region => region);');
    expect(admin).toContain('const zones = sortByChurchOrgOrder(zonesMap[region] || [], comparePastoralZones, zone => zone);');
    expect(admin).toContain("const sortedTeams = sortByChurchOrgOrder(teams, comparePastoralZones, team => {");
  });

  it("adds 3-person and 6-person reading-team join counts per great region and pastoral zone", () => {
    expect(teamCountsMigration).toContain("CREATE OR REPLACE FUNCTION public.get_admin_registration_statistics(");
    expect(teamCountsMigration).toContain("JOIN public.reading_teams AS rt ON rt.id = tm.team_id");
    expect(teamCountsMigration).toContain("tm.global_plan_id = p_global_plan_id");
    expect(teamCountsMigration).toContain("team3.division = 3");
    expect(teamCountsMigration).toContain("team6.division = 6");
    expect(teamCountsMigration).toContain("'team3Count', team3_count");
    expect(teamCountsMigration).toContain("'team6Count', team6_count");
    // Both rollups (pastoral zone AND great region) must expose the new counts,
    // not just one of them.
    expect(teamCountsMigration.match(/'team3Count', team3_count/g)?.length).toBe(2);
    expect(teamCountsMigration.match(/'team6Count', team6_count/g)?.length).toBe(2);

    expect(admin).toContain('<th>3 人團隊人數</th>');
    expect(admin).toContain('<th>6 人團隊人數</th>');
    expect(admin).toContain("Number(row.team3Count || 0)");
    expect(admin).toContain("Number(row.team6Count || 0)");
    expect(admin).toContain('esc(Number(row.team3Count || 0))');
    expect(admin).toContain('esc(Number(row.team6Count || 0))');
  });

  it("bumps the browser cache keys for the new UI", () => {
    expect(html).toMatch(/index\.css\?v=2026\d{4}_/);
    expect(html).toMatch(/js\/app\.js\?v=2026\d{4}_/);
  });
});

describe("報名與註冊統計 → Google 試算表同步", () => {
  it("adds an admin-only action to nlc-data that forwards to the Apps Script webhook with a shared secret, never the caller's token", () => {
    expect(edge).toContain('"sync_registration_stats_sheet"');
    expect(edge).toContain('if (action === "sync_registration_stats_sheet")');
    expect(edge).toContain("if (!isAdmin(profile)) return jsonResponse({ error: \"forbidden\" }, 403);");
    expect(edge).toContain('Deno.env.get("REGISTRATION_STATS_SHEET_WEBHOOK_URL")');
    expect(edge).toContain('Deno.env.get("REGISTRATION_STATS_SHEET_WEBHOOK_SECRET")');
    expect(edge).toContain("secret: sheetSecret");
    // The forwarded payload must be server-sanitized (numbers coerced, strings
    // length-capped), not the raw client body passed straight through.
    expect(edge).toContain("Number(row?.signupCount) || 0");
    expect(edge).toContain('String(row?.leaderName ?? "").slice(0, 60)');
  });

  it("client builds the exact row shape the Apps Script expects (大區 block, 牧區 block with leader names, fixed summary block)", () => {
    expect(admin).toContain("export async function buildAdminRegistrationStatisticsSheetPayload(context)");
    expect(admin).toContain("async function buildPastoralZoneLeaderNameMap()");
    expect(admin).toContain('await db.fetchManagedScopeProfiles()');
    expect(admin).toContain('getUserRoleCode(profile) !== "zone_leader"');
    expect(admin).toContain("leaderName: leaderNameByZone.get(sanitizeRegistrationStatisticsText(row.label)) || \"\"");
    // Great regions and pastoral zones must both go through the same fixed
    // church-org order used by every other export, not raw RPC order.
    expect(admin).toContain("sortByChurchOrgOrder(greatRegions, compareGreatRegions, row => row.label).map(toRow)");
    expect(admin).toContain("sortByChurchOrgOrder(pastoralZones, comparePastoralZones, row => row.label).map(row => ({");
  });

  it("db.js calls nlc-data directly with the Logto token, matching the sendCareReminder pattern (not the NlcDataClient shim)", () => {
    expect(db).toContain("async syncRegistrationStatisticsToSheet({ planName, greatRegions, pastoralZones, summary } = {})");
    expect(db).toContain('action: "sync_registration_stats_sheet"');
    expect(db).toContain("auth.getValidAccessToken()");
    expect(db).toContain("/functions/v1/nlc-data");
  });

  it("wires a disabled-until-loaded button next to the CSV export button", () => {
    expect(html).toContain('id="admin-registration-statistics-sheet-sync"');
    expect(html).toContain("更新到 Google 試算表");
    expect(admin).toContain("sheetSyncButton.onclick = syncAdminRegistrationStatisticsToSheet");
    expect(admin).toContain('if (sheetSyncButton) sheetSyncButton.disabled = true;');
    expect(admin).toContain('if (sheetSyncButton) sheetSyncButton.disabled = false;');
  });

  it("ships the Apps Script reference file and README setup instructions, following the issue-report-sheet-sync precedent", () => {
    const appsScript = readFileSync("supabase/functions/nlc-data/registration-stats-apps-script.gs.txt", "utf8");
    expect(appsScript).toContain("var SHEET_GID = 9828844;");
    expect(appsScript).toContain('function doPost(e)');
    expect(appsScript).toContain('payload.secret !== SHARED_SECRET');
    expect(appsScript).toContain('["區域", "區長", "報名人數", "註冊人數", "3人團隊人數", "6人團隊人數"]');
    expect(appsScript).toContain('rows.push(["大區"');
    expect(appsScript).toContain('rows.push(["牧區"');
    expect(appsScript).toContain("sheet.getRange(2, 8, 1, 6)");
    expect(appsScript).toContain("sheet.getRange(3, 8, 1, 6)");

    const readme = readFileSync("supabase/functions/README.md", "utf8");
    expect(readme).toContain("sync_registration_stats_sheet");
    expect(readme).toContain("REGISTRATION_STATS_SHEET_WEBHOOK_URL");
    expect(readme).toContain("REGISTRATION_STATS_SHEET_WEBHOOK_SECRET");
  });

  it("writes the plan name into the merged H7:I7 cell under the 讀經計畫 label at H6", () => {
    const appsScript = readFileSync("supabase/functions/nlc-data/registration-stats-apps-script.gs.txt", "utf8");
    // Merged cells take their value on the top-left anchor cell only — never
    // a multi-column setValues() across the merge.
    expect(appsScript).toContain('sheet.getRange(6, 8).setValue("讀經計畫");');
    expect(appsScript).toContain("sheet.getRange(7, 8).setValue(payload.planName || \"\");");

    // The client and server must both actually carry planName through to the
    // Apps Script payload, not just the Apps Script side expecting it.
    expect(admin).toContain("planName: String(context && context.planName || \"\")");
    expect(db).toContain("plan_name: String(planName || \"\")");
    expect(edge).toContain('planName: String(p.plan_name ?? "").slice(0, 60)');
  });
});
