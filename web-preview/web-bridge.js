'use strict';
/* 网页预览版桥接层
   把 Android 原生桥（AndroidHost）在浏览器里用 localStorage 复刻一份，
   使同一套 assets/web 界面代码无需改动即可在浏览器中运行。
   浏览器无法访问 USB 串口设备，因此：
     温控串口 / CH340 机械板 / 得力扫码枪  → 模拟连接，扫码枪改为手工输入编号
     得力 DL-720 标签机                    → 模拟连接，系统打印走浏览器打印对话框
     导出 / 导入                           → 浏览器下载 / 文件选择
   数据全部保存在本机浏览器的 localStorage（键 vitals.preview.db），与安卓版互不影响。 */
(function (global) {
  const BUILD = 'web-preview-20261008a';
  const DB_KEY = 'vitals.preview.db';
  const REPO_SLUG = '9573351-crypto/vitals-biosample';
  const ROLES = { sensor: '温控串口', motion: '机械板', scanner: '扫码枪' };
  const CHANGE_FIELDS = ['expectedRevision', 'upsertSamples', 'deleteSamples', 'addRecords', 'deleteRecords', 'setSettings', 'deleteSettings'];
  const connected = { sensor: false, motion: false, scanner: false };

  /* ==================== 存储 ==================== */
  function blank() {
    return { revision: 0, samples: {}, records: [], settings: { hi: 8, lo: -88, simOn: false, online: 0 }, nextRecordId: 1 };
  }

  function rawGet() {
    try { return global.localStorage.getItem(DB_KEY); } catch (_) { return null; }
  }
  function rawSet(text) {
    try { global.localStorage.setItem(DB_KEY, text); return true; } catch (_) { return false; }
  }

  /* 首次打开时注入一批演示样本，让预览版一进来就有内容可看。 */
  function seed() {
    const db = blank();
    const now = Date.now();
    const p = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const mk = (i, temp, name, type, slot, alert, monitor) => ({
      id: 'SB-' + (10000 + i),
      name, code: 'SB-' + (90000 + i), type,
      loc: slot == null ? '已出库' : '圆盘-' + (slot - 1),
      slot: slot == null ? undefined : slot,
      status: slot == null ? 'out' : 'in',
      timeRaw: '', timeTxt: fmt(new Date(now + i * 60000)),
      temp, note: '预览示例数据（可在「设置」中清空）', photo: null,
      createdAt: now + i * 60000, updatedAt: now + i * 60000,
      monitor, lastTemp: temp, lastHum: null, alert, lastUpdate: null,
      pendingIntake: false,
      env: Array.from({ length: 20 }, (_, k) => ({ time: '', temp: +(temp + Math.sin(k / 3) * 1.6 + (Math.random() - 0.5)).toFixed(2) }))
    });
    [
      mk(0, 5.2, '血清样本-01', '血清', 1, 'good', true),
      mk(1, -78.5, 'DNA样本-02', 'DNA', 2, 'warn', true),
      mk(2, 4.1, '全血样本-03', '全血', 3, 'good', false),
      mk(3, -20.3, '血浆样本-04', '血浆', null, 'good', false),
      mk(4, 2.8, '尿液样本-05', '尿液', 4, 'good', false)
    ].forEach(x => {
      if (x.status === 'out') { x.lastSlot = 3; delete x.slot; }
      db.samples[x.id] = x;
    });
    [
      ['系统', '初始化', '已载入 5 个预览示例样本（可在设置中清空）'],
      ['血清样本-01', '入库', '存放至 圆盘-0'],
      ['DNA样本-02', '入库', '存放至 圆盘-1'],
      ['全血样本-03', '入库', '存放至 圆盘-2'],
      ['血浆样本-04', '出库', '人工确认完成，槽位 2']
    ].forEach((r, i) => {
      db.records.push({
        recordId: db.nextRecordId++, time: fmt(new Date(now - (5 - i) * 3600000)),
        sample: r[0], sampleId: null, code: null, slot: null, status: null, taskId: null,
        type: r[1], detail: r[2]
      });
    });
    db.records.reverse(); // 记录按最新在前排列
    rawSet(JSON.stringify(db));
    return db;
  }

  function read() {
    const raw = rawGet();
    if (!raw) return seed();
    try {
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return seed();
      return {
        revision: Number(d.revision) || 0,
        samples: d.samples && typeof d.samples === 'object' ? d.samples : {},
        records: Array.isArray(d.records) ? d.records : [],
        settings: d.settings && typeof d.settings === 'object' ? d.settings : { hi: 8, lo: -88 },
        nextRecordId: Number(d.nextRecordId) || 1
      };
    } catch (_) { return seed(); }
  }

  function write(db) {
    if (!rawSet(JSON.stringify(db))) throw new Error('浏览器本地存储不可用或已满，请先在「设置」导出备份');
  }

  /* ==================== 事件回传（原生 → 页面） ==================== */
  function emit(type, role, text) {
    const fn = global.onAndroidEvent;
    if (typeof fn === 'function') fn(type, role, String(text == null ? '' : text));
  }
  function j(o) { return JSON.stringify(o); }
  function fail(message) { return j({ ok: false, error: String(message) }); }

  /* ==================== AndroidHost 实现 ==================== */
  const host = {
    /* ---- 数据库 ---- */
    getDatabaseInfo() { const db = read(); return j({ version: 1, revision: db.revision, legacyMigration: '' }); },
    getSamples() { return j(read().samples); },
    getRecords(sampleId) {
      const all = read().records;
      const sid = sampleId == null || sampleId === '' ? null : String(sampleId);
      return j(sid ? all.filter(r => r.sampleId === sid) : all);
    },
    getSettings() { return j(Object.assign({ hi: 8, lo: -88 }, read().settings)); },

    commitChanges(payload) {
      try {
        const db = read();
        const change = JSON.parse(payload || '{}');
        for (const k of Object.keys(change)) if (CHANGE_FIELDS.indexOf(k) < 0) throw new Error('未知变更字段');
        if (change.expectedRevision != null && Number(change.expectedRevision) !== db.revision) throw new Error('数据已变化，请刷新后重试');

        (change.deleteRecords || []).forEach(v => {
          const rid = Number(v);
          if (!Number.isFinite(rid) || rid <= 0) throw new Error('记录 ID 无效');
          db.records = db.records.filter(r => Number(r.recordId) !== rid);
        });
        (change.deleteSamples || []).forEach(sid => { delete db.samples[String(sid)]; });
        (change.upsertSamples || []).forEach(x => {
          const copy = JSON.parse(JSON.stringify(x));
          if (!copy.id) throw new Error('样本缺少内部 ID');
          if (!copy.status) copy.status = 'in';
          if (copy.status === 'out' && copy.slot != null) { copy.lastSlot = copy.slot; delete copy.slot; }
          db.samples[copy.id] = copy;
        });
        const added = [], ids = [];
        (change.addRecords || []).forEach(r => {
          const rec = Object.assign({}, r);
          rec.recordId = db.nextRecordId++;
          added.push(rec); ids.push(rec.recordId);
        });
        db.records = added.concat(db.records);
        const set = change.setSettings || {};
        Object.keys(set).forEach(k => { db.settings[k] = set[k]; });
        (change.deleteSettings || []).forEach(k => { delete db.settings[k]; });

        const task = db.settings.motionTask;
        if (task && task.slot != null && Object.values(db.samples).some(x => x.slot === task.slot && x.id !== task.sampleId))
          throw new Error('任务槽位被其他样本占用');

        db.revision += 1;
        write(db);
        return j({ ok: true, revision: db.revision, recordIds: ids });
      } catch (e) { return fail(e && e.message ? e.message : e); }
    },

    importBackup(payload) {
      try {
        if (payload == null || String(payload).length > 24 * 1024 * 1024) throw new Error('备份过大或为空');
        if (!global.MotionCore) throw new Error('备份校验模块未加载');
        const backup = global.MotionCore.validateBackup(JSON.parse(String(payload).replace(/^\uFEFF/, '')));
        const db = read();
        if (db.settings.motionTask) throw new Error('请先处理当前机械任务');
        db.samples = {};
        Object.keys(backup.samples).forEach(k => { db.samples[k] = backup.samples[k]; });
        db.records = []; db.nextRecordId = 1;
        (backup.records || []).forEach(r => {
          const rec = Object.assign({}, r);
          rec.recordId = db.nextRecordId++;
          db.records.push(rec);
        });
        db.records.reverse();
        db.settings = backup.settings || { hi: 8, lo: -88 };
        db.revision += 1;
        write(db);
        return j({ ok: true, revision: db.revision });
      } catch (e) { return fail(e && e.message ? e.message : e); }
    },

    getBackup() {
      const db = read();
      return j({
        app: 'vitals-biosample', version: 2, exportedAt: new Date().toISOString(),
        samples: db.samples, records: db.records,
        settings: Object.assign({ hi: 8, lo: -88 }, db.settings)
      });
    },

    /* ---- 设备（浏览器无 USB 主机，一律模拟） ---- */
    getExternalDevices() { return j({ scanner: 1, printer: 1 }); },
    connect(role, baud) {
      if (!ROLES[role]) return;
      if (!(Number(baud) >= 300 && Number(baud) <= 2000000)) { emit('error', role, '波特率无效'); return; }
      setTimeout(() => {
        connected[role] = true;
        emit('connected', role, ROLES[role] + '已连接（网页预览模拟）');
      }, 240);
    },
    disconnect(role) {
      if (!ROLES[role]) return;
      setTimeout(() => {
        connected[role] = false;
        emit('disconnected', role, ROLES[role] + '已断开');
      }, 0);
    },
    send(role, line) {
      const text = String(line == null ? '' : line);
      if (text.length > 4096 || /[\r\n]/.test(text)) { emit('error', role, '无效命令行'); return; }
      if (!connected[role]) { emit('error', role, '设备未连接'); return; }
      emit('sent', role, text);
      // 模拟 CH340 机械板收到指令后回一个到位 OK；硬件模式下的出库任务会据此自动完成。
      if (role === 'motion') setTimeout(() => { if (connected.motion) emit('line', 'motion', 'ok'); }, 900);
    },

    /* ---- 更新（网页预览：只读查询 GitHub，不具备安装能力） ---- */
    getAppVersion() { return j({ version: '1.19.2', versionCode: 33, repo: REPO_SLUG, simulated: true }); },
    checkUpdate() {
      try {
        const url = 'https://api.github.com/repos/' + REPO_SLUG + '/releases/latest';
        fetch(url, { headers: { Accept: 'application/vnd.github+json' } }).then(response => {
          if (response.status === 404) { emit('update', '', j({ status: 'checked', ok: true, hasUpdate: false, latestVersion: '1.18.2', message: '仓库尚未发布任何版本' })); return null; }
          if (!response.ok) throw new Error('GitHub 返回错误：HTTP ' + response.status);
          return response.json();
        }).then(release => {
          if (!release) return;
          const tag = String(release.tag_name || '').replace(/^[vV]/, '');
          const asset = (release.assets || []).filter(a => /\.apk$/i.test(a.name || ''))[0] || null;
          emit('update', '', j({
            status: 'checked', ok: true, hasUpdate: false, latestVersion: tag || '1.18.2',
            tag: release.tag_name || '', notes: release.body || '', pageUrl: release.html_url || '',
            publishedAt: release.published_at || '', apkName: asset ? asset.name : '', apkSize: asset ? asset.size : 0,
            hasApk: !!asset, port: 'web', message: '网页预览版只提示版本，不会下载或安装'
          }));
        }).catch(error => {
          emit('update', '', j({ status: 'error', ok: false, message: (error && error.message) || '检查更新失败' }));
        });
      } catch (e) { emit('update', '', j({ status: 'error', ok: false, message: (e && e.message) || '检查更新失败' })); }
    },
    downloadUpdate() { emit('update', '', j({ status: 'error', ok: false, message: '网页预览版不支持下载安装包，请在 Android 应用内使用一键更新' })); },
    installUpdate() { emit('update', '', j({ status: 'error', ok: false, message: '网页预览版不支持安装，请在 Android 应用内使用一键更新' })); },
    openUrl(url) {
      const text = String(url == null ? '' : url);
      if (!/^https:\/\/github\.com\//.test(text)) { emit('error', '', '只允许打开 GitHub 地址'); return; }
      global.open(text, '_blank');
    },

    /* ---- 文件 ---- */
    exportJson(filename, content) {
      try {
        const name = filename || ('vitals_backup_' + Date.now() + '.json');
        const url = URL.createObjectURL(new Blob([String(content == null ? '' : content)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        emit('export', '', '已导出备份：' + name);
      } catch (e) { emit('export', '', '导出失败：' + (e && e.message ? e.message : e)); }
    },
    importJson() {
      const input = document.getElementById('importFile');
      if (!input) { emit('error', '', '当前页面缺少导入入口'); return; }
      input.click();
    },

    /* ---- 打印 ---- */
    printLabel() { global.print(); },
    connectLabelPrinter() { emit('ready', 'printer', '打印机已就绪（网页预览模拟）'); },
    printUsbLabel() { emit('sent', 'printer', '已模拟发送 1 张标签，网页预览不会真的走纸'); }
  };

  global.AndroidHost = host;
  global.__VITALS_PREVIEW = BUILD;

  /* ==================== 预览层附加行为 ==================== */
  function injectScanInput(panel) {
    const dialog = panel.querySelector('.scanner-dialog');
    if (!dialog || dialog.querySelector('#previewScanInput')) return;
    const box = document.createElement('div');
    box.className = 'preview-scan';
    box.innerHTML = '<p>网页预览版没有扫码枪：输入或粘贴样本编号后回车，等同于扫码一次。</p>' +
      '<div class="preview-scan-row"><input class="input" id="previewScanInput" placeholder="例如 SB-90001" autocomplete="off" spellcheck="false">' +
      '<button class="btn primary" id="previewScanSend" type="button">模拟扫码</button></div>';
    dialog.insertBefore(box, dialog.querySelector('#scannerCancel'));
    const input = box.querySelector('#previewScanInput');
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      if (typeof global.onVitalsScannerData === 'function') global.onVitalsScannerData(v);
    };
    box.querySelector('#previewScanSend').addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    setTimeout(() => input.focus(), 80);
  }

  // load 事件晚于所有 defer 脚本，此时 scanner.js 已挂好 openVitalsScanner。
  global.addEventListener('load', () => {
    const tag = document.getElementById('buildTag');
    if (tag) {
      tag.textContent = '网页预览版 · 硬件为模拟 · 数据存浏览器';
      tag.title = '构建 ' + BUILD + '：数据保存在本机浏览器 localStorage，USB 硬件为模拟';
    }

    const openScanner = global.openVitalsScanner;
    if (typeof openScanner === 'function') {
      global.openVitalsScanner = function (mode, context) {
        const r = openScanner.call(this, mode, context);
        const panel = document.getElementById('scannerPanel');
        if (panel && panel.classList.contains('open')) injectScanInput(panel);
        return r;
      };
    }

    setTimeout(() => emit('error', '', '网页预览版：数据保存在本机浏览器，USB 硬件（温控／机械板／扫码枪／标签机）为模拟，不会真的驱动设备'), 900);
  });
})(typeof window !== 'undefined' ? window : globalThis);
