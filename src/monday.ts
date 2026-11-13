import type { PlanItem, StatusClass } from "./rules.js";

export interface MondayOptions {
  /** Column IDs for the three columns the plan reads. */
  statusColumnId: string;
  dateColumnId: string;
  linkColumnId: string;
  /** Maps each status label on the board to a statusClass. A label not listed here is an error. */
  statusClasses: Record<string, StatusClass>;
}

export interface MondayColumnValue {
  id: string;
  text?: string | null;
}

export interface MondayItem {
  id: string;
  name: string;
  updated_at?: string | null;
  url?: string | null;
  column_values?: MondayColumnValue[];
}

export interface MondayResponse {
  data?: {
    boards?: { items_page?: { cursor?: string | null; items?: MondayItem[] } }[];
  };
}

export interface MondayPage {
  items: PlanItem[];
  cursor: string | null;
}

// A Jira key: an uppercase project prefix, a dash, then a number. Matched anywhere in the link text.
const JIRA_KEY = /[A-Z][A-Z0-9]+-\d+/g;

/** Trims a column's text, returning null when the column is missing or blank. */
function textOf(item: MondayItem, columnId: string): string | null {
  const text = item.column_values?.find((column) => column.id === columnId)?.text?.trim();
  return text ? text : null;
}

/** Finds the unique Jira keys in a link column's text, in the order they first appear. */
export function jiraKeysIn(text: string | null): string[] {
  return [...new Set(text?.match(JIRA_KEY) ?? [])];
}

/**
 * Reads one page of items from a monday.com items_page response.
 * Throws when the response has no board or items_page, or a status label has no mapping.
 */
export function parseMondayPage(response: MondayResponse, options: MondayOptions): MondayPage {
  const page = response.data?.boards?.[0]?.items_page;
  if (!page) throw new Error("monday.com response has no board items_page");

  const items = (page.items ?? []).map((item): PlanItem => {
    const status = textOf(item, options.statusColumnId);
    if (status === null) throw new Error(`monday.com item ${item.id} has no status label`);
    const statusClass = options.statusClasses[status];
    if (statusClass === undefined) {
      throw new Error(`monday.com item ${item.id} has unmapped status label "${status}"`);
    }
    return {
      id: item.id,
      name: item.name,
      status,
      statusClass,
      dueDate: textOf(item, options.dateColumnId),
      updatedAt: item.updated_at ?? null,
      url: item.url ?? "",
      jiraKeys: jiraKeysIn(textOf(item, options.linkColumnId)),
    };
  });

  return { items, cursor: page.cursor ?? null };
}
