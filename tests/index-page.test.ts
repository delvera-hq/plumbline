import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("landing page title describes the product", () => {
  expect(html).toContain("<title>Plumbline: find where the plan and the work disagree</title>");
});

test("landing page heading is Plumbline with its tagline", () => {
  expect(html).toContain("<h1>Plumbline</h1>");
  expect(html).toContain("<p>Find where the plan and the work disagree.</p>");
});

test("landing page links to the newsletter next to Docs and Changelog", () => {
  expect(html).toContain(
    '<p><a href="/docs/">Docs</a> · <a href="/changelog/">Changelog</a> · <a href="https://plumbline.substack.com">Newsletter</a></p>',
  );
});
