import { parseArgs } from "node:util";
import type { FetchLike } from "./clients";
import { loadPlan, readConfig } from "./plan";
import { renderDriftReport } from "./report";
import { findDrift } from "./rules";

/** Everything the audit reads from outside: the settings, the network, the clock, and the two outputs. */
export interface AuditDeps {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  now: () => Date;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  writeFile: (path: string, text: string) => Promise<void>;
}

const USAGE = "Usage: plumbline audit [--out FILE]";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `plumbline audit`: loads the plan through the same settings and read-only clients as the MCP server,
 * runs the drift rules, and writes the Markdown report to stdout or to the --out file.
 * Returns the exit code. Drift is not an error, so only usage, settings and request failures return 1.
 */
export async function runAudit(argv: string[], deps: AuditDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { out: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    deps.stderr(`${errorText(error)}\n${USAGE}`);
    return 1;
  }

  const [command, ...rest] = parsed.positionals;
  if (command !== "audit" || rest.length > 0) {
    deps.stderr(USAGE);
    return 1;
  }
  const out = typeof parsed.values.out === "string" ? parsed.values.out : undefined;
  if (out === "") {
    deps.stderr(`--out needs a file name.\n${USAGE}`);
    return 1;
  }

  try {
    const config = readConfig(deps.env);
    const { items, issues } = await loadPlan(config, deps.fetch);
    const report = renderDriftReport(findDrift(items, issues, { now: deps.now() }));
    if (out === undefined) deps.stdout(report);
    else await deps.writeFile(out, report);
    return 0;
  } catch (error) {
    deps.stderr(`plumbline audit failed: ${errorText(error)}`);
    return 1;
  }
}
