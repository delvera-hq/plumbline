import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const binTarget = String(pkg.bin.plumbline).replace(/^\.\//, "");

let packedPaths: string[] = [];

// Build first so dist/ holds what the package would ship, then ask npm what it would pack.
beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const [result] = JSON.parse(output) as [{ files: { path: string }[] }];
  packedPaths = result.files.map((file) => file.path);
}, 120_000);

describe("package.json manifest", () => {
  test("is publishable under the scoped name with an MIT license", () => {
    expect(pkg.name).toBe("@delvera-ai/plumbline");
    expect(pkg.license).toBe("MIT");
    expect(pkg.private).toBeUndefined();
  });

  test("declares a repository URL", () => {
    expect(pkg.repository?.url).toContain("github.com/delvera-hq/plumbline");
  });

  test("bin.plumbline points into the built output", () => {
    expect(binTarget).toMatch(/^dist\/[^/]+\.js$/);
  });
});

describe("npm pack file list", () => {
  test("contains no paths under tests/, public/ or .github/", () => {
    for (const prefix of ["tests/", "public/", ".github/"]) {
      expect(packedPaths.filter((path) => path.startsWith(prefix))).toEqual([]);
    }
  });

  test("contains no fixture files", () => {
    expect(packedPaths.filter((path) => /fixture/i.test(path))).toEqual([]);
  });

  test("contains no .env files", () => {
    expect(packedPaths.filter((path) => /(^|\/)\.env(\.|$)/.test(path))).toEqual([]);
  });

  test("ships only top-level built JavaScript under dist/, so no docs-site files", () => {
    const distPaths = packedPaths.filter((path) => path.startsWith("dist/"));
    expect(distPaths.filter((path) => !/^dist\/[^/]+\.js$/.test(path))).toEqual([]);
  });

  test("includes LICENSE, README.md and the bin target", () => {
    expect(packedPaths).toContain("LICENSE");
    expect(packedPaths).toContain("README.md");
    expect(packedPaths).toContain(binTarget);
  });
});
