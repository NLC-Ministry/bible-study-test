import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const grading = readFileSync("js/modules/grading.js", "utf8");

// Regression: _mirror() used to write a fresh __savedAt timestamp to the L1
// localStorage mirror unconditionally, every time the grader navigated away
// from an attempt (openAttempt's pre-switch handler, _onHide, beforeunload)
// — even when nothing had actually been edited. Since openAttempt() decides
// "local vs server draft" purely by comparing timestamps, that phantom,
// content-identical mirror could out-rank a genuinely newer and more
// complete server-side draft on the next visit: the row got permanently
// stuck showing "⚠ 有未存修改" despite no real edits, and previously
// completed scores could revert to an earlier/blank state, tripping
// t.missing and disabling the submit button.
describe("grading.js does not fabricate unsaved-changes state from mere navigation", () => {
  it("_mirror() only persists to localStorage when the current attempt is actually dirty", () => {
    const idx = grading.indexOf("_mirror() {");
    expect(idx).toBeGreaterThan(-1);
    const body = grading.slice(idx, grading.indexOf("_clearLocal", idx));
    expect(body).toContain("if (!this.dirty.has(this.currentId)) return;");
    // the guard must come before the localStorage.setItem call, not after
    expect(body.indexOf("if (!this.dirty.has(this.currentId)) return;"))
      .toBeLessThan(body.indexOf("localStorage.setItem"));
  });
});
