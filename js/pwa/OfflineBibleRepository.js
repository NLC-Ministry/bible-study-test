export const OFFLINE_BIBLE_CATALOG = Object.freeze({
  OCCB: Object.freeze({
    translation: "OCCB",
    title: "當代譯本開放資源（繁體）",
    shortTitle: "當代譯本",
    language: "zh-Hant",
    edition: "2023",
    url: "/assets/bible-packs/occb-zh-hant.json",
    license: "CC BY-SA 4.0",
    sourceUrl: "https://ebible.org/bible/details.php?id=cmncbt"
  }),
  WEB: Object.freeze({
    translation: "WEB",
    title: "World English Bible",
    shortTitle: "WEB",
    language: "en",
    edition: "2020 stable text edition",
    url: "/assets/bible-packs/web.json",
    license: "Public Domain",
    sourceUrl: "https://ebible.org/bible/details.php?id=engwebp"
  })
});

function chapterKey(translation, book, chapter) {
  return `${String(translation).toUpperCase()}_${book}_${Number(chapter)}`;
}

export class OfflineBibleRepository extends EventTarget {
  constructor({ dbClient, fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    super();
    this.dbClient = dbClient;
    this.fetchImpl = fetchImpl;
    this.packPromises = new Map();
  }

  async getChapter(translation, book, chapter) {
    if (!this.dbClient) return null;
    const row = await this.dbClient.get("bible_chapters", chapterKey(translation, book, chapter));
    if (!row || !Array.isArray(row.verses) || row.verses.length === 0) return null;
    return {
      reference: `${book} ${chapter}`,
      translation: String(translation).toUpperCase(),
      verses: row.verses.map((text, index) => ({ verse: index + 1, text })),
      offline: true
    };
  }

  async getInstalledPack(translation) {
    if (!this.dbClient) return null;
    return this.dbClient.get("bible_packs", String(translation).toUpperCase());
  }

  async listInstalledPacks() {
    if (!this.dbClient) return [];
    return this.dbClient.getAll("bible_packs");
  }

  async fetchPack(translation, onProgress = () => {}) {
    const normalized = String(translation).toUpperCase();
    const config = OFFLINE_BIBLE_CATALOG[normalized];
    if (!config) throw new Error("這個譯本目前沒有可下載的離線資料包。");
    const response = await this.fetchImpl(config.url, { cache: "no-store" });
    if (!response.ok) throw new Error(`下載失敗（${response.status}）`);

    const total = Number(response.headers.get("Content-Length") || 0);
    let text = "";
    if (response.body?.getReader && typeof TextDecoder !== "undefined") {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        onProgress(total ? Math.min(90, Math.round((received / total) * 90)) : null);
      }
      text += decoder.decode();
    } else {
      text = await response.text();
      onProgress(90);
    }

    const payload = JSON.parse(text);
    if (payload.translation !== normalized || payload.chapterCount !== 1189 || !payload.chapters) {
      throw new Error("離線經文資料包驗證失敗。");
    }
    return payload;
  }

  async getRemoteChapter(translation, book, chapter) {
    const normalized = String(translation).toUpperCase();
    if (!OFFLINE_BIBLE_CATALOG[normalized]) return null;
    if (!this.packPromises.has(normalized)) {
      this.packPromises.set(normalized, this.fetchPack(normalized).catch(error => {
        this.packPromises.delete(normalized);
        throw error;
      }));
    }
    const payload = await this.packPromises.get(normalized);
    const verses = payload.chapters[`${book}_${Number(chapter)}`];
    if (!Array.isArray(verses) || verses.length === 0) return null;
    return {
      reference: `${book} ${chapter}`,
      translation: normalized,
      verses: verses.map((text, index) => ({ verse: index + 1, text }))
    };
  }

  async downloadPack(translation, onProgress = () => {}) {
    if (!this.dbClient) throw new Error("此瀏覽器不支援離線資料庫。");
    const normalized = String(translation).toUpperCase();
    this.dispatchEvent(new CustomEvent("status", { detail: { translation: normalized, status: "downloading" } }));
    const payload = await this.fetchPack(normalized, onProgress);
    const rows = Object.entries(payload.chapters).map(([chapterId, verses]) => {
      const separator = chapterId.lastIndexOf("_");
      const book = chapterId.slice(0, separator);
      const chapter = Number(chapterId.slice(separator + 1));
      return { key: chapterKey(normalized, book, chapter), translation: normalized, book, chapter, verses };
    });
    if (rows.length !== 1189) throw new Error("離線資料包章數不完整。");

    await this.dbClient.deleteByIndex("bible_chapters", "translation", normalized);
    await this.dbClient.putMany("bible_chapters", rows);
    const metadata = {
      translation: normalized,
      title: payload.title,
      edition: payload.edition,
      language: payload.language,
      license: payload.license,
      copyright: payload.copyright,
      sourceUrl: payload.sourceUrl,
      chapterCount: rows.length,
      downloadedAt: new Date().toISOString()
    };
    await this.dbClient.put("bible_packs", metadata);
    onProgress(100);
    this.dispatchEvent(new CustomEvent("status", { detail: { translation: normalized, status: "installed", metadata } }));

    if (navigator.storage?.persist) navigator.storage.persist().catch(() => false);
    return metadata;
  }

  async removePack(translation) {
    if (!this.dbClient) return;
    const normalized = String(translation).toUpperCase();
    await this.dbClient.deleteByIndex("bible_chapters", "translation", normalized);
    await this.dbClient.delete("bible_packs", normalized);
    this.dispatchEvent(new CustomEvent("status", { detail: { translation: normalized, status: "removed" } }));
  }
}
