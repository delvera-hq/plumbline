import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Node runs the built files without resolving extensions, so every relative
// specifier in src/ must name its file with .js (TypeScript maps it back to .ts).
const srcDir = new URL("../src/", import.meta.url);

// Matches `from "./x"`, `import "./x"` and `import("./x")`, including multi-line imports and re-exports.
const relativeSpecifier = /\b(?:from|import)\s*\(?\s*(["'])(\.{1,2}\/[^"']*)\1/g;

test("every relative import and export in src/ names its file with .js", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(srcDir).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, srcDir), "utf8");
    for (const match of source.matchAll(relativeSpecifier)) {
      const specifier = match[2] ?? "";
      if (!specifier.endsWith(".js")) {
        offenders.push(`src/${file}: ${match[0]} (add .js to "${specifier}")`);
      }
    }
  }
  expect(offenders, offenders.join("\n")).toEqual([]);
});
