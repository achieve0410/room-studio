#!/bin/sh

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P) || exit 1
LOOPBACK_HOST=${ROOM_STUDIO_LOOPBACK_HOST:-127.0.0.1}
LOOPBACK_PORT=${ROOM_STUDIO_LOOPBACK_PORT:-4173}
TAILSCALE_HOST=${ROOM_STUDIO_TAILSCALE_HOST:-}
HTTPS_PORT=${ROOM_STUDIO_HTTPS_PORT:-8443}
DEFAULT_RUNTIME_DIR="$ROOT/.room-studio/runtime"
LEGACY_RUNTIME_DIR="$ROOT/.omx/runtime/room-studio"
if [ -n "${ROOM_STUDIO_RUNTIME_DIR:-}" ]; then
  RUNTIME_DIR=$ROOM_STUDIO_RUNTIME_DIR
elif [ "$LOOPBACK_PORT" = "4173" ] && [ "$HTTPS_PORT" = "8443" ] \
  && [ -f "$LEGACY_RUNTIME_DIR/preview.pid" ] && [ ! -f "$DEFAULT_RUNTIME_DIR/preview.pid" ]; then
  RUNTIME_DIR=$LEGACY_RUNTIME_DIR
elif [ "$LOOPBACK_PORT" != "4173" ] || [ "$HTTPS_PORT" != "8443" ]; then
  RUNTIME_DIR="$ROOT/.room-studio/runtime-$LOOPBACK_PORT-$HTTPS_PORT"
else
  RUNTIME_DIR=$DEFAULT_RUNTIME_DIR
fi
PID_FILE="$RUNTIME_DIR/preview.pid"
LOG_FILE="$RUNTIME_DIR/preview.log"
VITE_BIN="$ROOT/node_modules/.bin/vite"
STARTED_PREVIEW_PID=''
TAILSCALE_STATUS_TEXT=''

die() {
  printf '%s\n' "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_tools() {
  need lsof
  need node
  need ps
  need curl
  need tailscale
  is_numeric "$LOOPBACK_PORT" || die "ROOM_STUDIO_LOOPBACK_PORT must be numeric"
  is_numeric "$HTTPS_PORT" || die "ROOM_STUDIO_HTTPS_PORT must be numeric"
  [ "$LOOPBACK_PORT" -ge 1 ] && [ "$LOOPBACK_PORT" -le 65535 ] \
    || die "ROOM_STUDIO_LOOPBACK_PORT must be between 1 and 65535"
  [ "$HTTPS_PORT" -ge 1 ] && [ "$HTTPS_PORT" -le 65535 ] \
    || die "ROOM_STUDIO_HTTPS_PORT must be between 1 and 65535"
  detect_tailscale_host
}

is_numeric() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

detect_tailscale_host() {
  if [ -z "$TAILSCALE_HOST" ]; then
    TAILSCALE_HOST=$(tailscale status --json 2>/dev/null | node -e "
      let input = '';
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => {
        try {
          process.stdout.write(String(JSON.parse(input).Self?.DNSName ?? '').replace(/\.$/, ''));
        } catch {
          process.exitCode = 1;
        }
      });
    ") || die "cannot detect the Tailscale MagicDNS host; set ROOM_STUDIO_TAILSCALE_HOST"
  fi
  TAILSCALE_HOST=${TAILSCALE_HOST%.}
  case "$TAILSCALE_HOST" in
    ''|*[!A-Za-z0-9.-]*) die "invalid ROOM_STUDIO_TAILSCALE_HOST: $TAILSCALE_HOST" ;;
  esac
}

pid_alive() {
  is_numeric "$1" && kill -0 "$1" 2>/dev/null
}

pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p'
}

pid_command() {
  ps -p "$1" -o command= 2>/dev/null | sed -n '1p'
}

listener_pids() {
  lsof -nP -tiTCP:"$LOOPBACK_PORT" -sTCP:LISTEN 2>/dev/null | sort -u
}

pid_has_expected_command() {
  cmd=$(pid_command "$1")
  case "$cmd" in
    *"$VITE_BIN preview --host $LOOPBACK_HOST --port $LOOPBACK_PORT --strictPort"|*"$ROOT/node_modules/vite/bin/vite.js preview --host $LOOPBACK_HOST --port $LOOPBACK_PORT --strictPort") ;;
    *) return 1 ;;
  esac
  return 0
}

validate_preview_identity() {
  pid=$1
  pid_alive "$pid" || return 1
  cwd=$(pid_cwd "$pid")
  [ "$cwd" = "$ROOT" ] || return 1
  pid_has_expected_command "$pid" || return 1
  return 0
}

validate_preview_pid() {
  pid=$1
  validate_preview_identity "$pid" || return 1
  [ "$(listener_pids)" = "$pid" ] || return 1
  return 0
}

serve_status_has_listener() {
  listener="https://$TAILSCALE_HOST"
  [ "$HTTPS_PORT" = "443" ] || listener="$listener:$HTTPS_PORT"
  awk -v listener="$listener" '
    $1 == listener { found = 1 }
    END { if (found) exit 0; exit 1 }
  '
}

serve_status_has_port() {
  awk -v port="$HTTPS_PORT" -v suffix=":$HTTPS_PORT" '
    $1 ~ /^https:\/\// {
      if (port == "443" && $1 !~ /:[0-9]+$/) found = 1
      if (port != "443" && index($1, suffix) == length($1) - length(suffix) + 1) found = 1
    }
    END { if (found) exit 0; exit 1 }
  '
}

serve_status_has_expected_listener() {
  header="https://$TAILSCALE_HOST"
  [ "$HTTPS_PORT" = "443" ] || header="$header:$HTTPS_PORT"
  header="$header (tailnet only)"
  awk \
    -v header="$header" \
    -v proxy="|-- / proxy http://$LOOPBACK_HOST:$LOOPBACK_PORT" '
      previous == header && $0 == proxy { found = 1 }
      { previous = $0 }
      END { if (found) exit 0; exit 1 }
    '
}

serve_status_has_expected_proxy() {
  awk \
    -v port="$HTTPS_PORT" \
    -v suffix=":$HTTPS_PORT" \
    -v proxy="|-- / proxy http://$LOOPBACK_HOST:$LOOPBACK_PORT" '
      {
        if (previous ~ /^https:\/\// && $0 == proxy) {
          listener = substr(previous, 1, index(previous, " ") - 1)
          if (port == "443" && listener !~ /:[0-9]+$/) found = 1
          if (port != "443" && index(previous, suffix) > 0 && index(previous, suffix) == index(previous, " ") - length(suffix)) found = 1
        }
        previous = $0
      }
      END { if (found) exit 0; exit 1 }
    '
}

load_tailscale_status() {
  TAILSCALE_STATUS_TEXT=$(tailscale serve status 2>&1)
}

tailscale_port_configured() {
  load_tailscale_status || return 2
  printf '%s\n' "$TAILSCALE_STATUS_TEXT" | serve_status_has_port
}

tailscale_expected_proxy_configured() {
  load_tailscale_status || return 2
  printf '%s\n' "$TAILSCALE_STATUS_TEXT" | serve_status_has_expected_proxy
}

tailscale_listener_healthy() {
  load_tailscale_status || return 2
  printf '%s\n' "$TAILSCALE_STATUS_TEXT" | serve_status_has_expected_listener
}

host_header_ok() {
  http_code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    -H "Host: $TAILSCALE_HOST" "http://$LOOPBACK_HOST:$LOOPBACK_PORT/" 2>/dev/null) || return 1
  [ "$http_code" = "200" ]
}

magicdns_ok() {
  http_code=$(curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' \
    "https://$TAILSCALE_HOST:$HTTPS_PORT/" 2>/dev/null) || return 1
  [ "$http_code" = "200" ]
}

disable_https_listener() {
  tailscale serve --https="$HTTPS_PORT" off
}

wait_for_valid_preview() {
  pid=$1
  i=0
  while [ "$i" -lt 100 ]; do
    pid_alive "$pid" || return 1
    if validate_preview_pid "$pid" && host_header_ok; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.1
  done
  return 1
}

terminate_validated_child() {
  child_pid=$1
  pid_alive "$child_pid" || return 0
  validate_preview_identity "$child_pid" || return 1
  if ! kill "$child_pid" 2>/dev/null; then
    pid_alive "$child_pid" && return 1
    return 0
  fi
  i=0
  while [ "$i" -lt 50 ]; do
    pid_alive "$child_pid" || return 0
    i=$((i + 1))
    sleep 0.1
  done
  validate_preview_identity "$child_pid" || return 1
  if ! kill -KILL "$child_pid" 2>/dev/null; then
    pid_alive "$child_pid" && return 1
    return 0
  fi
  i=0
  while [ "$i" -lt 50 ]; do
    pid_alive "$child_pid" || return 0
    i=$((i + 1))
    sleep 0.1
  done
  return 1
}

rollback_start_failure() {
  rollback_message=$1
  rollback_child_pid=$2
  rollback_tailscale=$3
  rollback_incomplete=0

  if [ "$rollback_tailscale" = "yes" ]; then
    if tailscale_expected_proxy_configured; then
      if ! disable_https_listener >/dev/null; then
        printf '%s\n' "rollback: disabling Tailscale HTTPS $HTTPS_PORT returned nonzero; verifying exact status" >&2
      fi
    else
      printf '%s\n' "error: rollback refused to disable HTTPS $HTTPS_PORT because its proxy does not match this checkout" >&2
      rollback_incomplete=1
    fi
  fi

  tailscale_port_configured
  rollback_status=$?
  case "$rollback_status" in
    0)
      printf '%s\n' "error: rollback verification found HTTPS $HTTPS_PORT still configured" >&2
      rollback_incomplete=1
      ;;
    1) ;;
    *)
      printf '%s\n' "error: rollback could not verify HTTPS $HTTPS_PORT is absent" >&2
      [ -n "$TAILSCALE_STATUS_TEXT" ] && printf '%s\n' "$TAILSCALE_STATUS_TEXT" >&2
      rollback_incomplete=1
      ;;
  esac

  if [ -n "$rollback_child_pid" ]; then
    if terminate_validated_child "$rollback_child_pid"; then
      if [ -f "$PID_FILE" ] && [ "$(sed -n '1p' "$PID_FILE" 2>/dev/null)" = "$rollback_child_pid" ]; then
        rm -f "$PID_FILE" || rollback_incomplete=1
      fi
    else
      printf '%s\n' "error: rollback could not confirm preview PID $rollback_child_pid stopped; PID metadata retained" >&2
      rollback_incomplete=1
    fi
  fi

  if [ "$rollback_incomplete" -ne 0 ]; then
    die "$rollback_message; rollback incomplete"
  fi
  die "$rollback_message; rollback complete"
}

start_preview_child() {
  mkdir -p "$RUNTIME_DIR" || die "cannot create runtime dir: $RUNTIME_DIR"
  [ -x "$VITE_BIN" ] || die "missing executable Vite binary: $VITE_BIN"
  old_pwd=$(pwd) || die "cannot read current directory"
  cd "$ROOT" || die "cannot enter repo root: $ROOT"
  ROOM_STUDIO_ALLOWED_HOSTS="$TAILSCALE_HOST" nohup "$VITE_BIN" preview --host "$LOOPBACK_HOST" --port "$LOOPBACK_PORT" --strictPort \
    >> "$LOG_FILE" 2>&1 < /dev/null &
  STARTED_PREVIEW_PID=$!
  cd "$old_pwd" || die "cannot restore working directory: $old_pwd"
  is_numeric "$STARTED_PREVIEW_PID" || die "Vite preview returned invalid PID: $STARTED_PREVIEW_PID"
}

preflight_preview_port() {
  owned_pid=''
  for pid in $(listener_pids); do
    if validate_preview_pid "$pid"; then
      [ -z "$owned_pid" ] && owned_pid=$pid
    else
      die "$LOOPBACK_HOST:$LOOPBACK_PORT is occupied by unowned PID $pid"
    fi
  done
  [ -n "$owned_pid" ] && printf '%s\n' "$owned_pid"
  return 0
}

clean_dead_pid_metadata() {
  [ -f "$PID_FILE" ] || return 0
  pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null)
  is_numeric "$pid" || return 0
  pid_alive "$pid" && return 0
  rm -f "$PID_FILE"
}

cmd_start() {
  require_tools
  tailscale_port_configured
  tailscale_state=$?
  case "$tailscale_state" in
    0) die "Tailscale HTTPS $HTTPS_PORT already has a handler" ;;
    1) ;;
    *) die "cannot inspect Tailscale serve status" ;;
  esac

  existing_pid=$(preflight_preview_port) || exit 1
  if [ -n "$existing_pid" ]; then
    host_header_ok || die "existing validated preview PID $existing_pid did not return HTTP 200"
    mkdir -p "$RUNTIME_DIR" || die "cannot create runtime dir: $RUNTIME_DIR"
    printf '%s\n' "$existing_pid" > "$PID_FILE.tmp" && mv "$PID_FILE.tmp" "$PID_FILE" \
      || die "cannot write PID metadata"
    preview_pid=$existing_pid
    started_child=''
  else
    clean_dead_pid_metadata
    start_preview_child
    preview_pid=$STARTED_PREVIEW_PID
    started_child=$preview_pid
    if ! wait_for_valid_preview "$preview_pid"; then
      rollback_start_failure "Vite preview did not pass ownership and HTTP checks; see $LOG_FILE" "$preview_pid" no
    fi
    printf '%s\n' "$preview_pid" > "$PID_FILE.tmp" && mv "$PID_FILE.tmp" "$PID_FILE" \
      || {
        rollback_start_failure "cannot write PID metadata" "$preview_pid" no
      }
  fi

  if ! tailscale serve --bg --https="$HTTPS_PORT" "http://$LOOPBACK_HOST:$LOOPBACK_PORT"; then
    rollback_start_failure "failed to configure Tailscale HTTPS $HTTPS_PORT" "$started_child" yes
  fi

  if ! tailscale_listener_healthy; then
    rollback_start_failure "HTTPS $HTTPS_PORT is not the expected tailnet-only root proxy" "$started_child" yes
  fi

  if ! magicdns_ok; then
    rollback_start_failure "MagicDNS HTTPS check did not return HTTP 200" "$started_child" yes
  fi

  printf 'running: https://%s:%s (preview PID %s)\n' "$TAILSCALE_HOST" "$HTTPS_PORT" "$preview_pid"
}

cmd_stop() {
  require_tools
  tailscale_port_configured
  tailscale_state=$?
  case "$tailscale_state" in
    0)
      tailscale_expected_proxy_configured \
        || die "refusing to disable Tailscale HTTPS $HTTPS_PORT because its proxy does not match this checkout"
      [ -f "$PID_FILE" ] \
        || die "refusing to disable Tailscale HTTPS $HTTPS_PORT without preview PID metadata"
      stop_pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null)
      is_numeric "$stop_pid" && validate_preview_pid "$stop_pid" \
        || die "refusing to disable Tailscale HTTPS $HTTPS_PORT without a validated preview process"
      disable_https_listener || die "failed to disable Tailscale HTTPS $HTTPS_PORT"
      ;;
    1) ;;
    *) die "cannot inspect Tailscale serve status" ;;
  esac

  if [ ! -f "$PID_FILE" ]; then
    printf '%s\n' "no preview PID metadata"
    return 0
  fi

  pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null)
  is_numeric "$pid" || die "refusing invalid PID metadata in $PID_FILE"

  if ! pid_alive "$pid"; then
    rm -f "$PID_FILE"
    printf 'removed stale preview PID metadata: %s\n' "$pid"
    return 0
  fi

  validate_preview_pid "$pid" || die "refusing to kill unrecognized or reused PID $pid"
  kill "$pid" 2>/dev/null || die "failed to terminate preview PID $pid"
  i=0
  while [ "$i" -lt 50 ]; do
    if ! pid_alive "$pid"; then
      rm -f "$PID_FILE"
      printf 'stopped preview PID %s\n' "$pid"
      return 0
    fi
    i=$((i + 1))
    sleep 0.1
  done
  validate_preview_pid "$pid" || die "preview PID $pid changed identity while stopping"
  kill -KILL "$pid" 2>/dev/null || die "failed to force-stop preview PID $pid"
  rm -f "$PID_FILE"
  printf 'force-stopped preview PID %s\n' "$pid"
}

cmd_status() {
  require_tools
  status_failed=0
  printf '%s\n' "Tailscale serve status:"
  if load_tailscale_status; then
    printf '%s\n' "$TAILSCALE_STATUS_TEXT"
    if printf '%s\n' "$TAILSCALE_STATUS_TEXT" | serve_status_has_expected_listener; then
      printf '%s\n' "HTTPS $HTTPS_PORT: exact tailnet-only root proxy validated"
      tailscale_ready=1
    else
      printf '%s\n' "HTTPS $HTTPS_PORT: expected tailnet-only root proxy is absent or mismatched"
      status_failed=1
      tailscale_ready=0
    fi
  else
    [ -n "$TAILSCALE_STATUS_TEXT" ] && printf '%s\n' "$TAILSCALE_STATUS_TEXT"
    printf '%s\n' "HTTPS $HTTPS_PORT: cannot inspect Tailscale serve status"
    status_failed=1
    tailscale_ready=0
  fi
  printf '\n'

  if [ -f "$PID_FILE" ]; then
    pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null)
    if is_numeric "$pid" && validate_preview_pid "$pid"; then
      printf 'preview: running (validated PID %s)\n' "$pid"
      if host_header_ok; then
        printf '%s\n' "local Host request: HTTP 200"
      else
        printf '%s\n' "local Host request: unhealthy"
        status_failed=1
      fi
    elif is_numeric "$pid" && pid_alive "$pid"; then
      printf 'preview: PID metadata exists but PID %s is not recognized as this preview\n' "$pid"
      status_failed=1
    elif is_numeric "$pid"; then
      printf 'preview: stopped (stale PID metadata %s)\n' "$pid"
      status_failed=1
    else
      printf 'preview: invalid PID metadata in %s\n' "$PID_FILE"
      status_failed=1
    fi
  else
    printf '%s\n' "preview: no PID metadata"
    status_failed=1
  fi

  pids=$(listener_pids)
  if [ -n "$pids" ]; then
    printf 'listener %s:%s: %s\n' "$LOOPBACK_HOST" "$LOOPBACK_PORT" "$pids"
  else
    printf 'listener %s:%s: none\n' "$LOOPBACK_HOST" "$LOOPBACK_PORT"
  fi

  if [ "$tailscale_ready" -eq 1 ]; then
    if magicdns_ok; then
      printf '%s\n' "MagicDNS: HTTP 200"
    else
      printf '%s\n' "MagicDNS: unhealthy"
      status_failed=1
    fi
  else
    printf '%s\n' "MagicDNS: not checked without the exact HTTPS $HTTPS_PORT handler"
  fi

  [ "$status_failed" -eq 0 ]
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *) die "usage: $0 start|stop|status" ;;
esac
