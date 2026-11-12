#!/usr/bin/env bash
# Path 3. Probes the live site. It holds no secrets and runs no project code.
# Usage: probe.sh BASE_URL [EXPECT_SHA]
# Passes when, in one attempt, all of these hold:
#   - /__version.json names EXPECT_SHA, if it's given
#   - /healthz returns 200 with the body "ok"
#   - each path in PROBE_PATHS (space-separated, default "/") returns 200
# It retries the whole set PROBE_TRIES times, PROBE_WAIT seconds apart, so a slow edge isn't a failure.
# On success it prints live_sha=<sha> for $GITHUB_OUTPUT. Exit 0 pass, 1 fail, 2 bad input.
set -uo pipefail

BASE="${1:-}"
EXPECT="${2:-}"
PATHS="${PROBE_PATHS:-/}"
TRIES="${PROBE_TRIES:-6}"
WAIT="${PROBE_WAIT:-10}"

case "$BASE" in https://*) ;; *) echo "::error::probe needs an https base URL" >&2; exit 2 ;; esac
BASE="${BASE%/}"
for P in $PATHS; do
  # Only plain paths. PROBE_PATHS is a repo variable, and it must not turn the probe into a request to another host.
  [[ "$P" =~ ^/[A-Za-z0-9._~/-]*$ ]] || { echo "::error::bad probe path: $P" >&2; exit 2; }
done

attempt_once() {
  local problems=() live body code
  live=$(curl -fsS --max-time 10 -H 'Cache-Control: no-cache' "$BASE/__version.json?probe=$RANDOM" | jq -r '.version // empty' 2>/dev/null) || live=""
  if [ -z "$live" ]; then problems+=("__version.json unreadable")
  elif [ -n "$EXPECT" ] && [ "$live" != "$EXPECT" ]; then problems+=("live is $live, expected $EXPECT"); fi

  body=$(curl -fsS --max-time 10 "$BASE/healthz") || body=""
  [ "$(tr -d '[:space:]' <<<"$body")" = "ok" ] || problems+=("/healthz didn't say ok")

  for P in $PATHS; do
    code=$(curl -sS -o /dev/null -L --max-redirs 3 --max-time 10 -w '%{http_code}' "$BASE$P") || code=000
    [ "$code" = "200" ] || problems+=("$P returned $code")
  done

  LIVE_SHA="$live"
  if [ ${#problems[@]} -eq 0 ]; then return 0; fi
  printf '%s\n' "${problems[@]}"
  return 1
}

LIVE_SHA=""
OUT="$(mktemp)"
for ((i = 1; i <= TRIES; i++)); do
  # Not in a subshell, so LIVE_SHA survives.
  if attempt_once > "$OUT"; then
    echo "Probe passed on attempt $i. Live: $LIVE_SHA"
    echo "live_sha=$LIVE_SHA"
    exit 0
  fi
  echo "Attempt $i failed:"; sed 's/^/  /' "$OUT"
  if [ "$i" -lt "$TRIES" ]; then sleep "$WAIT"; fi
done
echo "::error::Probe failed $TRIES times at $BASE"
exit 1
