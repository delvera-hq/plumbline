#!/usr/bin/env bash
# Path 2. A brief task is done: close the brief if it was the last step, or start the next step.
# Called by brief.yml when an agent PR merges, and when a person closes a task as completed. Both can fire for one
# task, so it is idempotent: a marker comment on the next task means it already started. brief.yml runs one at a
# time, so check-then-mark can't race.
# Needs: ISSUE (the finished task), ALLOW, GH_REPO, GH_TOKEN for gh.
set -euo pipefail

MARK="Started by the brief chain."

gh api "repos/$GH_REPO/issues/$ISSUE" > task.json
BODY=$(jq -r '.body // ""' task.json | tr -d '\r')
BRIEF=$(sed -nE 's/^Brief: #([0-9]+)$/\1/p' <<<"$BODY" | head -1)
STEP=$(sed -nE 's/^Step: ([0-9]+) of ([0-9]+)$/\1 \2/p' <<<"$BODY" | head -1)
if [ -z "$BRIEF" ] || [ -z "$STEP" ] || [ "$(jq -r .user.login task.json)" != "github-actions[bot]" ]; then
  echo "#$ISSUE isn't a brief task."
  exit 0
fi
read -r K M <<<"$STEP"

gh api "repos/$GH_REPO/issues/$BRIEF" > brief.json
jq -e --argjson allow "$ALLOW" '(.user.login as $u | $allow | index($u) != null) and ([.labels[].name] | index("brief") != null)' brief.json > /dev/null \
  || { echo "::error::#$BRIEF isn't a Director's brief"; exit 1; }
if [ "$(jq -r .state brief.json)" != "open" ]; then
  echo "Brief #$BRIEF is already closed."
  exit 0
fi

if [ "$K" -ge "$M" ]; then
  gh issue comment "$BRIEF" --body "All $M tasks are done. The last was #$ISSUE."
  gh issue close "$BRIEF" --reason completed
  exit 0
fi

WANT=$((K + 1))
gh api --paginate --slurp "repos/$GH_REPO/issues?state=open&per_page=100" > open.json
# Whole lines only, so "Brief: #1" never matches "Brief: #12".
NEXT=$(jq -r --arg b "Brief: #$BRIEF" --arg s "Step: $WANT of $M" '
  [.[][] | select(.pull_request == null and .user.login == "github-actions[bot]")
    | select((.body // "") | gsub("\r"; "") | split("\n") | (index($b) != null and index($s) != null)) | .number][0] // empty' open.json)
if [ -z "$NEXT" ]; then
  gh issue comment "$BRIEF" --body "Step $K of $M (#$ISSUE) is done, but I can't find step $WANT open, so the chain stopped."
  exit 0
fi

STARTED=$(gh api --paginate --slurp "repos/$GH_REPO/issues/$NEXT/comments?per_page=100" \
  | jq --arg m "$MARK" '[.[][] | select(.user.login == "github-actions[bot]" and (.body | startswith($m)))] | length')
if [ "$STARTED" -gt 0 ]; then
  echo "#$NEXT already started."
  exit 0
fi
gh issue comment "$NEXT" --body "$MARK Step $WANT of $M, after #$ISSUE."
gh workflow run agent.yml --ref main -f issue="$NEXT"
gh issue comment "$BRIEF" --body "Step $K of $M (#$ISSUE) is done. Started step $WANT, #$NEXT."
