#!/usr/bin/env bash
# Path 3. Called by deploy.yml when a release fails its probe. It opens a PR that reverts the bad commit, and asks
# GitHub to merge it when its checks pass. It runs no project code.
# Needs: BAD_SHA, ROLLBACK, RECHECK, RUN_URL, GITHUB_OUTPUT, GH_TOKEN (the App) and ISSUE_TOKEN (GITHUB_TOKEN) for gh.
# Writes outcome= and pr= to $GITHUB_OUTPUT. Outcomes: auto_merge, needs_merge, already_open, revert_of_revert, conflict.
set -euo pipefail

SHORT="${BAD_SHA:0:7}"
say() { echo "outcome=$1" >> "$GITHUB_OUTPUT"; echo "Outcome: $1"; }
need_person() {
  local body
  body=$(printf 'Release %s failed its live probe.\n\n%s\n\nRollback: %s. Recheck of the old release: %s.\n\nRun: %s\n' \
    "$BAD_SHA" "$2" "$ROLLBACK" "$RECHECK" "$RUN_URL")
  GH_TOKEN="$ISSUE_TOKEN" gh issue create --title "Release $SHORT: $1" --body "$body" > /dev/null \
    || echo "::warning::Couldn't open the issue"
}

# A failed rollback means the bad release may still be live. Say so first, whatever happens next.
if [ "$ROLLBACK" != "success" ] || [ "$RECHECK" != "success" ]; then
  need_person "the rollback needs a person" "The old release isn't confirmed live. Check the site now. To stop deploys, set the repo variable DEPLOY_FREEZE to true."
fi

# Never revert a revert. If an automatic revert fails its own probe, the probe or the platform is the problem.
HEAD_REF=$(gh api "repos/$GH_REPO/commits/$BAD_SHA/pulls" --jq '.[0].head.ref // ""' 2>/dev/null) || HEAD_REF=""
if [[ "$HEAD_REF" == revert/* ]]; then
  say revert_of_revert
  need_person "an automatic revert failed its probe too" "No further revert was opened. The probe, the platform or an earlier commit may be at fault."
  exit 0
fi

# One automatic revert at a time. A later release that fails holds the same bad change, so it isn't reverted too.
OPEN=$(gh pr list --state open --json headRefName,url --jq '[.[] | select(.headRefName | startswith("revert/"))][0].url // ""')
if [ -n "$OPEN" ]; then
  say already_open
  echo "pr=$OPEN" >> "$GITHUB_OUTPUT"
  gh pr comment "$OPEN" --body "Release $BAD_SHA also failed its probe and was rolled back. It holds the change this PR reverts, so no second revert was opened. Run: $RUN_URL" > /dev/null || true
  exit 0
fi

BRANCH="revert/$SHORT-$GITHUB_RUN_ID"
git switch -q -c "$BRANCH" origin/main
MAINLINE=()
if [ "$(git rev-list --parents -n 1 "$BAD_SHA" | wc -w)" -gt 2 ]; then MAINLINE=(-m 1); fi
if ! git -c user.name="path3-revert[bot]" -c user.email="path3-revert[bot]@users.noreply.github.com" \
  revert --no-edit ${MAINLINE[@]+"${MAINLINE[@]}"} "$BAD_SHA"; then
  git revert --abort 2>/dev/null || true
  say conflict
  need_person "the automatic revert didn't apply" "Later commits touch the same lines. The old release is live, but main still holds the bad change, and the next merge will ship it again. Revert it by hand."
  exit 0
fi

git push -q origin "$BRANCH"
BODY=$(printf 'Release %s failed its live probe, so traffic went back to the release before it.\n\nThis PR reverts %s so the next deploy doesn'"'"'t ship it again. It merges itself when its checks pass.\n\nRun: %s\n' \
  "$BAD_SHA" "$BAD_SHA" "$RUN_URL")
URL=$(gh pr create --head "$BRANCH" --base main --title "Revert $SHORT: its release failed the live probe" --body "$BODY")
echo "pr=$URL" >> "$GITHUB_OUTPUT"
if gh pr merge "$URL" --auto --squash; then
  say auto_merge
else
  say needs_merge
  need_person "merge the revert PR" "Auto-merge couldn't be turned on, so $URL needs a click. Turn on \"Allow auto-merge\" in the repo settings."
fi
