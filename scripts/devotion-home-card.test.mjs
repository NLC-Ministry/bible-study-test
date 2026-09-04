import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const home = readFileSync("js/modules/home.js", "utf8");
const plan = readFileSync("js/modules/plan.js", "utf8");
const iconManifest = JSON.parse(readFileSync("js/design/icon-manifest.json", "utf8"));

// 首頁「每日靈修」獨立卡片：故意跟上面「進行中的計畫」卡片（圍繞單一
// state.activePlan 畫進度條/百分比）完全分開，靈修計畫沒有「進度」這個概念。
//
// ⚠️ 靈修計畫也沒有「加入」這回事——不像一般讀經計畫要寫進 reading_plans
// （= state.activePlans）才算數，靈修計畫只有「這個人看不看得到」（daily_devotion
// 功能開關 + admin/pastor 例外）。卡片一定要查 state.globalPlans +
// isDevotionalPlanVisibleToUser()，查 state.activePlans 永遠是空的、卡片永遠
// 不會出現——這是實際發生過的 bug，見 js/modules/home.js findVisibleDevotionalPlan()。
describe("home dashboard: independent daily-devotion card", () => {
  it("index.html declares the card below the reading-plan card and above the daily-verse card, hidden by default", () => {
    const planCardIdx = html.indexOf('id="active-plan-summary"');
    const devoCardIdx = html.indexOf('id="devotion-home-card"');
    const verseCardIdx = html.indexOf('id="verse-card"');
    const announcementsIdx = html.indexOf('announcements-card');
    expect(planCardIdx).toBeGreaterThan(-1);
    expect(devoCardIdx).toBeGreaterThan(planCardIdx);
    // 使用者明確要求：不要跟每日金句卡並排在同一列搶版面，要出現在它上面。
    expect(verseCardIdx).toBeGreaterThan(devoCardIdx);
    expect(announcementsIdx).toBeGreaterThan(verseCardIdx);
    const cardTagStart = html.lastIndexOf("<div", devoCardIdx);
    const cardTag = html.slice(cardTagStart, html.indexOf(">", devoCardIdx) + 1);
    expect(cardTag).toContain("hidden");
    expect(html).toContain('id="devotion-home-content"');
  });

  it("the '進行中的計畫' widget never renders a devotional/group_meeting plan, even if state.activePlan briefly points at one (e.g. after previewing it)", () => {
    const idx = home.indexOf('const planSummaryDiv = document.getElementById("active-plan-summary");');
    expect(idx).toBeGreaterThan(-1);
    const body = home.slice(idx, idx + 700);
    expect(body).toContain('activePlanKind !== "devotional" && activePlanKind !== "group_meeting"');
    expect(body).toContain("if (hasRegularActivePlan) {");
  });

  it("looks up a devotional plan by visibility (state.globalPlans), not by join state (state.activePlans)", () => {
    const idx = home.indexOf("function findVisibleDevotionalPlan()");
    expect(idx).toBeGreaterThan(-1);
    const body = home.slice(idx, idx + 400);
    expect(body).toContain("state.globalPlans || []");
    expect(body).toContain('(gp.planKind || gp.plan_kind) === "devotional"');
    expect(body).toContain("window.isDevotionalPlanVisibleToUser(gp)");
    // 絕對不能又退回查 state.activePlans——那個陣列裡永遠不會有靈修計畫。
    expect(body).not.toContain("state.activePlans");
  });

  it("refreshDevotionHomeCard hides the card when there's no visible devotional plan, or no content for today", () => {
    const idx = home.indexOf("async function refreshDevotionHomeCard()");
    expect(idx).toBeGreaterThan(-1);
    const body = home.slice(idx, home.indexOf("\nwindow.openDevotionPlanFromDashboard", idx));
    expect(body).toContain("findVisibleDevotionalPlan()");
    expect(body).toContain('card.classList.add("hidden")');
    expect(body).toContain("db.getDevotionalPlan(planId)");
    // "今天" 是用 RPC 回傳的 today 去比對每一天的 displayDate，不是自己算日期，
    // 避免跟資料庫（台北時區）的今天定義兜不起來。
    expect(body).toContain("days.find(d => d.displayDate === data.today)");
    // 過期/未開課、沒有 today 那一天內容 → 也是整塊藏起來，不是顯示殘缺的卡片。
    expect(body).toMatch(/if \(!todayRow\) \{\s*\/\/[^\n]*\n\s*card\.classList\.add\("hidden"\)/);
  });

  it("shows a dev-mode hint (\"只有你看得到\") when the feature flag is off and only admin/pastor can see it", () => {
    const idx = home.indexOf("const isDevMode =");
    expect(idx).toBeGreaterThan(-1);
    const body = home.slice(idx, idx + 1700);
    expect(body).toContain("window.isDevotionalPlanDevMode(plan)");
    expect(body).toContain("devotion-home-row__dev-hint");
    expect(body).toContain("只有你看得到");
  });

  it("only shows the video hint when today's entry actually has a video, using the shared video icon", () => {
    const idx = home.indexOf("const hasVideo =");
    expect(idx).toBeGreaterThan(-1);
    const body = home.slice(idx, idx + 900);
    expect(body).toContain("todayRow.videoUrl");
    expect(body).toContain('hasVideo ? `<span class="devotion-home-row__video-hint">');
    expect(body).toContain('data-icon="video"');
    expect(iconManifest.video).toBe("Video");
  });

  it("tapping the card resets the devotion viewer to today and previews the plan the same way the plan list does (no join step exists)", () => {
    const idx = home.indexOf("window.openDevotionPlanFromDashboard = function");
    expect(idx).toBeGreaterThan(-1);
    const body = home.slice(idx, idx + 500);
    expect(body).toContain("findVisibleDevotionalPlan()");
    expect(body).toContain("window.resetDevotionViewerDay()");
    expect(body).toContain("window.previewDevotionalPlanAsMember(plan.globalPlanId || plan.id)");

    expect(plan).toContain("function resetDevotionViewerDay()");
    expect(plan).toContain("window.resetDevotionViewerDay = resetDevotionViewerDay;");
  });
});

// 每日靈修／小組經營週計畫沒有「每週讀經安排」／「重設進度」的概念：這兩顆按鈕
// 只在點開「...」選單當下依這份計畫的種類決定要不要藏起來，不能只在
// initPlanControls 跑一次就定案（那樣切換到別份一般計畫時按鈕不會再顯示回來）。
describe("shared plan-options dropdown hides viewer-only actions per plan kind", () => {
  it("refreshPlanOptionsMenuForKind hides the weekly-schedule and reset-progress buttons only for devotional/group_meeting plans", () => {
    const idx = plan.indexOf("function refreshPlanOptionsMenuForKind(plan)");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, idx + 700);
    expect(body).toContain('kind === "devotional" || kind === "group_meeting"');
    expect(body).toContain('scheduleBtn.style.display = isViewerOnlyPlan ? "none" : ""');
    expect(body).toContain('resetBtn.style.display = isViewerOnlyPlan ? "none" : ""');
  });

  it("is re-evaluated every time the dropdown is opened, not once at plan-detail entry", () => {
    const idx = plan.indexOf('optionsBtn.addEventListener("click"');
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, idx + 300);
    expect(body).toContain("refreshPlanOptionsMenuForKind(state.activePlan)");
  });
});

// 靈修／小組聚會週計畫從「探索計畫」搬到「我的計畫」：這兩種計畫沒有「加入」，
// 放在「探索計畫」（本來是給人「加入」用的清單）位置不合理，改成跟已加入的一般
// 計畫一起出現在「我的計畫」，用同一份 buildViewerOnlyPlanCard 卡片（沒有進度條、
// 只有「預覽內容」按鈕），兩份清單才不會各自維護一份、之後行為兜不起來。
describe("devotional/group_meeting plans live in 我的計畫, not 探索計畫", () => {
  it("renderPresetPlansList's visible-plan filter excludes both kinds outright", () => {
    const idx = plan.indexOf("function renderPresetPlansList()");
    expect(idx).toBeGreaterThan(-1);
    const filterIdx = plan.indexOf("const visiblePlans = sourcePlans.filter", idx);
    expect(filterIdx).toBeGreaterThan(idx);
    const body = plan.slice(filterIdx, filterIdx + 900);
    expect(body).toContain('planKind === "devotional" || planKind === "group_meeting"');
  });

  it("renderJoinedPlansList merges visible devotional/group_meeting plans from state.globalPlans alongside real joined plans", () => {
    const idx = plan.indexOf("function renderJoinedPlansList()");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, plan.indexOf("\nfunction formatCampaignReadingRange", idx));
    expect(body).toContain("const viewerOnlyPlans = filter ===");
    expect(body).toContain("state.globalPlans || []");
    expect(body).toContain('kind !== "devotional" && kind !== "group_meeting"');
    expect(body).toContain("buildViewerOnlyPlanCard(plan)");
    // 空清單判斷要把這批合併算進去，不然「我的計畫」裡只有靈修/小組計畫、沒有
    // 一般計畫時，會被誤判成空清單顯示「快去探索計畫加入」的錯誤文案。
    expect(body).toContain("plansToRender.length === 0 && viewerOnlyPlans.length === 0");
  });

  it("buildViewerOnlyPlanCard has no progress bar / join actions / preview button — tapping anywhere on the card opens it directly", () => {
    const idx = plan.indexOf("function buildViewerOnlyPlanCard(plan)");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, plan.indexOf("\nfunction renderJoinedPlansList", idx));
    expect(body).not.toContain("progress-bar");
    expect(body).not.toContain("solo-join");
    // 一顆「預覽內容」按鈕跟整張卡片可點擊是重複的功能，使用者明確說多餘——
    // 拿掉按鈕，只留 card.onclick。
    expect(body).not.toContain("viewer-open");
    expect(body).not.toContain("renderPlanCardActions");
    expect(body).toContain("card.onclick = () => {");
    expect(body).toContain("window.previewDevotionalPlanAsMember(plan.globalPlanId || plan.id)");
    expect(body).toContain("window.previewGroupMeetingPlanAsMember(plan.globalPlanId || plan.id)");
    expect(body).toContain("開發中・只有你看得到");
  });
});

// 計畫分頁側欄「每日陪你靈修」歡迎卡（index.html 裡的靜態文案：「歡迎加入教會
// 季度速讀挑戰！點擊頂部 探索計畫...」）：原本「我的計畫」／「探索計畫」分頁
// 一律顯示，但這句話是給完全沒有任何計畫的人看的——只要已經有任何一種計畫
// （一般讀經、每日靈修、小組聚會都算），繼續顯示就顯得多餘/矛盾。
describe("計畫分頁側欄「每日陪你靈修」歡迎卡：只在完全沒有任何計畫時才顯示", () => {
  it("index.html still has the static welcome copy inside #plan-sidebar-info-card", () => {
    const idx = html.indexOf('id="plan-sidebar-info-card"');
    expect(idx).toBeGreaterThan(-1);
    const body = html.slice(idx, idx + 700);
    expect(body).toContain("每日陪你靈修");
    expect(body).toContain("探索計畫");
  });

  it("userHasNoPlanAtAll checks state.activePlans plus visible devotional/group_meeting plans in state.globalPlans", () => {
    const idx = plan.indexOf("function userHasNoPlanAtAll()");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, plan.indexOf("\nfunction updatePlanSidebarIntroCardVisibility", idx));
    expect(body).toContain("(state.activePlans || []).length > 0");
    expect(body).toContain('(gp.planKind || gp.plan_kind) === "devotional" && isDevotionalPlanVisibleToUser(gp)');
    expect(body).toContain('(gp.planKind || gp.plan_kind) === "group_meeting"');
  });

  it("updatePlanSidebarIntroCardVisibility keeps the 已結束 tab always hidden, and is called from both renderJoinedPlansList and renderPresetPlansList", () => {
    const idx = plan.indexOf("function updatePlanSidebarIntroCardVisibility()");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, idx + 600);
    expect(body).toContain('if (filter === "completed")');
    expect(body).toContain('sidebarCard.classList.toggle("hidden", !userHasNoPlanAtAll())');

    const joinedIdx = plan.indexOf("function renderJoinedPlansList()");
    expect(plan.slice(joinedIdx, joinedIdx + 700)).toContain("updatePlanSidebarIntroCardVisibility();");
    const presetIdx = plan.indexOf("function renderPresetPlansList()");
    expect(plan.slice(presetIdx, presetIdx + 400)).toContain("updatePlanSidebarIntroCardVisibility();");
  });
});
