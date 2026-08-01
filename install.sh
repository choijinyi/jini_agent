#!/usr/bin/env bash
# Jini Agent 설치 (macOS / Linux / WSL / Git Bash)
#
#   curl -fsSL https://raw.githubusercontent.com/choijinyi/jini_agent/main/install.sh | bash
#   JINI_REPO=https://github.com/choijinyi/jini_agent.git bash install.sh
set -euo pipefail

REPO="${JINI_REPO:-https://github.com/choijinyi/jini_agent.git}"
REF="${JINI_REF:-main}"
DIR="${JINI_DIR:-$HOME/.jini-agent}"
BIN_DIR="${JINI_BIN:-$HOME/.local/bin}"

info() { printf '\033[36m[jini]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[jini]\033[0m %s\n' "$1"; }

for cmd in git node npm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd 이(가) PATH 에 없습니다. Node.js 20+ 와 git 을 먼저 설치하세요."; exit 1; }
done

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 20 이상이 필요합니다 (현재 $(node -v))."; exit 1; }

if [ -d "$DIR/.git" ]; then
  info "기존 설치 갱신: $DIR"
  git -C "$DIR" fetch --depth 1 origin "$REF"
  git -C "$DIR" reset --hard "origin/$REF"
else
  info "클론: $REPO -> $DIR"
  rm -rf "$DIR"
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

info '의존성 설치'
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null)

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/jini" <<EOF
#!/usr/bin/env bash
exec node "$DIR/bin/jini.js" "\$@"
EOF
chmod +x "$BIN_DIR/jini"

info '자기검증 실행'
(cd "$DIR" && node src/selftest.js)

info "설치 완료: $DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "PATH 에 $BIN_DIR 이 없습니다. 셸 설정에 추가하세요: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
[ -n "${ANTHROPIC_API_KEY:-}" ] || warn '다음 단계: export ANTHROPIC_API_KEY=sk-ant-...'
info '실행: jini'
