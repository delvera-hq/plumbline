import { type JiraIssue, parseJiraIssue } from "./jira.js";
import { type MondayItem, type MondayOptions, type MondayResponse, parseMondayPage } from "./monday.js";
import type { PlanItem, WorkIssue } from "./rules.js";

/** The part of fetch the clients use. Tests pass a fake; production passes globalThis.fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  fetch: FetchLike;
  /** Where the tokens are read from. Production passes process.env. Only the three token variables are read. */
  env: Record<string, string | undefined>;
}

export interface MondayClientOptions extends ClientOptions {
  /** The GraphQL endpoint. Defaults to monday.com's v2 API. */
  endpoint?: string;
}

export interface MondayReadOptions extends MondayClientOptions, MondayOptions {
  boardId: string;
  /** Items per page. */
  pageSize?: number;
}

export interface JiraClientOptions extends ClientOptions {
  /** Site root, such as https://example.atlassian.net. Requests may only go to this origin. */
  baseUrl: string;
}

export interface JiraReadOptions extends JiraClientOptions {
  jql: string;
  /** Issue fields to request. */
  fields?: string[];
  /** Issues per page. */
  pageSize?: number;
}

const MONDAY_ENDPOINT = "https://api.monday.com/v2";
const JIRA_SEARCH_PATH = "/rest/api/3/search/jql";
const JIRA_FIELDS = ["status", "duedate", "updated"];

const ITEM_FIELDS = "id name updated_at url column_values { id text }";
const FIRST_PAGE = `query ($boardId: [ID!]!, $limit: Int!) {
  boards(ids: $boardId) { items_page(limit: $limit) { cursor items { ${ITEM_FIELDS} } } }
}`;
const NEXT_PAGE = `query ($cursor: String!, $limit: Int!) {
  next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${ITEM_FIELDS} } }
}`;

type ItemsPage = { cursor?: string | null; items?: MondayItem[] };
type MondayPageResponse = { data?: { next_items_page?: ItemsPage } } & MondayResponse;

interface JiraSearchPage {
  issues?: JiraIssue[];
  nextPageToken?: string | null;
  isLast?: boolean;
}

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Builds an error with every secret replaced, so a token never reaches a message. */
function safeError(message: string, secrets: string[]): Error {
  let safe = message;
  for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
  return new Error(safe);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rateLimitMessage(service: string, retryAfter: string | null | undefined): string {
  const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : "";
  return `${service} rate limit reached. Stopped without retrying.${wait}`;
}

/**
 * Refuses any monday.com document that is not a single read. The rules are kept strict on purpose:
 * no comments or string literals (the client sends every value as a variable), no mutation or
 * subscription keyword, and exactly one `query` or `{ ... }` operation whose braces close at the end.
 */
export function assertMondayQuery(document: string): void {
  const refuse = (reason: string) => new Error(`monday.com request refused: ${reason}`);
  if (/[#"]/.test(document)) throw refuse("comments and string literals are not allowed");
  if (/\b(mutation|subscription)\b/i.test(document)) throw refuse("only GraphQL queries are allowed");

  const text = document.trimEnd();
  const open = text.indexOf("{");
  if (open === -1) throw refuse("the document must be a query");
  // Before the body only `query`, an optional name and optional variables may appear.
  if (!/^\s*(query(\s+[A-Za-z_]\w*)?\s*(\([^(){}]*\))?\s*)?$/.test(text.slice(0, open))) {
    throw refuse("the document must be a single query");
  }
  // The body must close exactly at the end, so a second operation cannot follow it.
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}") {
      depth--;
      if (depth === 0 && i !== text.length - 1) throw refuse("the document must be a single query");
    }
  }
  if (depth !== 0) throw refuse("the braces do not close");
}

/** Sends one GraphQL query to monday.com. Refuses anything that is not a query before fetch is called. */
export async function mondayQuery(
  document: string,
  variables: Record<string, unknown>,
  options: MondayClientOptions,
): Promise<MondayResponse> {
  assertMondayQuery(document);
  const token = requireEnv(options.env, "MONDAY_TOKEN");
  const secrets = [token];

  let response: Response;
  try {
    response = await options.fetch(options.endpoint ?? MONDAY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ query: document, variables }),
    });
  } catch (error) {
    throw safeError(`monday.com request failed: ${errorText(error)}`, secrets);
  }
  if (response.status === 429) {
    throw safeError(rateLimitMessage("monday.com", response.headers.get("retry-after")), secrets);
  }
  if (!response.ok) throw safeError(`monday.com request failed with HTTP ${response.status}`, secrets);

  let body: MondayResponse & { errors?: { message?: string; extensions?: { code?: string } }[] };
  try {
    body = await response.json();
  } catch {
    throw safeError("monday.com response was not JSON", secrets);
  }
  // monday.com reports complexity and rate limits as GraphQL errors on an HTTP 200.
  if (body.errors?.some((error) => /RATE|COMPLEXITY/i.test(error.extensions?.code ?? ""))) {
    throw safeError(rateLimitMessage("monday.com", null), secrets);
  }
  if (body.errors?.length) {
    const messages = body.errors.map((error) => error.message ?? "unknown error").join("; ");
    throw safeError(`monday.com returned errors: ${messages}`, secrets);
  }
  return body;
}

/**
 * Reads every item on a monday.com board, following the cursor until it runs out.
 * The first page uses items_page; later pages use next_items_page.
 */
export async function readMonday(options: MondayReadOptions): Promise<PlanItem[]> {
  const limit = options.pageSize ?? 100;
  const items: PlanItem[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  do {
    const response: MondayPageResponse =
      cursor === null
        ? await mondayQuery(FIRST_PAGE, { boardId: [options.boardId], limit }, options)
        : await mondayQuery(NEXT_PAGE, { cursor, limit }, options);
    // Later pages come back under next_items_page, so reshape them to the items_page form the parser reads.
    const page = response.data?.next_items_page
      ? { data: { boards: [{ items_page: response.data.next_items_page }] } }
      : response;
    const parsed = parseMondayPage(page, options);
    items.push(...parsed.items);

    cursor = parsed.cursor;
    if (cursor !== null) {
      if (seen.has(cursor)) throw new Error("monday.com returned a cursor it already sent");
      seen.add(cursor);
    }
  } while (cursor !== null);

  return items;
}

/**
 * Sends one request to Jira. Refuses anything except a GET, or the POST to the JQL search path,
 * and refuses any URL that is not on the configured site, before fetch is called.
 */
export async function jiraRequest(
  method: string,
  path: string,
  body: unknown,
  options: JiraClientOptions,
): Promise<unknown> {
  const verb = method.toUpperCase();
  const url = new URL(path, options.baseUrl);
  if (url.origin !== new URL(options.baseUrl).origin) {
    throw new Error(`Jira request refused: ${url.origin} is not the configured site`);
  }
  const readsOnly = verb === "GET" || (verb === "POST" && url.pathname === JIRA_SEARCH_PATH);
  if (!readsOnly) throw new Error(`Jira request refused: ${verb} ${url.pathname} is not a read`);

  const email = requireEnv(options.env, "JIRA_EMAIL");
  const token = requireEnv(options.env, "JIRA_TOKEN");
  const secrets = [email, token, btoa(`${email}:${token}`)];

  const init: RequestInit = {
    method: verb,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${email}:${token}`)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };

  let response: Response;
  try {
    response = await options.fetch(url.toString(), init);
  } catch (error) {
    throw safeError(`Jira request failed: ${errorText(error)}`, secrets);
  }
  if (response.status === 429) {
    throw safeError(rateLimitMessage("Jira", response.headers.get("retry-after")), secrets);
  }
  if (!response.ok) throw safeError(`Jira request failed with HTTP ${response.status}`, secrets);

  try {
    return await response.json();
  } catch {
    throw safeError("Jira response was not JSON", secrets);
  }
}

/**
 * Reads every issue matching a JQL query, following nextPageToken until Jira says it is the last page.
 * Each page is a POST to the JQL search path, which only reads.
 */
export async function readJira(options: JiraReadOptions): Promise<WorkIssue[]> {
  const issues: WorkIssue[] = [];
  const seen = new Set<string>();
  let nextPageToken: string | undefined;

  for (;;) {
    const body = {
      jql: options.jql,
      maxResults: options.pageSize ?? 100,
      fields: options.fields ?? JIRA_FIELDS,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    };
    const page = (await jiraRequest("POST", JIRA_SEARCH_PATH, body, options)) as JiraSearchPage;
    for (const issue of page.issues ?? []) {
      issues.push(parseJiraIssue(issue, { baseUrl: options.baseUrl }));
    }

    if (page.isLast || !page.nextPageToken) break;
    if (seen.has(page.nextPageToken)) throw new Error("Jira returned a page token it already sent");
    seen.add(page.nextPageToken);
    nextPageToken = page.nextPageToken;
  }

  return issues;
}
