import { describe, expect, test } from "vitest";
import { type JiraIssue, parseJiraIssue } from "../src/jira";
import { type MondayOptions, type MondayResponse, parseMondayPage } from "../src/monday";
import { renderDriftReport } from "../src/report";
import { type Finding, findDrift } from "../src/rules";
import jiraSample from "./fixtures/jira-issue.json";
import mondaySample from "./fixtures/monday-items.json";

// Fixed clock: findDrift must never read the real one.
const now = new Date("2026-11-11T12:00:00Z");

const mondayOptions: MondayOptions = {
  statusColumnId: "status",
  dateColumnId: "date4",
  linkColumnId: "link",
  statusClasses: { "Working on it": "active", Done: "done", "Not started": "not_started" },
};
const jiraOptions = { baseUrl: "https://example.atlassian.net" };
const FEEDBACK =
  "Did this audit help? Tell us by opening an issue at https://github.com/delvera-hq/plumbline/issues or through the waitlist form on the docs site.";

/** Runs the rules over the sample plan page and sample Jira issue. The patch may change the issue first. */
function fixtureFindings(patchIssue?: (issue: JiraIssue) => void): Finding[] {
  const page = parseMondayPage(structuredClone(mondaySample) as MondayResponse, mondayOptions);
  const issue = structuredClone(jiraSample) as JiraIssue;
  patchIssue?.(issue);
  return findDrift(page.items, [parseJiraIssue(issue, jiraOptions)], { now });
}

/** The count in a totals table row, e.g. `| KEY_NOT_FOUND | 1 |`. */
function total(report: string, label: string): number {
  const match = new RegExp(`^\\| ${label} \\| (\\d+) \\|$`, "m").exec(report);
  if (!match) throw new Error(`no totals row for ${label}`);
  return Number(match[1]);
}

const lastLine = (report: string) => report.trimEnd().split("\n").at(-1);

describe("renderDriftReport with fixture findings", () => {
  test("totals count the sample findings by rule and by severity", () => {
    const report = renderDriftReport(fixtureFindings());
    expect(total(report, "KEY_NOT_FOUND")).toBe(1);
    expect(total(report, "WORK_DONE_PLAN_OPEN")).toBe(0);
    expect(total(report, "medium")).toBe(1);
    expect(total(report, "high")).toBe(0);
    expect(report).toContain("Total findings: 1.");
  });

  test("totals and sections follow a patched sample where a linked issue is done", () => {
    // ENG-1 done leaves PLAN-9001 with no open linked issue, so WORK_DONE_PLAN_OPEN fires too.
    const findings = fixtureFindings((issue) => {
      issue.fields.status = { name: "Done", statusCategory: { key: "done" } };
    });
    const report = renderDriftReport(findings);
    expect(total(report, "WORK_DONE_PLAN_OPEN")).toBe(1);
    expect(total(report, "KEY_NOT_FOUND")).toBe(1);
    expect(total(report, "medium")).toBe(2);
    expect(report.indexOf("### 1. WORK_DONE_PLAN_OPEN (medium)")).toBeLessThan(
      report.indexOf("### 2. KEY_NOT_FOUND (medium)"),
    );
    expect(report).toContain("- 9001, statusClass: active");
    expect(report).toContain("- ENG\\-1, status: Done");
  });
});

describe("renderDriftReport structure", () => {
  const findings: Finding[] = [
    {
      rule: "NOT_LINKED",
      severity: "low",
      summary: "PLAN-3 is active but has no linked Jira keys.",
      evidence: [{ id: "PLAN-3", field: "jiraKeys", value: [] }],
    },
    {
      rule: "PLAN_DONE_WORK_OPEN",
      severity: "high",
      summary: "PLAN-1 is marked done, but linked issue(s) ENG-1 are still open.",
      evidence: [{ id: "PLAN-1", field: "statusClass", value: "done" }],
    },
    {
      rule: "DATE_CONFLICT",
      severity: "medium",
      summary: "PLAN-2 is due 2026-12-01, but linked issue(s) ENG-2 are due later.",
      evidence: [{ id: "ENG-2", field: "dueDate", value: "2026-12-05" }],
    },
  ];

  test("shows the totals before the per-finding sections", () => {
    const report = renderDriftReport(findings);
    const byRule = report.indexOf("## Totals by rule");
    const bySeverity = report.indexOf("## Totals by severity");
    const sections = report.indexOf("## Findings");
    expect(byRule).toBeGreaterThan(0);
    expect(byRule).toBeLessThan(bySeverity);
    expect(bySeverity).toBeLessThan(sections);
    expect(sections).toBeLessThan(report.indexOf("### 1."));
  });

  test("lists findings high severity first, each followed by its evidence", () => {
    const report = renderDriftReport(findings);
    const high = report.indexOf("### 1. PLAN_DONE_WORK_OPEN (high)");
    const medium = report.indexOf("### 2. DATE_CONFLICT (medium)");
    const low = report.indexOf("### 3. NOT_LINKED (low)");
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(medium);
    expect(medium).toBeLessThan(low);
    expect(report.indexOf("- PLAN\\-1, statusClass: done")).toBeGreaterThan(high);
    expect(report.indexOf("- ENG\\-2, dueDate: 2026\\-12\\-05")).toBeGreaterThan(medium);
    expect(report.indexOf("- PLAN\\-3, jiraKeys: none")).toBeGreaterThan(low);
  });

  test("ends with exactly one feedback line", () => {
    const report = renderDriftReport(findings);
    expect(lastLine(report)).toBe(FEEDBACK);
    expect(report.split("Did this audit help?")).toHaveLength(2);
  });

  test("handles an empty findings list", () => {
    const report = renderDriftReport([]);
    expect(report).toContain("Total findings: 0.");
    expect(total(report, "KEY_NOT_FOUND")).toBe(0);
    expect(total(report, "high")).toBe(0);
    expect(total(report, "low")).toBe(0);
    expect(report).toContain("## Findings\n\nNo drift findings.\n");
    expect(report).not.toMatch(/^### /m);
    expect(lastLine(report)).toBe(FEEDBACK);
  });

  test("escapes untrusted text so it stays inside its line", () => {
    const report = renderDriftReport([
      {
        rule: "KEY_NOT_FOUND",
        severity: "medium",
        summary: "ENG-1 <b>names</b> keys.",
        evidence: [{ id: "ENG-1", field: "summary", value: "# Injected\n- item | `code`" }],
      },
    ]);
    expect(report).not.toMatch(/^# Injected/m);
    expect(report).not.toMatch(/^- item/m);
    expect(report).toContain("ENG\\-1 \\<b\\>names\\<\\/b\\> keys\\.");
    expect(report).toContain("- ENG\\-1, summary: \\# Injected \\- item \\| \\`code\\`");
  });
});
