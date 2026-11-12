## What and why
`staleDays` should accept zero, meaning any issue not updated today counts as stale.

## Acceptance criteria
- `isStale(updatedAt, now, 0)` returns true for an issue updated yesterday.
- Negative `staleDays` throws a RangeError.
- A test covers both.
