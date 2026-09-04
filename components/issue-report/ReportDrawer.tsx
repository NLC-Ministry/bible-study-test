// components/issue-report/ReportDrawer.tsx
import React from "react";
import { Loader2, CheckCircle, AlertCircle, X, ChevronLeft, ImagePlus, Send, Shield } from "lucide-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ReportPipeline,
  ThreadPipeline,
  compressScreenshot,
  queueOfflineThreadMessage,
  type ThreadImage,
} from "./IssueReportBlocks.ts";
import {
  NativeSelect,
  NativeSelectOption,
} from "../ui/native-select.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { AdminThreadPane, AdminMiniList } from "./AdminReportView.tsx";

export const reportSchema = z.object({
  category: z.enum(["bug", "ui", "data", "other"], {
    error: () => "請選擇有效的問題分類"
  }),
  description: z.string()
    .trim()
    .min(1, "請填寫問題描述")
    .max(500, "問題描述最多限制 500 字")
});

type ReportFormValues = z.infer<typeof reportSchema>;

export function descriptionCounterClassName(length: number): string {
  return length > 500 ? "text-xs text-destructive" : "text-xs text-muted-foreground";
}

const reportMessageClassName = "flex items-center gap-2 rounded-md border p-3 text-sm font-medium";
const reportFieldLabelClassName = "text-sm font-medium text-muted-foreground";
const reportErrorClassName = "mt-0.5 text-xs text-destructive";
const reportHelperClassName = "text-xs text-muted-foreground";

interface ReportDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTab?: "form" | "my-reports";
  onReportsViewed?: () => void;
  mode?: "user" | "admin";           // admin = 「回覆模式」，泡泡直接進最新對話
  canToggleMode?: boolean;           // 只有管理員給 true
  onToggleMode?: (next: "user" | "admin") => void;
}

export const ReportDrawer: React.FC<ReportDrawerProps> = ({
  isOpen, onClose, defaultTab = "form", onReportsViewed,
  mode = "user", canToggleMode = false, onToggleMode
}) => {
  // 管理員「回覆模式」：泡泡打開直接進最新回報對話
  const [adminOpenId, setAdminOpenId] = React.useState<string | null>(null);
  const [adminListKey, setAdminListKey] = React.useState(0);
  React.useEffect(() => {
    if (!isOpen || mode !== "admin") { setAdminOpenId(null); return; }
    // 每次打開重置成「自動開最新」
    setAdminOpenId(null);
    setAdminListKey(k => k + 1);
  }, [isOpen, mode]);
  const [activeTab, setActiveTab] = React.useState<"form" | "my-reports">(defaultTab);
  const [isLoading, setIsLoading] = React.useState(false);
  const [message, setMessage] = React.useState<{ type: "success" | "error"; text: string } | null>(null);
  const [myReports, setMyReports] = React.useState<any[]>([]);
  const [isFetchingReports, setIsFetchingReports] = React.useState(false);

  // Conversation view (one open ticket)
  const [openReportId, setOpenReportId] = React.useState<string | null>(null);
  const [thread, setThread] = React.useState<any | null>(null);
  const [threadLoading, setThreadLoading] = React.useState(false);
  const [composerText, setComposerText] = React.useState("");
  const [composerImage, setComposerImage] = React.useState<ThreadImage | null>(null);
  const [composerBusy, setComposerBusy] = React.useState(false);
  const [composerError, setComposerError] = React.useState<string | null>(null);
  const [lightbox, setLightbox] = React.useState<string | null>(null);
  const pollRef = React.useRef<number | null>(null);

  const loadMyReports = async (_markSeen: boolean) => {
    setIsFetchingReports(true);
    const result = await ThreadPipeline.myReports();
    setIsFetchingReports(false);
    if (!result.success) return;
    setMyReports(result.rows);
  };

  const loadThread = async (reportId: string, markRead = true) => {
    const res = await ThreadPipeline.get(reportId, markRead);
    if (res.success && res.data) {
      setThread(res.data);
      if (markRead) {
        setMyReports(prev => prev.map(r => (r.id === reportId ? { ...r, unread: false } : r)));
        onReportsViewed?.();
      }
    }
  };

  const openThread = async (reportId: string) => {
    setOpenReportId(reportId);
    setThread(null);
    setComposerText("");
    setComposerImage(null);
    setComposerError(null);
    setThreadLoading(true);
    await loadThread(reportId, true);
    setThreadLoading(false);
  };

  const closeThread = () => {
    setOpenReportId(null);
    setThread(null);
    void loadMyReports(false);
  };

  // Poll the open thread every 20s while the drawer + a thread are visible.
  React.useEffect(() => {
    if (!isOpen || !openReportId) return;
    const tick = () => {
      if (document.visibilityState === "visible") void loadThread(openReportId, true);
    };
    pollRef.current = window.setInterval(tick, 20000);
    const onVis = () => { if (document.visibilityState === "visible") void loadThread(openReportId, true); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, openReportId]);

  const pickImage = async (file: File | undefined) => {
    setComposerError(null);
    if (!file) return;
    const shot = await compressScreenshot(file);
    if (!shot) { setComposerError("這張圖無法處理，請換一張（PNG / JPG / WebP）"); return; }
    setComposerImage(shot);
  };

  const sendMessage = async () => {
    const text = composerText.trim();
    if (!openReportId || (!text && !composerImage) || composerBusy) return;
    setComposerBusy(true);
    setComposerError(null);
    const res = await ThreadPipeline.post(openReportId, { body: text, image: composerImage });
    setComposerBusy(false);
    if (res.success) {
      setComposerText("");
      setComposerImage(null);
      await loadThread(openReportId, true);
    } else if (res.error === "not_logged_in" || res.error === "network_error") {
      await queueOfflineThreadMessage(openReportId, text, composerImage);
      setComposerText("");
      setComposerImage(null);
      setComposerError("目前無法連線，訊息已排入佇列，恢復連線後會自動送出。");
    } else if (res.error === "rate_limited") {
      setComposerError("訊息太頻繁，請稍候再送。");
    } else if (res.error === "thread_full") {
      setComposerError("這則對話已達上限，如仍有問題請另開新回報。");
    } else {
      setComposerError("送出失敗，請再試一次。");
    }
  };

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
    reset
  } = useForm<ReportFormValues>({
    resolver: zodResolver(reportSchema),
    defaultValues: {
      category: "bug",
      description: ""
    }
  });

  React.useEffect(() => {
    if (isOpen) {
      setActiveTab(defaultTab);
      let isMounted = true;
      loadMyReports(defaultTab === "my-reports").catch(() => {
        if (isMounted) setIsFetchingReports(false);
      });
      return () => { isMounted = false; };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultTab]);

  const watchDescription = watch("description", "") || "";

  const handleClose = () => {
    onClose();
    reset();
    setMessage(null);
  };

  const onSubmit = async (data: ReportFormValues) => {
    setIsLoading(true);
    setMessage(null);

    const result = await ReportPipeline.execute(data.category, data.description);
    setIsLoading(false);

    if (result.success) {
      const isOffline = result.source === "offline";
      setMessage({
        type: "success",
        text: isOffline
          ? "已保存至離線佇列，恢復連線後會自動上傳！"
          : "已送出。管理員的回覆會出現在這個對話裡，你也可以隨時補充訊息或截圖。"
      });
      reset();
      if (!isOffline && result.reportId) {
        // Jump straight into the new ticket's conversation.
        setActiveTab("my-reports");
        void loadMyReports(false);
        void openThread(result.reportId);
        setMessage(null);
      } else {
        setTimeout(() => { handleClose(); }, 2000);
      }
    } else {
      setMessage({
        type: "error",
        text: result.error || "回報提交失敗，請重試"
      });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-modal bg-background md:flex md:items-center md:justify-center md:bg-black/70 md:p-6">
      <section
        className="flex h-[100dvh] w-full flex-col bg-background md:h-auto md:max-h-[90dvh] md:max-w-lg md:rounded-lg md:border md:border-border md:shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-report-title"
        aria-describedby="issue-report-description"
      >
        <header className="shrink-0 border-b border-border p-4 text-center sm:text-left">
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1.5">
              <h2 id="issue-report-title" className="text-lg font-semibold leading-none tracking-tight text-foreground">
                {mode === "admin" ? "回報對話（回覆模式）" : "問題回報與對話"}
              </h2>
              <p id="issue-report-description" className="text-sm text-muted-foreground">
                {mode === "admin"
                  ? "直接進最新的回報對話，快速回覆。"
                  : "回報後可以在這裡跟我們一來一往討論、補充截圖。"}
              </p>
            </div>
            <button
              type="button"
              className="secondary-btn h-9 w-9 shrink-0 p-0"
              onClick={handleClose}
              aria-label="關閉"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {canToggleMode && (
            <div className="mt-3 flex gap-1 rounded-lg border border-border p-1 text-sm font-medium">
              <button
                type="button"
                aria-pressed={mode === "admin"}
                className={`flex-1 rounded-md py-1.5 transition-colors ${
                  mode === "admin"
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-foreground hover:bg-accent"
                }`}
                onClick={() => onToggleMode?.("admin")}
              >
                🛠 回覆模式
              </button>
              <button
                type="button"
                aria-pressed={mode === "user"}
                className={`flex-1 rounded-md py-1.5 transition-colors ${
                  mode === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-foreground hover:bg-accent"
                }`}
                onClick={() => onToggleMode?.("user")}
              >
                🙋 使用者模式
              </button>
            </div>
          )}

          {mode !== "admin" && (
          <div className="mt-3 flex border-b border-border">
            <button
              type="button"
              className={`flex-1 pb-2 text-center text-sm font-medium border-b-2 transition-colors ${
                activeTab === "my-reports"
                  ? "border-primary text-primary font-semibold"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              style={{ background: "transparent", boxShadow: "none" }}
              onClick={() => {
                setActiveTab("my-reports");
                setOpenReportId(null);
                loadMyReports(true);
              }}
            >
              💬 我的對話
            </button>
            <button
              type="button"
              className={`flex-1 pb-2 text-center text-sm font-medium border-b-2 transition-colors ${
                activeTab === "form"
                  ? "border-primary text-primary font-semibold"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              style={{ background: "transparent", boxShadow: "none" }}
              onClick={() => { setActiveTab("form"); setOpenReportId(null); }}
            >
              ＋ 新問題
            </button>
          </div>
          )}
        </header>

        {mode === "admin" ? (
          adminOpenId ? (
            <AdminThreadPane
              embedded
              reportId={adminOpenId}
              onBack={() => { setAdminOpenId(null); setAdminListKey(k => k + 1); }}
              onClose={handleClose}
              onChanged={() => { setAdminListKey(k => k + 1); onReportsViewed?.(); }}
            />
          ) : (
            <AdminMiniList
              reloadKey={adminListKey}
              autoOpenNewest
              onOpen={(id) => setAdminOpenId(id)}
            />
          )
        ) : activeTab === "form" ? (
          <form onSubmit={handleSubmit(onSubmit)} className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
            <div className="flex flex-col gap-4">
              {message && (
                <div
                  className={reportMessageClassName}
                  style={
                    message.type === "success"
                      ? {
                          backgroundColor: "var(--color-success-subtle)",
                          borderColor: "var(--color-success-border)",
                          color: "var(--color-success-foreground)",
                        }
                      : {
                          backgroundColor: "var(--color-danger-subtle)",
                          borderColor: "var(--color-danger)",
                          color: "var(--color-danger-foreground)",
                        }
                  }
                >
                  {message.type === "success" ? (
                    <CheckCircle className="h-4 w-4 shrink-0" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0" />
                  )}
                  <span>{message.text}</span>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label htmlFor="category" className={reportFieldLabelClassName}>
                  問題分類
                </label>
                <NativeSelect id="category" disabled={isLoading} {...register("category")}>
                  <NativeSelectOption value="bug">Bug 錯誤</NativeSelectOption>
                  <NativeSelectOption value="ui">UI 建議</NativeSelectOption>
                  <NativeSelectOption value="data">資料問題</NativeSelectOption>
                  <NativeSelectOption value="other">其他</NativeSelectOption>
                </NativeSelect>
                {errors.category && (
                  <span className={reportErrorClassName}>{errors.category.message}</span>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="description" className={reportFieldLabelClassName}>
                    詳細描述
                  </label>
                  <span className={descriptionCounterClassName(watchDescription.length)}>
                    {watchDescription.length}/500
                  </span>
                </div>
                <Textarea
                  id="description"
                  rows={4}
                  placeholder="請詳細描述問題發生的情境或建議作法..."
                  disabled={isLoading}
                  {...register("description")}
                />
                {errors.description && (
                  <span className={reportErrorClassName}>{errors.description.message}</span>
                )}
                <span className={reportHelperClassName}>
                  送出時系統會自動包含當前的網頁 URL 與瀏覽器版本資訊。
                </span>
              </div>

              <button
                type="submit"
                disabled={isLoading || watchDescription.length < 1 || watchDescription.length > 500}
                className="primary-btn w-full mt-2 justify-center"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>處理中...</span>
                  </>
                ) : (
                  <span>提交報告</span>
                )}
              </button>
              <button type="button" className="secondary-btn w-full" onClick={handleClose}>
                取消
              </button>
            </div>
          </form>
        ) : openReportId ? (
          <ThreadView
            loading={threadLoading}
            thread={thread}
            onBack={closeThread}
            composerText={composerText}
            setComposerText={setComposerText}
            composerImage={composerImage}
            clearImage={() => setComposerImage(null)}
            onPickImage={pickImage}
            onSend={sendMessage}
            busy={composerBusy}
            error={composerError}
            onOpenLightbox={setLightbox}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {isFetchingReports ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="text-sm">正在載入我的回報…</span>
              </div>
            ) : myReports.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
                <span className="text-3xl mb-2">💬</span>
                <p className="text-sm font-medium text-foreground">還沒有任何回報</p>
                <p className="text-xs text-muted-foreground mt-1">遇到問題或有建議，歡迎點「填寫回報」告訴我們。</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {myReports.map((report) => (
                  <button
                    key={report.id}
                    type="button"
                    onClick={() => openThread(report.id)}
                    className="w-full text-left rounded-lg border border-border bg-card p-3.5 shadow-sm transition-all hover:border-muted-foreground/40"
                  >
                    <div className="flex items-center gap-2">
                      {report.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="有新回覆" />}
                      <span className={CATEGORY_BADGE_CLASS}>
                        {CATEGORY_LABEL[report.category] || report.category}
                      </span>
                      <span className={statusBadgeClass(report.status)}>
                        {STATUS_LABEL[report.status] || report.status}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {formatWhen(report.lastMessageAt || report.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-foreground line-clamp-2 leading-relaxed">
                      {report.description}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {lightbox && (
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/85 p-4"
            onClick={() => setLightbox(null)}
          >
            <img src={lightbox} alt="截圖" className="max-h-[90dvh] max-w-full rounded-md object-contain" />
          </div>
        )}
      </section>
    </div>
  );
};

export const CATEGORY_LABEL: Record<string, string> = {
  bug: "Bug 錯誤", ui: "UI 建議", data: "資料問題", other: "其他"
};
export const STATUS_LABEL: Record<string, string> = {
  pending: "待處理", processing: "處理中", resolved: "已解決", ignored: "已存檔"
};
// 一律用設計系統的 .stat-badge token（隨 light/dark/warm 主題切換、對比達標）。
// 不要在這裡塞 rgba/hex —— 深色主題下會看不清。
const STATUS_BADGE_VARIANT: Record<string, string> = {
  pending: "stat-badge--warning",
  processing: "stat-badge--brand",
  resolved: "stat-badge--success",
  ignored: "stat-badge--neutral"
};
export function statusBadgeClass(status: string): string {
  return `stat-badge ${STATUS_BADGE_VARIANT[status] || "stat-badge--neutral"}`;
}
export const CATEGORY_BADGE_CLASS = "stat-badge stat-badge--neutral";
export function formatWhen(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "剛剛";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`;
  return d.toLocaleDateString("zh-TW");
}
export function clockTime(iso?: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}
export function dayKey(iso?: string): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toDateString() : "";
}
export function dayLabel(iso?: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yst = new Date(); yst.setDate(yst.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "今天";
  if (d.toDateString() === yst.toDateString()) return "昨天";
  return d.toLocaleDateString("zh-TW", { month: "long", day: "numeric" });
}
// Group consecutive messages by the same author within 5 minutes.
export function groupMessages(messages: any[]): any[][] {
  const groups: any[][] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    const prev = last && last[last.length - 1];
    const close = prev
      && prev.authorRole === m.authorRole
      && prev.isInternal === m.isInternal
      && Math.abs(new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 5 * 60_000
      && dayKey(prev.createdAt) === dayKey(m.createdAt);
    if (close) last.push(m);
    else groups.push([m]);
  }
  return groups;
}
const THREAD_HINT_KEY = "issue_thread_hint_seen";

interface ThreadViewProps {
  loading: boolean;
  thread: any | null;
  onBack: () => void;
  composerText: string;
  setComposerText: (v: string) => void;
  composerImage: ThreadImage | null;
  clearImage: () => void;
  onPickImage: (f: File | undefined) => void;
  onSend: () => void;
  busy: boolean;
  error: string | null;
  onOpenLightbox: (url: string) => void;
}

const ThreadView: React.FC<ThreadViewProps> = ({
  loading, thread, onBack, composerText, setComposerText,
  composerImage, clearImage, onPickImage, onSend, busy, error, onOpenLightbox
}) => {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const report = thread?.report;
  const messages: any[] = Array.isArray(thread?.messages) ? thread.messages : [];
  const groups = React.useMemo(() => groupMessages(messages), [messages]);

  const [hintDismissed, setHintDismissed] = React.useState(true);
  React.useEffect(() => {
    try { setHintDismissed(localStorage.getItem(THREAD_HINT_KEY) === "1"); } catch (_e) { setHintDismissed(false); }
  }, []);
  const dismissHint = () => {
    setHintDismissed(true);
    try { localStorage.setItem(THREAD_HINT_KEY, "1"); } catch (_e) { /* noop */ }
  };

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, loading]);

  // auto-grow composer up to ~5 lines
  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }, [composerText]);

  const lastMineAt = React.useMemo(() => {
    const mine = messages.filter((m) => m.authorRole === "member");
    return mine.length ? mine[mine.length - 1].createdAt : null;
  }, [messages]);
  const adminSaw = lastMineAt && thread?.report?.adminLastReadAt
    && new Date(thread.report.adminLastReadAt).getTime() >= new Date(lastMineAt).getTime();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 flex items-center gap-2 border-b border-border px-3 py-2">
        <button type="button" onClick={onBack} className="secondary-btn h-8 w-8 p-0" aria-label="返回列表">
          <ChevronLeft className="h-4 w-4" />
        </button>
        {report && (
          <>
            <span className={CATEGORY_BADGE_CLASS}>
              {CATEGORY_LABEL[report.category] || report.category}
            </span>
            <span className={statusBadgeClass(report.status)}>
              {STATUS_LABEL[report.status] || report.status}
            </span>
          </>
        )}
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {loading && !thread ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm">載入對話…</span>
          </div>
        ) : (
          <>
            {!hintDismissed && (
              <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-foreground">
                <span>我們會在這裡回覆你 👇 有補充直接打在下面，也可以傳截圖。</span>
                <button type="button" onClick={dismissHint} className="ml-auto shrink-0 bg-transparent text-foreground/70 hover:text-foreground" aria-label="知道了">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {report && (
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-[11px] font-semibold text-muted-foreground mb-1">
                  你的回報 · {formatWhen(report.createdAt)}
                </div>
                <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{report.description}</p>
              </div>
            )}

            {messages.length === 0 && (
              <div className="mx-auto my-2 rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
                已送出，等待管理員回覆…
              </div>
            )}

            {groups.map((grp, gi) => {
              const m0 = grp[0];
              const mine = m0.authorRole === "member";
              const prevGrp = groups[gi - 1];
              const showDay = !prevGrp || dayKey(prevGrp[0].createdAt) !== dayKey(m0.createdAt);
              return (
                <React.Fragment key={m0.id}>
                  {showDay && (
                    <div className="mx-auto my-1 rounded-full bg-muted px-3 py-0.5 text-[11px] text-muted-foreground">
                      {dayLabel(m0.createdAt)}
                    </div>
                  )}
                  <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                    {!mine && (
                      <span className="mb-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Shield className="h-3 w-3 text-primary" /> 管理員
                      </span>
                    )}
                    <div className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
                      {grp.map((m) => (
                        <div
                          key={m.id}
                          className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                            mine
                              ? "bg-primary text-primary-foreground rounded-br-sm"
                              : "bg-card border border-border text-foreground rounded-bl-sm"
                          }`}
                        >
                          {m.body && <span>{m.body}</span>}
                          {m.attachmentUrl && (
                            <img
                              src={m.attachmentUrl}
                              alt="截圖"
                              onClick={() => onOpenLightbox(m.attachmentUrl)}
                              className={`${m.body ? "mt-2 " : ""}max-h-52 max-w-full cursor-pointer rounded-md object-cover`}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                    <span className="mt-0.5 text-[10px] text-muted-foreground">
                      {clockTime(grp[grp.length - 1].createdAt)}
                    </span>
                  </div>
                </React.Fragment>
              );
            })}

            {adminSaw && (
              <span className="-mt-2 self-end text-[10px] text-muted-foreground">管理員已讀</span>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        {composerImage && (
          <div className="mb-2 flex items-center gap-2">
            <img
              src={`data:${composerImage.mime};base64,${composerImage.base64}`}
              alt="待送截圖"
              className="h-14 w-14 rounded-md border border-border object-cover"
            />
            <button type="button" className="secondary-btn text-xs" onClick={clearImage}>移除</button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => { onPickImage(e.target.files?.[0]); e.target.value = ""; }}
          />
          <button
            type="button"
            className="secondary-btn h-10 w-10 shrink-0 p-0"
            onClick={() => fileRef.current?.click()}
            aria-label="加截圖"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <Textarea
            ref={taRef}
            rows={1}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value.slice(0, 500))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); }
            }}
            placeholder="輸入訊息…"
            className="max-h-[120px] min-h-[2.5rem] flex-1 resize-none rounded-2xl"
          />
          <button
            type="button"
            className="primary-btn h-10 w-10 shrink-0 p-0 justify-center"
            disabled={busy || (!composerText.trim() && !composerImage)}
            onClick={onSend}
            aria-label="送出"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
};
