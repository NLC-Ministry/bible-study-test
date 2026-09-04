import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isRetiredPlanRequest } from "./retired-resources.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const READ_TABLES = new Set([
  "great_regions",
  "pastoral_zones",
  "small_groups",
  "global_plans",
  "church_announcements",
  "profiles",
  "reading_plans",
  "reading_logs",
  "devotional_notes",
  "devotional_likes",
  "devotional_comments",
  "verse_likes",
  "profile_identity_overview",
  "member_reading_summary",
  "view_pastoral_zone_stats",
  "view_small_group_stats",
  "care_reminders",
  "app_feature_settings",
  "role_definitions",
  "highlights",
  "reading_teams",
  "reading_team_members",
  "verse_notes"
]);
const USER_TABLES = new Set(["reading_plans", "reading_logs", "devotional_notes", "highlights"]);
const ADMIN_WRITE_TABLES = new Set(["great_regions", "pastoral_zones", "small_groups", "global_plans", "church_announcements", "profiles", "app_feature_settings"]);
const OWN_WRITE_TABLES = new Set(["reading_plans", "reading_logs", "devotional_notes", "devotional_likes", "devotional_comments", "care_reminders", "highlights", "verse_notes"]);
const TEAM_RPC_FUNCTIONS = new Set([
  "get_my_reading_team",
  "get_reading_team_registration_overview",
  "get_reading_team_statistics",
  "get_reading_team_leaderboards",
  "get_pastoral_zone_leaderboard",
  "get_personal_plan_ranking_summary",
  "create_reading_team",
  "join_reading_team_by_code",
  "get_reading_team_carryover_offer",
  "carry_reading_teams_to_stage",
  "leave_reading_team",
  "remove_reading_team_member",
  "disband_reading_team",
  "rename_reading_team",
  "transfer_reading_team_captain",
  "send_reading_team_reminder",
  "get_unjoined_plan_members",
  "get_joined_plan_members",
  "send_plan_join_invitation",
  "get_admin_member_team_placements"
]);
const PLAN_MANAGEMENT_RPC_FUNCTIONS = new Set([
  "get_reading_team_registration_overview",
  "get_unjoined_plan_members",
  "get_joined_plan_members",
  "send_plan_join_invitation",
  "get_admin_member_team_placements"
]);
const ADMIN_RPC_FUNCTIONS = new Set([
  "get_admin_registration_statistics",
  "set_profile_managed_scopes",
  "create_region_stage_cohort"
]);
const QUIZ_RPC_FUNCTIONS = new Set([
  "get_daily_quiz_dashboard",
  "request_daily_quiz_regeneration",
  "review_daily_quiz",
  "update_daily_quiz_questions",
  "publish_daily_quiz",
  "submit_daily_quiz",
  "get_quiz_notifications",
  "mark_quiz_notifications_read"
]);
// 速讀「大測驗」(migration 0096). Gated by the speed_reading_exam feature flag;
// authoring/grading RPCs additionally require an admin/pastor profile.
const EXAM_RPC_FUNCTIONS = new Set([
  "exam_upsert_paper",
  "exam_upsert_question",
  "exam_delete_question",
  "exam_get_paper_admin",
  "exam_save_announcement",
  "exam_publish_announcement",
  "exam_unpublish_announcement",
  "exam_publish",
  "exam_set_status",
  "exam_set_mode",
  "exam_push_to_live",
  "exam_reset_attempts",
  "exam_add_tester",
  "exam_remove_tester",
  "exam_get_paper_testers",
  "exam_set_auto_score",
  "exam_set_practice_enabled",
  "exam_recompute_scores",
  "exam_set_answer_key",
  "exam_publish_results",
  "exam_finalize_expired",
  "exam_start_practice",
  "exam_mark_practice_complete",
  "exam_get_practice_records",
  "exam_get_practice_detail",
  "exam_home_banner",
  "exam_home_exams",
  "exam_my_papers",
  "exam_get_for_attempt",
  "exam_start_attempt",
  "exam_save_progress",
  "exam_submit_attempt",
  "exam_backfill_shortanswer",
  "exam_get_my_result",
  "exam_get_grading_queue",
  "exam_grade_answer",
  "exam_grade_answers_batch",
  "exam_get_stats",
  "exam_export_answers",
  // 線上簡答批改頁（grade.html，migration 0146）。指派兩支要 admin；
  // 批改五支的閘門是「這個 attempt/paper 指派給我」，在 SQL 端做，不需 admin 角色。
  "exam_list_gradable_attempts",
  "exam_search_grader_candidates",
  "exam_assign_attempts",
  "exam_get_grading_workspace",
  "exam_get_grading_sheet",
  "exam_save_grading_draft",
  "exam_grade_attempt",
  "exam_grade_attempts_bulk",
  "exam_reset_attempt_grading",
  "get_exam_notifications",
  "mark_exam_notifications_read"
]);
const EXAM_ADMIN_RPC_FUNCTIONS = new Set([
  "exam_upsert_paper",
  "exam_upsert_question",
  "exam_delete_question",
  "exam_get_paper_admin",
  "exam_save_announcement",
  "exam_publish_announcement",
  "exam_unpublish_announcement",
  "exam_publish",
  "exam_set_status",
  "exam_set_mode",
  "exam_push_to_live",
  "exam_reset_attempts",
  "exam_add_tester",
  "exam_remove_tester",
  "exam_get_paper_testers",
  "exam_set_auto_score",
  "exam_set_practice_enabled",
  "exam_recompute_scores",
  "exam_set_answer_key",
  "exam_publish_results",
  "exam_finalize_expired",
  "exam_get_grading_queue",
  "exam_grade_answer",
  "exam_grade_answers_batch",
  // 線上簡答批改：指派清單／搜尋批改人員／指派動作要 admin/pastor（0146）
  "exam_list_gradable_attempts",
  "exam_search_grader_candidates",
  "exam_assign_attempts"
  // exam_get_stats 不在此：它自己做角色 + 委派範圍檢查（migration 0121），
  // 開放給 great_zone_leader / zone_leader / group_leader 看自己範圍的統計。
  // exam_get_grading_workspace / _sheet / _save_grading_draft / _grade_attempt /
  // _grade_attempts_bulk 也不在此：閘門是「指派給我」，批改人員不必是 admin。
]);
const PROFILE_SELECT = "id, name, email, avatar_url, great_region, pastoral_zone, small_group, role_id, is_demo, is_active, name_review_approved, managed_regions, managed_zones, managed_groups, member_context_synced_at, member_context_sync_attempted_at, member_context_sync_status, member_context_sync_error, member_context_contract_version, member_context_membership_lifecycle_state, member_context_placement_state, member_context_placement_workflow_state, member_context_has_required_placement, member_context_required_action, member_context_required_action_url, member_context_leadership_display_label, member_context_leadership_primary_assignment_id, member_context_leadership_assignments, role_definition:role_definitions(id, code, label, sort_order, is_assignable, can_manage_plans, can_manage_permissions, scope_type)";
// Same as PROFILE_SELECT minus name_review_approved (migration 0069) — used
// as a retry target wherever a query against PROFILE_SELECT fails, so a
// database that hasn't been migrated yet degrades instead of hard-failing.
const PROFILE_SELECT_LEGACY = "id, name, email, avatar_url, great_region, pastoral_zone, small_group, role_id, is_demo, is_active, managed_regions, managed_zones, managed_groups, member_context_synced_at, member_context_sync_attempted_at, member_context_sync_status, member_context_sync_error, member_context_leadership_display_label, member_context_leadership_primary_assignment_id, member_context_leadership_assignments, role_definition:role_definitions(id, code, label, sort_order, is_assignable, can_manage_plans, can_manage_permissions, scope_type)";
// 每日靈修（devotional plan，migration 0145）。write 的 RPC 自己在 SQL 端用
// _devotion_actor_can_manage() 檢查 admin/pastor；get_devotional_plan 自己檢查
// daily_devotion flag（管理者放行）。這裡只需注入 p_actor_id。
const DEVOTION_RPC_FUNCTIONS = new Set([
  "get_devotional_plan",
  "list_devotion_days",
  "upsert_devotion_day",
  "delete_devotion_day",
  "bulk_upsert_devotion_days",
  "set_devotional_plan_future_open"
]);
// 小組聚會週計畫（group_meeting plan，migration 0148）。write RPC 自己在 SQL 端
// 用 _group_meeting_actor_can_manage() 檢查 admin/pastor；get_group_meeting_plan
// 自己檢查 group_meeting_plan flag（管理者放行）。這裡只需注入 p_actor_id。
const GROUP_MEETING_RPC_FUNCTIONS = new Set([
  "get_group_meeting_plan",
  "list_group_meeting_weeks",
  "upsert_group_meeting_week",
  "delete_group_meeting_week",
  "bulk_upsert_group_meeting_weeks",
  "set_group_meeting_plan_future_open"
]);
// 每日靈修／小組聚會週計畫的「功能設定」總開關 + 每人一份的個人偏好
// （migration 0156）。get_/set_my_* 一律只操作呼叫者自己那筆，不接受目標使用者
// 參數；set_devotion_group_features_master 自己在 SQL 端檢查 admin 角色。這裡
// 只需注入 p_actor_id。
const DEVOTION_GROUP_FEATURE_RPC_FUNCTIONS = new Set([
  "get_my_devotion_group_preferences",
  "set_my_devotion_group_preference",
  "set_devotion_group_features_master"
]);
// 回報對話串（issue_reports 工單 + issue_report_messages，migration 0153）。
// 每支 RPC 自己在 SQL 端用 _issue_actor()/_issue_is_admin() 做「本人或 admin」授權；
// 這裡只需注入 p_actor_id。碰 Storage 的（附件上傳/簽名網址/刪物件）不是 RPC，
// 走下面的 issue_thread_get / issue_thread_post / issue_thread_attachment_delete action。
const ISSUE_RPC_FUNCTIONS = new Set([
  "issue_thread_mark_read",
  "issue_thread_unread_summary",
  "issue_my_reports",
  "issue_admin_thread_list",
  "issue_admin_set_status"
]);
const ISSUE_ADMIN_RPC_FUNCTIONS = new Set([
  "issue_admin_thread_list",
  "issue_admin_set_status"
]);
const RPC_FUNCTIONS = new Set([
  "increment_likes",
  "decrement_likes",
  "publish_global_plan_rules",
  "get_user_rankings",
  ...TEAM_RPC_FUNCTIONS,
  ...ADMIN_RPC_FUNCTIONS,
  ...QUIZ_RPC_FUNCTIONS,
  ...EXAM_RPC_FUNCTIONS,
  ...DEVOTION_RPC_FUNCTIONS,
  ...GROUP_MEETING_RPC_FUNCTIONS,
  ...DEVOTION_GROUP_FEATURE_RPC_FUNCTIONS,
  ...ISSUE_RPC_FUNCTIONS
]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

function parseJwt(token: string) {
  try {
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((char) => "%" + ("00" + char.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

const PROFILE_CACHE = new Map<string, { profile: any; timestamp: number }>();
const PROFILE_CACHE_TTL_MS = 15000; // 15 seconds warm Edge Function memory cache

async function fetchProfileData(supabaseAdmin: any, userId: string) {
  try {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select(PROFILE_SELECT)
      .or(`id.eq.${userId},auth_user_id.eq.${userId}`)
      .maybeSingle();
    if (!profileError && profile) return profile;
  } catch (err) {
    console.warn("PROFILE_SELECT join failed; falling back to direct profiles query:", err);
  }

  try {
    const { data: basicProfile, error: basicError } = await supabaseAdmin
      .from("profiles")
      .select("id, name, email, avatar_url, great_region, pastoral_zone, small_group, role_id, is_demo, is_active, name_review_approved, managed_regions, managed_zones, managed_groups, member_context_synced_at, member_context_sync_attempted_at, member_context_sync_status, member_context_sync_error, member_context_leadership_display_label, member_context_leadership_primary_assignment_id, member_context_leadership_assignments")
      .or(`id.eq.${userId},auth_user_id.eq.${userId}`)
      .maybeSingle();
    if (!basicError) return basicProfile;
  } catch (err) {
    console.warn("Fallback profile query with name_review_approved failed; retrying without it (migration 0069 not yet applied?):", err);
  }

  // Profile resolution runs on every request — never let one optional
  // column (added by migration 0069, which may not be deployed to this
  // database yet) take down auth for the whole app. Callers that actually
  // need name_review_approved already degrade to `false` when it's absent
  // (see fetchAdminUserProfiles).
  const { data: legacyProfile, error: legacyError } = await supabaseAdmin
    .from("profiles")
    .select(PROFILE_SELECT_LEGACY)
    .or(`id.eq.${userId},auth_user_id.eq.${userId}`)
    .maybeSingle();
  if (legacyError) throw legacyError;
  return legacyProfile ? { ...legacyProfile, name_review_approved: false } : legacyProfile;
}

async function resolveProfile(supabaseAdmin: any, accessToken: string) {
  const cached = PROFILE_CACHE.get(accessToken);
  const now = Date.now();
  if (cached && (now - cached.timestamp < PROFILE_CACHE_TTL_MS)) {
    return cached.profile;
  }

  const payload = parseJwt(accessToken);
  const expectedLogtoIssuer = trimSlash(Deno.env.get("NLC_LOGTO_ISSUER") || "https://sso.newlife.org.tw/oidc");
  const tokenIssuer = trimSlash(String(payload?.iss || ""));
  const isLogtoJwt = Boolean(payload?.sub && tokenIssuer === expectedLogtoIssuer);

  // Logto is the production login method. Do not send its JWT to Supabase Auth
  // first: that request must fail before fallback and adds one remote round trip
  // to every nlc-data call. Non-Logto tokens still use Supabase verification.
  if (!isLogtoJwt) {
    try {
      const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(accessToken);
      if (user && !authErr) {
        const profile = await fetchProfileData(supabaseAdmin, user.id);
        if (profile) {
          PROFILE_CACHE.set(accessToken, { profile, timestamp: Date.now() });
          return profile;
        }
      }
    } catch (err) {
      console.log("Supabase JWT verification failed; checking Logto OIDC:", err);
    }
  }

  let sub: string | null = isLogtoJwt ? String(payload.sub) : null;
  if (!sub) {
    // Opaque Logto tokens cannot be decoded locally; resolve them through the
    // configured OIDC UserInfo endpoint.
    try {
      const discovery = await fetchJson(`${expectedLogtoIssuer}/.well-known/openid-configuration`);
      const userinfo = await fetchJson(discovery.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
      });
      sub = userinfo?.sub || null;
    } catch (err) {
      console.error("Failed to resolve profile from OIDC UserInfo fallback:", err);
    }
  }

  if (!sub) throw new Error("invalid_logto_token");

  const { data: identity, error: identityError } = await supabaseAdmin
    .from("user_identities")
    .select("profile_id")
    .eq("provider", "logto")
    .eq("provider_user_id", sub)
    .maybeSingle();
  if (identityError) throw identityError;
  if (!identity?.profile_id) throw new Error("profile_identity_not_found");

  const profile = await fetchProfileData(supabaseAdmin, identity.profile_id);
  PROFILE_CACHE.set(accessToken, { profile, timestamp: Date.now() });
  return profile;
}


async function isFeatureEnabled(supabaseAdmin: any, key: string) {
  const { data, error } = await supabaseAdmin
    .from("app_feature_settings")
    .select("enabled")
    .eq("key", key)
    .maybeSingle();
  if (error) return false;
  return data?.enabled === true;
}
const ROLE_CODE_MAP: Record<string, string> = {
  "10000000-0000-4000-8000-000000000001": "member",
  "10000000-0000-4000-8000-000000000002": "group_leader",
  "10000000-0000-4000-8000-000000000003": "zone_leader",
  "10000000-0000-4000-8000-000000000004": "great_zone_leader",
  "10000000-0000-4000-8000-000000000005": "pastor",
  "10000000-0000-4000-8000-000000000006": "admin"
};

function getProfileRoleCode(profile: any) {
  const leadershipLabel = String(profile?.member_context_leadership_display_label || "").trim();
  if (leadershipLabel === "組織架構管理員" || leadershipLabel.includes("系統管理員") || leadershipLabel.includes("組織架構管理員")) {
    return "admin";
  }
  if (leadershipLabel === "教會牧者" || leadershipLabel.includes("主任牧師") || leadershipLabel.includes("教會牧者") || leadershipLabel.includes("牧者")) {
    return "pastor";
  }
  if (leadershipLabel === "大區長" || leadershipLabel.includes("大區同工")) {
    return "great_zone_leader";
  }
  if (leadershipLabel === "區長" || leadershipLabel.includes("牧區長") || leadershipLabel.includes("區同工")) {
    return "zone_leader";
  }
  if (leadershipLabel === "小組長" || leadershipLabel.includes("副小組長") || leadershipLabel.includes("小組同工")) {
    return "group_leader";
  }

  const roleId = String(profile?.role_id || "").toLowerCase();
  return profile?.role_definition?.code
    || (roleId ? ROLE_CODE_MAP[roleId] : null)
    || profile?.role
    || "member";
}

function isAdmin(profile: any) {
  return getProfileRoleCode(profile) === "admin";
}

function hasWholeChurchPlanScope(profile: any) {
  return ["admin", "pastor"].includes(getProfileRoleCode(profile));
}

function canManagePlans(profile: any) {
  return ["admin", "pastor", "great_zone_leader", "zone_leader", "group_leader"].includes(getProfileRoleCode(profile));
}

function normalizeRows(payload: any) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

function forceUserPayload(table: string, payload: any, profileId: string, action?: string) {
  if (table === "profiles") {
    const rows = normalizeRows(payload).map(row => {
      const copy = { ...row };
      if (action === "update") {
        delete copy.id;
      } else {
        copy.id = copy.id || profileId;
      }
      return copy;
    });
    return Array.isArray(payload) ? rows : rows[0];
  }
  // issue_reports is included so a member's report is always attributed to the
  // authenticated caller (server-authoritative user_id), never a client-supplied one.
  const writeProtected = ["reading_plans", "reading_logs", "devotional_notes", "devotional_likes", "devotional_comments", "issue_reports", "highlights", "verse_notes"];
  if (writeProtected.includes(table)) {
    const rows = normalizeRows(payload).map(row => {
      const copy = { ...row };
      if (action === "update") {
        delete copy.user_id;
      } else {
        copy.user_id = profileId;
      }
      return copy;
    });
    return Array.isArray(payload) ? rows : rows[0];
  }
  return payload;
}

function applyFilters(query: any, filters: any[] = []) {
  for (const filter of filters) {
    if (!filter || !filter.type || !filter.column) continue;
    if (filter.type === "eq") query = query.eq(filter.column, filter.value);
    else if (filter.type === "is") query = query.is(filter.column, filter.value);
    else if (filter.type === "in") query = query.in(filter.column, filter.value || []);
  }
  return query;
}

function valuesOverlap(left: unknown, right: unknown) {
  const leftValues = String(left || "").split(",").map(value => value.trim()).filter(Boolean);
  const rightValues = String(right || "").split(",").map(value => value.trim()).filter(Boolean);
  return leftValues.some(value => rightValues.includes(value));
}

async function getVisibleProfileIds(supabaseAdmin: any, profile: any) {
  if (hasWholeChurchPlanScope(profile)) return null;
  const splitScope = (value: unknown) => String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  const roleCode = getProfileRoleCode(profile);
  let query = supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("is_demo", false)
    .eq("is_active", true);

  if (roleCode === "great_zone_leader") {
    const regions = splitScope(profile.managed_regions || profile.great_region);
    if (!regions.length) return [profile.id];
    query = query.in("great_region", regions);
  } else if (roleCode === "zone_leader") {
    const zones = splitScope(profile.managed_zones || profile.pastoral_zone);
    if (!zones.length) return [profile.id];
    query = query.in("pastoral_zone", zones);
  } else if (roleCode === "group_leader") {
    const groups = splitScope(profile.managed_groups || profile.small_group);
    if (!groups.length) return [profile.id];
    query = query.in("small_group", groups);
  } else {
    return [profile.id];
  }

  const { data: profiles, error } = await query;
  if (error) throw error;
  return Array.from(new Set([profile.id, ...(profiles || []).map((candidate: any) => candidate.id)]));
}

async function applyForcedScope(query: any, table: string, action: string, profile: any, supabaseAdmin: any) {
  // Supabase query builders are PromiseLike. Returning one directly from this
  // async function would execute the query before order/limit/returning are
  // applied. Always wrap it in a plain object to prevent Promise assimilation.
  if (action === "insert" || action === "upsert") return { query };
  if (USER_TABLES.has(table)) {
    if (action !== "select") return { query: query.eq("user_id", profile.id) };
    const visibleIds = await getVisibleProfileIds(supabaseAdmin, profile);
    return {
      query: visibleIds === null
        ? query
        : query.in("user_id", visibleIds.length ? visibleIds : [profile.id])
    };
  }
  if (table === "profiles" && !hasWholeChurchPlanScope(profile)) {
    const visibleIds = await getVisibleProfileIds(supabaseAdmin, profile);
    return { query: query.in("id", visibleIds && visibleIds.length ? visibleIds : [profile.id]) };
  }
  if (table === "user_identities") return { query: query.eq("profile_id", profile.id) };
  // reading_teams / reading_team_members have no org-scope columns by design
  // (migration 0019) and rely on RLS ("see a team only after joining it, or
  // as admin") — but nlc-data runs on the service-role key, which bypasses
  // RLS entirely. Reproduce the same boundary here: a plain member may only
  // read teams they belong to; management roles keep full read access for
  // the admin team-registration overview / member-placement fallbacks in
  // js/db.js, which intentionally scan every team.
  if ((table === "reading_teams" || table === "reading_team_members") && action === "select" && !canManagePlans(profile)) {
    const { data: memberships, error: membershipError } = await supabaseAdmin
      .from("reading_team_members")
      .select("team_id")
      .eq("user_id", profile.id);
    if (membershipError) throw membershipError;
    const teamIds = (memberships || []).map((row: any) => row.team_id).filter(Boolean);
    const idColumn = table === "reading_teams" ? "id" : "team_id";
    return { query: query.in(idColumn, teamIds.length ? teamIds : ["00000000-0000-0000-0000-000000000000"]) };
  }
  if (table === "global_plans" && action === "select" && !canManagePlans(profile)) return { query: query.or("is_hidden.eq.false,plan_kind.eq.church_campaign_stage") };
  if (table === "church_announcements" && action === "select" && !isAdmin(profile)) return { query: query.eq("is_published", true) };
  if (table === "care_reminders" && action === "select") return { query: query.eq("recipient_id", profile.id) };
  if (table === "care_reminders" && action === "update") return { query: query.eq("recipient_id", profile.id) };
  // verse_notes are private reflections, never shared with pastors/admins the
  // way reading_logs/devotional_notes are — always restrict to the caller's
  // own rows regardless of role, on every action (not just select).
  if (table === "verse_notes") return { query: query.eq("user_id", profile.id) };
  return { query };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "*";
  const localCorsHeaders = {
    ...corsHeaders,
    "Access-Control-Allow-Origin": origin
  };

  const requestStartedAt = performance.now();
  const jsonResponse = (body: unknown, status = 200) => {
    const serialized = JSON.stringify(body);
    return new Response(serialized, {
      status,
      headers: {
        ...localCorsHeaders,
        "Content-Length": String(new TextEncoder().encode(serialized).byteLength),
        "Server-Timing": `edge;dur=${(performance.now() - requestStartedAt).toFixed(1)}`,
        "Access-Control-Expose-Headers": "Content-Length, Server-Timing"
      }
    });
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: localCorsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "server_not_configured" }, 500);

    const authHeader = req.headers.get("Authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!accessToken) return jsonResponse({ error: "missing_authorization" }, 401);

    const body = await req.json().catch(() => ({}));
    const table = body.table;
    const action = body.action || "select";
    if (!["save_profile", "rpc", "send_care_reminder", "mark_issue_report_reply_seen", "sync_registration_stats_sheet", "issue_thread_get", "issue_thread_post", "issue_thread_attachment_delete"].includes(action) && (!table || typeof table !== "string")) {
      return jsonResponse({ error: "missing_table" }, 400);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const profile = await resolveProfile(supabaseAdmin, accessToken);

    if (isRetiredPlanRequest(body)) {
      return jsonResponse({ error: "resource_not_found", resource: "reading_plan" }, 404);
    }

    if (action === "rpc") {
      const functionName = typeof body.function === "string" ? body.function : "";
      if (!RPC_FUNCTIONS.has(functionName)) return jsonResponse({ error: "forbidden_rpc" }, 403);
      if (functionName === "publish_global_plan_rules" && !isAdmin(profile)) {
        return jsonResponse({ error: "forbidden_rpc" }, 403);
      }
      if (PLAN_MANAGEMENT_RPC_FUNCTIONS.has(functionName) && !canManagePlans(profile)) {
        return jsonResponse({ error: "forbidden_rpc" }, 403);
      }
      if (ADMIN_RPC_FUNCTIONS.has(functionName) && !isAdmin(profile)) {
        return jsonResponse({ error: "forbidden_rpc" }, 403);
      }
      if (ISSUE_ADMIN_RPC_FUNCTIONS.has(functionName) && !isAdmin(profile)) {
        return jsonResponse({ error: "forbidden_rpc" }, 403);
      }
      if (QUIZ_RPC_FUNCTIONS.has(functionName)) {
        const { data: quizFeature, error: quizFeatureError } = await supabaseAdmin
          .from("app_feature_settings")
          .select("enabled")
          .eq("key", "daily_quiz")
          .maybeSingle();
        if (quizFeatureError || quizFeature?.enabled !== true) {
          return jsonResponse({ error: "daily_quiz_feature_disabled" }, 403);
        }
      }
      if (EXAM_RPC_FUNCTIONS.has(functionName)) {
        if (EXAM_ADMIN_RPC_FUNCTIONS.has(functionName) && !isAdmin(profile)) {
          return jsonResponse({ error: "forbidden_rpc" }, 403);
        }
        const { data: examFeature, error: examFeatureError } = await supabaseAdmin
          .from("app_feature_settings")
          .select("enabled")
          .eq("key", "speed_reading_exam")
          .maybeSingle();
        if (examFeatureError || examFeature?.enabled !== true) {
          return jsonResponse({ error: "speed_reading_exam_feature_disabled" }, 403);
        }
      }
      const rpcName = functionName;
      // get_admin_member_team_placements(p_global_plan_id, p_actor_id) calls
      // resolve_reading_team_actor(p_actor_id) just like every other
      // TEAM_RPC_FUNCTIONS entry (migration 0064) — it must get p_actor_id
      // injected too, or resolve_reading_team_actor falls back to
      // current_profile_id() (NULL under the service-role key nlc-data
      // runs on) and raises "profile_required".
      const rpcArgs = (functionName === "publish_global_plan_rules"
        || TEAM_RPC_FUNCTIONS.has(functionName)
        || QUIZ_RPC_FUNCTIONS.has(functionName)
        || EXAM_RPC_FUNCTIONS.has(functionName)
        || DEVOTION_RPC_FUNCTIONS.has(functionName)
        || GROUP_MEETING_RPC_FUNCTIONS.has(functionName)
        || DEVOTION_GROUP_FEATURE_RPC_FUNCTIONS.has(functionName)
        || ISSUE_RPC_FUNCTIONS.has(functionName)
        || functionName === "get_admin_registration_statistics"
        || functionName === "create_region_stage_cohort")
        ? { ...(body.args || {}), p_actor_id: profile.id }
        : (body.args || {});
      const { data, error } = await supabaseAdmin.rpc(rpcName, rpcArgs);
      if (error) return jsonResponse({ error: error.message, code: error.code }, 400);
      return jsonResponse({ data });
    }

    // ── send_care_reminder: server-side forced sender_id ──
    if (action === "send_care_reminder") {
      const p = body.payload || {};
      const validReasons = ["behind", "inactive", "care", "encouragement"];
      if (!p.recipient_id) return jsonResponse({ error: "missing_recipient_id" }, 400);
      if (!validReasons.includes(p.reason)) return jsonResponse({ error: "invalid_reason" }, 400);
      const msg = String(p.message || "").trim();
      if (!msg || msg.length > 300) return jsonResponse({ error: "invalid_message" }, 400);
      const pastoralRoles = ["admin", "pastor", "great_zone_leader", "zone_leader", "group_leader"];
      if (!pastoralRoles.includes(getProfileRoleCode(profile)) || profile.id === p.recipient_id) {
        return jsonResponse({ error: "pastoral_reminder_scope_required" }, 403);
      }
      const { data: recipient, error: recipientError } = await supabaseAdmin
        .from("profiles")
        .select("id, is_active, great_region, pastoral_zone, small_group")
        .eq("id", p.recipient_id)
        .maybeSingle();
      if (recipientError) return jsonResponse({ error: recipientError.message }, 400);
      if (!recipient || recipient.is_active === false) return jsonResponse({ error: "recipient_not_found" }, 404);

      const withinScope = hasWholeChurchPlanScope(profile)
        || (getProfileRoleCode(profile) === "great_zone_leader" && valuesOverlap(recipient.great_region, profile.managed_regions || profile.great_region))
        || (getProfileRoleCode(profile) === "zone_leader" && valuesOverlap(recipient.pastoral_zone, profile.managed_zones || profile.pastoral_zone))
        || (getProfileRoleCode(profile) === "group_leader"
          && valuesOverlap(recipient.pastoral_zone, profile.pastoral_zone)
          && valuesOverlap(recipient.small_group, profile.small_group));
      if (!withinScope) return jsonResponse({ error: "pastoral_reminder_scope_required" }, 403);

      const sentOn = new Date().toISOString().slice(0, 10);
      const planKey = String(p.plan_key || "");

      // A sender can only send one reminder per recipient per plan per day
      // (care_reminders_daily_unique). Re-sending the same day used to just
      // hit that unique-constraint error with no way to see or fix what was
      // already sent. Instead: if today's reminder to this person is still
      // unread, treat this as an edit (update it in place); if it's already
      // been read/dismissed, tell the caller plainly rather than surfacing a
      // raw constraint violation.
      const { data: existing, error: existingError } = await supabaseAdmin
        .from("care_reminders")
        .select("id, status")
        .eq("sender_id", profile.id)
        .eq("recipient_id", p.recipient_id)
        .eq("plan_key", planKey)
        .eq("sent_on", sentOn)
        .maybeSingle();
      if (existingError) return jsonResponse({ error: existingError.message, code: existingError.code }, 400);

      if (existing) {
        if (existing.status !== "unread") {
          return jsonResponse({ error: "care_reminder_already_seen" }, 409);
        }
        const { data: updated, error: updateError } = await supabaseAdmin
          .from("care_reminders")
          .update({ reason: p.reason, message: msg })
          .eq("id", existing.id)
          .select("id, reason, message, status, sent_on")
          .single();
        if (updateError) return jsonResponse({ error: updateError.message, code: updateError.code }, 400);
        return jsonResponse({ data: { ...updated, edited: true } });
      }

      const { data: inserted, error } = await supabaseAdmin
        .from("care_reminders")
        .insert({
          sender_id: profile.id,           // always the authenticated caller
          recipient_id: p.recipient_id,
          plan_key: planKey,
          reason: p.reason,
          message: msg,
          status: "unread",
          sent_on: sentOn
        })
        .select("id, reason, message, status, sent_on")
        .single();
      if (error) return jsonResponse({ error: error.message, code: error.code }, 400);
      return jsonResponse({ data: { ...inserted, edited: false } });
    }

    // ── mark_issue_report_reply_seen: the reporting member clears their own
    // unread-reply badge. Deliberately its own isolated action rather than a
    // generic issue_reports UPDATE grant — the server computes the new
    // metadata itself (existing metadata + reply_seen_at only) instead of
    // trusting whatever metadata the client sends, so a member can never use
    // this path to alter status/category/description or forge/edit the
    // admin's reply text on their own report.
    if (action === "mark_issue_report_reply_seen") {
      const reportId = String(body.report_id || "");
      if (!reportId) return jsonResponse({ error: "missing_report_id" }, 400);
      const { data: report, error: fetchError } = await supabaseAdmin
        .from("issue_reports")
        .select("id, user_id, metadata")
        .eq("id", reportId)
        .maybeSingle();
      if (fetchError) return jsonResponse({ error: fetchError.message }, 400);
      if (!report || report.user_id !== profile.id) return jsonResponse({ error: "forbidden" }, 403);

      const existingMetadata = (report.metadata && typeof report.metadata === "object") ? report.metadata : {};
      if (!existingMetadata.reply || existingMetadata.reply_seen_at) {
        // Nothing to mark (no reply yet, or already seen) — succeed idempotently.
        return jsonResponse({ data: report });
      }

      const { data: updated, error: updateError } = await supabaseAdmin
        .from("issue_reports")
        .update({ metadata: { ...existingMetadata, reply_seen_at: new Date().toISOString() } })
        .eq("id", reportId)
        .eq("user_id", profile.id)
        .select("id, metadata")
        .single();
      if (updateError) return jsonResponse({ error: updateError.message }, 400);
      return jsonResponse({ data: updated });
    }

    // ── 回報對話串：碰 Storage 的三個 action（SQL RPC 動不到 Storage）──────────
    // 授權一律在 SQL 端（_issue_actor / _issue_is_admin：本人或 admin）。
    const ISSUE_SHOTS_BUCKET = "issue-report-shots";
    const issueShotExt = (mime: string) =>
      mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp";
    const issueDecodeBase64 = (b64: string) => {
      const clean = String(b64 || "").replace(/^data:[^,]*,/, "");
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };

    if (action === "issue_thread_get") {
      const reportId = String(body.report_id || "");
      if (!reportId) return jsonResponse({ error: "missing_report_id" }, 400);
      const { data, error } = await supabaseAdmin.rpc("issue_thread_get", {
        p_report_id: reportId,
        p_actor_id: profile.id,
        p_mark_read: body.mark_read !== false
      });
      if (error) return jsonResponse({ error: error.message, code: error.code }, 400);
      const thread = data || {};
      const messages: any[] = Array.isArray(thread.messages) ? thread.messages : [];
      const paths = messages
        .map((m) => m?.attachmentPath)
        .filter((p): p is string => typeof p === "string" && p.length > 0 && p !== "pending");
      if (paths.length) {
        const { data: signed } = await supabaseAdmin.storage
          .from(ISSUE_SHOTS_BUCKET)
          .createSignedUrls(paths, 300);
        const urlByPath = new Map<string, string>();
        (signed || []).forEach((s: any) => {
          if (s && !s.error && s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
        });
        for (const m of messages) {
          if (m?.attachmentPath && urlByPath.has(m.attachmentPath)) {
            m.attachmentUrl = urlByPath.get(m.attachmentPath);
          }
        }
      }
      return jsonResponse({ data: thread });
    }

    if (action === "issue_thread_post") {
      const reportId = String(body.report_id || "");
      if (!reportId) return jsonResponse({ error: "missing_report_id" }, 400);
      const image = body.image && typeof body.image === "object" ? body.image : null;
      const imgMime = image ? String(image.mime || "") : "";
      if (image && !["image/webp", "image/jpeg", "image/png"].includes(imgMime)) {
        return jsonResponse({ error: "bad_mime" }, 400);
      }
      let imgBytes: Uint8Array | null = null;
      if (image) {
        try {
          imgBytes = issueDecodeBase64(image.base64);
        } catch (_e) {
          return jsonResponse({ error: "bad_image" }, 400);
        }
        if (!imgBytes.length || imgBytes.length > 512000) {
          return jsonResponse({ error: "too_large" }, 400);
        }
      }

      const { data: posted, error: postErr } = await supabaseAdmin.rpc("issue_thread_post", {
        p_report_id: reportId,
        p_body: typeof body.body === "string" ? body.body : "",
        p_is_internal: body.is_internal === true,
        p_has_attachment: !!image,
        p_actor_id: profile.id
      });
      if (postErr) return jsonResponse({ error: postErr.message, code: postErr.code }, 400);
      const messageId = posted?.id;

      if (image && imgBytes && messageId) {
        const path = `${reportId}/${messageId}.${issueShotExt(imgMime)}`;
        const up = await supabaseAdmin.storage
          .from(ISSUE_SHOTS_BUCKET)
          .upload(path, imgBytes, { contentType: imgMime, upsert: true });
        if (up.error) {
          await supabaseAdmin.rpc("issue_thread_drop_attachment", {
            p_message_id: messageId, p_actor_id: profile.id
          });
          return jsonResponse({ error: "upload_failed" }, 500);
        }
        const { error: setErr } = await supabaseAdmin.rpc("issue_thread_set_attachment", {
          p_message_id: messageId, p_path: path, p_mime: imgMime,
          p_bytes: imgBytes.length,
          p_w: Number(image.w) || null, p_h: Number(image.h) || null,
          p_actor_id: profile.id
        });
        if (setErr) {
          await supabaseAdmin.storage.from(ISSUE_SHOTS_BUCKET).remove([path]);
          await supabaseAdmin.rpc("issue_thread_drop_attachment", {
            p_message_id: messageId, p_actor_id: profile.id
          });
          return jsonResponse({ error: setErr.message }, 400);
        }
      }
      return jsonResponse({ data: { id: messageId, reportId } });
    }

    if (action === "issue_thread_attachment_delete") {
      const messageId = String(body.message_id || "");
      if (!messageId) return jsonResponse({ error: "missing_message_id" }, 400);
      const { data, error } = await supabaseAdmin.rpc("issue_thread_drop_attachment", {
        p_message_id: messageId, p_actor_id: profile.id
      });
      if (error) return jsonResponse({ error: error.message, code: error.code }, 400);
      const oldPath = data?.oldPath;
      if (typeof oldPath === "string" && oldPath && oldPath !== "pending") {
        await supabaseAdmin.storage.from(ISSUE_SHOTS_BUCKET).remove([oldPath]);
      }
      return jsonResponse({ data: { ok: true } });
    }

    if (action === "save_profile") {
      const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
      const { data: hubIdentity, error: hubIdentityError } = await supabaseAdmin
        .from("user_identities")
        .select("profile_id")
        .eq("profile_id", profile.id)
        .eq("provider", "logto")
        .maybeSingle();
      if (hubIdentityError) return jsonResponse({ error: hubIdentityError.message }, 400);

      // Logto-linked names are owned by Member Hub. Ignore cached names sent by
      // old browser tabs. nlc-session is the only writer of the canonical name.
      if (hubIdentity) {
        return jsonResponse({
          data: profile,
          profile,
          project_url: supabaseUrl,
          profile_id: profile.id,
          canonical_source: "member_hub"
        });
      }

      const nextName = payload.name ?? profile.name ?? "";
      const nameChanged = String(nextName) !== String(profile.name ?? "");
      const updatePayload: Record<string, unknown> = {
        name: nextName,
        updated_at: new Date().toISOString()
      };
      // save_profile is the only path a non-admin can use to change their own
      // name. A fresh self-edit must go back through admin review rather than
      // silently keeping a stale approval from a previously flagged name.
      if (nameChanged) updatePayload.name_review_approved = false;

      let savedProfile: any = null;
      let saveError: any = null;
      ({ data: savedProfile, error: saveError } = await supabaseAdmin
        .from("profiles")
        .update(updatePayload)
        .eq("id", profile.id)
        .select(PROFILE_SELECT)
        .single());

      if (saveError && nameChanged) {
        // The name_review_approved column (migration 0069) may not be
        // deployed to this database yet — retry without it rather than
        // blocking every member from saving their own name.
        console.warn("save_profile with name_review_approved failed; retrying without it (migration 0069 not yet applied?):", saveError);
        delete updatePayload.name_review_approved;
        ({ data: savedProfile, error: saveError } = await supabaseAdmin
          .from("profiles")
          .update(updatePayload)
          .eq("id", profile.id)
          .select(PROFILE_SELECT_LEGACY)
          .single());
      }

      if (saveError) return jsonResponse({ error: saveError.message, code: saveError.code }, 400);
      if (!savedProfile) return jsonResponse({ error: "profile_write_not_verified" }, 500);

      if (String((savedProfile as any).name || "") !== String(updatePayload.name || "")) {
        return jsonResponse({
          error: "profile_write_mismatch",
          mismatches: ["name"],
          expected: updatePayload,
          actual: savedProfile,
          project_url: supabaseUrl,
          profile_id: profile.id
        }, 500);
      }

      return jsonResponse({ data: savedProfile, profile: savedProfile, project_url: supabaseUrl, profile_id: profile.id });
    }

    // ── sync_registration_stats_sheet: admin-only, forwards a formatted
    // snapshot of 報名與註冊統計 to a Google Apps Script Web App bound to the
    // church's shared "速讀報名統計" spreadsheet. The client builds the rows
    // (it already has the zone-leader-name lookup used by the org-permissions
    // panel); this function only re-validates shape/admin access and adds the
    // shared secret before forwarding — the Apps Script side never sees a
    // Supabase/Logto token, just this one shared secret.
    if (action === "sync_registration_stats_sheet") {
      if (!isAdmin(profile)) return jsonResponse({ error: "forbidden" }, 403);

      const sheetUrl = Deno.env.get("REGISTRATION_STATS_SHEET_WEBHOOK_URL");
      const sheetSecret = Deno.env.get("REGISTRATION_STATS_SHEET_WEBHOOK_SECRET");
      if (!sheetUrl || !sheetSecret) {
        return jsonResponse({ error: "server_not_configured" }, 500);
      }

      const p = body.payload && typeof body.payload === "object" ? body.payload : {};
      const sanitizeCounts = (row: any) => ({
        label: String(row?.label ?? "").slice(0, 40),
        signupCount: Number(row?.signupCount) || 0,
        registeredCount: Number(row?.registeredCount) || 0,
        team3Count: Number(row?.team3Count) || 0,
        team6Count: Number(row?.team6Count) || 0
      });
      const greatRegions = Array.isArray(p.great_regions) ? p.great_regions.map(sanitizeCounts) : [];
      const pastoralZones = Array.isArray(p.pastoral_zones)
        ? p.pastoral_zones.map((row: any) => ({ ...sanitizeCounts(row), leaderName: String(row?.leaderName ?? "").slice(0, 60) }))
        : [];
      const s = p.summary && typeof p.summary === "object" ? p.summary : {};

      try {
        const sheetResponse = await fetch(sheetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: sheetSecret,
            planName: String(p.plan_name ?? "").slice(0, 60),
            greatRegions,
            pastoralZones,
            summary: {
              withoutPastoralZoneNotJoined: Number(s.withoutPastoralZoneNotJoined) || 0,
              withoutPastoralZoneJoined: Number(s.withoutPastoralZoneJoined) || 0,
              withPastoralZoneNotJoined: Number(s.withPastoralZoneNotJoined) || 0,
              withPastoralZoneJoined: Number(s.withPastoralZoneJoined) || 0,
              totalJoined: Number(s.totalJoined) || 0,
              totalRegistered: Number(s.totalRegistered) || 0
            }
          })
        });
        if (!sheetResponse.ok) {
          const text = await sheetResponse.text().catch(() => "");
          console.error("sync_registration_stats_sheet: sheet webhook rejected the payload", sheetResponse.status, text);
          return jsonResponse({ error: "sheet_webhook_failed" }, 502);
        }
      } catch (err) {
        console.error("sync_registration_stats_sheet: failed to reach sheet webhook", err);
        return jsonResponse({ error: "sheet_webhook_unreachable" }, 502);
      }

      return jsonResponse({ data: { ok: true } });
    }

    // Any authenticated member may file an issue report (insert only). Reads and
    // deletes stay admin-only via canRead / canAdminWrite below. user_id is forced
    // to the caller in forceUserPayload so a member cannot spoof another user.
    if (["insert", "update", "upsert"].includes(action)
      && table === "profiles"
      && Object.prototype.hasOwnProperty.call(body.payload || {}, "role_id")) {
      return jsonResponse({ error: "role_assignment_managed_by_member_hub" }, 403);
    }
    const canReportInsert = action === "insert" && table === "issue_reports";
    const canReportOwnSelect = action === "select" && table === "issue_reports" && (
      isAdmin(profile) || (
        Array.isArray(body.filters) && body.filters.some((f: any) => f.column === "user_id" && f.value === profile.id)
      )
    );
    const canRead = action === "select" && (READ_TABLES.has(table) || canReportOwnSelect);
    const canOwnWrite = (["insert", "update", "delete", "upsert"].includes(action) && OWN_WRITE_TABLES.has(table)) || canReportInsert;
    const canAdminWrite = ["insert", "update", "delete", "upsert"].includes(action) && (ADMIN_WRITE_TABLES.has(table) || table === "issue_reports") && (isAdmin(profile) || canManagePlans(profile));
    if (!canRead && !canOwnWrite && !canAdminWrite) return jsonResponse({ error: "forbidden" }, 403);


    const devotionalTables = new Set(["devotional_notes", "devotional_likes", "devotional_comments"]);
    if (devotionalTables.has(table)
      && !(await isFeatureEnabled(supabaseAdmin, "pastoral_sharing_wall"))) {
      if (action === "select") return jsonResponse({ data: [] });
      return jsonResponse({ error: "feature_archived" }, 403);
    }
    let query: any;
    if (action === "select") {
      query = supabaseAdmin.from(table).select(body.select || "*");
    } else if (action === "insert") {
      query = supabaseAdmin.from(table).insert(forceUserPayload(table, body.payload, profile.id, action));
    } else if (action === "update") {
      query = supabaseAdmin.from(table).update(forceUserPayload(table, body.payload, profile.id, action));
    } else if (action === "delete") {
      query = supabaseAdmin.from(table).delete();
    } else if (action === "upsert") {
      query = supabaseAdmin.from(table).upsert(forceUserPayload(table, body.payload, profile.id, action), body.options || undefined);
    } else {
      return jsonResponse({ error: "unsupported_action" }, 400);
    }

    query = applyFilters(query, body.filters || []);
    if (body.or) query = query.or(body.or);
    ({ query } = await applyForcedScope(query, table, action, profile, supabaseAdmin));
    if (["insert", "update", "upsert"].includes(action) && body.select) query = query.select(body.select);
    if (body.order?.column) query = query.order(body.order.column, { ascending: body.order.ascending !== false });
    if (body.range && Number.isInteger(body.range.from) && Number.isInteger(body.range.to)) {
      const rangeFrom = Math.max(0, body.range.from);
      const rangeTo = Math.min(Math.max(rangeFrom, body.range.to), rangeFrom + 199);
      query = query.range(rangeFrom, rangeTo);
    }
    if (body.limit) query = query.limit(Math.min(200, Math.max(1, Number(body.limit) || 1)));
    if (body.returning === "single") query = query.single();
    else if (body.returning === "maybeSingle") query = query.maybeSingle();

    const { data, error } = await query;
    if (error) return jsonResponse({ error: error.message, code: error.code }, 400);

    let responseData = data;
    if (table === "profiles" && ["insert", "update", "upsert"].includes(action)) {
      const { data: verifiedProfile, error: verifyError } = await supabaseAdmin
        .from("profiles")
        .select(PROFILE_SELECT)
        .eq("id", profile.id)
        .maybeSingle();
      if (verifyError) return jsonResponse({ error: verifyError.message, code: verifyError.code }, 400);
      if (!verifiedProfile) return jsonResponse({ error: "profile_write_not_verified" }, 500);
      responseData = verifiedProfile;
    }

    return jsonResponse({ data: responseData });
  } catch (err) {
    const errorDetails = err instanceof Error ? err.message : (typeof err === "object" && err !== null ? ((err as any).message || JSON.stringify(err)) : String(err));
    if (errorDetails === "invalid_logto_token") {
      return jsonResponse({ error: "invalid_logto_token", message: "Logto token is invalid or expired" }, 401);
    }
    if (errorDetails === "profile_identity_not_found") {
      return jsonResponse({ error: "profile_identity_not_found", message: "User profile identity not found" }, 404);
    }
    console.error("nlc-data failed:", errorDetails, err);
    return jsonResponse({ error: "nlc_data_failed", message: errorDetails }, 500);
  }
});
