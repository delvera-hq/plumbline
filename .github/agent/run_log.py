#!/usr/bin/env python3
"""Writes run-log records on the run-log branch. Standard library only, plus gh.

Every event goes through `emit`, in the event.v1 envelope, so the name check in delvera-hq/org-standards can read the
type and the fields from the call. Keep each call to plain arguments: --set (string), --int, --num, --bool, --json.
Empty values are left out, so an optional field that has no value is simply absent.

  run_log.py emit --type agent.finished --name STEM [--run-id R] [--issue N] [--attempt N] [--dry-run]
                  [--set k=v] [--int k=v] [--num k=v] [--bool k=v] [--json k=v] ...
  run_log.py put-trace --file trace.jsonl.gz --run-id R --role agent      Prints the trace's path, or nothing.
  run_log.py put-data --file f.json --path portfolio/predictions/idea-7/R.json   Path 12's data. Prints the path.

Needs GH_REPO, GH_TOKEN, TENANT and PROJECT, and the GITHUB_* variables Actions sets. A failed write is a warning,
never a failure: a missing record must not fail the job that did the work.
"""
import argparse
import base64
import json
import os
import pathlib
import secrets
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

BRANCH = "run-log"
MAX_TRACE_BYTES = 25 * 1024 * 1024
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid() -> str:
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    return "".join(CROCKFORD[(value >> (5 * i)) & 31] for i in range(25, -1, -1))


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def put(path: str, content: bytes, message: str) -> bool:
    """Creates one file on the run-log branch. The body goes through a file, as a trace can exceed argv limits."""
    body = {"message": message, "branch": BRANCH, "content": base64.b64encode(content).decode()}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(body, f)
    try:
        subprocess.run(["gh", "api", "-X", "PUT", f"repos/{os.environ['GH_REPO']}/contents/{path}", "--input", f.name],
                       check=True, capture_output=True, text=True)
        return True
    except (OSError, KeyError, subprocess.CalledProcessError) as exc:
        print(f"::warning::Couldn't write {path} to the run log: {getattr(exc, 'stderr', '') or exc}")
        return False
    finally:
        os.unlink(f.name)


def parse_pairs(pairs, kind):
    out = {}
    for pair in pairs or []:
        key, _, value = pair.partition("=")
        if value == "":
            continue
        if kind == "string":
            out[key] = value
        elif kind == "integer":
            out[key] = int(float(value))
        elif kind == "number":
            out[key] = float(value)
        elif kind == "boolean":
            out[key] = value.lower() == "true"
        else:
            out[key] = json.loads(value)
    return out


def build(args) -> dict:
    env = os.environ
    repo = env.get("GH_REPO") or env.get("GITHUB_REPOSITORY", "")
    data = {}
    for flag, kind in (("set", "string"), ("int", "integer"), ("num", "number"), ("bool", "boolean"), ("json", "json")):
        try:
            data.update(parse_pairs(getattr(args, flag), kind))
        except ValueError as exc:  # A bad value is dropped, and the event check reports the missing field.
            print(f"::warning::Bad --{flag} value: {exc}")
    run_id = args.run_id or f"run_{env.get('GITHUB_RUN_ID', '0')}_{env.get('GITHUB_RUN_ATTEMPT', '1')}"
    correlation = {"run_id": run_id, "tenant": env.get("TENANT", "internal"), "project": env.get("PROJECT", "")}
    if args.issue and str(args.issue).isdigit():
        correlation["issue"] = f"{repo}#{args.issue}"
    if args.attempt:
        correlation["attempt"] = int(args.attempt)
    workflow = (env.get("GITHUB_WORKFLOW_REF", "").split("@")[0].rsplit("/", 1)[-1]) or "local"
    producer = {"kind": "controller", "id": f"{repo}/{workflow}:{env.get('GITHUB_JOB', 'local')}"[:200]}
    if env.get("GITHUB_WORKFLOW_REF"):
        producer["workflow_ref"] = env["GITHUB_WORKFLOW_REF"][:300]
    if env.get("GITHUB_RUN_ID", "").isdigit():
        producer["github_run_id"] = env["GITHUB_RUN_ID"]
    return {
        "schema_version": "1.0",
        "event_id": f"evt_{ulid()}",
        "type": args.type,
        "occurred_at": now(),
        "producer": producer,
        "authority": "controller",
        "correlation": correlation,
        "data_schema": f"events/{args.type}.v1",
        "data": data,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("emit")
    e.add_argument("--type", required=True)
    e.add_argument("--name", required=True, help="file name stem, unique per event")
    e.add_argument("--run-id")
    e.add_argument("--issue")
    e.add_argument("--attempt")
    e.add_argument("--dry-run", action="store_true")
    for flag in ("set", "int", "num", "bool", "json"):
        e.add_argument(f"--{flag}", action="append", metavar="KEY=VALUE")
    t = sub.add_parser("put-trace")
    t.add_argument("--file", required=True)
    t.add_argument("--run-id", required=True)
    t.add_argument("--role", required=True, choices=["agent", "critic", "planner", "researcher-a", "researcher-b", "red-team", "judge-1", "judge-2", "judge-3", "pivot"])
    d = sub.add_parser("put-data")
    d.add_argument("--file", required=True)
    d.add_argument("--path", required=True, help="under portfolio/ on the run-log branch")
    args = parser.parse_args()

    if args.cmd == "put-data":
        path = pathlib.Path(args.file)
        remote = args.path.strip("/")
        if not remote.startswith("portfolio/") or ".." in remote.split("/") or not path.is_file():
            print("::warning::put-data writes only an existing file under portfolio/.", file=sys.stderr)
            return 0
        if put(remote, path.read_bytes(), f"data: {remote}"):
            print(remote)
        return 0

    if args.cmd == "put-trace":
        path = pathlib.Path(args.file)
        if not path.is_file() or path.stat().st_size == 0:
            print("::warning::No trace to keep.", file=sys.stderr)
            return 0
        if path.stat().st_size > MAX_TRACE_BYTES:
            print(f"::warning::The trace is {path.stat().st_size} bytes, over {MAX_TRACE_BYTES}. It stays in the run's artifacts only.", file=sys.stderr)
            return 0
        safe = "".join(c for c in args.run_id if c.isalnum() or c == "_")
        remote = f"traces/{now()[:10]}/{safe}-{args.role}.jsonl.gz"
        if put(remote, path.read_bytes(), f"trace: {safe} {args.role}"):
            print(remote)
        return 0

    event = build(args)
    text = json.dumps(event, indent=1) + "\n"
    if args.dry_run:
        print(text, end="")
        return 0
    stem = "".join(c for c in args.name if c.isalnum() or c in "_-.")[:150]
    put(f"events/{event['occurred_at'][:10]}/{stem}.json", text.encode(), f"log: {args.type} {stem}")
    print(f"Wrote {args.type} for {event['correlation']['run_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
