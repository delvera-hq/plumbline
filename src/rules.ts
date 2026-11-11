export type StatusClass = "done" | "active" | "not_started";

export interface PlanItem {
  id: string;
  name: string;
  status: string;
  statusClass: StatusClass;
  dueDate: string | null;
  updatedAt: string | null;
  url: string;
  jiraKeys: string[];
}

export interface WorkIssue {
  key: string;
  status: string;
  statusClass: StatusClass;
  dueDate: string | null;
  updatedAt: string | null;
  url: string;
}

export interface DriftOptions {
  now: Date;
  staleDays?: number;
  dueSoonDays?: number;
}

export type Severity = "high" | "medium" | "low";

export type RuleName =
  | "PLAN_DONE_WORK_OPEN"
  | "WORK_DONE_PLAN_OPEN"
  | "DUE_SOON_NO_ACTIVITY"
  | "DATE_CONFLICT"
  | "NOT_LINKED"
  | "KEY_NOT_FOUND";

export interface EvidenceEntry {
  id: string;
  field: string;
  value: string | string[] | null;
}

export interface Finding {
  rule: RuleName;
  severity: Severity;
  summary: string;
  evidence: EvidenceEntry[];
}

const DAY_MS = 86_400_000;

// Accepts YYYY-MM-DD, optionally followed by a time and a Z or ±HH:MM offset.
const DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?(?:Z|([+-])(\d{2}):?(\d{2}))?$/i;

/**
 * Parses a date string to milliseconds since the epoch, in UTC.
 * A string with no offset is read as UTC, never as local time.
 * Returns null for missing or unparseable values.
 */
export function parseUtc(value: string | null): number | null {
  if (value === null) return null;
  const match = DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", sign, offHour = "0", offMinute = "0"] = match;
  const y = Number(year);
  const m = Number(month) - 1;
  const d = Number(day);
  // Date.UTC rolls over impossible dates such as 2026-02-31; reject them instead.
  if (new Date(Date.UTC(y, m, d)).getUTCDate() !== d) return null;
  const local = Date.UTC(y, m, d, Number(hour), Number(minute), Number(second));
  const offset = sign ? (sign === "+" ? 1 : -1) * (Number(offHour) * 60 + Number(offMinute)) * 60_000 : 0;
  return local - offset;
}

/** The UTC calendar day a timestamp falls on, as a day number. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * Compares a plan's items against the work issues they link to.
 * Pure: it reads only its arguments and never the system clock.
 */
export function findDrift(items: PlanItem[], issues: WorkIssue[], options: DriftOptions): Finding[] {
  const staleDays = options.staleDays ?? 7;
  const dueSoonDays = options.dueSoonDays ?? 7;
  const nowMs = options.now.getTime();
  const today = utcDay(nowMs);
  const staleBefore = nowMs - staleDays * DAY_MS;
  const issueByKey = new Map(issues.map((issue) => [issue.key, issue]));
  const findings: Finding[] = [];

  for (const item of items) {
    const linked: WorkIssue[] = [];
    const missingKeys: string[] = [];
    for (const key of item.jiraKeys) {
      const issue = issueByKey.get(key);
      if (issue) linked.push(issue);
      else missingKeys.push(key);
    }
    const openLinked = linked.filter((issue) => issue.statusClass !== "done");
    const itemDue = parseUtc(item.dueDate);
    const itemFact = (field: string, value: string | null): EvidenceEntry => ({ id: item.id, field, value });
    const issueStatusFacts = (issue: WorkIssue): EvidenceEntry[] => [
      { id: issue.key, field: "status", value: issue.status },
      { id: issue.key, field: "statusClass", value: issue.statusClass },
    ];

    // PLAN_DONE_WORK_OPEN: the plan says done, but linked work is still open.
    if (item.statusClass === "done" && openLinked.length > 0) {
      findings.push({
        rule: "PLAN_DONE_WORK_OPEN",
        severity: "high",
        summary: `${item.id} is marked done, but linked issue(s) ${openLinked.map((i) => i.key).join(", ")} are still open.`,
        evidence: [itemFact("statusClass", item.statusClass), ...openLinked.flatMap(issueStatusFacts)],
      });
    }

    // WORK_DONE_PLAN_OPEN: every linked issue is done, but the plan item is not.
    if (item.statusClass !== "done" && linked.length > 0 && openLinked.length === 0) {
      findings.push({
        rule: "WORK_DONE_PLAN_OPEN",
        severity: "medium",
        summary: `All linked issues for ${item.id} are done, but the plan item is not marked done.`,
        evidence: [itemFact("statusClass", item.statusClass), ...linked.flatMap(issueStatusFacts)],
      });
    }

    // DUE_SOON_NO_ACTIVITY: the item is due soon (overdue counts), unfinished, and every
    // open linked issue has gone stale. Missing dates or no open issues produce nothing.
    if (item.statusClass !== "done" && itemDue !== null && utcDay(itemDue) - today <= dueSoonDays) {
      const openWithDates = openLinked.map((issue) => ({ issue, updated: parseUtc(issue.updatedAt) }));
      const allStale =
        openWithDates.length > 0 && openWithDates.every(({ updated }) => updated !== null && updated < staleBefore);
      if (allStale) {
        findings.push({
          rule: "DUE_SOON_NO_ACTIVITY",
          severity: "high",
          summary: `${item.id} is due ${item.dueDate} and none of its open linked issues has changed in ${staleDays} days.`,
          evidence: [
            itemFact("dueDate", item.dueDate),
            ...openWithDates.flatMap(({ issue }) => [{ id: issue.key, field: "updatedAt", value: issue.updatedAt }]),
          ],
        });
      }
    }

    // DATE_CONFLICT: a linked issue is due after the plan item it belongs to.
    if (itemDue !== null) {
      const conflicts = linked.filter((issue) => {
        const issueDue = parseUtc(issue.dueDate);
        return issueDue !== null && utcDay(issueDue) > utcDay(itemDue);
      });
      if (conflicts.length > 0) {
        findings.push({
          rule: "DATE_CONFLICT",
          severity: "medium",
          summary: `${item.id} is due ${item.dueDate}, but linked issue(s) ${conflicts.map((i) => i.key).join(", ")} are due later.`,
          evidence: [
            itemFact("dueDate", item.dueDate),
            ...conflicts.map((issue) => ({ id: issue.key, field: "dueDate", value: issue.dueDate })),
          ],
        });
      }
    }

    // NOT_LINKED: an active item has no Jira keys at all.
    if (item.statusClass === "active" && item.jiraKeys.length === 0) {
      findings.push({
        rule: "NOT_LINKED",
        severity: "low",
        summary: `${item.id} is active but has no linked Jira keys.`,
        evidence: [itemFact("statusClass", item.statusClass), { id: item.id, field: "jiraKeys", value: [] }],
      });
    }

    // KEY_NOT_FOUND: the item names keys that no supplied issue has.
    if (missingKeys.length > 0) {
      findings.push({
        rule: "KEY_NOT_FOUND",
        severity: "medium",
        summary: `${item.id} names Jira key(s) ${missingKeys.join(", ")} that were not found.`,
        evidence: [{ id: item.id, field: "jiraKeys", value: missingKeys }],
      });
    }
  }

  return findings;
}
