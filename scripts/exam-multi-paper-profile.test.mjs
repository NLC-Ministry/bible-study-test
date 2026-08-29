import { describe, expect, it } from "vitest";
import fs from "node:fs";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("多試卷首頁與個人紀錄", () => {
  it("資料庫清單只回傳登入者自己的 attempt，且個人紀錄只列正式版", () => {
    const sql = read("supabase/migrations/0123_exam_member_paper_lists.sql");
    expect(sql).toContain("user_id = p_actor_id");
    expect(sql).toContain("pr.mode = 'live'");
    expect(sql).toContain("attempt_kind = 'official'");
    expect(sql).toContain("attempt_kind = 'practice'");
  });

  it("首頁使用多卡片 RPC，舊資料庫仍能退回單卡片入口", () => {
    const home = read("js/modules/home.js");
    expect(home).toContain("db.getExamHomeExams()");
    expect(home).toContain("db.getExamHomeBanner()");
    expect(home).toContain('data-exam-paper-id');
  });

  it("個人分頁將正式與重作紀錄分開標示", () => {
    const profile = read("js/modules/profile.js");
    expect(profile).toContain("正式作答：");
    expect(profile).toContain("重作練習：");
    expect(profile).toContain("不列入正式成績");
  });
});

describe("重作練習獨立寬限期", () => {
  const sql = read("supabase/migrations/0124_exam_practice_grace_period.sql");
  it("正式關閉只收 official，練習期限為活動結束後一天", () => {
    expect(sql).toContain("attempt_kind='official' AND status='in_progress'");
    expect(sql).toContain("close_at + INTERVAL '1 day'");
    expect(sql).toContain("pr.status IN('published','closed')");
    expect(sql).toContain("a.attempt_kind='practice' AND a.status='in_progress'");
    expect(sql).toContain("a.attempt_kind='practice' AND a.submit_reason='auto_close'");
  });
  it("練習的開始、儲存與暫時完成都使用同一期限", () => {
    expect(sql.match(/_exam_practice_close_at/g)?.length).toBeGreaterThanOrEqual(8);
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.exam_start_practice");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.exam_save_progress");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.exam_mark_practice_complete");
  });
});

describe("簡答分段批次批改", () => {
  const sql = read("supabase/migrations/0125_exam_batch_grading.sql");
  const exam = read("js/modules/exam.js");
  it("資料庫整批驗證且只接受正式作答", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.exam_grade_answers_batch");
    expect(sql).toContain("a.attempt_kind='official'");
    expect(sql).toContain("exam_results_locked");
    expect(sql).toContain("exam_batch_validation_failed");
  });
  it("畫面只送出本輪有修改的卡片且不整頁重繪", () => {
    expect(exam).toContain('.exam-admin__grade-card.is-dirty');
    expect(exam).toContain("儲存本次修改（${count}）");
    expect(exam).toContain("db.gradeExamAnswersBatch(paperId, grades)");
    expect(exam).not.toContain("renderExamGrading(host, paperId, false, paperStatus)");
  });
  it("未作答一鍵歸零只處理待批且空白的簡答", () => {
    expect(exam).toContain("未作答全部給 0 分");
    expect(exam).toContain('db.getExamGradingQueue(paperId, "pending")');
    expect(exam).toContain('item.awardedPoints == null');
    expect(exam).toContain('String(item.response).trim() === ""');
    expect(exam).toContain('points: 0, comment: "未作答"');
  });
});
