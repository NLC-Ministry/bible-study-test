import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, Trash2, Loader2, AlertCircle, RefreshCw, MessageSquare, Filter, Copy, Check } from "lucide-react";

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

const CATEGORY_MAP = {
  bug: "Bug 錯誤",
  ui: "UI 建議",
  data: "資料問題",
  other: "其他"
};

export type StatusFilter = "all" | "pending" | "processing" | "resolved" | "ignored";

export const STATUS_FILTER_OPTIONS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "pending", label: "待處理" },
  { id: "processing", label: "處理中" },
  { id: "resolved", label: "已解決" },
  { id: "ignored", label: "已忽略" }
];

interface AdminReportTableProps {
  reports: IssueReport[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onExport: (exportData?: IssueReport[]) => void;
  onDelete: (id: string) => Promise<void>;
  onUpdate: (id: string, status: string, reply: string) => Promise<void>;
  onOpenThread?: (id: string) => void;
}

export const AdminReportTable: React.FC<AdminReportTableProps> = ({
  reports,
  isLoading,
  error,
  onRefresh,
  onExport,
  onDelete,
  onUpdate,
  onOpenThread
}) => {
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");

  const [deleteTargetId, setDeleteTargetId] = React.useState<string | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);

  const [replyTargetId, setReplyTargetId] = React.useState<string | null>(null);
  const [replyStatus, setReplyStatus] = React.useState<string>("pending");
  const [replyText, setReplyText] = React.useState<string>("");
  const [isSavingReply, setIsSavingReply] = React.useState(false);

  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  const handleCopyText = (id: string, text: string) => {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const statusCounts = React.useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      all: reports.length,
      pending: 0,
      processing: 0,
      resolved: 0,
      ignored: 0
    };
    reports.forEach(r => {
      const st = (r.status || "pending") as StatusFilter;
      if (st in counts && st !== "all") {
        counts[st]++;
      } else if (st !== "all") {
        counts.pending++;
      }
    });
    return counts;
  }, [reports]);

  const filteredReports = React.useMemo(() => {
    if (statusFilter === "all") return reports;
    return reports.filter(r => (r.status || "pending") === statusFilter);
  }, [reports, statusFilter]);

  const handleReplyOpen = (report: IssueReport) => {
    setReplyTargetId(report.id);
    setReplyStatus(report.status || "pending");
    setReplyText(report.metadata?.reply || "");
  };

  const handleReplySave = async () => {
    if (!replyTargetId) return;
    setIsSavingReply(true);
    try {
      await onUpdate(replyTargetId, replyStatus, replyText.trim());
      setReplyTargetId(null);
    } catch (err: any) {
      alert(err.message || "更新失敗");
    } finally {
      setIsSavingReply(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTargetId) return;
    setIsDeleting(true);
    try {
      await onDelete(deleteTargetId);
      setDeleteTargetId(null);
    } catch (err: any) {
      alert(err.message || "刪除失敗");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div 
      className="admin-report-view flex w-full flex-col gap-6 p-6 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 shadow-2xl backdrop-blur-md transition-all duration-300"
    >
      {/* Header and Actions */}
      <div 
        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-800 pb-4"
      >
        <div>
          <h2 className="text-xl font-bold text-slate-100">問題與建議回報管理</h2>
          <p className="text-xs mt-1 text-slate-400">檢視並管理使用者提交的 Bug 報告與介面建議</p>
        </div>
        
        <div className="flex items-center gap-3">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onRefresh}
            disabled={isLoading}
            className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-white px-3.5 py-2 text-xs font-semibold shadow-sm transition-colors disabled:opacity-50 cursor-pointer"
            type="button"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            重新整理
          </motion.button>
          
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onExport(filteredReports)}
            disabled={filteredReports.length === 0 || isLoading}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold px-3.5 py-2 text-xs shadow-md transition-colors disabled:opacity-50 cursor-pointer"
            type="button"
          >
            <Download className="h-3.5 w-3.5" />
            匯出 Excel/CSV
          </motion.button>
        </div>
      </div>

      {/* Status Filter Bar */}
      <div 
        className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-4"
        data-testid="status-filter-bar"
      >
        <span className="text-xs font-bold text-slate-300 mr-1 flex items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 text-cyan-400" />
          處理狀態：
        </span>
        {STATUS_FILTER_OPTIONS.map((option) => {
          const count = statusCounts[option.id];
          const isActive = statusFilter === option.id;
          return (
            <motion.button
              key={option.id}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              type="button"
              data-testid={`filter-status-${option.id}`}
              onClick={() => setStatusFilter(option.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 cursor-pointer ${
                isActive
                  ? option.id === "all"
                    ? "bg-cyan-500 text-slate-950 shadow-md ring-2 ring-cyan-400/50"
                    : option.id === "pending"
                    ? "bg-amber-400 text-slate-950 shadow-md ring-2 ring-amber-300/50"
                    : option.id === "processing"
                    ? "bg-sky-400 text-slate-950 shadow-md ring-2 ring-sky-300/50"
                    : option.id === "resolved"
                    ? "bg-emerald-400 text-slate-950 shadow-md ring-2 ring-emerald-300/50"
                    : "bg-slate-300 text-slate-950 shadow-md ring-2 ring-slate-200/50"
                  : "bg-slate-800/90 text-slate-200 hover:bg-slate-700 hover:text-white border border-slate-700 shadow-sm"
              }`}
            >
              <span>{option.label}</span>
              <span
                className={`inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-extrabold leading-none ${
                  isActive
                    ? "bg-slate-950/30 text-slate-950"
                    : "bg-slate-700/80 text-slate-300 border border-slate-600/50"
                }`}
              >
                {count}
              </span>
            </motion.button>
          );
        })}
      </div>

      {/* Error State */}
      <AnimatePresence mode="wait">
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex items-start gap-3 rounded-lg p-4 text-sm border border-rose-500/40 bg-rose-950/40 text-rose-300" 
          >
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-rose-400" />
            <div>
              <span className="font-bold">載入錯誤：</span>
              {error}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reports List Table Container */}
      <div 
        className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 shadow-inner max-h-[60vh] overflow-y-auto scrollbar-thin"
      >
        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-12 text-slate-400">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
            <span className="mt-3 text-sm">正在載入回報清單...</span>
          </div>
        ) : reports.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-sm text-slate-400">
            無任何回報資料
          </div>
        ) : filteredReports.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-sm text-slate-400">
            <Filter className="h-8 w-8 text-slate-500 mb-2" />
            無符合「{STATUS_FILTER_OPTIONS.find(o => o.id === statusFilter)?.label}」狀態的回報資料
          </div>
        ) : (
          <table className="min-w-full divide-y divide-slate-800 text-left text-xs">
            <thead className="uppercase tracking-wider font-bold bg-slate-900 text-slate-300 border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">建立時間</th>
                <th className="px-4 py-3">分類</th>
                <th className="px-4 py-3">狀態</th>
                <th className="px-6 py-3 w-1/3">回報內容</th>
                <th className="px-4 py-3">姓名</th>
                <th className="px-4 py-3">牧區</th>
                <th className="px-4 py-3">小組</th>
                <th className="px-4 py-3 text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-slate-100">
              {filteredReports.map((report) => (
                <tr key={report.id} className="hover:bg-slate-900/60 transition-colors">
                  <td className="px-4 py-3.5 whitespace-nowrap text-slate-400 font-mono text-xs">
                    {new Date(report.created_at).toLocaleString("zh-TW")}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap font-medium">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 font-bold text-[11px] ${
                      report.category === "bug" 
                        ? "bg-rose-950/80 text-rose-300 border border-rose-500/50"
                        : report.category === "ui"
                        ? "bg-amber-950/80 text-amber-300 border border-amber-500/50"
                        : report.category === "data"
                        ? "bg-emerald-950/80 text-emerald-300 border border-emerald-500/50"
                        : "bg-slate-800 text-slate-300 border border-slate-600"
                    }`}>
                      {CATEGORY_MAP[report.category] || report.category}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap font-medium">
                    <select
                      value={report.status || "pending"}
                      onChange={async (e) => {
                        const newStatus = e.target.value;
                        try {
                          await onUpdate(report.id, newStatus, report.metadata?.reply || "");
                        } catch (err: any) {
                          alert(err.message || "狀態更新失敗");
                        }
                      }}
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold border focus:outline-none focus:ring-1 focus:ring-cyan-400 cursor-pointer transition-colors ${
                        report.status === "processing"
                          ? "bg-sky-950/90 text-sky-300 border-sky-500/60 hover:bg-sky-900"
                          : report.status === "resolved"
                          ? "bg-emerald-950/90 text-emerald-300 border-emerald-500/60 hover:bg-emerald-900"
                          : report.status === "ignored"
                          ? "bg-slate-800 text-slate-300 border-slate-600 hover:bg-slate-700"
                          : "bg-amber-950/90 text-amber-300 border-amber-500/60 hover:bg-amber-900"
                      }`}
                      title="變更問題處理狀態"
                    >
                      <option value="pending" className="bg-slate-900 text-amber-300 font-bold">待處理 (Pending)</option>
                      <option value="processing" className="bg-slate-900 text-sky-300 font-bold">處理中 (Processing)</option>
                      <option value="resolved" className="bg-slate-900 text-emerald-300 font-bold">已解決 (Resolved)</option>
                      <option value="ignored" className="bg-slate-900 text-slate-300 font-bold">已忽略 (Ignored)</option>
                    </select>
                  </td>
                  <td className="px-6 py-3.5 break-words leading-relaxed text-sm text-slate-100 select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                    <div className="font-normal text-slate-100 select-text cursor-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                      {report.description}
                    </div>
                    {report.metadata?.reply && (
                      <div className="mt-2 rounded-lg bg-slate-900/90 border border-cyan-500/40 p-3 text-xs shadow-md select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                        <div className="font-bold text-cyan-400 mb-1 flex items-center gap-1.5">
                          <MessageSquare className="h-3.5 w-3.5" />
                          管理員回覆：
                        </div>
                        <div className="text-slate-100 font-medium leading-relaxed break-words select-text cursor-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>{report.metadata.reply}</div>
                        {report.metadata.replied_at && (
                          <div className="mt-1.5 text-[10px] text-slate-400 text-right font-mono">
                            {new Date(report.metadata.replied_at).toLocaleString("zh-TW")}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                    {report.profiles ? (
                      <span className="font-bold text-sm text-slate-100 select-text cursor-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>{report.profiles.name || "未填姓名"}</span>
                    ) : (
                      <span className="text-slate-400">訪客 / 離線回報</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap text-xs text-slate-300 font-medium select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                    {report.profiles ? (report.profiles.pastoral_zone || "無牧區") : "-"}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap text-xs text-slate-300 font-medium select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                    {report.profiles ? (report.profiles.small_group || "無小組") : "-"}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => handleCopyText(report.id, report.description)}
                        className={`inline-flex rounded-lg p-2 border transition-colors focus:outline-none shadow-sm cursor-pointer ${
                          copiedId === report.id
                            ? "text-emerald-300 bg-emerald-950 border-emerald-500/60"
                            : "text-slate-300 bg-slate-900 hover:bg-slate-800 hover:text-white border-slate-700"
                        }`}
                        title={copiedId === report.id ? "已複製內文！" : "複製內文"}
                        type="button"
                      >
                        {copiedId === report.id ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4 text-cyan-400" />}
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => (onOpenThread ? onOpenThread(report.id) : handleReplyOpen(report))}
                        className="relative inline-flex rounded-lg p-2 text-cyan-400 bg-slate-900 hover:bg-cyan-500/20 hover:text-cyan-300 border border-cyan-500/40 transition-colors focus:outline-none shadow-sm cursor-pointer"
                        title="開啟對話"
                        type="button"
                      >
                        <MessageSquare className="h-4 w-4" />
                        {(report as any).unreadFromMember && (
                          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-rose-500 border border-slate-900" />
                        )}
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => setDeleteTargetId(report.id)}
                        className="inline-flex rounded-lg p-2 text-rose-400 bg-slate-900 hover:bg-rose-500/20 hover:text-rose-300 border border-rose-500/40 transition-colors focus:outline-none shadow-sm cursor-pointer"
                        title="刪除此回報"
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                      </motion.button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Delete Confirmation Modal / Dialog */}
      <AnimatePresence>
        {deleteTargetId && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-sm rounded-xl p-6 shadow-2xl border border-slate-700 bg-slate-900 text-slate-100"
            >
              <h3 className="text-md font-bold text-slate-100">確認刪除</h3>
              <p className="text-xs mt-2 text-slate-300 leading-relaxed">
                您確定要刪除這筆使用者問題回報嗎？此動作將從 Supabase 中永久移除，無法復原。
              </p>
              
              <div className="mt-5 flex justify-end gap-3">
                <button
                  onClick={() => setDeleteTargetId(null)}
                  disabled={isDeleting}
                  className="rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white px-4 py-2 text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer"
                  type="button"
                >
                  取消
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  disabled={isDeleting}
                  className="flex items-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold px-4 py-2 text-xs shadow-md disabled:opacity-50 cursor-pointer"
                  type="button"
                >
                  {isDeleting && <Loader2 className="h-3 w-3 animate-spin" />}
                  確定刪除
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Reply Modal / Dialog */}
      <AnimatePresence>
        {replyTargetId && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md rounded-xl p-6 shadow-2xl border border-slate-700 bg-slate-900 text-slate-100"
            >
              <h3 className="text-md font-bold text-slate-100">回覆與狀態管理</h3>
              <p className="text-xs mt-1 text-slate-400">
                撰寫回覆訊息，並變更此使用者回報的進度狀態。
              </p>
              
              <div className="mt-4 flex flex-col gap-4">
                {/* Status Selection */}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="reply-status-select" className="text-xs font-bold text-slate-300">
                    處理狀態
                  </label>
                  <select
                    id="reply-status-select"
                    value={replyStatus}
                    onChange={(e) => setReplyStatus(e.target.value)}
                    disabled={isSavingReply}
                    className="flex h-11 w-full rounded-lg border border-slate-700 bg-slate-950 text-slate-100 px-3 py-2 text-base shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50 font-bold"
                  >
                    <option value="pending" className="bg-slate-900 text-amber-300 font-bold">待處理 (Pending)</option>
                    <option value="processing" className="bg-slate-900 text-sky-300 font-bold">處理中 (Processing)</option>
                    <option value="resolved" className="bg-slate-900 text-emerald-300 font-bold">已解決 (Resolved)</option>
                    <option value="ignored" className="bg-slate-900 text-slate-300 font-bold">已忽略 (Ignored)</option>
                  </select>
                </div>

                {/* Reply Message Textarea */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label htmlFor="reply-message-textarea" className="text-xs font-bold text-slate-300">
                      回覆內容
                    </label>
                    <span className="text-[10px] text-slate-400">
                      {replyText.length} / 500 字
                    </span>
                  </div>
                  <textarea
                    id="reply-message-textarea"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value.substring(0, 500))}
                    disabled={isSavingReply}
                    rows={4}
                    placeholder="請輸入回覆使用者的訊息..."
                    className="flex w-full rounded-lg border border-slate-700 bg-slate-950 text-slate-100 px-3 py-2 text-base font-normal shadow-sm transition-colors placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
              </div>
              
              <div className="mt-5 flex justify-end gap-3">
                <button
                  onClick={() => setReplyTargetId(null)}
                  disabled={isSavingReply}
                  className="rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white px-4 py-2 text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer"
                  type="button"
                >
                  取消
                </button>
                <button
                  onClick={handleReplySave}
                  disabled={isSavingReply}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-bold px-4 py-2 text-xs shadow-md disabled:opacity-50 cursor-pointer"
                  type="button"
                >
                  {isSavingReply && <Loader2 className="h-3 w-3 animate-spin" />}
                  儲存回覆
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
