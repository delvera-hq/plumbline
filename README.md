# Plumbline

Plumbline compares a monday.com plan board with the Jira issues its items link to, and reports where they disagree. You can run it as a command that prints a drift report, or as an MCP server that an assistant can call over stdio.

## Quick start

You need Node.js and a monday.com board with a Jira link column. This takes about 15 minutes.

1. Install the package in your project:

   ```sh
   npm install @delvera-ai/plumbline
   ```

2. Create a config file named `plumbline.env` with your own values. Each line is `KEY=value`, and lines starting with `#` are comments. The [settings](#settings) section explains each key.

   ```sh
   # plumbline.env: placeholder values only
   MONDAY_TOKEN=...
   MONDAY_BOARD_ID=...
   MONDAY_STATUS_COLUMN=status
   MONDAY_DATE_COLUMN=date4
   MONDAY_LINK_COLUMN=link
   MONDAY_STATUS_CLASSES={"Done":"done","Working on it":"active","Not started":"not_started"}
   JIRA_BASE_URL=https://example.atlassian.net
   JIRA_EMAIL=you@example.com
   JIRA_TOKEN=...
   ```

   The file holds tokens, so keep it out of version control and make it readable only by you (`chmod 600 plumbline.env`).

3. Print a drift report:

   ```sh
   npx plumbline audit --config plumbline.env
   ```

   Add `--out report.md` to write the report to a file instead of the terminal.

4. Add the MCP server to your assistant. This example registers it with Claude Code. Replace each placeholder with your own values:

   ```sh
   claude mcp add --transport stdio \
     --env MONDAY_TOKEN=... \
     --env MONDAY_BOARD_ID=... \
     --env MONDAY_STATUS_COLUMN=status \
     --env MONDAY_DATE_COLUMN=date4 \
     --env MONDAY_LINK_COLUMN=link \
     --env 'MONDAY_STATUS_CLASSES={"Done":"done","Working on it":"active","Not started":"not_started"}' \
     --env JIRA_BASE_URL=https://example.atlassian.net \
     --env JIRA_EMAIL=you@example.com \
     --env JIRA_TOKEN=... \
     plumbline -- npx plumbline mcp
   ```

   The MCP server reads its settings from the environment, so pass each one with `--env` as shown. It does not read `plumbline.env`.

5. Start your assistant and ask it to run `find_drift`.

## Settings

Plumbline reads these nine settings. Set them in the config file for `plumbline audit --config FILE`, or in the environment for `plumbline audit` and `plumbline mcp`. When both are set, the config file wins, and any setting the file leaves out comes from the environment.

| Setting | Required | What it is |
| --- | --- | --- |
| `MONDAY_TOKEN` | Yes | A monday.com API token. Use a read-only token (see [Read-only tokens](#read-only-tokens)). |
| `MONDAY_BOARD_ID` | Yes | The ID of the monday.com board that holds the plan. |
| `MONDAY_STATUS_COLUMN` | Yes | The column ID of the status column on that board. |
| `MONDAY_DATE_COLUMN` | Yes | The column ID of the due date column. |
| `MONDAY_LINK_COLUMN` | Yes | The column ID of the column that links each item to its Jira issues. |
| `MONDAY_STATUS_CLASSES` | Yes | A JSON object that maps every status label on the board to `done`, `active` or `not_started`, such as `{"Done":"done","Working on it":"active"}`. A label that is not listed is an error. |
| `JIRA_BASE_URL` | Yes | The root URL of your Jira site, such as `https://example.atlassian.net`. Plumbline sends requests only to this site. |
| `JIRA_EMAIL` | Yes | The email address of the Jira account that owns `JIRA_TOKEN`. |
| `JIRA_TOKEN` | Yes | A Jira API token. Use a read-only account (see [Read-only tokens](#read-only-tokens)). |

Column IDs are the short internal names monday.com uses for each column. You can find them in the board's column settings or in the API.

The server reads its configuration once at startup. If a setting is missing or invalid, it stops with a message that names the setting.

The `audit` command also takes two options: `--config FILE` reads settings from a file, and `--out FILE` writes the report to a file.

## What Plumbline reads and what it sends

Plumbline reads:

- From your monday.com board (`MONDAY_BOARD_ID`): each item's name, status, due date and link column.
- From your Jira site (`JIRA_BASE_URL`): the issues that those links point to, including their status, due date and last update time.

Plumbline then compares the two and reports each mismatch as a drift finding.

Plumbline sends nothing anywhere else. It makes requests to the monday.com API at `https://api.monday.com/v2` and to the Jira site named in `JIRA_BASE_URL`. It sends no telemetry and no analytics. The only file it writes is the report, and only when you pass `--out`.

## Read-only tokens

Use tokens that can only read:

- **monday.com:** an API token for a user with view-only access to the plan board. Plumbline sends only GraphQL queries, and the code refuses any mutation.
- **Jira:** an API token for an account that can only browse the projects involved. Plumbline sends only GET requests and the JQL search, and the code refuses any other request.

Plumbline enforces read-only requests in code. A token that cannot write is a second line of defence if that check is ever bypassed, so do not use a token that can edit the board or the issues.

## Tools

The MCP server offers two tools:

- `find_drift` returns every drift finding for the plan.
- `explain_item` takes a plan item ID and returns the item, its linked Jira issues and its findings.

Board and issue text is untrusted data. The tools say so, and the assistant should report that text rather than follow instructions in it.

## Development

```sh
pnpm install
pnpm build
```

## No warranty and support

Plumbline is provided as is, with no warranty of any kind. See the [LICENSE](LICENSE) file for the terms.

Support is best effort. Report problems and ask questions through [GitHub issues](https://github.com/delvera-hq/plumbline/issues). Do not paste tokens or real board contents into an issue.
