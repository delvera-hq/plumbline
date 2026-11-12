import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readJira, readMonday } from "./clients";
import type { StatusClass } from "./rules";
import { createServer } from "./server";

// The project has no @types/node, so declare the one global this entry point reads.
declare const process: { env: Record<string, string | undefined>; exitCode?: number };

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Starts the MCP server on stdin and stdout. Stdout carries protocol messages, so nothing else may write to it.
// Tokens are read by the clients from MONDAY_TOKEN, JIRA_EMAIL and JIRA_TOKEN. Both clients only read.
async function main(): Promise<void> {
  const env = process.env;
  const monday = {
    env,
    fetch: globalThis.fetch,
    boardId: required(env, "MONDAY_BOARD_ID"),
    statusColumnId: required(env, "MONDAY_STATUS_COLUMN"),
    dateColumnId: required(env, "MONDAY_DATE_COLUMN"),
    linkColumnId: required(env, "MONDAY_LINK_COLUMN"),
    statusClasses: JSON.parse(required(env, "MONDAY_STATUS_CLASSES")) as Record<string, StatusClass>,
  };
  const jira = {
    env,
    fetch: globalThis.fetch,
    baseUrl: required(env, "JIRA_BASE_URL"),
    jql: required(env, "JIRA_JQL"),
  };

  const server = createServer({
    source: {
      loadPlan: () => readMonday(monday),
      loadIssues: () => readJira(jira),
    },
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
