import{describe,expect,it}from"vitest";
import fs from"node:fs";
const sql=fs.readFileSync(new URL("../supabase/migrations/0130_exam_full_paper_result.sql",import.meta.url),"utf8");
const ui=fs.readFileSync(new URL("../js/modules/exam.js",import.meta.url),"utf8");
describe("查看完整試卷",()=>{
  it("以全部題目為主並保留未作答題",()=>{
    expect(sql).toContain("FROM public.exam_questions q LEFT JOIN public.exam_answers ea");
    expect(sql).toContain("ea.attempt_id=at.id");
  });
  it("答對與答錯題都顯示完整題目和正解",()=>{
    expect(ui).toContain("function examResultQuestionBody(a)");
    expect(ui).toContain('exam-result__row--correct');
    expect(ui).toContain("正確答案：");
    expect(ui).not.toContain("if (!graded || ok)");
  });
  it("答錯題以紅色正確答案取代原錯誤答案列",()=>{
    expect(ui).toContain("exam-result__corrected");
    expect(ui).toContain("正確答案：");
  });
});
