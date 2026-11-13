# Steps that still need a person

This list is the result of the experiment. Remove a line when a path automates it. Add a line when a run shows a new one.

| Step | Why it needs a person | Added | Removed |
|---|---|---|---|
| Write a task as an issue | The planner writes the tasks from a brief | Path 1 | Path 2 |
| Add the `agent:go` label | The brief chain starts each task | Path 1 | Path 2 |
| Write a brief, and label it `brief` | Only a Director's brief starts work. Later, path 10 takes briefs from other sources | Path 2 | |
| Click merge | Only for PRs that path 4 holds: dependencies, protected paths, data surfaces, new hosts, big changes, or a Critic fail. The host check also holds an example URL in plain text, such as `https://example.atlassian.net` in a docs page | Path 1 | Path 4, for low-risk PRs |
| Notice a bad live release | A probe checks each release, rolls it back and opens a revert | Path 1 | Path 3 |
| Act on a rollback that isn't confirmed, or a revert that conflicts | The system opens an issue, and a person decides | Path 3 | |
| Create the org, App and vendor accounts | Needs a person's identity and a payment method | Path 1 | |
| Add or rename a name: an event field, label, topic or project value | The names check fails until the entry is in `delvera-hq/org-standards`, and only a Director can publish it. That's on purpose: a name is a decision. Run `bootstrap/path-11/setup.sh` with a new `STANDARDS_TAG` | Path 11 | |
| Set up a new shared repo, its access and its rulesets | Needs an org admin. `bootstrap/path-11/setup.sh` did it for `org-standards` in one run | Path 11 | |
| Write an idea, and label it `idea` | Only a Director's idea starts research. Later, path 10 takes ideas from other sources | Path 12 | |
| Grade each idea report, then a sample after the first 10 | The grades are the human labels that the checks and scores are calibrated against | Path 12 | |
| Approve, park or stop an idea | Agents propose, plain code checks, and the Directors decide | Path 12 | |
| Add a second model provider's key | Both researchers are Claude until then, and one family's models share mistakes. Creating the account needs a person | Path 12 | |
| Keep the never-list and North Star summary in `portfolio/limits.yaml` the same as `NORTHSTAR.md` | It's a copy. A later path can read the North Star directly | Path 12 | |
| Read a trace to find why a run failed | Traces are kept from path 6. Nothing reads them yet. Path 9 will | Path 6 | |
