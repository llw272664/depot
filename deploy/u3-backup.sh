#!/usr/bin/env bash
# 把图床数据（data/ + .env）打包上传到 U3 对象存储，异地留一份。
# 依赖沙盒上的平台令牌 /root/.altare/token（altr 登录时写的，只读属主）。
# 用法：u3-backup.sh          打包+上传，成功按份数裁剪
#       u3-backup.sh list     只看远端现有备份
set -u

TID=${TID:-06caab7d-e6f5-468c-bae7-481fe432311e}
# 注意：桶相关接口认的是桶 id，不是桶名（用名字会 404 Bucket not found）
BID=${BID:-6b3eca6a681de6a06d00}
API="https://console.altare.gg/api/tenants/$TID/u3/buckets/$BID"
TOKF=/root/.altare/token
SRC=/root/work/depot
LOG=/root/work/logs/u3-backup.log
KEEP=${KEEP:-8}

mkdir -p "$(dirname "$LOG")"
say() { echo "$(date '+%F %T') $*" >>"$LOG"; }

if [ ! -s "$TOKF" ]; then say "没有找到平台令牌 $TOKF，跳过"; exit 0; fi
TOKEN=$(tr -d '\r\n' <"$TOKF")
AUTH="Authorization: Bearer $TOKEN"

list_keys() {
  curl -s -m 25 -H "$AUTH" "$API/objects?prefix=backups/" \
    | sed 's/},{/}\n{/g' | grep -o '"key":"backups/[^"]*"' | sed 's/"key":"//;s/"$//'
}

if [ "${1:-}" = list ]; then
  list_keys
  exit 0
fi

if [ ! -d "$SRC/data" ]; then say "找不到 $SRC/data，跳过"; exit 0; fi

TS=$(date +%Y%m%d-%H%M)
KEY="backups/depot-$TS.tar.gz"
TMP=$(mktemp /tmp/u3bak.XXXXXX.tar.gz)
trap 'rm -f "$TMP"' EXIT

if ! tar czf "$TMP" -C "$SRC" data .env 2>/dev/null; then
  say "打包失败，跳过"
  exit 0
fi
SIZE=$(stat -c%s "$TMP")

URL=$(curl -s -m 25 -X POST "$API/upload" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"key\":\"$KEY\",\"contentType\":\"application/gzip\"}" \
  | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')

if [ -z "$URL" ]; then
  say "取上传地址失败，本地备份照旧保留"
  exit 0
fi

CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 90 -X PUT "$URL" \
  -H 'Content-Type: application/gzip' --data-binary "@$TMP")
if [ "$CODE" != "200" ]; then
  say "上传失败 HTTP $CODE（$KEY，$SIZE 字节）"
  exit 0
fi

curl -s -m 20 -X POST "$API/uploaded" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"keys\":[\"$KEY\"]}" >/dev/null 2>&1
say "已上传 $KEY ($SIZE 字节)"

# 只留最近 $KEEP 份
OLD=$(list_keys | sort | head -n -"$KEEP")
if [ -n "$OLD" ]; then
  KEYS=$(echo "$OLD" | sed 's/.*/"&"/' | paste -sd, -)
  curl -s -m 30 -X POST "$API/delete-objects" -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"keys\":[$KEYS]}" >/dev/null 2>&1
  say "清理旧备份 $(echo "$OLD" | wc -l) 份"
fi
