import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const bibleData = read("js/data/bible_data.js");
const verseCountsSrc = read("js/data/bible_verse_counts.js");
const bible = read("js/modules/bible.js");
const state = read("js/state.js");
const html = read("index.html");
const css = read("index.css");

describe("bible book English-name keys line up between bible_data.js and bible_verse_counts.js", () => {
  const bookEngs = [...bibleData.matchAll(/eng:\s*"([^"]+)"/g)].map(m => m[1]);
  const countsObjSrc = verseCountsSrc.match(/const BIBLE_VERSE_COUNTS = (\{.*\});/s)[1];
  const counts = JSON.parse(countsObjSrc);
  const countKeys = new Set(Object.keys(counts));

  it("has a BIBLE_VERSE_COUNTS entry for every book, keyed by the exact book.eng name", () => {
    // A single mismatched key (e.g. "Psalm" vs "Psalms") makes every lookup
    // for that book silently miss and fall back to a hardcoded default of
    // 30 verses — Psalm 23 (6 verses) showed 30 options in the verse picker
    // because of exactly this bug.
    const missing = bookEngs.filter(eng => !countKeys.has(eng));
    expect(missing).toEqual([]);
  });

  it("keeps 詩篇/Psalms' verse counts correct, in particular the short Psalm 23 (6 verses)", () => {
    expect(verseCountsSrc).toContain('"Psalms":[');
    expect(verseCountsSrc).not.toMatch(/"Psalm":\[/);
    const psalmCounts = counts["Psalms"];
    expect(psalmCounts).toBeTruthy();
    expect(psalmCounts.length).toBe(150);
    expect(psalmCounts[22]).toBe(6); // chapter 23, 0-indexed
    expect(psalmCounts[118]).toBe(176); // chapter 119, the longest psalm
  });

  it("falls back to 30 verses only when a book/chapter genuinely has no data, not due to a key typo", () => {
    expect(bible).toContain('BIBLE_VERSE_COUNTS[book.eng]');
    expect(bible).toContain("let totalVerses = 30;");
  });
});

describe("mobile Bible version picker access", () => {
  it("hides the top navbar's redundant version pill only on narrow screens", () => {
    expect(css).toMatch(/@media \(max-width: 420px\) \{\s*\n\s*\.reader-version-btn \{\s*\n\s*display: none;/);
  });

  it("wires the directory overlay's version badge as the mobile replacement entry point into the picker modal", () => {
    // Previously #bible-nav-version-badge had no click handler at all, so on
    // phones (where .reader-version-btn is display:none) there was no way
    // left to open #bible-version-picker-modal.
    expect(bible).toContain('document.getElementById("bible-nav-version-badge")');
    expect(bible).toContain('versionBadge.addEventListener("click"');
    expect(bible).toContain("window.openBibleVersionPicker();");
    expect(html).toContain('id="bible-nav-version-badge"');
  });

  it("keeps the directory overlay's version badge label in sync with the active version", () => {
    expect(bible).toMatch(/document\.getElementById\("bible-nav-version-badge"\)[\s\S]{0,40}if \(navBadge\) navBadge\.textContent = label;/);
    expect(state).toContain('document.getElementById("bible-nav-version-badge")');
  });
});

describe("English Bible chapter selector labels", () => {
  it("uses English book, chapter, verse, testament, and navigation labels for English translations", () => {
    expect(bible).toContain('const ENGLISH_BIBLE_VERSIONS = new Set(["ESV", "NIV", "NLT", "WEB"])');
    expect(bible).toContain('english ? "Select Book" : "選擇書卷"');
    expect(bible).toMatch(/english\s*\?\s*\{ book: "Book", chapter: "Chapter", verse: "Verse" \}/);
    expect(bible).toContain('usesEnglishReaderLabels() ? "Old Testament" : "舊約聖經"');
    expect(bible).toContain('usesEnglishReaderLabels() ? `Chapter ${i}` : `${i} 章`');
    expect(bible).toContain('getReaderBookLabel(b)');
  });

  it("refreshes selector labels immediately when the translation changes", () => {
    expect(bible).toMatch(/state\.readerState\.version = newVersion;[\s\S]{0,350}populateBookSelector/);
    expect(bible).toMatch(/populateBookSelector[\s\S]{0,180}populateChapterSelector\(\);[\s\S]{0,80}renderReaderPicker\(\)/);
  });

  it("does not mislabel English translations as CUV during initial paint", () => {
    expect(state).toContain('state.readerState.version === "RCUVTS" ? "RCUV" : state.readerState.version');
    expect(read("js/app.js")).toContain('version === "RCUVTS" ? "RCUV" : version');
    expect(bible).toContain('const label = version === "RCUVTS" ? "RCUV" : version');
    expect(bible).not.toContain('version === "CUNP" ? "CUNP" : (version === "RCUVTS" ? "RCUV" : "CUV")');
  });
});

describe("Bible translation switching integrity", () => {
  it("includes the selected translation in every chapter cache key", () => {
    expect(bibleData).toContain('function getBibleChapterCacheKey(bookEngName, chapter, translation)');
    expect(bibleData).toContain('`${String(translation || "CUNP").toUpperCase()}_${bookEngName}_${chapter}`');
    expect(bible).toContain('window.getBibleChapterCacheKey(book.eng, chapter, requestedVersion)');
  });

  it("requests only the selected translation instead of silently substituting another one", () => {
    expect(bibleData).toContain('fetchFromBolls(bookEngName, chapter, preferredVersion, bollsBookId)');
    expect(bibleData).not.toContain('[preferredVersion, "ESV", "NIV", "NLT", "CUNP", "CUV"]');
    expect(bibleData).not.toContain('[preferredVersion, "CUNP", "CUV", "CUVS"');
    expect(bibleData).toContain('throw new Error(`${preferredVersion} 譯本載入失敗');
  });

  it("ignores an older response after the user has selected another version", () => {
    expect(bible).toContain('let readerRenderRequestId = 0;');
    expect(bible).toContain('const renderRequestId = ++readerRenderRequestId;');
    expect(bible).toMatch(/requestIsStale[\s\S]{0,350}state\.readerState\?\.version[\s\S]{0,250}if \(requestIsStale\) return/);
  });

  it("shows a visible retry action and never caches placeholder chapters", () => {
    expect(bibleData).toContain("isPlaceholder: true");
    expect(bibleData).toContain("delete window._bibleChapterCache[cacheKey]");
    expect(bible).toContain("function renderReaderLoadRetryState");
    expect(bible).toContain("data-reader-load-retry");
    expect(bible).toContain("重新讀取");
    expect(bible).toContain("data && !data.isPlaceholder");
    expect(css).toContain(".reader-load-retry-state");
  });

  it("deduplicates an in-flight prefetch and visible chapter request", () => {
    expect(bibleData).toContain("window._bibleChapterInFlight[cacheKey]");
    expect(bibleData).toContain("const requestPromise = (async () => {");
    expect(bibleData).toContain("return await requestPromise");
    expect(bibleData).toContain("delete window._bibleChapterInFlight[cacheKey]");
  });

  it("shares one real network request for concurrent loads of the same chapter", async () => {
    let releaseFetch;
    let fetchCount = 0;
    const pendingResponse = new Promise(resolve => {
      releaseFetch = () => resolve({
        ok: true,
        json: async () => Array.from({ length: 11 }, (_, index) => ({
          verse: index + 1,
          text: `測試經文第${index + 1}節`
        }))
      });
    });
    const context = {
      window: {},
      console: { log() {}, warn() {}, error() {} },
      fetch: () => {
        fetchCount += 1;
        return pendingResponse;
      }
    };
    runInNewContext(bibleData, context);

    const first = context.window.fetchBibleChapter("Genesis", 2, "CUNP");
    const second = context.window.fetchBibleChapter("Genesis", 2, "CUNP");
    expect(fetchCount).toBe(1);

    releaseFetch();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.verses).toHaveLength(11);
    expect(secondResult).toBe(firstResult);
    expect(context.window._bibleChapterInFlight).toEqual({});
  });
});
