#!/usr/bin/env python3
"""Path 4. Decides, with no LLM, whether an agent PR is low risk enough for the Critic and auto-merge.

It reads only GitHub's record of the PR: its metadata, its file list with patches, and a count of recent
automatic reverts. It never runs PR code. Anything it can't read, or doesn't recognize, means hold.

Usage: risk.py --pr pr.json --files files.json --reverts N [--known-hosts "a.com b.com"] [--max-lines 300]
Prints JSON: {"eligible": bool, "reasons": [...]}. Exit 0 always, unless the input is unreadable.
"""
import argparse
import importlib.util
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
# The publish gate's list of protected paths. Loaded by path, as -I keeps this folder off sys.path.
_spec = importlib.util.spec_from_file_location("path_gate", HERE / "path_gate.py")
path_gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(path_gate)

DEPENDENCY_FILES = {"package.json", "pnpm-lock.yaml"}
REVERT_BREAKER = 2  # Automatic reverts merged in the last 7 days that pause auto-merge (F-42).

# C4, the data-surface check. Each pattern runs on added lines only, case-insensitive.
SURFACES = [
    ("a form", r"<form\b"),
    ("a field for personal data", r"<input\b[^>]*\btype\s*=\s*[\"']?(email|password|tel)\b"),
    ("a mailto link", r"mailto:"),
    ("a payment provider", r"\b(stripe|paypal|braintree|squareup|paddle|lemonsqueezy|adyen|razorpay|mollie)\b"),
    ("tracking or analytics", r"googletagmanager|google-analytics|\bgtag\(|plausible\.io|posthog|segment\.(com|io)|mixpanel|hotjar|connect\.facebook\.net|clarity\.ms"),
    ("a script or frame from another site", r"<(script|iframe)\b[^>]*\bsrc\s*=\s*[\"']?(https?:)?//"),
    ("a cookie or browser storage", r"document\.cookie|localStorage\.setItem|sessionStorage\.setItem"),
    ("a secret-shaped value", r"AKIA[0-9A-Z]{16}|\bsk-(ant-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_|\bxox[abpr]-|-----BEGIN [A-Z ]*PRIVATE KEY"),
]
SURFACE_RES = [(name, re.compile(rx, re.I)) for name, rx in SURFACES]
URL = re.compile(r"https?://([A-Za-z0-9.-]+)", re.I)
SAFE_HOSTS = re.compile(r"(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.example|localhost|127\.0\.0\.1)$", re.I)
TEST_PATH = path_gate.TEST_FILE


def added_lines(patch: str):
    for line in patch.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            yield line[1:]


def assess(pr: dict, files: list, reverts: int, known_hosts: set, max_lines: int) -> tuple[bool, list[str]]:
    reasons = []
    head = (pr.get("head") or {}).get("ref", "")
    user = pr.get("user") or {}
    # These decide whether path 4 applies at all. A person's PR is never auto-merged.
    if not head.startswith("agent/"):
        reasons.append("not an agent branch")
    if user.get("type") != "Bot":
        reasons.append("not opened by the App")
    if pr.get("draft"):
        reasons.append("draft")
    if pr.get("state") != "open":
        reasons.append(f"PR is {pr.get('state')}")
    if (pr.get("base") or {}).get("ref") != "main":
        reasons.append("base isn't main")
    if reverts >= REVERT_BREAKER:
        reasons.append(f"auto-merge paused: {reverts} automatic reverts in the last 7 days")

    if not files:
        reasons.append("no files listed")
    total = 0
    for f in files:
        name = f.get("filename", "")
        total += int(f.get("additions", 0)) + int(f.get("deletions", 0))
        names = [name] + ([f["previous_filename"]] if f.get("previous_filename") else [])
        for n in names:
            if path_gate.FORBIDDEN.search(n):
                reasons.append(f"{n}: protected path")
            if n.rsplit("/", 1)[-1] in DEPENDENCY_FILES:
                reasons.append(f"{n}: dependencies changed")
        if f.get("status") == "removed":
            continue
        patch = f.get("patch")
        if patch is None:
            # GitHub leaves out the patch for binaries and very large files. Unseen means unreviewed.
            reasons.append(f"{name}: no patch to review")
            continue
        for line in added_lines(patch):
            for label, rx in SURFACE_RES:
                if rx.search(line):
                    reasons.append(f"{name}: adds {label}")
            if not TEST_PATH.search(name):
                for host in URL.findall(line):
                    host = host.lower().rstrip(".")
                    if host not in known_hosts and not SAFE_HOSTS.search(host):
                        reasons.append(f"{name}: adds a link or call to {host}")
    if total > max_lines:
        reasons.append(f"{total} changed lines, over {max_lines}")
    return (not reasons, sorted(set(reasons), key=reasons.index))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr", required=True)
    parser.add_argument("--files", required=True)
    parser.add_argument("--reverts", type=int, required=True)
    parser.add_argument("--known-hosts", default="")
    parser.add_argument("--max-lines", type=int, default=300)
    args = parser.parse_args()
    pr = json.loads(pathlib.Path(args.pr).read_text())
    files = json.loads(pathlib.Path(args.files).read_text())
    if files and isinstance(files[0], list):  # gh api --paginate --slurp gives a list of pages.
        files = [f for page in files for f in page]
    hosts = {h.lower() for h in args.known_hosts.split()}
    eligible, reasons = assess(pr, files, args.reverts, hosts, args.max_lines)
    print(json.dumps({"eligible": eligible, "reasons": reasons}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
