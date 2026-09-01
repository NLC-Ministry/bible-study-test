import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const context = {
  window: {},
  console,
  Date,
  Map,
  Set,
  JSON,
  Array,
  Number,
  String,
  Object,
  Math
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(readFileSync(join(root, "js", "data", "bible_data.js"), "utf8"), context);
vm.runInContext(readFileSync(join(root, "js", "data", "church_campaign.js"), "utf8"), context);

const campaign = context.window.CHURCH_CAMPAIGN;
const books = context.window.BIBLE_BOOKS;

describe("versioned church Bible campaign", () => {
  it("splits the campaign into stage plans — 第一輪期末賽 further split into 4 monthly finals", () => {
    const stages = context.window.createChurchCampaignStageDefinitions(campaign);
    // 1 (熱身賽) + 4 (期末賽 9–12 月) + 8 (stage 3–10) = 13
    expect(stages).toHaveLength(13);
    expect(new Set(stages.map(stage => stage.id))).toHaveLength(13);
    expect(new Set(stages.map(stage => stage.presetKey))).toHaveLength(13);
    expect(stages.every(stage => stage.planKind === "church_campaign_stage")).toBe(true);
    expect(stages.every(stage => stage.stages.length === 1 && stage.segments.length > 0)).toBe(true);

    // 4 個月度期末賽計畫，都掛 stageNo 2 + 鐵獎，9 月開放、10–12 月鎖住
    const monthly = stages.filter(stage => Number(stage.stageNo) === 2);
    expect(monthly.map(s => s.presetKey)).toEqual([
      "church_r1final_2026_09", "church_r1final_2026_10", "church_r1final_2026_11", "church_r1final_2026_12"
    ]);
    expect(monthly.every(s => s.awardName === monthly[0].awardName)).toBe(true);
    expect(monthly.map(s => s.isHidden)).toEqual([false, true, true, true]);
    expect(monthly.map(s => s.books[0])).toEqual(["出埃及記", "利未記", "民數記", "申命記"]);
    // 只有 12 月那張帶期末測驗
    expect(monthly.map(s => s.examDate)).toEqual([null, null, null, "2026-12-27"]);

    const scheduled = stages.flatMap(stage =>
      context.window.buildChurchCampaignDays(stage, books).flatMap(day => day.chapters)
    ).map(chapter => chapter.book + ":" + chapter.chapter);
    expect(scheduled).toHaveLength(1189);
    expect(new Set(scheduled)).toHaveLength(1189);
  });

  it("contains the complete 66-book, 1,189-chapter schedule", () => {
    const result = context.window.validateChurchCampaign(campaign, books);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.chapterCount).toBe(1189);
    expect(campaign.stages).toHaveLength(10);
    expect(new Set(campaign.stages.map(stage => stage.roundNo))).toHaveLength(8);
    expect(campaign.segments).toHaveLength(35);

    const scheduled = context.window.buildChurchCampaignDays(campaign, books)
      .flatMap(day => day.chapters)
      .map(chapter => chapter.book + ":" + chapter.chapter);
    const canonical = books.flatMap(book =>
      Array.from({ length: book.chapters }, (_, index) => book.name + ":" + (index + 1))
    );
    const campaignDays = context.window.buildChurchCampaignDays(campaign, books);
    expect(campaignDays[0].dayNum).toBe(1);
    expect(campaignDays.at(-1).dayNum).toBe(campaignDays.length);
    expect(new Set(campaignDays.map(day => day.dayNum)).size).toBe(campaignDays.length);
    expect(scheduled).toHaveLength(1189);
    expect(new Set(scheduled).size).toBe(1189);
    expect(new Set(scheduled)).toEqual(new Set(canonical));
  });

  it("redistributes every campaign stage around personal weekly rest days", () => {
    const days = context.window.buildChurchCampaignDays(campaign, books, [0, 6]);
    const restDays = days.filter(day => [0, 6].includes(new Date(day.isoDate + "T00:00:00").getDay()));
    expect(restDays.length).toBeGreaterThan(0);
    expect(restDays.every(day => day.isRestDay && day.chapters.length === 0)).toBe(true);
    expect(days.flatMap(day => day.chapters)).toHaveLength(1189);
    expect(days.filter(day => day.chapters.length > 0).every(day => ![0, 6].includes(new Date(day.isoDate + "T00:00:00").getDay()))).toBe(true);
  });

  it("uses profile small-group membership with a six-person minimum and no maximum", () => {
    const five = Array.from({ length: 5 }, () => ({ small_group: "恩典小組" }));
    const six = Array.from({ length: 6 }, () => ({ small_group: "恩典小組" }));
    const twelve = Array.from({ length: 12 }, () => ({ small_group: "恩典小組" }));
    expect(context.window.getChurchCampaignTeamStatus("smallGroup", five, campaign).eligible).toBe(false);
    expect(context.window.getChurchCampaignTeamStatus("smallGroup", six, campaign).eligible).toBe(true);
    const large = context.window.getChurchCampaignTeamStatus("smallGroup", twelve, campaign);
    expect(large.eligible).toBe(true);
    expect(large.max).toBeNull();
    expect(large.source).toBe("profile.small_group");
  });

  it("keeps independent small-home teams between two and four people", () => {
    for (const count of [2, 3, 4]) {
      expect(context.window.getChurchCampaignTeamStatus("smallHome", Array(count).fill({}), campaign).eligible).toBe(true);
    }
    expect(context.window.getChurchCampaignTeamStatus("smallHome", [{}], campaign).eligible).toBe(false);
    expect(context.window.getChurchCampaignTeamStatus("smallHome", Array(5).fill({}), campaign).eligible).toBe(false);
  });

  it("exposes each stage's books + award so a region cohort can run as a plain plan", () => {
    // 延後大區梯次「只沿用獎勵、其他都獨立」：它是普通固定日期計畫，排程靠
    // target_books（缺時前端退回 getChurchCampaignStageDefinition(N).books），
    // 只有 stageNo / awardName 跟著來源正式階段（發獎用）。
    const stage1 = context.window.getChurchCampaignStageDefinition(1, campaign);
    expect(stage1.books).toEqual(["創世記"]);
    expect(Number(stage1.stageNo)).toBe(1);
    expect(stage1.awardName).toBe("磐石獎");

    // stageNo 2 現在是 4 個月度計畫；錨點 def 指第一個月（出埃及記），
    // 4 卷書分散在 4 個 preset 上。
    const stage2 = context.window.getChurchCampaignStageDefinition(2, campaign);
    expect(stage2.books).toEqual(["出埃及記"]);
    expect(stage2.awardName).toBe("鐵獎");
    const monthlyBooks = context.window.createChurchCampaignStageDefinitions(campaign)
      .filter(s => Number(s.stageNo) === 2)
      .flatMap(s => s.books);
    expect(monthlyBooks).toEqual(["出埃及記", "利未記", "民數記", "申命記"]);
  });

  it("scopes plan progress to the plan — an 8月正辦 read must not count toward a 9月延後梯次", () => {
    // calculateAllPlansProgress matches reading_logs by plan_id / global_plan_id /
    // presetKey only. The legacy fallback is for logs with NO attribution at all,
    // never a blanket "any log for this chapter" wildcard (which would merge the
    // canonical stage and its region cohort — same books, different windows).
    const utils = readFileSync(join(root, "js", "utils.js"), "utf8");
    const block = utils.slice(
      utils.indexOf("const logSet = new Set();"),
      utils.indexOf("plan.completedChapters = completed;")
    );
    expect(block).not.toMatch(/logSet\.add\(`\*_/);
    expect(block).not.toMatch(/logSet\.has\(`\*_/);
    expect(block).toContain("__unattributed__");
    expect(block).toContain("!l.plan_id && !l.global_plan_id && !l.presetKey && !l.preset_key");
  });

  it("removes the old monthly selection flow while preserving compatibility hiding", () => {
    const state = readFileSync(join(root, "js", "state.js"), "utf8");
    const plan = readFileSync(join(root, "js", "modules", "plan.js"), "utf8");
    const db = readFileSync(join(root, "js", "db.js"), "utf8");
    expect(state).not.toContain("SEASON_MONTHS");
    expect(db).not.toContain('key.startsWith("m_")');
    expect(plan).not.toContain("targetMonth");
    expect(plan).not.toContain("getMonthSeason");
    expect(plan).toContain('String(plan && plan.presetKey || "").startsWith("m_")');
  });
});

describe("campaign data contract and statistics scope", () => {
  const migration = readFileSync(join(root, "supabase", "migrations", "0016_versioned_church_campaign.sql"), "utf8");
  const stageMigration = readFileSync(join(root, "supabase", "migrations", "0017_church_campaign_stage_plans.sql"), "utf8");
  const cleanupSql = readFileSync(join(root, "supabase", "migrations", "0026_production_cleanup_obsolete_plans_badges.sql"), "utf8");
  const edge = readFileSync(join(root, "supabase", "functions", "nlc-data", "index.ts"), "utf8");
  const db = readFileSync(join(root, "js", "db.js"), "utf8");

  it("stores versioned editable rules and synchronizes existing enrollments", () => {
    expect(migration).toContain("plan_rule_versions");
    expect(migration).toContain("publish_global_plan_rules");
    expect(migration).toContain("rule_version");
    expect(migration).toContain("WHERE global_plan_id = p_plan_id");
    expect(migration).toContain("profile.small_group");
  });

  it("creates separate stage statistics and clears obsolete test participation", () => {
    expect(stageMigration).toContain("church_campaign_stage");
    expect(stageMigration.match(/00000000-0000-0000-c026-0000000000\d\d/g)?.length).toBeGreaterThanOrEqual(10);
    expect(stageMigration).toContain("sync_church_campaign_stage_plans");
    expect(stageMigration).toContain("TEST ENVIRONMENT: discard obsolete participation");
    expect(stageMigration).not.toContain("old_plan.reading_days_per_week");
    expect(stageMigration).toContain("DELETE FROM public.reading_plans");
    expect(stageMigration).toContain("ON DELETE CASCADE");
    expect(db).toContain("migrateLocalChurchCampaignToStages");
    expect(db).toContain("item.books.includes(log.book)");
    expect(cleanupSql).toContain("Production cleanup");
    expect(cleanupSql).toContain("ON DELETE CASCADE");
    expect(cleanupSql).toContain("orphan reading_logs remain");
    expect(cleanupSql).toContain("retired enrollments remain");
    expect(cleanupSql).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });

  it("lets admins read all church participants while keeping non-admin scope filters", () => {
    expect(edge).toContain("if (hasWholeChurchPlanScope(profile)) return null");
    expect(edge).toContain('query.in("user_id"');
    expect(edge).toContain('query.in("id"');
    expect(edge).toContain('"publish_global_plan_rules"');
  });
});

describe("editable flexible weekly schedules", () => {
  const plan = readFileSync(join(root, "js", "modules", "plan.js"), "utf8");
  const db = readFileSync(join(root, "js", "db.js"), "utf8");
  const migration = readFileSync(join(root, "supabase", "migrations", "0015_flexible_weekly_schedule.sql"), "utf8");

  it("shows saved rest weekdays in the list and edits only from the plan menu", () => {
    expect(plan).toContain("formatFlexibleScheduleSummary");
    expect(plan).toContain("joined-plan-schedule-summary");
    expect(plan).not.toContain("edit-flexible-schedule-btn");
    expect(plan).toContain('document.getElementById("edit-flexible-plan-schedule-btn")');
    expect(plan).toContain("openFlexibleScheduleDialog(plan, { editing: true })");
    expect(plan).toContain("db.updateFlexiblePlanSchedule");
    expect(plan).toContain("isFixedPlanUpcoming");
    expect(plan).toContain("已開放預覽與預先加入");
    expect(plan).toContain("正式開始，敬請期待");
    expect(plan).toContain('isUpcomingFixed ? "預先加入" : "加入計畫"');
  });

  it("persists the weekly schedule and rebuilds chapter distribution", () => {
    expect(db).toContain("async updateFlexiblePlanSchedule");
    expect(db).toContain("reading_days_per_week: weeklySchedule.readingDaysPerWeek");
    expect(db).toContain("rest_weekdays: weeklySchedule.restWeekdays");
    expect(db).toContain("const rebuilt = generatePlanObject");
    expect(migration).toContain("cardinality(rest_weekdays) = 7 - reading_days_per_week");
  });
});

describe("joined plan options menu", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const stateSource = readFileSync(join(root, "js", "state.js"), "utf8");
  const planSource = readFileSync(join(root, "js", "modules", "plan.js"), "utf8");
  const gamification = readFileSync(join(root, "js", "gamification.js"), "utf8");

  it("shows plan details and exit actions for every joined plan", () => {
    const details = html.indexOf('id="view-plan-details-btn"');
    const exit = html.indexOf('id="delete-plan-btn"');
    expect(details).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(details);
    expect(stateSource).toContain('optionsContainer.classList.toggle("hidden", !isPlanDetail)');
    expect(stateSource).toContain('optionsContainer.style.display = isPlanDetail ? "flex" : "none"');
    expect(planSource).toContain("openPlanDetailsDialog(state.activePlan)");
    expect(planSource).toContain("isLegacyCampaignMaster");
    expect(planSource).toContain("2026-2029 新生生命聖經速讀計畫");
  });

  it("keeps the weekly schedule as a separate action for every plan", () => {
    const details = html.indexOf('id="view-plan-details-btn"');
    const schedule = html.indexOf('id="edit-flexible-plan-schedule-btn"');
    const exit = html.indexOf('id="delete-plan-btn"');
    expect(schedule).toBeGreaterThan(details);
    expect(exit).toBeGreaterThan(schedule);
    expect(html).not.toContain('id="edit-flexible-plan-schedule-btn" style="display:none;"');
    expect(planSource).toContain('if (flexibleScheduleMenuButton) flexibleScheduleMenuButton.style.display = ""');
    expect(planSource).toContain('if (!plan) return;');
  });

  it("shows stage awards and each monthly chapter range in plan details", () => {
    expect(planSource).toContain("每月／階段章節安排");
    expect(planSource).toContain("formatCampaignReadingRange");
    expect(planSource).toContain("完成本階段可獲得");
    expect(planSource).toContain("campaignAwardEarned");
    expect(planSource).toContain("plan-cover-thumbnail--icon");
    expect(planSource).toContain("white-space: nowrap");
    expect(gamification).toContain('const ACHIEVEMENTS = typeof window.createChurchCampaignStageDefinitions');
    expect(gamification).toContain("church_stage_award_");
    expect(gamification).toContain("badge.designVersion = 2");
    expect(gamification).toContain("badge.maxStars = 5");
    expect(gamification).toContain("完成1~5遍點亮1~5顆星");
    expect(gamification).not.toContain("badge_cat");
    expect(planSource).toContain("church_stage_completed_rounds_");
  });

  it("shows the current round star before lighting it on completion", () => {
    const utilsSource = readFileSync(join(root, "js", "utils.js"), "utf8");
    const cssSource = readFileSync(join(root, "index.css"), "utf8");
    expect(utilsSource).toContain("function getBadgeStarState");
    expect(utilsSource).toContain("getCampaignStageCurrentRound");
    expect(utilsSource).toContain("displayedStars = Math.min(maxStars");
    expect(utilsSource).toContain('isLit ? "badge-star--lit" : "badge-star--unlit"');
    expect(utilsSource).toContain('isLit ? "starFill" : "star"');
    expect(cssSource).toContain(".badge-star--lit");
    expect(cssSource).toContain(".badge-star--unlit");
    expect(cssSource).toContain(".badge-stars--compact");
    expect(cssSource).not.toContain("Ranked reading medals");
    expect(cssSource).not.toContain("tier-bronze");
    expect(cssSource).not.toContain("tier-legendary");
    expect(utilsSource).not.toContain('label: "青銅"');
    expect(utilsSource).not.toContain('label: "傳奇"');
    expect(utilsSource).toContain("function getBadgeFrameClass");
    expect(utilsSource).toContain("badge && badge.campaignStageNo");
    expect(utilsSource).toContain("campaign-medal-stage-");
    expect(cssSource).toContain("Campaign medal material is fixed by the award configured for each stage");
    expect(cssSource).toContain(".honor-badge-hex.campaign-medal-stage-1");
    expect(cssSource).toContain(".honor-badge-hex.campaign-medal-stage-10");
    expect(cssSource).toContain('.honor-badge-hex--locked[class*="campaign-medal-stage-"]');
    expect(utilsSource).toContain("const frameClass = getBadgeFrameClass(badge)");
    const badgeSpecs = [
      ["rock-badge.svg", "磐石"], ["iron-badge.svg", "鐵級"], ["copper-badge.svg", "銅級"],
      ["bronze-badge.svg", "青銅"], ["silver-badge.svg", "白銀"], ["gold-badge.svg", "黃金"],
      ["adamantine-badge.svg", "精金"], ["ophir-gold-badge.svg", "俄斐金"],
      ["fire-gold-badge.svg", "火煉金"], ["new-jerusalem-badge.svg", "新耶路撒冷"]
    ];
    badgeSpecs.forEach(([file, label]) => {
      const frame = readFileSync(join(root, "assets", "badges", "complete", file), "utf8");
      expect(frame).toContain("<" + "svg");
      expect(frame).toContain('viewBox="0 0 200 240"');
      expect(frame).toContain("<defs>");
      expect(frame).toContain("<linearGradient");
      expect(frame).toContain("<radialGradient");
      expect(frame).toContain("<filter");
      expect(frame).toContain("<feDropShadow");
      expect(frame).toContain("<text");
      expect(frame).toContain(`>${label}</text>`);
      const ids = new Set([...frame.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
      const references = [...frame.matchAll(/url\(#([^\)]+)\)/g)].map(match => match[1]);
      expect(ids.size).toBeGreaterThanOrEqual(8);
      expect(references.length).toBeGreaterThan(0);
      references.forEach(id => expect(ids.has(id), `Missing SVG definition #${id} in ${file}`).toBe(true));
      expect(cssSource).toContain(`assets/badges/complete/${file}`);
    });
    expect(cssSource).toContain('filter: grayscale(1) saturate(0)');

  });
});


describe("admin campaign round editor", () => {
  const editor = readFileSync(join(root, "js", "modules", "campaign-rule-editor.js"), "utf8");
  const css = readFileSync(join(root, "index.css"), "utf8");
  const db = readFileSync(join(root, "js", "db.js"), "utf8");
  const cleanupMigration = readFileSync(join(root, "supabase", "migrations", "0018_cleanup_removed_campaign_stages.sql"), "utf8");

  it("labels every date purpose and supports adding and removing rounds", () => {
    expect(editor).toContain("閱讀開始日期");
    expect(editor).toContain("閱讀結束日期");
    expect(editor).toContain("測驗／頒獎日期（選填）");
    expect(editor).toContain('id="campaign-add-stage"');
    expect(editor).toContain("data-remove-stage");
    expect(editor).toContain("renderStageRow");
    expect(editor).toContain("renderSegmentRow");
    expect(editor).toContain("若已有參加者，該輪進度與打卡紀錄會在發布後一併刪除");
    expect(css).toContain(".campaign-stage-columns");
    expect(css).toContain(".campaign-stage-remove");
  });

  it("publishes atomically to Supabase and removes deleted materialized stages", () => {
    expect(editor).toContain("db.publishCampaignRules(plan, next)");
    expect(editor).toContain("完成 Supabase 儲存驗證");
    expect(db).toContain('.rpc("publish_global_plan_rules"');
    expect(db).toContain('.select("id, rules, rule_version")');
    expect(db).toContain("materializedStageNumbers");
    expect(db).toContain("persistenceVerified");
    expect(cleanupMigration).toContain("cleanup_removed_church_campaign_stages");
    expect(cleanupMigration).toContain("DELETE FROM public.reading_plans");
    expect(cleanupMigration).toContain("DELETE FROM public.global_plans");
    expect(cleanupMigration).toContain("AFTER UPDATE OF rules");
    expect(cleanupMigration).toContain("parentCampaignId");
  });
});
