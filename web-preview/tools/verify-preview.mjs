/* 网页预览版自检：在 Node 里用假的 localStorage 跑真实的 persistence.js，
   验证 web-bridge.js 提供的 AndroidHost 契约与安卓原生一致。
   运行： node tools/verify-preview.mjs */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 假环境 ---------- */
const disk = {};
const localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(disk, k) ? disk[k] : null),
  setItem: (k, v) => { disk[k] = String(v); },
  removeItem: k => { delete disk[k]; }
};
const sandbox = {
  console, setTimeout, clearTimeout, JSON, Math, Date, Array, Object, Number, String, Error, Promise, Set, Blob,
  localStorage,
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
  document: {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, dataset: {}, addEventListener() {}, appendChild() {}, remove() {}, click() {} }),
    addEventListener() {}, body: { appendChild() {} }
  },
  print() {},
  addEventListener() {}
};
const ctx = vm.createContext(sandbox);
vm.runInContext('globalThis.window = globalThis;', ctx);
const run = (file, extra) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8') + (extra || ''), ctx, { filename: file });

run('motion-core.js');
run('web-bridge.js');
run('persistence.js', '\n;globalThis.__Store = Store;');

const H = sandbox.AndroidHost;
const Store = sandbox.__Store;
const MotionCore = sandbox.MotionCore;

/* ---------- 1. 桥接 API 覆盖 ---------- */
console.log('\n[1] AndroidHost API 覆盖');
// v4 的读路径是 snapshot() 单事务快照；v3 是 getDatabaseInfo+getSamples+getRecords+getSettings 四次查询。
// 本自检对两者都兼容，并明确报告当前生效的契约。
const api = {
  snapshot: typeof H.snapshot === 'function',
  recordsPage: typeof H.recordsPage === 'function',
  samplePhoto: typeof H.getSamplePhoto === 'function',
  exportCsv: typeof H.exportCsv === 'function',
  legacyRead: ['getDatabaseInfo', 'getSamples', 'getRecords', 'getSettings'].every(m => typeof H[m] === 'function')
};
console.log('  读路径：' + (api.snapshot ? 'v4 snapshot()（单事务快照）' : api.legacyRead ? 'v3 四次查询' : '均缺失'));
check('提供可用读路径（snapshot 或 v3 四次查询）', api.snapshot || api.legacyRead);
const required = ['commitChanges', 'connect', 'connectLabelPrinter', 'disconnect', 'exportJson', 'getBackup',
  'getExternalDevices', 'importBackup', 'importJson', 'printLabel', 'printUsbLabel', 'send'];
required.forEach(m => check('实现 ' + m + '()', typeof H[m] === 'function'));
if (api.snapshot) {
  check('v4 桥提供 getSamplePhoto()', api.samplePhoto);
  check('v4 桥提供 recordsPage()', api.recordsPage);
  check('v4 桥提供 exportCsv()', api.exportCsv);
}
function snapshot() { return JSON.parse(H.snapshot()); }
function readSamples() { return api.snapshot ? snapshot().s.samples : JSON.parse(H.getSamples()); }
function readRecords() { return api.snapshot ? snapshot().rec : JSON.parse(H.getRecords('')); }
function readRevision() { return Number(api.snapshot ? snapshot().revision : JSON.parse(H.getDatabaseInfo()).revision); }

/* ---------- 2. 首次载入 ---------- */
console.log('\n[2] 首次载入（种子数据 + revision 契约）');
let state = null;
try { state = Store.load(); } catch (e) {
  console.error('\n读路径不可用：Store.load() 失败 —— ' + ((e && e.message) || e));
  console.error('  检测到的读路径：' + (api.snapshot ? 'snapshot()' : api.legacyRead ? 'v3 四次查询' : '均缺失'));
  console.error('  web-preview/web-bridge.js 必须提供 persistence.js 实际调用的桥方法（v4 为 snapshot / recordsPage / getSamplePhoto / exportCsv）。');
  console.error('\n通过 ' + pass + ' 项，失败 ' + (failures.length + 1) + ' 项');
  process.exit(1);
}
check('Store.load() 返回 s/rec/set', !!(state.s && Array.isArray(state.rec) && state.set));
check('示例样本 5 个', Object.keys(state.s.samples).length === 5, '实际 ' + Object.keys(state.s.samples).length);
check('示例记录 5 条', state.rec.length === 5, '实际 ' + state.rec.length);
check('记录带数字 recordId', state.rec.every(r => Number.isFinite(Number(r.recordId))));
check('设置含 hi/lo', state.set.hi === 8 && state.set.lo === -88);
check('revision 为数字', Number.isFinite(readRevision()));

/* ---------- 3. 快照一致性 ---------- */
console.log('\n[3] revision 快照一致性');
const r1 = readRevision();
readSamples(); readRecords();
check('只读操作不改变 revision', readRevision() === r1);

/* ---------- 4. 新增记录 ---------- */
console.log('\n[4] 新增样本 + 记录');
state.s.samples['SB-19999'] = {
  id: 'SB-19999', name: '自检样本', code: 'SB-99999', type: '全血', loc: '圆盘-4', slot: 5,
  status: 'in', temp: 3.3, monitor: false, alert: 'good', createdAt: Date.now(), updatedAt: Date.now()
};
state.rec.unshift({ time: '2026-09-28T10:00', sample: '自检样本', sampleId: 'SB-19999', code: 'SB-99999', slot: 5, status: 'in', type: '入库', detail: '自检写入' });
Store.save(state);
check('新样本已持久化', !!readSamples()['SB-19999']);
const recs = readRecords();
check('新记录已持久化并回填 recordId', recs.length === 6 && Number.isFinite(Number(recs[0].recordId)));
check('记录最新在前', recs[0].detail === '自检写入');
check('revision 递增', readRevision() === r1 + 1);

/* ---------- 5. 幂等保存 ---------- */
console.log('\n[5] 幂等保存');
const revBefore = readRevision();
Store.save(state);
check('无变化保存不增加 revision', readRevision() === revBefore);

/* ---------- 6. revision 冲突保护 ---------- */
console.log('\n[6] 并发冲突保护');
const conflict = JSON.parse(H.commitChanges(JSON.stringify({ expectedRevision: 999, addRecords: [] })));
check('过期 revision 被拒绝', conflict.ok === false && /变化/.test(conflict.error || ''), JSON.stringify(conflict));
check('未知字段被拒绝', JSON.parse(H.commitChanges(JSON.stringify({ bogus: 1 }))).ok === false);

/* ---------- 7. 删除 ---------- */
console.log('\n[7] 删除样本 / 记录');
state.rec = state.rec.filter(r => r.recordId !== recs[0].recordId);
delete state.s.samples['SB-19999'];
Store.save(state);
check('样本已删除', !readSamples()['SB-19999']);
check('记录已删除', readRecords().length === 5);

/* ---------- 8. 备份往返 ---------- */
console.log('\n[8] 备份导出 / 导入往返');
const backup = Store.backup();
check('备份含 app/version/samples/records/settings',
  backup.app === 'vitals-biosample' && Number.isFinite(Number(backup.version != null ? backup.version : backup.schemaVersion)) &&
  !!backup.samples && !!backup.records && !!backup.settings,
  'version=' + (backup.version != null ? backup.version : backup.schemaVersion));
let validBackup = true, validErr = '';
try { MotionCore.validateBackup(JSON.parse(JSON.stringify(backup))); } catch (e) { validBackup = false; validErr = e.message; }
check('导出内容能通过原生同款校验', validBackup,
  validErr ? validErr + '（若为存储圆盘类型错误，请检查 web-preview/web-bridge.js 的种子样本类型是否只含 全血/血清/血浆）' : '');
const beforeReplace = Object.keys(readSamples()).length;
let replaced = null, replaceErr = '';
try {
  if (typeof Store.replace === 'function') replaced = Store.replace(JSON.stringify(backup));
  else if (typeof Store.import === 'function') replaced = Store.import(JSON.stringify(backup), 'replace');
  else throw new Error('Store 未提供导入入口（replace/import）');
} catch (e) { replaceErr = (e && e.message) || String(e); }
check('导入往返成功', !!replaced, replaceErr);
if (replaced) {
  check('导入后样本数一致', Object.keys(replaced.s.samples).length === beforeReplace, '实际 ' + Object.keys(replaced.s.samples).length + '，期望 ' + beforeReplace);
  check('导入后记录数一致', replaced.rec.length === 5, '实际 ' + replaced.rec.length);
  check('导入后 revision 递增', readRevision() > revBefore, 'revision=' + readRevision());
} else {
  check('导入后样本数一致', false, '导入未成功，跳过');
  check('导入后记录数一致', false, '导入未成功，跳过');
  check('导入后 revision 递增', false, '导入未成功，跳过');
}

/* ---------- 9. 设备模拟事件 ---------- */
console.log('\n[9] 设备模拟事件链');
const seen = [];
sandbox.onAndroidEvent = (type, role, text) => seen.push(type + ':' + role + ':' + text);
H.connect('motion', 115200);
await sleep(400);
check('connect 触发 connected 事件', seen.some(e => e.startsWith('connected:motion')));
seen.length = 0;
H.send('motion', 'OUT,A-0');
await sleep(1200);
check('send 触发 sent 事件', seen.some(e => e.startsWith('sent:motion:OUT,A-0')));
check('机械板回传到位 ok', seen.some(e => e === 'line:motion:ok'));
seen.length = 0;
H.send('motion', 'bad\nline');
check('非法命令行被拒绝', seen.some(e => e.startsWith('error:motion')));
seen.length = 0;
H.disconnect('motion');
await sleep(20);
check('disconnect 触发 disconnected 事件', seen.some(e => e.startsWith('disconnected:motion')));
seen.length = 0;
H.send('sensor', 'X');
check('未连接时发送被拒绝', seen.some(e => e === 'error:sensor:设备未连接'));
check('外部设备上报可解析', (() => { const d = JSON.parse(H.getExternalDevices()); return Number.isFinite(d.scanner) && Number.isFinite(d.printer); })());

/* ---------- 10. 损坏数据自愈 ---------- */
console.log('\n[10] 损坏存储自愈');
disk['vitals.preview.db'] = '{坏掉的 JSON';
const healed = Store.load();
check('损坏数据不抛错并回到种子库', Object.keys(healed.s.samples).length === 5);

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + failures.length + ' 项');
if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
