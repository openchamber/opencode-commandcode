#!/usr/bin/env bash
# End-to-end OpenCode CLI checks against command-code / Laguna S 2.1.
# Requires: Go-plan auth, plugin loaded from this workspace.
set -euo pipefail
export PATH="${HOME}/.local/bin:${HOME}/bin:${HOME}/.opencode/bin:${PATH}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OPENCODE_BIN="${OPENCODE_BIN:-$(command -v opencode)}"
MODEL="${MODEL:-command-code/laguna-s-2.1-free}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

run_case() {
  local name="$1"
  shift
  echo ""
  echo "── opencode: $name ──"
  local out="$TMP/${name//[^a-zA-Z0-9_-]/_}.txt"
  if "$@" >"$out" 2>"$TMP/${name}.err"; then
    echo "✓ $name"
    pass=$((pass + 1))
    head -c 400 "$out" | tr '\n' ' '
    echo
  else
    echo "✗ $name"
    fail=$((fail + 1))
    tail -n 40 "$TMP/${name}.err" || true
    tail -n 40 "$out" || true
  fi
}

assert_grep() {
  local name="$1"
  local pattern="$2"
  local file="$3"
  if grep -Eiq "$pattern" "$file"; then
    echo "✓ assert $name"
    pass=$((pass + 1))
  else
    echo "✗ assert $name (pattern /$pattern/)"
    fail=$((fail + 1))
    head -c 800 "$file" || true
    echo
  fi
}

echo "Using $OPENCODE_BIN · model $MODEL"
"$OPENCODE_BIN" --version

# 1) Plain marker
run_case plain \
  "$OPENCODE_BIN" run --model "$MODEL" --format default \
  "Reply with exactly the token OPENCODE-PLAIN-OK and nothing else."
assert_grep plain-token "OPENCODE-PLAIN-OK" "$TMP/plain.txt"

# 2) Alias model
run_case alias \
  "$OPENCODE_BIN" run --model "command-code/laguna" --format default \
  "Reply with exactly ALIAS-CLI-OK."
assert_grep alias-token "ALIAS-CLI-OK" "$TMP/alias.txt"

# 3) Unicode / mixed content
run_case unicode \
  "$OPENCODE_BIN" run --model "$MODEL" \
  "Echo 日本語 and café then write UNICODE-CLI-OK on the next line."
assert_grep unicode-token "UNICODE-CLI-OK" "$TMP/unicode.txt"

# 4) Code reasoning
run_case code \
  "$OPENCODE_BIN" run --model "$MODEL" \
  "In TypeScript, what does Array.prototype.map return? One short sentence, end with CODE-CLI-OK."
assert_grep code-token "CODE-CLI-OK" "$TMP/code.txt"

# 5) File attachment via --file (message before flags, or after --)
printf 'SECRET=FILE-4421\n' >"$TMP/secret.txt"
run_case file-attach \
  "$OPENCODE_BIN" run --model "$MODEL" --file "$TMP/secret.txt" -- \
  "Read the attached file. Reply with its SECRET value and FILE-CLI-OK."
assert_grep file-token "FILE-4421|4421" "$TMP/file-attach.txt"
assert_grep file-ok "FILE-CLI-OK" "$TMP/file-attach.txt"

# 6) Large-ish prompt through OpenCode (not full 90k — keep CLI responsive)
BIG="$TMP/big.txt"
python3 - <<'PY' >"$BIG"
print("pad " * 20000)
print("Ignore padding. Reply with exactly BIG-CLI-OK")
PY
run_case big-prompt \
  "$OPENCODE_BIN" run --model "$MODEL" \
  "$(cat "$BIG")"
assert_grep big-token "BIG-CLI-OK" "$TMP/big-prompt.txt"

# 7) Auto tools — ask OpenCode to use bash/read style tools if available
run_case tools-auto \
  "$OPENCODE_BIN" run --model "$MODEL" --auto \
  "List the files in the current directory with a tool if available, then end with TOOLS-CLI-OK. Keep it short."
assert_grep tools-token "TOOLS-CLI-OK" "$TMP/tools-auto.txt"

# 8) Continue session
run_case continue-1 \
  "$OPENCODE_BIN" run --model "$MODEL" --title "matrix-continue" \
  "Remember the word ORBIT. Reply with ACK-ORBIT."
assert_grep cont1 "ACK-ORBIT|ORBIT" "$TMP/continue-1.txt"

run_case continue-2 \
  "$OPENCODE_BIN" run --model "$MODEL" --continue \
  "What word did I ask you to remember? Reply with only that word and CONTINUE-CLI-OK."
assert_grep cont2 "ORBIT|CONTINUE-CLI-OK" "$TMP/continue-2.txt"

echo ""
echo "── opencode e2e summary: $pass passed, $fail failed ──"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
echo "ok — opencode e2e passed"
