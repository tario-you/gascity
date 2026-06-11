#!/usr/bin/env bash
# smoke-fresh-repo.sh verifies that a local gc binary can bootstrap a brand-new
# city, add a brand-new git repo as a rig, report status, and cleanly stop.
#
# Defaults are intentionally low-dependency:
#   - GC_BEADS=file unless overridden, so bd/dolt are not required.
#   - GC_HOME is isolated under a temp dir.
#   - HOME is left unchanged because platform supervisors reject fake HOME.
#
# Usage:
#   scripts/smoke-fresh-repo.sh
#   GC_BIN=/path/to/gc scripts/smoke-fresh-repo.sh
#   GC_BEADS=bd scripts/smoke-fresh-repo.sh
#   GC_BEADS=bd GC_SMOKE_CGO_ENABLED=1 scripts/smoke-fresh-repo.sh
#   GC_SMOKE_KEEP=1 scripts/smoke-fresh-repo.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gc-fresh-repo-smoke.XXXXXX")"
WORK_ROOT="$(cd "$WORK_ROOT" && pwd -P)"
GC_HOME_DIR="$WORK_ROOT/gc-home"
RUNTIME_DIR="$WORK_ROOT/runtime"
LOG_DIR="$WORK_ROOT/logs"
CITY_DIR="$WORK_ROOT/city"
PROJECT_DIR="$WORK_ROOT/project"
CITY_TEMPLATE="$WORK_ROOT/city-template.toml"
TIMEOUT="${GC_SMOKE_TIMEOUT:-90}"
BEADS_PROVIDER="${GC_BEADS:-file}"
KEEP="${GC_SMOKE_KEEP:-}"
GC_BIN="${GC_BIN:-}"

mkdir -p "$GC_HOME_DIR" "$RUNTIME_DIR" "$LOG_DIR"

gc_env=(
	"GC_HOME=$GC_HOME_DIR"
	"XDG_RUNTIME_DIR=$RUNTIME_DIR"
	"GC_BEADS=$BEADS_PROVIDER"
	"GC_BEADS_SCOPE_ROOT="
)

fail() {
	echo "FAIL: $*" >&2
	echo "Logs: $LOG_DIR" >&2
	exit 1
}

run_timeout() {
	local seconds="$1"
	shift
	"$@" </dev/null &
	local pid=$!
	(
		sleep "$seconds"
		kill -TERM "$pid" 2>/dev/null || true
		sleep 2
		kill -KILL "$pid" 2>/dev/null || true
	) &
	local watchdog=$!
	local status=0
	wait "$pid" || status=$?
	kill "$watchdog" 2>/dev/null || true
	wait "$watchdog" 2>/dev/null || true
	return "$status"
}

run_step() {
	local name="$1"
	shift
	echo "--- $name ---"
	if run_timeout "$TIMEOUT" "$@" >"$LOG_DIR/$name.out" 2>"$LOG_DIR/$name.err"; then
		echo "PASS $name"
	else
		local status=$?
		echo "STDOUT:" >&2
		tail -40 "$LOG_DIR/$name.out" >&2 || true
		echo "STDERR:" >&2
		tail -80 "$LOG_DIR/$name.err" >&2 || true
		fail "$name exited $status"
	fi
}

run_gc_step() {
	local name="$1"
	shift
	run_step "$name" env "${gc_env[@]}" "$GC_BIN" "$@"
}

append_build_flag() {
	local name="$1"
	local flag="$2"
	local current="${!name:-}"
	case " $current " in
	*" $flag "*) ;;
	*) export "$name=${current:+$current }$flag" ;;
	esac
}

configure_cgo_icu_flags() {
	[[ "${GC_SMOKE_CGO_ENABLED:-0}" != "0" ]] || return 0
	local icu_prefix="${GC_SMOKE_ICU_PREFIX:-}"
	if [[ -z "$icu_prefix" ]] && command -v brew >/dev/null 2>&1; then
		icu_prefix="$(brew --prefix icu4c 2>/dev/null || true)"
	fi
	[[ -n "$icu_prefix" && -d "$icu_prefix/include" && -d "$icu_prefix/lib" ]] || return 0
	append_build_flag CGO_CFLAGS "-I$icu_prefix/include"
	append_build_flag CGO_CPPFLAGS "-I$icu_prefix/include"
	append_build_flag CGO_CXXFLAGS "-I$icu_prefix/include"
	append_build_flag CGO_LDFLAGS "-L$icu_prefix/lib"
}

cleanup() {
	local status=$?
	if [[ -n "${GC_BIN:-}" && -x "${GC_BIN:-}" ]]; then
		run_timeout 20 env "${gc_env[@]}" "$GC_BIN" supervisor stop --wait --wait-timeout 15s \
			>"$LOG_DIR/supervisor-stop.out" 2>"$LOG_DIR/supervisor-stop.err" || true
		run_timeout 20 env "${gc_env[@]}" "$GC_BIN" supervisor uninstall \
			>"$LOG_DIR/supervisor-uninstall.out" 2>"$LOG_DIR/supervisor-uninstall.err" || true
	fi
	if [[ -n "$KEEP" ]]; then
		echo "Kept smoke workspace: $WORK_ROOT"
	else
		rm -rf "$WORK_ROOT"
	fi
	exit "$status"
}
trap cleanup EXIT

cd "$ROOT"

echo "=== Gas City Fresh Repo Smoke ==="
echo "Workspace:      $WORK_ROOT"
echo "GC_HOME:        $GC_HOME_DIR"
echo "Beads provider: $BEADS_PROVIDER"
echo "Timeout:        ${TIMEOUT}s"
echo ""

if [[ -z "$GC_BIN" ]]; then
	GC_BIN="$WORK_ROOT/bin/gc"
	mkdir -p "$(dirname "$GC_BIN")"
	echo "--- build-gc ---"
	configure_cgo_icu_flags
	if CGO_ENABLED="${GC_SMOKE_CGO_ENABLED:-0}" go build -o "$GC_BIN" ./cmd/gc \
		>"$LOG_DIR/build-gc.out" 2>"$LOG_DIR/build-gc.err"; then
		echo "PASS build-gc"
	else
		echo "STDOUT:" >&2
		tail -40 "$LOG_DIR/build-gc.out" >&2 || true
		echo "STDERR:" >&2
		tail -80 "$LOG_DIR/build-gc.err" >&2 || true
		fail "build-gc failed; set GC_BIN=/path/to/gc to smoke an installed binary"
	fi
elif [[ "$GC_BIN" != /* ]]; then
	GC_BIN="$ROOT/$GC_BIN"
fi

[[ -x "$GC_BIN" ]] || fail "GC_BIN is not executable: $GC_BIN"

run_gc_step version version

mkdir -p "$PROJECT_DIR"
git -C "$PROJECT_DIR" init -q
printf '# Smoke project\n' >"$PROJECT_DIR/README.md"
git -C "$PROJECT_DIR" add README.md
git -C "$PROJECT_DIR" \
	-c user.name="Gas City Smoke" \
	-c user.email="smoke@gascity.local" \
	commit -qm "initial smoke project"

cat >"$CITY_TEMPLATE" <<EOF
[workspace]
name = "city"

[beads]
provider = "$BEADS_PROVIDER"
EOF

run_gc_step init-city init --file "$CITY_TEMPLATE" --skip-provider-readiness --yes "$CITY_DIR"
run_gc_step city-status-json status --json "$CITY_DIR"
jq -e '.ok == true and (.city_path | endswith("/city"))' \
	"$LOG_DIR/city-status-json.out" >/dev/null || fail "status JSON did not describe the temp city"

run_gc_step cities-list-json cities list --json
jq -e '[(.cities // [])[] | select(.path | endswith("/city"))] | length == 1' \
	"$LOG_DIR/cities-list-json.out" >/dev/null || fail "temp city was not registered"

echo "--- rig-add ---"
if (
	cd "$CITY_DIR"
	run_timeout "$TIMEOUT" env "${gc_env[@]}" "$GC_BIN" rig add "$PROJECT_DIR" --name smoke-project --prefix smk --start-suspended \
		>"$LOG_DIR/rig-add.out" 2>"$LOG_DIR/rig-add.err"
); then
	echo "PASS rig-add"
else
	echo "STDOUT:" >&2
	tail -40 "$LOG_DIR/rig-add.out" >&2 || true
	echo "STDERR:" >&2
	tail -80 "$LOG_DIR/rig-add.err" >&2 || true
	fail "rig-add failed"
fi

run_step city-status-after-rig env "${gc_env[@]}" GC_NO_API=1 "$GC_BIN" status --json "$CITY_DIR"
jq -e '[(.rigs // [])[] | select(.path | endswith("/project"))] | length == 1' \
	"$LOG_DIR/city-status-after-rig.out" >/dev/null || fail "status JSON did not include the rig"

for path in \
	.gc/beads.json \
	.beads/.env \
	.beads/.local_version \
	.beads/dolt-server.port \
	.beads/dolt/db; do
	git -C "$PROJECT_DIR" check-ignore -q "$path" || fail "$path is not ignored in the rig repo"
done

echo "--- doctor ---"
if (
	cd "$CITY_DIR"
	run_timeout "$TIMEOUT" env "${gc_env[@]}" "$GC_BIN" doctor \
		>"$LOG_DIR/doctor.out" 2>"$LOG_DIR/doctor.err"
); then
	echo "PASS doctor"
else
	echo "STDOUT:" >&2
	tail -40 "$LOG_DIR/doctor.out" >&2 || true
	echo "STDERR:" >&2
	tail -80 "$LOG_DIR/doctor.err" >&2 || true
	fail "doctor failed"
fi

echo ""
echo "Fresh repo smoke passed."
