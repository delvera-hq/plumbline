import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadPlan, readConfig } from "./plan";
import { createServer } from "./server";

// The project has no Node type definitions, so declare the parts of process this file reads.
declare const process: { argv: string[]; env: Record<string, string | undefined> };

/**
 * Starts the MCP server over stdio. The configuration is read first, so a missing setting throws before the
 * server accepts requests.
 */
export async function startStdioServer(env: Record<string, string | undefined>): Promise<void> {
  const config = readConfig(env);
  const server = createServer({ load: () => loadPlan(config) });
  await server.connect(new StdioServerTransport());
}

// Run only when this file is the program being started, not when cli.ts imports it.
const ENTRY = /(^|\/)stdio\.(js|ts)$/;
if (ENTRY.test(process.argv[1] ?? "")) {
  await startStdioServer(process.env);
}
