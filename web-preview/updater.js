/* Vitals · 内置更新（Android / 网页预览 / Electron 通用）
   数据源：本仓库的 GitHub 公开 Release。
   - Android：优先走原生桥 AndroidHost（网络、下载、校验、安装都在原生侧完成）；
   - 浏览器 / Electron：回退到 fetch 只读查询，只能提示版本，不具备安装能力。
   侧边栏底部提供「检查更新」入口，设置页提供完整卡片，两级入口共用同一状态。 */
(function () {
  'use strict';

  var REPO = '9573351-crypto/vitals-biosample';
  var RELEASES_PAGE = 'https://github.com/' + REPO + '/releases/latest';
  var API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest';

  var info = null;          // 最近一次检查结果
  var phase = 'idle';       // idle | checking | available | latest | downloading | downloaded | installing | error
  var busy = false;
  var progress = { percent: -1, text: '' };
  var message = '';
  var dialogMounted = false;
  var currentCache = '';    // 由原生事件（version 字段）带回的当前版本，避免依赖同步桥取值失败

  function el(id) { return document.getElementById(id); }
  function rt() { return window.AndroidHost || (window.parent && window.parent !== window ? window.parent.AndroidHost : null); }
  function native() { var b = rt(); return !!(b && typeof b.checkUpdate === 'function'); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function normalize(v) { return String(v == null ? '' : v).trim().replace(/^[vV]/, ''); }
  function fmtTime(iso) { if (!iso) return '—'; return String(iso).replace('T', ' ').slice(0, 16); }

  /* ==================== 数据源 ==================== */

  function check() {
    if (busy) return;
    if (native()) { busy = true; setPhase('checking'); try { rt().checkUpdate(); } catch (e) { fail(e && e.message ? e.message : e); } return; }
    busy = true; setPhase('checking');
    fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (response) {
        if (response.status === 404) return { ok: true, hasUpdate: false, message: '仓库尚未发布任何版本', latestVersion: currentVersion() };
        if (!response.ok) throw new Error('GitHub 返回错误：HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        busy = false;
        var latest = normalize(data.tag_name || '');
        var asset = pickApk(assetList(data), latest);
        var has = !!latest && compare(latest, currentVersion()) > 0;
        apply({ ok: true, hasUpdate: has, latestVersion: latest || currentVersion(), tag: data.tag_name || '', notes: data.body || '', pageUrl: data.html_url || '', publishedAt: data.published_at || '', apkName: asset ? asset.name : '', apkSize: asset ? asset.size : 0, hasApk: !!asset, port: 'web' });
      })
      .catch(function (e) { busy = false; fail(e && e.message ? e.message : '检查更新失败'); });
  }

  function assetList(release) { return release && Array.isArray(release.assets) ? release.assets : []; }
  function pickApk(assets, version) {
    var apks = assets.filter(function (a) { return a && /\.apk$/i.test(a.name || ''); });
    if (!apks.length) return null;
    var hit = apks.filter(function (a) { return String(a.name).toLowerCase().indexOf(version.toLowerCase()) >= 0; })[0];
    return hit || apks[0];
  }

  function compare(latest, current) {
    function parse(value) {
      var text = normalize(value), pre = '', plus = text.indexOf('+');
      if (plus >= 0) text = text.slice(0, plus);
      var dash = text.indexOf('-');
      if (dash >= 0) { pre = text.slice(dash + 1); text = text.slice(0, dash); }
      return { parts: text.split('.').map(function (x) { return parseInt(String(x).replace(/\D/g, ''), 10) || 0; }), pre: pre };
    }
    var a = parse(latest), b = parse(current), n = Math.max(a.parts.length, b.parts.length);
    for (var i = 0; i < n; i++) {
      var x = a.parts[i] || 0, y = b.parts[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    if (!a.pre && !b.pre) return 0;
    if (!a.pre) return 1;
    if (!b.pre) return -1;
    return a.pre > b.pre ? 1 : (a.pre === b.pre ? 0 : -1);
  }

  function currentVersion() {
    if (currentCache) return currentCache; // 原生事件已给出当前版本，优先采信
    try {
      if (native()) {
        var r = rt().getAppVersion();
        if (r) {
          var parsed = typeof r === 'string' ? JSON.parse(r) : r;
          if (parsed && parsed.version) return normalize(parsed.version);
        }
      }
    } catch (e) { }
    // 回退一：界面上的构建标记（例如「Android 1.19.0 · …」）
    var tag = el('buildTag');
    var text = tag && tag.textContent ? String(tag.textContent) : '';
    var match = text.match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/);
    if (match) return normalize(match[1]);
    // 回退二：页面自报的版本对象（web-preview / 桌面端由 web-bridge 注入）
    try {
      if (window.__VITALS && window.__VITALS.version) {
        var v = String(window.__VITALS.version).match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/);
        if (v) return normalize(v[1]);
      }
    } catch (e) { }
    return '';
  }

  /* ==================== 状态应用 ==================== */

  function setPhase(next) {
    phase = next;
    if (next === 'checking') { message = '正在查询最新版本…'; progress = { percent: -1, text: '' }; }
    render();
  }

  function apply(data) {
    info = data || {};
    if (data && data.ok === false) { fail(data.error || data.message || '检查更新失败'); return; }
    // 原生侧带回的当前版本最可信，先记录下来供界面与比较使用
    if (data && data.currentVersion) currentCache = normalize(data.currentVersion);
    if (data && data.latestVersion) info.latestVersion = normalize(data.latestVersion);
    if (!data || data.hasUpdate === false) { phase = 'latest'; message = (data && data.message) || ''; }
    else if (!data.hasApk) { phase = 'available'; message = '最新版本未提供 APK 安装包，请前往发布页手动下载'; }
    else { phase = 'available'; message = ''; }
    progress = { percent: -1, text: '' };
    render();
  }

  function fail(text) {
    busy = false; phase = 'error'; message = String(text || '更新失败'); progress = { percent: -1, text: '' };
    render();
  }

  /* ==================== 侧边栏入口 ==================== */

  function installDrawer() {
    var foot = document.querySelector('.sidebar-foot');
    if (!foot || el('updateGroup')) return;
    var group = document.createElement('div');
    group.className = 'migrate-group update-group';
    group.id = 'updateGroup';
    group.innerHTML = '<div class="migrate-title">软件更新</div>' +
      '<button class="btn ghost mini update-btn" id="updateBtn" type="button" title="从 GitHub 获取最新版本">检查更新</button>' +
      '<div class="update-line" id="updateLine">正在读取当前版本…</div>' +
      '<div class="update-line dim" id="updateRepo"></div>';
    var buildTag = el('buildTag');
    if (buildTag) foot.insertBefore(group, buildTag); else foot.appendChild(group);
    el('updateBtn').addEventListener('click', onPrimary);
    el('updateRepo').textContent = native() ? '来源 GitHub · 支持一键安装' : '来源 GitHub · 当前环境仅提示版本';
  }

  /* ==================== 设置页卡片 ==================== */

  function installCard() {
    var view = el('view-settings');
    if (!view || el('updateCard')) return;
    var card = document.createElement('section');
    card.className = 'panel glass update-card';
    card.id = 'updateCard';
    card.innerHTML = '<div class="panel-head"><h3>软件更新</h3><span class="pill" id="updatePill">未检查</span></div>' +
      '<p class="muted" id="updateHint">从 GitHub Release 获取新版本。' + (native() ? '下载完成后由系统安装器完成升级。' : '当前环境只提示版本信息，不会下载或安装。') + '</p>' +
      '<div class="update-grid">' +
      '<div><span class="update-label">当前版本</span><b id="updateCurrent">—</b></div>' +
      '<div><span class="update-label">最新版本</span><b id="updateLatest">—</b></div>' +
      '<div><span class="update-label">发布时间</span><b id="updateDate">—</b></div>' +
      '</div>' +
      '<div class="update-progress" id="updateProgress" hidden><div class="bar"><i id="updateBar"></i></div><span id="updatePercent"></span></div>' +
      '<div class="android-actions update-actions">' +
      '<button class="btn primary" id="updateCheckBtn" type="button">检查更新</button>' +
      '<button class="btn primary" id="updateInstallBtn" type="button" hidden>一键更新</button>' +
      '<button class="btn ghost" id="updatePageBtn" type="button">打开发布页</button>' +
      '</div>' +
      '<details class="update-notes"><summary>更新说明</summary><pre id="updateNotes">—</pre></details>';
    view.appendChild(card);
    el('updateCheckBtn').addEventListener('click', check);
    el('updateInstallBtn').addEventListener('click', function () { startUpdate(); });
    el('updatePageBtn').addEventListener('click', openReleasePage);
  }

  /* ==================== 渲染 ==================== */

  function render() {
    var btn = el('updateBtn'), line = el('updateLine'), pill = el('updatePill');
    if (btn) btn.setAttribute('data-phase', phase);
    var label = '检查更新', tone = '';
    if (phase === 'checking') label = '查询中…';
    else if (phase === 'available') { label = native() ? '一键更新' : '打开发布页'; tone = 'on'; }
    else if (phase === 'downloading') { label = '下载中 ' + progress.text; tone = 'on'; }
    else if (phase === 'downloaded') { label = '立即安装'; tone = 'on'; }
    else if (phase === 'installing') { label = '安装中…'; tone = 'on'; }

    if (btn) { btn.textContent = label; btn.disabled = (phase === 'checking' || phase === 'downloading' || phase === 'installing'); btn.classList.toggle('on', tone === 'on'); }

    var current = currentVersion() || '未知';
    var latest = info && info.latestVersion ? normalize(info.latestVersion) : '';
    var summary;
    if (phase === 'idle') summary = '当前版本 ' + current;
    else if (phase === 'checking') summary = '正在查询最新版本…';
    else if (phase === 'latest') summary = '当前已是最新版本（' + current + '）';
    else if (phase === 'available') summary = '发现新版本 ' + (latest || '') + (latest ? '，当前 ' + current : '');
    else if (phase === 'downloading') summary = info && info.latestVersion ? '正在下载 ' + normalize(info.latestVersion) + ' ' + progress.text : '正在下载 ' + progress.text;
    else if (phase === 'downloaded') summary = '下载完成，等待安装';
    else if (phase === 'installing') summary = '已交给系统安装器';
    else summary = message || '检查更新失败';
    if (line) { line.textContent = summary; line.classList.toggle('bad', phase === 'error'); }
    if (pill) {
      pill.textContent = phase === 'idle' ? '未检查' : phase === 'checking' ? '查询中' : phase === 'latest' ? '已是最新' : phase === 'available' ? '有新版本' : phase === 'downloading' ? '下载中' : phase === 'downloaded' ? '待安装' : phase === 'installing' ? '安装中' : '失败';
      pill.classList.toggle('on', phase === 'available' || phase === 'downloaded' || phase === 'installing');
    }
    if (el('updateCurrent')) el('updateCurrent').textContent = current;
    if (el('updateLatest')) el('updateLatest').textContent = latest || '—';
    if (el('updateDate')) el('updateDate').textContent = fmtTime(info && info.publishedAt);
    if (el('updateNotes')) el('updateNotes').textContent = (info && info.notes) ? String(info.notes) : '—';

    var install = el('updateInstallBtn');
    if (install) {
      install.hidden = !(phase === 'available' || phase === 'downloaded');
      install.textContent = phase === 'downloaded' ? '立即安装' : '一键更新';
      install.disabled = !native() || !(info && info.hasApk || phase === 'downloaded');
    }

    var box = el('updateProgress');
    if (box) {
      var show = progress.percent >= 0;
      box.hidden = !show;
      if (show) { el('updateBar').style.width = Math.max(0, Math.min(100, progress.percent)) + '%'; el('updatePercent').textContent = progress.text; }
    }

    ['updateBtn', 'updateCheckBtn', 'updateInstallBtn', 'updatePageBtn'].forEach(function (id) {
      var node = el(id); if (node) node.disabled = (id === 'updateInstallBtn') ? node.disabled : (phase === 'checking' || phase === 'downloading' || phase === 'installing');
    });

    if (dialogMounted) renderDialog();
  }

  /* ==================== 更新流程 ==================== */

  function startUpdate() {
    if (phase === 'downloaded' || phase === 'installing') { installNow(); return; }
    if (!native()) { openReleasePage(); return; }
    if (phase !== 'available') { check(); return; }
    showDialog();
  }

  /** 侧边栏按钮：按当前状态分派到检查 / 确认更新 / 安装 / 打开发布页。 */
  function onPrimary() {
    if (phase === 'downloading' || phase === 'checking' || phase === 'installing') return;
    if (phase === 'available') { startUpdate(); return; }
    if (phase === 'downloaded') { installNow(); return; }
    check();
  }

  function confirmDownload() {
    if (!info || !info.hasApk) { openReleasePage(); return; }
    // 只把 tag 交给原生，由原生重新解析 Release 资产地址并再次白名单校验，
    // 避免前端传入任意 URL 被用于下载（桥接口不可信）。
    if (!info.tag) { openReleasePage(); return; }
    closeDialog();
    busy = true;
    setPhase('downloading');
    try { rt().downloadUpdate(String(info.tag), Number(info.apkSize) || 0, info.sha256 || ''); } catch (e) { fail(e && e.message ? e.message : '无法开始下载'); }
  }

  function installNow() {
    if (!native()) { openReleasePage(); return; }
    busy = true;
    setPhase('installing');
    closeDialog();
    try { rt().installUpdate(); } catch (e) { fail(e && e.message ? e.message : '无法启动安装'); }
  }

  function openReleasePage() {
    var url = (info && info.pageUrl) || RELEASES_PAGE;
    if (native() && typeof rt().openUrl === 'function') { try { rt().openUrl(url); return; } catch (e) { } }
    try { var w = window.open(url, '_blank'); if (!w) throw new Error('blocked'); } catch (e) { location.href = url; }
  }

  /* ==================== 事件接收入口 ==================== */

  function onUpdateEvent(payload) {
    var data = payload;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
    if (!data || !data.status) return;
    // 原生事件带回的当前版本先落地，后续比较与界面显示都不再依赖同步桥
    if (data.currentVersion) currentCache = normalize(data.currentVersion);
    switch (data.status) {
      case 'checking':
        busy = true; setPhase('checking'); break;
      case 'checked':
        busy = false; apply(data); if (data.hasUpdate && data.hasApk) showDialog(); else if (data.hasUpdate) toast('发现新版本 ' + normalize(data.latestVersion) + '，但未提供安装包'); else if (data.message) toast(data.message); else toast('当前已是最新版本 ' + (currentCache || currentVersion())); break;
      case 'downloading':
        busy = true; setPhase('downloading'); if (Number(data.total) > 0) { progress = { percent: 0, text: '0%' }; } render(); break;
      case 'progress':
        phase = 'downloading'; progress = { percent: Number(data.percent) >= 0 ? Number(data.percent) : -1, text: data.percentText || '' }; render(); break;
      case 'downloaded':
        busy = false; phase = 'downloaded'; progress = { percent: 100, text: '已完成' }; render(); toast('更新包已下载完成，点击「立即安装」完成升级'); break;
      case 'installing':
        busy = true; setPhase('installing'); break;
      case 'permissionRequired':
        busy = false; phase = 'available'; message = data.message || '需要安装权限'; render(); toast(data.message || '请在系统设置中允许安装未知应用'); break;
      case 'cancelled':
        busy = false; phase = info && info.hasUpdate ? 'available' : 'idle'; message = data.message || '已取消'; render(); if (data.message) toast(data.message); break;
      case 'diagnostic':
        try { console.warn('[Vitals 更新] ' + (data.message || '')); } catch (e) { }
        break;
      case 'busy':
        busy = false; toast('更新任务正在进行，请稍候'); break;
      case 'error':
      default:
        busy = false; fail(data.message || '更新失败'); toast(data.message || '更新失败'); break;
    }
  }

  function toast(text) { if (typeof window.toast === 'function') window.toast(text); }

  /* ==================== 对话框 ==================== */

  function showDialog() {
    var mask = el('updateDialogMask');
    if (!mask) {
      mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.id = 'updateDialogMask';
      mask.innerHTML = '<div class="modal update-dialog"><div class="modal-head"><h3 id="updateDialogTitle">发现新版本</h3></div>' +
        '<div class="modal-body"><p id="updateDialogMeta" class="muted"></p><div class="update-dialog-notes" id="updateDialogNotes"></div></div>' +
        '<div class="modal-foot"><button class="btn ghost" id="updateDialogClose" type="button">稍后</button><button class="btn primary" id="updateDialogOk" type="button">立即更新</button></div></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', function (e) { if (e.target === mask) closeDialog(); });
      el('updateDialogClose').addEventListener('click', closeDialog);
      el('updateDialogOk').addEventListener('click', function () { if (phase === 'downloaded') installNow(); else if (phase === 'installing') closeDialog(); else confirmDownload(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialogMounted) closeDialog(); });
    }
    mask.classList.add('open');
    dialogMounted = true;
    renderDialog();
  }

  function renderDialog() {
    if (!el('updateDialogMask')) return;
    var title = el('updateDialogTitle'), meta = el('updateDialogMeta'), notes = el('updateDialogNotes');
    var ok = el('updateDialogOk'), close = el('updateDialogClose');
    var latest = info && info.latestVersion ? normalize(info.latestVersion) : '';
    if (phase === 'downloading') {
      title.textContent = '正在下载更新';
      meta.textContent = '版本 ' + latest + ' · ' + (progress.text || '准备中');
      notes.textContent = '下载在后台进行，完成后可选择立即安装。';
      ok.hidden = true; close.textContent = '后台继续';
    } else if (phase === 'downloaded') {
      title.textContent = '下载完成';
      meta.textContent = '版本 ' + latest + ' · 已通过包名校验';
      notes.textContent = '点击「立即安装」后将交给系统安装器完成升级，安装过程中请勿断电。';
      ok.hidden = false; ok.textContent = '立即安装'; ok.disabled = false; close.textContent = '稍后';
    } else if (phase === 'installing') {
      title.textContent = '等待系统安装';
      meta.textContent = '请在系统安装界面完成升级';
      notes.textContent = '安装完成后重新打开应用即为新版本。';
      ok.hidden = true; close.textContent = '关闭';
    } else {
      title.textContent = '发现新版本 ' + (latest || '');
      meta.textContent = '当前版本 ' + (currentVersion() || '未知') + ' · 发布于 ' + fmtTime(info && info.publishedAt) + (info && info.apkSize ? ' · 安装包 ' + sizeText(info.apkSize) : '');
      notes.textContent = (info && info.notes) ? String(info.notes) : '（本次发布未填写更新说明）';
      ok.hidden = false; ok.textContent = '立即更新'; ok.disabled = false; close.textContent = '稍后';
    }
  }

  function closeDialog() { var mask = el('updateDialogMask'); if (mask) mask.classList.remove('open'); dialogMounted = false; }
  function sizeText(bytes) { var n = Number(bytes) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB'; }

  /* ==================== 启动 ==================== */

  window.onVitalsUpdateEvent = onUpdateEvent;

  document.addEventListener('DOMContentLoaded', function () {
    installDrawer();
    installCard();
    var current = currentVersion();
    var line = el('updateLine');
    if (line) line.textContent = current ? '当前版本 ' + current : (native() ? '当前版本未知' : '当前环境仅提示版本');
    render();
    // 已确认运行在 Android 应用内时自动查询一次，让侧边栏直接显示是否有新版本。
    if (native()) check();
  });

  if (document.readyState !== 'loading') {
    // DOMContentLoaded 已经过去（脚本晚加载）时立即初始化
    setTimeout(function () {
      if (!el('updateGroup')) { installDrawer(); installCard(); render(); if (native()) check(); }
    }, 0);
  }
})();
