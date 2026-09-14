import { describe, expect, it } from "vitest";
import fs from "node:fs";

// Normalize CRLF to LF: this file is checked out with Windows line endings,
// and loadNormalizeMemberName() below extracts a function body by searching
// for a literal "\n}\n" boundary — a "\r\n}\r\n" sequence never matches that,
// so the search silently fails (indexOf returns -1) and the extracted slice
// comes out empty, blowing up new Function() with a syntax error.
const db = fs.readFileSync("js/db.js", "utf8").replace(/\r\n/g, "\n");
const session = fs.readFileSync("supabase/functions/nlc-session/index.ts", "utf8").replace(/\r\n/g, "\n");
const data = fs.readFileSync("supabase/functions/nlc-data/index.ts", "utf8").replace(/\r\n/g, "\n");

function loadNormalizeMemberName() {
  const start = session.indexOf("function normalizeMemberName(");
  const end = session.indexOf("\n}\n", start) + 2;
  const source = session.slice(start, end).replace("value: unknown", "value");
  return new Function(`return (${source});`)();
}

describe("Member Hub canonical name sync", () => {
  it("does not write profile identity while saving reading progress", () => {
    const saveLogStart = db.indexOf("async saveReadingLog(");
    const syncMethodStart = db.indexOf("async syncProfileStatsToSupabase()", saveLogStart);
    expect(db.slice(saveLogStart, syncMethodStart)).not.toContain("this.syncProfileStatsToSupabase()");
  });

  it("blocks stale profile writes for a Hub-managed name", () => {
    expect(db).toContain('if (lockedFields.has("name"))');
    expect(db).toContain('reason: "member_hub_managed_name"');
    expect(data).toContain('canonical_source: "member_hub"');
    expect(data.indexOf("if (hubIdentity)"))
      .toBeLessThan(data.indexOf("const nextName = payload.name"));
  });

  it("fetches current UserInfo on every real session sync", () => {
    expect(session).toContain("let freshUserinfo: any = null");
    expect(session).toContain("freshUserinfo = fullUserinfo");
    expect(session).not.toContain("UserInfo from token missing sub");
  });

  it("rejects blank, oversized, control-character, and mojibake names", () => {
    const normalizeMemberName = loadNormalizeMemberName();
    expect(normalizeMemberName("   ")).toBeNull();
    expect(normalizeMemberName("A\u0000B")).toBeNull();
    expect(normalizeMemberName("王\uFFFD明")).toBeNull();
    expect(normalizeMemberName("Fran\u00C3\u00A7ois")).toBeNull();
    expect(normalizeMemberName("王".repeat(41))).toBeNull();
    expect(normalizeMemberName(" 王 小明 ")).toBe("王 小明");
    expect(normalizeMemberName("Ethan D")).toBe("Ethan D");
  });

  it("no longer tracks a name-review approval flag on the canonical name projection", () => {
    expect(session).not.toContain("canonicalNameChanged");
    expect(session).not.toContain("name_review_approved");
  });
});
