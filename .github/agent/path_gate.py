#!/usr/bin/env python3
"""gate/path. Deterministic, no LLM, and it never runs PR code. It only reads git's own record of the change.

SEC-1: an Agent could otherwise define the tests that judge it, for example `"test": "exit 0"` in package.json.
SEC-2: an Agent could otherwise hide its diff from the Critics with a .gitattributes file.
BK-4: it also recognizes a genuine release PR, which needs no paid Critics.

Rules bind any bot except the controller. People are held by code-owner review instead.
Exit 0 pass, 1 fail. Prints pass= and release_pr= for $GITHUB_OUTPUT, and reasons on stderr.
"""
import argparse
import json
import re
import subprocess
import sys

CONTROLLER = "dv-controller[bot]"
RELEASE_FILES = {"CHANGELOG.md", ".release-please-manifest.json", "package.json"}
RELEASE_ONLY = {"CHANGELOG.md", ".release-please-manifest.json"}
RELEASE_BRANCH = "release-please--"

# Files that change what verification does, or what a reviewer sees, at any depth.
FORBIDDEN = re.compile(
    r"(^|/)("
    r"\.github/.*|\.claude/.*|CLAUDE\.md|AGENTS\.md|\.mcp\.json|CODEOWNERS|\.copier-answers\.yml|"
    r"\.gitattributes|\.gitmodules|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.[cm]?js|pnpm-workspace\.yaml|bunfig\.toml|"
    r"biome\.jsonc?|tsconfig[^/]*\.json|vitest\.(config|workspace)\.[^/]+|playwright\.config\.[^/]+|"
    r"\.semgrepignore|\.semgrep[^/]*|\.gitleaks[^/]*|osv-scanner[^/]*|"
    r"wrangler\.[^/]+"
    r")$",
    re.DOTALL,  # A newline in a path must not hide it from the rule.
)
TEST_FILE = re.compile(r"(^|/)(tests?|__tests__)/|\.(test|spec)\.[cm]?[jt]sx?$|(^|/)test_[^/]+\.py$|_test\.py$")
ASSERTION = re.compile(r"\b(expect|assert|should)\b")
TAUTOLOGY = re.compile(r"\b(expect|assert)\s*\(\s*(true|false|1|0|null|undefined)\s*\)")
COMMENT = re.compile(r"^\s*(//|#|\*|/\*)")
DISABLED = re.compile(
    r"\.(skip|only|todo|skipIf|runIf|fails)\b|\b(it|test|describe)\s*\[|\b(xit|xdescribe|xtest)\s*\(|@pytest\.mark\.(skip|xfail)|\bunittest\.skip\b"
)
# The tools that report the result. An Agent may add dependencies, never swap one of these (F2).
TOOLCHAIN = ("vitest", "typescript", "@biomejs/biome", "@playwright/test")
# Only a plain registry version. `file:`, `link:`, `npm:`, git and URL specifiers can substitute any code for a named package.
REGISTRY_SPEC = re.compile(r"^[~^]?\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$")
DEPENDENCY_FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
# Fields of package.json that decide what runs, or what is installed outside the lockfile's normal path.
PINNED_FIELDS = ("scripts", "packageManager", "devEngines", "pnpm", "overrides", "resolutions", "engines", "workspaces")


def is_agent(author: str, head_ref: str = "") -> bool:
    # The branch counts too. If `gh pr create` fails and a person opens the PR, the code is still an Agent's.
    return head_ref.startswith("agent/") or (author.endswith("[bot]") and author != CONTROLLER)


def lock_problems(base_lock: str | None, head_lock: str | None) -> list[str]:
    """pnpm's frozen install trusts the lockfile's `version:` for a direct dependency, so a lockfile-only edit can alias
    `vitest` to any package while package.json looks untouched. Only the importers block is checked. Transitive
    aliases are legitimate in real lockfiles, and pnpm refuses a swapped tarball URL."""
    if head_lock is None or head_lock == base_lock:
        return []

    def direct(lock):
        block = (lock or "").split("\npackages:", 1)[0]
        return dict(re.findall(r"^\s+'?(@?[^\s':]+)'?:\n\s+specifier: .*\n\s+version: (.+)$", block, re.M))

    old, new = direct(base_lock), direct(head_lock)
    out = []
    for name, version in new.items():
        if not re.match(r"\d", version):
            out.append(f"pnpm-lock.yaml: {name} resolves to {version}")
        if name in TOOLCHAIN and old.get(name) != version:
            out.append(f"pnpm-lock.yaml: toolchain {name} changed")
    return out


def package_changes(base: str | None, head: str | None) -> list[str]:
    """Names of pinned fields that differ. Unparseable JSON is a change, never a pass."""
    if base is None and head is None:
        return []
    try:
        old, new = json.loads(base or "{}"), json.loads(head or "{}")
    except json.JSONDecodeError:
        return ["unparseable"]
    changed = [field for field in PINNED_FIELDS if old.get(field) != new.get(field)]
    for field in DEPENDENCY_FIELDS:
        before, after = old.get(field) or {}, new.get(field) or {}
        for name, spec in after.items():
            if name in TOOLCHAIN and before.get(name) != spec:
                changed.append(f"toolchain {name}")
            elif before.get(name) != spec and not REGISTRY_SPEC.match(str(spec)):
                changed.append(f"non-registry dependency {name}")
        changed += [f"toolchain {name}" for name in before if name in TOOLCHAIN and name not in after]
    return changed


def only_version_changed(base: str | None, head: str | None) -> bool:
    try:
        old, new = json.loads(base or ""), json.loads(head or "")
    except json.JSONDecodeError:
        return False
    old.pop("version", None)
    new.pop("version", None)
    return old == new


def real_assertions(lines: list[str]) -> int:
    return sum(bool(ASSERTION.search(line)) and not COMMENT.search(line) and not TAUTOLOGY.search(line) for line in lines)


def weakened_tests(patches: dict[str, str]) -> list[str]:
    """patches maps a test file to its unified diff. Fewer real assertions, or a newly disabled test, is a failure.

    This is a heuristic that raises the cost of weakening a test. It can't prove a test still means anything: PR code
    decides how `pnpm test` exits, so the Critics and post-merge outcomes remain the check on test quality.
    """
    out = []
    for path, patch in sorted(patches.items()):
        added = [line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++")]
        removed = [line[1:] for line in patch.splitlines() if line.startswith("-") and not line.startswith("---")]
        if real_assertions(removed) > real_assertions(added):
            out.append(f"{path}: removes assertions")
        if any(DISABLED.search(line) for line in added):
            out.append(f"{path}: disables a test")
    return out


def is_release_pr(author: str, head_ref: str, changes: list[tuple[str, str, str]], base_pkg, head_pkg) -> bool:
    if author != CONTROLLER or not head_ref.startswith(RELEASE_BRANCH) or not changes:
        return False
    # The first release creates CHANGELOG.md. Everything else must be an edit.
    if any(path not in RELEASE_FILES or not (status == "M" or (status == "A" and path == "CHANGELOG.md")) for status, path, _ in changes):
        return False
    return only_version_changed(base_pkg, head_pkg) if any(path == "package.json" for _, path, _ in changes) else True


def evaluate(author, head_ref, changes, base_pkg, head_pkg, test_patches, base_lock=None, head_lock=None) -> tuple[bool, bool, list[str]]:
    """changes is a list of (status, path, new_mode). Returns (passed, release_pr, reasons)."""
    release_pr = is_release_pr(author, head_ref, changes, base_pkg, head_pkg)
    if release_pr or not is_agent(author, head_ref):
        return True, release_pr, []
    reasons = []
    for status, path, mode in changes:
        if FORBIDDEN.search(path):
            reasons.append(f"{path}: protected path")
        if path in RELEASE_ONLY:
            reasons.append(f"{path}: only a release PR may change this")
        if mode == "120000":
            reasons.append(f"{path}: symlinks are not allowed")
        if mode == "160000":
            reasons.append(f"{path}: submodules are not allowed")
        if status == "D" and TEST_FILE.search(path):
            reasons.append(f"{path}: deletes a test")
    changed = package_changes(base_pkg, head_pkg)
    if changed:
        reasons.append(f"package.json: changes {', '.join(changed)}")
    reasons += lock_problems(base_lock, head_lock)
    reasons += weakened_tests(test_patches)
    return not reasons, False, reasons


def git(*args: str) -> str:
    # Git's own tree data only. No external diff, no textconv, no attributes that could hide content.
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True, errors="replace").stdout


def collect(base: str, head: str):
    raw = git("diff", "--raw", "--no-renames", "--no-abbrev", "-z", f"{base}...{head}").split("\0")
    changes = []
    for meta, path in zip(raw[0::2], raw[1::2]):
        fields = meta.split()
        changes.append((fields[4], path, fields[1]))

    # Compare with where the PR branched, so a Director's later change on main doesn't fail every open Agent PR.
    fork = git("merge-base", base, head).strip()

    def show(ref, name="package.json"):
        try:
            return git("show", f"{ref}:{name}")
        except subprocess.CalledProcessError:
            return None

    patches = {}
    for status, path, _ in changes:
        if status == "M" and TEST_FILE.search(path):
            patches[path] = git("diff", "--text", "--no-ext-diff", "--no-textconv", "-U0", f"{base}...{head}", "--", path)
    return changes, show(fork), show(head), patches, show(fork, "pnpm-lock.yaml"), show(head, "pnpm-lock.yaml")


def main() -> int:
    parser = argparse.ArgumentParser()
    for name in ("base", "head", "author", "head-ref"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    try:
        changes, base_pkg, head_pkg, patches, base_lock, head_lock = collect(args.base, args.head)
        passed, release_pr, reasons = evaluate(args.author, args.head_ref, changes, base_pkg, head_pkg, patches, base_lock, head_lock)
    except Exception as exc:  # Anything unexpected fails closed.
        passed, release_pr, reasons = False, False, [f"gate error: {type(exc).__name__}"]
    print(f"pass={'true' if passed else 'false'}")
    print(f"release_pr={'true' if release_pr else 'false'}")
    for reason in reasons:
        print(f"::error::{reason}", file=sys.stderr)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
