import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadPlan, readConfig } from "./plan";
import { createServer } from "./server";

// The project has no Node type definitions, so declare the one part of process this file reads.
declare const process: { env: Record<string, string | undefined> };

/** Reads the configuration once at startup, so a missing setting stops the server before it accepts requests. */
const config = readConfig(process.env);
const server = createServer({ load: () => loadPlan(config) });
await server.connect(new StdioServerTransport());
