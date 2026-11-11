import type { StatusClass, WorkIssue } from "./rules";

/** The fields of a Jira issue that the plan comparison reads. */
export interface JiraIssue {
  key: string;
  fields: {
    status?: { name?: string; statusCategory?: { key?: string } } | null;
    duedate?: string | null;
    updated?: string | null;
  };
}

export interface JiraOptions {
  /** Site root, such as https://example.atlassian.net. Used to build the browse link. */
  baseUrl: string;
}

// Jira's built-in status categories, mapped to the statusClass the comparison uses.
const CATEGORY_CLASSES: Record<string, StatusClass> = {
  new: "not_started",
  indeterminate: "active",
  done: "done",
};

/**
 * Reads a Jira issue into a WorkIssue.
 * A missing duedate or updated becomes null. A missing key, status or category is an error,
 * as is a category Jira does not define.
 */
export function parseJiraIssue(issue: JiraIssue, options: JiraOptions): WorkIssue {
  if (!issue.key) throw new Error("Jira issue has no key");
  const status = issue.fields.status;
  if (!status?.name) throw new Error(`Jira issue ${issue.key} has no status name`);
  const categoryKey = status.statusCategory?.key;
  if (!categoryKey) throw new Error(`Jira issue ${issue.key} has no status category`);
  const statusClass = CATEGORY_CLASSES[categoryKey];
  if (statusClass === undefined) {
    throw new Error(`Jira issue ${issue.key} has unknown status category "${categoryKey}"`);
  }
  return {
    key: issue.key,
    status: status.name,
    statusClass,
    dueDate: issue.fields.duedate || null,
    updatedAt: issue.fields.updated || null,
    url: `${options.baseUrl.replace(/\/$/, "")}/browse/${issue.key}`,
  };
}
