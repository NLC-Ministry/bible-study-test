// scripts/bundle.test.mjs
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readFileSync as rf, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveLocalAssets, concatScripts, contentHash, emitBundle, assertParses, assertRelativeModuleImportsResolve, copyLazyModuleRuntime } from "./bundle.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("resolveLocalAssets", () => {
  it("returns local scripts in document order, external excluded, queries stripped", () => {
    const html = `
      <link rel="stylesheet" href="https://cdn/x.css">
      <link rel="stylesheet" href="index.css?v=abc">
      <link rel="stylesheet" href="css/team-registration.css?v=def">
      <script src="https://cdn/lib.js"></script>
      <script src="config.js?v=1"></script>
      <script src="js/state.js?v=2"></script>`;
    const out = resolveLocalAssets(html);
    expect(out.scripts).toEqual(["config.js", "js/state.js"]);
    expect(out.stylesheet).toBe("index.css");
    expect(out.stylesheets).toEqual(["index.css", "css/team-registration.css"]);
  });

  it("extracts src regardless of attribute order, still excluding external and inline", () => {
    const html = `
      <script defer src="js/a.js"></script>
      <script type="module" src="js/b.js"></script>
      <script src="https://cdn/lib.js" crossorigin></script>
      <script>window.x = "src=inline";</script>`;
    expect(resolveLocalAssets(html).scripts).toEqual(["js/a.js", "js/b.js"]);
  });

  it("returns null stylesheet when there is no local stylesheet link", () => {
    expect(resolveLocalAssets(`<script src="js/a.js"></script>`).stylesheet).toBeNull();
  });

  it("resolves the real index.html to the exact 1-file order", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    const { scripts, stylesheets } = resolveLocalAssets(html);
    expect(scripts).toEqual([
      "js/app.js"
    ]);
  });
});

describe("concatScripts", () => {
  it("joins file contents in order with ASI-safe separators", () => {
    const read = (p) => ({ "a.js": "var a=1", "b.js": "var b=2" })[p];
    expect(concatScripts(["a.js", "b.js"], read)).toBe("var a=1\n;\nvar b=2");
  });
});

describe("contentHash", () => {
  it("is deterministic and 8 hex chars", () => {
    const h = contentHash("hello");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(h).toBe(contentHash("hello"));
    expect(h).not.toBe(contentHash("world"));
  });
});

describe("assertParses", () => {
  it("passes for valid concatenated JS", () => {
    expect(() => assertParses("var a=1;\n;\nfunction f(){ return a; }")).not.toThrow();
  });
  it("throws a descriptive error for a syntax error", () => {
    expect(() => assertParses("var a = ;")).toThrow(/failed syntax check/);
  });
});

describe("emitBundle esbuild invocation", () => {
  it("writes esbuild output to a file instead of capturing stdout", () => {
    const source = readFileSync(join(root, "scripts/bundle.mjs"), "utf8");
    expect(source).toContain("--outfile=");
    expect(source).toContain("ENOBUFS");
    expect(source).toMatch(/issueReportEntry[\s\S]*--format=esm/);
    expect(source).not.toMatch(
      /execSync\(`\$\{esbuildCmd\} "\$\{entryPoint\}" --bundle --minify --target=es2020`/
    );
  });
});

describe("emitBundle guards", () => {
  it("throws a descriptive error when index.html has no local stylesheet", () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-nocss-"));
    try {
      writeFileSync(join(dir, "index.html"), `<script src="a.js"></script>`);
      expect(() => emitBundle({ root: dir, outDir: join(dir, "out") })).toThrow(/no local stylesheet/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("copied lazy module dependencies", () => {
  it("rejects a lazy module whose relative dependency was not copied", () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-missing-module-"));
    try {
      writeFileSync(join(dir, "plan.js"), 'import "../data/missing.mjs";');
      expect(() => assertRelativeModuleImportsResolve(dir)).toThrow(/copied module dependency missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies shared data dependencies at the path lazy modules import", () => {
    const out = mkdtempSync(join(tmpdir(), "bundle-lazy-runtime-"));
    try {
      expect(copyLazyModuleRuntime(root, out)).toBe(true);
      expect(existsSync(join(out, "modules", "bible.js"))).toBe(true);
      expect(existsSync(join(out, "data", "plan-progress-availability.mjs"))).toBe(true);
      expect(() => assertRelativeModuleImportsResolve(join(out, "modules"))).not.toThrow();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
describe("emitBundle (integration, real repo)", () => {
  // config.js is git-ignored and generated by build-config.js. In a clean checkout
  // (e.g. CI, where `npm test` runs before the build step) it does not exist yet,
  // so generate it here to make this real-repo test self-sufficient.
  beforeAll(() => {
    if (!existsSync(join(root, "config.js"))) {
      execSync("node build-config.js", { cwd: root, stdio: "ignore" });
    }
  });

  it("produces one hashed JS bundle + hashed CSS and a rewritten index.html", () => {
    const out = mkdtempSync(join(tmpdir(), "bundle-"));
    try {
      const { jsFile, cssFile } = emitBundle({ root, outDir: out });
      // hashed filenames
      expect(jsFile).toMatch(/^app\.[0-9a-f]{8}\.js$/);
      expect(cssFile).toMatch(/^index\.[0-9a-f]{8}\.css$/);
      expect(existsSync(join(out, jsFile))).toBe(true);
      expect(existsSync(join(out, "app.js"))).toBe(true);
      expect(existsSync(join(out, cssFile))).toBe(true);
      expect(existsSync(join(out, "index.css"))).toBe(true);
      // rewritten HTML: exactly one app script tag, no leftover local js/ tags
      const html = rf(join(out, "index.html"), "utf8");
      expect(html).toContain(`<script type="module" src="/${jsFile}"></script>`);
      expect(html).not.toMatch(/<script\s+src="js\//);
      expect(html).not.toMatch(/<script\s+src="config\.js/);
      expect(html).toContain(`href="/${cssFile}" onerror="window.showAppStyleRecovery(this)"`);
      expect((html.match(new RegExp(`href="/${cssFile}"`, "g")) || []).length).toBe(1);
      const bundledCss = rf(join(out, cssFile), "utf8");
      expect(bundledCss).toContain(".reading-team-overlay");
      expect(rf(join(out, "index.css"), "utf8")).toBe(bundledCss);
      const serviceWorker = rf(join(out, "sw.js"), "utf8");
      expect(serviceWorker).not.toContain("__BUILD_VERSION__");
      expect(serviceWorker).not.toContain("__BUILD_JS_PATH__");
      expect(serviceWorker).not.toContain("__BUILD_CSS_PATH__");
      expect(serviceWorker).toContain(`"/${jsFile}"`);
      expect(serviceWorker).toContain(`"/${cssFile}"`);
      expect(serviceWorker).toContain('"/index.css"');
      expect(serviceWorker).toMatch(/const VERSION = "\d{14}"/);

      // assets copied
      expect(existsSync(join(out, "manifest.json"))).toBe(true);
      expect(existsSync(join(out, "repair.html"))).toBe(true);
      expect(existsSync(join(out, "sw.js"))).toBe(true);
      expect(existsSync(join(out, "js", "pwa", "CacheManager.js"))).toBe(true);
      expect(existsSync(join(out, "js", "pwa", "SupabaseRepository.js"))).toBe(true);
      expect(readdirSync(join(out, "assets")).length).toBeGreaterThan(0);
      // modules folder copied
      expect(existsSync(join(out, "modules"))).toBe(true);
      expect(readdirSync(join(out, "modules")).length).toBeGreaterThan(0);
      expect(existsSync(join(out, "modules", "plan.js"))).toBe(true);
      expect(existsSync(join(out, "modules", "plan-progress-reset.mjs"))).toBe(true);
      expect(existsSync(join(out, "data", "plan-progress-availability.mjs"))).toBe(true);
      const issueReportBundle = rf(join(out, "modules", "issue-report-ui.bundle.js"), "utf8");
      expect(issueReportBundle).toMatch(/export\s*\{[^}]*mountIssueReportUi/);
      // contains app bundle code
      const bundle = rf(join(out, jsFile), "utf8");
      expect(bundle.includes("Lazy-loading")).toBe(true);
      expect(bundle).not.toContain("__BUILD_VERSION__");
      expect(bundle).toContain("issue-report-ui.bundle.js");
      expect(bundle).toMatch(/\d{14}/);
      expect(bundle).toContain("_clean_demo_mode_v20");
      expect(bundle).not.toMatch(/\.includes\("\d{14}"\)/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120000);
});
