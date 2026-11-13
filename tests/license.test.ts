import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const license = readFileSync(new URL("../LICENSE", import.meta.url), "utf8");

test("LICENSE starts with the MIT License heading", () => {
  expect(license.startsWith("MIT License")).toBe(true);
});

test("LICENSE names Delvera as the copyright holder", () => {
  expect(license).toContain("Delvera");
});
