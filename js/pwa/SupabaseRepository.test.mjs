import { describe, expect, it, vi } from "vitest";
import { RepositoryError, SupabaseRepository } from "./SupabaseRepository.js";

class MemoryCacheClient {
  constructor(records = []) { this.records = new Map(records.map(record => [record.key, record])); }
  async get(_store, key) { return this.records.get(key); }
  async put(_store, value) { this.records.set(value.key, structuredClone(value)); }
  async delete(_store, key) { this.records.delete(key); }
}

const clientFor = result => ({ from: vi.fn(() => ({
  insert: () => Promise.resolve(result),
  update: () => ({ eq: () => Promise.resolve(result) }),
  upsert: () => Promise.resolve(result),
  delete: () => ({ eq: () => Promise.resolve(result) })
})) });

describe("SupabaseRepository", () => {
  it("publishes IndexedDB first, then overwrites it with Supabase data", async () => {
    const cache = new MemoryCacheClient([{ key: "reading_logs:user-1", data: [{ chapter: 1 }], updatedAt: "old" }]);
    const updates = [];
    const repository = new SupabaseRepository({ table: "reading_logs", clientProvider: () => clientFor({ data: [] }), cacheClient: cache });

    const result = await repository.fetch({
      cacheKey: "reading_logs:user-1",
      query: async () => ({ data: [{ chapter: 2 }], error: null }),
      onData: (data, meta) => updates.push({ data, source: meta.source })
    });

    expect(updates).toEqual([
      { data: [{ chapter: 1 }], source: "indexeddb" },
      { data: [{ chapter: 2 }], source: "supabase" }
    ]);
    expect(result.meta.stale).toBe(false);
    expect((await cache.get("server_cache", "reading_logs:user-1")).data).toEqual([{ chapter: 2 }]);
  });

  it("returns stale cache with a precise network error when refresh fails", async () => {
    const cache = new MemoryCacheClient([{ key: "logs", data: [{ chapter: 1 }], updatedAt: "old" }]);
    const repository = new SupabaseRepository({ table: "reading_logs", clientProvider: () => clientFor({ data: [] }), cacheClient: cache });
    const result = await repository.fetch({ cacheKey: "logs", query: async () => { throw new TypeError("Failed to fetch"); } });
    expect(result.data).toEqual([{ chapter: 1 }]);
    expect(result.meta.stale).toBe(true);
    expect(result.error).toBeInstanceOf(RepositoryError);
    expect(result.error.category).toBe("network");
  });

  it("throws RLS failures instead of reporting a successful insert", async () => {
    const client = clientFor({ data: null, error: { code: "42501", message: "row-level security policy" }, status: 403 });
    const repository = new SupabaseRepository({ table: "reading_logs", clientProvider: () => client });
    await expect(repository.insert({ chapter: 1 })).rejects.toMatchObject({ category: "permission", operation: "insert" });
  });

  it("invalidates a cached snapshot only after a successful update", async () => {
    const cache = new MemoryCacheClient([{ key: "logs", data: [1] }]);
    const repository = new SupabaseRepository({ table: "reading_logs", clientProvider: () => clientFor({ data: [{ id: 1 }], error: null }), cacheClient: cache });
    await repository.update({ read_at: "now" }, query => query.eq("id", 1), { invalidate: ["logs"] });
    expect(await cache.get("server_cache", "logs")).toBeUndefined();
  });

  it("keeps fresh Supabase data when IndexedDB refresh fails", async () => {
    const cache = { get: async () => undefined, put: async () => { throw new Error("quota"); }, delete: async () => {} };
    const repository = new SupabaseRepository({ table: "reading_logs", clientProvider: () => clientFor({ data: [] }), cacheClient: cache });
    const result = await repository.fetch({ cacheKey: "logs", query: async () => ({ data: [{ chapter: 3 }], error: null }) });
    expect(result).toMatchObject({ data: [{ chapter: 3 }], error: null, meta: { source: "supabase" } });
  });

  it("does not turn a successful Supabase mutation into failure when cache cleanup fails", async () => {
    const cache = { get: async () => undefined, put: async () => {}, delete: async () => { throw new Error("locked"); } };
    const repository = new SupabaseRepository({ table: "reading_logs", clientProvider: () => clientFor({ data: [{ id: 1 }], error: null }), cacheClient: cache });
    await expect(repository.insert({ chapter: 1 }, { invalidate: ["logs"] })).resolves.toEqual({ data: [{ id: 1 }], error: null });
  });

  it("pages past the server's per-request row cap instead of silently truncating", async () => {
    // Regression test: a one-shot query used to stop growing once a user's
    // real reading_logs row count passed the backend's default row cap
    // (surfaced as 累積閱讀章數 freezing at 1000). A chainable query builder
    // with .range() must be paged through to completion.
    const pageSize = 2;
    const allRows = [{ chapter: 1 }, { chapter: 2 }, { chapter: 3 }, { chapter: 4 }, { chapter: 5 }];
    const repository = new SupabaseRepository({ table: "reading_logs", clientProvider: () => ({ from: () => ({}) }) });

    const query = () => ({
      range(from, to) {
        return Promise.resolve({ data: allRows.slice(from, to + 1), error: null });
      }
    });

    const result = await repository.fetch({ query, pageSize });
    expect(result.data).toEqual(allRows);
    expect(result.error).toBeNull();
  });
});