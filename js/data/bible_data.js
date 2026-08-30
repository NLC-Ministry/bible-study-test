// Bible Data: 66 Books of the Chinese Union Version (CUV)
const BIBLE_BOOKS = [
  // Old Testament (39 books)
  { id: 1, name: "創世記", abbrev: "創", eng: "Genesis", chapters: 50, section: "old" },
  { id: 2, name: "出埃及記", abbrev: "出", eng: "Exodus", chapters: 40, section: "old" },
  { id: 3, name: "利未記", abbrev: "利", eng: "Leviticus", chapters: 27, section: "old" },
  { id: 4, name: "民數記", abbrev: "民", eng: "Numbers", chapters: 36, section: "old" },
  { id: 5, name: "申命記", abbrev: "申", eng: "Deuteronomy", chapters: 34, section: "old" },
  { id: 6, name: "約書亞記", abbrev: "書", eng: "Joshua", chapters: 24, section: "old" },
  { id: 7, name: "士師記", abbrev: "士", eng: "Judges", chapters: 21, section: "old" },
  { id: 8, name: "路得記", abbrev: "得", eng: "Ruth", chapters: 4, section: "old" },
  { id: 9, name: "撒母耳記上", abbrev: "撒上", eng: "1 Samuel", chapters: 31, section: "old" },
  { id: 10, name: "撒母耳記下", abbrev: "撒下", eng: "2 Samuel", chapters: 24, section: "old" },
  { id: 11, name: "列王紀上", abbrev: "王上", eng: "1 Kings", chapters: 22, section: "old" },
  { id: 12, name: "列王紀下", abbrev: "王下", eng: "2 Kings", chapters: 25, section: "old" },
  { id: 13, name: "歷代志上", abbrev: "代上", eng: "1 Chronicles", chapters: 29, section: "old" },
  { id: 14, name: "歷代志下", abbrev: "代下", eng: "2 Chronicles", chapters: 36, section: "old" },
  { id: 15, name: "以斯拉記", abbrev: "拉", eng: "Ezra", chapters: 10, section: "old" },
  { id: 16, name: "尼希米記", abbrev: "尼", eng: "Nehemiah", chapters: 13, section: "old" },
  { id: 17, name: "以斯帖記", abbrev: "帖", eng: "Esther", chapters: 10, section: "old" },
  { id: 18, name: "約伯記", abbrev: "伯", eng: "Job", chapters: 42, section: "old" },
  { id: 19, name: "詩篇", abbrev: "詩", eng: "Psalms", chapters: 150, section: "old" },
  { id: 20, name: "箴言", abbrev: "箴", eng: "Proverbs", chapters: 31, section: "old" },
  { id: 21, name: "傳道書", abbrev: "傳", eng: "Ecclesiastes", chapters: 12, section: "old" },
  { id: 22, name: "雅歌", abbrev: "歌", eng: "Song of Solomon", chapters: 8, section: "old" },
  { id: 23, name: "以賽亞書", abbrev: "賽", eng: "Isaiah", chapters: 66, section: "old" },
  { id: 24, name: "耶利米書", abbrev: "耶", eng: "Jeremiah", chapters: 52, section: "old" },
  { id: 25, name: "耶利米哀歌", abbrev: "哀", eng: "Lamentations", chapters: 5, section: "old" },
  { id: 26, name: "以西結書", abbrev: "結", eng: "Ezekiel", chapters: 48, section: "old" },
  { id: 27, name: "但以理書", abbrev: "但", eng: "Daniel", chapters: 12, section: "old" },
  { id: 28, name: "何西阿書", abbrev: "何", eng: "Hosea", chapters: 14, section: "old" },
  { id: 29, name: "約珥書", abbrev: "珥", eng: "Joel", chapters: 3, section: "old" },
  { id: 30, name: "阿摩司書", abbrev: "摩", eng: "Amos", chapters: 9, section: "old" },
  { id: 31, name: "俄巴底亞書", abbrev: "俄", eng: "Obadiah", chapters: 1, section: "old" },
  { id: 32, name: "約拿書", abbrev: "拿", eng: "Jonah", chapters: 4, section: "old" },
  { id: 33, name: "彌迦書", abbrev: "彌", eng: "Micah", chapters: 7, section: "old" },
  { id: 34, name: "那鴻書", abbrev: "鴻", eng: "Nahum", chapters: 3, section: "old" },
  { id: 35, name: "哈巴谷書", abbrev: "哈", eng: "Habakkuk", chapters: 3, section: "old" },
  { id: 36, name: "西番雅書", abbrev: "番", eng: "Zephaniah", chapters: 3, section: "old" },
  { id: 37, name: "哈該書", abbrev: "該", eng: "Haggai", chapters: 2, section: "old" },
  { id: 38, name: "撒迦利亞書", abbrev: "亞", eng: "Zechariah", chapters: 14, section: "old" },
  { id: 39, name: "瑪拉基書", abbrev: "瑪", eng: "Malachi", chapters: 4, section: "old" },

  // New Testament (27 books)
  { id: 40, name: "馬太福音", abbrev: "太", eng: "Matthew", chapters: 28, section: "new" },
  { id: 41, name: "馬可福音", abbrev: "可", eng: "Mark", chapters: 16, section: "new" },
  { id: 42, name: "路加福音", abbrev: "路", eng: "Luke", chapters: 24, section: "new" },
  { id: 43, name: "約翰福音", abbrev: "約", eng: "John", chapters: 21, section: "new" },
  { id: 44, name: "使徒行傳", abbrev: "徒", eng: "Acts", chapters: 28, section: "new" },
  { id: 45, name: "羅馬書", abbrev: "羅", eng: "Romans", chapters: 16, section: "new" },
  { id: 46, name: "哥林多前書", abbrev: "林前", eng: "1 Corinthians", chapters: 16, section: "new" },
  { id: 47, name: "哥林多後書", abbrev: "林後", eng: "2 Corinthians", chapters: 13, section: "new" },
  { id: 48, name: "加拉太書", abbrev: "加", eng: "Galatians", chapters: 6, section: "new" },
  { id: 49, name: "以弗所書", abbrev: "弗", eng: "Ephesians", chapters: 6, section: "new" },
  { id: 50, name: "腓立比書", abbrev: "腓", eng: "Philippians", chapters: 4, section: "new" },
  { id: 51, name: "歌羅西書", abbrev: "歌", eng: "Colossians", chapters: 4, section: "new" },
  { id: 52, name: "帖撒羅尼迦前書", abbrev: "帖前", eng: "1 Thessalonians", chapters: 5, section: "new" },
  { id: 53, name: "帖撒羅尼迦後書", abbrev: "帖後", eng: "2 Thessalonians", chapters: 3, section: "new" },
  { id: 54, name: "提摩太前書", abbrev: "提前", eng: "1 Timothy", chapters: 6, section: "new" },
  { id: 55, name: "提摩太後書", abbrev: "提後", eng: "2 Timothy", chapters: 4, section: "new" },
  { id: 56, name: "提多書", abbrev: "多", eng: "Titus", chapters: 3, section: "new" },
  { id: 57, name: "腓利門書", abbrev: "門", eng: "Philemon", chapters: 1, section: "new" },
  { id: 58, name: "希伯來書", abbrev: "希", eng: "Hebrews", chapters: 13, section: "new" },
  { id: 59, name: "雅各書", abbrev: "雅", eng: "James", chapters: 5, section: "new" },
  { id: 60, name: "彼得前書", abbrev: "彼前", eng: "1 Peter", chapters: 5, section: "new" },
  { id: 61, name: "彼得後書", abbrev: "彼後", eng: "2 Peter", chapters: 3, section: "new" },
  { id: 62, name: "約翰一書", abbrev: "約一", eng: "1 John", chapters: 5, section: "new" },
  { id: 63, name: "約翰二書", abbrev: "約二", eng: "2 John", chapters: 1, section: "new" },
  { id: 64, name: "約翰三書", abbrev: "約三", eng: "3 John", chapters: 1, section: "new" },
  { id: 65, name: "猶大書", abbrev: "猶", eng: "Jude", chapters: 1, section: "new" },
  { id: 66, name: "啟示錄", abbrev: "啟", eng: "Revelation", chapters: 22, section: "new" }
];

// Bolls.life API uses numeric book IDs (1-66), not English abbreviations.
// Build lookup map from the canonical BIBLE_BOOKS array.
function getBollsBookId(bookEngName) {
  const book = BIBLE_BOOKS.find(b => b.eng === bookEngName);
  return book ? book.id : null;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function normalizeVerses(rawVerses) {
  if (!Array.isArray(rawVerses)) return [];
  return rawVerses
    .map((v, index) => ({
      verse: Number(v.verse || v.verseNumber || v.number || index + 1),
      text: String(v.text || v.content || "").replace(/<[^>]*>/g, "").trim()
    }))
    .filter(v => v.verse && v.text);
}

function assertCompleteEnough(result, sourceName, isEnglish = false) {
  if (!result || !Array.isArray(result.verses) || result.verses.length === 0) {
    throw new Error(`${sourceName} 沒有回傳經文`);
  }

  const combinedText = result.verses.map(v => v.text).join("");
  if (!isEnglish && !/[\u3400-\u9fff]/.test(combinedText)) {
    throw new Error(`${sourceName} 回傳的不是中文聖經`);
  }

  const lastVerse = result.verses[result.verses.length - 1].verse;
  const uniqueCount = new Set(result.verses.map(v => v.verse)).size;
  if (result.verses.length === 10 && lastVerse === 10 && uniqueCount === 10) {
    throw new Error(`${sourceName} 只回傳前 10 節`);
  }

  return result;
}

async function fetchFromBibleApi(bookEngName, chapter, translation) {
  let queryPassage = `${bookEngName} ${chapter}`;
  if (translation === "cuv" && typeof BIBLE_BOOKS !== "undefined") {
    const book = BIBLE_BOOKS.find(b => b.eng.toLowerCase() === bookEngName.toLowerCase());
    if (book) {
      queryPassage = `${book.name} ${chapter}`;
    }
  }

  const isEnglish = ["esv", "niv", "nlt", "web", "kjv"].includes(translation.toLowerCase());
  const url = `https://bible-api.com/${encodeURIComponent(queryPassage)}?translation=${encodeURIComponent(translation)}`;
  const data = await fetchJson(url);
  return assertCompleteEnough({
    reference: data.reference || `${bookEngName} ${chapter}`,
    verses: normalizeVerses(data.verses)
  }, `bible-api ${translation}`, isEnglish);
}

async function fetchFromBolls(bookEngName, chapter, translation, bookIdentifier = null) {
  const bookCode = bookIdentifier;
  if (!bookCode) throw new Error(`Bolls 缺少書卷代碼：${bookEngName}`);

  const isEnglish = ["esv", "niv", "nlt", "kjv"].includes(translation.toLowerCase());
  const url = `https://bolls.life/get-chapter/${encodeURIComponent(translation)}/${encodeURIComponent(bookCode)}/${encodeURIComponent(chapter)}/`;
  const data = await fetchJson(url);
  return assertCompleteEnough({
    reference: `${bookEngName} ${chapter}`,
    verses: normalizeVerses(data)
  }, `Bolls ${translation}`, isEnglish);
}
const BIBLE_FALLBACK = {
  "Genesis_1": {
    reference: "創世記 1章",
    verses: [
      { verse: 1, text: "起初，神創造天地。" },
      { verse: 2, text: "地是空虛混沌，淵面黑暗；神的靈運行在水面上。" },
      { verse: 3, text: "神說：「要有光」，就有了光。" },
      { verse: 4, text: "神看光是好的，就把光暗分開了。" },
      { verse: 5, text: "神稱光為「晝」，稱暗為「夜」。有晚上，有早晨，這是頭一日。" },
      { verse: 6, text: "神說：「諸水之間要有空氣，將水分為上下。」" },
      { verse: 7, text: "神就造出空氣，將空氣以下的水、空氣以上的水分開了。事就這樣成了。" },
      { verse: 8, text: "神稱空氣為「天」。有晚上，有早晨，是第二日。" },
      { verse: 9, text: "神說：「天下的水要聚在一處，使旱地露出來。」事就這樣成了。" },
      { verse: 10, text: "神稱旱地為「地」，稱水的聚處為「海」。神看著是好的。" }
    ]
  },
  "Matthew_1": {
    reference: "馬太福音 1章",
    verses: [
      { verse: 1, text: "亞伯拉罕的後裔，大衛的子孫，耶穌基督的家譜：" },
      { verse: 2, text: "亞伯拉罕生以撒；以撒生雅各；雅各生猶大和他的弟兄；" },
      { verse: 3, text: "猶大從他瑪氏生法勒斯和謝拉；法勒斯生希士崙；希士崙生亞蘭；" },
      { verse: 4, text: "亞蘭生亞米拿達；亞米拿達生拿順；拿順生撒門；" },
      { verse: 5, text: "撒門從喇合氏生波阿斯；波阿斯從路得氏生俄備得；俄備得生耶西；" },
      { verse: 6, text: "耶西生大衛王。大衛從烏利亞的妻子生所羅門；" },
      { verse: 7, text: "所羅門生羅波安；羅波安生亞比雅；亞比雅生亞撒；" },
      { verse: 8, text: "亞撒生約沙法；約沙法生約蘭；約蘭生烏西雅；" },
      { verse: 9, text: "烏西雅生約坦；約坦生亞哈斯；亞哈斯生希西家；" },
      { verse: 10, text: "希西家生瑪拿西；瑪拿西生亞門；亞門生約西亞；" }
    ]
  }
};

/**
 * Fetches verses for a given book and chapter.
 * @param {string} bookEngName - The English name of the book (e.g. "Genesis").
 * @param {number} chapter - The chapter number.
 * @returns {Promise<{reference: string, verses: Array<{verse: number, text: string}>}>}
 */
function getBibleChapterCacheKey(bookEngName, chapter, translation) {
  return `${String(translation || "CUNP").toUpperCase()}_${bookEngName}_${chapter}`;
}

async function fetchBibleChapter(bookEngName, chapter, requestedVersion = null) {
  // Anti-Bug Guard: validate parameters before sending network requests
  if (!bookEngName || !chapter || isNaN(chapter) || Number(chapter) <= 0) {
    console.warn('⚠️ [API 防護攔截] 偵測到無效參數，拒絕發送錯誤網址');
    throw new Error('⚠️ [API 防護攔截] 偵測到無效參數，拒絕發送錯誤網址');
  }

  const preferredVersion = String(
    requestedVersion || (typeof state !== "undefined" && state.readerState && state.readerState.version) || "CUNP"
  ).toUpperCase();

  // Translation is part of the cache identity. Without it, switching from
  // CUNP to NIV can incorrectly reuse the CUNP chapter cached moments ago.
  if (!window._bibleChapterCache) {
    window._bibleChapterCache = {};
  }
  const cacheKey = getBibleChapterCacheKey(bookEngName, chapter, preferredVersion);
  if (window._bibleChapterCache[cacheKey] && !window._bibleChapterCache[cacheKey].isPlaceholder) {
    return window._bibleChapterCache[cacheKey];
  }
  if (window._bibleChapterCache[cacheKey]?.isPlaceholder) {
    delete window._bibleChapterCache[cacheKey];
  }

  // Predictive prefetch and audio auto-navigation can request the same next
  // chapter at nearly the same time. Share one in-flight request so a slower
  // success cannot race with a second failure that replaces the reader UI.
  if (!window._bibleChapterInFlight) {
    window._bibleChapterInFlight = {};
  }
  if (window._bibleChapterInFlight[cacheKey]) {
    return window._bibleChapterInFlight[cacheKey];
  }

  const requestPromise = (async () => {
  const offlineRepository = window.offlineBibleRepository;
  if (offlineRepository && typeof offlineRepository.getChapter === "function") {
    try {
      const offlineChapter = await offlineRepository.getChapter(preferredVersion, bookEngName, chapter);
      if (offlineChapter) {
        window._bibleChapterCache[cacheKey] = offlineChapter;
        return offlineChapter;
      }
    } catch (error) {
      console.warn("離線經文讀取失敗，改用線上來源。", error);
    }
  }

  // Bolls.life requires the numeric book ID (1-66)
  const bollsBookId = getBollsBookId(bookEngName);
  const isEnglishVersion = ["ESV", "NIV", "NLT", "WEB"].includes(preferredVersion);
  const sources = [];

  if (preferredVersion === "OCCB" && offlineRepository && typeof offlineRepository.getRemoteChapter === "function") {
    sources.push(async () => {
      const result = await offlineRepository.getRemoteChapter(preferredVersion, bookEngName, chapter);
      if (!result) throw new Error("OCCB 資料包沒有這個章節");
      return result;
    });
  } else if (bollsBookId) {
    sources.push(() => fetchFromBolls(bookEngName, chapter, preferredVersion, bollsBookId));
  }
  // bible-api is only an exact-version fallback where that version is known
  // by the same identifier. Never silently substitute a different translation.
  if (["CUV", "ESV", "NIV", "NLT", "WEB"].includes(preferredVersion)) {
    sources.push(() => fetchFromBibleApi(bookEngName, chapter, preferredVersion.toLowerCase()));
  }

  const errors = [];
  for (const source of sources) {
    try {
      const result = await source();
      const versionedResult = { ...result, translation: preferredVersion };
      window._bibleChapterCache[cacheKey] = versionedResult;
      return versionedResult;
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  const fallbackKey = `${bookEngName}_${chapter}`;
  const fallback = BIBLE_FALLBACK[fallbackKey];
  if (!isEnglishVersion && fallback && fallback.verses && fallback.verses.length > 0) {
    const versionedFallback = { ...fallback, translation: preferredVersion };
    window._bibleChapterCache[cacheKey] = versionedFallback;
    return versionedFallback;
  }

  if (isEnglishVersion) {
    throw new Error(`${preferredVersion} 譯本載入失敗：${errors.join("；") || "沒有可用的經文來源"}`);
  }

  // Robust offline fallback using BIBLE_VERSE_COUNTS
  let totalVerses = 30;
  if (typeof BIBLE_VERSE_COUNTS !== "undefined") {
    totalVerses = (BIBLE_VERSE_COUNTS[bookEngName] && BIBLE_VERSE_COUNTS[bookEngName][chapter - 1]) || 30;
  }

  console.warn(`⚠️ [Warning] 無法從線上或快取中載入 ${bookEngName} ${chapter} 章，啟動本地防崩潰經文生成，總計 ${totalVerses} 節。`);

  const placeholderVerses = [];
  for (let v = 1; v <= totalVerses; v++) {
    placeholderVerses.push({
      verse: v,
      text: "（經文暫時未載入）"
    });
  }

  return {
    reference: `${bookEngName} ${chapter}章`,
    verses: placeholderVerses,
    translation: preferredVersion,
    isPlaceholder: true,
    loadError: errors.join("；") || "沒有可用的經文來源"
  };
  })();

  window._bibleChapterInFlight[cacheKey] = requestPromise;
  try {
    return await requestPromise;
  } finally {
    if (window._bibleChapterInFlight[cacheKey] === requestPromise) {
      delete window._bibleChapterInFlight[cacheKey];
    }
  }
}

window.BIBLE_BOOKS = BIBLE_BOOKS;
window.fetchBibleChapter = fetchBibleChapter;
window.getBibleChapterCacheKey = getBibleChapterCacheKey;

