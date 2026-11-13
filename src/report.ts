import type { EvidenceEntry, Finding, RuleName, Severity } from "./rules.js";

const RULES: readonly RuleName[] = [
  "PLAN_DONE_WORK_OPEN",
  "WORK_DONE_PLAN_OPEN",
  "DUE_SOON_NO_ACTIVITY",
  "DATE_CONFLICT",
  "NOT_LINKED",
  "KEY_NOT_FOUND",
];
const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

// ASCII punctuation, which a backslash can escape in CommonMark. Escaping all of it keeps data from forming Markdown syntax.
const PUNCTUATION = /[!-/:-@[-`{-~]/g;
// Control characters, including line breaks, would start a new Markdown block, so they become spaces.
const CONTROL = /\p{Cc}/gu;

/** Makes untrusted text print literally inside a Markdown line. */
function escapeMarkdown(text: string): string {
  return text.replace(CONTROL, " ").replace(PUNCTUATION, "\\$&");
}

function formatValue(value: EvidenceEntry["value"]): string {
  if (value === null) return "none";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map(escapeMarkdown).join(", ");
  return escapeMarkdown(value);
}

function renderFinding(finding: Finding, index: number): string[] {
  const evidence =
    finding.evidence.length === 0
      ? ["- none"]
      : finding.evidence.map(
          (entry) => `- ${escapeMarkdown(entry.id)}, ${escapeMarkdown(entry.field)}: ${formatValue(entry.value)}`,
        );
  return [
    `### ${index + 1}. ${finding.rule} (${finding.severity})`,
    "",
    escapeMarkdown(finding.summary),
    "",
    "Evidence:",
    "",
    ...evidence,
    "",
  ];
}

function countTable(
  heading: string,
  column: string,
  labels: readonly string[],
  count: (label: string) => number,
): string[] {
  return [
    `## ${heading}`,
    "",
    `| ${column} | Findings |`,
    "| --- | ---: |",
    ...labels.map((label) => `| ${label} | ${count(label)} |`),
    "",
  ];
}

/**
 * Renders drift findings as a Markdown report: totals by rule and by severity, then one section
 * per finding with its evidence, then a closing line asking for feedback.
 * Findings are listed high severity first; findings of equal severity keep their input order.
 * Pure: it reads only its argument and sends nothing anywhere.
 */
export function renderDriftReport(findings: Finding[]): string {
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const lines = [
    "# Plumbline drift report",
    "",
    `Total findings: ${findings.length}.`,
    "",
    ...countTable("Totals by rule", "Rule", RULES, (rule) => findings.filter((f) => f.rule === rule).length),
    ...countTable(
      "Totals by severity",
      "Severity",
      SEVERITIES,
      (severity) => findings.filter((f) => f.severity === severity).length,
    ),
    "## Findings",
    "",
    ...(sorted.length === 0 ? ["No drift findings.", ""] : sorted.flatMap(renderFinding)),
    "Did this audit help? Tell us by opening an issue at https://github.com/delvera-hq/plumbline/issues or through the waitlist form on the docs site.",
  ];
  return `${lines.join("\n")}\n`;
}
