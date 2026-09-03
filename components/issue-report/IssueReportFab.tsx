// components/issue-report/IssueReportFab.tsx
import React from "react";
import { SupportFab } from "./SupportFab.tsx";
import { ReportDrawer } from "./ReportDrawer.tsx";
import { initOfflineReportSync, ThreadPipeline } from "./IssueReportBlocks.ts";

const FAB_MODE_KEY = "issue_report_fab_mode";

function detectIsAdmin(): boolean {
  try {
    const state = (window as any).state;
    const u = state?.currentUser;
    const role = (window as any).getUserRoleCode?.(u) || u?.role_definition?.code || "member";
    return role === "admin";
  } catch (_e) {
    return false;
  }
}

export const IssueReportFab: React.FC = () => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [defaultTab, setDefaultTab] = React.useState<"form" | "my-reports">("form");
  const [unreadReplyCount, setUnreadReplyCount] = React.useState(0);
  const [hasReports, setHasReports] = React.useState(false);
  const prevUnread = React.useRef(0);

  const [isAdmin, setIsAdmin] = React.useState(detectIsAdmin());
  // 管理員預設「回覆模式」（他們不需要自己回報）；一般會友永遠 user 模式。
  const [mode, setMode] = React.useState<"user" | "admin">(() => {
    if (!detectIsAdmin()) return "user";
    try {
      const saved = localStorage.getItem(FAB_MODE_KEY);
      return saved === "user" ? "user" : "admin";
    } catch (_e) {
      return "admin";
    }
  });
  const effectiveMode: "user" | "admin" = isAdmin ? mode : "user";

  const setModePersisted = (next: "user" | "admin") => {
    setMode(next);
    try { localStorage.setItem(FAB_MODE_KEY, next); } catch (_e) { /* noop */ }
  };

  const refreshUnreadCount = React.useCallback(() => {
    ThreadPipeline.unreadSummary().then(({ total }) => {
      setUnreadReplyCount(total);
      if (total > prevUnread.current && total > 0 && !isOpen
        && typeof (window as any).showToast === "function") {
        (window as any).showToast(
          detectIsAdmin() ? "有回報等你回覆，點右下角泡泡查看" : "你的回報有新回覆，點右下角泡泡查看"
        );
      }
      prevUnread.current = total;
    }).catch(() => {});
  }, [isOpen]);

  const refreshHasReports = React.useCallback(() => {
    ThreadPipeline.myReports().then(({ rows }) => {
      setHasReports(Array.isArray(rows) && rows.length > 0);
    }).catch(() => {});
  }, []);

  React.useEffect(() => {
    initOfflineReportSync();
  }, []);

  // Role can resolve after mount (auth/session sync). Re-check for a while.
  React.useEffect(() => {
    if (isAdmin) return;
    let n = 0;
    const iv = window.setInterval(() => {
      n += 1;
      if (detectIsAdmin()) {
        setIsAdmin(true);
        try {
          const saved = localStorage.getItem(FAB_MODE_KEY);
          setMode(saved === "user" ? "user" : "admin");
        } catch (_e) { setMode("admin"); }
        window.clearInterval(iv);
      } else if (n > 20) {
        window.clearInterval(iv);
      }
    }, 1500);
    return () => window.clearInterval(iv);
  }, [isAdmin]);

  // Let non-React surfaces (the notification bell) open the drawer.
  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const wantMyReports = (e as CustomEvent)?.detail?.tab !== "form";
      if (wantMyReports) {
        // 鈴鐺的「你的回報有新回覆」是會友視角 → 切回使用者模式
        if (isAdmin) setModePersisted("user");
        setDefaultTab("my-reports");
      } else {
        setDefaultTab("form");
      }
      setIsOpen(true);
    };
    window.addEventListener("open-issue-report", onOpen);
    return () => window.removeEventListener("open-issue-report", onOpen);
  }, [isAdmin]);

  React.useEffect(() => {
    refreshUnreadCount();
    refreshHasReports();
    window.addEventListener("focus", refreshUnreadCount);
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshUnreadCount();
    }, 60000);
    return () => {
      window.removeEventListener("focus", refreshUnreadCount);
      window.clearInterval(iv);
    };
  }, [refreshUnreadCount, refreshHasReports]);

  const openDrawer = () => {
    if (effectiveMode === "admin") {
      setIsOpen(true);   // ReportDrawer 會自動開最新對話
      return;
    }
    setDefaultTab(hasReports || unreadReplyCount > 0 ? "my-reports" : "form");
    setIsOpen(true);
  };

  return (
    <>
      <SupportFab
        isOpen={isOpen}
        unreadReplyCount={unreadReplyCount}
        onClick={openDrawer}
      />
      <ReportDrawer
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        defaultTab={defaultTab}
        onReportsViewed={() => { refreshUnreadCount(); refreshHasReports(); }}
        mode={effectiveMode}
        canToggleMode={isAdmin}
        onToggleMode={setModePersisted}
      />
    </>
  );
};
