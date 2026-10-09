#!/usr/bin/env node
/* 生成备份校验与合并场景的确定性夹具（Node 标准库，无依赖）。
   用于验证：checksum、计数、schema 版本、条码冲突、合并去重、子集恢复。
   运行：node .local-ci/make-backup-fixtures.mjs  → 输出到 .local-ci/fixtures/ */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'fixtures');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/* 规范化 JSON：对象键排序、无多余空白。必须与被测实现保持一致。 */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
function checksumOf(samples, records, settings) {
  const payload = canonical(samples) + canonical(records) + canonical(settings);
  return 'sha256:' + createHash('sha256').update(payload, 'utf8').digest('hex');
}
function backup(samples, records, settings, extra = {}) {
  const base = {
    app: 'vitals-biosample',
    schemaVersion: 4,
    appVersion: '1.19.3',
    exportedAt: '2026-10-09T08:00:00+08:00',
    counts: { samples: Object.keys(samples).length, records: records.length },
    checksum: checksumOf(samples, records, settings),
    samples, records, settings
  };
  return Object.assign(base, extra);
}
const sample = (id, code, name, slot, type = '全血') => ({
  id, name, code, type, status: slot == null ? 'out' : 'in',
  slot: slot == null ? undefined : slot,
  loc: slot == null ? '已出库' : `圆盘-${slot - 1}`,
  timeTxt: '2026-10-09 08:00', timeRaw: '2026-10-09T08:00',
  temp: 4.2, monitor: false, alert: 'good', createdAt: 1759968000000, updatedAt: 1759968000000,
  pendingIntake: false,
  env: [{ time: '2026-10-09T08:00', temp: 4.2 }, { time: '2026-10-09T08:01', temp: 4.3 }]
});
const record = (n, sid, name) => ({
  recordId: n, sampleId: sid, sample: name, time: '2026-10-09T08:00', type: '入库',
  detail: '夹具记录 ' + n, code: 'SB-' + (90000 + n), slot: 1, status: 'in', taskId: 'T-FIXTURE-' + n,
  source: 'manual', type_code: 'in', operator: '夹具'
});

const samplesA = { 'SB-10001': sample('SB-10001', 'SB-90001', '血清样本-01', 1, '血清') };
const recordsA = [record(1, 'SB-10001', '血清样本-01'), record(2, 'SB-10001', '血清样本-01')];
const settings = { hi: 8, lo: -88, simOn: false, online: 0 };

/* 1) 正常备份 */
const good = backup(samplesA, recordsA, settings);
write('good.json', good);

/* 2) 内容被改动但 checksum 未更新 → 应被拒绝 */
const tampered = JSON.parse(JSON.stringify(good));
tampered.samples['SB-10001'].name = '被篡改的样本名';
write('tampered.json', tampered);

/* 3) 计数不符 → 应被拒绝 */
const badCounts = JSON.parse(JSON.stringify(good));
badCounts.counts.samples = 99;
write('bad-counts.json', badCounts);

/* 4) app 字段不匹配 → 应被拒绝 */
write('foreign-app.json', Object.assign({}, good, { app: 'other-app' }));

/* 5) schemaVersion 高于当前 → 应被拒绝 */
write('future-schema.json', Object.assign({}, good, { schemaVersion: 99 }));

/* 6) 截断文件（JSON 不完整） */
writeRaw('truncated.json', JSON.stringify(good).slice(0, Math.floor(JSON.stringify(good).length * 0.6)));

/* 7) 合并用（合法）：同 id 更新 + 新样本 + 一条重复记录 + 一条新记录 */
const samplesB = {
  'SB-10001': Object.assign(sample('SB-10001', 'SB-90001', '血清样本-01（已更新）', 2, '血清'), { note: '合并更新' }),
  'SB-10002': sample('SB-10002', 'SB-90002', '全血样本-02', 1, '全血')
};
const recordsB = [recordsA[0], record(3, 'SB-10002', '全血样本-02'), record(4, 'SB-10002', '全血样本-02')];
const merge = backup(samplesB, recordsB, settings);
write('merge.json', merge);

/* 7b) 条码冲突用：新样本 SB-10003 复用了 SB-10001 的条码 SB-90001。
       注意它自身不合法（同一条码出现两次会被 validateBackup 拒绝），
       因此 checksum 在「写入前」的合法副本上计算，用于专门验证冲突检测路径。 */
const conflictSamples = {
  'SB-10003': sample('SB-10003', 'SB-90001', '条码冲突样本', 3, '血浆')
};
const conflict = backup(conflictSamples, [], settings);
write('conflict-code.json', conflict);

/* 8) 子集恢复：只包含 SB-10002 与其记录 */
const subset = backup({ 'SB-10002': samplesB['SB-10002'] }, [record(3, 'SB-10002', '全血样本-02')], settings);
write('subset.json', subset);

/* 9) 旧形状（{s:{samples}}，无 schemaVersion/checksum）→ 走兼容路径 */
const legacyShape = {
  s: { samples: samplesA, samplesSeeded: true, records: recordsA },
  rec: recordsA, set: settings
};
write('legacy-shape.json', legacyShape);

/* 10) 含照片的备份（照片外置后应仍可导入，photo 作为兼容字段） */
const withPhoto = JSON.parse(JSON.stringify(good));
withPhoto.samples['SB-10001'].photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
withPhoto.checksum = checksumOf(withPhoto.samples, withPhoto.records, withPhoto.settings);
write('with-photo.json', withPhoto);

function write(name, obj) { writeRaw(name, JSON.stringify(obj, null, 2)); }
function writeRaw(name, text) { writeFileSync(join(out, name), text, 'utf8'); }

console.log('夹具已生成到 ' + out);
for (const name of ['good.json', 'tampered.json', 'bad-counts.json', 'foreign-app.json', 'future-schema.json', 'truncated.json', 'merge.json', 'subset.json', 'legacy-shape.json', 'with-photo.json']) {
  console.log('  ' + name.padEnd(20) + statSync(join(out, name)).size + ' 字节');
}
console.log('\n正常备份的 checksum = ' + good.checksum);
