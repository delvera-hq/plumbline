#!/usr/bin/env python3
"""Joins run-log events into the weekly summary. Prints Markdown. Standard library only.

Touches are counted from the GitHub API with `gh`. Run with --no-touches to skip that, for example in a test.
"""
import argparse
import json
import pathlib
import statistics
import subprocess
from datetime import datetime, timedelta, timezone


def stamp(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def load(folder):
    events = []
    for path in sorted(pathlib.Path(folder).rglob("*.json")):
        try:
            event = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(event, dict) and event.get("event") and event.get("at"):
            events.append(event)
    return events


ROLLED = ("rolled_back", "rollback_failed", "rollback_unverified")


def human(login):
    return bool(login) and not login.endswith("[bot]")


def gh_json(path):
    out = subprocess.run(["gh", "api", "--paginate", "--slurp", path], check=True, capture_output=True, text=True).stdout
    return [item for page in json.loads(out) for item in page]


def touches(repo, pr, issue):
    """Reviews and comments by people on the PR, plus labels and comments by people on its issue. The merge is added by the caller."""
    count = 0
    count += sum(human((r.get("user") or {}).get("login")) for r in gh_json(f"repos/{repo}/pulls/{pr}/reviews"))
    count += sum(human((c.get("user") or {}).get("login")) for c in gh_json(f"repos/{repo}/issues/{pr}/comments"))
    if issue:
        count += sum(human((c.get("user") or {}).get("login")) for c in gh_json(f"repos/{repo}/issues/{issue}/comments"))
        count += sum(e.get("event") == "labeled" and human((e.get("actor") or {}).get("login")) for e in gh_json(f"repos/{repo}/issues/{issue}/events"))
    return count


def summarize(events, since, touch_fn=None):
    runs = [e for e in events if e["event"] == "agent_finished" and stamp(e["at"]) >= since]
    closed = {e.get("run_id"): e for e in events if e["event"] == "pr_closed" and e.get("run_id")}
    deploys = {e.get("sha"): e for e in events if e["event"] == "deployed"}
    recent_deploys = [e for e in events if e["event"] == "deployed" and stamp(e["at"]) >= since]

    results, cost, merged, live, hours, touch_total, touch_known, no_touch = {}, 0.0, 0, 0, [], 0, 0, []
    for run in runs:
        results[run.get("result", "unknown")] = results.get(run.get("result", "unknown"), 0) + 1
        cost += float(run.get("cost_usd_est") or 0)
        pr = closed.get(run.get("run_id"))
        if not pr or not pr.get("merged"):
            continue
        merged += 1
        deploy = deploys.get(pr.get("sha"))
        if deploy and deploy.get("result") == "ok":
            live += 1
            if run.get("started_at"):
                hours.append((stamp(deploy["at"]) - stamp(run["started_at"])).total_seconds() / 3600)
        if touch_fn:
            count = touch_fn(pr.get("pr"), run.get("issue")) + (1 if human(pr.get("merged_by")) else 0)
            touch_total += count
            touch_known += 1
            if count == 0:
                no_touch.append(pr.get("pr"))

    lines = [
        f"# Weekly run summary, since {since.date()}",
        "",
        "| Measure | Value |",
        "|---|---|",
        f"| Agent runs | {len(runs)} |",
        f"| Run results | {', '.join(f'{k}: {v}' for k, v in sorted(results.items())) or 'none'} |",
        f"| PRs merged | {merged} |",
        f"| Changes live | {live} |",
        f"| Deploys, all causes | {len(recent_deploys)}, of which failed: {sum(e.get('result') != 'ok' for e in recent_deploys)} |",
        f"| Rolled back by the probe | {sum(e.get('result') in ROLLED for e in recent_deploys)}, of which unconfirmed: {sum(e.get('result') in ('rollback_failed', 'rollback_unverified') for e in recent_deploys)} |",
        f"| Automatic revert PRs | {sum(bool(e.get('revert_pr')) and e.get('revert') in ('auto_merge', 'needs_merge') for e in recent_deploys)} |",
        f"| LLM spend, client-side estimate | ${cost:.2f} |",
        f"| Estimated cost per live change | {f'${cost / live:.2f}' if live else 'n/a'} |",
        f"| Median hours from agent start to live | {f'{statistics.median(hours):.1f}' if hours else 'n/a'} |",
        f"| Director touches per merged PR | {f'{touch_total / touch_known:.1f}' if touch_known else 'n/a'} |",
    ]
    bad = [e for e in recent_deploys if e.get("result") in ("rollback_failed", "rollback_unverified")]
    if bad:
        lines += ["", f"**Rollback not confirmed:** releases {', '.join(e.get('sha', '?')[:7] for e in bad)}. Check what's live."]
    if no_touch:
        lines += ["", f"**Merged with no recorded Director touch:** PRs {', '.join(f'#{n}' for n in no_touch)}. Merges come from a person on this path, so check these: an App token may have merged them."]
    lines += ["", "Cost is Claude Code's estimate. Compare it with Console spend now and then: a large gap can mean a stolen key.", "", "Optional: reply with your rough Director minutes this week. It's fine to skip."]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", required=True)
    parser.add_argument("--repo", default="")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--no-touches", action="store_true")
    args = parser.parse_args()
    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    touch_fn = None if args.no_touches else (lambda pr, issue: touches(args.repo, pr, issue))
    print(summarize(load(args.events), since, touch_fn))


if __name__ == "__main__":
    main()
