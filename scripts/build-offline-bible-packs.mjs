import fs from "node:fs";
import path from "node:path";

const sourceRoot = process.argv[2];
const outputRoot = process.argv[3] || path.resolve("assets/bible-packs");

if (!sourceRoot) {
  throw new Error("Usage: node scripts/build-offline-bible-packs.mjs <extracted-pack-root> [output-root]");
}

const BOOK_CODES = [
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH",
  "2CH", "EZR", "NEH", "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER", "LAM", "EZK",
  "DAN", "HOS", "JOL", "AMO", "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH", "PHP", "COL", "1TH",
  "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV"
];

const BOOK_NAMES = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth", "1 Samuel",
  "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra", "Nehemiah", "Esther", "Job",
  "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon", "Isaiah", "Jeremiah", "Lamentations", "Ezekiel",
  "Daniel", "Hosea", "Joel", "Amos", "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah",
  "Haggai", "Zechariah", "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians",
  "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians",
  "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James", "1 Peter", "2 Peter", "1 John",
  "2 John", "3 John", "Jude", "Revelation"
];

const PACKS = [
  {
    source: "cmncbt",
    output: "occb-zh-hant.json",
    translation: "OCCB",
    title: "當代譯本開放資源（繁體）",
    language: "zh-Hant",
    edition: "2023",
    license: "CC BY-SA 4.0",
    copyright: "Biblica® 聖經，當代譯本™開放資源，版權所有 © 1979, 2005, 2007, 2012, 2023 Biblica, Inc.",
    sourceUrl: "https://ebible.org/bible/details.php?id=cmncbt"
  },
  {
    source: "engwebp",
    output: "web.json",
    translation: "WEB",
    title: "World English Bible",
    language: "en",
    edition: "2020 stable text edition",
    license: "Public Domain",
    copyright: "World English Bible text is in the Public Domain. World English Bible is a trademark of eBible.org.",
    sourceUrl: "https://ebible.org/bible/details.php?id=engwebp"
  }
];

fs.mkdirSync(outputRoot, { recursive: true });

for (const config of PACKS) {
  const directory = path.join(sourceRoot, config.source);
  const files = fs.readdirSync(directory).filter(file => /_read\.txt$/i.test(file));
  const chapters = {};

  for (let bookIndex = 0; bookIndex < BOOK_CODES.length; bookIndex += 1) {
    const code = BOOK_CODES[bookIndex];
    const bookName = BOOK_NAMES[bookIndex];
    const pattern = new RegExp(`_${code}_(\\d{2,3})_read\\.txt$`, "i");
    const chapterFiles = files
      .map(file => ({ file, match: file.match(pattern) }))
      .filter(item => item.match)
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

    for (const { file, match } of chapterFiles) {
      const chapter = Number(match[1]);
      const lines = fs.readFileSync(path.join(directory, file), "utf8")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
      const verses = lines.slice(2);
      if (!verses.length) throw new Error(`${config.translation} ${bookName} ${chapter} has no verses`);
      chapters[`${bookName}_${chapter}`] = verses;
    }
  }

  if (Object.keys(chapters).length !== 1189) {
    throw new Error(`${config.translation} expected 1189 chapters, found ${Object.keys(chapters).length}`);
  }

  const payload = {
    schemaVersion: 1,
    translation: config.translation,
    title: config.title,
    language: config.language,
    edition: config.edition,
    license: config.license,
    copyright: config.copyright,
    sourceUrl: config.sourceUrl,
    chapterCount: 1189,
    generatedAt: new Date().toISOString(),
    chapters
  };
  fs.writeFileSync(path.join(outputRoot, config.output), JSON.stringify(payload));
}
