#!/usr/bin/env bash
# 三人同游桌面端在线更新发布入口（macOS universal + Windows x64，上传自建更新源）。
#
# 默认行为（一条命令完成一次发布）：
#   1. 把 package.json 升一个 patch（1.1.17 -> 1.1.18）
#   2. 跑回归门禁 npm run test:changed（5 正向 + 20 负向）
#   3. 只把版本号改动提交为 chore: release vX.Y.Z 并 push 当前分支
#   4. 类型检查、打包 macOS universal 与 Windows x64，上传更新源
#   5. 回读线上 latest.yml / latest-mac.yml 核对版本
#
# 用法：bash scripts/publish.sh [选项]
#   --version X.Y.Z   发布指定版本（不再自动升 patch）
#   --no-bump         发布当前 package.json 的版本，不改版本号
#   --mac-only        只发布 macOS
#   --win-only        只发布 Windows
#   --skip-tests      跳过 npm run test:changed（跳过即违反 AGENTS.md 交付要求，需用户显式授权）
#   --no-commit       不 commit、不 push，只打包上传
#   --no-push         只 commit 不 push
#   --tag             额外创建并 push 注释 tag vX.Y.Z
#   --no-verify       上传后不回读线上清单
#   --dry-run         只预览版本、git 动作与打包步骤，不改文件、不提交、不上传
#   -h, --help        显示帮助
#
# 运行本脚本即视为用户已授权其中的版本提交与 push（AGENTS.md 高风险操作需显式授权）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\033[1;34m[publish]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[publish]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[publish]\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

TARGET="all"
EXPLICIT_VERSION=""
NO_BUMP=0
DRY_RUN=0
SKIP_TESTS=0
VERIFY=1
COMMIT=1
PUSH=1
TAG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || die "--version 需要版本号，例如 --version 1.2.0"
      EXPLICIT_VERSION="$2"
      shift 2
      ;;
    --no-bump) NO_BUMP=1; shift ;;
    --mac-only) TARGET="mac"; shift ;;
    --win-only) TARGET="win"; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --no-commit) COMMIT=0; PUSH=0; shift ;;
    --no-push) PUSH=0; shift ;;
    --tag) TAG=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：${1}（用 --help 查看用法）" ;;
  esac
done

[[ "$NO_BUMP" == "1" && -n "$EXPLICIT_VERSION" ]] && die "--no-bump 与 --version 不能同时使用"

version_of() {
  node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version"
}

validate_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "版本号必须是 x.y.z 格式，收到：$1"
}

bump_patch() {
  local major minor patch
  IFS='.' read -r major minor patch <<<"$1"
  printf '%s.%s.%s' "$major" "$minor" "$((patch + 1))"
}

version_gt() {
  local -a left right
  IFS='.' read -r -a left <<<"$1"
  IFS='.' read -r -a right <<<"$2"
  local i
  for i in 0 1 2; do
    ((10#${left[i]} > 10#${right[i]})) && return 0
    ((10#${left[i]} < 10#${right[i]})) && return 1
  done
  return 1
}

# 远端 git 操作禁用交互输入并限制 SSH 连接时间，避免发布流程卡死
git_remote() {
  GIT_TERMINAL_PROMPT=0 git -c core.sshCommand="ssh -o BatchMode=yes -o ConnectTimeout=10" "$@"
}

CURRENT_VERSION="$(version_of)"
validate_version "$CURRENT_VERSION"

if [[ -n "$EXPLICIT_VERSION" ]]; then
  validate_version "$EXPLICIT_VERSION"
  version_gt "$EXPLICIT_VERSION" "$CURRENT_VERSION" || die "--version $EXPLICIT_VERSION 不高于当前版本 ${CURRENT_VERSION}；要重发当前版本请用 --no-bump"
  NEXT_VERSION="$EXPLICIT_VERSION"
elif [[ "$NO_BUMP" == "1" ]]; then
  NEXT_VERSION="$CURRENT_VERSION"
else
  NEXT_VERSION="$(bump_patch "$CURRENT_VERSION")"
fi

REMOTE_HOST="${VBK_UPDATE_SSH_HOST:-sx2}"
REMOTE_ROOT="${VBK_UPDATE_REMOTE_ROOT:-/data/www/web/downloads/sanrentongyou/updates}"
MANIFEST_BASE="https://www.atdtour.com/downloads/sanrentongyou/updates/stable"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
TAG_NAME="v$NEXT_VERSION"

for cmd in node npm curl ssh rsync git; do
  command -v "$cmd" >/dev/null 2>&1 || die "缺少命令：$cmd"
done
[[ "$BRANCH" == "HEAD" ]] && die "当前处于 detached HEAD，无法安全提交与 push"

case "$TARGET" in
  mac) PUBLISH_SCRIPT="release:online:mac"; MANIFESTS=("latest-mac.yml") ;;
  win) PUBLISH_SCRIPT="release:online:win"; MANIFESTS=("latest.yml") ;;
  *) PUBLISH_SCRIPT="release:online"; MANIFESTS=("latest-mac.yml" "latest.yml") ;;
esac

stale_artifacts=()
for file in "release/三人同游-$NEXT_VERSION-universal.dmg" "release/三人同游-$NEXT_VERSION-universal.zip" \
  "release/三人同游-$NEXT_VERSION-x64-setup.exe"; do
  [[ -f "$file" ]] && stale_artifacts+=("$file")
done
if [[ ${#stale_artifacts[@]} -gt 0 ]]; then
  warn "release/ 里已存在 $NEXT_VERSION 的产物，发布脚本会拒绝覆盖："
  for file in "${stale_artifacts[@]}"; do warn "  - $file"; done
  warn "如需重发请显式指定更高版本：bash scripts/publish.sh --version <x.y.z>"
fi

if [[ "$COMMIT" == "1" ]]; then
  git rev-parse -q --verify "refs/tags/$TAG_NAME" >/dev/null && die "本地已存在 tag ${TAG_NAME}，请先确认版本号（或 --version 指定新版本）"
  if git_remote fetch --quiet origin "$BRANCH" 2>/dev/null; then
    behind="$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)"
    [[ "$behind" != "0" ]] && die "本地落后 origin/$BRANCH $behind 个提交，先 git pull 再发布"
  else
    warn "无法 fetch origin/${BRANCH}（SSH 免密不可用或网络不通），跳过落后检查"
  fi
fi

log "仓库：${REPO_ROOT}（分支 ${BRANCH}）"
log "当前版本：$CURRENT_VERSION"
log "本次发布：${NEXT_VERSION}（$([[ "$NEXT_VERSION" == "$CURRENT_VERSION" ]] && echo "沿用当前版本号" || echo "写入 package.json")）"
log "发布目标：${TARGET}（npm run ${PUBLISH_SCRIPT}）"
log "更新源：$REMOTE_HOST:$REMOTE_ROOT/stable"
if [[ "$COMMIT" == "1" ]]; then
  log "git 动作：commit chore: release v${NEXT_VERSION}$([[ "$PUSH" == "1" ]] && echo " + push $BRANCH")$([[ "$TAG" == "1" ]] && echo " + tag $TAG_NAME")"
else
  log "git 动作：已按 --no-commit 跳过"
fi
[[ "$SKIP_TESTS" == "1" ]] && warn "已跳过 npm run test:changed（AGENTS.md 要求交付前跑完 5 正向 + 20 负向共 25 项回归）"

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run：不改文件、不提交、不打包、不上传。真实执行时的步骤："
  if [[ "$NEXT_VERSION" != "$CURRENT_VERSION" ]]; then
    log "  1. npm version $NEXT_VERSION --no-git-tag-version"
  else
    log "  1. 保持 package.json 版本 $NEXT_VERSION"
  fi
  [[ "$SKIP_TESTS" == "1" ]] && log "  2. 跳过 npm run test:changed" || log "  2. npm run test:changed"
  if [[ "$COMMIT" == "1" ]]; then
    log "  3. git add package.json && git commit -m \"chore: release v$NEXT_VERSION\""
    [[ "$PUSH" == "1" ]] && log "     git push origin ${BRANCH}$([[ "$TAG" == "1" ]] && echo " && git tag -a $TAG_NAME && git push origin $TAG_NAME")"
    [[ "$PUSH" == "0" ]] && log "     （--no-push：只提交，不 push）"
  else
    log "  3. 跳过 commit / push"
  fi
  log "  4. npm run ${PUBLISH_SCRIPT}（check + 打包 + 上传到 $REMOTE_HOST:$REMOTE_ROOT/stable）"
  [[ "$TARGET" != "win" ]] && log "     macOS 产物：release/三人同游-$NEXT_VERSION-universal.dmg"
  [[ "$TARGET" != "mac" ]] && log "     Windows 产物：release/三人同游-$NEXT_VERSION-x64-setup.exe"
  if [[ "$VERIFY" == "1" ]]; then
    for manifest in "${MANIFESTS[@]}"; do
      log "  5. 回读 $MANIFEST_BASE/$manifest 核对 version: $NEXT_VERSION"
    done
  fi
  log "dry run 完成"
  exit 0
fi

if [[ "$NEXT_VERSION" != "$CURRENT_VERSION" ]]; then
  log "步骤 1/6：写入版本号 $CURRENT_VERSION -> $NEXT_VERSION"
  npm version "$NEXT_VERSION" --no-git-tag-version >/dev/null
else
  log "步骤 1/6：沿用当前版本号 $NEXT_VERSION"
fi

if [[ "$SKIP_TESTS" == "1" ]]; then
  log "步骤 2/6：跳过回归门禁"
else
  log "步骤 2/6：回归门禁 npm run test:changed"
  npm run test:changed || die "回归未通过，已终止发布（未提交、未打包、未上传；package.json 已升到 ${NEXT_VERSION}，尚未提交）"
fi

if [[ "$COMMIT" == "0" ]]; then
  log "步骤 3/6：跳过 commit / push"
else
  log "步骤 3/6：提交版本号改动"
  staged_version="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version")"
  [[ "$staged_version" == "$NEXT_VERSION" ]] || die "package.json 版本为 ${staged_version}，与预期 ${NEXT_VERSION} 不一致"
  unexpected="$(git diff -U0 HEAD -- package.json | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | grep -vE '^[+-][[:space:]]*"version":' || true)"
  if [[ -n "$unexpected" ]]; then
    warn "package.json 里除版本号外还有未提交改动，不会混入发布提交："
    printf '%s\n' "$unexpected" >&2
    die "请先单独提交这些改动，或用 --no-commit 手动控制提交范围（package.json 当前已是 ${NEXT_VERSION}，尚未提交）"
  fi
  git add -- package.json
  if git diff --cached --quiet -- package.json; then
    warn "package.json 无版本号改动，跳过提交（版本 $NEXT_VERSION 可能已提交过）"
  else
    git commit -m "chore: release v$NEXT_VERSION" -- package.json
    log "已提交：chore: release v$NEXT_VERSION"
  fi
  if [[ "$TAG" == "1" ]]; then
    git tag -a "$TAG_NAME" -m "Release v$NEXT_VERSION"
    log "已创建 tag：$TAG_NAME"
  fi
  if [[ "$PUSH" == "1" ]]; then
    log "push 到 origin/$BRANCH"
    if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
      git_remote push origin "$BRANCH" || die "push 失败，已按当前状态终止（可修好后用 --no-bump 重跑发布）"
    else
      git_remote push -u origin "$BRANCH" || die "push 失败，已按当前状态终止（可修好后用 --no-bump 重跑发布）"
    fi
    [[ "$TAG" == "1" ]] && { git_remote push origin "$TAG_NAME" || die "tag push 失败"; }
    log "已 push：${BRANCH}$([[ "$TAG" == "1" ]] && echo " + $TAG_NAME")"
  fi
fi

log "步骤 4/6：类型检查、打包并上传（npm run ${PUBLISH_SCRIPT}）"
npm run "$PUBLISH_SCRIPT" || die "发布失败，检查上方输出；上传先写临时目录再原子切换，stable 不会被写坏"

if [[ "$VERIFY" == "0" ]]; then
  warn "步骤 5/6：已按 --no-verify 跳过线上清单核对"
else
  log "步骤 5/6：回读线上清单核对版本"
  sleep 2
  for manifest in "${MANIFESTS[@]}"; do
    body="$(curl -fsSL "$MANIFEST_BASE/$manifest")" || die "线上清单读取失败：$MANIFEST_BASE/$manifest"
    grep -q "^version: *${NEXT_VERSION}$" <<<"$body" || die "${manifest} 未声明版本 ${NEXT_VERSION}，线上核对失败"
    log "  $manifest -> version: $NEXT_VERSION"
  done
fi

log "步骤 6/6：发布完成 v$NEXT_VERSION"
[[ "$TARGET" != "win" ]] && log "macOS：release/三人同游-$NEXT_VERSION-universal.dmg"
[[ "$TARGET" != "mac" ]] && log "Windows：release/三人同游-$NEXT_VERSION-x64-setup.exe"
log "清单地址：$MANIFEST_BASE/latest-mac.yml 、 $MANIFEST_BASE/latest.yml"
[[ "$COMMIT" == "1" && "$PUSH" == "1" ]] && log "代码：已 push 到 origin/$BRANCH" || warn "代码未 push（--no-commit/--no-push）；package.json 与 release/ 产物状态见上"
