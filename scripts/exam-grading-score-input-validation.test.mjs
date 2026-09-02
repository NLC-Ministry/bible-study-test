import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const utils = readFileSync("js/utils.js", "utf8");
const grading = readFileSync("js/modules/grading.js", "utf8");
const exam = readFileSync("js/modules/exam.js", "utf8");

describe("exam grading score input validation", () => {
  it("clampScoreInput clears non-numeric input and clamps to [min, max]", () => {
    const idx = utils.indexOf("function clampScoreInput(el)");
    expect(idx).toBeGreaterThan(-1);
    const body = utils.slice(idx, idx + 700);
    expect(body).toContain('el.value = "";'); // non-numeric -> cleared, not left invalid
    expect(body).toContain("clamped < min");
    expect(body).toContain("clamped > max");
    expect(utils).toContain("window.clampScoreInput = clampScoreInput");
  });

  it("grade.html's score input clamps on blur before it can be submitted", () => {
    const idx = grading.indexOf('r.querySelectorAll("[data-q-score]")');
    expect(idx).toBeGreaterThan(-1);
    const body = grading.slice(idx, idx + 400);
    expect(body).toContain('addEventListener("blur"');
    expect(body).toContain("window.clampScoreInput(el)");
  });

  it("the legacy admin grading tab's score input clamps on blur too", () => {
    const idx = exam.indexOf('card.querySelectorAll(\'[data-g="points"], [data-g="comment"]\')');
    expect(idx).toBeGreaterThan(-1);
    const body = exam.slice(idx, idx + 500);
    expect(body).toContain('[data-g="points"]');
    expect(body).toContain('addEventListener("blur"');
    expect(body).toContain("window.clampScoreInput(e.currentTarget)");
  });
});
