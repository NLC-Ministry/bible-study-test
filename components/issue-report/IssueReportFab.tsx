// components/issue-report/IssueReportFab.tsx
import React from "react";
import { SupportFab } from "./SupportFab.tsx";
import { ReportDrawer } from "./ReportDrawer.tsx";
import { initOfflineReportSync, ThreadPipeline } from "./IssueReportBlocks.ts";

export const IssueReportFab: React.FC = () => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [defaultTab, setDefaultTab] = React.useState<"form" | "my-reports">("form");
  const [unreadReplyCount, setUnreadReplyCount] = React.useState(0);

  const refreshUnreadCount = React.useCallback(() => {
    ThreadPipeline.unreadSummary().then(({ total }) => {
      setUnreadReplyCount(total);
    }).catch(() => {});
  }, []);

  // Initialize offline sync on component mount
  React.useEffect(() => {
    initOfflineReportSync();
  }, []);

  // Let non-React surfaces (e.g. the notification bell) open the drawer.
  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const tab = (e as CustomEvent)?.detail?.tab === "my-reports" ? "my-reports" : "form";
      setDefaultTab(tab);
      setIsOpen(true);
    };
    window.addEventListener("open-issue-report", onOpen);
    return () => window.removeEventListener("open-issue-report", onOpen);
  }, []);

  // Check for unread replies on mount, and again whenever the tab regains
  // focus — an admin's reply won't otherwise be noticed until the next full
  // page load.
  React.useEffect(() => {
    refreshUnreadCount();
    window.addEventListener("focus", refreshUnreadCount);
    return () => window.removeEventListener("focus", refreshUnreadCount);
  }, [refreshUnreadCount]);

  return (
    <>
      <SupportFab
        isOpen={isOpen}
        unreadReplyCount={unreadReplyCount}
        onClick={() => { setDefaultTab("form"); setIsOpen(true); }}
      />
      <ReportDrawer
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        defaultTab={defaultTab}
        onReportsViewed={refreshUnreadCount}
      />
    </>
  );
};
