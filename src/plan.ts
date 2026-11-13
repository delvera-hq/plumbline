import { z } from "zod";
import { type FetchLike, readJira, readMonday } from "./clients.js";
import type { MondayOptions } from "./monday.js";
import type { PlanData } from "./server.js";

const Config = z.object({
  MONDAY_BOARD_ID: z.string().min(1),
  MONDAY_STATUS_COLUMN: z.string().min(1),
  MONDAY_DATE_COLUMN: z.string().min(1),
  MONDAY_LINK_COLUMN: z.string().min(1),
  /** A JSON object mapping each monday.com status label to done, active or not_started. */
  MONDAY_STATUS_CLASSES: z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "MONDAY_STATUS_CLASSES is not JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.enum(["done", "active", "not_started"]))),
  JIRA_BASE_URL: z.url(),
});

// Jira accepts long key lists, but a shorter JQL keeps each request small.
const JIRA_KEYS_PER_QUERY = 50;

export interface PlumblineConfig {
  boardId: string;
  baseUrl: string;
  monday: MondayOptions;
  env: Record<string, string | undefined>;
}

/** Reads the configuration from the environment. A missing or invalid setting throws a message that names it. */
export function readConfig(env: Record<string, string | undefined>): PlumblineConfig {
  const parsed = Config.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Plumbline is not configured: ${problems.join("; ")}`);
  }
  const config = parsed.data;
  const monday: MondayOptions = {
    statusColumnId: config.MONDAY_STATUS_COLUMN,
    dateColumnId: config.MONDAY_DATE_COLUMN,
    linkColumnId: config.MONDAY_LINK_COLUMN,
    statusClasses: config.MONDAY_STATUS_CLASSES,
  };
  return { boardId: config.MONDAY_BOARD_ID, baseUrl: config.JIRA_BASE_URL, monday, env };
}

/** Reads the board, then the Jira issues its links name. Both are read-only. */
export async function loadPlan(config: PlumblineConfig, fetch: FetchLike = globalThis.fetch): Promise<PlanData> {
  const items = await readMonday({
    ...config.monday,
    boardId: config.boardId,
    env: config.env,
    fetch,
  });
  const keys = [...new Set(items.flatMap((item) => item.jiraKeys))];

  const issues: PlanData["issues"] = [];
  for (let i = 0; i < keys.length; i += JIRA_KEYS_PER_QUERY) {
    const chunk = keys.slice(i, i + JIRA_KEYS_PER_QUERY);
    issues.push(
      ...(await readJira({
        jql: `key in (${chunk.join(",")})`,
        baseUrl: config.baseUrl,
        env: config.env,
        fetch,
      })),
    );
  }
  return { items, issues };
}
