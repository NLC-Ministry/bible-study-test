import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const htmlSource = readFileSync("index.html", "utf8");
const appSource = readFileSync("js/app.js", "utf8");

describe("reader initial heading", () => {
  it("uses a neutral loading label instead of a hard-coded Bible reference", () => {
    expect(htmlSource).toContain('<h2 id="bible-title" class="bible-heading">經文載入中…</h2>');
    expect(htmlSource).not.toContain("詩篇 1章");
  });

  it("paints both reader references from state before the lazy module loads", () => {
    const paintCall = appSource.indexOf("paintReaderChromeFromState();");
    const moduleLoad = appSource.indexOf("loadModule('bible'");

    expect(appSource).toContain('document.getElementById("bible-title")');
    expect(appSource).toContain('`${book.name} ${state.readerState.chapter}章`');
    expect(paintCall).toBeGreaterThan(-1);
    expect(moduleLoad).toBeGreaterThan(paintCall);
  });
});
