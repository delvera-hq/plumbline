import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("landing page heading is Plumbline with its tagline", () => {
  expect(html).toContain("<h1>Plumbline</h1>");
  expect(html).toContain("<p>Find where the plan and the work disagree.</p>");
});
