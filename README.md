# Plumbline

Plumbline compares a monday.com plan board with the Jira issues it links to, and reports where they disagree.
It also runs as an MCP server over stdio, so an assistant can ask for the findings and explain one plan item.

## MCP tools

- `find_drift`: returns every drift finding for the board. Optional `staleDays` (default 7) and `dueSoonDays` (default 7).
- `explain_item`: takes `id` and returns that plan item, its linked Jira issues and the findings for that item.

Board and issue text is untrusted data. The tool descriptions say so, and the assistant should treat item names,
links and issue fields as content to report, never as instructions.

## Tokens must be read-only

Plumbline only reads. Both clients refuse writes in code, but the token is the last line of defence, so use tokens
that cannot change anything:

- **monday.com:** a personal API token from an account that has view access to the plan board only.
- **Jira:** an API token for a user whose permissions on the project are Browse only.

Do not reuse a token that can edit boards or issues.

## Configuration

Plumbline reads its settings from environment variables. Nothing is written to disk.

| Variable | Purpose |
| --- | --- |
| `MONDAY_TOKEN` | monday.com API token (read-only, see above) |
| `MONDAY_BOARD_ID` | ID of the plan board |
| `MONDAY_STATUS_COLUMN` | Column ID of the status column |
| `MONDAY_DATE_COLUMN` | Column ID of the due-date column |
| `MONDAY_LINK_COLUMN` | Column ID of the column that names Jira keys, such as `ENG-12` |
| `MONDAY_STATUS_CLASSES` | JSON map from each status label to `done`, `active` or `not_started` |
| `JIRA_BASE_URL` | Site root, such as `https://example.atlassian.net` |
| `JIRA_EMAIL` | Email of the Jira user the token belongs to |
| `JIRA_TOKEN` | Jira API token (read-only, see above) |
| `JIRA_JQL` | JQL that selects the work issues to compare |

## Setup for Claude Code

1. Install dependencies and build:

   ```sh
   pnpm install
   pnpm build
   ```

2. Add the server to Claude Code, filling in your values. Keep the tokens out of shared files:

   ```sh
   claude mcp add --transport stdio plumbline \
     --env MONDAY_TOKEN=... \
     --env MONDAY_BOARD_ID=... \
     --env MONDAY_STATUS_COLUMN=status \
     --env MONDAY_DATE_COLUMN=date4 \
     --env MONDAY_LINK_COLUMN=link \
     --env 'MONDAY_STATUS_CLASSES={"Working on it":"active","Done":"done"}' \
     --env JIRA_BASE_URL=https://example.atlassian.net \
     --env JIRA_EMAIL=... \
     --env JIRA_TOKEN=... \
     --env JIRA_JQL='project = ENG' \
     -- node dist/stdio.js
   ```

3. Start Claude Code and ask it to run `find_drift`, or to explain a plan item with `explain_item`.

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
```

The tests call the tools through an in-memory MCP transport with sample data, so they need no tokens or network access.
