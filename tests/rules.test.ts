import { describe, expect, test } from "vitest";
import { findDrift, type PlanItem, parseUtc, type WorkIssue } from "../src/rules";

// Fixed clock: findDrift must never read the real one.
const now = new Date("2026-11-11T12:00:00Z");

function plan(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "PLAN-1",
    name: "Ship the thing",
    status: "In progress",
    statusClass: "active",
    dueDate: "2026-12-01",
    updatedAt: "2026-11-10T09:00:00Z",
    url: "https://plan.example/PLAN-1",
    jiraKeys: ["ENG-1"],
    ...overrides,
  };
}

function issue(overrides: Partial<WorkIssue> = {}): WorkIssue {
  return {
    key: "ENG-1",
    status: "In Progress",
    statusClass: "active",
    dueDate: "2026-11-30",
    updatedAt: "2026-11-10T09:00:00Z",
    url: "https://jira.example/ENG-1",
    ...overrides,
  };
}

const rulesIn = (findings: { rule: string }[]) => findings.map((f) => f.rule);

describe("parseUtc", () => {
  test("reads a bare date as UTC midnight", () => {
    expect(parseUtc("2026-11-11")).toBe(Date.UTC(2026, 10, 11));
  });

  test("reads a timestamp with no offset as UTC, not local time", () => {
    expect(parseUtc("2026-11-11T10:00:00")).toBe(Date.UTC(2026, 10, 11, 10));
  });

  test("applies an explicit offset", () => {
    expect(parseUtc("2026-11-11T10:00:00+02:00")).toBe(Date.UTC(2026, 10, 11, 8));
  });

  test("returns null for missing, invalid or impossible dates", () => {
    expect(parseUtc(null)).toBeNull();
    expect(parseUtc("not a date")).toBeNull();
    expect(parseUtc("2026-02-31")).toBeNull();
  });

  test("reads Jira's +0000 offset form", () => {
    expect(parseUtc("2026-11-10T09:00:00.000+0000")).toBe(Date.UTC(2026, 10, 10, 9));
  });

  test("returns null for an impossible month", () => {
    expect(parseUtc("2026-13-01")).toBeNull();
    expect(parseUtc("2026-00-10")).toBeNull();
  });

  test("returns null for an impossible day", () => {
    expect(parseUtc("2026-11-00")).toBeNull();
    expect(parseUtc("2026-11-31")).toBeNull();
  });

  test("returns null for an impossible hour", () => {
    expect(parseUtc("2026-11-10T25:00:00Z")).toBeNull();
    expect(parseUtc("2026-11-10T24:00:00Z")).toBeNull();
  });

  test("returns null for an impossible minute", () => {
    expect(parseUtc("2026-11-10T09:60:00Z")).toBeNull();
  });

  test("returns null for an impossible second", () => {
    expect(parseUtc("2026-11-10T09:00:60Z")).toBeNull();
  });

  test("returns null for an offset hour over 23 or offset minute over 59", () => {
    expect(parseUtc("2026-11-10T09:00:00+24:00")).toBeNull();
    expect(parseUtc("2026-11-10T09:00:00-99:00")).toBeNull();
    expect(parseUtc("2026-11-10T09:00:00+01:60")).toBeNull();
    expect(parseUtc("2026-11-10T09:00:00+0160")).toBeNull();
  });

  test("accepts the largest valid field values", () => {
    expect(parseUtc("2026-12-31T23:59:59+23:59")).toBe(Date.UTC(2026, 11, 31, 23, 59, 59) - (23 * 60 + 59) * 60_000);
  });
});

describe("findDrift", () => {
  describe("PLAN_DONE_WORK_OPEN", () => {
    test("fires when the plan item is done and a linked issue is open", () => {
      const findings = findDrift([plan({ statusClass: "done" })], [issue()], { now });
      expect(rulesIn(findings)).toContain("PLAN_DONE_WORK_OPEN");
      const finding = findings.find((f) => f.rule === "PLAN_DONE_WORK_OPEN");
      expect(finding?.severity).toBe("high");
      expect(finding?.evidence).toContainEqual({ id: "ENG-1", field: "statusClass", value: "active" });
    });

    test("does not fire when every linked issue is done", () => {
      const findings = findDrift([plan({ statusClass: "done" })], [issue({ statusClass: "done" })], { now });
      expect(rulesIn(findings)).not.toContain("PLAN_DONE_WORK_OPEN");
    });
  });

  describe("WORK_DONE_PLAN_OPEN", () => {
    test("fires when all linked issues are done and the plan item is not", () => {
      const findings = findDrift([plan({ statusClass: "active" })], [issue({ statusClass: "done" })], { now });
      expect(rulesIn(findings)).toContain("WORK_DONE_PLAN_OPEN");
    });

    test("does not fire when a linked issue is still open", () => {
      const findings = findDrift([plan({ statusClass: "active" })], [issue({ statusClass: "active" })], { now });
      expect(rulesIn(findings)).not.toContain("WORK_DONE_PLAN_OPEN");
    });

    test("does not fire when there are no resolvable linked issues", () => {
      const findings = findDrift([plan({ statusClass: "active", jiraKeys: ["ENG-9"] })], [], { now });
      expect(rulesIn(findings)).not.toContain("WORK_DONE_PLAN_OPEN");
    });
  });

  describe("DUE_SOON_NO_ACTIVITY", () => {
    test("fires when due within dueSoonDays and every open linked issue is stale", () => {
      const findings = findDrift([plan({ dueDate: "2026-11-15" })], [issue({ updatedAt: "2026-10-01T00:00:00Z" })], {
        now,
      });
      expect(rulesIn(findings)).toContain("DUE_SOON_NO_ACTIVITY");
    });

    test("does not fire when an open linked issue changed recently", () => {
      const findings = findDrift([plan({ dueDate: "2026-11-15" })], [issue({ updatedAt: "2026-11-10T00:00:00Z" })], {
        now,
      });
      expect(rulesIn(findings)).not.toContain("DUE_SOON_NO_ACTIVITY");
    });

    test("does not fire when the due date is beyond dueSoonDays", () => {
      const findings = findDrift([plan({ dueDate: "2026-12-20" })], [issue({ updatedAt: "2026-10-01T00:00:00Z" })], {
        now,
      });
      expect(rulesIn(findings)).not.toContain("DUE_SOON_NO_ACTIVITY");
    });

    test("records the now timestamp and stale cutoff in its evidence as ISO 8601 UTC", () => {
      const findings = findDrift([plan({ dueDate: "2026-11-15" })], [issue({ updatedAt: "2026-10-01T00:00:00Z" })], {
        now,
      });
      const finding = findings.find((f) => f.rule === "DUE_SOON_NO_ACTIVITY");
      expect(finding?.evidence).toContainEqual({ id: "PLAN-1", field: "now", value: "2026-11-11T12:00:00.000Z" });
      expect(finding?.evidence).toContainEqual({
        id: "PLAN-1",
        field: "staleCutoff",
        value: "2026-11-04T12:00:00.000Z",
      });
    });

    test("the stale cutoff follows staleDays", () => {
      const findings = findDrift([plan({ dueDate: "2026-11-15" })], [issue({ updatedAt: "2026-10-01T00:00:00Z" })], {
        now,
        staleDays: 3,
      });
      const finding = findings.find((f) => f.rule === "DUE_SOON_NO_ACTIVITY");
      expect(finding?.evidence).toContainEqual({
        id: "PLAN-1",
        field: "staleCutoff",
        value: "2026-11-08T12:00:00.000Z",
      });
    });

    test("does not fire when the updatedAt of a linked issue is missing", () => {
      const findings = findDrift([plan({ dueDate: "2026-11-15" })], [issue({ updatedAt: null })], { now });
      expect(rulesIn(findings)).not.toContain("DUE_SOON_NO_ACTIVITY");
    });
  });

  describe("DATE_CONFLICT", () => {
    test("fires when a linked issue is due after the plan item", () => {
      const findings = findDrift([plan({ dueDate: "2026-12-01" })], [issue({ dueDate: "2026-12-15" })], { now });
      expect(rulesIn(findings)).toContain("DATE_CONFLICT");
    });

    test("does not fire when the dates agree", () => {
      const findings = findDrift([plan({ dueDate: "2026-12-01" })], [issue({ dueDate: "2026-12-01" })], { now });
      expect(rulesIn(findings)).not.toContain("DATE_CONFLICT");
    });

    test("compares in UTC, so a late-evening offset timestamp on the same UTC day does not conflict", () => {
      const findings = findDrift(
        [plan({ dueDate: "2026-12-01T23:00:00Z" })],
        [issue({ dueDate: "2026-12-01T10:00:00-05:00" })],
        { now },
      );
      expect(rulesIn(findings)).not.toContain("DATE_CONFLICT");
    });

    test("does not fire when either date is missing", () => {
      const noPlanDate = findDrift([plan({ dueDate: null })], [issue({ dueDate: "2026-12-15" })], { now });
      const noIssueDate = findDrift([plan({ dueDate: "2026-12-01" })], [issue({ dueDate: null })], { now });
      expect(rulesIn(noPlanDate)).not.toContain("DATE_CONFLICT");
      expect(rulesIn(noIssueDate)).not.toContain("DATE_CONFLICT");
    });
  });

  describe("NOT_LINKED", () => {
    test("fires when an active item has no Jira keys", () => {
      const findings = findDrift([plan({ jiraKeys: [] })], [], { now });
      expect(rulesIn(findings)).toContain("NOT_LINKED");
    });

    test("does not fire when an active item has a Jira key", () => {
      const findings = findDrift([plan({ jiraKeys: ["ENG-1"] })], [issue()], { now });
      expect(rulesIn(findings)).not.toContain("NOT_LINKED");
    });

    test("does not fire for a not-started item with no keys", () => {
      const findings = findDrift([plan({ statusClass: "not_started", jiraKeys: [] })], [], { now });
      expect(rulesIn(findings)).not.toContain("NOT_LINKED");
    });
  });

  describe("KEY_NOT_FOUND", () => {
    test("fires when an item names a key no issue has", () => {
      const findings = findDrift([plan({ jiraKeys: ["ENG-1", "ENG-404"] })], [issue()], { now });
      const finding = findings.find((f) => f.rule === "KEY_NOT_FOUND");
      expect(finding?.evidence).toEqual([{ id: "PLAN-1", field: "jiraKeys", value: ["ENG-404"] }]);
    });

    test("does not fire when every named key is found", () => {
      const findings = findDrift([plan({ jiraKeys: ["ENG-1"] })], [issue()], { now });
      expect(rulesIn(findings)).not.toContain("KEY_NOT_FOUND");
    });
  });

  test("produces no findings when the data agrees", () => {
    const findings = findDrift(
      [plan({ statusClass: "active", dueDate: "2026-12-01", updatedAt: "2026-11-10T09:00:00Z" })],
      [issue({ statusClass: "active", dueDate: "2026-11-30", updatedAt: "2026-11-10T09:00:00Z" })],
      { now },
    );
    expect(findings).toEqual([]);
  });

  test("missing dates produce no false findings", () => {
    const findings = findDrift(
      [plan({ dueDate: null, updatedAt: null })],
      [issue({ dueDate: null, updatedAt: null })],
      { now },
    );
    expect(findings).toEqual([]);
  });

  test("honours custom staleDays and dueSoonDays", () => {
    const item = [plan({ dueDate: "2026-11-20" })];
    const stale = [issue({ updatedAt: "2026-11-01T00:00:00Z" })];
    expect(rulesIn(findDrift(item, stale, { now, dueSoonDays: 3 }))).not.toContain("DUE_SOON_NO_ACTIVITY");
    expect(rulesIn(findDrift(item, stale, { now, dueSoonDays: 10, staleDays: 14 }))).not.toContain(
      "DUE_SOON_NO_ACTIVITY",
    );
    expect(rulesIn(findDrift(item, stale, { now, dueSoonDays: 10, staleDays: 5 }))).toContain("DUE_SOON_NO_ACTIVITY");
  });
});
