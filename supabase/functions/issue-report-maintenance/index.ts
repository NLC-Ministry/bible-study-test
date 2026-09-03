// 回報對話串維護（migration 0153）。由排程（Supabase Scheduled Function / Cron）
// 每天呼叫一次。verify_jwt = false —— 用共享密鑰 header 守門。
//
//   POST { }                → 只跑 autoclose（管理員回覆後 14 天無回應 → 結案）
//   POST { "purge": true }   → 另外跑 purge（結案 180 天 → 刪訊息列）+ 掃孤兒截圖
//
// 需要的 secrets：
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY（平台內建）
//   ISSUE_REPORT_MAINTENANCE_SECRET（自訂；排程呼叫時放在 x-maintenance-secret）

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = "issue-report-shots";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function sweepOrphanShots(supabase: any): Promise<number> {
  // DB 端所有還在用的路徑
  const used = new Set<string>();
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from("issue_report_messages")
      .select("attachment_path")
      .not("attachment_path", "is", null)
      .range(from, from + page - 1);
    if (error) throw error;
    (data || []).forEach((r: any) => {
      if (r.attachment_path && r.attachment_path !== "pending") used.add(r.attachment_path);
    });
    if (!data || data.length < page) break;
    from += page;
  }

  // Storage 端：<report_id>/<file> 兩層
  const orphans: string[] = [];
  const { data: folders, error: folderErr } = await supabase.storage.from(BUCKET).list("", { limit: 1000 });
  if (folderErr) throw folderErr;
  for (const folder of folders || []) {
    if (!folder?.name) continue;
    const { data: files, error: fileErr } = await supabase.storage
      .from(BUCKET)
      .list(folder.name, { limit: 1000 });
    if (fileErr) continue;
    for (const f of files || []) {
      if (!f?.name) continue;
      const full = `${folder.name}/${f.name}`;
      if (!used.has(full)) orphans.push(full);
    }
  }

  let removed = 0;
  for (let i = 0; i < orphans.length; i += 100) {
    const batch = orphans.slice(i, i + 100);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);
    if (!error) removed += batch.length;
  }
  return removed;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const secret = Deno.env.get("ISSUE_REPORT_MAINTENANCE_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "server_not_configured" }, 500);
  }
  if (req.headers.get("x-maintenance-secret") !== secret) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const out: Record<string, unknown> = {};

  try {
    const { data: closed, error: closeErr } = await supabase.rpc("issue_threads_autoclose");
    if (closeErr) throw closeErr;
    out.autoclosed = closed ?? 0;

    if (body?.purge === true) {
      const days = Number.isInteger(body.older_than_days) ? body.older_than_days : 180;
      const { data: purged, error: purgeErr } = await supabase.rpc("issue_threads_purge_messages", {
        p_older_than_days: days
      });
      if (purgeErr) throw purgeErr;
      out.purgedMessages = purged ?? 0;
      out.orphanShotsRemoved = await sweepOrphanShots(supabase);
    }
  } catch (err) {
    console.error("issue-report-maintenance failed:", err);
    return jsonResponse({ error: String((err as any)?.message || err) }, 500);
  }

  return jsonResponse({ ok: true, ...out });
});
