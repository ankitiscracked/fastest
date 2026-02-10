#!/usr/bin/env bash
set -euo pipefail

# =========================================
#  fst CLI — End-to-End Workflow Tests
# =========================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"
FST=""
BUILD_DIR=""

PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()

TEST_DIR=""
TEST_FAILED=0
OUTPUT=""
LAST_EXIT=0

# Colors (for test runner output only)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ---- build ----

build_fst() {
    BUILD_DIR="$(mktemp -d)"
    printf "Building fst binary... "
    (cd "$CLI_DIR" && go build -o "$BUILD_DIR/fst" ./cmd/fst) 2>&1
    FST="$BUILD_DIR/fst"
    echo "done"
}

# ---- test lifecycle ----

setup_test() {
    TEST_DIR="$(mktemp -d)"
    TEST_FAILED=0
    cd "$TEST_DIR"

    # Pre-create author config so snapshot never launches TUI prompt
    mkdir -p "$TEST_DIR/.config/fst"
    cat > "$TEST_DIR/.config/fst/author.json" <<'JSON'
{"name":"Test User","email":"test@example.com"}
JSON
    export XDG_CONFIG_HOME="$TEST_DIR/.config"
    export XDG_CACHE_HOME="$TEST_DIR/.cache"
    export NO_COLOR=1
}

teardown_test() {
    if [[ -n "${TEST_DIR:-}" && -d "$TEST_DIR" ]]; then
        rm -rf "$TEST_DIR"
    fi
}

# ---- run fst without aborting on error ----

run_fst() {
    local exit_code=0
    OUTPUT=$("$FST" "$@" 2>&1) || exit_code=$?
    LAST_EXIT=$exit_code
    return 0
}

# ---- assertions ----

fail() {
    echo -e "    ${RED}FAIL${NC}: $1"
    TEST_FAILED=1
}

assert_exit_code() {
    local expected="$1"
    if [[ "$LAST_EXIT" -ne "$expected" ]]; then
        fail "expected exit code $expected, got $LAST_EXIT"
        echo "    output (first 5 lines):"
        echo "$OUTPUT" | head -5 | sed 's/^/      /'
    fi
}

assert_contains() {
    local needle="$1"
    if ! echo "$OUTPUT" | grep -qF "$needle"; then
        fail "output does not contain '$needle'"
        echo "    output (first 10 lines):"
        echo "$OUTPUT" | head -10 | sed 's/^/      /'
    fi
}

assert_not_contains() {
    local needle="$1"
    if echo "$OUTPUT" | grep -qF "$needle"; then
        fail "output should not contain '$needle'"
    fi
}

assert_file_exists() {
    if [[ ! -f "$1" ]]; then
        fail "file does not exist: $1"
    fi
}

assert_file_contains() {
    local path="$1" needle="$2"
    if [[ ! -f "$path" ]]; then
        fail "file does not exist: $path"
    elif ! grep -qF "$needle" "$path"; then
        fail "file '$path' does not contain '$needle'"
    fi
}

assert_file_not_contains() {
    local path="$1" needle="$2"
    if [[ -f "$path" ]] && grep -qF "$needle" "$path"; then
        fail "file '$path' should not contain '$needle'"
    fi
}

assert_json_valid() {
    if ! echo "$OUTPUT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        fail "output is not valid JSON"
        echo "    output (first 5 lines):"
        echo "$OUTPUT" | head -5 | sed 's/^/      /'
    fi
}

assert_json_field() {
    local field="$1" expected="$2"
    local actual
    actual=$(echo "$OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$field',''))" 2>/dev/null) || {
        fail "failed to parse JSON for field '$field'"
        return
    }
    if [[ "$actual" != "$expected" ]]; then
        fail "JSON .$field: expected '$expected', got '$actual'"
    fi
}

# ---- snapshot ID extraction ----

extract_snapshot_id() {
    echo "$OUTPUT" | grep 'ID:' | head -1 | awk '{print $2}'
}

read_config_field() {
    local file="$1" field="$2"
    python3 -c "import json; print(json.load(open('$file')).get('$field',''))"
}

# =========================================
#  Test functions
# =========================================

test_bootstrap() {
    setup_test

    # Create project
    run_fst project create myproject --no-snapshot
    assert_exit_code 0
    assert_contains "Project created"

    cd "$TEST_DIR/myproject/main"

    # Status
    run_fst status
    assert_exit_code 0
    assert_contains "main"

    # Status JSON
    run_fst status --json
    assert_exit_code 0
    assert_json_valid
    assert_json_field "workspace_name" "main"

    # Create file and snapshot
    echo "hello world" > hello.txt
    run_fst snapshot -m "first snapshot"
    assert_exit_code 0
    assert_contains "Snapshot created"

    # Log
    run_fst log
    assert_exit_code 0
    assert_contains "first snapshot"

    teardown_test
}

test_branching_and_merge() {
    setup_test

    run_fst project create myproject --no-snapshot
    assert_exit_code 0
    cd "$TEST_DIR/myproject/main"

    # Shared base file with multiple lines
    cat > app.txt <<'EOF'
line1: original header
line2: shared content
line3: shared content
line4: shared content
line5: original footer
EOF
    run_fst snapshot -m "base snapshot"
    assert_exit_code 0

    # Fork
    run_fst workspace create feature
    assert_exit_code 0
    assert_contains "Workspace created"

    # Feature: change the LAST line (non-overlapping with main's change)
    cd "$TEST_DIR/myproject/feature"
    sed -i.bak 's/line5: original footer/line5: FEATURE FOOTER/' app.txt && rm -f app.txt.bak
    run_fst snapshot -m "feature work"
    assert_exit_code 0

    # Main: change the FIRST line (non-overlapping with feature's change)
    cd "$TEST_DIR/myproject/main"
    sed -i.bak 's/line1: original header/line1: MAIN HEADER/' app.txt && rm -f app.txt.bak
    run_fst snapshot -m "main work"
    assert_exit_code 0

    # Drift should detect changes
    run_fst drift feature
    assert_exit_code 1

    # Diff names-only
    run_fst diff feature --names-only
    assert_exit_code 1
    assert_contains "app.txt"

    # Merge: same file, different lines → line-level auto-merge
    run_fst merge feature
    assert_exit_code 0
    assert_contains "Merge complete"
    assert_contains "Auto-merged"

    # Verify the merged file has BOTH changes
    assert_file_contains "$TEST_DIR/myproject/main/app.txt" "MAIN HEADER"
    assert_file_contains "$TEST_DIR/myproject/main/app.txt" "FEATURE FOOTER"

    teardown_test
}

test_merge_conflict_resolution() {
    setup_test

    run_fst project create myproject --no-snapshot
    assert_exit_code 0
    cd "$TEST_DIR/myproject/main"

    cat > config.txt <<'EOF'
setting_a = 1
setting_b = 2
setting_c = 3
EOF
    run_fst snapshot -m "initial config"
    assert_exit_code 0

    run_fst workspace create branch
    assert_exit_code 0

    # Branch: change setting_b
    cd "$TEST_DIR/myproject/branch"
    sed -i.bak 's/setting_b = 2/setting_b = BRANCH_VALUE/' config.txt && rm -f config.txt.bak
    run_fst snapshot -m "branch config"
    assert_exit_code 0

    # Main: change same line differently
    cd "$TEST_DIR/myproject/main"
    sed -i.bak 's/setting_b = 2/setting_b = MAIN_VALUE/' config.txt && rm -f config.txt.bak
    run_fst snapshot -m "main config"
    assert_exit_code 0

    # Dry-run shows conflicts (exit 0 for dry-run)
    run_fst merge branch --dry-run
    assert_exit_code 0
    assert_contains "config.txt"

    # Merge --theirs resolves with their version
    run_fst merge branch --theirs
    assert_exit_code 0
    assert_contains "Merge complete"

    assert_file_contains "$TEST_DIR/myproject/main/config.txt" "BRANCH_VALUE"
    assert_file_not_contains "$TEST_DIR/myproject/main/config.txt" "MAIN_VALUE"

    teardown_test
}

test_snapshot_history() {
    setup_test

    run_fst project create myproject --no-snapshot
    assert_exit_code 0
    cd "$TEST_DIR/myproject/main"

    echo "v1" > data.txt
    run_fst snapshot -m "version one"
    assert_exit_code 0

    echo "v2" > data.txt
    run_fst snapshot -m "version two"
    assert_exit_code 0

    echo "v3" > data.txt
    run_fst snapshot -m "version three"
    assert_exit_code 0

    # Log shows all
    run_fst log
    assert_exit_code 0
    assert_contains "version one"
    assert_contains "version two"
    assert_contains "version three"

    # Log limit
    run_fst log -n 1
    assert_exit_code 0
    assert_contains "version three"
    assert_not_contains "version one"

    # Dirty change + dry-run rollback
    echo "v4-dirty" > data.txt
    run_fst rollback --dry-run
    assert_exit_code 0
    assert_contains "dry run"
    assert_file_contains "$TEST_DIR/myproject/main/data.txt" "v4-dirty"

    # Actual rollback
    run_fst rollback --force
    assert_exit_code 0
    assert_contains "Restored"
    assert_file_contains "$TEST_DIR/myproject/main/data.txt" "v3"
    assert_file_not_contains "$TEST_DIR/myproject/main/data.txt" "v4-dirty"

    teardown_test
}

test_history_rewrite() {
    setup_test

    run_fst project create myproject --no-snapshot
    assert_exit_code 0
    cd "$TEST_DIR/myproject/main"

    echo "snap1" > file.txt
    run_fst snapshot -m "first commit"
    assert_exit_code 0
    local SNAP1
    SNAP1=$(extract_snapshot_id)

    echo "snap2" > file.txt
    run_fst snapshot -m "second commit"
    assert_exit_code 0
    local SNAP2
    SNAP2=$(extract_snapshot_id)

    echo "snap3" > file.txt
    run_fst snapshot -m "third commit"
    assert_exit_code 0
    local SNAP3
    SNAP3=$(extract_snapshot_id)

    # Edit message
    run_fst edit "$SNAP2" -m "edited message"
    assert_exit_code 0
    assert_contains "Updated snapshot"

    run_fst log
    assert_exit_code 0
    assert_contains "edited message"
    assert_not_contains "second commit"

    # After edit, IDs in the chain are rewritten. Read the current head.
    local CURRENT_ID
    CURRENT_ID=$(read_config_field .fst/config.json current_snapshot_id)

    # Walk the chain to find the oldest snapshot
    local chain_ids=()
    local walk_id="$CURRENT_ID"
    while [[ -n "$walk_id" ]]; do
        chain_ids+=("$walk_id")
        # Find the meta file and read parent
        local meta_files
        meta_files=$(find "$TEST_DIR/myproject/.fst/snapshots" -name "${walk_id}.meta.json" 2>/dev/null || true)
        if [[ -z "$meta_files" ]]; then
            break
        fi
        local parent
        parent=$(python3 -c "
import json
m = json.load(open('$meta_files'))
parents = m.get('parent_snapshot_ids', [])
print(parents[0] if parents else '')
" 2>/dev/null) || break
        walk_id="$parent"
    done

    local oldest="${chain_ids[${#chain_ids[@]}-1]}"
    local newest="${chain_ids[0]}"

    if [[ ${#chain_ids[@]} -ge 2 ]]; then
        run_fst squash "${oldest}..${newest}" -m "squashed all"
        assert_exit_code 0
        assert_contains "Squashed"

        run_fst log
        assert_exit_code 0
        assert_contains "squashed all"
    else
        fail "could not find enough snapshots in chain for squash (found ${#chain_ids[@]})"
    fi

    teardown_test
}

test_info_commands() {
    setup_test

    run_fst project create myproject --no-snapshot
    assert_exit_code 0
    cd "$TEST_DIR/myproject/main"

    echo "data" > file.txt
    run_fst snapshot -m "initial"
    assert_exit_code 0

    run_fst workspace create secondary
    assert_exit_code 0

    # Info from workspace
    cd "$TEST_DIR/myproject/main"
    run_fst info
    assert_exit_code 0
    assert_contains "main"

    # Info JSON
    run_fst info --json
    assert_exit_code 0
    assert_json_valid
    assert_json_field "workspace_name" "main"

    # Info workspaces
    run_fst info workspaces
    assert_exit_code 0
    assert_contains "main"
    assert_contains "secondary"

    # Info project
    run_fst info project
    assert_exit_code 0
    assert_contains "myproject"
    assert_contains "Workspaces"

    # Info workspace by name
    run_fst info workspace main
    assert_exit_code 0
    assert_contains "main"

    teardown_test
}

test_git_export() {
    setup_test

    export GIT_AUTHOR_NAME="Test User"
    export GIT_AUTHOR_EMAIL="test@example.com"
    export GIT_COMMITTER_NAME="Test User"
    export GIT_COMMITTER_EMAIL="test@example.com"

    run_fst project create myproject --no-snapshot
    assert_exit_code 0
    cd "$TEST_DIR/myproject/main"

    echo "v1" > file.txt
    run_fst snapshot -m "snapshot one"
    assert_exit_code 0

    echo "v2" > file.txt
    run_fst snapshot -m "snapshot two"
    assert_exit_code 0

    # Export to git
    run_fst git export --init
    assert_exit_code 0
    assert_contains "Exported"

    # Verify git repo was created with commits
    assert_file_exists "$TEST_DIR/myproject/main/.git/HEAD"
    local git_log
    git_log=$(cd "$TEST_DIR/myproject/main" && git log --oneline 2>&1)
    if ! echo "$git_log" | grep -qF "snapshot one"; then
        fail "git log missing 'snapshot one'"
    fi
    if ! echo "$git_log" | grep -qF "snapshot two"; then
        fail "git log missing 'snapshot two'"
    fi

    # Incremental export (no new commits)
    run_fst git export
    assert_exit_code 0
    assert_contains "up to date"

    teardown_test
}

test_gc() {
    setup_test

    run_fst project create myproject --no-snapshot
    assert_exit_code 0
    cd "$TEST_DIR/myproject/main"

    echo "v1" > file.txt
    run_fst snapshot -m "gc snap one"
    assert_exit_code 0

    echo "v2" > file.txt
    run_fst snapshot -m "gc snap two"
    assert_exit_code 0
    local SNAP2
    SNAP2=$(extract_snapshot_id)

    echo "v3" > file.txt
    run_fst snapshot -m "gc snap three"
    assert_exit_code 0

    # Drop middle snapshot to create unreachable artifact
    run_fst drop "$SNAP2"
    assert_exit_code 0
    assert_contains "Dropped"

    # GC from project root
    cd "$TEST_DIR/myproject"
    run_fst gc --dry-run
    assert_exit_code 0
    assert_contains "Would delete"

    run_fst gc
    assert_exit_code 0
    assert_contains "Deleted"

    teardown_test
}

test_exit_codes() {
    setup_test

    run_fst project create myproject --no-snapshot
    assert_exit_code 0
    cd "$TEST_DIR/myproject/main"

    echo "base" > file.txt
    run_fst snapshot -m "base"
    assert_exit_code 0

    # Status always exits 0
    run_fst status
    assert_exit_code 0

    # Create feature (identical to main)
    run_fst workspace create feature
    assert_exit_code 0

    # No drift → exit 0
    run_fst drift feature
    assert_exit_code 0

    # No diff → exit 0
    run_fst diff feature
    assert_exit_code 0
    assert_contains "No differences"

    # Introduce drift in feature
    cd "$TEST_DIR/myproject/feature"
    echo "feature change" >> file.txt
    run_fst snapshot -m "feature diverge"
    assert_exit_code 0

    # From main: drift → exit 1
    cd "$TEST_DIR/myproject/main"
    run_fst drift feature
    assert_exit_code 1

    # Diff → exit 1
    run_fst diff feature --names-only
    assert_exit_code 1
    assert_contains "file.txt"

    teardown_test
}

# =========================================
#  Runner
# =========================================

run_test() {
    local name="$1"
    printf "${BOLD}%-40s${NC}" "$name"
    TEST_FAILED=0

    # Run test, capture any unexpected errors
    local test_err=""
    eval "$name" 2>&1 || test_err="$?"

    if [[ -n "$test_err" && "$test_err" != "0" && "$TEST_FAILED" -eq 0 ]]; then
        fail "test crashed with exit code $test_err"
    fi

    if [[ "$TEST_FAILED" -eq 0 ]]; then
        echo -e "${GREEN}PASS${NC}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo -e "${RED}FAIL${NC}"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        FAILED_TESTS+=("$name")
    fi
}

cleanup() {
    if [[ -n "${BUILD_DIR:-}" && -d "$BUILD_DIR" ]]; then
        rm -rf "$BUILD_DIR"
    fi
    if [[ -n "${TEST_DIR:-}" && -d "$TEST_DIR" ]]; then
        rm -rf "$TEST_DIR"
    fi
}
trap cleanup EXIT

main() {
    echo "========================================="
    echo " fst E2E Tests"
    echo "========================================="
    echo ""

    build_fst
    echo ""

    run_test test_bootstrap
    run_test test_branching_and_merge
    run_test test_merge_conflict_resolution
    run_test test_snapshot_history
    run_test test_history_rewrite
    run_test test_info_commands
    run_test test_git_export
    run_test test_gc
    run_test test_exit_codes

    echo ""
    echo "========================================="
    echo " Results: $((PASS_COUNT + FAIL_COUNT)) tests"
    echo "========================================="
    echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}"
    if [[ "$FAIL_COUNT" -gt 0 ]]; then
        echo -e "  ${RED}Failed: $FAIL_COUNT${NC}"
        echo ""
        echo "  Failed tests:"
        for t in "${FAILED_TESTS[@]}"; do
            echo -e "    ${RED}- $t${NC}"
        done
    fi
    echo ""

    if [[ "$FAIL_COUNT" -gt 0 ]]; then
        exit 1
    fi
}

main "$@"
