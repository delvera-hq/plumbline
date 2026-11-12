# Steps that still need a person

This list is the result of the experiment. Remove a line when a path automates it. Add a line when a run shows a new one.

| Step | Why it needs a person | Added | Removed |
|---|---|---|---|
| Write a task as an issue | No brief intake yet (path 2) | Path 1 | |
| Add the `agent:go` label | No auto-start yet (path 2) | Path 1 | |
| Click merge | Only for PRs that path 4 holds: dependencies, protected paths, data surfaces, new hosts, big changes, or a Critic fail | Path 1 | Path 4, for low-risk PRs |
| Notice a bad live release | A probe checks each release, rolls it back and opens a revert | Path 1 | Path 3 |
| Act on a rollback that isn't confirmed, or a revert that conflicts | The system opens an issue, and a person decides | Path 3 | |
| Create the org, App and vendor accounts | Needs a person's identity and a payment method | Path 1 | |
