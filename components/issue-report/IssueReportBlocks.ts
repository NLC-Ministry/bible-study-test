// components/issue-report/IssueReportBlocks.ts

/**
 * ValidateReportBlock: Handles sanitization and basic check constraints for inputs
 */
export class ValidateReportBlock {
  /**
   * Sanitizes text inputs by escaping/removing script tags for XSS protection
   */
  static sanitize(text: string): string {
    if (!text) return "";
    // Filter out script tags and inline javascript event handlers
    let sanitized = text
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/on\w+\s*=\s*"(?:[^"]*)"/gi, "")
      .replace(/on\w+\s*=\s*'(?:[^']*)'/gi, "")
      .replace(/javascript\s*:\s*/gi, "");
    
    // Escape HTML entities to prevent rendering arbitrary HTML
    return sanitized
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  /**
   * Validates Category and Description criteria
   */
  static validate(category: string, description: string): { success: boolean; error?: string; sanitizedDescription?: string } {
    const validCategories = ["bug", "ui", "data", "other"];
    if (!validCategories.includes(category)) {
      return { success: false, error: "無效的分類項目" };
    }

    if (!description || description.trim().length === 0) {
      return { success: false, error: "回報內容不能為空" };
    }

    const trimmed = description.trim();
    if (trimmed.length < 1) {
      return { success: false, error: "回報內容太短（最少 1 個字）" };
    }
    if (trimmed.length > 500) {
      return { success: false, error: "回報內容太長（最多 500 個字）" };
    }

    return { 
      success: true, 
      sanitizedDescription: this.sanitize(trimmed) 
    };
  }
}

/**
 * OfflineQueue: Simple self-contained IndexedDB store for offline storage
 */
export class OfflineQueue {
  private dbName = "issue_reports_offline_db";
  private storeName = "reports_queue";
  private dbVersion = 1;

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not supported"));
        return;
      }
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async add(data: any): Promise<string> {
    const db = await this.openDb();
    const id = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2) + Date.now().toString(36);

    const record = { 
      ...data, 
      id, 
      created_at: new Date().toISOString() 
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readwrite");
      const store = transaction.objectStore(this.storeName);
      store.add(record);
      transaction.oncomplete = () => resolve(id);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getAll(): Promise<any[]> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readonly");
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readwrite");
      const store = transaction.objectStore(this.storeName);
      store.delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
}

/**
 * SubmitReportBlock: Decides whether to send online or store offline
 */
export class SubmitReportBlock {
  private static queue = new OfflineQueue();

  /**
   * Helper to check online status (can be mocked in tests)
   */
  static isOnline(): boolean {
    return typeof navigator !== "undefined" ? navigator.onLine : true;
  }

  static async submit(reportData: {
    category: string;
    description: string;
    url?: string;
    user_agent?: string;
    user_id?: string;
  }): Promise<{ success: boolean; source: "online" | "offline"; error?: string; reportId?: string }> {
    if (this.isOnline()) {
      try {
        const state = (window as any).state;
        const supabase = state?.supabase;
        if (!supabase) {
          throw new Error("Supabase client is not initialized");
        }

        // .select("id") so the drawer can jump straight into the new ticket's
        // conversation. Works for both the real client and the nlc-data shim;
        // guarded so a builder without .select() (older shim / test mock) still
        // completes the insert.
        let insertQuery: any = supabase.from("issue_reports").insert([reportData]);
        if (insertQuery && typeof insertQuery.select === "function") {
          insertQuery = insertQuery.select("id").single();
        }
        const { data, error } = await insertQuery;

        if (error) throw error;
        return { success: true, source: "online", reportId: data?.id };
      } catch (err: any) {
        console.warn("[IssueReport] Online submission failed, caching to offline queue:", err);
        // Fallback to offline queue if online request fails
        await this.queue.add({ ...reportData, kind: "new_report" });
        return { success: true, source: "offline" };
      }
    } else {
      // Offline mode
      await this.queue.add({ ...reportData, kind: "new_report" });
      return { success: true, source: "offline" };
    }
  }
}

/**
 * ReportPipeline: Coordinates validation, concurrency lock, and submission
 */
export class ReportPipeline {
  private static isLocked = false;

  static async execute(category: string, description: string): Promise<{ success: boolean; source?: "online" | "offline"; error?: string; reportId?: string }> {
    // Concurrency Lock / Debounce check
    if (this.isLocked) {
      return { success: false, error: "提交處理中，請勿重複連點" };
    }

    this.isLocked = true;

    try {
      // 1. Validation & Sanitization
      const validation = ValidateReportBlock.validate(category, description);
      if (!validation.success) {
        return { success: false, error: validation.error };
      }

      // 2. Fetch context details
      const state = (window as any).state;
      const url = typeof window !== "undefined" ? window.location.href : "";
      const user_agent = typeof navigator !== "undefined" ? navigator.userAgent : "";
      const user_id = state?.currentUser?.id || null;

      // 3. Submit
      const result = await SubmitReportBlock.submit({
        category,
        description: validation.sanitizedDescription || description,
        url,
        user_agent,
        user_id
      });

      return result;
    } catch (err: any) {
      return { success: false, error: err.message || "提交失敗，請稍後再試" };
    } finally {
      this.isLocked = false;
    }
  }
}

export class FetchMyReportsPipeline {
  static async execute(): Promise<{ success: boolean; data?: any[]; error?: string }> {
    try {
      const state = (window as any).state;
      const currentUser = state?.currentUser;
      if (!currentUser?.id) {
        return { success: true, data: [] };
      }

      const supabase = state?.supabase;
      const cfg = state?.supabaseConfig || {};
      const supabaseUrl = cfg.url || "";
      const supabaseAnonKey = cfg.anonKey || "";

      let accessToken = "";
      if (supabase && typeof supabase.auth?.getSession === "function") {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) accessToken = session.access_token;
      }
      if (!accessToken && (window as any).auth && typeof (window as any).auth.getValidAccessToken === "function") {
        accessToken = await (window as any).auth.getValidAccessToken();
      }

      if (accessToken && supabaseUrl) {
        const functionUrl = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/nlc-data`;
        const response = await fetch(functionUrl, {
          method: "POST",
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            table: "issue_reports",
            action: "select",
            select: "id, created_at, category, description, status, metadata",
            filters: [{ type: "eq", column: "user_id", value: currentUser.id }],
            order: { column: "created_at", ascending: false }
          })
        });

        if (response.ok) {
          const payload = await response.json().catch(() => ({}));
          return { success: true, data: payload.data || [] };
        }
      }

      if (supabase && typeof supabase.from === "function") {
        const { data, error } = await supabase
          .from("issue_reports")
          .select("id, created_at, category, description, status, metadata")
          .eq("user_id", currentUser.id)
          .order("created_at", { ascending: false });

        if (!error) {
          return { success: true, data: data || [] };
        }
      }

      return { success: true, data: [] };
    } catch (err: any) {
      console.error("[IssueReport] Fetch my reports error:", err);
      return { success: false, error: err.message || "讀取歷史回報失敗" };
    }
  }
}

/**
 * How many of a member's own reports have an admin reply they haven't
 * viewed yet — drives the numbered badge on the floating report button.
 */
export function countUnseenReplies(reports: any[]): number {
  if (!Array.isArray(reports)) return 0;
  return reports.filter(r => r?.metadata?.reply && !r?.metadata?.reply_seen_at).length;
}

/**
 * MarkReplySeenPipeline: clears the unread-reply badge for one report.
 * Deliberately does NOT send arbitrary metadata — the server
 * (mark_issue_report_reply_seen in nlc-data) recomputes the merged metadata
 * itself from the current row, so this call can only ever touch
 * reply_seen_at, never the reply text/status/etc. on the caller's own report.
 */
export class MarkReplySeenPipeline {
  static async execute(reportId: string): Promise<{ success: boolean; error?: string }> {
    if (!reportId) return { success: false, error: "missing_report_id" };
    try {
      const state = (window as any).state;
      const currentUser = state?.currentUser;
      if (!currentUser?.id) return { success: false, error: "not_logged_in" };

      const supabase = state?.supabase;
      const cfg = state?.supabaseConfig || {};
      const supabaseUrl = cfg.url || "";
      const supabaseAnonKey = cfg.anonKey || "";

      let accessToken = "";
      if (supabase && typeof supabase.auth?.getSession === "function") {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) accessToken = session.access_token;
      }
      if (!accessToken && (window as any).auth && typeof (window as any).auth.getValidAccessToken === "function") {
        accessToken = await (window as any).auth.getValidAccessToken();
      }

      if (accessToken && supabaseUrl) {
        const functionUrl = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/nlc-data`;
        const response = await fetch(functionUrl, {
          method: "POST",
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ action: "mark_issue_report_reply_seen", report_id: reportId })
        });
        return { success: response.ok };
      }

      // Dev-mode (real Supabase client) fallback: same read-then-merge
      // pattern the server uses, so this path also never overwrites any
      // metadata key besides reply_seen_at.
      if (supabase && typeof supabase.from === "function") {
        const { data: existing } = await supabase
          .from("issue_reports")
          .select("metadata")
          .eq("id", reportId)
          .eq("user_id", currentUser.id)
          .maybeSingle();
        const existingMetadata = existing?.metadata || {};
        const { error } = await supabase
          .from("issue_reports")
          .update({ metadata: { ...existingMetadata, reply_seen_at: new Date().toISOString() } })
          .eq("id", reportId)
          .eq("user_id", currentUser.id);
        return { success: !error };
      }

      return { success: false, error: "no_client" };
    } catch (err: any) {
      console.error("[IssueReport] Mark reply seen error:", err);
      return { success: false, error: err.message || "標記已讀失敗" };
    }
  }
}

/**
 * Initialize offline sync trigger when network goes online
 */
export function initOfflineReportSync() {
  if (typeof window === "undefined") return;

  window.addEventListener("online", async () => {
    console.log("[IssueReport] Connection restored. Synchronizing offline queue...");
    const queue = new OfflineQueue();
    try {
      const reports = await queue.getAll();
      if (reports.length === 0) return;

      const state = (window as any).state;
      const supabase = state?.supabase;
      if (!supabase) return;

      for (const report of reports) {
        const { id, kind, ...data } = report;
        try {
          if (kind === "thread_message") {
            const res = await ThreadPipeline.post(data.report_id, {
              body: data.body || "",
              image: data.image || null
            });
            if (!res.success) throw new Error(res.error || "thread sync failed");
          } else {
            const { error } = await supabase.from("issue_reports").insert([data]);
            if (error) throw error;
          }
          await queue.delete(id);
          console.log(`[IssueReport] Sync success: ${id}`);
        } catch (err) {
          console.warn(`[IssueReport] Sync failed for ${id}:`, err);
        }
      }
    } catch (err) {
      console.error("[IssueReport] Offline sync error:", err);
    }
  });
}

// ───────────────────────── 對話串（migration 0153）─────────────────────────

async function getAccessToken(): Promise<string> {
  const state = (window as any).state;
  const supabase = state?.supabase;
  let token = "";
  try {
    if (supabase && typeof supabase.auth?.getSession === "function") {
      const { data } = await supabase.auth.getSession();
      if (data?.session?.access_token) token = data.session.access_token;
    }
  } catch (_e) { /* fall through */ }
  if (!token && (window as any).auth?.getValidAccessToken) {
    try { token = await (window as any).auth.getValidAccessToken(); } catch (_e) { /* noop */ }
  }
  return token || "";
}

/** POST one action/rpc to the nlc-data Edge Function. */
export async function callNlc(payload: Record<string, unknown>): Promise<{ success: boolean; data?: any; error?: string }> {
  const state = (window as any).state;
  const cfg = state?.supabaseConfig || {};
  const supabaseUrl = String(cfg.url || "").replace(/\/+$/, "");
  const anonKey = String(cfg.anonKey || "");
  if (!supabaseUrl) return { success: false, error: "no_config" };
  const token = await getAccessToken();
  if (!token) return { success: false, error: "not_logged_in" };
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/nlc-data`, {
      method: "POST",
      headers: {
        "apikey": anonKey,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) return { success: false, error: json?.error || `HTTP ${resp.status}` };
    return { success: true, data: json?.data };
  } catch (err: any) {
    return { success: false, error: err?.message || "network_error" };
  }
}

const rpc = (fn: string, args: Record<string, unknown>) =>
  callNlc({ action: "rpc", function: fn, args });

/**
 * Shrink a picked screenshot in-browser to WebP ≤ ~300 KB before upload.
 * Canvas re-encode also drops EXIF/GPS. Returns null on unsupported files.
 */
export async function compressScreenshot(
  file: File
): Promise<{ base64: string; mime: string; w: number; h: number } | null> {
  if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) return null;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;

  const encode = (maxSide: number, quality: number) => {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/webp", quality);
    return { dataUrl, w, h };
  };

  const CAP = 300 * 1024;
  const attempts: Array<[number, number]> = [[1600, 0.7], [1600, 0.55], [1400, 0.5], [1200, 0.42], [1000, 0.4]];
  let best: { dataUrl: string; w: number; h: number } | null = null;
  for (const [side, q] of attempts) {
    const out = encode(side, q);
    if (!out || !out.dataUrl.startsWith("data:image/webp")) continue;
    best = out;
    // rough byte size of a base64 payload
    const bytes = Math.ceil((out.dataUrl.length - out.dataUrl.indexOf(",") - 1) * 0.75);
    if (bytes <= CAP) break;
  }
  bitmap.close?.();
  if (!best) return null;
  return {
    base64: best.dataUrl.replace(/^data:[^,]*,/, ""),
    mime: "image/webp",
    w: best.w,
    h: best.h
  };
}

export interface ThreadImage { base64: string; mime: string; w: number; h: number; }

export class ThreadPipeline {
  /** 會友：我的工單清單 */
  static async myReports(): Promise<{ success: boolean; rows: any[]; error?: string }> {
    const r = await rpc("issue_my_reports", {});
    if (!r.success) return { success: false, rows: [], error: r.error };
    return { success: true, rows: Array.isArray(r.data?.rows) ? r.data.rows : [] };
  }

  /** 讀一串（回覆含 attachmentUrl 簽名網址）。順手把該串標記已讀。 */
  static async get(reportId: string, markRead = true): Promise<{ success: boolean; data?: any; error?: string }> {
    return callNlc({ action: "issue_thread_get", report_id: reportId, mark_read: markRead });
  }

  /** 發一則訊息（body 可空，但要有 image） */
  static async post(
    reportId: string,
    opts: { body?: string; image?: ThreadImage | null; isInternal?: boolean }
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return callNlc({
      action: "issue_thread_post",
      report_id: reportId,
      body: opts.body || "",
      is_internal: opts.isInternal === true,
      image: opts.image || null
    });
  }

  static async deleteAttachment(messageId: string): Promise<{ success: boolean; error?: string }> {
    const r = await callNlc({ action: "issue_thread_attachment_delete", message_id: messageId });
    return { success: r.success, error: r.error };
  }

  static async markRead(reportId: string): Promise<void> {
    await rpc("issue_thread_mark_read", { p_report_id: reportId });
  }

  /** { total, role } — 驅動浮動按鈕 / 鈴鐺的未讀數字 */
  static async unreadSummary(): Promise<{ total: number; role: string }> {
    const r = await rpc("issue_thread_unread_summary", {});
    if (!r.success || !r.data) return { total: 0, role: "anon" };
    return { total: Number(r.data.total) || 0, role: String(r.data.role || "anon") };
  }

  /** 管理端清單 */
  static async adminList(status?: string, limit = 40, offset = 0): Promise<{ success: boolean; rows: any[]; error?: string }> {
    const args: Record<string, unknown> = { p_limit: limit, p_offset: offset };
    if (status && status !== "all") args.p_status = status;
    const r = await rpc("issue_admin_thread_list", args);
    if (!r.success) return { success: false, rows: [], error: r.error };
    return { success: true, rows: Array.isArray(r.data?.rows) ? r.data.rows : [] };
  }

  static async setStatus(reportId: string, status: string): Promise<{ success: boolean; error?: string }> {
    const r = await rpc("issue_admin_set_status", { p_report_id: reportId, p_status: status });
    return { success: r.success, error: r.error };
  }
}

/** 把一則離線訊息排入佇列（送出失敗時用） */
export async function queueOfflineThreadMessage(reportId: string, body: string, image: ThreadImage | null) {
  const queue = new OfflineQueue();
  await queue.add({ kind: "thread_message", report_id: reportId, body, image });
}
