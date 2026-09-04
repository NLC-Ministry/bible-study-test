import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const exists = path => existsSync(new URL(`../${path}`, import.meta.url));
const migration = read("supabase/migrations/0019_reading_team_registration.sql");
const forwardMigration = read("supabase/migrations/0021_enforce_reading_team_uuid_links.sql");
const dualDivisionMigration = read("supabase/migrations/0022_allow_both_team_divisions.sql");
const peerReminderMigration = read("supabase/migrations/0023_reading_team_peer_reminders.sql");
const rosterStatsMigration = read("supabase/migrations/0024_reading_team_member_roster_stats.sql");
const productionCleanup = read("supabase/migrations/0026_production_cleanup_obsolete_plans_badges.sql");
const secureTeamNamesMigration = read("supabase/migrations/0037_secure_unique_reading_team_names.sql");
const captainOnlyTeamExitMigration = read("supabase/migrations/0042_restrict_reading_team_exit_to_captain.sql");
const edge = read("supabase/functions/nlc-data/index.ts");
const db = read("js/db.js");
const plan = read("js/modules/plan.js");
const participation = read("js/modules/plan-participation-helpers.mjs");
const teamUi = read("js/modules/team-registration.js");
const profile = read("js/modules/profile.js");
const teamCss = read("css/team-registration.css");
const html = read("index.html");
const app = read("js/app.js");
const indexCss = read("index.css");

const extractFunction = (source, name, nextName) => {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

const loadConfirmPlanJoin = () => {
  const source = extractFunction(plan, "confirmPlanJoin", "joinPlanSoloFromCard");
  return new Function(
    "escapeHTML",
    "hydrateIcons",
    `${source}; return confirmPlanJoin;`
  )(
    value => String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char])),
    () => {}
  );
};

const withDialogDom = async testFn => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await testFn(dom);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
};

describe("reading competition team schema", () => {
  it("shows unread care reminders only on the notification bell", () => {
    expect(html).not.toContain("data-care-reminder-badge");
    expect(html).toContain('id="btn-notification-bell"');
    expect(html).toContain('id="notification-bell-badge"');
    expect(app).toContain("refreshCareReminderBadge({ force: true })");
    expect(app).toContain('document.addEventListener("visibilitychange"');
    expect(app).toContain('count > 9 ? "9+"');
    expect(profile).toContain('window.updateCareReminderBadge(reminders || [])');
    expect(indexCss).toContain(".notification-bell-badge[hidden]");
  });

  it("keeps 3-person and 6-person teams separate from organisation groups", () => {
    expect(migration).toContain("division IN (3, 6)");
    expect(migration).toContain("UNIQUE (global_plan_id, user_id)"); // upgraded by 0022
    expect(migration).toContain("user_id UUID NOT NULL REFERENCES public.profiles(id)");
    expect(migration).toContain("FOREIGN KEY (team_id, global_plan_id)");
    expect(migration).toContain("REFERENCES public.reading_teams(id, global_plan_id)");
    expect(migration).not.toMatch(/member_name|display_name/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.profiles/i);
    expect(migration).not.toMatch(/ALTER\s+TABLE\s+public\.(small_groups|pastoral_zones)/i);
  });

  it("can safely upgrade a database that already applied earlier team migrations", () => {
    expect(forwardMigration).toContain("IF NOT EXISTS");
    expect(dualDivisionMigration).toContain("ADD COLUMN IF NOT EXISTS division SMALLINT");
    expect(dualDivisionMigration).toContain("UNIQUE (global_plan_id, user_id, division)");
    expect(dualDivisionMigration).toContain("FOREIGN KEY (team_id, global_plan_id, division)");
    expect(dualDivisionMigration).toContain("already_in_plan_division");
  });

  it("normalizes team names and prevents duplicates and unsafe hidden markup", () => {
    expect(secureTeamNamesMigration).toContain("normalize_reading_team_name");
    expect(secureTeamNamesMigration).toContain("idx_reading_teams_plan_division_normalized_name");
    expect(secureTeamNamesMigration).toContain("reading_teams_name_safe_check");
    expect(secureTeamNamesMigration).toContain("duplicate_team_name");
    expect(secureTeamNamesMigration).toContain("pg_advisory_xact_lock");
    expect(secureTeamNamesMigration).toContain("[[:cntrl:]<>]");
    expect(secureTeamNamesMigration).toContain("duplicate_number");
    expect(db).toContain('duplicate_team_name: "這個團隊名稱已有人使用，請換一個名稱。"');
    expect(teamUi).toContain("escapeHTML(team.name");
  });

  it("does not ship fixture seed scripts and removes their UUID-linked data atomically", () => {
    expect(exists("supabase/scripts/seed_reading_team_test_data.sql")).toBe(false);
    expect(exists("supabase/scripts/seed_reading_team_reminder_test.sql")).toBe(false);
    expect(exists("supabase/scripts/cleanup_reading_team_test_data.sql")).toBe(false);
    expect(productionCleanup).toContain("00000000-0000-0000-c026-000000009999");
    expect(productionCleanup).toContain("TEST3TEAM");
    expect(productionCleanup).toContain("TEST6TEAM");
    expect(productionCleanup.indexOf("DELETE FROM public.reading_plans"))
      .toBeLessThan(productionCleanup.indexOf("DELETE FROM public.global_plans"));
  });

  it("locks concurrent joins and freezes a completed roster", () => {
    expect(migration).toMatch(/join_reading_team_by_code[\s\S]*FOR UPDATE/);
    expect(migration).toContain("current_count >= selected_team.division");
    expect(migration).toContain("status = 'ready'");
    expect(migration).toContain("ready_team_roster_locked");
  });

  it("uses a non-recursive membership helper for row-level visibility", () => {
    expect(migration).toContain("FUNCTION public.is_reading_team_member");
    expect(migration).toContain("public.is_reading_team_member(reading_teams.id");
    expect(migration).toContain("public.is_reading_team_member(reading_team_members.team_id");
    const memberPolicy = migration.match(/CREATE POLICY reading_team_members_own_team_read[\s\S]*?\);/)?.[0] || "";
    expect(memberPolicy).not.toContain("FROM public.reading_team_members");
  });

  it("returns both of the caller's joined team divisions through the user RPC", () => {
    expect(dualDivisionMigration).toMatch(/get_my_reading_team[\s\S]*own_membership\.user_id = actor_id/);
    expect(dualDivisionMigration).toContain("'teams', team_contexts");
    expect(dualDivisionMigration).toContain("ORDER BY division");
    expect(dualDivisionMigration).not.toContain("get_all_reading_teams");
  });

  it("allows peer reminders only between UUID-linked members of the same team", () => {
    expect(peerReminderMigration).toContain("send_reading_team_reminder");
    expect(peerReminderMigration).toMatch(/JOIN public\.reading_team_members sender[\s\S]*sender\.user_id = actor_id/);
    expect(peerReminderMigration).toMatch(/JOIN public\.reading_team_members recipient[\s\S]*recipient\.user_id = p_recipient_id/);
    expect(peerReminderMigration).toContain("team_reminder_same_team_required");
    expect(peerReminderMigration).toContain("team_reminder_daily_limit");
    expect(peerReminderMigration).toContain("auth.uid() IS NOT NULL");
    expect(peerReminderMigration).not.toMatch(/UPDATE\s+public\.(profiles|small_groups|pastoral_zones)/i);
  });

  it("returns the same roster metrics needed by organisation member status", () => {
    expect(rosterStatsMigration).toContain("'longestStreak'");
    expect(rosterStatsMigration).toContain("'readingLogs'");
    expect(rosterStatsMigration).toContain("ROW_NUMBER() OVER (ORDER BY read_day)");
    expect(rosterStatsMigration).toContain("membership.team_id = selected_team.id");
    expect(rosterStatsMigration).not.toMatch(/ALTER\s+TABLE\s+public\.(profiles|small_groups|pastoral_zones)/i);
  });
});

describe("NLC and browser integration", () => {
  it("styles plan participation controls for touch-safe responsive layouts", () => {
    expect(indexCss).toContain(".plan-team-invite-shortcut");
    expect(indexCss).toContain(".plan-team-invite-shortcut__action");
    expect(indexCss).toContain(".plan-card-participation-actions");
    expect(indexCss).toContain(".plan-card-action-btn");
    expect(indexCss).toContain("min-height: 44px");
    expect(indexCss).toContain("@media (max-width: 640px)");
    expect(plan).toContain("primary-btn plan-card-action-btn");
    expect(plan).toContain("secondary-btn plan-card-action-btn");
  });

  it("models plan cards around solo and team participation actions", () => {
    expect(plan).toContain("async function openJoinedPlanProgress(plan)");
    expect(plan).toContain("async function openJoinedPlanTeam(plan)");
    expect(plan).toContain("async function joinPlanSoloFromCard(plan, key)");
    expect(plan).toContain("async function createTeamFromPlanCard(plan, key)");
    expect(plan).toContain('data-plan-card-action="continue"');
    expect(plan).toContain('data-plan-card-action="solo-join"');
    expect(plan).toContain('data-plan-card-action="team-create"');
    // Participation copy now lives in the extracted pure model helper.
    expect(participation).toContain("個人讀經中");
    expect(participation).toContain("團隊讀經中");
    expect(participation).toContain("建立 / 加入團隊");
    expect(plan).toContain("自己加入");
    expect(plan).toContain("建立團隊");
  });

  it("confirms solo joins while team registration stays cancel-safe", () => {
    expect(plan).toContain("async function confirmPlanJoin");
    expect(plan).toContain('role="dialog"');
    expect(plan).toContain('aria-modal="true"');
    expect(plan).toContain('id="plan-join-confirmation-title"');
    expect(plan).toContain("要加入這個讀經計畫嗎？");
    expect(plan).toContain("太好了，開始吧");
    expect(plan).toContain("我再看看");

    const soloHandler = plan.slice(
      plan.indexOf("card.querySelector('[data-plan-card-action=\"solo-join\"]')"),
      plan.indexOf("card.querySelector('[data-plan-card-action=\"team-create\"]')")
    );
    expect(soloHandler).toContain("confirmPlanJoin");
    expect(soloHandler.indexOf("confirmPlanJoin")).toBeLessThan(soloHandler.indexOf("joinPlanSoloFromCard"));

    const teamHandlerStart = plan.indexOf("card.querySelector('[data-plan-card-action=\"team-create\"]')");
    const teamHandler = plan.slice(
      teamHandlerStart,
      plan.indexOf("container.appendChild(card)", teamHandlerStart)
    );
    expect(teamHandler).not.toContain("confirmPlanJoin");
    expect(teamHandler).toContain("createTeamFromPlanCard(plan, key)");
    expect(teamHandler).not.toContain("joinPlanSoloFromCard");
  });

  it("requires confirmation before joining from preset plan details", () => {
    const openDetailsFlow = plan.slice(
      plan.indexOf("const openDetails = () =>"),
      plan.indexOf("card.onclick = event =>")
    );
    expect(openDetailsFlow).toContain("openPlanDetailsDialog(plan");
    expect(openDetailsFlow).toContain("onJoin");
    expect(openDetailsFlow).toContain("confirmPlanJoin");
    expect(openDetailsFlow).toContain("joinPlanSoloFromCard(plan, key)");
    expect(openDetailsFlow.indexOf("confirmPlanJoin")).toBeLessThan(openDetailsFlow.indexOf("joinPlanSoloFromCard(plan, key)"));
  });

  it("opens team setup from preset cards without joining the plan first", () => {
    const createTeamFlow = plan.slice(
      plan.indexOf("async function createTeamFromPlanCard"),
      plan.indexOf("function renderPresetPlans")
    );
    expect(createTeamFlow).not.toContain("joinPlanSoloFromCard");
    expect(createTeamFlow).not.toContain("await db.joinPresetPlan");
    expect(createTeamFlow).toContain("openReadingTeamDialog(plan");
    expect(createTeamFlow).not.toContain("preferredDivision: 3");

    const teamDialog = teamUi.slice(
      teamUi.indexOf("const renderEmpty = (joinedContexts"),
      teamUi.indexOf("const renderTeam = (context")
    );
    expect(teamDialog).toContain("availableDivisions = [3, 6]");
    expect(teamDialog).toContain("data-division-choice");
    expect(teamDialog).toContain("data-team-back");
    expect(teamDialog).toContain("returnDivision");
    expect(teamDialog).toContain("renderTeam(returnContext, joinedContexts)");
    expect(teamDialog).toContain("db.createReadingTeam(plan, preferredDivision");
    expect(teamCss).toContain(".reading-team-back-button");
  });

  it("focuses the safest action when the plan join confirmation opens", async () => {
    await withDialogDom(async () => {
      const confirmPlanJoin = loadConfirmPlanJoin();
      const pending = confirmPlanJoin({
        plan: { name: "Test Plan" },
        mode: "solo",
        onConfirm: vi.fn()
      });

      const cancelButton = document.querySelector("[data-plan-confirm-cancel]");
      expect(document.activeElement).toBe(cancelButton);

      cancelButton.click();
      await expect(pending).resolves.toBe(false);
    });
  });

  it("traps keyboard focus in the plan join confirmation and restores prior focus", async () => {
    const confirmSource = extractFunction(plan, "confirmPlanJoin", "joinPlanSoloFromCard");
    expect(confirmSource).toContain("previousActiveElement");
    expect(confirmSource).toContain("focusableElements");
    expect(confirmSource).toContain("event.shiftKey");
    expect(confirmSource).toContain("previousActiveElement.focus()");

    await withDialogDom(async () => {
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.textContent = "Open details";
      document.body.appendChild(trigger);
      trigger.focus();

      const confirmPlanJoin = loadConfirmPlanJoin();
      const pending = confirmPlanJoin({
        plan: { name: "Test Plan" },
        mode: "solo",
        onConfirm: vi.fn()
      });

      const cancelButton = document.querySelector("[data-plan-confirm-cancel]");
      const confirmButton = document.querySelector("[data-plan-confirm-action]");
      expect(document.activeElement).toBe(cancelButton);

      cancelButton.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true
      }));
      expect(document.activeElement).toBe(confirmButton);

      confirmButton.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true
      }));
      expect(document.activeElement).toBe(cancelButton);

      cancelButton.click();
      await expect(pending).resolves.toBe(false);
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("recovers when plan join confirmation fails", async () => {
    await withDialogDom(async () => {
      const confirmPlanJoin = loadConfirmPlanJoin();
      const onConfirm = vi.fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce(undefined);
      const pending = confirmPlanJoin({
        plan: { name: "Test Plan" },
        mode: "solo",
        onConfirm
      });
      const confirmButton = document.querySelector("[data-plan-confirm-action]");

      confirmButton.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(document.querySelector(".plan-join-confirmation-dialog__error")?.textContent)
        .toContain("暫時無法加入，請再試一次。");
      expect(confirmButton.disabled).toBe(false);

      confirmButton.click();
      await expect(pending).resolves.toBe(true);
      expect(document.querySelector(".plan-join-confirmation-overlay")).toBeNull();
      expect(onConfirm).toHaveBeenCalledTimes(2);
    });
  });

  it("models joined-plan participation through the shared participation item", () => {
    expect(participation).toContain("export function getPlanParticipationModel");
    expect(plan).toContain("function renderPlanParticipationItem");
    expect(plan).toContain("function bindPlanParticipationItemActions");
    expect(participation).toContain("團隊讀經中");
    expect(participation).toContain("個人讀經中");
    expect(participation).toContain("我的團隊");
    expect(participation).toContain("open-team-dialog");
  });

  it("allows only the bounded team RPCs and forces the authenticated profile id", () => {
    for (const name of [
      "get_my_reading_team",
      "create_reading_team",
      "join_reading_team_by_code",
      "leave_reading_team",
      "remove_reading_team_member",
      "disband_reading_team",
      "send_reading_team_reminder"
    ]) expect(edge).toContain(`"${name}"`);
    expect(edge).toContain("TEAM_RPC_FUNCTIONS.has(functionName)");
    expect(edge).toContain('"get_reading_team_statistics"');
    expect(edge).toContain("p_actor_id: profile.id");

    // reading_teams / reading_team_members ARE in the generic read allowlist
    // — js/db.js's admin fallback paths (_getReadingTeamRegistrationOverviewFallback,
    // _getAdminMemberTeamPlacementsFallback) rely on selecting them directly
    // when their RPC counterpart is unavailable. nlc-data runs on the
    // service-role key and bypasses the reading_teams_own_team_read /
    // reading_team_members_own_team_read RLS policies (migration 0019), so
    // applyForcedScope must reproduce that same boundary for non-management
    // callers instead of leaving the table wide open.
    const readAllowlist = edge.match(/const READ_TABLES = new Set\([\s\S]*?\);/)?.[0] || "";
    expect(readAllowlist).toContain("reading_teams");
    expect(readAllowlist).toContain("reading_team_members");

    const scopeStart = edge.indexOf('table === "reading_teams" || table === "reading_team_members"');
    expect(scopeStart, "reading_teams/reading_team_members scope in applyForcedScope").toBeGreaterThan(-1);
    const scopeBlock = edge.slice(scopeStart, edge.indexOf("\n  }", scopeStart));
    expect(scopeBlock).toContain('!canManagePlans(profile)');
    expect(scopeBlock).toContain('.eq("user_id", profile.id)');
    expect(scopeBlock).toContain('query.in(idColumn, teamIds.length ? teamIds : ["00000000-0000-0000-0000-000000000000"])');
  });

  it("lets only the captain remove individual members or dissolve the team", () => {
    expect(teamUi).not.toContain("data-leave-team");
    expect(teamUi).not.toContain("db.leaveReadingTeam(");
    expect(teamUi).toContain("data-team-remove-user");
    expect(teamUi).toContain("移出隊員");
    expect(teamUi).toContain("db.removeReadingTeamMember(team.id, member.userId)");
    expect(teamUi).toContain("解散團隊");
    expect(teamUi).toContain("db.disbandReadingTeam(team.id)");
    expect(captainOnlyTeamExitMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.remove_reading_team_member/);
    expect(captainOnlyTeamExitMigration).toMatch(/selected_team\.captain_id <> actor_id[\s\S]*team_member_remove_captain_required/);
    expect(captainOnlyTeamExitMigration).toContain("team_captain_remove_self_not_allowed");
    expect(captainOnlyTeamExitMigration).toMatch(/DELETE FROM public\.reading_team_members[\s\S]*user_id = p_member_id/);
    expect(captainOnlyTeamExitMigration).toMatch(/UPDATE public\.reading_teams[\s\S]*SET status = 'forming'/);
    expect(db).toContain('_callReadingTeamRpc("remove_reading_team_member"');
    expect(db).toContain('team_captain_required: "只有隊長可以解散團隊。"');
    expect(edge).toContain('"remove_reading_team_member"');
    expect(teamCss).toContain(".reading-team-remove-btn");
    expect(teamCss).toContain(".reading-team-member__actions");
  });
  it("delivers team reminders without requiring a table parameter", () => {
    expect(edge).toContain('["save_profile", "rpc", "send_care_reminder", "mark_issue_report_reply_seen", "sync_registration_stats_sheet", "issue_thread_get", "issue_thread_post", "issue_thread_attachment_delete"]');
    expect(edge).toContain('const pastoralRoles = ["admin", "pastor", "great_zone_leader", "zone_leader", "group_leader"]');
    expect(edge).toContain("pastoral_reminder_scope_required");
    expect(edge).toContain("const withinScope = hasWholeChurchPlanScope(profile)");
    expect(db).toContain("response.status === 403");
    expect(profile).toContain("收到的關心提醒");
    expect(profile).toContain('startsWith("reading-team:")');
    expect(profile).toContain('isTeamReminder ? "隊友"');
    expect(profile).not.toContain("收到牧長同工的關心提醒");
  });

  it("keeps personal progress primary and offers optional 3-person or 6-person teams", () => {
    expect(teamUi).toContain("計畫已加入");
    expect(teamUi).toContain("你可以同時參加一支 3 人團隊與一支 6 人團隊");
    expect(teamUi).toContain("章節進度只需勾選一次");
    expect(teamUi).toContain("data-team-skip");
    expect(teamUi).toContain('data-team-division="3"');
    expect(teamUi).toContain('data-team-division="6"');
    expect(teamUi).toContain('id="reading-team-create-form"');
    expect(teamUi).toContain("並產生邀請碼");
    expect(html).toContain("使用邀請碼加入團隊");
    expect(teamUi).toContain("team.inviteCode");
    expect(teamUi).toContain("renderTeamStatGrid");
    expect(teamUi).toContain("renderTeamMemberRoster");
    expect(teamUi).toContain("最高連續");
    expect(teamUi).toContain("累計完成");
    expect(teamUi).toContain("補讀");
    expect(teamUi).toContain("進度狀態");
    expect(teamUi).toContain("data-team-remind-user");
    expect(teamUi).toContain('data-icon="poke"');
    expect(teamUi).toContain('reading-team-remind-btn__label">戳一下');
    expect(teamCss).toContain(".reading-team-inline--stats .reading-team-remind-btn__label");
    expect(teamCss).not.toMatch(/\.reading-team-inline--stats \.reading-team-remind-btn\s*\{\s*display:\s*none/);
    expect(db).toContain("sendReadingTeamReminder");
    expect(teamUi).toContain("加入後，你可以查看自己的團隊與夥伴進度");
    expect(teamUi).toContain("只有同隊成員可查看");
    expect(teamUi).toContain("其他隊伍的資料不會顯示");
    expect(teamUi).not.toContain("UUID");
    expect(db).toContain("目前找不到你的會員資料");
  });

  it("keeps the other team-size creation entry visible inside My Team", () => {
    const renderTeam = teamUi.slice(
      teamUi.indexOf("const renderTeam = (context"),
      teamUi.indexOf("const refresh = async")
    );

    expect(renderTeam).toContain("availableDivisions");
    expect(renderTeam).toContain("data-add-other-team");
    expect(renderTeam).toContain("建立另一種人數團隊");
    expect(renderTeam.indexOf("data-add-other-team")).toBeLessThan(renderTeam.indexOf("querySelector(\"[data-add-other-team]"));
  });

  it("opens team setup with an explicit 3-person and 6-person chooser before the create form", () => {
    const renderEmpty = teamUi.slice(
      teamUi.indexOf("const renderEmpty = (joinedContexts"),
      teamUi.indexOf("const renderTeam = (context")
    );

    expect(renderEmpty).toContain("reading-team-division-choice-grid");
    expect(renderEmpty).toContain("availableDivisions = [3, 6]");
    expect(renderEmpty).toContain("availableDivisions.map");
    expect(renderEmpty).toContain("data-division-choice");
    expect(renderEmpty).toContain('data-division-choice="${division}"');
    expect(renderEmpty).toContain("你可以同時參加 3 人團隊與 6 人團隊");
    expect(renderEmpty).toContain("章節進度只需打卡一次");
    expect(renderEmpty).toContain("panel.querySelectorAll(\"[data-division-choice]\")");
    expect(renderEmpty).toContain('id="reading-team-create-form"');
    expect(renderEmpty.indexOf("reading-team-division-choice-grid")).toBeLessThan(renderEmpty.indexOf('id="reading-team-create-form"'));
  });

  it("keeps inline team reminder controls inside mobile member rows", () => {
    expect(teamCss).toContain(".reading-team-inline--stats .reading-team-member");
    expect(teamCss).toContain("grid-template-columns: 40px minmax(0, 1fr) 44px");
    expect(teamCss).toContain(".reading-team-inline--stats .reading-team-member__body");
    expect(teamCss).toContain("grid-column: 2 / 4");
    expect(teamCss).toContain(".reading-team-inline--stats .reading-team-remind-btn");
    expect(teamCss).toContain("inline-size: 44px");
    expect(teamCss).toContain(".reading-team-inline--stats .reading-team-remind-btn__label");
    expect(teamCss).toContain("display: none");
  });

  it("uses adaptive semantic surfaces in light, dark, and warm themes", () => {
    expect(teamCss).toContain("--reading-team-surface:");
    expect(teamCss).toContain("--reading-team-surface-raised:");
    expect(teamCss).toContain("body.dark-theme .reading-team-overlay");
    expect(teamCss).toContain("body.warm-theme .reading-team-overlay");
    expect(teamCss).toContain(".reading-team-registration-tabs");
    expect(teamCss).toContain("@media (prefers-contrast: more)");
    expect(teamCss).not.toMatch(/var\(--bg-secondary,\s*#2/i);
  });

  it("renders the participation chooser above fixed app navigation", () => {
    expect(teamCss).toMatch(/\.reading-team-overlay[\s\S]*position: fixed/);
    expect(teamCss).toContain("inset: 0");
    expect(teamCss).toContain("z-index: var(--z-modal, 700)");
    expect(teamCss).toMatch(/@media \(max-width: 640px\)[\s\S]*align-items: flex-end/);
    expect(teamUi).toContain("reading-team-modal-open");
    expect(teamUi).toContain("reading-team-dialog--choice");
    expect(teamUi).toContain('data-icon="chevronRight"');
  });

  it("styles plan join confirmation as a compact non-pill dialog", () => {
    expect(teamCss).toContain(".plan-join-confirmation-overlay");
    expect(teamCss).toContain(".plan-join-confirmation-dialog");
    expect(teamCss).toContain("border-radius: 12px");
    expect(teamCss).toContain(".plan-join-confirmation-dialog__footer");
    expect(teamCss).toContain("@media (max-width: 640px)");
    expect(teamCss).not.toMatch(/\.plan-join-confirmation-dialog__[^{]+\{[^}]*border-radius:\s*999/i);
  });

  it("connects joining to My Team and integrates team data into existing group views", () => {
    expect(plan).not.toContain("chooseReadingPlanParticipation(plan)");
    expect(plan).toContain("openJoinModeDialog(plan)");
    expect(plan).toContain("openReadingTeamDialog(plan");
    expect(plan).toContain("resolveTeamJoinEffectivePlan");
    expect(html).not.toContain('id="view-reading-team-btn"');
    const planOptions = html.slice(html.indexOf('id="plan-options-dropdown"'), html.indexOf('</div>', html.indexOf('id="plan-options-dropdown"')));
    expect(planOptions).not.toContain("\u7267\u5340\u5c0f\u7d44\u72c0\u6cc1");
    expect(plan).not.toContain("view-reading-team-btn");
    expect(plan).not.toContain("async function enterOrgStatsState");
    expect(plan).not.toContain("setPlanState(PLAN_ROUTE.ORG_STATS)");
    expect(html).not.toContain('id="view-reading-team-stats-btn"');
    // Segmented control, not a hidden-affordance <select>: users who joined both
    // the 3-person and 6-person team must see both options at once, never a
    // dropdown they have to notice and open first (that shape produced real
    // "can't see my 6-person team" reports).
    expect(html).toContain('id="stats-team-view-tabs"');
    expect(html).toContain('id="members-team-view-tabs"');
    expect(html).not.toContain('id="stats-team-view-select"');
    expect(html).not.toContain('id="members-team-view-select"');
    expect(plan).toContain("async function prepareReadingTeamSubview");
    expect(plan).toContain('prepareReadingTeamSubview("stats")');
    expect(plan).toContain('prepareReadingTeamSubview("members")');
    expect(plan).toContain('reading-team-');
    expect(plan).toContain('readingTeamDivision');
    expect(plan).toContain('readingTeamDefaultPlan');
    expect(plan).toContain('segment-toggle-btn');
    expect(plan).toContain('statsTab.textContent = "團隊"');
    expect(teamUi).toContain("renderMyReadingTeamInline");
    expect(teamUi).toContain("data-team-view-division");
    expect(teamUi).toContain("data-add-other-team");
    expect(teamUi).not.toContain("openReadingTeamAdminStatsDialog");
    expect(teamUi).not.toContain("競賽團隊統計");
    expect(db).toContain("forbidden_rpc");
    expect(db).toContain("already_in_plan_division");
    expect(migration).toMatch(/get_reading_team_statistics[\s\S]*team_statistics_admin_required/);
    expect(db).toContain('_callReadingTeamRpc("get_my_reading_team"');
    expect(db).toContain("return newPlanObj;");
  });

  it("derives team progress from each member's single personal reading log", () => {
    expect(migration).not.toContain("reading_team_logs");
    expect(migration).toMatch(/LEFT JOIN public\.reading_plans plan[\s\S]*plan\.user_id = membership\.user_id/);
    expect(migration).toMatch(/FROM public\.reading_logs log WHERE log\.plan_id = plan\.id/);
    expect(db).toContain('onConflict: "user_id,plan_id,book,chapter,round"');
  });

  it("does not reuse organisation statistics as team registration", () => {
    expect(teamUi).not.toContain("pastoral_zone");
    expect(teamUi).not.toContain("small_group");
    expect(db).toContain("getPlanFilterAliases");
    expect(plan).toContain("canUseAdvancedGroupStats");
  });

  it("promotes invite-code team joining above plan list filters", () => {
    expect(html).toContain('id="plan-team-invite-shortcut"');
    expect(html).toContain('id="btn-open-plan-team-invite"');
    expect(html).toContain("有邀請碼？加入團隊");
    expect(html).toContain('id="join-team-container"');
    expect(html).toContain('id="btn-close-plan-team-invite"');
    expect(html).not.toContain('data-filter="join-team"');
    expect(plan).toContain("function openPlanTeamInvitePanel");
    expect(plan).toContain("function closePlanTeamInvitePanel");
    expect(plan).toContain('document.getElementById("btn-open-plan-team-invite")');
    expect(plan).toContain('document.getElementById("btn-close-plan-team-invite")');
    expect(plan).not.toContain('filter === "join-team"');
  });

  it("keeps the invite panel trigger and reset flow accessible", () => {
    const trigger = html.match(/<button[^>]+id="btn-open-plan-team-invite"[^>]*>/)?.[0] || "";
    const panelFlow = plan.slice(
      plan.indexOf("function openPlanTeamInvitePanel"),
      plan.indexOf("function initPlanControls")
    );

    expect(trigger).toContain('aria-controls="join-team-container"');
    expect(trigger).toContain('aria-expanded="false"');
    expect(panelFlow).toContain('trigger?.setAttribute("aria-expanded", "true")');
    expect(panelFlow).toContain("function resetPlanTeamInvitePanel");
    expect(panelFlow).toContain("resetPlanTeamInvitePanelState({");
    expect(panelFlow).toContain("restoreFocus");
    expect(panelFlow).toContain("resetPlanTeamInvitePanel({ restoreFocus: true })");
    expect(plan).toContain('openInviteBtn?.setAttribute("aria-expanded", "false")');
  });

  it("delegates successful and already-joined team results to effective plan resolution", () => {
    const globalJoinFlow = plan.slice(
      plan.indexOf("async function joinTeamGlobally"),
      plan.indexOf("window.joinTeamGlobally")
    );

    expect(globalJoinFlow).toContain("res.success || isAlreadyJoinedTeamResult(res)");
    expect(globalJoinFlow).toContain("resolveTeamJoinEffectivePlan({");
    expect(globalJoinFlow).toContain("return db.joinPresetPlan");
    expect(globalJoinFlow).toContain("if (!effectivePlan)");
    expect(globalJoinFlow).toContain("plan: effectivePlan");
  });

  it("routes invite-code success into the resolved plan team surface", () => {
    const formFlow = plan.slice(
      plan.indexOf("function setupGlobalJoinTeamForm"),
      plan.indexOf("function openPlanDetailsDialog")
    );
    expect(formFlow).toContain("resetPlanTeamInvitePanel()");
    expect(formFlow).toContain("await openJoinedPlanTeam(res.plan)");
    expect(formFlow.indexOf("resetPlanTeamInvitePanel()")).toBeLessThan(formFlow.indexOf("await openJoinedPlanTeam(res.plan)"));
    expect(formFlow).toContain("已成功加入");
    expect(formFlow).toContain("團隊");
    expect(formFlow).not.toContain('const minePill = Array.from(document.querySelectorAll("#plan-list-status-pills .pill-btn"))');
  });

  it("never selects a non-existent id column from reading_team_members (its primary key is team_id + user_id)", () => {
    // Regression: reading_team_members has no `id` column (migration 0019:
    // PRIMARY KEY (team_id, user_id)) — selecting it fails with Postgres
    // 42703 ("column reading_team_members.id does not exist") and 400s the
    // whole nlc-data request. Both admin RPC-fallback queries in db.js must
    // never re-add it; neither actually reads `.id` off the returned rows.
    const teamMembersSelects = [...db.matchAll(/\.from\("reading_team_members"\)\s*\n\s*\.select\("([^"]+)"\)/g)]
      .map(match => match[1]);
    expect(teamMembersSelects.length).toBeGreaterThan(0);
    for (const select of teamMembersSelects) {
      const columns = select.split(",").map(col => col.trim());
      expect(columns).not.toContain("id");
    }
  });

  it("defines the values_overlap() SQL helper get_reading_team_registration_overview depends on", () => {
    // Regression: migration 0066 calls public.values_overlap(text, text)
    // but never created it — every call to get_reading_team_registration_overview
    // failed with 42883 ("function public.values_overlap(text, text) does
    // not exist"). Migration 0070 adds it and fixes two related bugs found
    // while doing so: `managed_regions || great_region` (string
    // concatenation, not the COALESCE(NULLIF(...), ...) fallback pattern
    // used everywhere else) glues two comma-lists together with no
    // separator, and the group_leader branch compared a team member's
    // pastoral_zone against the actor's managed_groups/small_group instead
    // of the member's own small_group.
    const fixMigration = read("supabase/migrations/0070_fix_values_overlap_and_team_overview_scope.sql");
    expect(fixMigration).toContain("CREATE OR REPLACE FUNCTION public.values_overlap(left_values TEXT, right_values TEXT)");
    expect(fixMigration).toContain("RETURNS BOOLEAN");
    expect(fixMigration).toContain("GRANT EXECUTE ON FUNCTION public.values_overlap(TEXT, TEXT) TO authenticated, service_role;");
    expect(fixMigration).not.toContain("managed_regions || actor_profile.great_region");
    expect(fixMigration).toContain("COALESCE(NULLIF(actor_profile.managed_regions, ''), actor_profile.great_region, '')");
    expect(fixMigration).toContain("COALESCE(NULLIF(actor_profile.managed_zones, ''), actor_profile.pastoral_zone, '')");
    expect(fixMigration).toContain("COALESCE(NULLIF(actor_profile.managed_groups, ''), actor_profile.small_group, '')");
    expect(fixMigration).toContain("public.values_overlap(md.small_group, COALESCE(NULLIF(actor_profile.managed_groups, ''), actor_profile.small_group, ''))");
    expect(fixMigration).toContain("p.small_group");
  });

  it("filters reading_team_members.user_id to real strings before the profiles .in() lookup", () => {
    // A malformed entry reaching .in("id", userIds) can make PostgREST
    // reject the whole request with a bare "Bad Request" (no Postgres error
    // code), not just skip that one row — filter defensively, not just for
    // truthiness.
    const start = db.indexOf("const userIds = Array.from(new Set(");
    const end = db.indexOf("));", start) + 3;
    const block = db.slice(start, end);
    expect(block).toContain('typeof id === "string" && id.length > 0');
  });

  it("self-heals a stale 'ready' status instead of trusting it as the source of truth (migration 0072)", () => {
    // Regular members have no self-service way to leave a team at all
    // (only the captain can, and that dissolves the team) — so under
    // normal app usage reading_teams.status can never legitimately go
    // stale relative to the real reading_team_members row count. It can
    // only desync if a membership row is removed some other way (e.g. a
    // manual delete via the Supabase dashboard), after which the team was
    // stuck reporting "full" (reading_team_full) to every future
    // invite-code join no matter how many members it actually had.
    const fixMigration = read("supabase/migrations/0072_self_heal_stale_reading_team_status.sql");
    expect(fixMigration).toContain("CREATE OR REPLACE FUNCTION public.join_reading_team_by_code(");
    const healStart = fixMigration.indexOf("IF selected_team.status = 'ready' AND current_count < selected_team.division THEN");
    expect(healStart, "self-heal branch").toBeGreaterThan(-1);
    const fullCheckIndex = fixMigration.indexOf("RAISE EXCEPTION 'reading_team_full';");
    expect(fullCheckIndex).toBeGreaterThan(healStart); // self-heal must run before the blocking check
    expect(fixMigration).toContain("UPDATE public.reading_teams SET status = 'forming' WHERE id = selected_team.id;");
    // One-time repair for any team already stuck as of this migration.
    expect(fixMigration).toContain("SET status = 'forming'");
    expect(fixMigration).toContain("WHERE team.status = 'ready'");
    expect(fixMigration).toContain(") < team.division;");
  });

  it("includes great_region/small_group on every team member, not just pastoral_zone (migration 0074)", () => {
    // Regression: js/modules/admin.js's teamMatchesManagementOrgFilter()
    // reads member.greatRegion/member.smallGroup when the shared 查看範圍
    // filter is set to 大區 or 小組. get_reading_team_registration_overview
    // only ever selected pastoral_zone per member, so those two fields were
    // always undefined and every team silently failed the filter (matched
    // zero teams) whenever an admin filtered by region or group — only
    // filtering by 牧區 could ever show results. Both the RPC and its
    // client-side fallback (_getReadingTeamRegistrationOverviewFallback)
    // must expose all three fields.
    const fixMigration = read("supabase/migrations/0074_team_overview_members_full_scope.sql");
    // This migration file is checked out with CRLF line endings, so a plain
    // toContain() on a \n-joined multi-line literal never matches even
    // though the content is present — match line-ending-agnostically instead.
    expect(fixMigration).toMatch(/p\.great_region,\s*p\.pastoral_zone,\s*p\.small_group/);
    expect(fixMigration).toContain("'greatRegion', md.great_region,");
    expect(fixMigration).toContain("'pastoralZone', md.pastoral_zone,");
    expect(fixMigration).toContain("'smallGroup', md.small_group");

    expect(db).toContain('.select("id, name, great_region, pastoral_zone, small_group")');
    const fallbackMemberBlock = db.slice(
      db.indexOf("const teamMembersMap = new Map();"),
      db.indexOf("const globalPlans = state.globalPlans || [];")
    );
    expect(fallbackMemberBlock).toContain("greatRegion: p?.great_region || \"\"");
    expect(fallbackMemberBlock).toContain("pastoralZone: p?.pastoral_zone || \"\"");
    expect(fallbackMemberBlock).toContain("smallGroup: p?.small_group || \"\"");
  });
});
