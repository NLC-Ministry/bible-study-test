import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildRequest } from "../js/data-client/query-builder.mjs";

const db = readFileSync("js/db.js", "utf8");
const edge = readFileSync("supabase/functions/nlc-data/index.ts", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
const indexes = readFileSync("supabase/migrations/0051_performance_indexes.sql", "utf8");

describe("performance architecture contracts", () => {
  it("supports bounded pagination through the browser-to-edge query protocol", () => {
    expect(buildRequest("issue_reports").select("id, status").range(20, 39).toRequest()).toMatchObject({
      table: "issue_reports",
      action: "select",
      select: "id, status",
      range: { from: 20, to: 39 }
    });
    expect(edge).toContain("query = query.range(rangeFrom, rangeTo)");
    expect(edge).toContain("rangeFrom + 199");
    expect(edge).toContain("Math.min(200");
  });

  it("does not fetch every startup column for high-volume resources", () => {
    expect(db).not.toContain('from("global_plans").select("*").order("start_date"');
    expect(db).not.toContain('from("reading_plans").select("*").eq("user_id", user.id)');
    expect(db).toContain('select("book, chapter, read_at, plan_id, round")');
  });

  it("filters permission scope in PostgreSQL instead of downloading all profiles", () => {
    const helper = edge.match(/async function getVisibleProfileIds[\s\S]*?\r?\n}\r?\n\r?\nasync function applyForcedScope/)?.[0] || "";
    expect(helper).toContain('.select("id")');
    expect(helper).toContain('.eq("is_active", true)');
    expect(helper).toContain('query.in("great_region", regions)');
    expect(helper).not.toContain('.select("id, great_region, pastoral_zone, small_group")');
    expect(helper).not.toContain(".filter((candidate");
  });

  it("does not send Logto JWTs through Supabase Auth before resolving their identity", () => {
    const helper = edge.match(/async function resolveProfile[\s\S]*?\r?\n}\r?\n\r?\n/)?.[0] || "";
    expect(helper).toContain("isLogtoJwt");
    expect(helper).toContain("if (!isLogtoJwt)");
    expect(helper.indexOf("const isLogtoJwt")).toBeLessThan(helper.indexOf("supabaseAdmin.auth.getUser"));
  });

  it("adds indexes matching plan and permission filter order", () => {
    expect(indexes).toContain("profiles(great_region)");
    expect(indexes).toContain("reading_plans(global_plan_id, user_id)");
    expect(indexes).toContain("reading_logs(plan_id, round, read_at DESC)");
  });

  it("keeps static HTML and the service worker revalidated", () => {
    const bySource = new Map(vercel.headers.map(rule => [rule.source, rule.headers[0].value]));
    // Entry HTML: revalidate on every load, but NOT no-store — no-store would
    // disable bfcache and make every history.back() from exam.html a full cold
    // reload. See docs/exam-close-ux-analysis.md (O1).
    for (const src of ["/", "/index.html"]) {
      expect(bySource.get(src)).toContain("no-cache");
      expect(bySource.get(src)).toContain("must-revalidate");
      expect(bySource.get(src)).not.toContain("no-store");
    }
    expect(bySource.get("/sw.js")).toContain("no-store");
  });
});

