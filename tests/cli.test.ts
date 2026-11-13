import { describe, expect, test, vi } from "vitest";
import { runAudit } from "../src/audit";
import type { FetchLike } from "../src/clients";

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
