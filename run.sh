#!/usr/bin/env bash
#
# Local launcher for Discord Util Bot.
#
#   ./run.sh            preflight checks, then run with watch-reload
#   ./run.sh prod       build, then run the compiled bundle
#   ./run.sh setup      first-time setup (deps, .env, permissions)
#   ./run.sh check      verify GitHub credentials and Discord connectivity
#   ./run.sh commands   register slash commands with Discord
#   ./run.sh stop       stop any running instance of this bot
#   ./run.sh restart    stop, then start again
#   ./run.sh status     show whether this bot is running
#   ./run.sh test       typecheck, tests, and format check
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

readonly MIN_NODE_MAJOR=22
readonly MIN_NODE_MINOR=5

if [[ -t 1 ]]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[1m'; D=$'\e[2m'; N=$'\e[0m'
else
  R=""; G=""; Y=""; B=""; D=""; N=""
fi

ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '  %s✗%s %s\n' "$R" "$N" "$1" >&2; [[ $# -gt 1 ]] && printf '    %s\n' "$2" >&2; exit 1; }
head_() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }

# --- checks -----------------------------------------------------------------

check_node() {
  command -v node >/dev/null 2>&1 || die "Node is not installed." "Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org"

  local raw major minor
  raw="$(node --version)"; raw="${raw#v}"
  major="${raw%%.*}"
  minor="${raw#*.}"; minor="${minor%%.*}"

  if (( major < MIN_NODE_MAJOR )) || { (( major == MIN_NODE_MAJOR )) && (( minor < MIN_NODE_MINOR )); }; then
    die "Node ${raw} is too old (need ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+)." \
        "This project uses the built-in node:sqlite module."
  fi
  ok "Node ${raw}"
}

check_deps() {
  if [[ ! -d node_modules ]]; then
    warn "Dependencies missing — installing..."
    npm install
  fi
  ok "Dependencies present"
}

check_env() {
  if [[ ! -f .env ]]; then
    die ".env not found." "Run: ./run.sh setup"
  fi

  # Secrets should not be world-readable.
  local perms
  perms="$(stat -f '%Lp' .env 2>/dev/null || stat -c '%a' .env 2>/dev/null || echo '')"
  if [[ -n "$perms" && "$perms" != "600" ]]; then
    warn ".env was mode ${perms}; tightening to 600"
    chmod 600 .env
  fi

  local missing=()
  for key in DISCORD_TOKEN DISCORD_APP_ID GITHUB_APP_ID GITHUB_ORG GITHUB_INSTALLATION_ID; do
    local line value
    line="$(grep -E "^${key}=" .env || true)"
    value="${line#*=}"
    if [[ -z "$line" || -z "$value" ]] || [[ "$value" =~ (your-|000000|here|placeholder) ]]; then
      missing+=("$key")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    die "These are unset or still placeholders in .env: ${missing[*]}" "See .env.example for where each value comes from."
  fi
  ok ".env looks complete"

  # A private key is required, by path or inline.
  local key_path
  key_path="$(grep -E '^GITHUB_APP_PRIVATE_KEY_PATH=' .env | cut -d= -f2- || true)"
  if [[ -n "$key_path" && "$key_path" != /* ]]; then
    die "GITHUB_APP_PRIVATE_KEY_PATH must be an absolute path." "Got: ${key_path}  (a leading ~ is not expanded)"
  fi
  if [[ -n "$key_path" ]]; then
    [[ -r "$key_path" ]] || die "Cannot read the private key at ${key_path}"
    ok "Private key readable"
  elif grep -qE '^GITHUB_APP_PRIVATE_KEY=.+' .env; then
    ok "Private key supplied inline"
  else
    die "No GitHub App private key configured." "Set GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY."
  fi
}

report_mode() {
  local dry
  dry="$(grep -E '^GITHUB_DRY_RUN=' .env | cut -d= -f2- || echo 'true')"
  if [[ "$dry" == "true" || "$dry" == "1" || "$dry" == "yes" ]]; then
    warn "GITHUB_DRY_RUN is ON — invitations are logged, not sent"
  else
    printf '  %s!%s %sGITHUB_DRY_RUN is OFF — invitations are REAL%s\n' "$R" "$N" "$R" "$N"
  fi

  local backfill
  backfill="$(grep -E '^BACKFILL_ENABLED=' .env | cut -d= -f2- || echo 'true')"
  if [[ "$backfill" == "false" || "$backfill" == "0" || "$backfill" == "no" ]]; then
    printf '  %s·%s Catch-up scan disabled\n' "$D" "$N"
  else
    ok "Catch-up scan on — messages missed while offline will be processed"
  fi
}

preflight() {
  head_ "Preflight"
  check_node
  check_deps
  check_env
  report_mode
}

# --- process control --------------------------------------------------------

# Finds processes belonging to THIS checkout only.
#
# Matching on the project directory is what keeps this from killing unrelated
# node processes. Dev-mode commands embed the path (via node_modules/tsx), while
# a production `node dist/src/index.js` does not -- so that case is confirmed by
# checking the process's working directory instead.
find_bot_pids() {
  local dir="$PWD" pid cwd
  {
    pgrep -f "${dir}.*(src/index\.ts|dist/src/index\.js)" 2>/dev/null || true

    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
      [[ "$cwd" == "$dir" ]] && printf '%s\n' "$pid"
    done < <(pgrep -f 'node .*dist/src/index\.js' 2>/dev/null || true)
  } | sort -un | grep -vx "$$" || true
}

# bash 3.2 (what macOS ships) has no `mapfile`, so collect into an array by hand.
read_pids_into() {
  local __name="$1" __line
  eval "$__name=()"
  while IFS= read -r __line; do
    [[ -n "$__line" ]] && eval "$__name+=(\"\$__line\")"
  done < <(find_bot_pids)
}

describe_pid() {
  ps -p "$1" -o pid=,lstart=,command= 2>/dev/null | sed 's/  */ /g' | cut -c1-110 || true
}

stop_bot() {
  local pids
  read_pids_into pids

  if (( ${#pids[@]} == 0 )); then
    ok "No running instance found"
    return 0
  fi

  printf '  Found %d process(es):\n' "${#pids[@]}"
  local pid
  for pid in "${pids[@]}"; do printf '    %s\n' "$(describe_pid "$pid")"; done

  # SIGTERM first: the bot traps it, closes the gateway cleanly and closes the
  # SQLite handle. Killing outright can leave a stale WAL.
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done

  local waited=0
  while (( waited < 50 )); do
    read_pids_into pids
    (( ${#pids[@]} == 0 )) && { ok "Stopped cleanly"; return 0; }
    sleep 0.1
    waited=$(( waited + 1 ))
  done

  warn "Still running after 5s — sending SIGKILL"
  for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  sleep 0.3

  read_pids_into pids
  if (( ${#pids[@]} == 0 )); then ok "Stopped"; else die "Could not stop: ${pids[*]}"; fi
}

assert_not_running() {
  local pids
  read_pids_into pids
  (( ${#pids[@]} == 0 )) && return 0

  printf '  %s✗%s This bot is already running:\n' "$R" "$N" >&2
  local pid
  for pid in "${pids[@]}"; do printf '    %s\n' "$(describe_pid "$pid")" >&2; done
  printf '\n    Two instances share one token and both reply to everything.\n' >&2
  printf '    Use %s./run.sh restart%s, or %s./run.sh stop%s first.\n\n' "$B" "$N" "$B" "$N" >&2
  exit 1
}

# --- commands ---------------------------------------------------------------

cmd_setup() {
  head_ "Setup"
  check_node
  npm install
  ok "Dependencies installed"

  if [[ -f .env ]]; then
    ok ".env already exists — leaving it alone"
  else
    cp .env.example .env
    chmod 600 .env
    ok "Created .env from .env.example (mode 600)"
  fi

  cat <<EOF

${B}Next:${N}
  1. Fill in .env — see .env.example for where each value comes from.
     GITHUB_APP_PRIVATE_KEY_PATH must be an ${B}absolute${N} path.
  2. ./run.sh check      verify credentials
  3. ./run.sh commands   register slash commands
  4. ./run.sh            start the bot

${D}GITHUB_DRY_RUN defaults to true, so nothing real is sent until you change it.${N}
EOF
}

cmd_check() {
  preflight
  head_ "GitHub"
  npm run --silent check-github
  head_ "Discord"
  npm run --silent doctor
}

cmd_commands() {
  preflight
  head_ "Registering slash commands"
  npm run --silent deploy-commands
}

cmd_test() {
  head_ "Typecheck";    npm run --silent typecheck && ok "No type errors"
  head_ "Tests";        npm run --silent test
  head_ "Formatting";   npm run --silent format:check
}

cmd_stop() {
  head_ "Stopping"
  stop_bot
}

cmd_status() {
  head_ "Status"
  local pids
  read_pids_into pids
  if (( ${#pids[@]} == 0 )); then
    printf '  %s·%s Not running\n' "$D" "$N"
  else
    printf '  %s●%s Running (%d process(es))\n' "$G" "$N" "${#pids[@]}"
    local pid
    for pid in "${pids[@]}"; do printf '    %s\n' "$(describe_pid "$pid")"; done
  fi
}

cmd_restart() {
  head_ "Stopping"
  stop_bot
  cmd_dev
}

cmd_prod() {
  assert_not_running
  preflight
  head_ "Building"
  npm run --silent build
  ok "Built to dist/"
  head_ "Starting (Ctrl-C to stop)"
  exec node dist/src/index.js
}

cmd_dev() {
  assert_not_running
  preflight
  head_ "Starting with watch-reload (Ctrl-C to stop)"
  exec npx tsx watch src/index.ts
}

case "${1:-dev}" in
  dev|"")   cmd_dev ;;
  prod)     cmd_prod ;;
  setup)    cmd_setup ;;
  check)    cmd_check ;;
  commands) cmd_commands ;;
  test)     cmd_test ;;
  stop)     cmd_stop ;;
  status)   cmd_status ;;
  restart)  cmd_restart ;;
  -h|--help|help)
    awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
    ;;
  *) die "Unknown command: $1" "Run ./run.sh --help" ;;
esac
