import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const planSource = readFileSync(new URL("../src/plan.ts", import.meta.url), "utf8");
const clientsSource = readFileSync(new URL("../src/clients.ts", import.meta.url), "utf8");

// config-file.ts only splits KEY=value lines; the keys it accepts are the ones the config schema and token reads name.
const configKeys = [
  ...[...planSource.matchAll(/^\s+([A-Z_]+):\s*z\b/gm)].map((match) => match[1]),
  ...[...clientsSource.matchAll(/requireEnv\(options\.env, "([A-Z_]+)"\)/g)].map((match) => match[1]),
];

test("the source defines the nine settings the README must explain", () => {
  expect([...new Set(configKeys)].sort()).toEqual(
    [
      "JIRA_BASE_URL",
      "JIRA_EMAIL",
      "JIRA_TOKEN",
      "MONDAY_BOARD_ID",
      "MONDAY_DATE_COLUMN",
      "MONDAY_LINK_COLUMN",
      "MONDAY_STATUS_CLASSES",
      "MONDAY_STATUS_COLUMN",
      "MONDAY_TOKEN",
    ].sort(),
  );
});

test("every config key is named in the README", () => {
  for (const key of new Set(configKeys)) {
    expect(readme, `README is missing ${key}`).toContain(`\`${key}\``);
  }
});

test("quick start covers install, a config file, audit with --config, and the MCP command", () => {
  expect(readme).toContain("## Quick start");
  expect(readme).toContain("npm install @delvera-ai/plumbline");
  expect(readme).toContain("plumbline audit --config plumbline.env");
  expect(readme).toContain("plumbline mcp");
  expect(readme).toContain("claude mcp add --transport stdio");
  expect(readme).toContain("find_drift");
});

test("the README has sections on what Plumbline reads and that nothing else receives data", () => {
  expect(readme).toContain("## What Plumbline reads and what it sends");
  expect(readme).toContain("Plumbline sends nothing anywhere else.");
});

test("the README has a read-only tokens section that says writes are refused", () => {
  expect(readme).toContain("## Read-only tokens");
  expect(readme).toContain("the code refuses any mutation");
  expect(readme).toContain("the code refuses any other request");
  expect(readme).toContain("second line of defence");
});

test("the README has a no-warranty section with best-effort support through GitHub issues", () => {
  expect(readme).toContain("## No warranty and support");
  expect(readme).toContain("no warranty of any kind");
  expect(readme).toContain("Support is best effort.");
  expect(readme).toContain("[GitHub issues](https://github.com/delvera-hq/plumbline/issues)");
});

test("examples use only placeholder emails, URLs and tokens", () => {
  const emails = [...readme.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0]);
  for (const email of emails) {
    expect(email.endsWith("@example.com"), `${email} is not an example.com address`).toBe(true);
  }

  const urls = [...readme.matchAll(/https?:\/\/[^\s)"'`]+/g)].map((match) => match[0]);
  const allowedUrls = [
    "https://example.atlassian.net",
    "https://api.monday.com/v2",
    "https://github.com/delvera-hq/plumbline/issues",
  ];
  for (const url of urls) {
    expect(allowedUrls, `${url} is not an allowed URL`).toContain(url);
  }

  const tokenValues = [...readme.matchAll(/(?:TOKEN|JIRA_EMAIL)=(\S+)/g)].map((match) => match[1]);
  expect(tokenValues.length).toBeGreaterThan(0);
  for (const value of tokenValues) {
    expect(value === "..." || value.endsWith("@example.com"), `${value} is not a placeholder`).toBe(true);
  }
});
