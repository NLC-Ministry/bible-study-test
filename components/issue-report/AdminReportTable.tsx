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

// 分類 → 設計系統 .stat-badge 變體（隨 light/dark/warm 主題切換、對比達標）
function categoryBadgeClass(cat: string): string {
  const v = cat === "bug" ? "stat-badge--danger"
    : cat === "ui" ? "stat-badge--warning"
    : cat === "data" ? "stat-badge--success"
    : "stat-badge--neutral";
  return `stat-badge ${v}`;
}

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
    const counts: Record<StatusFilter, number> = { all: reports.length, pending: 0, processing: 0, resolved: 0, ignored: 0 };
    reports.forEach(r => {
      const st = (r.status || "pending") as StatusFilter;
      if (st in counts && st !== "all") counts[st]++;
      else if (st !== "all") counts.pending++;
    });
    return counts;
  }, [reports]);

  const filteredReports = React.useMemo(() => {
    if (statusFilter === "all") return reports;
    return reports.filter(r => (r.status || "pending") === statusFilter);
  }, [reports, statusFilter]);

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
    <div className="admin-report-view flex w-full flex-col gap-6 p-6 rounded-xl border border-border bg-card text-foreground shadow-md">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">問題與建議回報管理</h2>
          <p className="text-sm mt-1 text-muted-foreground">檢視並管理使用者提交的 Bug 報告與介面建議</p>
        </div>
        <div className="flex items-center gap-3">
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={onRefresh}
            disabled={isLoading}
            className="secondary-btn inline-flex items-center gap-2 text-sm disabled:opacity-50"
            type="button"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            重新整理
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={() => onExport(filteredReports)}
            disabled={filteredReports.length === 0 || isLoading}
            className="primary-btn inline-flex items-center gap-2 text-sm disabled:opacity-50"
            type="button"
          >
            <Download className="h-4 w-4" />
            匯出 Excel/CSV
          </motion.button>
        </div>
      </div>

      {/* Status filter */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-4" data-testid="status-filter-bar">
        <span className="text-sm font-medium text-muted-foreground mr-1 flex items-center gap-1.5">
          <Filter className="h-4 w-4 text-primary" />
          處理狀態：
        </span>
        {STATUS_FILTER_OPTIONS.map((option) => {
          const count = statusCounts[option.id];
          const isActive = statusFilter === option.id;
          return (
            <motion.button
              key={option.id}
              whileTap={{ scale: 0.98 }}
              type="button"
              data-testid={`filter-status-${option.id}`}
              onClick={() => setStatusFilter(option.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground border border-primary"
                  : "bg-muted text-muted-foreground border border-border hover:bg-accent hover:text-foreground"
              }`}
            >
              <span>{option.label}</span>
              <span
                className="inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold leading-none"
                style={isActive
                  ? { backgroundColor: "rgba(0,0,0,0.18)", color: "inherit" }
                  : { backgroundColor: "var(--bg-input)", color: "var(--text-muted)" }}
              >
                {count}
              </span>
            </motion.button>
          );
        })}
      </div>

      {/* Error */}
      <AnimatePresence mode="wait">
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex items-start gap-3 rounded-lg p-4 text-sm border"
            style={{ borderColor: "var(--color-danger)", background: "var(--color-danger-subtle)", color: "var(--color-danger-foreground, var(--text-primary))" }}
          >
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" style={{ color: "var(--color-danger)" }} />
            <div><span className="font-semibold">載入錯誤：</span>{error}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border bg-background max-h-[60vh] overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="mt-3 text-sm">正在載入回報清單…</span>
          </div>
        ) : reports.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-sm text-muted-foreground">無任何回報資料</div>
        ) : filteredReports.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-sm text-muted-foreground">
            <Filter className="h-8 w-8 mb-2 opacity-60" />
            無符合「{STATUS_FILTER_OPTIONS.find(o => o.id === statusFilter)?.label}」狀態的回報資料
          </div>
        ) : (
          <table className="min-w-full divide-y divide-border text-left text-sm">
            <thead className="font-medium bg-muted text-muted-foreground border-b border-border">
              <tr>
                <th className="px-4 py-3 font-medium">建立時間</th>
                <th className="px-4 py-3 font-medium">分類</th>
                <th className="px-4 py-3 font-medium">狀態</th>
                <th className="px-6 py-3 w-1/3 font-medium">回報內容</th>
                <th className="px-4 py-3 font-medium">姓名</th>
                <th className="px-4 py-3 font-medium">牧區</th>
                <th className="px-4 py-3 font-medium">小組</th>
                <th className="px-4 py-3 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-foreground">
              {filteredReports.map((report) => (
                <tr key={report.id} className="hover:bg-accent transition-colors">
                  <td className="px-4 py-3.5 whitespace-nowrap text-muted-foreground text-xs">
                    {new Date(report.created_at).toLocaleString("zh-TW")}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap">
                    <span className={categoryBadgeClass(report.category)}>
                      {CATEGORY_MAP[report.category] || report.category}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap">
                    <select
                      value={report.status || "pending"}
                      onChange={async (e) => {
                        try { await onUpdate(report.id, e.target.value, ""); }
                        catch (err: any) { alert(err.message || "狀態更新失敗"); }
                      }}
                      className="rounded-md border border-border bg-card text-foreground text-sm px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
                      title="變更問題處理狀態"
                    >
                      <option value="pending">待處理</option>
                      <option value="processing">處理中</option>
                      <option value="resolved">已解決</option>
                      <option value="ignored">已忽略</option>
                    </select>
                  </td>
                  <td className="px-6 py-3.5 break-words leading-relaxed text-sm text-foreground select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                    {report.description}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                    {report.profiles
                      ? <span className="font-medium text-sm text-foreground">{report.profiles.name || "未填姓名"}</span>
                      : <span className="text-muted-foreground">訪客 / 離線回報</span>}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap text-sm text-muted-foreground select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                    {report.profiles ? (report.profiles.pastoral_zone || "無牧區") : "-"}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap text-sm text-muted-foreground select-text" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                    {report.profiles ? (report.profiles.small_group || "無小組") : "-"}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <motion.button
                        whileTap={{ scale: 0.9 }}
                        onClick={() => handleCopyText(report.id, report.description)}
                        className="inline-flex rounded-lg p-2 border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        title={copiedId === report.id ? "已複製內文！" : "複製內文"}
                        type="button"
                      >
                        {copiedId === report.id
                          ? <Check className="h-4 w-4" style={{ color: "var(--color-success-foreground, var(--color-success))" }} />
                          : <Copy className="h-4 w-4 text-primary" />}
                      </motion.button>
                      <motion.button
                        whileTap={{ scale: 0.9 }}
                        onClick={() => onOpenThread?.(report.id)}
                        className="relative inline-flex rounded-lg p-2 border border-border bg-card text-primary hover:bg-accent transition-colors"
                        title="開啟對話"
                        type="button"
                      >
                        <MessageSquare className="h-4 w-4" />
                        {(report as any).unreadFromMember && (
                          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary border-2 border-card" />
                        )}
                      </motion.button>
                      <motion.button
                        whileTap={{ scale: 0.9 }}
                        onClick={() => setDeleteTargetId(report.id)}
                        className="inline-flex rounded-lg p-2 border bg-card transition-colors hover:bg-accent"
                        style={{ color: "var(--color-danger)", borderColor: "color-mix(in srgb, var(--color-danger) 35%, transparent)" }}
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

      {/* Delete confirmation */}
      <AnimatePresence>
        {deleteTargetId && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-sm rounded-xl p-6 shadow-lg border border-border bg-card text-foreground"
            >
              <h3 className="text-base font-semibold text-foreground">確認刪除</h3>
              <p className="text-sm mt-2 text-muted-foreground leading-relaxed">
                確定要刪除這筆回報嗎？此動作會從資料庫永久移除（含對話與截圖），無法復原。
              </p>
              <div className="mt-5 flex justify-end gap-3">
                <button
                  onClick={() => setDeleteTargetId(null)}
                  disabled={isDeleting}
                  className="secondary-btn text-sm disabled:opacity-50"
                  type="button"
                >
                  取消
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  disabled={isDeleting}
                  className="danger-btn inline-flex items-center gap-1.5 text-sm disabled:opacity-50"
                  type="button"
                >
                  {isDeleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  確定刪除
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
