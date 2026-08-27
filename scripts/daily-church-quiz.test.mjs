import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const schema = read("supabase/migrations/0084_daily_church_quizzes.sql");
const cron = read("supabase/migrations/0085_schedule_daily_church_quizzes.sql");
const regeneration = read("supabase/migrations/0086_manual_daily_quiz_regeneration.sql");
const dashboardOptimization = read("supabase/migrations/0087_optimize_daily_quiz_dashboard.sql");
const featureFlag = read("supabase/migrations/0088_daily_quiz_feature_flag.sql");
const publishFlow = read("supabase/migrations/0090_quiz_publish_flow_redesign.sql");
const publishOptimization = read("supabase/migrations/0091_optimize_quiz_publication.sql");
const reservationFix = read("supabase/migrations/0092_fix_daily_quiz_generation_reservation.sql");
const quizSql = `${schema}\n${regeneration}\n${dashboardOptimization}\n${featureFlag}\n${publishFlow}\n${publishOptimization}\n${reservationFix}`;
const generator = read("supabase/functions/generate-daily-quizzes/index.ts");
const edge = read("supabase/functions/nlc-data/index.ts");
const db = read("js/db.js");
const plan = read("js/modules/plan.js");
const admin = read("js/modules/admin.js");
const html = read("index.html");
const css = read("index.css");

describe("daily church quiz", () => {
  it("runs the automatic A/B/C set once and supports deduplicated manual retries", () => {
    expect(schema).toContain("UNIQUE (global_plan_id, quiz_date, variant)");
    expect(generator).toContain("for (const variant of requestedVariants)");
    expect(generator).toContain("if (!reservation?.reserved)");
    expect(generator).toContain('body?.retryExisting === true');
    expect(generator).toContain('reserve_daily_quiz_regeneration');
    expect(regeneration).toContain("DROP CONSTRAINT IF EXISTS daily_quizzes_automatic_generation_attempts_check");
    expect(regeneration).toContain("CHECK (automatic_generation_attempts >= 0)");
    expect(regeneration).toContain("generation_status IN ('failed', 'ready')");
    expect(generator).toContain("https://generativelanguage.googleapis.com/v1beta/models/");
    expect(generator).toContain('"x-goog-api-key": apiKey');
    expect(generator).toContain('Deno.env.get("GEMINI_API_KEY")');
    expect(generator).toContain('Deno.env.get("GEMINI_QUIZ_MODEL")');
    expect(generator).toContain('|| "gemini-3.1-flash-lite"');
    expect(generator).toContain('function normalizeGeminiModel');
    expect(generator).toContain('replace(/^models\\//i, "")');
    expect(generator).toContain('replace(/^GEMINI_QUIZ_MODEL\\s*=\\s*/i, "")');
    expect(generator).not.toContain('|| "gemini-2.5-flash');
  });

  it("reserves A/B generation through the partial uniqueness index", () => {
    expect(publishFlow).toContain("CREATE UNIQUE INDEX IF NOT EXISTS daily_quizzes_ai_variant_unique");
    expect(publishFlow).toContain("WHERE variant IN ('A', 'B')");
    expect(reservationFix).toContain("CREATE OR REPLACE FUNCTION public.reserve_daily_quiz_generation");
    expect(reservationFix).toMatch(/ON CONFLICT \(global_plan_id, quiz_date, variant\)\s+WHERE variant IN \('A', 'B'\)\s+DO NOTHING/);
    expect(reservationFix).toContain("IF p_variant NOT IN ('A', 'B')");
    expect(reservationFix).toContain("TO service_role");
  });

  it("uses Taipei church progress and a strict five-question schema", () => {
    expect(generator).toContain('timeZone: "Asia/Taipei"');
    expect(generator).toContain("resolveDailyChapters(plan.rules, quizDate)");
    expect(generator).toContain('responseMimeType: "application/json"');
    expect(generator).toContain("responseJsonSchema");
    expect(generator).not.toContain("responseFormat: { text:");
    expect(generator).toContain("minItems: 5, maxItems: 5");
    expect(generator).toContain("minItems: 4, maxItems: 4");
    expect(generator).toContain("validateQuestions(JSON.parse(extractGeminiText(payload)))");
  });

  it("requires pastoral review and makes published versions immutable", () => {
    expect(schema).toContain("actor_role NOT IN ('admin', 'pastor')");
    expect(schema).toContain("quiz_approval_required");
    expect(schema).toContain("quiz_already_published");
    expect(schema).toContain("review_status = 'approved'");
    expect(regeneration).toContain("quiz_approval_locked");
    expect(regeneration).toContain("OLD.review_status = 'approved'");
    expect(regeneration).toContain("quiz_already_approved");
  });

  it("publishes through organization groups with one assignment per day", () => {
    expect(schema).toContain("UNIQUE (global_plan_id, quiz_date, small_group_id)");
    expect(schema).toContain("public.can_manage_quiz_group(actor_id, g.id)");
    expect(schema).toContain("ON CONFLICT (global_plan_id, quiz_date, small_group_id) DO NOTHING");
    expect(schema).toContain("quiz_notifications(publication_id, recipient_id, message)");
  });

  it("exposes only assigned quizzes and stores server-scored attempts", () => {
    expect(schema).toContain("public.profile_belongs_to_quiz_group(actor_id, publication_row.small_group_id)");
    expect(schema).toContain("quiz_questions_for_member(quiz_row.questions, attempt_row.id IS NOT NULL)");
    expect(schema).toContain("score_value := score_value + 1");
    expect(schema).toContain("UNIQUE (publication_id, user_id)");
  });

  it("connects all quiz RPCs through nlc-data and db.js", () => {
    for (const rpc of [
      "get_daily_quiz_dashboard", "request_daily_quiz_regeneration", "review_daily_quiz", "update_daily_quiz_questions",
      "publish_daily_quiz", "submit_daily_quiz", "get_quiz_notifications",
      "mark_quiz_notifications_read"
    ]) {
      expect(edge).toContain(`"${rpc}"`);
      expect(quizSql).toContain(`public.${rpc}`);
    }
    expect(db).toContain("async getDailyQuizDashboard(plan, quizDate)");
    expect(db).toContain("async publishDailyQuiz(plan, quizDate, scope = {}, selection = {})");
    expect(db).toContain('p_scope_type: scope.scopeType || "all"');
    expect(db).toContain("p_variant: selection.variant || null");
    expect(db).toContain("async submitDailyQuiz(publicationId, answers)");
    expect(db).toContain("async regenerateDailyQuiz(plan, quizDate, variants = [])");
  });

  it("places the member entrance below chapter progress only after assignment", () => {
    expect(html).toContain('id="daily-quiz-section"');
    expect(html.indexOf('id="daily-quiz-section"')).toBeGreaterThan(html.indexOf('id="plan-tasks-list"'));
    expect(plan).toContain("if (!context.myQuiz && !context.canPublish)");
    expect(plan).toContain("renderDailyQuizEntry");
    expect(plan).toContain('id="daily-quiz-entry-button"');
    expect(plan).toContain("getDailyQuizReadingProgress");
    expect(plan).toContain("if (!progress.isComplete)");
    expect(plan).toContain("請先閱讀完今天的速讀進度，再進入小測驗");
    expect(plan).toContain("quizDate !== getDailyQuizTaiwanToday()");
    expect(plan).toContain("if (options.open === true)");
    expect(plan).toContain("renderAssignedDailyQuiz");
    expect(plan).toContain("renderPublisherDailyQuiz");
    expect(css).toContain(".daily-quiz-entry-button {");
    expect(css).toContain("font-size: 14px;");
  });

  it("shows approved version numbers only to publishers after review", () => {
    expect(plan).toContain('const approvedVariants = (Array.isArray(context.approvedVariants)');
    expect(plan).toContain('data-quiz-version-choice="A"');
    expect(plan).toContain('data-quiz-version-choice="B"');
    expect(plan).toContain('data-quiz-version-choice="C"');
    expect(plan).toContain('今日 AI 題目尚未完成審核');
  });

  it("adds review, publishing and scoped member results to plan management", () => {
    expect(html).toContain('data-plan-subtab="quizzes"');
    expect(admin).toContain("renderAdminQuizReviewCards");
    expect(admin).toContain("renderAdminQuizPublishPanel");
    expect(admin).toContain('id="admin-quiz-publish-btn"');
    expect(admin).toContain('data-quiz-version-choice="C"');
    expect(admin).toContain('data-quiz-action="regenerate"');
    expect(admin).toContain("更換後會清除目前題目並重新生成");
    expect(admin).toContain("已審核鎖定");
    expect(admin).toContain("group.members");
    expect(admin).toContain("averageScore");
  });

  it("schedules one generator invocation at 00:05 Taipei time", () => {
    expect(cron).toContain("'5 16 * * *'");
    expect(cron).toContain("quiz_generation_cron_secret");
    expect(cron).toContain("generate-daily-quizzes");
  });

  it("can disable all quiz entry points without deleting existing data", () => {
    expect(featureFlag).toMatch(/'daily_quiz',\s*FALSE/);
    expect(featureFlag).toContain("IF NOT public.is_feature_enabled('daily_quiz')");
    expect(featureFlag).not.toMatch(/DELETE FROM public\.(daily_quizzes|quiz_)/i);
    expect(generator).toContain('eq("key", "daily_quiz")');
    expect(generator).toContain('status: "feature_disabled", requests: 0');
    expect(edge).toContain('error: "daily_quiz_feature_disabled"');
    // allowedKeys may carry additional feature keys (e.g. speed_reading_exam);
    // only assert daily_quiz stays gated alongside pastoral_sharing_wall.
    expect(db).toMatch(/\["pastoral_sharing_wall", "daily_quiz"[\],]/);
    expect(html).toContain('id="admin-daily-quiz-feature-toggle"');
    expect(admin).toContain('updateFeatureSetting("daily_quiz", nextEnabled)');
    expect(plan).toContain('isDailyQuizFeatureEnabled()');
    expect(admin).toContain("adminDailyQuizDashboardCache.clear()");
    expect(admin).toContain("delete quizRoot.dataset.quizDashboardKey");
    expect(admin).toContain("切換至小測驗分頁後會載入原有資料");
    expect(plan).toContain('window.addEventListener("daily-quiz-feature-changed"');
    expect(plan).toContain("void renderDailyQuizSection(state.activePlan, selectedDay, lastTrackerRequestId)");
    expect(plan).toContain("dailyQuizRenderRequestId += 1");
  });

  it("uses two-version and 發佈 wording consistently in the quiz UI", () => {
    expect(admin).toContain("每日兩版題目");
    expect(admin).not.toContain("每日三版題目");
    expect(admin).toContain("<h2>發佈小測驗</h2>");
    expect(admin).not.toContain("發布小測驗");
    expect(plan).toContain("發佈小測驗");
    expect(plan).not.toContain("發布小測驗");
  });

  it("loads the organization dashboard without per-group member subqueries", () => {
    expect(dashboardOptimization).toContain("CREATE OR REPLACE FUNCTION public.get_daily_quiz_dashboard");
    expect(dashboardOptimization).toContain("member_matches AS MATERIALIZED");
    expect(dashboardOptimization).toContain("published_members AS");
    expect(dashboardOptimization).toContain("idx_quiz_publications_plan_date_group");
    expect(dashboardOptimization).not.toContain("SELECT COUNT(*) FROM public.profiles member WHERE public.profile_belongs_to_quiz_group");
  });

  it("logs each invocation and Gemini variant without exposing secrets", () => {
    expect(generator).toContain("daily_quiz_invocation_received");
    expect(generator).toContain("daily_quiz_gemini_request_started");
    expect(generator).toContain("daily_quiz_variant_failed");
    expect(generator).toContain("daily_quiz_generation_finished");
    expect(generator).not.toContain('apiKey }));');
    expect(generator).not.toContain('cronSecret }));');
  });

  it("shows a safe retryable error state instead of raw database errors", () => {
    expect(db).toContain('normalized.includes("canceling statement")');
    expect(db).toContain('return "小測驗載入逾時，請稍後再試。"');
    expect(db).toContain('normalized.includes("pgrst202")');
    expect(db).toContain('return "小測驗資料庫版本尚未更新，請通知管理員完成系統更新。"');
    expect(admin).toContain('class="admin-daily-quiz-load-error"');
    expect(admin).toContain('data-quiz-load-retry');
    expect(admin).toContain("['A', 'B'].map(variant");
    expect(admin).toContain('狀態載入失敗');
    expect(admin).toContain('已保留原有題目與審核狀態');
    expect(admin).not.toContain('data-quiz-action="refresh-status"');
    expect(admin).not.toContain('重新載入狀態');
    expect(admin).toContain("void renderAdminDailyQuizManagement(true, quizDate)");
    expect(admin).toContain("prefetchedResult = null");
    expect(admin).toContain('const adminDailyQuizDashboardCache = new Map()');
    expect(admin).toContain('root.dataset.quizDashboardKey === cacheKey');
    expect(admin).toContain('adminDailyQuizDashboardCache.get(cacheKey)');
    expect(admin).toContain('adminDailyQuizDashboardCache.set(cacheKey, result)');
    expect(admin).toContain('renderAdminDailyQuizManagement(false, event.target.value)');
    expect(css).not.toContain('.admin-daily-quiz-version--status-loading {');
    expect(admin).toContain('載入後才可審核');
    expect(admin).toContain('載入後才可編輯');
    expect(admin).toContain('編輯題目');
    expect(admin).toContain('data-quiz-action="toggle-edit"');
    expect(admin).toContain('class="admin-daily-quiz-editor-shell"');
    expect(admin).toContain('role="dialog" aria-modal="true"');
    expect(admin).toContain('data-quiz-editor-close');
    expect(admin).toContain("document.body.classList.toggle('admin-quiz-editor-open', opening)");
    expect(css).toContain('min-height: 100dvh;');
    expect(css).toContain('body.admin-quiz-editor-open');
    expect(css).toMatch(/\.admin-daily-quiz-editor-wrap \{[\s\S]*overflow-y: auto;/);
    expect(css).toMatch(/\.admin-daily-quiz-editor-shell \{[\s\S]*min-height: 100dvh;/);
    expect(css).toMatch(/\.admin-daily-quiz-editor \.admin-daily-quiz-question \{[\s\S]*border: 0;/);
    expect(admin).toContain('data-quiz-carousel');
    expect(admin).toContain('data-quiz-slide-track');
    expect(admin).toContain('data-quiz-slide="previous"');
    expect(admin).toContain('data-quiz-slide="next"');
    expect(admin).toContain('bindAdminQuizCarousels(root)');
    expect(css).toContain('scroll-snap-type: x mandatory;');
    expect(css).toContain('.admin-daily-quiz-question-slide {');
    expect(admin).toContain("editorWrap.dataset.dirty = 'true'");
    expect(admin).toContain("editor.dataset.dirty === 'true'");
    expect(admin).toContain('目前有尚未儲存的題目修改');
    expect(admin).toContain("editor.querySelector('[data-quiz-editor-close]')?.click()");
    expect(admin).toContain("button.textContent = '儲存中…'");
    expect(admin).toContain('data-quiz-action="review"');
    expect(admin).toContain('審核通過');
    expect(css).toContain('.admin-daily-quiz-load-error {');
    expect(css).toContain('.admin-daily-quiz-version--load-failed {');
    expect(html).toMatch(/index\.css\?v=2026\d{4}_[a-z0-9_]+/);
  });

  it("deploys the redesigned publish RPC under a unique, safely repeatable migration", () => {
    expect(publishFlow).toContain("DROP FUNCTION IF EXISTS public.publish_daily_quiz(UUID, DATE, UUID[], BOOLEAN, UUID)");
    expect(publishFlow).toContain("CREATE OR REPLACE FUNCTION public.publish_daily_quiz(");
    expect(publishFlow).toContain("p_scope_type TEXT");
    expect(publishFlow).toContain("p_variant TEXT DEFAULT NULL");
    expect(publishFlow).toContain("p_custom_questions JSONB DEFAULT NULL");
  });

  it("publishes groups and notifications with set-based statements", () => {
    expect(publishOptimization).toContain("FROM UNNEST(target_group_ids)");
    expect(publishOptimization).toContain("GET DIAGNOSTICS published_count = ROW_COUNT");
    expect(publishOptimization).toContain("INSERT INTO public.quiz_notifications");
    expect(publishOptimization).toContain("profile.small_group_id = publication.small_group_id");
    expect(publishOptimization).not.toContain("FOREACH target_group_id");
    expect(publishOptimization).toContain("NOTIFY pgrst, 'reload schema'");
    expect(db).toContain("JSON.stringify(errorDetails)");
  });
});
