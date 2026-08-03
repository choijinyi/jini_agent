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

# 자기검증을 먼저 통과해야 실행 셈을 만든다.
# 이전 순서(셈 생성 → 검증)는 검증이 실패해도 셈이 남아 깨진 설치가 실행 가능했다
# — CSO 검수 §4(중대).
info '자기검증 실행'
if ! (cd "$DIR" && node src/selftest.js); then
  warn '자기검증 실패 — 실행 셈을 만들지 않고 중단한다.'
  warn "받아둔 소스는 $DIR 에 남아 있다(수동 점검용). 제거하려면: rm -rf \"$DIR\""
  exit 1
fi

# 스킬 확인 — skills/ 는 저장소에 함께 추적되므로 clone 만으로 이미 배치돼 있다.
# 여기서 네트워크로 다시 받지 않는다. 받는 것이 아니라 **맞는지 확인**하는 단계다.
# 스킬이 없거나 어긋나도 설치를 중단하지 않는다 — 에이전트는 스킬 없이도 동작한다.
info '스킬 확인'
if ! (cd "$DIR" && node src/tools/skills-verify.js); then
  warn '스킬 정합에 어긋난 항목이 있습니다(설치는 계속합니다). 위 FAIL 줄을 확인하세요.'
fi

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/jini" <<EOF
#!/usr/bin/env bash
exec node "$DIR/bin/jini.js" "\$@"
EOF
chmod +x "$BIN_DIR/jini"

info "설치 완료: $DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "PATH 에 $BIN_DIR 이 없습니다. 셸 설정에 추가하세요: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
info '다음 단계: jini doctor 로 claude·gemini·codex 계정 로그인 상태를 확인하세요.'
info '실행: jini'
