import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const jsonHeaders = { "Content-Type": "application/json" };

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function taipeiDate(date: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function utcDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid_date:${value}`);
  return parsed;
}

function dayDifference(later: string, earlier: string) {
  return Math.floor((utcDate(later).getTime() - utcDate(earlier).getTime()) / 86400000);
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// 頻道用 @handle 表示，但 YouTube 的公開 RSS 只吃 channel_id，所以先讀一次頻道
// 首頁解析出 channel_id——這一步跟用瀏覽器打開這個網址看到的是同一份公開網頁，
// 不需要登入、不使用任何帳號憑證。可用 DEVOTION_YOUTUBE_CHANNEL_ID 環境變數
// 直接指定 channel_id，跳過這個解析步驟（每次都少一次請求，也比較穩定）。
async function resolveChannelId(handle: string): Promise<string> {
  const response = await fetch(`https://www.youtube.com/@${handle}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NewLifeBibleApp/1.0; +https://bible.newlife.org.tw)" }
  });
  if (!response.ok) throw new Error(`channel_page_fetch_failed:${response.status}`);
  const html = await response.text();
  const match = html.match(/"channelId":"(UC[0-9A-Za-z_-]{22})"/)
    || html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})"/);
  if (!match) throw new Error("channel_id_not_found");
  return match[1];
}

type LatestVideo = { videoId: string; title: string; publishedTaipeiDate: string };

// YouTube 官方公開的頻道 RSS（Atom）訂閱源，任何 RSS 閱讀器都能讀，不需要
// 登入、不需要申請 API 金鑰、沒有配額限制。只看第一則（= 最新一支影片）。
async function fetchLatestVideo(channelId: string): Promise<LatestVideo | null> {
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!response.ok) throw new Error(`feed_fetch_failed:${response.status}`);
  const xml = await response.text();
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return null;
  const entry = entryMatch[1];
  const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
  const titleRaw = entry.match(/<title>([^<]*)<\/title>/)?.[1];
  const published = entry.match(/<published>([^<]+)<\/published>/)?.[1];
  if (!videoId || !titleRaw || !published) return null;
  const publishedDate = new Date(published);
  if (Number.isNaN(publishedDate.getTime())) return null;
  return {
    videoId,
    title: decodeXmlEntities(titleRaw),
    publishedTaipeiDate: taipeiDate(publishedDate)
  };
}

Deno.serve(async req => {
  const invocationId = crypto.randomUUID();
  console.info("devotion_video_sync_invocation_received", JSON.stringify({ invocationId, method: req.method, hasCronSecret: Boolean(req.headers.get("x-cron-secret")) }));
  if (req.method !== "POST") {
    console.warn("devotion_video_sync_method_rejected", JSON.stringify({ invocationId, method: req.method }));
    return respond({ error: "method_not_allowed", invocationId }, 405);
  }
  const cronSecret = Deno.env.get("DEVOTION_VIDEO_SYNC_CRON_SECRET") || "";
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    console.warn("devotion_video_sync_auth_rejected", JSON.stringify({ invocationId, secretConfigured: Boolean(cronSecret) }));
    return respond({ error: "unauthorized", invocationId }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const configuredChannelId = (Deno.env.get("DEVOTION_YOUTUBE_CHANNEL_ID") || "").trim();
  const handle = (Deno.env.get("DEVOTION_YOUTUBE_HANDLE") || "NewLifeChurch").trim().replace(/^@/, "");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("devotion_video_sync_server_not_configured", JSON.stringify({ invocationId }));
    return respond({ error: "server_not_configured", invocationId }, 500);
  }

  const body = await req.json().catch(() => ({}));
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.date || "")) ? String(body.date) : taipeiDate();
  console.info("devotion_video_sync_started", JSON.stringify({ invocationId, source: String(body?.source || "unknown"), today }));

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: plans, error: planError } = await supabase.from("global_plans")
    .select("id, name, start_date, end_date")
    .eq("plan_kind", "devotional")
    .lte("start_date", today).gte("end_date", today);
  if (planError) {
    console.error("devotion_video_sync_plan_lookup_failed", JSON.stringify({ invocationId, error: planError.message }));
    return respond({ error: planError.message, invocationId }, 500);
  }
  if (!plans || plans.length === 0) {
    console.info("devotion_video_sync_no_active_plan", JSON.stringify({ invocationId, today }));
    return respond({ date: today, status: "no_active_devotional_plan", updated: 0, invocationId });
  }

  let channelId = configuredChannelId;
  if (!channelId) {
    try {
      channelId = await resolveChannelId(handle);
    } catch (error) {
      const message = String((error as Error)?.message || error);
      console.error("devotion_video_sync_channel_resolution_failed", JSON.stringify({ invocationId, handle, error: message }));
      return respond({ error: message, invocationId }, 502);
    }
  }

  let latest: LatestVideo | null;
  try {
    latest = await fetchLatestVideo(channelId);
  } catch (error) {
    const message = String((error as Error)?.message || error);
    console.error("devotion_video_sync_feed_fetch_failed", JSON.stringify({ invocationId, channelId, error: message }));
    return respond({ error: message, channelId, invocationId }, 502);
  }
  if (!latest) {
    console.info("devotion_video_sync_feed_empty", JSON.stringify({ invocationId, channelId }));
    return respond({ date: today, channelId, status: "feed_empty", updated: 0, invocationId });
  }
  if (latest.publishedTaipeiDate !== today) {
    // 頻道今天還沒上架新影片（例如上架時間延後）：寧可留白讓管理員之後手動補，
    // 也不要把不是今天的舊影片誤植到今天的靈修內容。
    console.info("devotion_video_sync_no_new_video_today", JSON.stringify({ invocationId, today, latestPublished: latest.publishedTaipeiDate }));
    return respond({ date: today, channelId, status: "no_new_video_today", updated: 0, invocationId });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${latest.videoId}`;
  const results: Array<Record<string, unknown>> = [];
  let updated = 0;
  for (const plan of plans) {
    const dayIndex = dayDifference(today, String(plan.start_date)) + 1;
    if (dayIndex < 1) { results.push({ planId: plan.id, status: "before_plan_start" }); continue; }
    const { data: syncResult, error: syncError } = await supabase.rpc("sync_devotion_day_video", {
      p_global_plan_id: plan.id, p_day_index: dayIndex,
      p_video_url: videoUrl, p_video_title: latest.title
    });
    if (syncError) {
      console.error("devotion_video_sync_rpc_failed", JSON.stringify({ invocationId, planId: plan.id, dayIndex, error: syncError.message }));
      results.push({ planId: plan.id, dayIndex, status: "failed", error: syncError.message });
      continue;
    }
    if (syncResult?.updated) updated += 1;
    results.push({ planId: plan.id, dayIndex, status: syncResult?.updated ? "updated" : "already_set_or_missing_day" });
  }

  console.info("devotion_video_sync_finished", JSON.stringify({ invocationId, today, channelId, videoId: latest.videoId, updated, results }));
  return respond({ date: today, channelId, videoId: latest.videoId, videoTitle: latest.title, updated, results, invocationId });
});
