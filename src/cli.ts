#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { runAudit } from "./audit";

// The project has no Node type definitions, so declare the parts of process this file reads.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
};

const exitCode = await runAudit(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  now: () => new Date(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(`${text}\n`),
  writeFile: (path, text) => writeFile(path, text, "utf8"),
});
process.exitCode = exitCode;
