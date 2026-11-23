(() => {
  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const empty = $('empty');
  const tally = $('tally');
  const queue = $('queue');
  const dropZone = $('dropZone');
  const fileInput = $('fileInput');
  const loginForm = $('loginForm');
  const authBtn = $('authBtn');
  const logoutBtn = $('logoutBtn');
  const filter = $('filter');
  const viewer = $('viewer');

  let state = { items: [], bytes: 0, admin: false, maxMb: 24, name: '仓' };

  const fmtSize = (n) => {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };

  const fmtDate = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  };

  async function json(url, options) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.status + ' ' + res.statusText);
    return body;
  }

  function render() {
    const total = state.items.length;
    tally.textContent = `${total} 张 · ${fmtSize(state.bytes)}`;
    $('footName').textContent = state.name;
    $('footTime').textContent = new Date().toLocaleDateString('zh-CN');

    const q = filter.value.trim().toLowerCase();
    const list = q ? state.items.filter((it) => (it.title || it.name).toLowerCase().includes(q)) : state.items;

    grid.innerHTML = '';
    empty.hidden = total > 0;
    if (!total) empty.textContent = '还是空的。上面拖一张进来。';
    else if (!list.length) empty.hidden = false, empty.textContent = '没有匹配的文件。';

    for (const it of list) {
      const tile = document.createElement('figure');
      tile.className = 'tile';
      tile.dataset.id = it.id;

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = it.title || it.name;
      img.src = '/f/' + it.name;
      tile.appendChild(img);

      const bar = document.createElement('div');
      bar.className = 'tile-bar';

      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = it.title || it.name;
      name.title = `${it.title || it.name} · ${fmtSize(it.size)} · ${fmtDate(it.ts)}`;

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '链接';
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(location.origin + '/f/' + it.name).then(() => {
          copy.textContent = '已复制';
          setTimeout(() => (copy.textContent = '链接'), 1200);
        });
      });

      bar.append(name, copy);

      if (state.admin) {
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '删';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`删除「${it.title || it.name}」？不可恢复。`)) return;
          try {
            await json('/api/images/' + it.id, { method: 'DELETE' });
            state.items = state.items.filter((x) => x.id !== it.id);
            state.bytes = state.items.reduce((s, x) => s + (x.size || 0), 0);
            render();
          } catch (err) {
            alert(err.message);
          }
        });
        bar.appendChild(del);
      }

      tile.appendChild(bar);
      tile.addEventListener('click', () => openViewer(it));
      grid.appendChild(tile);
    }
  }

  function openViewer(it) {
    $('viewerImg').src = '/f/' + it.name;
    $('viewerMeta').textContent = `${it.title || it.name} · ${fmtSize(it.size)} · ${fmtDate(it.ts)} · ${location.origin}/f/${it.name}`;
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeViewer() {
    viewer.hidden = true;
    $('viewerImg').src = '';
    document.body.style.overflow = '';
  }

  $('viewerClose').addEventListener('click', closeViewer);
  viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !viewer.hidden) closeViewer();
    if (e.key === '/' && document.activeElement !== filter && document.activeElement !== $('pw')) {
      e.preventDefault();
      filter.focus();
    }
  });

  function queueRow(file) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = file.name;
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    li.append(label, bar);
    queue.appendChild(li);
    return { li, fill, label };
  }

  function uploadFiles(fileList) {
    const files = Array.from(fileList).filter(Boolean);
    if (!files.length) return;

    if (!state.admin) {
      loginForm.hidden = false;
      $('pw').focus();
      return;
    }

    const form = new FormData();
    files.forEach((f) => form.append('files', f));

    const rows = files.map(queueRow);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      rows.forEach((r) => (r.fill.style.width = pct + '%'));
    });
    xhr.onload = async () => {
      if (xhr.status === 401) {
        rows.forEach((r) => { r.label.className = 'err'; r.label.textContent = '需要登录'; });
        loginForm.hidden = false;
        return;
      }
      if (xhr.status >= 400) {
        rows.forEach((r) => { r.label.className = 'err'; r.label.textContent = '失败'; });
        return;
      }
      const body = JSON.parse(xhr.responseText || '{}');
      const failed = (body.added || []).filter((x) => x.error);
      rows.forEach((r) => { r.fill.style.width = '100%'; });
      if (failed.length) {
        rows.forEach((r) => { r.label.className = 'err'; r.label.textContent = '部分文件被拒绝'; });
      }
      setTimeout(() => rows.forEach((r) => r.li.remove()), 900);
      await load();
    };
    xhr.onerror = () => rows.forEach((r) => { r.label.className = 'err'; r.label.textContent = '网络错误'; });
    xhr.send(form);
  }

  $('pickBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('hot'); }));
  dropZone.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

  document.addEventListener('paste', (e) => {
    const items = e.clipboardData ? e.clipboardData.files : null;
    if (items && items.length) uploadFiles(items);
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await json('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('pw').value }),
      });
      $('pw').value = '';
      await load();
      loginForm.hidden = true;
    } catch (err) {
      $('pw').value = '';
      $('pw').placeholder = err.message;
      $('pw').focus();
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await json('/api/logout', { method: 'POST' });
    await load();
  });

  authBtn.addEventListener('click', async () => {
    if (state.admin) {
      await json('/api/logout', { method: 'POST' });
      await load();
    } else {
      loginForm.hidden = !loginForm.hidden;
      if (!loginForm.hidden) $('pw').focus();
    }
  });

  filter.addEventListener('input', render);

  async function load() {
    const [cfg, images, session] = await Promise.all([
      json('/api/config'),
      json('/api/images'),
      json('/api/session').catch(() => ({ admin: false })),
    ]);

    state.name = cfg.name;
    state.maxMb = cfg.maxMb;
    state.admin = session.admin;
    state.items = images.items || [];
    state.bytes = images.bytes || 0;

    document.title = cfg.name + ' · depot';
    document.querySelector('.intro-side p').textContent = cfg.sub;
    $('introMeta').textContent = cfg.owner ? `${cfg.owner} · ${state.items.length} 件` : `${state.items.length} 件 · 自管`;
    $('maxMb').textContent = cfg.maxMb;

    if (state.admin) {
      authBtn.textContent = '退出';
      loginForm.hidden = true;
      logoutBtn.hidden = true;
    } else {
      authBtn.textContent = '登录';
      logoutBtn.hidden = true;
    }

    render();
  }

  load().catch((err) => {
    tally.textContent = '连接失败';
    console.error(err);
  });
})();
