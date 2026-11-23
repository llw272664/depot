# depot

一个自建的图片站点 + 几个跑在 Altare 上的小服务。没有框架、没有构建步骤，纯 Node 标准库。

```
server.js         图床后端（上传 / 列表 / 删除 / 短链 / 口令登录）
public/           前端三件套，静态文件直接读盘
bot/              Telegram 机器人，收图后转存到图床并回短链
functions/api/    Altare Edge Function：健康检查 + webhook 入口
```

## 图床

上传走 `POST /api/upload`，需要登录口令换来的会话。图片按日期分目录落在 `data/uploads`，删除是软删（`.trash`），短链存在 `data/links.json`。

跑起来：

```bash
npm install
cp .env.example .env    # 改里面的口令和 API key
node server.js
```

关键环境变量：

| 变量 | 用途 |
| --- | --- |
| `PORT` | 监听端口，默认 3000 |
| `ADMIN_PASSWORD` | 站点登录口令 |
| `API_KEY` | 给机器人用的免登录写权限 key，走 `x-api-key` 头 |
| `SESSION_SECRET` | 会话签名密钥 |
| `DATA_DIR` | 数据目录，默认 `./data` |
| `MAX_UPLOAD_MB` | 单文件上限，默认 25 |
| `SITE_NAME` / `SITE_OWNER` / `SITE_SUB` | 页面上的站名、署名、副标题 |
| `HOST` | 监听地址，默认 `::`（双栈）。改成 `0.0.0.0` 会让隧道首个请求 502，别动 |

## 机器人

零依赖长轮询，不用 webhook、不用公网回调。

```bash
cd bot
TELEGRAM_TOKEN=123:abc SITE_URL=http://127.0.0.1:3000 SITE_API_KEY=xxx node bot.js
```

发图给它，它上传后回一条短链。指令：`/ping` `/stats` `/id` `/help`。
`SITE_PUBLIC_URL` 是回给用户的外链前缀（默认取 `SITE_URL`），`POLL_SECONDS` 控制每轮长轮询的等待秒数。

## 边缘函数

`functions/api/index.mjs` 是 Altare Edge Function 的入口，路由 `/`、`/health`、`/webhook`、`/discord`。
`/webhook` 校验请求头 `x-webhook-secret`，不匹配直接 401；`/discord` 处理 Discord 的 PING 校验。

## 部署

线上现在跑在一台 Debian 13 沙盒里，`altr tunnel` 给公网地址，`watchdog.sh` 每 60 秒巡检、每小时级备份。
具体的启停命令、踩过的坑写在 `DEPLOY.md`。
