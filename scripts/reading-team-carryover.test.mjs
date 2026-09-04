import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = path => readFileSync(path, "utf8");
const migration = read("supabase/migrations/0058_carry_reading_team_to_next_stage.sql");
const migrationSkip = read("supabase/migrations/0154_carryover_skip_conflicting_members.sql");
const plan = read("js/modules/plan.js");
const db = read("js/db.js");
const edge = read("supabase/functions/nlc-data/index.ts");
const teamUi = read("js/modules/team-registration.js");

describe("reading team stage carryover", () => {
  it("offers carryover only to captains of the immediately previous stage", () => {
    expect(migration).toContain("source_stage_no := target_stage_no - 1");
    expect(migration).toContain("source_team.captain_id = actor_id");
    expect(migration).toContain("own_membership.member_role = 'captain'");
    expect(migration).toContain("target_stage_not_open");
    expect(migration).toContain("is_hidden = FALSE");
  });

  it("copies the complete roster and plan enrollment in one idempotent operation (original 0058 shape)", () => {
    expect(migration).toContain("carried_from_team_id");
    expect(migration).toContain("idx_reading_teams_one_carryover_per_stage");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toMatch(/INSERT INTO public\.reading_team_members[\s\S]*FROM public\.reading_team_members source_member/);
    expect(migration).toMatch(/INSERT INTO public\.reading_plans[\s\S]*ON CONFLICT \(user_id, global_plan_id\)/);
    // 0058's original all-or-nothing behavior — superseded by 0154 below.
    expect(migration).toContain("team_carryover_member_conflict");
  });

  it("exposes the offer and confirmation RPCs through both data paths", () => {
    for (const name of [
      "get_reading_team_carryover_offer",
      "carry_reading_teams_to_stage"
    ]) {
      expect(edge).toContain('"' + name + '"');
      expect(migration).toContain("FUNCTION public." + name);
    }
    expect(db).toContain("getReadingTeamCarryoverOffer(plan)");
    expect(db).toContain("carryReadingTeamsToStage(plan)");
  });

  // 0154: a member who quit the roster mid-season and independently joined a
  // different team in the next stage used to block the WHOLE carry-over for
  // every willing teammate (captain included) — a single RAISE EXCEPTION
  // rolled back the entire transaction. Real report: "隊長想保留隊伍進下一
  // 階段，但一位隊員退出了導致無法帶著其他隊員繼續進入". Fixed by skipping
  // just the conflicting member (or, if it's the captain themself, just that
  // one division's team) and reporting who was skipped instead of failing.
  it("skips a conflicting member instead of blocking the whole team (migration 0154)", () => {
    expect(migrationSkip).toContain("CREATE OR REPLACE FUNCTION public.carry_reading_teams_to_stage");
    expect(migrationSkip).not.toMatch(/RAISE EXCEPTION 'team_carryover_member_conflict'/);
    expect(migrationSkip).toContain("carried_from_team_id");
    expect(migrationSkip).toContain("pg_advisory_xact_lock");
    expect(migrationSkip).toMatch(/INSERT INTO public\.reading_team_members[\s\S]*FROM public\.reading_team_members source_member/);
    expect(migrationSkip).toMatch(/INSERT INTO public\.reading_plans[\s\S]*ON CONFLICT \(user_id, global_plan_id\)/);
    // Non-captain conflicts: excluded from the INSERT, reported per team.
    expect(migrationSkip).toContain("'skippedMembers'");
    expect(migrationSkip).toContain("GET DIAGNOSTICS carried_count = ROW_COUNT");
    // Captain conflicts: that one team is skipped, other divisions unaffected.
    expect(migrationSkip).toContain("captain_already_in_target");
    expect(migrationSkip).toContain("'skippedTeams'");
    expect(migrationSkip).toContain("CONTINUE;");
    // A captain with zero eligible source teams still gets the original error.
    expect(migrationSkip).toContain("team_carryover_captain_required");
    // Carries forward migration 0137's dynamic patch (cohort stages + region guard)
    // instead of silently reverting it with this CREATE OR REPLACE.
    expect(migrationSkip).toContain("public.is_campaign_stage_kind(plan_kind)");
    expect(migrationSkip).toContain("public.is_campaign_stage_kind(source_plan.plan_kind)");
    expect(migrationSkip).toContain("source_plan.audience_regions IS NOT DISTINCT FROM target_plan.audience_regions");
  });

  // The old flow was a single auto-fired confirm dialog (once per session,
  // silently suppressed forever if declined, no way to retry after a
  // failure). Replaced with a persistent button on the captain's own team
  // card so they can check and retry on their own terms.
  it("replaces the one-shot auto popup with a persistent captain-triggered button", () => {
    expect(plan).not.toContain("maybeOfferNextStageTeamCarryover");
    expect(plan).not.toContain("reading_team_carryover_deferred_");
    expect(plan).not.toContain("teamCarryoverCheckedSignature");

    expect(teamUi).toContain("async function renderCaptainCarryoverAction");
    expect(teamUi).toContain("void renderCaptainCarryoverAction(container, plan, team)");
    expect(teamUi).toContain("db.getReadingTeamCarryoverOffer(nextStagePlan)");
    expect(teamUi).toContain("db.carryReadingTeamsToStage(nextStagePlan)");
    expect(teamUi).toContain("carryTeamToStage");
    expect(teamUi).toContain("帶隊進入第");
    // Only offered when the offer RPC says this team's division is eligible.
    expect(teamUi).toContain("offerTeams.some(item => Number(item.division) === Number(team.division))");
    // Reports skipped individuals/teams from the new response shape, doesn't
    // just show a generic success/failure toast.
    expect(teamUi).toContain("skippedMembers");
    expect(teamUi).toContain("thisTeamSkipped");
  });

  it("uses the account logout icon for captain member removal controls", () => {
    const removeButtons = [...teamUi.matchAll(/<button[^>]+data-team-remove-user[\s\S]*?<\/button>/g)]
      .map(match => match[0]);
    expect(removeButtons).toHaveLength(2);
    removeButtons.forEach(button => {
      expect(button).toContain('data-icon="logout"');
      expect(button).not.toContain('data-icon="trash"');
    });
  });
});
