// components/issue-report/AdminReportView.tsx
import React, { useState, useEffect } from "react";
import { Loader2, ChevronLeft, ImagePlus, Send, Trash2 } from "lucide-react";
import { AdminReportTable } from "./AdminReportTable.tsx";
import { ThreadPipeline, compressScreenshot, type ThreadImage } from "./IssueReportBlocks.ts";

interface IssueReport {
  id: string;
  created_at: string;
  category: "bug" | "ui" | "data" | "other";
  description: string;
  url?: string;
  user_agent?: string;
  status: string;
  metadata?: Record<string, any>;
  profiles?: {
    name?: string;
    pastoral_zone?: string;
    small_group?: string;
  } | null;
}

const CATEGORY_MAP: Record<string, string> = {
  bug: "Bug 錯誤",
  ui: "UI 建議",
  data: "資料問題",
  other: "其他"
};

const STATUS_MAP: Record<string, string> = {
  pending: "待處理",
  processing: "處理中",
  resolved: "已解決",
  ignored: "已忽略",
  closed: "已關閉"
};

export function convertToCSV(data: IssueReport[]): string {
  if (!data || data.length === 0) return "";
  const headers = ["ID", "建立時間", "分類", "處理狀況", "官方回覆", "回覆時間", "問題描述", "頁面網址", "回報者姓名", "回報者牧區", "回報者小組"];
  const rows = data.map(item => [
    item.id,
    item.created_at,
    CATEGORY_MAP[item.category] || item.category,
    STATUS_MAP[item.status] || item.status || "待處理",
    item.metadata?.reply ? String(item.metadata.reply).replace(/"/g, '""') : "",
    item.metadata?.replied_at || "",
    (item.description || "").replace(/"/g, '""'),
    item.url || "",
    item.profiles?.name || "訪客/離線",
    item.profiles?.pastoral_zone || "",
    item.profiles?.small_group || ""
  ]);
  
  return [
    headers.join(","),
    ...rows.map(row => row.map(val => `"${val}"`).join(","))
  ].join("\n");
}

export const AdminReportView: React.FC = () => {
  const [reports, setReports] = useState<IssueReport[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const fetchReports = async () => {
    const state = (window as any).state;
    const currentUser = state?.currentUser;
    const role = (window as any).getUserRoleCode?.(currentUser)
      || currentUser?.role_definition?.code
      || 'member';
    const isUserAdmin = role === 'admin';
    if (!isUserAdmin) {
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const res = await ThreadPipeline.adminList(undefined, 100, 0);
      if (!res.success) throw new Error(res.error || "載入回報失敗");
      const mapped: IssueReport[] = res.rows.map((row: any) => ({
        id: row.id,
        created_at: row.createdAt,
        category: row.category,
        description: row.description,
        url: row.url,
        status: row.status,
        metadata: {},
        profiles: row.reporter
          ? { name: row.reporter.name, pastoral_zone: row.reporter.pastoralZone, small_group: row.reporter.smallGroup }
          : null,
        // extra fields the table reads via (report as any)
        ...( { unreadFromMember: !!row.unreadFromMember, messageCount: row.messageCount, lastMessageAt: row.lastMessageAt } as any )
      }));
      setReports(mapped);
    } catch (err: any) {
      console.error("[IssueReportAdmin] Fetch error:", err);
      setError(err.message || "載入回報失敗，請確認管理員權限");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, []);

  const state = (window as any).state;
  const currentUser = state?.currentUser;
  const role = (window as any).getUserRoleCode?.(currentUser)
    || currentUser?.role_definition?.code
    || 'member';
  const isUserAdmin = role === 'admin';

  if (!isUserAdmin) {
    return null;
  }

  const handleExportCSV = (exportData?: IssueReport[]) => {
    const target = exportData || reports;
    if (target.length === 0) return;
    const csvContent = convertToCSV(target);
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `issue_reports_export_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // 狀態下拉 / 快速回覆都走 0153 的 RPC（不再直接寫 issue_reports.metadata）。
  const handleUpdate = async (id: string, status: string, reply: string) => {
    const st = await ThreadPipeline.setStatus(id, status);
    if (!st.success) throw new Error(st.error || "狀態更新失敗");
    const text = (reply || "").trim();
    if (text) {
      const posted = await ThreadPipeline.post(id, { body: text });
      if (!posted.success) throw new Error(posted.error || "回覆送出失敗");
    }
    await fetchReports();
  };

  const handleDelete = async (id: string) => {
    const token = (window as any).auth?.getValidAccessToken
      ? await (window as any).auth.getValidAccessToken().catch(() => "")
      : "";
    const cfg = (window as any).state?.supabaseConfig || {};
    const supabaseUrl = String(cfg.url || "").replace(/\/+$/, "");
    if (!token || !supabaseUrl) throw new Error("請先登入管理員帳號");
    const response = await fetch(`${supabaseUrl}/functions/v1/nlc-data`, {
      method: "POST",
      headers: {
        "apikey": String(cfg.anonKey || ""),
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        table: "issue_reports",
        action: "delete",
        filters: [{ type: "eq", column: "id", value: id }]
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP 錯誤 ${response.status}`);
    setReports(prev => prev.filter(r => r.id !== id));
    if (openId === id) setOpenId(null);
  };

  return (
    <>
      <AdminReportTable
        reports={reports}
        isLoading={isLoading}
        error={error}
        onRefresh={fetchReports}
        onExport={handleExportCSV}
        onDelete={handleDelete}
        onUpdate={handleUpdate}
        onOpenThread={setOpenId}
      />
      {openId && (
        <AdminThreadPane
          reportId={openId}
          onClose={() => { setOpenId(null); void fetchReports(); }}
          onChanged={fetchReports}
        />
      )}
    </>
  );
};

// ───────────────────────── 管理端對話 pane ─────────────────────────

const CAT_LABEL: Record<string, string> = { bug: "Bug 錯誤", ui: "UI 建議", data: "資料問題", other: "其他" };
const ST_LABEL: Record<string, string> = { pending: "待處理", processing: "處理中", resolved: "已解決", ignored: "已存檔" };

const AdminThreadPane: React.FC<{ reportId: string; onClose: () => void; onChanged: () => void }> = ({ reportId, onClose, onChanged }) => {
  const [thread, setThread] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [image, setImage] = useState<ThreadImage | null>(null);
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const load = async () => {
    const res = await ThreadPipeline.get(reportId, true);
    if (res.success && res.data) setThread(res.data);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const iv = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 20000);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread]);

  const report = thread?.report;
  const messages: any[] = Array.isArray(thread?.messages) ? thread.messages : [];

  const send = async () => {
    const body = text.trim();
    if ((!body && !image) || busy) return;
    setBusy(true); setErr(null);
    const res = await ThreadPipeline.post(reportId, { body, image, isInternal: internal });
    setBusy(false);
    if (res.success) {
      setText(""); setImage(null); setInternal(false);
      await load();
      onChanged();
    } else {
      setErr(res.error === "rate_limited" ? "訊息太頻繁，請稍候。" : "送出失敗，請再試一次。");
    }
  };

  const pick = async (f?: File) => {
    if (!f) return;
    const shot = await compressScreenshot(f);
    if (!shot) { setErr("這張圖無法處理"); return; }
    setImage(shot);
  };

  const setStatus = async (s: string) => {
    const r = await ThreadPipeline.setStatus(reportId, s);
    if (r.success) { await load(); onChanged(); }
  };

  const delAttachment = async (messageId: string) => {
    if (!window.confirm("刪除這張截圖？")) return;
    const r = await ThreadPipeline.deleteAttachment(messageId);
    if (r.success) await load();
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-stretch justify-end bg-black/50" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col bg-background border-l border-border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center gap-2 border-b border-border px-3 py-2">
          <button type="button" onClick={onClose} className="secondary-btn h-8 w-8 p-0" aria-label="關閉">
            <ChevronLeft className="h-4 w-4" />
          </button>
          {report && (
            <>
              <span className="text-xs font-semibold rounded-full px-2 py-0.5" style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-card)" }}>
                {CAT_LABEL[report.category] || report.category}
              </span>
              <select
                value={report.status}
                onChange={(e) => setStatus(e.target.value)}
                className="ml-auto text-xs rounded-md border border-border bg-card px-2 py-1"
              >
                {Object.entries(ST_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </>
          )}
        </div>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-3 flex flex-col gap-3">
          {loading && !thread ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" /><span className="text-sm">載入對話…</span>
            </div>
          ) : (
            <>
              {report && (
                <div className="rounded-lg border border-border bg-card p-3 text-sm">
                  <div className="text-[11px] font-semibold text-muted-foreground mb-1">
                    原始回報{report.url ? ` · ${report.url}` : ""}
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed text-foreground">{report.description}</p>
                </div>
              )}
              {messages.map((m) => {
                const fromAdmin = m.authorRole === "admin";
                return (
                  <div key={m.id} className={`flex flex-col ${fromAdmin ? "items-end" : "items-start"}`}>
                    <span className="text-[11px] text-muted-foreground mb-0.5">
                      {fromAdmin ? "管理員" : "會友"}{m.isInternal ? "（內部備註）" : ""}
                    </span>
                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                      m.isInternal ? "bg-amber-100 text-amber-900 border border-amber-300"
                      : fromAdmin ? "bg-primary text-primary-foreground rounded-br-sm"
                      : "bg-card border border-border text-foreground rounded-bl-sm"
                    }`}>
                      {m.body && <span>{m.body}</span>}
                      {m.attachmentUrl && (
                        <div className={m.body ? "mt-2" : ""}>
                          <img src={m.attachmentUrl} alt="截圖" onClick={() => setLightbox(m.attachmentUrl)}
                            className="max-h-52 max-w-full cursor-pointer rounded-md object-cover" />
                          <button type="button" onClick={() => delAttachment(m.id)}
                            className="mt-1 inline-flex items-center gap-1 text-[11px] text-destructive">
                            <Trash2 className="h-3 w-3" /> 刪除截圖
                          </button>
                        </div>
                      )}
                    </div>
                    <span className="mt-0.5 text-[10px] text-muted-foreground">{new Date(m.createdAt).toLocaleString("zh-TW")}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-border p-3">
          {err && <p className="mb-2 text-xs text-destructive">{err}</p>}
          {image && (
            <div className="mb-2 flex items-center gap-2">
              <img src={`data:${image.mime};base64,${image.base64}`} alt="待送" className="h-14 w-14 rounded-md border border-border object-cover" />
              <button type="button" className="secondary-btn text-xs" onClick={() => setImage(null)}>移除</button>
            </div>
          )}
          <label className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
            內部備註（會友看不到）
          </label>
          <div className="flex items-end gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={(e) => { pick(e.target.files?.[0]); e.currentTarget.value = ""; }} />
            <button type="button" className="secondary-btn h-10 w-10 p-0" onClick={() => fileRef.current?.click()} aria-label="加截圖">
              <ImagePlus className="h-4 w-4" />
            </button>
            <textarea
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 500))}
              placeholder="輸入回覆…"
              className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-border bg-card px-3 py-2 text-sm"
            />
            <button type="button" className="primary-btn h-10 w-10 p-0 justify-center"
              disabled={busy || (!text.trim() && !image)} onClick={send} aria-label="送出">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
      {lightbox && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/85 p-4" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="截圖" className="max-h-[90dvh] max-w-full rounded-md object-contain" />
        </div>
      )}
    </div>
  );
};
