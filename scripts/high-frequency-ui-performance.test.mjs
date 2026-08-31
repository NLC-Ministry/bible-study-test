import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const plan = readFileSync("js/modules/plan.js", "utf8");
const db = readFileSync("js/db.js", "utf8");
const repository = readFileSync("js/pwa/SupabaseRepository.js", "utf8");

describe("high-frequency UI performance", () => {
  it("filters the already processed participant list without refetching on every keystroke", () => {
    const listenerStart = plan.indexOf('searchInput.addEventListener("input", () => {');
    const listenerEnd = plan.indexOf("window.displayParticipantsList(100);", listenerStart);
    const listener = plan.slice(listenerStart, listenerEnd + 36);

    expect(listenerStart).toBeGreaterThan(-1);
    expect(listener).toContain("requestAnimationFrame");
    expect(listener).toContain("displayParticipantsList");
    expect(listener).not.toContain("renderGroupParticipantsRankingTable");
    expect(listener).not.toContain("await");
  });

  it("uses stale-while-revalidate only for a user-scoped reading-log cache key", () => {
    expect(repository).toContain("this.publish(cached.data");
    expect(repository).toContain("const data = await this.fetchAllPages(query, pageSize)");
    expect(db).toContain("`reading_logs:${user.id}`");
    expect(db).not.toContain('cacheKey: "reading_logs"');
  });

  it("does not persist network metrics or response bodies", () => {
    expect(db).toContain("networkMetrics.record");
    expect(db).not.toContain("localStorage.setItem(\"network");
    expect(db).not.toContain("body: request");
  });
});

