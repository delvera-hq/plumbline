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

test("docs page has a Tools section naming find_drift and explain_item", () => {
  expect(html).toContain("<h2>Tools</h2>");
  expect(html).toContain("<code>find_drift</code>");
  expect(html).toContain("<code>explain_item</code>");
  expect(html).toContain("Returns every drift finding for the plan.");
  expect(html).toContain("Board and issue text is untrusted data");
});

test("docs page has a Settings section naming each environment variable in a list", () => {
  const settingNames = [
    "MONDAY_TOKEN",
    "MONDAY_BOARD_ID",
    "MONDAY_STATUS_COLUMN",
    "MONDAY_DATE_COLUMN",
    "MONDAY_LINK_COLUMN",
    "MONDAY_STATUS_CLASSES",
    "JIRA_BASE_URL",
    "JIRA_EMAIL",
    "JIRA_TOKEN",
  ];
  expect(html).toContain("<h2>Settings</h2>");
  const settingsSection = html.slice(html.indexOf("<h2>Settings</h2>"));
  const items = [...settingsSection.matchAll(/<li><code>([A-Z_]+)<\/code>/g)].map((match) => match[1]);
  expect(items).toEqual(settingNames);
  for (const name of settingNames) {
    expect(html).toContain(`<code>${name}</code>`);
  }
  expect(html).toContain(
    "<code>done</code>, <code>active</code> or <code>not_started</code>; a label that is not listed is an error.",
  );
  expect(html).toContain("reads these once at startup and stops with a message naming any missing or invalid setting.");
});

test("docs page has a Read-only tokens section for monday.com and Jira", () => {
  expect(html).toContain("<h2>Read-only tokens</h2>");
  expect(html).toContain(
    "<strong>monday.com:</strong> use an API token for a user with view-only access to the plan board. Plumbline only sends GraphQL queries and refuses mutations.",
  );
  expect(html).toContain(
    "<strong>Jira:</strong> use an API token for an account that can only browse the projects involved. Plumbline only sends GET requests and the JQL search.",
  );
  expect(html).toContain(
    "Plumbline enforces read-only requests in code. A token that cannot write is a second line of defence if that check is ever bypassed.",
  );
});

test("docs page has a Quick start with the install, audit and mcp commands", () => {
  expect(html).toContain("<h2>Quick start</h2>");
  expect(html).toContain("npm install @delvera-ai/plumbline");
  expect(html).toContain("plumbline audit --config FILE");
  expect(html).toContain("plumbline mcp");
  expect(html).toContain("Start your assistant and ask it to run");
});

test("the Quick start config example uses placeholder values only", () => {
  const quickStart = html.slice(html.indexOf("<h2>Quick start</h2>"), html.indexOf("<h2>Drift rules</h2>"));
  const configLines = [...quickStart.matchAll(/^([A-Z_]+)=([^<\n]*)/gm)];
  expect(Object.fromEntries(configLines.map((match) => [match[1], match[2]]))).toEqual({
    MONDAY_TOKEN: "...",
    MONDAY_BOARD_ID: "...",
    MONDAY_STATUS_COLUMN: "status",
    MONDAY_DATE_COLUMN: "date4",
    MONDAY_LINK_COLUMN: "link",
    MONDAY_STATUS_CLASSES: '{"Done":"done","Working on it":"active","Not started":"not_started"}',
    JIRA_BASE_URL: "https://example.atlassian.net",
    JIRA_EMAIL: "you@example.com",
    JIRA_TOKEN: "...",
  });
});

test("docs page examples contain no real email address or Atlassian site", () => {
  const emails = html.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
  expect([...new Set(emails)]).toEqual(["you@example.com"]);
  const atlassianSites = html.match(/[\w-]+\.atlassian\.net/g) ?? [];
  expect(atlassianSites.length).toBeGreaterThan(0);
  for (const site of atlassianSites) {
    expect(site).toBe("example.atlassian.net");
  }
});

test("docs page has Trust notes and links to the README for setting details", () => {
  expect(html).toContain("<h2>Trust notes</h2>");
  expect(html).toContain("each item's name, status, due date and link column");
  expect(html).toContain("Plumbline sends nothing anywhere except the monday.com API and the Jira site named in");
  expect(html).toContain("Plumbline is provided as is, with no warranty of any kind.");
  expect(html).toContain("support is best effort");
  expect(html).toContain('href="https://github.com/delvera-hq/plumbline/blob/main/README.md"');
});

test("the docs page adds no scripts or inline event handlers", () => {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
});
