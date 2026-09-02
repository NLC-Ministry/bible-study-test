import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const auth = readFileSync("js/auth.js", "utf8");
const examEntry = readFileSync("js/exam-entry.js", "utf8");
const gradeEntry = readFileSync("js/grade-entry.js", "utf8");
const grading = readFileSync("js/modules/grading.js", "utf8");

// Regression: exam-entry.js/grade-entry.js used to redirect to
// `/?return=<back>` when not logged in, and the auth_continuation system's
// returnTo (the mechanism actually designed for "come back here after
// login") was written on login-initiation but never read back in
// handleCallback() — so every login, everywhere, always landed on the bare
// app root instead of wherever the user actually was.
describe("login continuation actually returns the user to where they were", () => {
  it("handleCallback() reads the stored continuation and redirects to returnTo when it differs from the current page", () => {
    const idx = auth.indexOf("async handleCallback()");
    expect(idx).toBeGreaterThan(-1);
    const body = auth.slice(idx, auth.indexOf("\n  },", idx));
    expect(body).toContain("parseAuthContinuation(this._getFlowItem(this.keys.continuation))");
    expect(body).toContain("window.location.replace(returnTo)");
  });

  it("no file still builds the dead ?return= query param that nothing reads", () => {
    for (const [name, source] of [["auth.js", auth], ["exam-entry.js", examEntry], ["grade-entry.js", gradeEntry], ["grading.js", grading]]) {
      expect(source, name).not.toMatch(/\/\?return=/);
    }
  });

  it("exam-entry.js and grade-entry.js's not-logged-in boot check goes through startInteractiveLogin with a returnTo continuation", () => {
    for (const [name, source] of [["exam-entry.js", examEntry], ["grade-entry.js", gradeEntry]]) {
      const idx = source.indexOf("if (!loggedIn)");
      expect(idx, name).toBeGreaterThan(-1);
      const body = source.slice(idx, idx + 500);
      expect(body, name).toContain("auth.startInteractiveLogin({ intent: 'login', returnTo: location.pathname + location.search })");
    }
  });

  it("grading.js's re-login banner also uses startInteractiveLogin instead of a raw redirect", () => {
    const idx = grading.indexOf("[data-g-relogin]");
    expect(idx).toBeGreaterThan(-1);
    const body = grading.slice(idx, idx + 400);
    expect(body).toContain("window.auth?.startInteractiveLogin");
    expect(body).toContain('intent: "login"');
  });
});
