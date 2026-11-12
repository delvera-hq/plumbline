import { describe, expect, test } from "vitest";
import { jiraKeysIn, type MondayOptions, type MondayResponse, parseMondayPage } from "../src/monday";
import sample from "./fixtures/monday-items.json";

const options: MondayOptions = {
  statusColumnId: "status",
  dateColumnId: "date4",
  linkColumnId: "link",
  statusClasses: { "Working on it": "active", Done: "done", "Not started": "not_started" },
};

const response = (): MondayResponse => structuredClone(sample) as MondayResponse;

/** Returns the first sample item with the given columns and item fields replaced or removed. */
function withItem(patch: (item: Record<string, unknown>) => void): MondayResponse {
  const copy = response();
  const item = copy.data?.boards?.[0]?.items_page?.items?.[0] as Record<string, unknown>;
  patch(item);
  return copy;
}

describe("parseMondayPage", () => {
  test("reads every field of an item from the sample page", () => {
    const page = parseMondayPage(response(), options);
    expect(page.cursor).toBe("example-cursor-2");
    expect(page.items[0]).toEqual({
      id: "9001",
      name: "Example plan item one",
      status: "Working on it",
      statusClass: "active",
      dueDate: "2026-12-01",
      updatedAt: "2026-11-10T09:00:00Z",
      url: "https://plan.example/items/9001",
      jiraKeys: ["ENG-1", "ENG-2"],
    });
  });

  test("maps a Done label to the done statusClass", () => {
    const page = parseMondayPage(response(), options);
    expect(page.items[1]?.statusClass).toBe("done");
  });

  test("uses the column IDs and status map from the options, not fixed names", () => {
    const copy = response();
    const items = copy.data?.boards?.[0]?.items_page?.items ?? [];
    for (const item of items) {
      for (const column of item.column_values ?? []) {
        column.id = `renamed-${column.id}`;
      }
    }
    const renamed = parseMondayPage(copy, {
      statusColumnId: "renamed-status",
      dateColumnId: "renamed-date4",
      linkColumnId: "renamed-link",
      statusClasses: { "Working on it": "not_started", Done: "done" },
    });
    expect(renamed.items[0]).toMatchObject({
      statusClass: "not_started",
      dueDate: "2026-12-01",
      jiraKeys: ["ENG-1", "ENG-2"],
    });
  });

  test("names the label when a status is not in the map", () => {
    expect(() => parseMondayPage(response(), { ...options, statusClasses: { Done: "done" } })).toThrow(
      'monday.com item 9001 has unmapped status label "Working on it"',
    );
  });

  test("does not guess a statusClass for a label whose case differs", () => {
    expect(() => parseMondayPage(response(), { ...options, statusClasses: { "working on it": "active" } })).toThrow(
      'unmapped status label "Working on it"',
    );
  });

  test("errors when an item has no status label", () => {
    const missing = withItem((item) => {
      item.column_values = [{ id: "date4", text: "2026-12-01" }];
    });
    expect(() => parseMondayPage(missing, options)).toThrow("monday.com item 9001 has no status label");
  });

  test("errors when the status text is blank", () => {
    const blank = withItem((item) => {
      item.column_values = [{ id: "status", text: "   " }];
    });
    expect(() => parseMondayPage(blank, options)).toThrow("monday.com item 9001 has no status label");
  });

  test("errors when the response has no board", () => {
    expect(() => parseMondayPage({ data: { boards: [] } }, options)).toThrow("has no board items_page");
    expect(() => parseMondayPage({}, options)).toThrow("has no board items_page");
  });

  test("returns a null cursor when the page has none", () => {
    const copy = response();
    const page = copy.data?.boards?.[0]?.items_page as Record<string, unknown>;
    delete page.cursor;
    expect(parseMondayPage(copy, options).cursor).toBeNull();
  });

  test("returns an empty list for a page with no items", () => {
    const copy = response();
    const page = copy.data?.boards?.[0]?.items_page as Record<string, unknown>;
    delete page.items;
    expect(parseMondayPage(copy, options)).toEqual({ items: [], cursor: "example-cursor-2" });
  });

  test("reads a missing due date column as null", () => {
    const noDate = withItem((item) => {
      item.column_values = [{ id: "status", text: "Working on it" }];
    });
    expect(parseMondayPage(noDate, options).items[0]?.dueDate).toBeNull();
  });

  test("reads a blank or null due date as null", () => {
    const page = parseMondayPage(response(), options);
    expect(page.items[1]?.dueDate).toBeNull();
  });

  test("reads a missing updated_at as null", () => {
    const page = parseMondayPage(response(), options);
    expect(page.items[1]?.updatedAt).toBeNull();
    const noUpdated = withItem((item) => {
      delete item.updated_at;
    });
    expect(parseMondayPage(noUpdated, options).items[0]?.updatedAt).toBeNull();
  });

  test("reads a missing url as an empty string", () => {
    const noUrl = withItem((item) => {
      delete item.url;
    });
    expect(parseMondayPage(noUrl, options).items[0]?.url).toBe("");
  });

  test("returns no Jira keys when the link column is null or blank", () => {
    const page = parseMondayPage(response(), options);
    expect(page.items[1]?.jiraKeys).toEqual([]);
    const blank = withItem((item) => {
      item.column_values = [
        { id: "status", text: "Working on it" },
        { id: "link", text: "" },
      ];
    });
    expect(parseMondayPage(blank, options).items[0]?.jiraKeys).toEqual([]);
  });

  test("returns no Jira keys when the link column is missing", () => {
    const noLink = withItem((item) => {
      item.column_values = [{ id: "status", text: "Working on it" }];
    });
    expect(parseMondayPage(noLink, options).items[0]?.jiraKeys).toEqual([]);
  });
});

describe("jiraKeysIn", () => {
  test("finds every key in the text", () => {
    expect(jiraKeysIn("ENG-1 and OPS2-42 and AB-7")).toEqual(["ENG-1", "OPS2-42", "AB-7"]);
  });

  test("returns each key once, in first-seen order", () => {
    expect(jiraKeysIn("ENG-2, ENG-1, ENG-2")).toEqual(["ENG-2", "ENG-1"]);
  });

  test("ignores text that is not a key", () => {
    expect(jiraKeysIn("eng-1 is lowercase, A-1 is too short, ENG- has no number")).toEqual([]);
  });

  test("returns an empty list for null", () => {
    expect(jiraKeysIn(null)).toEqual([]);
  });
});
