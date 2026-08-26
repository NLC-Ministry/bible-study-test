export class IndexedDbClient {
  constructor({ name = "newlife-bible", version = 3 } = {}) {
    this.name = name;
    this.version = version;
    this.connectionPromise = null;
  }

  open() {
    if (this.connectionPromise) return this.connectionPromise;
    this.connectionPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, this.version);
      request.onupgradeneeded = () => this.upgrade(request.result, request.transaction);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => console.warn("[PWA] IndexedDB upgrade is blocked by another tab.");
    });
    return this.connectionPromise;
  }

  upgrade(db) {
    if (!db.objectStoreNames.contains("offline_operations")) {
      const store = db.createObjectStore("offline_operations", { keyPath: "id" });
      store.createIndex("status", "status", { unique: false });
      store.createIndex("nextAttemptAt", "nextAttemptAt", { unique: false });
      store.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
    }
    if (!db.objectStoreNames.contains("server_cache")) {
      const cacheStore = db.createObjectStore("server_cache", { keyPath: "key" });
      cacheStore.createIndex("table", "table", { unique: false });
      cacheStore.createIndex("updatedAt", "updatedAt", { unique: false });
    }
    if (!db.objectStoreNames.contains("bible_chapters")) {
      const chapterStore = db.createObjectStore("bible_chapters", { keyPath: "key" });
      chapterStore.createIndex("translation", "translation", { unique: false });
      chapterStore.createIndex("book", "book", { unique: false });
    }
    if (!db.objectStoreNames.contains("bible_packs")) {
      const packStore = db.createObjectStore("bible_packs", { keyPath: "translation" });
      packStore.createIndex("downloadedAt", "downloadedAt", { unique: false });
    }
  }

  async run(storeName, mode, executor) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;
      try { request = executor(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(request && "result" in request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error || request?.error);
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  get(storeName, key) { return this.run(storeName, "readonly", store => store.get(key)); }
  put(storeName, value) { return this.run(storeName, "readwrite", store => store.put(value)); }
  delete(storeName, key) { return this.run(storeName, "readwrite", store => store.delete(key)); }
  getAll(storeName) { return this.run(storeName, "readonly", store => store.getAll()); }
  clear(storeName) { return this.run(storeName, "readwrite", store => store.clear()); }

  async putMany(storeName, values) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      try {
        values.forEach(value => store.put(value));
      } catch (error) {
        transaction.abort();
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(values.length);
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB bulk write failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB bulk write aborted"));
    });
  }

  async deleteByIndex(storeName, indexName, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.index(indexName).openKeyCursor(IDBKeyRange.only(value));
      request.onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB indexed delete aborted"));
    });
  }
}
