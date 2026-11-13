#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { runAudit } from "./audit";
import { parseConfigFile } from "./config-file";

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
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the CLI. A `--config FILE` option is read first: its settings override the environment, and any setting
 * the file leaves out comes from the environment. The rest of argv goes to `runAudit`, which validates the settings.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
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
  });
  process.exitCode = exitCode;
}
