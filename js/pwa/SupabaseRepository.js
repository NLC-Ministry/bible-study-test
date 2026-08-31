export class RepositoryError extends Error {
  constructor(message, { code = null, status = 0, category = "unknown", operation = "unknown", cause = null } = {}) {
    super(message, { cause });
    this.name = "RepositoryError";
    this.code = code;
    this.status = Number(status || 0);
    this.category = category;
    this.operation = operation;
  }
}

export class SupabaseRepository extends EventTarget {
  constructor({ table, clientProvider, cacheClient = null, cacheStore = "server_cache" }) {
    super();
    if (!table) throw new TypeError("SupabaseRepository requires a table name.");
    if (typeof clientProvider !== "function") throw new TypeError("SupabaseRepository requires a clientProvider.");
    this.table = table;
    this.clientProvider = clientProvider;
    this.cacheClient = cacheClient;
    this.cacheStore = cacheStore;
  }

  async fetch({ cacheKey, query, onData = null, pageSize = 200 } = {}) {
    if (typeof query !== "function") throw new TypeError("fetch requires a query callback.");
    const cached = cacheKey ? await this.readCache(cacheKey) : null;
    if (cached) this.publish(cached.data, { source: "indexeddb", stale: true, cacheKey, updatedAt: cached.updatedAt }, onData);

    try {
      const data = await this.fetchAllPages(query, pageSize);
      if (cacheKey) {
        try { await this.writeCache(cacheKey, data); }
        catch (cacheError) { console.warn(`[Repository:${this.table}] IndexedDB refresh failed.`, cacheError); }
      }
      this.publish(data, { source: "supabase", stale: false, cacheKey, updatedAt: new Date().toISOString() }, onData);
      return { data, error: null, meta: { source: "supabase", stale: false } };
    } catch (error) {
      const normalized = this.normalizeError(error, "fetch");
      this.dispatchEvent(new CustomEvent("error", { detail: normalized }));
      if (cached) return { data: cached.data, error: normalized, meta: { source: "indexeddb", stale: true } };
      throw normalized;
    }
  }

  // Supabase/PostgREST caps rows per request (the project's configured
  // db.max_rows, commonly 1000; the nlc-data Edge Function additionally
  // hard-clamps any .range() span to 200). A single one-shot query silently
  // truncates once a user's real row count passes that cap, so counts
  // derived from it (e.g. cumulative chapters read) quietly stop growing
  // instead of erroring. `query` must be a factory that returns a *fresh*
  // query builder each call — .range() is appended per page, and builders
  // here are single-use. Test/mocked `query` callbacks that return a plain
  // promise (no chainable .range()) fall back to a single unpaged fetch.
  async fetchAllPages(query, pageSize) {
    const rows = [];
    let from = 0;
    while (true) {
      const builder = query(this.tableQuery());
      const paged = builder && typeof builder.range === "function"
        ? builder.range(from, from + pageSize - 1)
        : builder;
      const result = await paged;
      const page = this.unwrap(result, "fetch") || [];
      if (typeof builder?.range !== "function") return page;
      rows.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }
    return rows;
  }

  insert(payload, options = {}) {
    return this.mutate("insert", table => {
      let query = table.insert(payload);
      if (options.select && typeof query.select === "function") query = query.select(options.select);
      return query;
    }, options);
  }

  update(payload, configure, options = {}) {
    if (typeof configure !== "function") throw new TypeError("update requires a filter callback.");
    return this.mutate("update", table => {
      let query = configure(table.update(payload));
      if (options.select && typeof query.select === "function") query = query.select(options.select);
      return query;
    }, options);
  }

  upsert(payload, upsertOptions = {}, options = {}) {
    return this.mutate("upsert", table => {
      let query = table.upsert(payload, upsertOptions);
      if (options.select && typeof query.select === "function") query = query.select(options.select);
      return query;
    }, options);
  }

  delete(configure, options = {}) {
    if (typeof configure !== "function") throw new TypeError("delete requires a filter callback.");
    return this.mutate("delete", table => configure(table.delete()), options);
  }

  async mutate(operation, execute, { invalidate = [] } = {}) {
    try {
      const result = await execute(this.tableQuery());
      const data = this.unwrap(result, operation);
      const cacheResults = await Promise.allSettled(invalidate.map(key => this.deleteCache(key)));
      cacheResults.filter(result => result.status === "rejected").forEach(result =>
        console.warn(`[Repository:${this.table}] Cache invalidation failed after ${operation}.`, result.reason)
      );
      this.dispatchEvent(new CustomEvent("mutation", { detail: { table: this.table, operation, data } }));
      return { data, error: null };
    } catch (error) {
      const normalized = this.normalizeError(error, operation);
      this.dispatchEvent(new CustomEvent("error", { detail: normalized }));
      throw normalized;
    }
  }

  tableQuery() {
    const client = this.clientProvider();
    if (!client || typeof client.from !== "function") {
      throw new RepositoryError("Supabase client is unavailable.", { category: "auth", status: 401, operation: "client" });
    }
    return client.from(this.table);
  }

  unwrap(result, operation) {
    if (result?.error) throw this.normalizeError({ ...result.error, status: result.status || result.error.status }, operation);
    return result?.data ?? null;
  }

  normalizeError(error, operation) {
    if (error instanceof RepositoryError) return error;
    const status = Number(error?.status || 0);
    const code = error?.code || null;
    const message = String(error?.message || error?.error || error || "Unknown Supabase error");
    const lower = message.toLowerCase();
    let category = "server";
    if (status === 401 || status === 403 || code === "42501" || lower.includes("row-level security") || lower.includes("rls")) category = "permission";
    else if (status === 400 || code === "23502" || code === "23503" || code === "23505" || code === "22P02") category = "validation";
    else if (error instanceof TypeError || status === 0 || lower.includes("fetch") || lower.includes("network") || lower.includes("offline") || lower.includes("timeout")) category = "network";
    return new RepositoryError(message, { code, status, category, operation, cause: error });
  }

  publish(data, meta, onData) {
    try {
      if (typeof onData === "function") onData(data, meta);
      this.dispatchEvent(new CustomEvent("data", { detail: { table: this.table, data, ...meta } }));
    } catch (uiError) {
      console.error(`[Repository:${this.table}] UI subscriber failed.`, uiError);
    }
  }
  async readCache(key) {
    if (!this.cacheClient) return null;
    try { return await this.cacheClient.get(this.cacheStore, key); }
    catch (error) { console.warn(`[Repository:${this.table}] IndexedDB read failed.`, error); return null; }
  }

  async writeCache(key, data) {
    if (!this.cacheClient) return;
    await this.cacheClient.put(this.cacheStore, {
      key,
      table: this.table,
      data,
      updatedAt: new Date().toISOString()
    });
  }

  async deleteCache(key) {
    if (!this.cacheClient || !key) return;
    await this.cacheClient.delete(this.cacheStore, key);
  }
}