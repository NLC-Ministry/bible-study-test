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
