import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("NLC OIDC scopes for Member Hub sync", () => {
  it("documents member:read.basic in .env.example", () => {
    const example = readFileSync(join(root, ".env.example"), "utf8");
    expect(example).toMatch(/NLC_SCOPES=.*member:read\.basic/);
  });

  it("documents offline_access in .env.example so refresh tokens are OIDC-standard", () => {
    const example = readFileSync(join(root, ".env.example"), "utf8");
    expect(example).toMatch(/NLC_SCOPES=.*\boffline_access\b/);
  });

  it("defaults build-config scopes to include member:read.basic and offline_access", () => {
    const source = readFileSync(join(root, "build-config.js"), "utf8");
    expect(source).toContain('process.env.NLC_SCOPES || "openid profile email offline_access member:read.basic"');
  });

  it("keeps auth.js fallback scopes aligned with Member Hub access + refresh tokens", () => {
    const source = readFileSync(join(root, "js/auth.js"), "utf8");
    expect(source).toContain('NLC_CONFIG.scopes) || "openid profile email offline_access member:read.basic"');
  });
});
