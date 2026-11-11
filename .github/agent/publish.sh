#!/usr/bin/env bash
# Applies the agent's patch to a new branch, checks it, pushes it and opens a PR. It runs no agent code.
# The workflow runs a copy of this file and of path_gate.py from $TOOLS, taken before the patch is applied.
# Needs: PATCH, TOOLS, ISSUE, RUN_ID, PR_TITLE, AGENT_RESULT, BASE_SHA, GITHUB_OUTPUT, and GH_TOKEN for gh.
set -euo pipefail

MAX_CHANGED_LINES="${MAX_CHANGED_LINES:-800}"
MAX_PATCH_BYTES="${MAX_PATCH_BYTES:-1048576}"
BRANCH="agent/issue-$ISSUE-$RUN_ID"

say() { echo "published=$1" >> "$GITHUB_OUTPUT"; echo "reason=$2" >> "$GITHUB_OUTPUT"; }

if [ ! -s "$PATCH" ]; then say false no_change; echo "The agent produced no changes."; exit 0; fi
SIZE=$(wc -c < "$PATCH" | tr -d ' ')
if [ "$SIZE" -gt "$MAX_PATCH_BYTES" ]; then say false patch_too_big; echo "::error::Patch is $SIZE bytes"; exit 1; fi

git switch -q -c "$BRANCH"
if ! git apply --index "$PATCH"; then say false patch_refused; echo "::error::git refused the patch"; exit 1; fi

# Read what git actually staged, not the patch text. Renames show both paths, and -z stops odd names being quoted.
# Written to a file first. grep -q in a pipe stops reading early, and pipefail then hides the match.
NUMSTAT="$(mktemp)"
git diff --cached --no-renames --numstat > "$NUMSTAT"
if grep '^-' "$NUMSTAT" > /dev/null; then
  say false binary_file; echo "::error::Patch contains a binary file"; exit 1
fi
TOTAL=$(awk '{a+=$1; d+=$2} END {print a+d+0}' "$NUMSTAT")
# Too many lines still opens, as a draft, so the paid work isn't lost. The byte limit above stays a refusal,
# and the gate below still runs on it.
OVERSIZED=false
if [ "$TOTAL" -gt "$MAX_CHANGED_LINES" ]; then
  OVERSIZED=true
  echo "::warning::$TOTAL changed lines, over the limit of $MAX_CHANGED_LINES. Opening as a draft. Split the issue."
fi

git -c user.name="path1-agent[bot]" -c user.email="path1-agent[bot]@users.noreply.github.com" \
  commit -q -m "$PR_TITLE" -m "Issue #$ISSUE" -m "Agent-Run: $RUN_ID"

# path_gate rejects protected paths, symlinks, changed scripts, changed test tools, deleted or weakened tests.
if ! python3 -I "$TOOLS/path_gate.py" --base "$BASE_SHA" --head HEAD --author "path1-agent[bot]" --head-ref "$BRANCH"; then
  say false gate_failed; echo "::error::The publish gate refused this patch"; exit 1
fi

git push -q origin "$BRANCH"
BODY=$(printf 'Closes #%s\n\nrun_id: %s\nagent_result: %s\n' "$ISSUE" "$RUN_ID" "$AGENT_RESULT")
# Partial work from a cap hit still opens, as a draft, so the paid work isn't lost. So does an oversized patch.
DRAFT=()
REASON=opened
if [ "$AGENT_RESULT" != "ok" ]; then DRAFT=(--draft); fi
if $OVERSIZED; then
  DRAFT=(--draft)
  REASON=opened_oversized
  BODY=$(printf '%s\nDraft: %s changed lines, over the limit of %s. Split the issue, or review it with care.\n' "$BODY" "$TOTAL" "$MAX_CHANGED_LINES")
fi
URL=$(gh pr create --head "$BRANCH" --title "$PR_TITLE" --body "$BODY" ${DRAFT[@]+"${DRAFT[@]}"})
say true "$REASON"
echo "pr_url=$URL" >> "$GITHUB_OUTPUT"
