#!/usr/bin/env python3
"""Joins run-log events into the weekly summary. Prints Markdown. Standard library only.

It reads event.v1 events and the flat events from before them. Old names map to new ones through ALIASES, which must
match the aliases in delvera-hq/org-standards (test.sh checks this). Touches are counted from the GitHub API with `gh`.
Run with --no-touches to skip that, for example in a test.
"""
import argparse
import json
import pathlib
import statistics
import subprocess
from datetime import datetime, timedelta, timezone


def stamp(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


# Old name -> registered name, for events and data fields. The same aliases are in org-standards.
ALIASES = {"agent_finished": "agent.finished", "pr_closed": "pr.closed", "review": "pr.reviewed",
           "brief_planned": "brief.planned", "deployed": "deploy.finished"}
FIELD_ALIASES = {"critic_cost_usd_est": "cost_usd_est", "planner_cost_usd_est": "cost_usd_est"}


def flatten(doc):
    """One flat dict per event, whatever its format: event, at, run_id, issue (a number), and the data fields."""
    if "type" in doc and isinstance(doc.get("data"), dict):
        corr = doc.get("correlation") or {}
        issue = str(corr.get("issue") or "").rpartition("#")[2]
        flat = {**doc["data"], "event": doc["type"], "at": doc.get("occurred_at"), "run_id": corr.get("run_id"),
                "tenant": corr.get("tenant"), "project": corr.get("project"), "issue": issue, "format": "event.v1"}
    else:
        flat = {FIELD_ALIASES.get(k, k): v for k, v in doc.items()}
        flat["event"] = ALIASES.get(doc.get("event"), doc.get("event"))
        flat["format"] = "legacy"
    if flat.get("pr") is not None:
        flat["pr"] = str(flat["pr"])
    return flat


def load(folder):
    events = []
    for path in sorted(pathlib.Path(folder).rglob("*.json")):
        try:
            doc = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(doc, dict):
            continue
        event = flatten(doc)
        if event.get("event") and event.get("at"):
            events.append(event)
    return events


def by_model(rows):
    """Cost and results per role and model. Events from before path 6 have no model."""
    groups = {}
    for role, e in rows:
        key = (role, e.get("model") or "not recorded")
        g = groups.setdefault(key, {"n": 0, "cost": 0.0, "tin": 0, "tout": 0, "turns": [], "results": {}})
        g["n"] += 1
        g["cost"] += float(e.get("cost_usd_est") or 0)
        g["tin"] += int(e.get("tokens_in") or 0)
        g["tout"] += int(e.get("tokens_out") or 0)
        if e.get("turns"):
            g["turns"].append(int(e["turns"]))
        result = e.get("result", "unknown")
        g["results"][result] = g["results"].get(result, 0) + 1
    lines = ["| Role | Model | Calls | Results | Estimated cost | Tokens in / out | Median turns |", "|---|---|---|---|---|---|---|"]
    for (role, model), g in sorted(groups.items()):
        results = ", ".join(f"{k}: {v}" for k, v in sorted(g["results"].items()))
        turns = f"{statistics.median(g['turns']):g}" if g["turns"] else "n/a"
        lines.append(f"| {role} | {model} | {g['n']} | {results} | ${g['cost']:.2f} | {g['tin']:,} / {g['tout']:,} | {turns} |")
    return lines


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


def summarize(events, since, touch_fn=None, extra=""):
    runs = [e for e in events if e["event"] == "agent.finished" and stamp(e["at"]) >= since]
    closed = {e.get("run_id"): e for e in events if e["event"] == "pr.closed" and e.get("run_id")}
    deploys = {e.get("sha"): e for e in events if e["event"] == "deploy.finished"}
    recent_deploys = [e for e in events if e["event"] == "deploy.finished" and stamp(e["at"]) >= since]
    reviews = [e for e in events if e["event"] == "pr.reviewed" and stamp(e["at"]) >= since]
    briefs = [e for e in events if e["event"] == "brief.planned" and stamp(e["at"]) >= since]
    planner_cost = sum(float(e.get("cost_usd_est") or 0) for e in briefs)
    critic_cost = sum(float(e.get("cost_usd_est") or 0) for e in reviews)
    held_reasons = {}
    for e in reviews:
        if e.get("result") == "held":
            for reason in e.get("reasons") or ["no reason recorded"]:
                key = reason.split(": ", 1)[-1] if reason.startswith(("src/", "public/", "tests/")) else reason
                held_reasons[key] = held_reasons.get(key, 0) + 1

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
        f"| Auto-merged by path 4 | {sum(e.get('result') == 'auto_merged' for e in reviews)}, held for a Director: {sum(e.get('result') == 'held' for e in reviews)} |",
        f"| Briefs planned by path 2 | {sum(e.get('result') == 'planned' for e in briefs)}, into {sum(len(e.get('tasks') or []) for e in briefs)} tasks. Not planned: {sum(e.get('result') != 'planned' for e in briefs)} |",
        f"| LLM spend, client-side estimate | ${cost + critic_cost + planner_cost:.2f}, of which the Critic: ${critic_cost:.2f}, the planner: ${planner_cost:.2f} |",
        f"| Estimated cost per live change | {f'${(cost + critic_cost + planner_cost) / live:.2f}' if live else 'n/a'} |",
        f"| Median hours from agent start to live | {f'{statistics.median(hours):.1f}' if hours else 'n/a'} |",
        f"| Director touches per merged PR | {f'{touch_total / touch_known:.1f}' if touch_known else 'n/a'} |",
    ]
    traced = sum(bool(r.get("trace")) for r in runs)
    lines += [f"| Agent runs with a stored trace | {traced} of {len(runs)} |"]
    critic_calls = [e for e in reviews if e.get("model") or e.get("cost_usd_est")]
    planner_calls = [e for e in briefs if e.get("model") or e.get("cost_usd_est")]
    lines += ["", "**By model:**", ""] + by_model([("agent", r) for r in runs] + [("critic", e) for e in critic_calls] + [("planner", e) for e in planner_calls])
    bad = [e for e in recent_deploys if e.get("result") in ("rollback_failed", "rollback_unverified")]
    if bad:
        lines += ["", f"**Rollback not confirmed:** releases {', '.join(e.get('sha', '?')[:7] for e in bad)}. Check what's live."]
    if held_reasons:
        top = sorted(held_reasons.items(), key=lambda kv: -kv[1])[:5]
        lines += ["", "**Why PRs were held:** " + "; ".join(f"{k} ({v})" for k, v in top) + "."]
    if no_touch:
        lines += ["", f"**Merged with no recorded Director touch:** PRs {', '.join(f'#{n}' for n in no_touch)}. A Director's label should start every run, so check these: an App token may have started or merged them."]
    lines += ["", extra.strip() or "**Event check (event.v1):** didn't run."]
    lines += ["", "Cost is Claude Code's estimate. Compare it with Console spend now and then: a large gap can mean a stolen key.", "", "Optional: reply with your rough Director minutes this week. It's fine to skip."]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", required=True)
    parser.add_argument("--repo", default="")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--no-touches", action="store_true")
    parser.add_argument("--extra", default="", help="a Markdown file to add, such as the event check's report")
    args = parser.parse_args()
    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    touch_fn = None if args.no_touches else (lambda pr, issue: touches(args.repo, pr, issue))
    extra = pathlib.Path(args.extra).read_text() if args.extra and pathlib.Path(args.extra).is_file() else ""
    print(summarize(load(args.events), since, touch_fn, extra))


if __name__ == "__main__":
    main()
