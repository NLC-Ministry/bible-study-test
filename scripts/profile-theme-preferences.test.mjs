import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const css = readFileSync("index.css", "utf8");
const state = readFileSync("js/state.js", "utf8");
const app = readFileSync("js/app.js", "utf8");
const profile = readFileSync("js/modules/profile.js", "utf8");
const bible = readFileSync("js/modules/bible.js", "utf8");

describe("Profile theme preferences", () => {
  it("adds a dedicated preferences tab with light and dark choices", () => {
    expect(html).toContain('data-profile-open="preferences"');
    expect(html).toContain('id="profile-tab-content-preferences"');
    expect(html).toContain('data-profile-theme="light"');
    expect(html).toContain('data-profile-theme="dark"');
    expect(html).not.toContain('data-profile-theme="warm"');
    expect(css).toContain(".profile-theme-option.active");
  });

  it("removes the top bar day and night toggle without touching the verse card background action", () => {
    expect(html).not.toContain('id="theme-toggle"');
    expect(css).not.toContain("#theme-toggle");
    expect(state).not.toContain('getElementById("theme-toggle")');
    expect(app).not.toContain('getElementById("theme-toggle")');
    expect(html).toContain('id="btn-change-verse-bg"');
  });

  it("uses one shared theme action for profile and reader controls", () => {
    expect(state).toContain("window.applyAppTheme = applyAppTheme");
    expect(state).toContain('localStorage.setItem("app_theme", nextTheme)');
    expect(profile).toContain('window.applyAppTheme(button.dataset.profileTheme)');
    expect(bible).not.toContain("window.applyAppTheme = function");
  });
});