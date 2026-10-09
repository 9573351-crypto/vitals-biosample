#!/usr/bin/env node
/* 预览桥（web-bridge.js）校验和交叉验证：
   用浏览器桥的同步 SHA-256 + 规范化算法，重算 .local-ci/fixtures/good.json 的 checksum，
   与原生 BackupFormat 产出的基准值比对。两边一致即证明「浏览器预览」与「Android 原生」的
   备份校验和算法完全对齐（这是导入校验能互通的前提）。
   运行：node vitals-android/tools/bridge-checksum.test.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, '..', '..', 'web-preview', 'web-bridge.js');
const fixturePath = join(here, '..', '..', '.local-ci', 'fixtures', 'good.json');
const mergePath = join(here, '..', '..', '.local-ci', 'fixtures', 'merge.json');
const conflictPath = join(here, '..', '..', '.local-ci', 'fixtures', 'conflict-code.json');

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// 最小浏览器桩：web-bridge.js 需要 localStorage / window / document
const store = new Map();
const sandbox = {
  console,
  JSON, Math, Number, String, Object, Array, RegExp, Error, Date, Promise, Set, Map, parseInt, parseFloat, isNaN,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); return true; }
  },
  setTimeout: (fn) => { try { fn(); } catch (_) { } return 0; },
  clearTimeout: () => { },
  addEventListener: () => { },
  document: { getElementById: () => null, querySelector: () => null, createElement: () => ({ style: {}, classList: { add() { }, remove() { }, toggle() { } }, appendChild() { }, remove() { }, click() { } }), body: { appendChild() { } } },
  crypto: {}
};
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(bridgePath, 'utf8'), sandbox, { filename: 'web-bridge.js' });
// 预览桥的导入校验依赖 MotionCore.validateBackup，按真实加载顺序注入
vm.runInContext(readFileSync(join(here, '..', '..', 'web-preview', 'motion-core.js'), 'utf8'), sandbox, { filename: 'motion-core.js' });

ok('桥已挂载到 window', typeof sandbox.AndroidHost === 'object' && sandbox.AndroidHost !== null);
ok('校验模块 MotionCore 已加载', typeof sandbox.MotionCore === 'object' && typeof sandbox.MotionCore.validateBackup === 'function');
const host = sandbox.AndroidHost;

// 用夹具内容灌入预览库：必须写入 localStorage，否则桥会认为库为空并重新播种
const good = JSON.parse(readFileSync(fixturePath, 'utf8'));
function seedDb(samples, records, settings) {
  const db = { revision: 1, samples, records, settings, nextRecordId: 100 };
  store.set('vitals.preview.db', JSON.stringify(db));
  return db;
}
seedDb(good.samples, good.records, good.settings);

const exported = JSON.parse(host.exportBackup(true));
ok('预览桥导出为 v4 自描述备份', exported.schemaVersion === 4 && exported.app === 'vitals-biosample', JSON.stringify({ schemaVersion: exported.schemaVersion, app: exported.app }));
ok('预览桥导出与原生夹具 checksum 一致（跨端算法对齐）', exported.checksum === good.checksum, exported.checksum + ' vs ' + good.checksum);
ok('预览桥导出包含 counts', exported.counts && typeof exported.counts.samples === 'number' && typeof exported.counts.records === 'number', JSON.stringify(exported.counts));
ok('预览桥导出的记录数与夹具一致', (exported.records || []).length === good.records.length, String((exported.records || []).length));

// 篡改检测：改一个样本名后 checksum 必须变化
const tampered = JSON.parse(JSON.stringify(good));
tampered.samples[Object.keys(tampered.samples)[0]].name = 'tampered-name';
seedDb(tampered.samples, tampered.records, tampered.settings);
const reExported = JSON.parse(host.exportBackup(true));
ok('内容变化后 checksum 随之变化', reExported.checksum !== good.checksum, reExported.checksum);

// merge 夹具：导入校验应通过（counts 与 checksum 自洽）
const merge = JSON.parse(readFileSync(mergePath, 'utf8'));
seedDb(good.samples, good.records, good.settings);
const preview = JSON.parse(host.importBackupEx(JSON.stringify(merge), 'preview', ''));
ok('预览导入返回 dryRun 差异', preview.ok === true && preview.dryRun === true, JSON.stringify(preview));
ok('预览差异包含新增样本与重复记录计数', preview.diff && typeof preview.diff.newSamples === 'number' && typeof preview.diff.duplicateRecords === 'number', JSON.stringify(preview.diff));

// 条码冲突的备份必须被拒（校验阶段即拒绝）
const conflictFixture = JSON.parse(readFileSync(conflictPath, 'utf8'));
seedDb(good.samples, good.records, good.settings);
const conflictResult = JSON.parse(host.importBackupEx(JSON.stringify(conflictFixture), 'merge', ''));
ok('复用已有条码的备份被拒绝', conflictResult.ok === false && /条码/.test(String(conflictResult.error)), JSON.stringify(conflictResult));

// 篡改的备份必须被拒（checksum 校验）
const rejected = JSON.parse(host.importBackupEx(JSON.stringify(tampered), 'merge', ''));
ok('checksum 被篡改的备份被拒绝', rejected.ok === false && String(rejected.error).includes('校验和'), JSON.stringify(rejected));

console.log('\nTOTAL ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) process.exit(1);
