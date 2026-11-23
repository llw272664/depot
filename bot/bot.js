'use strict';

/*
 * 仓的 Telegram 机器人
 *  - 长轮询，不需要公网端口
 *  - 收到图片/文件就存进图床，回一条短链
 * 环境变量：TELEGRAM_TOKEN, SITE_URL, SITE_API_KEY
 */

const TOKEN = process.env.TELEGRAM_TOKEN || '';
const SITE = (process.env.SITE_URL || '').replace(/\/$/, '');
// 对外展示的地址：机器人可能通过内网/本机访问图床，但用户点链接要走公网
const PUBLIC = (process.env.SITE_PUBLIC_URL || process.env.SITE_URL || '').replace(/\/$/, '');
const API_KEY = process.env.SITE_API_KEY || '';
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 30);

if (!TOKEN) {
  console.error('缺少 TELEGRAM_TOKEN');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const started = Date.now();

async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function reply(chatId, text, extra = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function uploadToDepot(buffer, filename, type) {
  if (!SITE) throw new Error('没有配置 SITE_URL');
  const form = new FormData();
  form.append('files', new Blob([buffer], { type }), filename);
  const res = await fetch(`${SITE}/api/upload`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.status);
  const ok = (body.added || []).find((x) => !x.error);
  if (!ok) throw new Error('图床没有接受这个文件');
  return `${PUBLIC}/f/${ok.name}`;
}

async function fetchTelegramFile(fileId) {
  const info = await tg('getFile', { file_id: fileId });
  if (!info.ok) throw new Error(info.description || 'getFile 失败');
  const url = `https://api.telegram.org/file/bot${TOKEN}/${info.result.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('下载失败 ' + res.status);
  const type = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer: Buffer.from(await res.arrayBuffer()), type, path: info.result.file_path };
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d ? d + ' 天' : '', h ? h + ' 小时' : '', m + ' 分'].filter(Boolean).join(' ');
}

async function handle(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text.startsWith('/start') || text.startsWith('/help')) {
    return reply(chatId,
      '<b>仓</b> 在跑。\n\n'
      + '直接把图片发给我，我存进图床并回你一条短链。\n'
      + '文件、PDF 也可以。\n\n'
      + '/id — 这个会话的 ID\n'
      + '/stats — 图床里有多少东西\n'
      + '/ping — 还活着吗');
  }

  if (text.startsWith('/ping')) {
    return reply(chatId, `在。已运行 ${fmtUptime(Date.now() - started)}。`);
  }

  if (text.startsWith('/id')) {
    return reply(chatId, `chat_id: <code>${chatId}</code>`);
  }

  if (text.startsWith('/stats')) {
    if (!SITE) return reply(chatId, '还没配置图床地址。');
    try {
      const res = await fetch(`${SITE}/api/images`);
      const data = await res.json();
      const mb = (data.bytes / 1024 / 1024).toFixed(1);
      return reply(chatId, `图床里 ${data.total} 件，共 ${mb} MB。\n${PUBLIC}`);
    } catch (err) {
      return reply(chatId, '图床没回应：' + err.message);
    }
  }

  const photo = msg.photo && msg.photo[msg.photo.length - 1];
  const doc = msg.document;

  if (!photo && !doc) {
    if (text) return reply(chatId, '发张图给我试试，或者 /help 看看能做什么。');
    return;
  }

  const notice = await reply(chatId, '收到，正在存…');

  try {
    let fileId, filename, hint;
    if (photo) {
      fileId = photo.file_id;
      filename = `telegram-${Date.now()}.jpg`;
      hint = 'image/jpeg';
    } else {
      fileId = doc.file_id;
      filename = doc.file_name || `telegram-${Date.now()}`;
      hint = doc.mime_type || 'application/octet-stream';
    }

    const file = await fetchTelegramFile(fileId);
    const link = await uploadToDepot(file.buffer, filename, hint || file.type);

    await tg('editMessageText', {
      chat_id: chatId,
      message_id: notice.result.message_id,
      text: `存好了\n<code>${link}</code>`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: notice.result.message_id,
      text: '没存成：' + err.message,
    }).catch(() => {});
  }
}

async function loop() {
  let offset = 0;
  const me = await tg('getMe', {});
  console.log('bot @' + (me.result ? me.result.username : '?') + ' 起来了');

  for (;;) {
    try {
      const res = await tg('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] });
      if (res.ok && res.result.length) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          handle(update).catch((err) => console.error('handle', err.message));
        }
      }
    } catch (err) {
      console.error('poll', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

loop();
