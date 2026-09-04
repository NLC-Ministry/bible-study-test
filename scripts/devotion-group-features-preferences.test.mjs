import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/0156_devotion_group_features_master.sql");
const nlcData = read("supabase/functions/nlc-data/index.ts");
const dbJs = read("js/db.js");
const plan = read("js/modules/plan.js");
const admin = read("js/modules/admin.js");
const profile = read("js/modules/profile.js");
const html = read("index.html");

// 每日靈修／小組聚會週計畫「功能設定」：
//  ① 管理分頁一顆「功能設定」總開關（admin 專屬）——關閉時強制清空所有會友
//     已經自己開啟的個人偏好；開啟後不會幫任何人預設打開。
//  ② 個人分頁「功能設定」子頁面（只在①開啟時對所有會友顯示，不是管理員專屬）
//     ——每個會友自己的「每日靈修」「小組經營」開關，一人一份，互不影響。
describe("migration 0156: per-user preference table + master flag + RPCs", () => {
  it("creates a per-profile preference table (not a single shared global flag)", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.profile_feature_preferences");
    expect(migration).toContain("PRIMARY KEY (profile_id, feature_key)");
    expect(migration).toContain("feature_key IN ('daily_devotion', 'group_meeting_plan')");
  });

  it("adds the master flag defaulting to off, reusing the existing app_feature_settings mechanism", () => {
    expect(migration).toContain("VALUES ('devotion_group_features_master', FALSE,");
  });

  it("get_my_devotion_group_preferences and set_my_devotion_group_preference only ever touch the calling actor's own row", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.get_my_devotion_group_preferences(");
    expect(migration).toContain("UUID := public.resolve_quiz_actor(p_actor_id);");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.set_my_devotion_group_preference(");
    // 沒有「目標使用者」參數——只有 p_feature_key / p_enabled / p_actor_id。
    expect(migration).not.toMatch(/set_my_devotion_group_preference\([^)]*p_profile_id/);
  });

  it("enabling your own preference requires the master flag to already be on", () => {
    const idx = migration.indexOf("CREATE OR REPLACE FUNCTION public.set_my_devotion_group_preference(");
    const body = migration.slice(idx, migration.indexOf("$$;", idx));
    expect(body).toContain("devotion_group_features_master_disabled");
    expect(body).toContain("IF COALESCE(master_enabled, FALSE) IS NOT TRUE THEN");
  });

  it("set_devotion_group_features_master is admin-only and cascades: off wipes everyone's preferences, on does not grant anyone anything", () => {
    const idx = migration.indexOf("CREATE OR REPLACE FUNCTION public.set_devotion_group_features_master(");
    expect(idx).toBeGreaterThan(-1);
    const body = migration.slice(idx, migration.indexOf("\n-- ── 6.", idx));
    expect(body).toContain("devotion_group_master_admin_required");
    expect(body).toContain("role_code((SELECT role_id FROM public.profiles WHERE id = actor_id)) = 'admin'");
    expect(body).toContain("IF NOT COALESCE(p_enabled, FALSE) THEN");
    expect(body).toContain("DELETE FROM public.profile_feature_preferences");
    expect(body).toContain("WHERE feature_key IN ('daily_devotion', 'group_meeting_plan')");
    // 開啟總開關的分支裡不能出現任何 INSERT/UPDATE profile_feature_preferences——
    // 開啟時絕對不能幫任何人預設打開。
    const grantedOnEnable = body.slice(0, body.indexOf("IF NOT COALESCE(p_enabled, FALSE) THEN"));
    expect(grantedOnEnable).not.toContain("profile_feature_preferences");
  });

  it("get_devotional_plan and get_group_meeting_plan gate member access on master AND the caller's own preference, not the old global flags", () => {
    const devoIdx = migration.lastIndexOf("CREATE OR REPLACE FUNCTION public.get_devotional_plan(");
    const devoBody = migration.slice(devoIdx, migration.indexOf("\n-- ── 7.", devoIdx));
    expect(devoBody).toContain("FROM public.app_feature_settings WHERE key = 'devotion_group_features_master'");
    expect(devoBody).toContain("FROM public.profile_feature_preferences");
    expect(devoBody).toContain("feature_key = 'daily_devotion'");
    expect(devoBody).not.toContain("is_feature_enabled('daily_devotion')");

    const groupIdx = migration.lastIndexOf("CREATE OR REPLACE FUNCTION public.get_group_meeting_plan(");
    expect(groupIdx).toBeGreaterThan(devoIdx);
    const groupBody = migration.slice(groupIdx);
    expect(groupBody).toContain("FROM public.app_feature_settings WHERE key = 'devotion_group_features_master'");
    expect(groupBody).toContain("feature_key = 'group_meeting_plan'");
    expect(groupBody).not.toContain("is_feature_enabled('group_meeting_plan')");
  });
});

describe("nlc-data allowlists the 3 new RPCs and injects p_actor_id", () => {
  it("adds DEVOTION_GROUP_FEATURE_RPC_FUNCTIONS to the allowlist and the actor-injection condition", () => {
    expect(nlcData).toContain('"get_my_devotion_group_preferences"');
    expect(nlcData).toContain('"set_my_devotion_group_preference"');
    expect(nlcData).toContain('"set_devotion_group_features_master"');
    expect(nlcData).toContain("...DEVOTION_GROUP_FEATURE_RPC_FUNCTIONS");
    expect(nlcData).toContain("|| DEVOTION_GROUP_FEATURE_RPC_FUNCTIONS.has(functionName)");
  });
});

describe("db.js wrappers", () => {
  it("exposes read/write helpers for the caller's own preferences, and a dedicated admin-gated master setter", () => {
    expect(dbJs).toContain("async getMyDevotionGroupPreferences()");
    expect(dbJs).toContain("async setMyDevotionGroupPreference(featureKey, enabled)");
    expect(dbJs).toContain("async setDevotionGroupFeaturesMaster(enabled)");
    // 寫總開關前先在前端也擋一次非 admin（後端 RPC 本身也會擋，這裡是防呆）。
    const idx = dbJs.indexOf("async setDevotionGroupFeaturesMaster(enabled)");
    const body = dbJs.slice(idx, idx + 300);
    expect(body).toContain('getUserRoleCode(state.currentUser) !== "admin"');
  });

  it("does not let the generic updateFeatureSetting write the master flag (writes must go through the cascading RPC)", () => {
    const idx = dbJs.indexOf("async updateFeatureSetting(key, enabled)");
    const body = dbJs.slice(idx, idx + 400);
    expect(body).not.toContain("devotion_group_features_master");
  });
});

describe("js/modules/plan.js: visibility now depends on master gate + the current user's own cached preference", () => {
  it("ensureDevotionGroupPreferencesLoaded fetches once and caches masterEnabled + my own daily_devotion/group_meeting_plan preference", () => {
    const idx = plan.indexOf("async function ensureDevotionGroupPreferencesLoaded()");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, idx + 1200);
    expect(body).toContain("db.getMyDevotionGroupPreferences()");
    expect(body).toContain("window.devotionGroupFeaturesMasterEnabled = data.masterEnabled === true");
    expect(body).toContain("window.dailyDevotionFeatureEnabled = data.dailyDevotion === true");
    expect(body).toContain("window.groupMeetingPlanFeatureEnabled = data.groupMeetingPlan === true");
  });

  it("isDevotionalPlanVisibleToUser: admin/pastor always see it; everyone else needs the master gate AND their own preference", () => {
    const idx = plan.indexOf("function isDevotionalPlanVisibleToUser(plan)");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, idx + 500);
    expect(body).toContain('role === "admin" || role === "pastor"');
    expect(body).toContain("window.devotionGroupFeaturesMasterEnabled !== true) return false");
    expect(body).toContain("return window.dailyDevotionFeatureEnabled === true");
  });

  it("isGroupMeetingPlanVisibleToUser follows the same rule for group_meeting_plan", () => {
    const idx = plan.indexOf("function isGroupMeetingPlanVisibleToUser(plan)");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, idx + 500);
    expect(body).toContain('role === "admin" || role === "pastor"');
    expect(body).toContain("window.devotionGroupFeaturesMasterEnabled !== true) return false");
    expect(body).toContain("return window.groupMeetingPlanFeatureEnabled === true");
  });

  it("dev-mode badges now key off the master gate, not the old per-feature global flags", () => {
    const devoIdx = plan.indexOf("function isDevotionalPlanDevMode(plan)");
    expect(devoIdx).toBeGreaterThan(-1);
    const devoBody = plan.slice(devoIdx, devoIdx + 200);
    expect(devoBody).toContain('(plan.planKind || plan.plan_kind) === "devotional"');
    expect(devoBody).toContain("window.devotionGroupFeaturesMasterEnabled !== true");

    const groupIdx = plan.indexOf("function isGroupMeetingPlanDevMode(plan)");
    expect(groupIdx).toBeGreaterThan(-1);
    const groupBody = plan.slice(groupIdx, groupIdx + 200);
    expect(groupBody).toContain('(plan.planKind || plan.plan_kind) === "group_meeting"');
    expect(groupBody).toContain("window.devotionGroupFeaturesMasterEnabled !== true");
  });
});

describe("js/modules/admin.js: 管理分頁只有一顆「功能設定」總開關", () => {
  it("no longer renders/binds individual daily_devotion / group_meeting_plan switches here", () => {
    expect(admin).not.toContain("admin-daily-devotion-feature-toggle");
    expect(admin).not.toContain("admin-group-meeting-feature-toggle");
    expect(admin).not.toContain('db.updateFeatureSetting("daily_devotion"');
    expect(admin).not.toContain('db.updateFeatureSetting("group_meeting_plan"');
  });

  it("renders exactly one master toggle wired through the cascading db.setDevotionGroupFeaturesMaster", () => {
    expect(admin).toContain('getElementById("admin-devotion-master-toggle")');
    const idx = admin.indexOf('masterToggle.addEventListener("click"');
    expect(idx).toBeGreaterThan(-1);
    const body = admin.slice(idx, idx + 900);
    expect(body).toContain("db.setDevotionGroupFeaturesMaster(nextEnabled)");
    expect(body).toContain("window.devotionGroupFeaturesMasterEnabled = nextEnabled");
  });

  it("still refreshes the role-gated 計劃管理 sub-tabs independently of the feature flags themselves", () => {
    const idx = admin.indexOf("export async function renderAdminFeatureSettings()");
    const body = admin.slice(idx, idx + 1200);
    expect(body).toContain("applyAdminDevotionVisibility();");
    expect(body).toContain("applyAdminGroupMeetingVisibility();");
  });
});

describe("js/modules/profile.js: 個人分頁「功能設定」給所有會友，各自的偏好", () => {
  it("row visibility depends only on the master flag, not on the viewer's role", () => {
    const idx = profile.indexOf("async function updateFeatureSettingsRowVisibility()");
    expect(idx).toBeGreaterThan(-1);
    const body = profile.slice(idx, idx + 900);
    expect(body).not.toContain("getUserRoleCode");
    expect(body).not.toContain('=== "admin"');
    expect(body).toContain('row.classList.toggle("hidden", window.devotionGroupFeaturesMasterEnabled !== true)');
  });

  it("is called on every profile view render (not admin-nav-only)", () => {
    const idx = profile.indexOf("export async function renderProfileView()");
    const body = profile.slice(idx, idx + 600);
    expect(body).toContain("void updateFeatureSettingsRowVisibility();");
  });

  it("the subpage's two toggles write through setMyDevotionGroupPreference (self-scoped, no master toggle in this subpage)", () => {
    const idx = profile.indexOf("async function renderFeatureSettingsSubpage()");
    expect(idx).toBeGreaterThan(-1);
    const body = profile.slice(idx, profile.indexOf("\nwindow.openProfileDetail", idx) === -1
      ? profile.length
      : profile.indexOf("\nwindow.openProfileDetail", idx));
    expect(body).toContain('db.setMyDevotionGroupPreference("daily_devotion", nextEnabled)');
    expect(body).toContain('db.setMyDevotionGroupPreference("group_meeting_plan", nextEnabled)');
    expect(body).not.toContain("profile-devotion-master-toggle");
  });
});

describe("index.html structure", () => {
  it("admin-feature-settings-card has exactly one devotion/group-meeting row (the master), not the old per-feature rows", () => {
    const cardIdx = html.indexOf('class="glass-card admin-feature-settings-card"');
    const cardEndIdx = html.indexOf("admin-plan-context", cardIdx);
    const cardBody = html.slice(cardIdx, cardEndIdx);
    expect(cardBody).toContain('id="admin-devotion-master-toggle"');
    expect(cardBody).not.toContain("admin-daily-devotion-feature-toggle");
    expect(cardBody).not.toContain("admin-group-meeting-feature-toggle");
  });

  it("the 個人-tab row is hidden by default (JS decides visibility for every viewer) and its subpage has both per-user switches", () => {
    const rowIdx = html.indexOf('id="profile-feature-settings-row"');
    expect(rowIdx).toBeGreaterThan(-1);
    const rowTagStart = html.lastIndexOf("<button", rowIdx);
    const rowTag = html.slice(rowTagStart, html.indexOf(">", rowIdx) + 1);
    expect(rowTag).toContain("hidden");

    const subIdx = html.indexOf('id="profile-tab-content-feature-settings"');
    expect(subIdx).toBeGreaterThan(-1);
    const subBody = html.slice(subIdx, subIdx + 2500);
    expect(subBody).toContain('id="profile-daily-devotion-feature-toggle"');
    expect(subBody).toContain('id="profile-group-meeting-feature-toggle"');
    expect(subBody).not.toContain("profile-devotion-master-toggle");
  });
});
