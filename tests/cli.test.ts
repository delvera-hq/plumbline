import { describe, expect, test, vi } from "vitest";
import { runAudit } from "../src/audit";
import { runCli } from "../src/cli";
import type { FetchLike } from "../src/clients";
import jiraFixture from "./fixtures/jira-issue.json";
import mondayFixture from "./fixtures/monday-items.json";

// Fixed clock: the drift rules must never read the real one.
const now = new Date("2026-11-12T12:00:00Z");

const MONDAY_ENDPOINT = "https://api.monday.com/v2";
const JIRA_SEARCH = "https://example.atlassian.net/rest/api/3/search/jql";

const env: Record<string, string | undefined> = {
  MONDAY_TOKEN: "mon-secret-token-111",
  JIRA_EMAIL: "dev@example.com",
  JIRA_TOKEN: "jira-secret-token-222",
  MONDAY_BOARD_ID: "1234",
  MONDAY_STATUS_COLUMN: "status",
  MONDAY_DATE_COLUMN: "date4",
  MONDAY_LINK_COLUMN: "link",
  MONDAY_STATUS_CLASSES: JSON.stringify({ Done: "done", "Working on it": "active" }),
  JIRA_BASE_URL: "https://example.atlassian.net",
};

// A done plan item whose linked Jira issue is still in progress: one PLAN_DONE_WORK_OPEN finding.
const driftItems = [
  {
    id: "9002",
    name: "Ship the importer",
    updated_at: "2026-11-10T09:00:00Z",
    url: "https://plan.example/items/9002",
    column_values: [
      { id: "status", text: "Done" },
      { id: "date4", text: "" },
      { id: "link", text: "ENG-2" },
    ],
  },
];
const driftIssues = [
  {
    key: "ENG-2",
    fields: {
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      duedate: null,
      updated: "2026-11-11T08:00:00.000+0000",
    },
  },
];

// A done plan item whose linked Jira issue is also done: no findings.
const cleanItems = [
  {
    id: "9003",
    name: "Finished work",
    updated_at: "2026-11-10T09:00:00Z",
    url: "https://plan.example/items/9003",
    column_values: [
      { id: "status", text: "Done" },
      { id: "date4", text: "" },
      { id: "link", text: "ENG-3" },
    ],
  },
];
const cleanIssues = [
  {
    key: "ENG-3",
    fields: {
      status: { name: "Done", statusCategory: { key: "done" } },
      duedate: null,
      updated: "2026-11-11T08:00:00.000+0000",
    },
  },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fake network: serves one monday.com board page and the Jira issues, and records every call. */
function fakePlan(items: unknown[], issues: unknown[]) {
  return vi.fn<FetchLike>(async (url) => {
    if (url === MONDAY_ENDPOINT) {
      return json({ data: { boards: [{ items_page: { cursor: null, items } }] } });
    }
    if (url === JIRA_SEARCH) return json({ issues, isLast: true });
    throw new Error(`unexpected request to ${url}`);
  });
}

/** Builds the audit's outputs, which record what the command writes. */
function outputs(fetch: FetchLike, overrides: { env?: Record<string, string | undefined> } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files = new Map<string, string>();
  const deps = {
    env: overrides.env ?? env,
    fetch,
    now: () => now,
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
    writeFile: async (path: string, text: string) => {
      files.set(path, text);
    },
  };
  return { deps, stdout, stderr, files };
}

describe("plumbline audit", () => {
  test("writes the Markdown report to stdout and exits 0 when drift is found", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps, stdout, stderr, files } = outputs(fetch);

    const code = await runAudit(["audit"], deps);

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toMatch(/^# Plumbline drift report\n/);
    expect(stdout[0]).toContain("Total findings: 1.");
    expect(stdout[0]).toContain("PLAN_DONE_WORK_OPEN");
    expect(stderr).toEqual([]);
    expect(files.size).toBe(0);
  });

  test("exits 0 and reports no findings when the plan has no drift", async () => {
    const { deps, stdout } = outputs(fakePlan(cleanItems, cleanIssues));

    const code = await runAudit(["audit"], deps);

    expect(code).toBe(0);
    expect(stdout[0]).toContain("Total findings: 0.");
    expect(stdout[0]).toContain("No drift findings.");
  });

  test("writes the report to the --out file, and nothing to stdout", async () => {
    const { deps, stdout, stderr, files } = outputs(fakePlan(driftItems, driftIssues));

    const code = await runAudit(["audit", "--out", "report.md"], deps);

    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect([...files.keys()]).toEqual(["report.md"]);
    expect(files.get("report.md")).toMatch(/^# Plumbline drift report\n/);
    expect(files.get("report.md")).toContain("PLAN_DONE_WORK_OPEN");
  });

  test("exits non-zero and names the missing setting when a setting is missing", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { MONDAY_BOARD_ID: _unused, ...withoutBoard } = env;
    const { deps, stdout, stderr } = outputs(fetch, { env: withoutBoard });

    const code = await runAudit(["audit"], deps);

    expect(code).toBe(1);
    expect(stderr[0]).toContain("MONDAY_BOARD_ID");
    expect(stdout).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("exits non-zero and names the setting when a setting is invalid", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps, stdout, stderr } = outputs(fetch, {
      env: { ...env, MONDAY_STATUS_CLASSES: "not json" },
    });

    const code = await runAudit(["audit"], deps);

    expect(code).toBe(1);
    expect(stderr[0]).toContain("MONDAY_STATUS_CLASSES");
    expect(stdout).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("exits non-zero when a request fails, without printing a token", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("denied", { status: 500 }));
    const { deps, stdout, stderr } = outputs(fetch);

    const code = await runAudit(["audit"], deps);

    expect(code).toBe(1);
    expect(stderr[0]).toContain("monday.com request failed with HTTP 500");
    expect(stderr.join("\n")).not.toContain(env.MONDAY_TOKEN);
    expect(stdout).toEqual([]);
  });

  test("exits non-zero with usage for an unknown command, an unknown option, or a bad --out", async () => {
    const badArgv = [
      [],
      ["report"],
      ["audit", "extra"],
      ["audit", "--bogus"],
      ["audit", "--out"],
      ["audit", "--out", ""],
    ];
    for (const argv of badArgv) {
      const fetch = fakePlan(driftItems, driftIssues);
      const { deps, stdout, stderr } = outputs(fetch);

      const code = await runAudit(argv, deps);

      expect(code, JSON.stringify(argv)).toBe(1);
      expect(stderr.join("\n"), JSON.stringify(argv)).toContain("plumbline audit");
      expect(stdout).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  test("sends only reads: monday.com queries and the Jira search", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps } = outputs(fetch);

    await runAudit(["audit"], deps);

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(init?.method).toBe("POST");
      expect([MONDAY_ENDPOINT, JIRA_SEARCH]).toContain(url);
    }
    const mondayBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { query: string };
    expect(mondayBody.query.trimStart()).toMatch(/^query/);
  });
});

/** Renders settings as the lines of a --config file. An undefined setting is left out. */
function configText(settings: Record<string, string | undefined>): string {
  return Object.entries(settings)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** The outputs for the CLI, plus a config file that reads as `text`, or fails with `error` when given one. */
function cliOutputs(
  fetch: FetchLike,
  config: { text?: string; error?: Error },
  overrides: { env?: Record<string, string | undefined> } = {},
) {
  const { deps, stdout, stderr, files } = outputs(fetch, overrides);
  const readFile = vi.fn(async () => {
    if (config.error) throw config.error;
    return config.text ?? "";
  });
  return { deps: { ...deps, readFile }, stdout, stderr, files, readFile };
}

/** A fake network that serves the monday.com and Jira fixtures, and no further monday.com items. */
function fixturePlan() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (url === MONDAY_ENDPOINT) {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      if (query.includes("next_items_page")) {
        return json({ data: { next_items_page: { cursor: null, items: [] } } });
      }
      return json(mondayFixture);
    }
    if (url === JIRA_SEARCH) return json({ issues: [jiraFixture], isLast: true });
    throw new Error(`unexpected request to ${url}`);
  });
}

describe("plumbline audit --config FILE", () => {
  test("reads every setting from the file when the environment is empty", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps, stdout, stderr } = cliOutputs(fetch, { text: configText(env) }, { env: {} });

    const code = await runCli(["audit", "--config", "plumbline.env"], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout[0]).toContain("PLAN_DONE_WORK_OPEN");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("takes a setting the file leaves out from the environment", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { MONDAY_BOARD_ID: _board, ...fileWithoutBoard } = env;
    const { deps, stderr } = cliOutputs(
      fetch,
      { text: configText(fileWithoutBoard) },
      { env: { MONDAY_BOARD_ID: "1234" } },
    );

    const code = await runCli(["audit", "--config", "plumbline.env"], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const mondayBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { variables: { boardId: string[] } };
    expect(mondayBody.variables.boardId).toEqual(["1234"]);
  });

  test("prefers a setting in the file over the same setting in the environment", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps, stdout } = cliOutputs(fetch, { text: configText({ MONDAY_BOARD_ID: "5678" }) }, { env });

    const code = await runCli(["audit", "--config", "plumbline.env"], deps);

    expect(code).toBe(0);
    expect(stdout[0]).toContain("Total findings: 1.");
    const mondayBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { variables: { boardId: string[] } };
    expect(mondayBody.variables.boardId).toEqual(["5678"]);
  });

  test("exits non-zero and names a setting missing from both the file and the environment, without a token", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { MONDAY_BOARD_ID: _board, ...withoutBoard } = env;
    const { deps, stdout, stderr } = cliOutputs(fetch, { text: configText(withoutBoard) }, { env: {} });

    const code = await runCli(["audit", "--config", "plumbline.env"], deps);

    expect(code).toBe(1);
    expect(stderr[0]).toContain("MONDAY_BOARD_ID");
    expect(stderr.join("\n")).not.toContain(env.MONDAY_TOKEN);
    expect(stderr.join("\n")).not.toContain(env.JIRA_TOKEN);
    expect(stdout).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("exits non-zero and names an invalid setting from the file, without a token", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps, stdout, stderr } = cliOutputs(
      fetch,
      { text: configText({ ...env, MONDAY_STATUS_CLASSES: "not json" }) },
      { env: {} },
    );

    const code = await runCli(["audit", "--config", "plumbline.env"], deps);

    expect(code).toBe(1);
    expect(stderr[0]).toContain("MONDAY_STATUS_CLASSES");
    expect(stderr.join("\n")).not.toContain(env.MONDAY_TOKEN);
    expect(stdout).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("exits non-zero without printing a token when a line has no =", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps, stdout, stderr } = cliOutputs(fetch, { text: `MONDAY_BOARD_ID=1234\n${env.MONDAY_TOKEN}\n` });

    const code = await runCli(["audit", "--config", "plumbline.env"], deps);

    expect(code).toBe(1);
    expect(stderr[0]).toContain("config file line 2");
    expect(stderr.join("\n")).not.toContain(env.MONDAY_TOKEN);
    expect(stdout).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("exits non-zero and names the file when it cannot be read", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps, stdout, stderr } = cliOutputs(fetch, { error: new Error("ENOENT: no such file") }, { env });

    const code = await runCli(["audit", "--config", "missing.env"], deps);

    expect(code).toBe(1);
    expect(stderr[0]).toContain("missing.env");
    expect(stdout).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("exits non-zero with usage when --config has no file name", async () => {
    for (const argv of [
      ["audit", "--config"],
      ["audit", "--config", ""],
    ]) {
      const fetch = fakePlan(driftItems, driftIssues);
      const { deps, stdout, stderr, readFile } = cliOutputs(fetch, { text: configText(env) }, { env });

      const code = await runCli(argv, deps);

      expect(code, JSON.stringify(argv)).toBe(1);
      expect(stderr.join("\n"), JSON.stringify(argv)).toContain("--config needs a file name");
      expect(stdout).toEqual([]);
      expect(readFile).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  test("writes the Markdown report for the fixtures to stdout, with faked clients", async () => {
    const fetch = fixturePlan();
    const { deps, stdout, stderr } = cliOutputs(fetch, { text: configText(env) }, { env: {} });

    const code = await runCli(["audit", "--config", "plumbline.env"], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toMatch(/^# Plumbline drift report\n/);
    expect(stdout[0]).toContain("Total findings:");
    expect(fetch).toHaveBeenCalled();
  });

  test("writes the report to the --out file when --out is given after --config", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps, stdout, files } = cliOutputs(fetch, { text: configText(env) }, { env: {} });

    const code = await runCli(["audit", "--config", "plumbline.env", "--out", "report.md"], deps);

    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(files.get("report.md")).toMatch(/^# Plumbline drift report\n/);
  });

  test("runs the audit without reading a file when --config is not given", async () => {
    const fetch = fakePlan(driftItems, driftIssues);
    const { deps, stdout, readFile } = cliOutputs(fetch, {}, { env });

    const code = await runCli(["audit"], deps);

    expect(code).toBe(0);
    expect(stdout[0]).toContain("Total findings: 1.");
    expect(readFile).not.toHaveBeenCalled();
  });
});
