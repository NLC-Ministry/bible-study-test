import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migration = readFileSync(join(root, "supabase/migrations/0122_exam_practice_review_and_auto_close.sql"), "utf8");
const edge = readFileSync(join(root, "supabase/functions/nlc-data/index.ts"), "utf8");
const db = readFileSync(join(root, "js/db.js"), "utf8");
const exam = readFileSync(join(root, "js/modules/exam.js"), "utf8");

describe("大測驗正式首考與重作練習隔離", () => {
  it("回填舊資料並以 partial unique indexes 保留一份正式與一份練習", () => {
    expect(migration).toContain("SET attempt_kind = 'official'");
    expect(migration).toContain("CREATE UNIQUE INDEX idx_exam_attempts_one_official");
    expect(migration).toContain("CREATE UNIQUE INDEX idx_exam_attempts_one_practice");
  });

  it("正式統計、批改、公布與通知都明確限制 official", () => {
    expect(migration).toMatch(/exam_get_stats[\s\S]*?a\.attempt_kind='official'/);
    expect(migration).toMatch(/exam_get_grading_queue[\s\S]*?a\.attempt_kind='official'/);
    expect(migration).toMatch(/exam_publish_results[\s\S]*?attempt_kind='official'/);
    expect(migration).toMatch(/INSERT INTO public\.exam_notifications[\s\S]*?a\.attempt_kind='official'/);
  });

  it("published 期間只存答案且關閉前禁止評分與公布", () => {
    expect(migration).toMatch(/exam_submit_attempt[\s\S]*?auto_score=NULL,manual_score=NULL,total_score=NULL/);
    expect(migration).toContain("exam_scoring_before_close");
    expect(migration).toContain("exam_grading_before_close");
    expect(migration).toContain("exam_results_before_close");
  });

  it("手動與排程關閉共用 server helper，且 pg_cron 每分鐘補關閉", () => {
    expect(migration).toContain("_exam_close_paper");
    expect(migration).toContain("_exam_close_expired_papers");
    expect(migration).toContain("cron.schedule('exam-auto-close','* * * * *'");
  });

  it("練習 RPC 已 allowlist 且前端明確傳 attemptKind", () => {
    for (const fn of ["exam_start_practice", "exam_mark_practice_complete", "exam_get_practice_records", "exam_get_practice_detail"]) {
      expect(edge).toContain(`"${fn}"`);
    }
    expect(db).toContain('p_attempt_kind: attemptKind === "practice" ? "practice" : "official"');
    expect(exam).toContain('重作模式｜不列入正式成績');
  });
});
