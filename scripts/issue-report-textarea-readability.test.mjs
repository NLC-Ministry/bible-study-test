import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("issue report textarea readability tests", () => {
  it("verifies Textarea component has text-foreground and text-base for high contrast typing", () => {
    const code = readFileSync("components/ui/textarea.tsx", "utf8");
    expect(code).toContain("text-foreground");
    expect(code).toContain("text-base");
  });

  it("verifies the admin reply textarea has text-base and app-token contrast (moved to AdminThreadPane)", () => {
    // 回覆已從 AdminReportTable 的彈窗改成 AdminReportView 的對話 pane。
    const code = readFileSync("components/issue-report/AdminReportView.tsx", "utf8");
    expect(code).toContain("data-admin-reply-textarea");
    expect(code).toContain("text-base");
    expect(code).toContain("text-foreground");
    // 不再用寫死的 slate 調色盤
    expect(code).not.toMatch(/text-slate-\d/);
    expect(code).not.toMatch(/bg-slate-\d/);
  });

  it("verifies index.css includes textarea high contrast font-size and color safeguards", () => {
    const css = readFileSync("index.css", "utf8");
    expect(css).toContain("#description,");
    expect(css).toContain("color: var(--text-primary, #F8FAFC) !important;");
  });
});
