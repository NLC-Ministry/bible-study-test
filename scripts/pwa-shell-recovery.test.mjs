import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const auth = readFileSync("js/auth.js", "utf8");
const app = readFileSync("js/app.js", "utf8");
const sw = readFileSync("sw.js", "utf8");
const repair = readFileSync("repair.html", "utf8");

describe("PWA shell recovery", () => {
  it("clears both current and legacy app cache prefixes during login reset", () => {
    expect(auth).toContain('key.startsWith("newlife-bible-") || key.startsWith("church-bible-")');
    expect(auth).not.toMatch(/filter\(key => key\.startsWith\("church-bible-"\)\)/);
  });

  it("checks the Service Worker when the user refreshes app data", () => {
    expect(app).toContain('navigator.serviceWorker.getRegistration("/")');
    expect(app).toContain("await registration?.update()");
  });

  it("uses one complete navigation fallback and build-injected shell assets", () => {
    expect(sw).toContain('const VERSION = "__BUILD_VERSION__"');
    expect(sw).toContain('const BUILD_JS_PATH = "__BUILD_JS_PATH__"');
    expect(sw).toContain('const BUILD_CSS_PATH = "__BUILD_CSS_PATH__"');
    expect(sw).toContain('"/index.css"');
    expect(sw).toContain('...(BUILD_JS_PATH.startsWith("/") ? [BUILD_JS_PATH] : [])');
    expect(sw).toContain('fallbackUrl: "/"');
    expect(sw).not.toContain('fallbackUrl: "/index.html"');
  });

  it("keeps hidden content hidden and offers asset-only recovery when CSS fails", () => {
    expect(html).toContain('.hidden, [hidden] { display: none !important; }');
    expect(html).toContain('onerror="window.showAppStyleRecovery(this)"');
    expect(html).toContain("stableFallbackAttempted");
    expect(html).toContain('stylesheet.href = "/index.css?version=" + Date.now()');
    expect(html).toContain('id="app-style-recovery-button"');
    expect(html).toContain('id="login-gate-refresh-latest"');
    expect(html).toContain('href="/repair?source=login-gate"');
    expect(html).toContain('window.location.replace("/repair?version=" + Date.now())');
    expect(html).not.toContain("continueWithoutStyleRecovery");
    expect(repair).toContain('registration.unregister()');
    expect(repair).toContain('fetch("/index.css?version=" + Date.now()');
    expect(repair).toContain('content-type');
    expect(repair).toContain('window.location.replace("/?repaired=1" + resumeParam + "&version=" + Date.now())');
    expect(sw).toContain('url.pathname === "/repair"');
  });

  it("falls back to stable CSS when an old hashed stylesheet disappears", () => {
    expect(sw).toContain("isVersionedStylesheetRequest");
    expect(sw).toContain('fetch(`/index.css?version=${VERSION}`');
    expect(sw).toContain("response.ok");
  });

  it("keeps the standalone repair page executable", () => {
    const scriptStart = repair.indexOf("<script>") + "<script>".length;
    const scriptEnd = repair.indexOf("</script>", scriptStart);
    expect(scriptStart).toBeGreaterThan("<script>".length - 1);
    expect(scriptEnd).toBeGreaterThan(scriptStart);
    expect(() => new Function(repair.slice(scriptStart, scriptEnd))).not.toThrow();
  });
});
