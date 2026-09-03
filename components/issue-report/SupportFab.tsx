// components/issue-report/SupportFab.tsx
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare } from "lucide-react";

interface SupportFabProps {
  onClick: () => void;
  isOpen: boolean;
  unreadReplyCount?: number;
}

function isLoginGateVisibleNow(): boolean {
  if (typeof document === "undefined") return false;
  const loginGate = document.getElementById("login-gate");
  return Boolean(loginGate && !loginGate.classList.contains("hidden"));
}

export const SupportFab: React.FC<SupportFabProps> = ({ onClick, isOpen, unreadReplyCount = 0 }) => {
  const [currentPath, setCurrentPath] = React.useState(
    typeof window !== "undefined" ? window.location.pathname : ""
  );

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener("popstate", handleLocationChange);
    const interval = setInterval(handleLocationChange, 500);

    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      clearInterval(interval);
    };
  }, []);

  const [isLoginGateVisible, setIsLoginGateVisible] = React.useState(isLoginGateVisibleNow());

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const loginGate = document.getElementById("login-gate");
    if (!loginGate) return;

    const syncLoginGateVisibility = () => setIsLoginGateVisible(isLoginGateVisibleNow());
    syncLoginGateVisibility();
    const observer = new MutationObserver(syncLoginGateVisibility);
    observer.observe(loginGate, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const [isVisible, setIsVisible] = React.useState(true);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    let lastScrollY = window.scrollY;
    let throttleTimeout: ReturnType<typeof setTimeout> | null = null;
    let scrollStopTimeout: ReturnType<typeof setTimeout> | null = null;

    const handleScroll = (event: Event) => {
      if (throttleTimeout) return;

      throttleTimeout = setTimeout(() => {
        const target = event.target as HTMLElement;
        const currentScrollY = target.scrollTop !== undefined ? target.scrollTop : window.scrollY;

        if (scrollStopTimeout) clearTimeout(scrollStopTimeout);

        if (currentScrollY > lastScrollY && currentScrollY > 50) {
          setIsVisible(false);
        } else {
          setIsVisible(true);
        }

        lastScrollY = currentScrollY;
        throttleTimeout = null;

        scrollStopTimeout = setTimeout(() => {
          setIsVisible(true);
        }, 150);
      }, 50);
    };

    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      if (throttleTimeout) clearTimeout(throttleTimeout);
      if (scrollStopTimeout) clearTimeout(scrollStopTimeout);
    };
  }, []);

  const isExcluded =
    (currentPath || "") === "/login" ||
    (currentPath || "").startsWith("/auth") ||
    (currentPath || "") === "/signup" ||
    isLoginGateVisible;

  if (isExcluded) return null;

  return (
    <AnimatePresence>
      {!isOpen && isVisible && (
        <motion.button
          onClick={onClick}
          initial={{ scale: 0, opacity: 0, y: 50 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0, opacity: 0, y: 50 }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
          className="issue-report-fab fixed z-sheet flex h-14 w-14 items-center justify-center rounded-full border border-border bg-primary text-primary-foreground shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          aria-label={unreadReplyCount > 0 ? `打開問題回報與對話，有 ${unreadReplyCount} 則未讀回覆` : "打開問題回報與對話"}
          type="button"
        >
          <MessageSquare className="h-[var(--icon-size-lg)] w-[var(--icon-size-lg)]" strokeWidth={2} />
          {unreadReplyCount > 0 && (
            <span
              className="issue-report-fab-badge absolute flex items-center justify-center rounded-full font-semibold"
              style={{
                top: "-0.25rem",
                right: "-0.25rem",
                minWidth: "1.25rem",
                height: "1.25rem",
                padding: "0 0.3rem",
                fontSize: "0.7rem",
                lineHeight: 1,
                backgroundColor: "var(--color-danger, #ef4444)",
                color: "#fff",
                border: "2px solid var(--bg-page, #fff)"
              }}
              aria-hidden="true"
            >
              {unreadReplyCount > 9 ? "9+" : unreadReplyCount}
            </span>
          )}
        </motion.button>
      )}
    </AnimatePresence>
  );
};
