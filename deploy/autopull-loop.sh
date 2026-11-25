#!/usr/bin/env bash
# autopull 的常驻外壳：每 90 秒跑一次 autopull.sh。
# 必须用 setsid 独立启动，不能挂在 tmux 里：
#   setsid nohup bash /root/autopull-loop.sh >/dev/null 2>&1 < /dev/null &
while true; do
  bash /root/autopull.sh >/dev/null 2>&1
  sleep 85
done
