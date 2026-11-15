#!/usr/bin/env bash
# Path 3. Called by deploy.yml when a release fails its probe. It opens a PR that reverts the bad commit. It asks
# GitHub to merge it when its checks pass only if the bad commit was the App's own agent PR. It runs no project code.
# Needs: BAD_SHA, ROLLBACK, RECHECK, RUN_URL, GITHUB_OUTPUT, GH_TOKEN (the App) and ISSUE_TOKEN (GITHUB_TOKEN) for gh.
# Optional: APP_SLUG (the App's slug, so its login is APP_SLUG[bot]), and the repo variables AUTO_ROLLBACK and
# DEPLOY_FREEZE.
# Writes outcome= and pr= to $GITHUB_OUTPUT. Outcomes: auto_merge, needs_merge, already_open, revert_of_revert,
# conflict, lookup_failed, workflow_files, push_failed, failed.
# Every way out that leaves main holding the bad change opens an issue for a person.
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
# Any other failure must still tell a person. Without this, set -e ends the script and nobody is told.
on_error() {
  trap - ERR
  say failed
  need_person "the automatic revert failed" "A step of the revert failed at line $1, so main still holds the bad change, and the next merge will ship it again. Revert it by hand."
  exit 1
}
trap 'on_error $LINENO' ERR

# A failed rollback means the bad release may still be live. Say so first, whatever happens next.
if [ "$ROLLBACK" != "success" ] || [ "$RECHECK" != "success" ]; then
  need_person "the rollback needs a person" "The old release isn't confirmed live. Check the site now. To stop deploys, set the repo variable DEPLOY_FREEZE to true."
fi

# Find the PR that made the bad commit. If GitHub can't say, don't guess: it may be a revert, or a person's change.
if ! PRS=$(gh api "repos/$GH_REPO/commits/$BAD_SHA/pulls" 2>/dev/null); then
  say lookup_failed
  need_person "revert it by hand" "GitHub didn't say which PR made this commit, so no revert was opened. It may be a revert itself, or a person's change. Revert it by hand if it should go."
  exit 0
fi
# The PR that this commit merged, if any. A direct push has none.
PR_INFO=$(jq -c --arg sha "$BAD_SHA" '([.[] | select(.merge_commit_sha == $sha)] + .)[0] // {}' <<<"$PRS")
HEAD_REF=$(jq -r '.head.ref // ""' <<<"$PR_INFO")

# Never revert a revert. If an automatic revert fails its own probe, the probe or the platform is the problem.
if [[ "$HEAD_REF" == revert/* ]]; then
  say revert_of_revert
  need_person "an automatic revert failed its probe too" "No further revert was opened. The probe, the platform or an earlier commit may be at fault."
  exit 0
fi

# The revert merges itself only when the bad commit was the App's own agent PR. A person's change is a person's call.
AGENT=false
if [ -n "${APP_SLUG:-}" ] && jq -e --arg app "${APP_SLUG}[bot]" \
  '(.head.ref // "" | startswith("agent/")) and .user.login == $app and .head.repo.full_name == .base.repo.full_name' \
  <<<"$PR_INFO" > /dev/null; then
  AGENT=true
fi
HOLD=""
if [ "$AGENT" != "true" ]; then HOLD="The bad commit didn't come from the App's agent PR, so a person decides."; fi
if [ "${AUTO_ROLLBACK:-}" = "false" ]; then HOLD="AUTO_ROLLBACK is false."; fi
if [ "${DEPLOY_FREEZE:-}" = "true" ]; then HOLD="DEPLOY_FREEZE is true."; fi

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

# The App's token can't push a change to a workflow file, so GitHub would refuse the push. Say so before trying.
if git diff --name-only origin/main HEAD | grep -q '^\.github/workflows/'; then
  say workflow_files
  need_person "a person must revert it" "The revert touches workflow files, so a person must revert it. The App's token can't change .github/workflows. The old release is live, but main still holds the bad change."
  exit 0
fi

if ! git push -q origin "$BRANCH"; then
  say push_failed
  need_person "a person must revert it" "GitHub refused the push of the revert branch, so no revert PR was opened. Main still holds the bad change. Revert it by hand."
  exit 0
fi
if [ -n "$HOLD" ]; then
  MERGE_NOTE="A person must review and merge it. $HOLD"
else
  MERGE_NOTE="It merges itself when its checks pass."
fi
BODY=$(printf 'Release %s failed its live probe, so traffic went back to the release before it.\n\nThis PR reverts %s so the next deploy doesn'"'"'t ship it again. %s\n\nRun: %s\n' \
  "$BAD_SHA" "$BAD_SHA" "$MERGE_NOTE" "$RUN_URL")
if ! URL=$(gh pr create --head "$BRANCH" --base main --title "Revert $SHORT: its release failed the live probe" --body "$BODY"); then
  say failed
  need_person "open the revert PR" "The branch $BRANCH holds the revert, but the PR didn't open. Open it and merge it by hand."
  exit 0
fi
echo "pr=$URL" >> "$GITHUB_OUTPUT"
if [ -n "$HOLD" ]; then
  say needs_merge
  need_person "merge the revert PR" "$URL reverts the bad commit, and needs a person. $HOLD"
elif gh pr merge "$URL" --auto --squash; then
  say auto_merge
else
  say needs_merge
  need_person "merge the revert PR" "Auto-merge couldn't be turned on, so $URL needs a click. Turn on \"Allow auto-merge\" in the repo settings."
fi
