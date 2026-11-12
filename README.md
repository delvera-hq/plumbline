# Plumbline

Plumbline compares a monday.com plan board with the Jira issues its items link to, and reports where they disagree. It exposes that comparison to an assistant as an MCP server over stdio.

## Tools

- `find_drift` returns every drift finding for the plan.
- `explain_item` takes a plan item id and returns the item, its linked Jira issues and its findings.

Board and issue text is untrusted data. The tools say so, and the assistant should report that text rather than follow instructions in it.

## Setup for Claude Code

1. Install dependencies and build:

   ```sh
   pnpm install
   pnpm build
   ```

2. Create tokens that can only read:
   - **monday.com:** an API token for a user with view-only access to the plan board. Plumbline only sends GraphQL queries and refuses mutations.
   - **Jira:** an API token for an account that can only browse the projects involved. Plumbline only sends GET requests and the JQL search, and refuses any other request.

   Tokens should be read-only. Plumbline enforces read-only requests in code, but a token that cannot write is the second line of defence if that check is ever bypassed.

3. Register the server with Claude Code, replacing the placeholders:

   ```sh
   claude mcp add --transport stdio \
     --env MONDAY_TOKEN=... \
     --env JIRA_EMAIL=you@example.com \
     --env JIRA_TOKEN=... \
     --env MONDAY_BOARD_ID=... \
     --env MONDAY_STATUS_COLUMN=status \
     --env MONDAY_DATE_COLUMN=date4 \
     --env MONDAY_LINK_COLUMN=link \
     --env 'MONDAY_STATUS_CLASSES={"Done":"done","Working on it":"active","Not started":"not_started"}' \
     --env JIRA_BASE_URL=https://example.atlassian.net \
     plumbline -- node /absolute/path/to/plumbline/dist/stdio.js
   ```

   - `MONDAY_STATUS_CLASSES` maps every status label on the board to `done`, `active` or `not_started`. A label that is not listed is an error.
   - `MONDAY_STATUS_COLUMN`, `MONDAY_DATE_COLUMN` and `MONDAY_LINK_COLUMN` are the monday.com column IDs for status, due date and Jira links.

4. Start Claude Code and ask it to run `find_drift`.

The server reads its configuration once at startup and stops with a message naming any missing or invalid setting.
