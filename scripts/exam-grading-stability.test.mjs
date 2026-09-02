import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const grading = readFileSync("js/modules/grading.js", "utf8");

describe("grading.js: 'save draft' only claims success when it actually saved", () => {
  it("_flushDraft returns a success boolean instead of being fire-and-forget", () => {
    const idx = grading.indexOf("async _flushDraft(reason, opts = {})");
    expect(idx).toBeGreaterThan(-1);
    const body = grading.slice(idx, grading.indexOf("\n  }\n", idx));
    // every exit path must report whether it actually saved
    expect(body).toContain("return true;");
    expect((body.match(/return false;/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("the save-draft button only toasts success when _flushDraft reported success", () => {
    const idx = grading.indexOf('r.querySelector("[data-g-draft]")');
    expect(idx).toBeGreaterThan(-1);
    const body = grading.slice(idx, idx + 400);
    expect(body).toContain("const saved = await this._flushDraft(");
    expect(body).toContain("if (saved) toast(");
    // regression guard: it must not unconditionally toast success right after awaiting
    expect(body).not.toMatch(/await this\._flushDraft\([^;]*\);\s*\n\s*e\.currentTarget\.disabled[^;]*;\s*\n\s*toast\("已儲存草稿"\);/);
  });
});

describe("grading.js: openAttempt() ignores stale results from superseded navigation", () => {
  it("stamps a token per call and drops results once a newer call has started", () => {
    const idx = grading.indexOf("async openAttempt(id, opts = {})");
    expect(idx).toBeGreaterThan(-1);
    const body = grading.slice(idx, grading.indexOf("this.render();", idx));
    expect(body).toContain("const myToken = ++this._openToken;");
    // must check after both await points that can race: the pre-switch draft
    // flush, and the sheet fetch
    const checks = (body.match(/if \(myToken !== this\._openToken\) return;/g) || []).length;
    expect(checks).toBeGreaterThanOrEqual(2);
  });
});
