#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { runAudit } from "./audit.js";
import { parseConfigFile } from "./config-file.js";
import { startStdioServer } from "./stdio.js";

// The project has no Node type definitions, so declare the parts of process this file reads.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
};

/** Everything the CLI reads from outside, so a test can pass fakes for each of them. */
export interface CliDeps {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => Date;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  /** Starts the MCP server over stdio and resolves once it is connected. Only `plumbline mcp` calls it. */
  serveMcp: () => Promise<void>;
}

const TOP_USAGE = `Usage: plumbline <command> [options]

Commands:
  audit [--config FILE] [--out FILE]  Print a drift report comparing the monday.com plan with Jira.
  mcp                                 Start the MCP server over stdio for an assistant to use.`;

const MCP_USAGE = `Usage: plumbline mcp

Starts the Plumbline MCP server over stdio, so an assistant can register "plumbline mcp". The monday.com and
Jira settings are read from the environment when the server starts.`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `plumbline mcp`. Help exits before the server starts, so it never reads a setting. */
async function runMcp(args: string[], deps: CliDeps): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    deps.stdout(MCP_USAGE);
    return 0;
  }
  if (args.length > 0) {
    deps.stderr(`Unknown option for plumbline mcp: ${args.join(" ")}\n${MCP_USAGE}`);
    return 1;
  }

  try {
    await deps.serveMcp();
  } catch (error) {
    deps.stderr(`Could not start the MCP server: ${errorText(error)}`);
    return 1;
  }
  return 0;
}

/**
 * Runs the CLI. `mcp` starts the MCP server. Otherwise a `--config FILE` option is read first: its settings override
 * the environment, and any setting the file leaves out comes from the environment. The rest of argv goes to
 * `runAudit`, which validates the settings.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  if (argv[0] === "mcp") return runMcp(argv.slice(1), deps);
  if (argv[0] === "--help" || argv[0] === "-h") {
    deps.stdout(TOP_USAGE);
    return 0;
  }
  if (argv.length === 0) {
    deps.stderr(TOP_USAGE);
    return 1;
  }

  const at = argv.indexOf("--config");
  if (at === -1) return runAudit(argv, deps);

  const file = argv[at + 1];
  if (file === undefined || file === "") {
    deps.stderr("--config needs a file name.\nUsage: plumbline audit [--config FILE] [--out FILE]");
    return 1;
  }

  let env: Record<string, string | undefined>;
  try {
    env = { ...deps.env, ...parseConfigFile(await deps.readFile(file)) };
  } catch (error) {
    deps.stderr(`Could not load config file ${file}: ${errorText(error)}`);
    return 1;
  }
  return runAudit([...argv.slice(0, at), ...argv.slice(at + 2)], { ...deps, env });
}

// Run only when this file is the program being started, not when a test imports it.
const ENTRY = /(^|\/)(cli\.(js|ts)|plumbline)$/;
if (ENTRY.test(process.argv[1] ?? "")) {
  const exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    now: () => new Date(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(`${text}\n`),
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, text) => writeFile(path, text, "utf8"),
    serveMcp: () => startStdioServer(process.env),
  });
  process.exitCode = exitCode;
}
