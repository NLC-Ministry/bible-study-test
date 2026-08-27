import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const EXCLUDE = new Set([
  "scripts/migrate-icons.mjs",
  "scripts/icon-audit.test.mjs",
  "scripts/generate-icon-registry.mjs",
  "js/design/icon-manifest.test.mjs",
  "js/design/icon-registry.js",
  "js/design/icons.js",
]);

const BI_CLASS = /\bbi bi-[a-z0-9-]+/i;
const BI_PREFIX = /\bbi-[a-z0-9-]+/i;
const BOOTSTRAP_CDN = /bootstrap-icons/i;
const ICON_PARK = /@icon-park\/svg/i;
const INLINE_SVG = /<svg\b/i;
const GOOGLE_BRAND_SVG = /fill="#4285F4"/;

const ALLOWED_ICON_SIZE_KEYS = new Set([
  "xs",
  "sm",
  "md",
  "lg",
  "nav",
  "touch",
  "hero",
  "badge",
  "1em",
]);

const ICON_SIZE_CSS_VARS = [
  "--icon-size-xs",
  "--icon-size-sm",
  "--icon-size-md",
  "--icon-size-lg",
  "--icon-size-nav",
  "--icon-size-touch",
  "--icon-size-hero",
  "--icon-size-badge",
];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git" || name === ".worktrees" || name === "scratch") continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, acc);
    else if (/\.(js|html|css|mjs)$/.test(name)) acc.push(abs);
  }
  return acc;
}

function findMatches(pattern) {
  const hits = [];
  for (const abs of walk(root)) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (EXCLUDE.has(rel)) continue;
    const content = readFileSync(abs, "utf8");
    if (pattern.test(content)) hits.push(rel);
    pattern.lastIndex = 0;
  }
  return hits;
}

function stripAllowedInlineSvgs(html) {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, (block) =>
      GOOGLE_BRAND_SVG.test(block) || /class="theme-icon-(?:sun|moon)"/.test(block) ? "" : block
    );
}

function findInlineSvgHits() {
  const hits = [];
  for (const abs of walk(root)) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (EXCLUDE.has(rel)) continue;
    const content = readFileSync(abs, "utf8");
    if (!INLINE_SVG.test(content)) continue;
    if (rel === "index.html") {
      const withoutAllowed = stripAllowedInlineSvgs(content);
      if (!INLINE_SVG.test(withoutAllowed)) continue;
    }
    hits.push(rel);
    INLINE_SVG.lastIndex = 0;
  }
  return hits;
}

/** Icons on actionable controls must inherit label color — not --color-icon-default. */
function findControlIconColorOverrides() {
  const hits = [];
  const buttonBlock = /<button\b[\s\S]*?<\/button>/gi;
  const explicitIconColor =
    /<span\b[^>]*class="[^"]*\bnlc-icon\b[^"]*"[^>]*style="[^"]*\bcolor:\s*(?!inherit\b)/i;

  for (const abs of walk(root)) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (EXCLUDE.has(rel)) continue;
    if (!/\.(html|js)$/.test(abs)) continue;
    const content = readFileSync(abs, "utf8");
    let match;
    while ((match = buttonBlock.exec(content))) {
      if (explicitIconColor.test(match[0])) {
        hits.push(rel);
        break;
      }
    }
    buttonBlock.lastIndex = 0;
  }
  return hits;
}

function findInvalidIconSizeUsage() {
  const hits = [];
  const dataSize = /data-icon-size="([^"]+)"/g;
  const renderSize = /renderIcon\([^)]*size:\s*["']([^"']+)["']/g;

  for (const abs of walk(root)) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (EXCLUDE.has(rel)) continue;
    if (!/\.(html|js)$/.test(abs)) continue;
    const content = readFileSync(abs, "utf8");
    let match;
    while ((match = dataSize.exec(content))) {
      if (!ALLOWED_ICON_SIZE_KEYS.has(match[1])) {
        hits.push(`${rel}: data-icon-size="${match[1]}"`);
      }
    }
    while ((match = renderSize.exec(content))) {
      if (!ALLOWED_ICON_SIZE_KEYS.has(match[1])) {
        hits.push(`${rel}: renderIcon size="${match[1]}"`);
      }
    }
  }
  return hits;
}

function findInlineIconFontSize() {
  const hits = [];
  const pattern =
    /<span\b[^>]*class="[^"]*\bnlc-icon\b[^"]*"[^>]*style="[^"]*\bfont-size\s*:/i;

  for (const abs of walk(root)) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (EXCLUDE.has(rel)) continue;
    if (!/\.(html|js)$/.test(abs)) continue;
    const content = readFileSync(abs, "utf8");
    if (pattern.test(content)) hits.push(rel);
    pattern.lastIndex = 0;
  }
  return hits;
}

function findLegacyNavBackSizeSelectors(css) {
  return /nav-back-chevron\[data-icon-size="[^"]*px/i.test(css) ? ["index.css"] : [];
}

/**
 * Every data-icon="x" / renderIcon("x", ...) key actually used in the app
 * must exist in js/design/icon-manifest.json — otherwise hydrateIcons()
 * silently renders an empty <span class="nlc-icon--missing"> instead of
 * the intended glyph (see js/design/icons.js renderIcon()). This is exactly
 * how the "匯出" button's download icon and the reader's multi-select copy
 * icon went missing: both were added to markup without a manifest entry,
 * and nothing failed loudly — the icon was just silently absent, in every
 * theme, forever.
 */
function findUndeclaredIconKeys() {
  const manifest = JSON.parse(readFileSync(join(root, "js/design/icon-manifest.json"), "utf8"));
  const manifestKeys = new Set(Object.keys(manifest));
  const used = new Map();
  const dataIconRe = /data-icon(?:Key)?\s*[:=]\s*["'`]([a-zA-Z0-9_]+)["'`]/g;
  const renderIconRe = /renderIcon\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g;

  for (const abs of walk(root)) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (EXCLUDE.has(rel)) continue;
    if (!/\.(html|js|mjs)$/.test(abs)) continue;
    const content = readFileSync(abs, "utf8");
    for (const re of [dataIconRe, renderIconRe]) {
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(content))) {
        const key = match[1];
        if (!used.has(key)) used.set(key, new Set());
        used.get(key).add(rel);
      }
    }
  }

  const missing = [];
  for (const [key, files] of used) {
    if (!manifestKeys.has(key)) missing.push(`"${key}" used in ${[...files].join(", ")}`);
  }
  return missing.sort();
}

describe("icon audit", () => {
  it("every data-icon / renderIcon key used in the app is declared in icon-manifest.json", () => {
    const hits = findUndeclaredIconKeys();
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("has no Bootstrap Icons class usage in source", () => {
    const hits = findMatches(BI_CLASS);
    expect(hits, hits.join(", ")).toEqual([]);
  });

  it("has no bootstrap-icons CDN references", () => {
    const hits = findMatches(BOOTSTRAP_CDN);
    expect(hits, hits.join(", ")).toEqual([]);
  });

  it("has no IconPark package references in app source", () => {
    const hits = findMatches(ICON_PARK);
    expect(hits, hits.join(", ")).toEqual([]);
  });

  it("has no legacy bi- icon keys in app source (except migration tooling)", () => {
    const hits = findMatches(BI_PREFIX).filter((rel) => !EXCLUDE.has(rel));
    expect(hits, hits.join(", ")).toEqual([]);
  });

  it("has no inline SVG icons outside the Lucide registry (except Google brand mark and theme toggle)", () => {
    const hits = findInlineSvgHits();
    expect(hits, hits.join(", ")).toEqual([]);
  });

  it("nlc-icon base rules keep glyph backgrounds transparent", () => {
    const css = readFileSync(join(root, "index.css"), "utf8");
    const block = css.match(/\/\* Lucide icons[\s\S]*?\.search-icon-inside/);
    expect(block).toBeTruthy();
    expect(block[0]).toMatch(/\.nlc-icon\s*\{[\s\S]*?background:\s*transparent/);
    expect(block[0]).toMatch(/\.nlc-icon svg,\s*\n\.nlc-icon__svg\s*\{[\s\S]*?background:\s*transparent/);
  });

  it("actionable controls inherit icon color from label text", () => {
    const css = readFileSync(join(root, "index.css"), "utf8");
    expect(css).toMatch(/button\s+\.nlc-icon[\s\S]*?color:\s*inherit/);
    expect(css).toMatch(/\.btn-with-icon\s+\.nlc-icon[\s\S]*?color:\s*inherit/);
    expect(css).toMatch(/\.label-with-icon\s+\.nlc-icon[\s\S]*?color:\s*inherit/);
  });

  it("has no explicit icon color overrides inside buttons", () => {
    const hits = findControlIconColorOverrides();
    expect(hits, hits.join(", ")).toEqual([]);
  });

  it("defines all icon size CSS tokens on :root", () => {
    const css = readFileSync(join(root, "index.css"), "utf8");
    const rootBlock = css.match(/:root\s*\{[\s\S]*?\n\}/);
    expect(rootBlock).toBeTruthy();
    for (const token of ICON_SIZE_CSS_VARS) {
      expect(rootBlock[0], token).toMatch(new RegExp(`${token}:`));
    }
  });

  it("uses only semantic icon size keys in markup and renderIcon", () => {
    const hits = findInvalidIconSizeUsage();
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("has no inline font-size on nlc-icon elements", () => {
    const hits = findInlineIconFontSize();
    expect(hits, hits.join(", ")).toEqual([]);
  });

  it("does not use deprecated nlc-icon--xs in app markup", () => {
    const hits = [];
    for (const abs of walk(root)) {
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (EXCLUDE.has(rel)) continue;
      if (!/\.(html|js)$/.test(abs)) continue;
      if (/nlc-icon--xs/.test(readFileSync(abs, "utf8"))) hits.push(rel);
    }
    expect(hits, hits.join(", ")).toEqual([]);
  });

  it("does not use deprecated xs size in renderIcon calls", () => {
    const hits = [];
    const renderSize = /renderIcon\([^)]*size:\s*["']xs["']/g;
    for (const abs of walk(root)) {
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (EXCLUDE.has(rel)) continue;
      if (!/\.js$/.test(abs)) continue;
      const content = readFileSync(abs, "utf8");
      if (renderSize.test(content)) hits.push(rel);
      renderSize.lastIndex = 0;
    }
    expect(hits, hits.join(", ")).toEqual([]);
  });

  it("does not use legacy px selectors for nav-back chevrons", () => {
    const css = readFileSync(join(root, "index.css"), "utf8");
    const hits = findLegacyNavBackSizeSelectors(css);
    expect(hits, hits.join(", ")).toEqual([]);
  });
});
