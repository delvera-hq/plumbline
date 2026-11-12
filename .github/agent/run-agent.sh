#!/usr/bin/env bash
# Runs the coding agent once, inside the sandbox. It always exits 0, so a cap hit doesn't lose the paid work.
# The workflow runs copies of this file and the prompt from $RUNNER_TEMP, because the agent can write to the workspace.
# Path 6: it keeps the full stream-json transcript as the trace, and records what ran.
# Needs: GITHUB_WORKSPACE, RUNNER_TEMP, GITHUB_OUTPUT, MODEL, BUDGET, and $RUNNER_TEMP/agent-prompt.md.
# Writes to $GITHUB_OUTPUT: result, cost_usd_est, model, harness, harness_version, prompt_sha, tokens_in, tokens_out,
# turns, duration_s. Writes the trace to $RUNNER_TEMP/trace/trace.jsonl.gz.
set -uo pipefail

SETTINGS="$RUNNER_TEMP/claude-settings.json"
STORE="$RUNNER_TEMP/pnpm-store"
PROMPT_FILE="$RUNNER_TEMP/agent-prompt.md"
STREAM="$RUNNER_TEMP/trace.jsonl"
RESULT="$RUNNER_TEMP/result.json"
mkdir -p "$RUNNER_TEMP/trace"

jq -n --arg workspace "$GITHUB_WORKSPACE" --arg store "$STORE" '{
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    filesystem: { denyRead: ["~/"], allowRead: [$workspace, $store], allowWrite: [$workspace, $store] },
    network: { allowedDomains: ["registry.npmjs.org"], strictAllowlist: true }
  }
}' > "$SETTINGS"

PROMPT=$(cat "$PROMPT_FILE")
PROMPT_SHA=$(sha256sum "$PROMPT_FILE" | cut -c1-16)
HARNESS_VERSION=$(claude --version 2>/dev/null | awk '{print $1}')
START=$(date +%s)

# The prompt comes straight after -p. --allowedTools takes many values, and it would swallow a prompt placed after it.
# stream-json needs --verbose with -p. Its last line is the same result object --output-format json gave.
CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 CI=false \
npm_config_store_dir="$STORE" pnpm_config_store_dir="$STORE" npm_config_ignore_scripts=true \
claude -p "$PROMPT" \
  --model "$MODEL" \
  --settings "$SETTINGS" \
  --max-turns 60 \
  --max-budget-usd "$BUDGET" \
  --permission-mode dontAsk \
  --output-format stream-json \
  --verbose \
  --disallowedTools "WebFetch,WebSearch,mcp__*" \
  --allowedTools "Read(./**),Edit(./**),Write(./**),Glob(./**),Grep(./**),Bash(pnpm install *),Bash(pnpm add *),Bash(pnpm lint),Bash(pnpm typecheck),Bash(pnpm test),Bash(pnpm exec vitest *),Bash(git status),Bash(git diff *)" \
  < /dev/null > "$STREAM" 2> "$RUNNER_TEMP/agent.err"
RC=$?
DURATION=$(( $(date +%s) - START ))

# A cut-off stream can end in half a line, so read line by line and skip what isn't JSON.
jq -cR 'fromjson? | select(.type == "result")' "$STREAM" 2>/dev/null | tail -1 > "$RESULT"
INIT_MODEL=$(jq -rR 'fromjson? | select(.type == "system" and .subtype == "init") | .model // empty' "$STREAM" 2>/dev/null | head -1)

SUBTYPE=$(jq -r '.subtype // "none"' "$RESULT" 2>/dev/null)
case "$SUBTYPE" in
  success) STATE=ok ;;
  error_max_budget_usd) STATE=budget_capped ;;
  error_max_turns) STATE=max_turns ;;
  *) STATE=agent_error ;;
esac
if [ "$RC" != "0" ] && [ "$STATE" = "ok" ]; then STATE=agent_error; fi
num() { jq -r "$1" "$RESULT" 2>/dev/null | grep -E '^[0-9.eE+-]+$' || echo 0; }
COST=$(num '.total_cost_usd // 0')
TURNS=$(num '.num_turns // 0')
# All models the harness called, including any small model it uses on the side.
TOKENS_IN=$(num '[.modelUsage[]? | (.inputTokens // 0) + (.cacheReadInputTokens // 0) + (.cacheCreationInputTokens // 0)] | add // 0')
TOKENS_OUT=$(num '[.modelUsage[]? | .outputTokens // 0] | add // 0')

# The trace is the agent's own transcript. Its key is scrubbed from subprocesses and the sandbox can't read ~/,
# but strip anything shaped like a credential anyway before it's kept.
sed -E \
  -e 's/sk-ant-[A-Za-z0-9_-]{10,}/[REDACTED]/g' \
  -e 's/gh[opsur]_[A-Za-z0-9]{20,}/[REDACTED]/g' \
  -e 's/github_pat_[A-Za-z0-9_]{20,}/[REDACTED]/g' \
  -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----[^"]*/[REDACTED]/g' \
  "$STREAM" | gzip -9 > "$RUNNER_TEMP/trace/trace.jsonl.gz"

{
  echo "result=$STATE"
  echo "cost_usd_est=$COST"
  echo "model=${INIT_MODEL:-$MODEL}"
  echo "harness=claude-code"
  echo "harness_version=$HARNESS_VERSION"
  echo "prompt_sha=$PROMPT_SHA"
  echo "tokens_in=$TOKENS_IN"
  echo "tokens_out=$TOKENS_OUT"
  echo "turns=$TURNS"
  echo "duration_s=$DURATION"
} >> "$GITHUB_OUTPUT"
echo "Agent finished: $STATE, about \$$COST, $TURNS turns, ${DURATION}s, exit $RC. Trace: $(stat -c %s "$RUNNER_TEMP/trace/trace.jsonl.gz" 2>/dev/null || echo 0) bytes"
if [ "$STATE" = "agent_error" ]; then head -c 2000 "$RUNNER_TEMP/agent.err"; fi
exit 0
