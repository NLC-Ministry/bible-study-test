import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const css = readFileSync("index.css", "utf8");
const db = readFileSync("js/db.js", "utf8");
const bible = readFileSync("js/modules/bible.js", "utf8");
const profile = readFileSync("js/modules/profile.js", "utf8");
const migration = readFileSync("supabase/migrations/0139_highlights_cloud_sync.sql", "utf8");

describe("我的螢光＆筆記 review page", () => {
  it("adds a root menu row that opens the highlights-notes subpage", () => {
    expect(html).toContain('data-profile-open="highlights-notes"');
    expect(html).toContain('id="profile-tab-content-highlights-notes"');
  });

  it("gives every profile subpage its own full-screen header with a back button", () => {
    for (const key of ["exams", "preferences", "badges", "highlights-notes"]) {
      const marker = `id="profile-tab-content-${key}"`;
      const idx = html.indexOf(marker);
      expect(idx, `${marker} not found`).toBeGreaterThan(-1);
      const slice = html.slice(idx, idx + 400);
      expect(slice, `${key} subpage header`).toContain("profile-subpage__header");
      expect(slice, `${key} subpage back button`).toContain("data-profile-close");
    }
  });

  it("removes the old segmented tab-strip in favor of list-style root rows", () => {
    expect(html).not.toContain("profile-tabs-list");
    expect(html).not.toContain("profile-tab-trigger");
    expect(css).not.toContain(".profile-tab-trigger");
  });

  it("supports two sub-tabs (highlights/notes) and two sort modes", () => {
    expect(html).toContain('data-hn-tab="highlights"');
    expect(html).toContain('data-hn-tab="notes"');
    expect(html).toContain('data-hn-sort="recent"');
    expect(html).toContain('data-hn-sort="bible-order"');
  });

  it("wires openProfileDetail/closeProfileDetail as globals used by the shared tab-root-reset logic", () => {
    expect(profile).toContain("window.openProfileDetail = openProfileDetail");
    expect(profile).toContain("window.closeProfileDetail = closeProfileDetail");
  });
});

describe("verse notes: fetch-all query for the review page", () => {
  it("paginates via fetchAllRows instead of a one-shot query", () => {
    const idx = db.indexOf("async getAllVerseNotesForUser()");
    expect(idx).toBeGreaterThan(-1);
    const body = db.slice(idx, idx + 700);
    expect(body).toContain("fetchAllRows(");
    expect(body).toContain('.from("verse_notes")');
  });
});

describe("highlights: cloud sync", () => {
  it("adds a cloud-synced highlights table symmetric to verse_notes", () => {
    expect(migration).toContain("DROP TABLE IF EXISTS public.highlights");
    expect(migration).toContain("book TEXT NOT NULL");
    expect(migration).toContain("chapter INTEGER NOT NULL");
    expect(migration).toContain("verse INTEGER NOT NULL");
    expect(migration).toContain("color TEXT NOT NULL");
    expect(migration).toContain("UNIQUE(user_id, book, chapter, verse)");
    expect(migration).toContain("highlights_manage_own");
  });

  it("db.js exposes save/delete/fetch-all helpers, fetch-all paginated", () => {
    expect(db).toContain("async saveHighlight(bookName, chapter, verse, color)");
    expect(db).toContain("async deleteHighlight(bookName, chapter, verse)");
    const idx = db.indexOf("async fetchAllHighlights()");
    expect(idx).toBeGreaterThan(-1);
    expect(db.slice(idx, idx + 500)).toContain("fetchAllRows(");
  });

  it("loadUserData merges server highlights into state.highlights without discarding unsynced local edits", () => {
    expect(db).toContain("state.highlights = { ...serverHighlights, ...state.highlights }");
  });

  it("bible.js keeps the instant local write and adds a best-effort background cloud sync", () => {
    expect(bible).toContain('localStorage.setItem("bible_highlights", JSON.stringify(state.highlights))');
    expect(bible).toContain("db.saveHighlight(bookName, chapter, verse, normalizedColor)");
    expect(bible).toContain("db.deleteHighlight(bookName, chapter, verse)");
  });
});
