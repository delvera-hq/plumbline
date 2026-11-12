import { describe, expect, test, vi } from "vitest";
import { assertMondayQuery, type FetchLike, jiraRequest, mondayQuery, readJira, readMonday } from "../src/clients";
import type { MondayOptions } from "../src/monday";

const MONDAY_TOKEN = "mon-secret-token-111";
const JIRA_EMAIL = "dev@example.com";
const JIRA_TOKEN = "jira-secret-token-222";
const BASE_URL = "https://example.atlassian.net";

const env = { MONDAY_TOKEN, JIRA_EMAIL, JIRA_TOKEN };

const mondayOptions: MondayOptions = {
  statusColumnId: "status",
  dateColumnId: "date4",
  linkColumnId: "link",
  statusClasses: { "Working on it": "active", Done: "done" },
};

/** Builds a fake fetch that returns each response in turn. */
function fakeFetch(...responses: Response[]) {
  const fetch = vi.fn<FetchLike>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const mondayItem = (id: string) => ({
  id,
  name: `Item ${id}`,
  updated_at: null,
  url: `https://plan.example/items/${id}`,
  column_values: [
    { id: "status", text: "Done" },
    { id: "date4", text: "" },
    { id: "link", text: "ENG-1" },
  ],
});

const firstPage = (cursor: string | null, ids: string[]) => ({
  data: { boards: [{ items_page: { cursor, items: ids.map(mondayItem) } }] },
});

const nextPage = (cursor: string | null, ids: string[]) => ({
  data: { next_items_page: { cursor, items: ids.map(mondayItem) } },
});

const jiraIssue = (key: string) => ({
  key,
  fields: {
    status: { name: "To Do", statusCategory: { key: "new" } },
    duedate: null,
    updated: null,
  },
});

/** The JSON body of the nth call the fake fetch received. */
function bodyOf(fetch: ReturnType<typeof fakeFetch>, call: number): { query?: string; nextPageToken?: string } {
  return JSON.parse(String(fetch.mock.calls[call]?.[1]?.body));
}

describe("monday.com reads are always GraphQL queries", () => {
  test("sends a query with the token in the Authorization header", async () => {
    const fetch = fakeFetch(json(firstPage(null, ["1"])));
    await mondayQuery("query { boards(ids: [1]) { id } }", {}, { fetch, env });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: MONDAY_TOKEN });
    expect(bodyOf(fetch, 0).query).toBe("query { boards(ids: [1]) { id } }");
  });

  test.each([
    ["a mutation", 'mutation { create_item(board_id: 1, item_name: "x") { id } }'],
    ["a mutation after a query", "query { boards { id } } mutation { delete_item(item_id: 1) { id } }"],
    ["a lower-case mutation keyword", "mutation{ change_column_value(item_id: 1) { id } }"],
    ["a subscription", "subscription { changed_item { id } }"],
    ["a document that does not start with query", "fragment F on Board { id } { boards { id } }"],
    ["a mutation hidden after a comment", 'query { me { id } } # "\nmutation { delete_item(item_id: 1) { id } } # "'],
    ["a mutation in a block string", 'query { me { id } } """\nmutation { delete_item(item_id: 1) { id } }\n"""'],
    ["a mutation after a comment", "query { me { id } } # hidden\nmutation { delete_item(item_id: 1) { id } }"],
    ["two queries in one document", "query { boards { id } } query { me { id } }"],
    ["a lone mutation", "mutation { delete_item(item_id: 1) { id } }"],
    ["a string literal", 'query { boards(ids: [1]) { name(format: "plain") } }'],
  ])("refuses %s before sending", async (_label, document) => {
    const fetch = fakeFetch(json(firstPage(null, [])));
    await expect(mondayQuery(document, {}, { fetch, env })).rejects.toThrow("monday.com request refused");
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["a named query with variables", "query Items($boardId: [ID!]!, $limit: Int!) { boards(ids: $boardId) { id } }"],
    ["an unnamed query", "query { boards { id } }"],
    ["a shorthand query", "{ me { id } }"],
    ["a query with a line break", "query {\n  boards(ids: [1]) {\n    id\n  }\n}\n"],
  ])("accepts %s", (_label, document) => {
    expect(() => assertMondayQuery(document)).not.toThrow();
  });

  test("readMonday sends only query documents on every page", async () => {
    const fetch = fakeFetch(json(firstPage("c2", ["1"])), json(nextPage(null, ["2"])));
    await readMonday({ ...mondayOptions, boardId: "42", fetch, env });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (let call = 0; call < 2; call++) {
      expect(bodyOf(fetch, call).query).toMatch(/^query /);
      expect(bodyOf(fetch, call).query).not.toMatch(/mutation|subscription/);
    }
  });
});

describe("readMonday", () => {
  test("follows the cursor across pages until one has none", async () => {
    const fetch = fakeFetch(
      json(firstPage("c2", ["1", "2"])),
      json(nextPage("c3", ["3"])),
      json(nextPage(null, ["4"])),
    );
    const items = await readMonday({ ...mondayOptions, boardId: "42", fetch, env });
    expect(items.map((item) => item.id)).toEqual(["1", "2", "3", "4"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetch, 1)).toMatchObject({ query: expect.stringContaining("next_items_page") });
  });

  test("stops when the cursor repeats instead of looping", async () => {
    const fetch = fakeFetch(json(firstPage("same", ["1"])), json(nextPage("same", ["2"])));
    await expect(readMonday({ ...mondayOptions, boardId: "42", fetch, env })).rejects.toThrow("already sent");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("rate limits stop without retrying", () => {
  test("an HTTP 429 from monday.com throws once with a clear message", async () => {
    const fetch = fakeFetch(new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    const error = await readMonday({ ...mondayOptions, boardId: "42", fetch, env }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "monday.com rate limit reached. Stopped without retrying. Retry after 30 seconds.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a complexity error inside a 200 response stops once", async () => {
    const body = {
      errors: [{ message: "Complexity budget exhausted", extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED" } }],
    };
    const fetch = fakeFetch(json(body));
    await expect(readMonday({ ...mondayOptions, boardId: "42", fetch, env })).rejects.toThrow(
      "monday.com rate limit reached",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("an HTTP 429 from Jira throws once", async () => {
    const fetch = fakeFetch(new Response("", { status: 429 }));
    await expect(readJira({ baseUrl: BASE_URL, jql: "project = ENG", env, fetch })).rejects.toThrow(
      "Jira rate limit reached. Stopped without retrying.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Jira calls are reads only", () => {
  test("a GET is allowed", async () => {
    const fetch = fakeFetch(json({ accountId: "abc" }));
    const result = await jiraRequest("GET", "/rest/api/3/myself", undefined, { baseUrl: BASE_URL, env, fetch });
    expect(result).toEqual({ accountId: "abc" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  test("the POST to the JQL search path is allowed", async () => {
    const fetch = fakeFetch(json({ issues: [], isLast: true }));
    await jiraRequest("POST", "/rest/api/3/search/jql", { jql: "project = ENG" }, { baseUrl: BASE_URL, env, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["a POST that creates an issue", "POST", "/rest/api/3/issue", { fields: {} }],
    ["a PUT to an issue", "PUT", "/rest/api/3/issue/ENG-1", {}],
    ["a PATCH to an issue", "PATCH", "/rest/api/3/issue/ENG-1", {}],
    ["a DELETE of an issue", "DELETE", "/rest/api/3/issue/ENG-1", undefined],
    ["a POST that walks out of the search path", "POST", "/rest/api/3/search/jql/../../issue", {}],
    ["a POST to the search path with a different verb", "PUT", "/rest/api/3/search/jql", {}],
    ["a request to another site", "GET", "https://evil.example/rest/api/3/myself", undefined],
  ])("refuses %s before sending", async (_label, method, path, body) => {
    const fetch = fakeFetch(json({}));
    await expect(jiraRequest(method, path, body, { baseUrl: BASE_URL, env, fetch })).rejects.toThrow(
      "Jira request refused",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("readJira follows nextPageToken and only POSTs to the search path", async () => {
    const fetch = fakeFetch(
      json({ issues: [jiraIssue("ENG-1")], nextPageToken: "t2", isLast: false }),
      json({ issues: [jiraIssue("ENG-2")], isLast: true }),
    );
    const issues = await readJira({ baseUrl: BASE_URL, jql: "project = ENG", env, fetch });
    expect(issues.map((issue) => issue.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(bodyOf(fetch, 1).nextPageToken).toBe("t2");
    for (const call of fetch.mock.calls) {
      expect(call[1]?.method).toBe("POST");
      expect(call[0]).toBe(`${BASE_URL}/rest/api/3/search/jql`);
    }
  });

  test("readJira stops when a page token repeats", async () => {
    const fetch = fakeFetch(
      json({ issues: [], nextPageToken: "same", isLast: false }),
      json({ issues: [], nextPageToken: "same", isLast: false }),
    );
    await expect(readJira({ baseUrl: BASE_URL, jql: "project = ENG", env, fetch })).rejects.toThrow("already sent");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("tokens come only from the environment and never reach an error", () => {
  test("a missing MONDAY_TOKEN is named, and the call is not sent", async () => {
    const fetch = fakeFetch(json(firstPage(null, [])));
    await expect(mondayQuery("query { id }", {}, { fetch, env: {} })).rejects.toThrow("MONDAY_TOKEN is not set");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a missing JIRA_TOKEN is named, and the call is not sent", async () => {
    const fetch = fakeFetch(json({}));
    await expect(
      jiraRequest("GET", "/rest/api/3/myself", undefined, { baseUrl: BASE_URL, env: { JIRA_EMAIL }, fetch }),
    ).rejects.toThrow("JIRA_TOKEN is not set");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("the Jira auth header is Basic with the email and token", async () => {
    const fetch = fakeFetch(json({}));
    await jiraRequest("GET", "/rest/api/3/myself", undefined, { baseUrl: BASE_URL, env, fetch });
    const expected = `Basic ${btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`)}`;
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: expected });
  });

  test("a network failure that echoes the monday token does not show it", async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error(`socket reset while using ${MONDAY_TOKEN}`));
    const error = await mondayQuery("query { id }", {}, { fetch, env }).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(MONDAY_TOKEN);
    expect((error as Error).message).toContain("[redacted]");
  });

  test("a GraphQL error that echoes the monday token does not show it", async () => {
    const fetch = fakeFetch(json({ errors: [{ message: `bad token ${MONDAY_TOKEN}` }] }));
    const error = await mondayQuery("query { id }", {}, { fetch, env }).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(MONDAY_TOKEN);
  });

  test("an HTTP 401 from Jira does not show the email, the token or the auth header", async () => {
    const fetch = fakeFetch(new Response("denied", { status: 401 }));
    const error = await jiraRequest("GET", "/rest/api/3/myself", undefined, { baseUrl: BASE_URL, env, fetch }).catch(
      (e: Error) => e,
    );
    const message = (error as Error).message;
    expect(message).toBe("Jira request failed with HTTP 401");
    expect(message).not.toContain(JIRA_TOKEN);
    expect(message).not.toContain(JIRA_EMAIL);
    expect(message).not.toContain(btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`));
  });

  test("a Jira network failure that echoes the token does not show it", async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error(`refused for ${JIRA_EMAIL} ${JIRA_TOKEN}`));
    const error = await jiraRequest("GET", "/rest/api/3/myself", undefined, { baseUrl: BASE_URL, env, fetch }).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).not.toContain(JIRA_TOKEN);
    expect((error as Error).message).not.toContain(JIRA_EMAIL);
  });
});
