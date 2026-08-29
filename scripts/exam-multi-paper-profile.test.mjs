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
