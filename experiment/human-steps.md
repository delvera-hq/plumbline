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
| Start research on an idea from your own Claude Code session | Research runs on the Directors' subscriptions to keep API spend low (path 16). One command: `/delvera:research-idea <number>`. CI checks and scores it with no other step | Path 16 | |
| Set each repo's spend limit in the Anthropic Console | The provider's own limit is the one a bug can't get past. The Admin API can't set it yet | Path 16 | |
| Grade each idea report, then a sample after the first 10 | The grades are the human labels that the checks and scores are calibrated against. A Director without the domain knowledge can pass on a reviewing agent's grade with `by=agent`, which is kept apart | Path 12 | |
| Approve, park or stop an idea | Agents propose, plain code checks, and the Directors decide | Path 12 | |
| Publish a release to npm | Needs the Director's npm login and two-factor code. Run `pnpm install --frozen-lockfile` and `pnpm build` first, then `npm publish --dry-run`, then publish. A new package's first version can show a `0.0.0-stage` placeholder for a few minutes while npm processes it: wait before treating it as staged | Path 12 | |
| Make a repo public | Scan the full history, every file version and the issue and PR text for secrets first, as path 17 requires. Then update it with `copier update --data public=true` in the same hour: a public repo can't use the private org-standards action, so its `names` check fails until it has its pinned copy | Path 12 | |
| Screen a product's name on the trademark registers before its build | Renaming after a build touches the package, repo, docs and users. Plain code checks npm, repos and DNS, but a trademark screen is a judgement. `/delvera:name-idea` and `idea:name` give the links | Path 12 | |
| Set the pass mark and stop date for a test release | `/delvera:release-check` gathers what's left and proposes them. A pass mark set before launch is what stops cold feet and sunk cost alike | Path 12 | |
| Ask for a pivot review of a weak idea, and stop a line that doesn't clear the bar | The weekly report lists candidates, and `idea:pivot` files up to three variants. Stopping is a Director's call, so sunk cost can't keep a line alive | Path 12 | |
| Add a second model family | Both researchers are Claude until then, and one family's models share mistakes. A second provider's assistant on its own subscription can write the same `research.v1` report. Creating the account needs a person | Path 12 | |
| Keep the never-list and North Star summary in `portfolio/limits.yaml` the same as `NORTHSTAR.md` | It's a copy. A later path can read the North Star directly | Path 12 | |
| Read a trace to find why a run failed | Traces are kept from path 6. Nothing reads them yet. Path 9 will | Path 6 | |
