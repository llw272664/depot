/*
 * 仓 · 边缘函数（API + webhook 接收端）
 *
 * 路由：
 *   GET  /            自述
 *   GET  /health      健康检查
 *   POST /webhook     通用 webhook 接收（需 x-webhook-secret，可选转发到 Telegram）
 *   POST /discord     Discord 交互端点（PING 与 /ping 命令）
 *
 * 环境变量：WEBHOOK_SECRET, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, DISCORD_PUBLIC_KEY
 */

const enc = new TextEncoder();

function envGet(env, key) {
  if (env && env[key]) return env[key];
  try {
    return (globalThis.process && process.env && process.env[key]) || '';
  } catch {
    return '';
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

async function toTelegram(env, text) {
  const token = envGet(env, 'TELEGRAM_TOKEN');
  const chat = envGet(env, 'TELEGRAM_CHAT_ID');
  if (!token || !chat) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  return res.ok;
}

async function verifyDiscord(env, request, raw) {
  const publicKey = envGet(env, 'DISCORD_PUBLIC_KEY');
  if (!publicKey) return false;
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');
  if (!sig || !ts) return false;

  const hexToBytes = (hex) => Uint8Array.from(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
  try {
    const key = await crypto.subtle.importKey(
      'raw', hexToBytes(publicKey), { name: 'Ed25519' }, false, ['verify'],
    );
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(sig), enc.encode(ts + raw));
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' ) {
      return json({
        name: 'depot api',
        routes: ['GET /health', 'POST /webhook', 'POST /discord'],
      });
    }

    if (path === '/health') {
      return json({ ok: true, at: new Date().toISOString() });
    }

    if (path === '/webhook') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const secret = envGet(env, 'WEBHOOK_SECRET');
      if (secret && request.headers.get('x-webhook-secret') !== secret) {
        return json({ error: 'bad secret' }, 401);
      }
      const raw = await request.text();
      let payload = raw;
      try { payload = JSON.parse(raw); } catch {}

      const summary = typeof payload === 'string'
        ? payload.slice(0, 500)
        : JSON.stringify(payload).slice(0, 500);

      const forwarded = await toTelegram(env, '来自 webhook：\n' + summary).catch(() => false);

      return json({ ok: true, receivedAt: new Date().toISOString(), forwarded, preview: summary });
    }

    if (path === '/discord') {
      const raw = await request.text();
      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }

      if (body.type === 1) return json({ type: 1 });

      const ok = await verifyDiscord(env, request, raw);
      if (!ok) return json({ error: 'bad signature' }, 401);

      if (body.type === 2) {
        const name = body.data && body.data.name;
        if (name === 'ping') {
          return json({ type: 4, data: { content: '在。' } });
        }
        return json({ type: 4, data: { content: '不认识这个命令：' + (name || '?') } });
      }

      return json({ type: 4, data: { content: '收到。' } });
    }

    return json({ error: 'not found', path }, 404);
  },
};
