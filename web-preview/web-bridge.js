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
    // 种子样本必须符合 1.18.2 起的存储规则：只有全血 / 血清 / 血浆可占槽，且同一类型内槽位唯一。
    // 之前的 DNA / 尿液 样本占槽会被 validateBackup 判定为非法，导致预览版备份往返必然失败。
    [
      mk(0, 5.2, '血清样本-01', '血清', 1, 'good', true),
      mk(1, -78.5, '血清样本-02', '血清', 2, 'warn', true),
      mk(2, 4.1, '全血样本-03', '全血', 3, 'good', false),
      mk(3, -20.3, '血浆样本-04', '血浆', null, 'good', false),
      mk(4, 2.8, '血浆样本-05', '血浆', 4, 'good', false)
    ].forEach(x => {
      if (x.status === 'out') { x.lastSlot = 3; delete x.slot; }
      db.samples[x.id] = x;
    });
    [
      ['系统', '初始化', '已载入 5 个预览示例样本（可在设置中清空）'],
      ['血清样本-01', '入库', '存放至 血清圆盘 1号'],
      ['血清样本-02', '入库', '存放至 血清圆盘 2号'],
      ['全血样本-03', '入库', '存放至 全血圆盘 3号'],
      ['血浆样本-04', '出库', '人工确认完成，槽位 4号']
    ].forEach((r, i) => {
      db.records.push({
        recordId: db.nextRecordId++, time: fmt(new Date(now - (5 - i) * 3600000)),
        sample: r[0], sampleId: null, code: null, slot: null, status: null, taskId: null,
        type: r[1], detail: r[2],
        // 契约 C：记录来源与动作枚举，便于记录页筛选
        source: 'system', type_code: 'system', operator: null
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
  function ok(o) { return j(Object.assign({ ok: true }, o || {})); }
  // 让测试工具能直接操作内存库（浏览器自检脚本用），仅预览版存在
  function expose(db) { try { global.__vitalsDb = db; } catch (_) { } return db; }
  function dbNow() { return expose(read()); }

  /* ---- 备份校验和：与原生 BackupFormat 逐字节对齐的规范化算法 ---- */
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
  }
  function checksumOf(samples, records, settings) {
    return 'sha256:' + sha256Hex(canonical(samples) + canonical(records) + canonical(settings));
  }
  // 同步 SHA-256：浏览器原生 crypto.subtle 是异步的，而桥方法必须同步返回，
  // 因此这里内置一份标准实现，保证与原生 BackupFormat 的校验和结果逐字节一致。
  function sha256Hex(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0xd800 || code >= 0xe000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else {
        i++;
        const point = 0x10000 + (((code & 0x3ff) << 10) | (text.charCodeAt(i) & 0x3ff));
        bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
      }
    }
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const length = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // 64 位大端长度；JavaScript 位运算只有 32 位，故拆高低两半分别右移
    const highBits = Math.floor(length / 0x20000000);
    const lowBits = (length << 3) >>> 0;
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((highBits >>> shift) & 0xff);
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((lowBits >>> shift) & 0xff);
    const w = new Array(64);
    const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = ((bytes[offset + i * 4] << 24) | (bytes[offset + i * 4 + 1] << 16) | (bytes[offset + i * 4 + 2] << 8) | bytes[offset + i * 4 + 3]) >>> 0;
      for (let i = 16; i < 64; i++) {
        const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      const next = [a, b, c, d, e, f, g, h];
      for (let i = 0; i < 8; i++) H[i] = (H[i] + next[i]) >>> 0;
    }
    return H.map(x => ('00000000' + x.toString(16)).slice(-8)).join('');
  }

  /* ---- 指纹与差异（与原生 merge 语义保持一致） ---- */
  function recordFingerprint(r) {
    return [r.time, r.sample, r.type, r.detail, r.code, r.slot, r.status].map(v => v == null ? '' : String(v)).join('|');
  }
  function sampleMapOf(db) { return db.samples || {}; }
  function photoOf(sample) {
    const photo = sample && sample.photo;
    if (!photo || typeof photo !== 'string') return null;
    const comma = photo.indexOf(',');
    return comma < 0 ? null : { meta: photo.slice(0, comma + 1), base64: photo.slice(comma + 1) };
  }
  function thumbOf(photo) {
    // 预览版没有原生缩略图管线：直接沿用原图 data URL 作为 thumb（仅体积差异，不影响功能验证）
    return photo || null;
  }

  /* ==================== AndroidHost 实现 ==================== */
  const host = {
    /* ---- 数据库 ---- */
    // 预览库结构对应原生 schema v3（DB_VERSION=3 + ensureSchema 增量列）
    getDatabaseInfo() { const db = dbNow(); return j({ version: 3, revision: db.revision, legacyMigration: '' }); },
    getSamples() { return j(dbNow().samples); },
    getRecords(sampleId) {
      const all = dbNow().records;
      const sid = sampleId == null || sampleId === '' ? null : String(sampleId);
      return j(sid ? all.filter(r => r.sampleId === sid) : all);
    },
    getSettings() { return j(Object.assign({ hi: 8, lo: -88 }, dbNow().settings)); },
    /** 契约 B：单事务一致读（浏览器为单线程内存库，天然一致）；samples 剔除全图，只留 thumb。 */
    snapshot() {
      try {
        const db = dbNow();
        const samples = {};
        Object.keys(sampleMapOf(db)).forEach(id => {
          const copy = JSON.parse(JSON.stringify(db.samples[id]));
          delete copy.photo; // 与原生一致：快照不含全图
          samples[id] = copy;
        });
        return j({ ok: true, s: { samples }, rec: db.records, set: Object.assign({ hi: 8, lo: -88 }, db.settings), revision: db.revision });
      } catch (e) { return fail(e && e.message ? e.message : e); }
    },
    /** 契约 A：按需取图；full=false 只回 thumb。 */
    getSamplePhoto(id, full) {
      try {
        const db = dbNow();
        const sample = db.samples[String(id)];
        if (!sample) return j({ id: String(id), hash: '', thumb: '', missing: true });
        const photo = photoOf(sample);
        const out = { id: String(id), hash: sample.photoHash || '', thumb: sample.thumb || thumbOf(sample.photo) || '', photo: null, missing: !photo };
        if (full && photo) out.photo = sample.photo;
        return j(out);
      } catch (e) { return fail(e && e.message ? e.message : e); }
    },
    /** 契约 C：记录分页与筛选（limit 上限 500，默认 200）。 */
    recordsPage(fromIso, toIso, typeCode, limit, offset) {
      try {
        const db = dbNow();
        const size = !limit || limit <= 0 ? 200 : Math.min(limit, 500);
        const skip = offset && offset > 0 ? Number(offset) : 0;
        const filtered = db.records.filter(r => {
          if (fromIso && String(r.time || '') < String(fromIso)) return false;
          if (toIso && String(r.time || '') > String(toIso)) return false;
          if (typeCode && String(r.type_code || '') !== String(typeCode) && String(r.typeCode || '') !== String(typeCode)) return false;
          return true;
        });
        return j({ ok: true, records: filtered.slice(skip, skip + size), total: filtered.length, hasMore: skip + size < filtered.length });
      } catch (e) { return fail(e && e.message ? e.message : e); }
    },
    /** 契约 F：自描述备份。checksum 对「原样 payload」计算（含 recordId / photo），
     *  与原生一致；这样导出的备份能被导入校验接受，也能与原生导出的备份互换。 */
    exportBackup(includePhotos) {
      try {
        const db = dbNow();
        const samples = {};
        Object.keys(sampleMapOf(db)).forEach(id => {
          const copy = JSON.parse(JSON.stringify(db.samples[id]));
          if (includePhotos === false) { delete copy.photo; delete copy.thumb; }
          samples[id] = copy;
        });
        const records = JSON.parse(JSON.stringify(db.records));
        const settings = Object.assign({ hi: 8, lo: -88 }, db.settings);
        return j({
          app: 'vitals-biosample', schemaVersion: 4, appVersion: '1.19.2',
          exportedAt: new Date().toISOString(),
          counts: { samples: Object.keys(samples).length, records: records.length },
          checksum: checksumOf(samples, records, settings),
          samples, records, settings
        });
      } catch (e) { return fail(e && e.message ? e.message : e); }
    },
    /** 契约 F：preview / replace / merge 三种导入模式 + 条码子集恢复。 */
    importBackupEx(payload, mode, filterJson) {
      try {
        if (!global.MotionCore) throw new Error('备份校验模块未加载');
        const text = String(payload == null ? '' : payload).replace(/^\uFEFF/, '');
        const raw = JSON.parse(text);
        const backup = global.MotionCore.validateBackup(raw);
        const filter = filterJson ? JSON.parse(filterJson) : null;
        const db = dbNow();

        // checksum / counts 校验（旧形状没有这两个字段时跳过，视为兼容路径）
        if (raw && raw.checksum) {
          const expect = checksumOf(raw.samples || {}, raw.records || [], raw.settings || {});
          if (expect !== raw.checksum) throw new Error('备份校验和不匹配，文件可能被修改或截断');
        }
        if (raw && raw.counts && raw.samples && Array.isArray(raw.records)) {
          if (Number(raw.counts.samples) !== Object.keys(raw.samples).length || Number(raw.counts.records) !== raw.records.length) {
            throw new Error('备份条目数与内容不一致');
          }
        }

        const wanted = filter && (filter.onlySampleIds || filter.onlyCodes) ? filter : null;
        const incoming = backup.samples || {};
        const ids = Object.keys(incoming).filter(id => {
          if (!wanted) return true;
          if (wanted.onlySampleIds && wanted.onlySampleIds.indexOf(id) >= 0) return true;
          if (wanted.onlyCodes && wanted.onlyCodes.indexOf(incoming[id].code) >= 0) return true;
          return false;
        });
        const records = (backup.records || []).filter(r => !wanted || ids.indexOf(r.sampleId) >= 0 || (r.code && wanted.onlyCodes && wanted.onlyCodes.indexOf(r.code) >= 0));

        // 冲突检测（按 id 去重，条码冲突即报错）
        const codes = {};
        Object.keys(db.samples).forEach(id => { if (db.samples[id].code) codes[db.samples[id].code] = id; });
        const conflictCodes = [];
        ids.forEach(id => {
          const code = incoming[id].code;
          if (code && codes[code] && codes[code] !== id) conflictCodes.push(code);
        });
        const existing = new Set(db.records.map(recordFingerprint));
        const newRecords = records.filter(r => !existing.has(recordFingerprint(r))).length;
        const payloadCounts = raw && raw.counts ? { samples: Number(raw.counts.samples) || 0, records: Number(raw.counts.records) || 0 } : { samples: Object.keys(incoming).length, records: (backup.records || []).length };

        if (mode === 'preview') {
          return j({
            ok: true, dryRun: true, counts: { samples: ids.length, records: records.length }, backupCounts: payloadCounts,
            diff: {
              newSamples: ids.filter(id => !db.samples[id]).length,
              updatedSamples: ids.filter(id => !!db.samples[id]).length,
              conflictCodes, newRecords, duplicateRecords: records.length - newRecords
            },
            warnings: conflictCodes.length ? ['存在条码冲突，合并导入会被拒绝'] : [], mode: 'preview'
          });
        }
        if (conflictCodes.length) throw new Error('条码冲突：' + conflictCodes.slice(0, 5).join('、'));
        if (mode === 'replace' && (Object.keys(db.samples).length || db.records.length)) {
          return fail('本机已有数据，replace 仅允许在空库使用，请改用 merge');
        }

        const db2 = dbNow();
        if (mode === 'replace') { db2.samples = {}; db2.records = []; }
        ids.forEach(id => { db2.samples[id] = incoming[id]; });
        const seen = new Set(db2.records.map(recordFingerprint));
        records.forEach(r => {
          if (seen.has(recordFingerprint(r))) return;
          const rec = Object.assign({}, r);
          rec.recordId = db2.nextRecordId++;
          if (rec.sampleId == null && wanted && r.code && wanted.onlyCodes) {
            const hit = ids.find(i => incoming[i].code === r.code);
            if (hit) rec.sampleId = hit;
          }
          db2.records.push(rec);
          seen.add(recordFingerprint(rec));
        });
        if (backup.settings) db2.settings = Object.assign({}, backup.settings);
        db2.revision += 1;
        write(dbNow());
        return j({ ok: true, mode, revision: db2.revision, imported: { samples: ids.length, records: newRecords } });
      } catch (e) { return fail(e && e.message ? e.message : e); }
    },
    /** 契约 G：CSV 文本（带 BOM，供 Excel 正确识别 UTF-8）。 */
    exportCsv(kind, optionsJson) {
      try {
        const options = optionsJson ? JSON.parse(optionsJson) : {};
        const db = dbNow();
        const cell = v => {
          const text = v == null ? '' : String(v);
          return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
        };
        const row = arr => arr.map(cell).join(',');
        const inRange = t => (!options.fromIso || String(t || '') >= options.fromIso) && (!options.toIso || String(t || '') <= options.toIso);
        const lines = [];
        if (kind === 'samples') {
          lines.push(row(['内部ID', '名称', '编号', '类别', '位置', '状态', '采集时间', '温度', '备注']));
          Object.keys(sampleMapOf(db)).forEach(id => {
            const x = db.samples[id];
            lines.push(row([id, x.name, x.code, x.type, x.loc, x.status === 'out' ? '已出库' : '已入库', x.timeTxt || x.timeRaw, x.temp, x.note]));
          });
        } else if (kind === 'env') {
          lines.push(row(['样本ID', '样本名称', '时间', '温度']));
          Object.keys(sampleMapOf(db)).forEach(id => {
            const x = db.samples[id];
            (x.env || []).forEach(p => { if (inRange(p.time)) lines.push(row([id, x.name, p.time, p.temp])); });
          });
        } else {
          lines.push(row(['时间', '样本', '编号', '类型', '明细', '槽位', '状态', '任务号', '来源']));
          db.records.forEach(r => {
            if (!inRange(r.time)) return;
            if (options.typeCode && String(r.type_code || '') !== String(options.typeCode)) return;
            lines.push(row([r.time, r.sample, r.code, r.type, r.detail, r.slot, r.status, r.taskId, r.source]));
          });
        }
        return '\uFEFF' + lines.join('\r\n') + '\r\n';
      } catch (e) { throw new Error(e && e.message ? e.message : 'CSV 生成失败'); }
    },

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
    getAppVersion() { return j({ version: '1.21.2', versionCode: 38, repo: REPO_SLUG, simulated: true }); },
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
