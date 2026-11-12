import { describe, expect, test } from "vitest";
import { type JiraIssue, parseJiraIssue } from "../src/jira";
import sample from "./fixtures/jira-issue.json";

const options = { baseUrl: "https://example.atlassian.net" };

const issue = (): JiraIssue => structuredClone(sample) as JiraIssue;

describe("parseJiraIssue", () => {
  test("reads every field of the sample issue", () => {
    expect(parseJiraIssue(issue(), options)).toEqual({
      key: "ENG-1",
      status: "In Progress",
      statusClass: "active",
      dueDate: "2026-12-01",
      updatedAt: "2026-11-10T09:00:00.000+0000",
      url: "https://example.atlassian.net/browse/ENG-1",
    });
  });

  test("maps the new category to not_started", () => {
    const copy = issue();
    copy.fields.status = { name: "To Do", statusCategory: { key: "new" } };
    expect(parseJiraIssue(copy, options).statusClass).toBe("not_started");
  });

  test("maps the done category to done", () => {
    const copy = issue();
    copy.fields.status = { name: "Done", statusCategory: { key: "done" } };
    expect(parseJiraIssue(copy, options).statusClass).toBe("done");
  });

  test("errors on a category Jira does not define, and names it", () => {
    const copy = issue();
    copy.fields.status = { name: "Odd", statusCategory: { key: "in-review" } };
    expect(() => parseJiraIssue(copy, options)).toThrow('Jira issue ENG-1 has unknown status category "in-review"');
  });

  test("reads a null duedate as null", () => {
    const copy = issue();
    copy.fields.duedate = null;
    expect(parseJiraIssue(copy, options).dueDate).toBeNull();
  });

  test("reads a missing duedate as null", () => {
    const copy = issue();
    delete copy.fields.duedate;
    expect(parseJiraIssue(copy, options).dueDate).toBeNull();
  });

  test("reads a missing or null updated as null", () => {
    const copy = issue();
    delete copy.fields.updated;
    expect(parseJiraIssue(copy, options).updatedAt).toBeNull();
    copy.fields.updated = null;
    expect(parseJiraIssue(copy, options).updatedAt).toBeNull();
  });

  test("errors when the key is missing", () => {
    const copy = issue();
    (copy as { key: string }).key = "";
    expect(() => parseJiraIssue(copy, options)).toThrow("Jira issue has no key");
  });

  test("errors when the status is missing", () => {
    const copy = issue();
    delete copy.fields.status;
    expect(() => parseJiraIssue(copy, options)).toThrow("Jira issue ENG-1 has no status name");
  });

  test("errors when the status name is missing", () => {
    const copy = issue();
    copy.fields.status = { statusCategory: { key: "new" } };
    expect(() => parseJiraIssue(copy, options)).toThrow("Jira issue ENG-1 has no status name");
  });

  test("errors when the status category is missing", () => {
    const copy = issue();
    copy.fields.status = { name: "In Progress" };
    expect(() => parseJiraIssue(copy, options)).toThrow("Jira issue ENG-1 has no status category");
  });

  test("drops a trailing slash from the base URL when building the link", () => {
    expect(parseJiraIssue(issue(), { baseUrl: "https://example.atlassian.net/" }).url).toBe(
      "https://example.atlassian.net/browse/ENG-1",
    );
  });
});
