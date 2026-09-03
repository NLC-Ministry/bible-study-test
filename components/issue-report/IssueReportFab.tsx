// components/issue-report/IssueReportFab.tsx
import React from "react";
import { SupportFab } from "./SupportFab.tsx";
import { ReportDrawer } from "./ReportDrawer.tsx";
import { initOfflineReportSync, ThreadPipeline } from "./IssueReportBlocks.ts";

export const IssueReportFab: React.FC = () => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [defaultTab, setDefaultTab] = React.useState<"form" | "my-reports">("form");
  const [unreadReplyCount, setUnreadReplyCount] = React.useState(0);
  const [hasReports, setHasReports] = React.useState(false);
  const prevUnread = React.useRef(0);

  const refreshUnreadCount = React.useCallback(() => {
    ThreadPipeline.unreadSummary().then(({ total }) => {
      setUnreadReplyCount(total);
      // 人在 App 裡、抽屜關著時，未讀從無變有 → 提示一下（不然舊用戶不會回來看）。
      if (total > prevUnread.current && total > 0 && !isOpen
        && typeof (window as any).showToast === "function") {
        (window as any).showToast("你的回報有新回覆，點右下角泡泡查看");
      }
      prevUnread.current = total;
    }).catch(() => {});
  }, [isOpen]);

  const refreshHasReports = React.useCallback(() => {
    ThreadPipeline.myReports().then(({ rows }) => {
      setHasReports(Array.isArray(rows) && rows.length > 0);
    }).catch(() => {});
  }, []);

  // Initialize offline sync on component mount
  React.useEffect(() => {
    initOfflineReportSync();
  }, []);

  // Let non-React surfaces (e.g. the notification bell) open the drawer.
  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const tab = (e as CustomEvent)?.detail?.tab === "form" ? "form" : "my-reports";
      setDefaultTab(tab);
      setIsOpen(true);
    };
    window.addEventListener("open-issue-report", onOpen);
    return () => window.removeEventListener("open-issue-report", onOpen);
  }, []);

  // Check on mount, on focus, and on a slow poll — so a reply that arrives
  // while the user is still on the page surfaces without a full reload.
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
    // 舊用戶心智：以為只有「投遞」。有回報過就先給看對話列表，讓他發現有來回。
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
      />
    </>
  );
};
