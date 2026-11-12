## What and why
Report a DATE_CONFLICT when a linked Jira issue is due after the plan item.

## Acceptance criteria
- `findDrift` returns a `DATE_CONFLICT` finding when a linked issue's due date is later than the item's due date.
- No finding when the issue is due on or before the item's date.
- A test covers both cases.
