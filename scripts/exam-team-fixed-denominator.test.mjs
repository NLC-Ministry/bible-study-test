import { describe,expect,it } from "vitest";
import fs from "node:fs";

const sql=fs.readFileSync(new URL("../supabase/migrations/0129_exam_team_fixed_denominator.sql",import.meta.url),"utf8");
const ui=fs.readFileSync(new URL("../js/modules/exam.js",import.meta.url),"utf8");

describe("測驗團隊固定分母",()=>{
  it("使用隊伍 division 而不是已完成人數計算平均",()=>{
    expect(sql).toContain("::numeric/rt.division");
    expect(sql).toContain("PARTITION BY ranked.division ORDER BY ranked.avg_total DESC");
    expect(sql).toContain("a.reading_team_id=rt.id");
  });
  it("介面明確說明 3 人除 3、6 人除 6",()=>{
    expect(ui).toContain("3 人隊除以 3、6 人隊除以 6");
    expect(ui).toContain("平均（總分÷${size}）");
  });
});
