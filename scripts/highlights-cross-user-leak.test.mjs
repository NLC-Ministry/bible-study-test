import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const db = readFileSync("js/db.js", "utf8");
const auth = readFileSync("js/auth.js", "utf8");

// Bug: state.highlights is a flat, non-user-namespaced localStorage cache
// ("bible_highlights"). loadUserData() merges it with local-wins-over-server
// priority (so a highlight just tapped, not yet synced, isn't clobbered by a
// slightly stale server response). If a different profile logs in on the
// same device/browser without that cache ever being cleared, the merge
// treats the previous person's leftover local highlights as "my own
// not-yet-synced edits" and keeps showing them — and editing one of those
// entries would push it to the server under the new account's user_id.
describe("highlights: same-device account switch does not leak the previous user's records", () => {
  it("logout() clears the highlight cache and its owner tag, not just reading-plan data", () => {
    const idx = auth.indexOf('async logout()');
    expect(idx).toBeGreaterThan(-1);
    const body = auth.slice(idx, auth.indexOf("_finishLocalLogout", idx));
    expect(body).toContain('localStorage.removeItem("bible_highlights")');
    expect(body).toContain('localStorage.removeItem("bible_highlight_timestamps")');
    expect(body).toContain('localStorage.removeItem("bible_highlights_owner")');
  });

  it("loadUserData() discards the local highlight cache when its recorded owner doesn't match the signed-in user", () => {
    const idx = db.indexOf('const highlightsOwnerKey = "bible_highlights_owner"');
    expect(idx).toBeGreaterThan(-1);
    const body = db.slice(idx, idx + 700);
    expect(body).toContain("cachedHighlightsOwner !== user.id");
    expect(body).toContain("state.highlights = {};");
    expect(body).toContain("state.highlightTimestamps = {};");
    // must run before the local-wins-over-server merge, not after
    expect(body.indexOf("cachedHighlightsOwner !== user.id"))
      .toBeLessThan(db.indexOf("state.highlights = { ...serverHighlights, ...state.highlights }"));
  });
});
