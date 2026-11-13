#!/usr/bin/env python3
"""Delvera's name check. Plain code: no agent has to understand the glossary for it to work.

The one source of names is this repo: GLOSSARY.yaml, contracts/names.yaml, contracts/classification.yaml,
contracts/events/registry.yaml and contracts/event.v1.schema.json. Every failure prints the exact entry to add.

Commands:
  names.py validate
      The standards agree with themselves.
  names.py check-repo --root DIR [--repo OWNER/NAME]
      Event types and data fields in run_log.py emit calls, labels in workflows and issue forms, copier questions,
      .copier-answers.yml and project.yaml values. With --repo, also the repo's live labels and topics, through gh.
  names.py check-event FILE...
      Each file is an event.v1 event with a registered type and registered data fields.
  names.py check-events --dir DIR [--since-days N] [--report FILE] [--strict]
      How many events in a run-log folder match event.v1. Prints Markdown. --strict fails on any that don't.
  names.py check-migrations FILE_OR_DIR...
      Each migration.v1 record matches its schema, and its group and facet values are in contracts/classification.yaml.

Needs PyYAML. Exit code 1 means a name isn't registered.
"""
import argparse
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import yaml

HERE = pathlib.Path(__file__).resolve().parent
STANDARDS_REPO = "delvera-hq/org-standards"
EMIT_KINDS = {"--set": "string", "--int": "integer", "--num": "number", "--bool": "boolean", "--json": "json"}
SKIP_DIRS = {".git", "node_modules", "dist", "debs", "critic-fixtures"}


# ---------- Loading


class Standards:
    def __init__(self, root: pathlib.Path = HERE):
        self.root = root
        self.glossary = yaml.safe_load((root / "GLOSSARY.yaml").read_text())
        self.names = yaml.safe_load((root / "contracts/names.yaml").read_text())
        self.registry = yaml.safe_load((root / "contracts/events/registry.yaml").read_text())
        self.envelope = json.loads((root / "contracts/event.v1.schema.json").read_text())
        self.terms = self.glossary.get("terms") or {}
        self.fields = self.registry.get("fields") or {}
        self.events = self.registry.get("events") or {}
        self.event_aliases = {a: name for name, e in self.events.items() for a in (e.get("aliases") or [])}
        self.field_aliases = {a: name for name, f in self.fields.items() for a in (f.get("aliases") or [])}
        self.labels = set((self.names.get("labels") or {}).keys())
        self.label_aliases = {a: n for n, e in (self.names.get("labels") or {}).items() for a in ((e or {}).get("aliases") or [])}
        self.default_labels = set(self.names.get("github_default_labels") or [])
        self.topics = set((self.names.get("topics") or {}).keys())
        self.project_values = self.names.get("project_values") or {}
        cls_path = root / "contracts/classification.yaml"
        self.classification = yaml.safe_load(cls_path.read_text()) if cls_path.exists() else {}
        self.groups = set(((self.classification.get("groups") or {}).get("values") or {}).keys())
        self.facets = {name: set((f.get("values") or {}).keys())
                       for name, f in ((self.classification.get("facets") or {}).items())}
        for spec, values in [(self.classification.get("groups") or {}, self.groups)] + [
                (f, set((f.get("values") or {}).keys())) for f in (self.classification.get("facets") or {}).values()]:
            self.topics |= {f"{spec.get('topic_prefix', '')}{v}" for v in values}


class Problems:
    """Collects failures, each with where it is and the exact entry to add."""

    def __init__(self):
        self.items = []

    def add(self, where: str, message: str, fix: str = ""):
        self.items.append((where, message, fix))

    def report(self, out=sys.stdout) -> int:
        for where, message, fix in self.items:
            file, _, line = where.partition(":")
            loc = f"file={file}" + (f",line={line}" if line.isdigit() else "") if file else ""
            annotation = (message + ("\n" + fix if fix else "")).replace("%", "%25").replace("\r", "").replace("\n", "%0A")
            if os.environ.get("GITHUB_ACTIONS"):
                print(f"::error {loc}::{annotation}", file=out)
            print(f"\n{where or '-'}: {message}", file=out)
            if fix:
                print(fix, file=out)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary and self.items:
            with open(summary, "a") as f:
                f.write(f"## Name check: {len(self.items)} problem(s)\n\n")
                for where, message, fix in self.items:
                    f.write(f"- `{where}`: {message}\n")
                    if fix:
                        f.write(f"\n```yaml\n{fix}\n```\n")
        return 1 if self.items else 0


def entry(file: str, text: str) -> str:
    return f"Add this to {file} in {STANDARDS_REPO}, then use the name:\n{text}"


# ---------- A small JSON Schema validator for the subset event.v1 uses


def type_ok(kind: str, value) -> bool:
    return {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "null": value is None,
    }.get(kind, False)


def is_datetime(text: str) -> bool:
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
        return "T" in text
    except ValueError:
        return False


def schema_errors(schema: dict, value, path: str = "$") -> list[str]:
    errs = []
    if "const" in schema and value != schema["const"]:
        errs.append(f"{path} must be {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errs.append(f"{path} is {value!r}, not one of {schema['enum']}")
    if "type" in schema and not type_ok(schema["type"], value):
        return errs + [f"{path} must be a {schema['type']}"]
    if isinstance(value, dict):
        props = schema.get("properties") or {}
        errs += [f"{path}.{r} is missing" for r in schema.get("required", []) if r not in value]
        if schema.get("additionalProperties") is False:
            errs += [f"{path}.{k} isn't allowed" for k in value if k not in props]
        for k, v in value.items():
            if k in props:
                errs += schema_errors(props[k], v, f"{path}.{k}")
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for n, item in enumerate(value):
            errs += schema_errors(schema["items"], item, f"{path}[{n}]")
        if len(value) > schema.get("maxItems", 10**9):
            errs.append(f"{path} has more than {schema['maxItems']} items")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append(f"{path} {value!r} doesn't match {schema['pattern']}")
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", 10**9):
            errs.append(f"{path} has the wrong length")
        if schema.get("format") == "date-time" and not is_datetime(value):
            errs.append(f"{path} {value!r} isn't a date-time")
    if type_ok("number", value) and "minimum" in schema and value < schema["minimum"]:
        errs.append(f"{path} is under {schema['minimum']}")
    return errs


# ---------- Fix snippets


def field_fix(event: str, field: str, value=None) -> str:
    kind = {bool: "boolean", int: "integer", float: "number", list: "array", dict: "object"}.get(type(value), "string")
    return entry("contracts/events/registry.yaml", "\n".join([
        "fields:",
        f"  {field}: {{type: {kind}, meaning: \"One plain sentence.\"}}",
        "events:",
        f"  {event}:",
        f"    optional: [..., {field}]",
    ]))


def event_fix(event: str, fields: list[str]) -> str:
    return entry("contracts/events/registry.yaml", "\n".join([
        "events:",
        f"  {event}:",
        "    producer: <workflow file>, <job>",
        "    authority: controller",
        "    meaning: One plain sentence.",
        "    required: []",
        f"    optional: [{', '.join(fields)}]",
    ]))


def label_fix(label: str, where: str) -> str:
    return entry("contracts/names.yaml", f"labels:\n  \"{label}\":\n    meaning: One plain sentence.\n    used_by: [{where}]")


def topic_fix(topic: str) -> str:
    return entry("contracts/names.yaml", f"topics:\n  {topic}: {{term: <glossary term>}}")


def value_key_fix(key: str) -> str:
    return entry("contracts/names.yaml", f"project_values:\n  {key}: {{values: [], meaning: \"One plain sentence.\"}}")


# ---------- Values


def check_value(std: Standards, key: str, value, where: str, probs: Problems):
    if key not in std.project_values:
        probs.add(where, f"Project value key \"{key}\" isn't registered.", value_key_fix(key))
        return
    rule = std.project_values[key] or {}
    text = str(value)
    if rule.get("status") == "reserved":
        probs.add(where, f"\"{key}\" is reserved. The Directors set its values with NORTHSTAR.md, and none is registered yet.")
        return
    if "values" in rule and text not in [str(v) for v in rule["values"]]:
        listed = ", ".join(str(v) for v in rule["values"])
        probs.add(where, f"\"{key}: {text}\" isn't a registered value. Registered: {listed}.",
                  entry("contracts/names.yaml", f"project_values:\n  {key}: {{values: [{listed}, {text}]}}"))
    if "pattern" in rule and not re.search(rule["pattern"], text):
        probs.add(where, f"\"{key}: {text}\" doesn't match {rule['pattern']}.")


# ---------- Events


def check_event(std: Standards, doc, where: str, probs: Problems) -> str:
    """Returns ok, legacy or invalid."""
    if isinstance(doc, dict) and "event" in doc and "type" not in doc:
        return "legacy"
    before = len(probs.items)
    if not isinstance(doc, dict):
        probs.add(where, "An event must be a JSON object.")
        return "invalid"
    for err in schema_errors(std.envelope, doc):
        probs.add(where, f"Not event.v1: {err}.")
    etype, data = doc.get("type"), doc.get("data") if isinstance(doc.get("data"), dict) else {}
    if etype in std.event_aliases:
        probs.add(where, f"Event type \"{etype}\" is an old name. Use \"{std.event_aliases[etype]}\".")
    elif isinstance(etype, str) and etype not in std.events:
        probs.add(where, f"Event type \"{etype}\" isn't registered.", event_fix(etype, sorted(data)))
    spec = std.events.get(etype)
    if spec:
        if doc.get("authority") != spec.get("authority"):
            probs.add(where, f"{etype} must have authority {spec.get('authority')}, not {doc.get('authority')}.")
        allowed = set(spec.get("required") or []) | set(spec.get("optional") or [])
        for key in spec.get("required") or []:
            if key not in data:
                probs.add(where, f"{etype} needs data.{key}.")
        for key, value in data.items():
            if key in std.field_aliases and std.field_aliases[key] in allowed:
                probs.add(where, f"data.{key} is an old name. Use \"{std.field_aliases[key]}\".")
            elif key not in allowed:
                probs.add(where, f"data.{key} isn't registered for {etype}.", field_fix(etype, key, value))
            else:
                check_field(std, etype, spec, key, value, where, probs)
    return "ok" if len(probs.items) == before else "invalid"


def check_field(std, etype, spec, key, value, where, probs):
    rule = std.fields.get(key) or {}
    if rule.get("type") and not type_ok(rule["type"], value):
        probs.add(where, f"{etype} data.{key} must be a {rule['type']}, not {type(value).__name__}.")
        return
    values = (spec.get("values") or {}).get(key, rule.get("values"))
    if values is not None and value not in values:
        probs.add(where, f"{etype} data.{key} is {value!r}, not one of {values}.",
                  entry("contracts/events/registry.yaml", f"events:\n  {etype}:\n    values:\n      {key}: [..., {value}]"))
    if isinstance(value, str) and rule.get("pattern") and not re.search(rule["pattern"], value):
        probs.add(where, f"{etype} data.{key} {value!r} doesn't match {rule['pattern']}.")
    if isinstance(value, str) and rule.get("format") == "date-time" and value and not is_datetime(value):
        probs.add(where, f"{etype} data.{key} {value!r} isn't a date-time.")


def event_time(doc) -> datetime | None:
    text = doc.get("occurred_at") or doc.get("at") if isinstance(doc, dict) else None
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None


def check_events(std: Standards, folder: pathlib.Path, since: datetime | None):
    counts, shown = {"ok": 0, "legacy": 0, "invalid": 0}, Problems()
    for path in sorted(folder.rglob("*.json")):
        try:
            doc = json.loads(path.read_text())
        except (OSError, ValueError):
            shown.add(str(path), "Not JSON.")
            counts["invalid"] += 1
            continue
        when = event_time(doc)
        if since and (when is None or when < since):
            continue
        counts[check_event(std, doc, str(path.relative_to(folder)), shown)] += 1
    return counts, shown


def events_markdown(counts, probs: Problems, days) -> str:
    total = sum(counts.values())
    lines = [f"**Event check (event.v1):** {counts['ok']} of {total} events in the last {days} days match. "
             f"Legacy, from before event.v1: {counts['legacy']}. Invalid: {counts['invalid']}."]
    for where, message, _ in probs.items[:10]:
        lines.append(f"- `{where}`: {message}")
    if len(probs.items) > 10:
        lines.append(f"- and {len(probs.items) - 10} more.")
    return "\n".join(lines)


# ---------- Repo scan


def text_files(root: pathlib.Path):
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if any(part in SKIP_DIRS for part in rel.parts) or not path.is_file():
            continue
        if rel.parts[:2] == (".github", "standards") or rel.parts[:1] == (".standards-base",):
            continue  # A public repo's copy of these standards is the registry, not a use of it.
        if path.suffix in (".yml", ".yaml", ".sh", ".py", ".jinja", ".md") or path.name == "CODEOWNERS":
            try:
                yield rel, path.read_text()
            except (UnicodeDecodeError, OSError):
                continue


def logical_lines(text: str):
    """Joins shell continuation lines. Yields (first line number, joined text)."""
    start, buf = None, []
    for n, line in enumerate(text.splitlines(), 1):
        if start is None:
            start = n
        stripped = line.rstrip()
        if stripped.endswith("\\"):
            buf.append(stripped[:-1])
            continue
        buf.append(line)
        yield start, " ".join(s.strip() for s in buf)
        start, buf = None, []
    if buf:
        yield start, " ".join(s.strip() for s in buf)


EMIT_RE = re.compile(r"run_log\.py[\"']?\s+emit\b(.*)")
LABEL_PATTERNS = [
    re.compile(r"label\.name\s*==\s*'([^']+)'"),
    re.compile(r"gh label create\s+(\"[^\"]+\"|'[^']+'|[^\s\"']+)"),
    re.compile(r"--(?:add-)?label[ =](\"[^\"]+\"|'[^']+'|[^\s\"']+)"),
    re.compile(r"\[\.labels\[\]\.name\]\s*\|\s*index\(\"([^\"]+)\"\)"),
    re.compile(r"labels\.\*\.name,\s*'([^']+)'"),
]


def scan_emits(std: Standards, rel, text, probs: Problems, seen: dict):
    if rel.name == "run_log.py":
        return
    for n, line in logical_lines(text):
        if "contents/events/" in line and "run_log.py" not in line:
            probs.add(f"{rel}:{n}", "Writes to the run log without run_log.py emit, so the event can't be checked. Use run_log.py emit.")
        m = EMIT_RE.search(line)
        if not m:
            continue
        try:
            tokens = shlex.split(m.group(1).split(" #")[0])
        except ValueError:
            probs.add(f"{rel}:{n}", "Can't read this run_log.py emit call. Keep each call to plain arguments.")
            continue
        etype, keys = None, []
        for i, tok in enumerate(tokens[:-1]):
            if tok == "--type":
                etype = tokens[i + 1]
            elif tok in EMIT_KINDS:
                keys.append(tokens[i + 1].split("=", 1)[0])
        where = f"{rel}:{n}"
        if not etype:
            probs.add(where, "run_log.py emit has no --type.")
            continue
        seen.setdefault(etype, []).append(where)
        if etype in std.event_aliases:
            probs.add(where, f"Event type \"{etype}\" is an old name. Use \"{std.event_aliases[etype]}\".")
            continue
        spec = std.events.get(etype)
        if not spec:
            probs.add(where, f"Event type \"{etype}\" isn't registered.", event_fix(etype, keys))
            continue
        allowed = set(spec.get("required") or []) | set(spec.get("optional") or [])
        for key in keys:
            if key in std.field_aliases and std.field_aliases[key] in allowed:
                probs.add(where, f"Field \"{key}\" is an old name. Use \"{std.field_aliases[key]}\".")
            elif key not in allowed:
                probs.add(where, f"Field \"{key}\" isn't registered for {etype}.", field_fix(etype, key))
        for key in spec.get("required") or []:
            if key not in keys:
                probs.add(where, f"{etype} needs the field \"{key}\".")


def scan_labels(rel, text) -> list[tuple[str, str]]:
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        for pat in LABEL_PATTERNS:
            for m in pat.finditer(line):
                found.append((m.group(1).strip("\"'"), f"{rel}:{n}"))
        if "ISSUE_TEMPLATE" in rel.parts:
            m = re.match(r"\s*labels:\s*\[([^\]]*)\]", line)
            if m:
                found += [(x.strip().strip("\"'"), f"{rel}:{n}") for x in m.group(1).split(",") if x.strip()]
    return [(name, where) for name, where in found if "$" not in name and "{" not in name]


def check_label(std: Standards, name: str, where: str, probs: Problems):
    if name in std.labels or name in std.default_labels:
        return
    if name in std.label_aliases:
        probs.add(where, f"Label \"{name}\" is an old name. Use \"{std.label_aliases[name]}\".")
        return
    probs.add(where, f"Label \"{name}\" isn't registered.", label_fix(name, where.split(":")[0]))


def check_repo(std: Standards, root: pathlib.Path, repo: str | None, probs: Problems):
    seen = {}
    for rel, text in text_files(root):
        if rel.parts and rel.parts[0] == ".github" or rel.name.endswith((".yml", ".yaml", ".sh")):
            scan_emits(std, rel, text, probs, seen)
            for name, where in scan_labels(rel, text):
                check_label(std, name, where, probs)
    answers = root / ".copier-answers.yml"
    if answers.exists():
        for key, value in (yaml.safe_load(answers.read_text()) or {}).items():
            if not str(key).startswith("_"):
                check_value(std, key, value, ".copier-answers.yml", probs)
    copier = root / "copier.yml"
    if copier.exists():
        for key, q in (yaml.safe_load(copier.read_text()) or {}).items():
            if str(key).startswith("_"):
                continue
            if key not in std.project_values:
                probs.add("copier.yml", f"Copier question \"{key}\" isn't a registered project value.", value_key_fix(key))
                continue
            for choice in (q or {}).get("choices") or []:
                check_value(std, key, choice, "copier.yml", probs)
            if isinstance(q, dict) and "default" in q and "{" not in str(q["default"]):
                check_value(std, key, q["default"], "copier.yml", probs)
    project = root / "project.yaml"
    if project.exists():
        for key, value in (yaml.safe_load(project.read_text()) or {}).items():
            check_value(std, key, value, "project.yaml", probs)
    if repo:
        labels = gh_lines(["api", "--paginate", f"repos/{repo}/labels", "--jq", ".[].name"], probs, "labels")
        for name in labels:
            check_label(std, name, f"live label on {repo}", probs)
        for topic in gh_lines(["api", f"repos/{repo}", "--jq", ".topics[]"], probs, "topics"):
            if topic not in std.topics:
                probs.add(f"live topic on {repo}", f"Topic \"{topic}\" isn't registered.", topic_fix(topic))
    return seen


def gh_lines(args, probs: Problems, what: str) -> list[str]:
    try:
        out = subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        probs.add("gh", f"Couldn't read the repo's {what}: {getattr(exc, 'stderr', '') or exc}. The job needs issues: read.")
        return []
    return [line for line in out.splitlines() if line.strip()]


# ---------- The standards agree with themselves


def validate(std: Standards, probs: Problems):
    where = "contracts/events/registry.yaml"
    seen_alias = {}
    for name, e in std.events.items():
        if not re.search(std.envelope["properties"]["type"]["pattern"], name):
            probs.add(where, f"Event type \"{name}\" doesn't match the envelope's type pattern.")
        for key in (e.get("required") or []) + (e.get("optional") or []):
            if key not in std.fields:
                probs.add(where, f"{name} lists \"{key}\", which has no entry under fields.")
        for key in (e.get("values") or {}):
            if key not in (e.get("required") or []) + (e.get("optional") or []):
                probs.add(where, f"{name} lists values for \"{key}\", which it doesn't carry.")
        if e.get("authority") not in std.envelope["properties"]["authority"]["enum"]:
            probs.add(where, f"{name} has an unknown authority.")
        for a in e.get("aliases") or []:
            if a in std.events or a in seen_alias:
                probs.add(where, f"Alias \"{a}\" is used twice.")
            seen_alias[a] = name
    for name, f in std.fields.items():
        if not f or "type" not in f or "meaning" not in f:
            probs.add(where, f"Field \"{name}\" needs a type and a meaning.")
        elif f.get("term") and f["term"] not in std.terms:
            probs.add(where, f"Field \"{name}\" points to the glossary term \"{f['term']}\", which isn't there.")
    for name, t in std.terms.items():
        t = t or {}
        if t.get("status") == "replaced":
            for target in t.get("replaced_by") or []:
                if target not in std.terms:
                    probs.add("GLOSSARY.yaml", f"\"{name}\" is replaced by \"{target}\", which isn't a term.")
        elif not t.get("definition"):
            probs.add("GLOSSARY.yaml", f"\"{name}\" needs a definition.")
        for target in t.get("not_to_be_confused_with") or []:
            if target not in std.terms:
                probs.add("GLOSSARY.yaml", f"\"{name}\" refers to \"{target}\", which isn't a term.")
    aliases = [a for t in std.terms.values() for a in ((t or {}).get("aliases") or [])]
    for a in aliases:
        if a in std.terms or aliases.count(a) > 1:
            probs.add("GLOSSARY.yaml", f"Alias \"{a}\" clashes with a term or another alias.")
    for name in std.glossary.get("removed") or []:
        if name in std.terms:
            probs.add("GLOSSARY.yaml", f"\"{name}\" is both a term and removed.")
    for key, rule in std.project_values.items():
        if rule and rule.get("term") and rule["term"] not in std.terms:
            probs.add("contracts/names.yaml", f"\"{key}\" points to the term \"{rule['term']}\", which isn't there.")
    for name, t in (std.names.get("topics") or {}).items():
        if (t or {}).get("term") not in std.terms:
            probs.add("contracts/names.yaml", f"Topic \"{name}\" needs a glossary term.")
    validate_classification(std, probs)


def validate_classification(std: Standards, probs: Problems):
    where = "contracts/classification.yaml"
    specs = [("groups", std.classification.get("groups") or {})] + list((std.classification.get("facets") or {}).items())
    prefixes = []
    for name, spec in specs:
        prefix = spec.get("topic_prefix", "")
        if not re.fullmatch(r"[a-z]+-", prefix):
            probs.add(where, f"\"{name}\" needs a topic_prefix such as \"{name[:5]}-\".")
        prefixes.append(prefix)
        for value, entry in (spec.get("values") or {}).items():
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", str(value)):
                probs.add(where, f"{name} value \"{value}\" must be lowercase letters, digits and hyphens.")
            elif len(prefix + str(value)) > 50:
                probs.add(where, f"Topic \"{prefix}{value}\" is longer than GitHub's 50 characters.")
            if not (entry or {}).get("meaning"):
                probs.add(where, f"{name} value \"{value}\" needs a meaning.")
    if len(set(prefixes)) != len(prefixes):
        probs.add(where, "Two facets share a topic_prefix.")
    for topic in (std.names.get("topics") or {}):
        if any(topic.startswith(p) for p in prefixes):
            probs.add("contracts/names.yaml", f"Topic \"{topic}\" uses a classification prefix. Register it in {where}.")


# ---------- Migration records


def check_migration(std: Standards, schema: dict, doc, where: str, probs: Problems):
    for err in schema_errors(schema, doc):
        probs.add(where, f"Not migration.v1: {err}.")
    decision = doc.get("decision") if isinstance(doc, dict) and isinstance(doc.get("decision"), dict) else {}
    group = decision.get("group")
    if group is not None and group not in std.groups:
        probs.add(where, f"Group \"{group}\" isn't registered.",
                  entry("contracts/classification.yaml", f"groups:\n  values:\n    {group}: {{meaning: \"...\"}}"))
    for facet, values in (decision.get("facets") or {}).items():
        if facet not in std.facets:
            probs.add(where, f"Facet \"{facet}\" isn't registered.")
            continue
        for v in values or []:
            if v not in std.facets[facet]:
                probs.add(where, f"{facet} value \"{v}\" isn't registered.",
                          entry("contracts/classification.yaml", f"facets:\n  {facet}:\n    values:\n      {v}: {{meaning: \"...\"}}"))
    repo = (doc.get("facts") or {}).get("repo") or {} if isinstance(doc, dict) else {}
    for v in repo.get("stack") or []:
        if v not in std.facets.get("stack", set()):
            probs.add(where, f"stack value \"{v}\" isn't registered.",
                      entry("contracts/classification.yaml", f"facets:\n  stack:\n    values:\n      {v}: {{meaning: \"...\"}}"))


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("validate")
    r = sub.add_parser("check-repo")
    r.add_argument("--root", default=".")
    r.add_argument("--repo")
    e = sub.add_parser("check-event")
    e.add_argument("files", nargs="+")
    es = sub.add_parser("check-events")
    es.add_argument("--dir", required=True)
    es.add_argument("--since-days", type=int, default=7)
    es.add_argument("--report")
    es.add_argument("--strict", action="store_true")
    cr = sub.add_parser("check-research", help="check research.v1 files against contracts/research.v1.schema.json")
    cr.add_argument("files", nargs="+")
    cm = sub.add_parser("check-migrations", help="check migration.v1 records, and their group and facet values")
    cm.add_argument("paths", nargs="+")
    parser.add_argument("--standards", default=str(HERE), help=argparse.SUPPRESS)
    args = parser.parse_args()
    std = Standards(pathlib.Path(args.standards))
    probs = Problems()

    if args.cmd == "validate":
        validate(std, probs)
        rc = probs.report()
        print(f"\nStandards: {len(std.terms)} terms, {len(std.events)} event types, {len(std.fields)} fields. "
              f"{'OK' if not rc else 'Problems above.'}")
        return rc
    if args.cmd == "check-repo":
        seen = check_repo(std, pathlib.Path(args.root), args.repo, probs)
        rc = probs.report()
        print(f"\nName check: {len(probs.items)} problem(s). Event types written here: {', '.join(sorted(seen)) or 'none'}.")
        return rc
    if args.cmd == "check-research":
        schema = json.loads((std.root / "contracts" / "research.v1.schema.json").read_text())
        for f in args.files:
            try:
                doc = json.loads(pathlib.Path(f).read_text())
            except (OSError, ValueError) as exc:
                probs.add(f, f"Not readable JSON: {exc}")
                continue
            for err in schema_errors(schema, doc):
                probs.add(f, err)
        rc = probs.report()
        print(f"\nResearch check: {len(probs.items)} problem(s) in {len(args.files)} file(s).")
        return rc
    if args.cmd == "check-migrations":
        schema = json.loads((std.root / "contracts" / "migration.v1.schema.json").read_text())
        files = [f for p in map(pathlib.Path, args.paths) for f in (sorted(p.glob("*.json")) if p.is_dir() else [p])]
        for f in files:
            try:
                doc = json.loads(f.read_text())
            except (OSError, ValueError) as exc:
                probs.add(str(f), f"Not readable JSON: {exc}")
                continue
            check_migration(std, schema, doc, str(f), probs)
        rc = probs.report()
        print(f"\nMigration check: {len(probs.items)} problem(s) in {len(files)} record(s).")
        return rc
    if args.cmd == "check-event":
        states = [check_event(std, json.loads(pathlib.Path(f).read_text()), f, probs) for f in args.files]
        rc = probs.report()
        if "legacy" in states:
            print("\nA legacy event, from before event.v1, isn't valid as a new event.")
            rc = 1
        return rc
    since = datetime.now(timezone.utc) - timedelta(days=args.since_days)
    counts, shown = check_events(std, pathlib.Path(args.dir), since)
    text = events_markdown(counts, shown, args.since_days)
    print(text)
    if args.report:
        pathlib.Path(args.report).write_text(text + "\n")
    return 1 if args.strict and (counts["legacy"] or counts["invalid"]) else 0


if __name__ == "__main__":
    sys.exit(main())
