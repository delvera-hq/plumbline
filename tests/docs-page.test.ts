import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const html = readFileSync(new URL("../public/docs/index.html", import.meta.url), "utf8");
const rulesSource = readFileSync(new URL("../src/rules.ts", import.meta.url), "utf8");

const headings = [...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1]);

test("docs page has a Drift rules section with an introduction", () => {
  expect(html).toContain("<h2>Drift rules</h2>");
  expect(html).toContain(
    "<p>Plumbline compares monday.com plan items with their linked Jira issues and reports each mismatch as a finding.",
  );
});

test("every drift rule appears in src/rules.ts order, each with a heading", () => {
  const ruleNames = [...rulesSource.matchAll(/^\s*\| "([A-Z_]+)"/gm)].map((match) => match[1]);
  expect(ruleNames).toHaveLength(6);
  expect(headings).toEqual(ruleNames);
});

test("each rule entry has an explanation and a made-up example", () => {
  expect(headings).toHaveLength(6);
  const sections = html.split("<h3>").slice(1);
  for (const section of sections) {
    expect(section).toContain("<p>Fires when");
    expect(section).toContain("<strong>Example:</strong>");
  }
});

test("the docs page adds no scripts or inline event handlers", () => {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
});
