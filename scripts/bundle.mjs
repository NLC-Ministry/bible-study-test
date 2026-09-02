// scripts/bundle.mjs
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  rmdirSync,
  copyFileSync,
  mkdtempSync
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

export function rmDirRecursive(dirPath) {
  if (existsSync(dirPath)) {
    readdirSync(dirPath).forEach((file) => {
      const curPath = join(dirPath, file);
      if (lstatSync(curPath).isDirectory()) {
        rmDirRecursive(curPath);
      } else {
        unlinkSync(curPath);
      }
    });
    rmdirSync(dirPath);
  }
}

export function cpDirRecursive(src, dest) {
  if (!existsSync(src)) return;
  const stats = lstatSync(src);
  if (stats.isDirectory()) {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }
    readdirSync(src).forEach((child) => {
      cpDirRecursive(join(src, child), join(dest, child));
    });
  } else {
    copyFileSync(src, dest);
  }
}

export function assertRelativeModuleImportsResolve(modulesDir) {
  if (!existsSync(modulesDir)) throw new Error(`bundle: missing copied modules directory: ${modulesDir}`);
  const moduleFiles = [];
  const collectModules = (directory) => {
    readdirSync(directory).forEach(name => {
      const path = join(directory, name);
      if (lstatSync(path).isDirectory()) collectModules(path);
      else if (/\.(?:js|mjs)$/.test(name)) moduleFiles.push(path);
    });
  };
  collectModules(modulesDir);

  const importPattern = /(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"'?#]+)(?:[?#][^"']*)?["']/g;
  moduleFiles.forEach(file => {
    if (file.endsWith("issue-report-ui.js")) return;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const dependency = join(dirname(file), match[1]);
      if (!existsSync(dependency)) {
        throw new Error(`bundle: copied module dependency missing: ${file} -> ${match[1]}`);
      }
    }
  });
}

export function copyLazyModuleRuntime(root, outDir) {
  const modulesSrc = join(root, "js", "modules");
  if (!existsSync(modulesSrc)) return false;
  cpDirRecursive(modulesSrc, join(outDir, "modules"));
  // Lazy modules are served from /modules instead of /js/modules. Preserve
  // their ../data/* relative imports by publishing js/data at /data too.
  cpDirRecursive(join(root, "js", "data"), join(outDir, "data"));
  assertRelativeModuleImportsResolve(join(outDir, "modules"));
  return true;
}
// Matches a local <script src="..."></script> with `src` in ANY attribute position
const SCRIPT_RE = /<script\b[^>]*?\ssrc="(?!https?:|\/\/)([^"?#]+)(?:[?#][^"]*)?"[^>]*>\s*<\/script>/g;
const CSS_RE = /<link\s+rel="stylesheet"\s+href="(?!https?:|\/\/)([^"?#]+)(?:[?#][^"]*)?"[^>]*>/g;

export function resolveLocalAssets(html) {
  const scripts = [...html.matchAll(SCRIPT_RE)].map((m) => m[1]);
  const stylesheets = [...html.matchAll(CSS_RE)].map((m) => m[1]);
  return { scripts, stylesheets, stylesheet: stylesheets[0] ?? null };
}

export function concatScripts(paths, readFile) {
  return paths.map((p) => readFile(p)).join("\n;\n");
}

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

export function assertParses(code) {
  try {
    new Function(code);
  } catch (err) {
    throw new Error(`bundle: assembled output failed syntax check: ${err.message}`);
  }
}

export function emitBundle({ root, outDir }) {
  const indexPath = join(root, "index.html");
  if (!existsSync(indexPath)) throw new Error(`bundle: missing ${indexPath}`);
  const html = readFileSync(indexPath, "utf8");
  const { scripts, stylesheets } = resolveLocalAssets(html);
  if (!stylesheets.length) throw new Error("bundle: no local stylesheet <link> found in index.html");

  const readSource = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) throw new Error(`bundle: referenced file missing: ${rel}`);
    return readFileSync(abs, "utf8");
  };

  // Compile using esbuild
  const entryPoint = join(root, "js/app.js");
  if (!existsSync(entryPoint)) throw new Error(`bundle: missing entrypoint ${entryPoint}`);

  console.log(`⚡ [esbuild] Bundling ${entryPoint}...`);
  const esbuildCmd = "npx esbuild";
  const tmpOutDir = mkdtempSync(join(tmpdir(), "bible-esbuild-"));
  const tmpOutFile = join(tmpOutDir, "app.bundle.js");

  let bundleJs;
  try {
    // Write to a file instead of capturing stdout — minified React bundles exceed
    // Node's default execSync maxBuffer and fail with ENOBUFS.
    execSync(
      `${esbuildCmd} "${entryPoint}" --bundle --minify --target=es2020 --alias:@=. --outfile="${tmpOutFile}"`,
      {
        encoding: "utf8",
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    bundleJs = readFileSync(tmpOutFile, "utf8");
  } catch (err) {
    console.error("esbuild failed stderr:", err.stderr || err.message);
    throw new Error(`esbuild compilation failed: ${err.message}`);
  } finally {
    rmDirRecursive(tmpOutDir);
  }

  assertParses(bundleJs);

  const cssContent = stylesheets.map((stylesheet) => readSource(stylesheet)).join("\n\n");

  // 💡 一勞永逸的快取清除法：動態產生當次建置版號，並替換程式中的 placeholder 欄位
  const buildVer = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const processedJs = bundleJs.replace(/__BUILD_VERSION__/g, buildVer);

  const jsFile = `app.${contentHash(processedJs)}.js`;
  const cssFile = `index.${contentHash(cssContent)}.css`;

  console.log("DEBUG: Removing and creating outDir: " + outDir);
  if (existsSync(outDir)) {
    rmDirRecursive(outDir);
  }
  mkdirSync(outDir, { recursive: true });
  console.log("DEBUG: outDir created, writing files...");

  writeFileSync(join(outDir, jsFile), processedJs, "utf8");
  writeFileSync(join(outDir, "app.js"), processedJs, "utf8");
  writeFileSync(join(outDir, cssFile), cssContent, "utf8");
  writeFileSync(join(outDir, "index.css"), cssContent, "utf8");
  console.log("DEBUG: Files written successfully!");

  // Rewrite HTML
  console.log("DEBUG: Rewriting HTML...");
  const total = scripts.length;
  let seen = 0;
  let outHtml = html.replace(SCRIPT_RE, () => {
    seen += 1;
    return seen === total ? `<script type="module" src="/${jsFile}"></script>` : "";
  });
  let seenStylesheet = 0;
  outHtml = outHtml.replace(CSS_RE, () => {
    seenStylesheet += 1;
    return seenStylesheet === 1 ? `<link rel="stylesheet" href="/${cssFile}" onerror="window.showAppStyleRecovery(this)">` : "";
  });
  console.log("DEBUG: Writing index.html...");
  writeFileSync(join(outDir, "index.html"), outHtml, "utf8");
  console.log("DEBUG: index.html written!");

  // Copy static assets unchanged.
  console.log("DEBUG: Copying assets...");
  cpDirRecursive(join(root, "assets"), join(outDir, "assets"));
  console.log("DEBUG: Copying manifest.json...");
  cpDirRecursive(join(root, "manifest.json"), join(outDir, "manifest.json"));
  const repairPage = join(root, "repair.html");
  if (existsSync(repairPage)) cpDirRecursive(repairPage, join(outDir, "repair.html"));
  console.log("DEBUG: Copying Service Worker and PWA runtime modules...");
  const serviceWorker = readFileSync(join(root, "sw.js"), "utf8")
    .replaceAll("__BUILD_VERSION__", buildVer)
    .replaceAll("__BUILD_JS_PATH__", `/${jsFile}`)
    .replaceAll("__BUILD_CSS_PATH__", `/${cssFile}`);
  writeFileSync(join(outDir, "sw.js"), serviceWorker, "utf8");
  cpDirRecursive(join(root, "js", "pwa"), join(outDir, "js", "pwa"));

  // Copy modules folder for lazy loading support
  const modulesSrc = join(root, "js/modules");
  console.log("DEBUG: Checking modulesSrc: " + modulesSrc);
  if (existsSync(modulesSrc)) {
    console.log("DEBUG: Copying modules...");
    copyLazyModuleRuntime(root, outDir);
  }
  const issueReportEntry = join(root, "js", "modules", "issue-report-ui.js");
  if (existsSync(issueReportEntry)) {
    const issueReportOut = join(outDir, "modules", "issue-report-ui.bundle.js");
    mkdirSync(join(outDir, "modules"), { recursive: true });
    execSync(
      `${esbuildCmd} "${issueReportEntry}" --bundle --minify --target=es2020 --format=esm --alias:@=. --outfile="${issueReportOut}"`,
      {
        encoding: "utf8",
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  }

  // ── 速讀測驗獨立頁：exam.html + esbuild(js/exam-entry.js) 打包成單一 bundle ──
  const examHtmlPath = join(root, "exam.html");
  const examEntryPath = join(root, "js", "exam-entry.js");
  if (existsSync(examHtmlPath) && existsSync(examEntryPath)) {
    console.log("DEBUG: Bundling exam.html entry...");
    const examTmpDir = mkdtempSync(join(tmpdir(), "bible-exam-"));
    const examTmpFile = join(examTmpDir, "exam.bundle.js");
    let examJs;
    try {
      execSync(
        `${esbuildCmd} "${examEntryPath}" --bundle --minify --target=es2020 --format=esm --alias:@=. --outfile="${examTmpFile}"`,
        { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "pipe"] }
      );
      examJs = readFileSync(examTmpFile, "utf8").replace(/__BUILD_VERSION__/g, buildVer);
    } catch (err) {
      console.error("esbuild(exam) failed stderr:", err.stderr || err.message);
      throw new Error(`esbuild exam entry failed: ${err.message}`);
    } finally {
      rmDirRecursive(examTmpDir);
    }
    const examJsFile = `exam.${contentHash(examJs)}.js`;
    writeFileSync(join(outDir, examJsFile), examJs, "utf8");
    const outExamHtml = readFileSync(examHtmlPath, "utf8")
      .replace(SCRIPT_RE, `<script type="module" src="/${examJsFile}"></script>`)
      .replace(CSS_RE, `<link rel="stylesheet" href="/${cssFile}">`);
    writeFileSync(join(outDir, "exam.html"), outExamHtml, "utf8");
    console.log("DEBUG: exam.html + " + examJsFile + " written!");
  }

  // ── 線上簡答批改獨立頁：grade.html + esbuild(js/grade-entry.js) ──
  const gradeHtmlPath = join(root, "grade.html");
  const gradeEntryPath = join(root, "js", "grade-entry.js");
  if (existsSync(gradeHtmlPath) && existsSync(gradeEntryPath)) {
    console.log("DEBUG: Bundling grade.html entry...");
    const gradeTmpDir = mkdtempSync(join(tmpdir(), "bible-grade-"));
    const gradeTmpFile = join(gradeTmpDir, "grade.bundle.js");
    let gradeJs;
    try {
      execSync(
        `${esbuildCmd} "${gradeEntryPath}" --bundle --minify --target=es2020 --format=esm --alias:@=. --outfile="${gradeTmpFile}"`,
        { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "pipe"] }
      );
      gradeJs = readFileSync(gradeTmpFile, "utf8").replace(/__BUILD_VERSION__/g, buildVer);
    } catch (err) {
      console.error("esbuild(grade) failed stderr:", err.stderr || err.message);
      throw new Error(`esbuild grade entry failed: ${err.message}`);
    } finally {
      rmDirRecursive(gradeTmpDir);
    }
    const gradeJsFile = `grade.${contentHash(gradeJs)}.js`;
    writeFileSync(join(outDir, gradeJsFile), gradeJs, "utf8");
    const outGradeHtml = readFileSync(gradeHtmlPath, "utf8")
      .replace(SCRIPT_RE, `<script type="module" src="/${gradeJsFile}"></script>`)
      .replace(CSS_RE, `<link rel="stylesheet" href="/${cssFile}">`);
    writeFileSync(join(outDir, "grade.html"), outGradeHtml, "utf8");
    console.log("DEBUG: grade.html + " + gradeJsFile + " written!");
  }
  console.log("DEBUG: emitBundle complete!");

  return { jsFile, cssFile };
}

import { resolve } from "node:path";
const currentPath = resolve(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (currentPath === entryPath) {
  const root = dirname(dirname(currentPath));
  const { jsFile, cssFile } = emitBundle({ root, outDir: join(root, "dist") });
  console.log(`bundle: wrote dist/${jsFile} and dist/${cssFile}`);
}
