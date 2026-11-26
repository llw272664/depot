#!/usr/bin/env bash
# 每 90 秒检查一次远端 main，变了就拉下来重启对应服务。
# 独立进程跑（setsid），不挂在 tmux 里。
# 用法：autopull.sh [once]
set -u

W=/root/work
REPO=${REPO:-https://github.com/llw272664/depot.git}
BRANCH=${BRANCH:-main}
LOG=$W/logs/autopull.log
mkdir -p "$W/logs"
say() { echo "$(date '+%F %T') $*" >>"$LOG"; }

cd "$W/depot" || { say "找不到 $W/depot"; exit 1; }

if [ ! -d .git ]; then
  git init -q
  git remote add origin "$REPO" 2>/dev/null || git remote set-url origin "$REPO"
  say "初始化 git 仓库"
fi

# 辅助脚本同步到 /root。
# 必须放在「无变化就退出」之前，否则没有新提交的那些轮次永远不会同步。
# 用 .new + mv 原子替换，不影响正在跑的进程。
sync_helpers() {
  for f in u3-backup.sh; do
    src="$W/depot/deploy/$f"
    [ -f "$src" ] || continue
    if ! cmp -s "$src" "/root/$f" 2>/dev/null; then
      cp "$src" "/root/$f.new" && mv "/root/$f.new" "/root/$f" && chmod +x "/root/$f" \
        && say "同步 $f 到 /root"
    fi
  done
}
sync_helpers

BEFORE=$(git rev-parse HEAD 2>/dev/null || echo none)

if ! git fetch -q origin "$BRANCH" 2>>"$LOG"; then
  say "fetch 失败（网络或 GitHub 不可达），稍后再试"
  exit 0
fi

REMOTE=$(git rev-parse FETCH_HEAD)
if [ "$BEFORE" = "$REMOTE" ]; then
  [ "${1:-}" = once ] && say "已是最新 $REMOTE"
  exit 0
fi

# 记下 package-lock 是否变化，决定要不要重装依赖
LOCK_BEFORE=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1)
CHANGED=$(git diff --name-only "$BEFORE" FETCH_HEAD 2>/dev/null | head -40)

# 只覆盖被跟踪的文件；.env / data / node_modules 是 untracked，不受影响
if ! git reset --hard -q FETCH_HEAD 2>>"$LOG"; then
  say "reset 失败，放弃本轮"
  exit 1
fi
LOCK_AFTER=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1)

say "更新 $BEFORE -> $REMOTE"
say "改动: $(echo "$CHANGED" | tr '\n' ' ')"

if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  say "依赖有变动，执行 npm ci"
  npm ci --omit=dev >>"$LOG" 2>&1 || say "npm ci 失败，保留旧依赖继续跑"
fi

# 重启图床（只用 tmux kill-session，绝不用 pkill，会连整个 proot 进程树一起带走）
if tmux has-session -t depot 2>/dev/null; then
  tmux kill-session -t depot
  sleep 1
fi
tmux new-session -d -s depot "cd $W/depot && set -a && . ./.env && set +a && PORT=3000 exec node server.js >> $W/logs/depot.log 2>&1"
say "depot 已重启"

# 机器人代码也同步一份过去（保留它的 .env 和 node_modules）
if [ -d "$W/depot/bot" ] && [ -d "$W/bot" ]; then
  rsync -a --exclude node_modules --exclude .env "$W/depot/bot/" "$W/bot/" 2>>"$LOG"
  if echo "$CHANGED" | grep -q '^bot/'; then
    if tmux has-session -t bot 2>/dev/null; then tmux kill-session -t bot; sleep 1; fi
    tmux new-session -d -s bot "cd $W/bot && set -a && . ./.env && set +a && exec node bot.js >> $W/logs/bot.log 2>&1"
    say "bot 已重启"
  fi
fi

if [ "${1:-}" != once ]; then
  sleep 5
  curl -s -o /dev/null -w "本地自检 HTTP %{http_code}\n" -m 10 http://127.0.0.1:3000/ >>"$LOG" 2>&1
fi
