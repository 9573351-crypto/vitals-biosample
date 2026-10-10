#!/usr/bin/env node
/* 两轴导出验收（真实 WebView 驱动）：导出内容（多选）× 文件类型（多选）都真正可选。
   核心不变量：**不会有"勾了却不导出"的组合** —— 每次切换后选择都自洽（交集归一化）。

   检查项：
   1) 打开弹窗；设置页无重复的「数据导出」卡片；
   2) 内容项是复选语义（可多选）、44pt 触控高度、标出支持的格式；
   3) 两个文件类型都可点；选择与内容始终自洽：
      - 只选「完整备份」时 CSV 不可点（完整备份只能 JSON），并给出原因；
      - 改选「样本清单」后 CSV 变为可点（说明置灰是随选择变化的，不是死的）；
   4) 关键组合真的能导出：完整备份→JSON、样本清单→CSV、操作记录→CSV；
   5) 跨维度组合：样本清单 + JSON 导出过滤后的 JSON（含 samples，无 records/settings）；
      偏好设置 + JSON 只导出 settings 段；
   6) 多选内容：完整备份 + 样本清单 同时选中，结果说明列出两者；
   7) JSON + CSV 同时选：每个所选内容各写一个文件，数量与按钮文案一致；
   8) CSV 下照片开关置灰并说明原因；JSON 下可用；
   9) 日期范围只在「操作记录 + CSV」时出现。
   用法：node .local-ci/verify-export-two-axis.mjs [port] */
const port = Number(process.argv[2] || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page') || targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', e => { const m = JSON.parse(e.data); const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.rej(new Error(JSON.stringify(m.error))) : s.res(m.result); });
await new Promise(r => ws.addEventListener('open', r));
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const detail = (d.exception && (d.exception.description || d.exception.value)) || d.text;
    console.error('[eval failed] ' + detail + '\n--- expression ---\n' + String(x).slice(0, 400));
    throw new Error(detail);
  }
  return r.result.value;
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? (pass++, console.log('PASS ' + name)) : (fail++, console.log('FAIL ' + name + (detail ? ' — ' + detail : ''))); };
const wait = ms => new Promise(r => setTimeout(r, ms));

const snapshot = () => ev(`(() => ({
  scopes: [...document.querySelectorAll('#exportScope .export-scope-item')].map(b => ({
    id: b.dataset.scope, role: b.getAttribute('role'), checked: b.getAttribute('aria-checked'),
    disabled: b.disabled, h: Math.round(b.getBoundingClientRect().height),
    formats: b.querySelector('.esi-format') ? b.querySelector('.esi-format').textContent : '',
    title: b.title
  })),
  formats: [...document.querySelectorAll('#exportFormat .seg-btn')].map(b => ({
    id: b.dataset.format, checked: b.getAttribute('aria-checked'), disabled: b.disabled, title: b.title
  })),
  formatNote: document.getElementById('exportFormatNote').textContent,
  photosHidden: document.getElementById('exportPhotosRow').hidden,
  photosDisabled: document.getElementById('exportPhotos').disabled,
  rangeHidden: document.getElementById('exportRange').hidden,
  outcome: document.getElementById('exportOutcome').textContent,
  confirmDisabled: document.getElementById('exportConfirm').disabled,
  confirmLabel: document.getElementById('exportConfirm').textContent
}))()`);

/* 打开弹窗并把两个维度设成指定状态。两个维度的可用性是互相影响的
   （切格式会让某些内容项失效），所以用多遍收敛：每遍把"当前可点且不符合目标"的项点掉，
   直到状态稳定或达到上限。弹窗刻意保留上次选择，因此每段都必须显式设定。 */
async function openWith(formats, scopes){
  await ev(`document.getElementById('exportBtn').click()`);
  await wait(400);
  const wantF = JSON.stringify(formats), wantS = JSON.stringify(scopes);
  for (let round = 0; round < 6; round++) {
    const changed = await ev(`(() => {
      const wantF = ${wantF}, wantS = ${wantS};
      let n = 0;
      document.querySelectorAll('#exportFormat .seg-btn').forEach(b => {
        const on = b.getAttribute('aria-checked') === 'true';
        if (!b.disabled && wantF.includes(b.dataset.format) !== on) { b.click(); n++; }
      });
      document.querySelectorAll('#exportScope .export-scope-item').forEach(b => {
        const on = b.getAttribute('aria-checked') === 'true';
        if (!b.disabled && wantS.includes(b.dataset.scope) !== on) { b.click(); n++; }
      });
      return n;
    })()`);
    await wait(300);
    if (!changed) break;
  }
  return snapshot();
}

// 落盘钩子：saveTextFile 是函数声明且不可配置，无法从外部替换，
// 因此应用预留了 window.__vitalsFileSink（仅测试使用）用于观察实际写出的文件。
await ev(`(() => {
  window.__exportLog = [];
  window.__vitalsFileSink = function(name, content, mime, msg){
    const text = String(content||'');
    window.__exportLog.push({
      name: name, mime: mime, len: text.length, msg: msg,
      head: text.slice(0, 50),
      isBom: text.charCodeAt(0) === 0xFEFF,
      hasSamples: /内部ID,/.test(text) || /"samples":\\s*\\{\\s*"/.test(text),
      hasRecords: /时间,样本,编号/.test(text) || /"records":\\s*\\[\\s*\\{/.test(text),
      hasSettings: /"settings":\\s*\\{\\s*[^}\\s]/.test(text),
      isPartial: /"partial":\\s*true/.test(text),
      scope: (/"scope":\\s*"([^"]+)"/.exec(text) || [])[1] || '',
      hasChecksum: /checksum/.test(text)
    });
    if (typeof toast === 'function') toast(msg || '已导出');
  };
  return true;
})()`);

check('设置页无重复的「数据导出」卡片', await ev(`!document.getElementById('exportCard')`) === true);

/* ---- 1. 默认态与基础可用性 ---- */
const open = await openWith(['json'], ['backup']);
console.log('默认态: ' + JSON.stringify({ scopes: open.scopes.map(s => s.id + ':' + s.checked), formats: open.formats.map(f => f.id + ':' + f.checked) }));
check('点「导出」打开弹窗', await ev(`document.getElementById('exportModal').classList.contains('open')`) === true);
check('导出内容是复选语义（可多选）', open.scopes.every(s => s.role === 'checkbox'), open.scopes.map(s => s.role).join(','));
check('内容项触控高度 ≥44px', open.scopes.every(s => s.h >= 44), open.scopes.map(s => s.h).join(','));
check('每个内容项标出支持的格式', open.scopes.every(s => /JSON|CSV/.test(s.formats)), open.scopes.map(s => s.id + ':' + s.formats).join(' '));
check('默认选中完整备份 + JSON', open.scopes.find(s => s.id === 'backup').checked === 'true' && open.formats.find(f => f.id === 'json').checked === 'true');

/* ---- 2. 自洽性：选择随内容变化，而不是写死 ---- */
const backupOnly = await openWith(['json'], ['backup']);
const csvBtn = backupOnly.formats.find(f => f.id === 'csv');
console.log('只选完整备份: ' + JSON.stringify({ csv: csvBtn, settings: backupOnly.scopes.find(s => s.id === 'settings').disabled }));
check('只选「完整备份」时 CSV 不可点（完整备份只能 JSON）', csvBtn.disabled === true, JSON.stringify(csvBtn));
check('CSV 置灰给出了具体原因', /只能导出为 JSON/.test(csvBtn.title || ''), csvBtn.title);

const samplesOnly = await openWith(['json'], ['samples']);
const csvBtn2 = samplesOnly.formats.find(f => f.id === 'csv');
console.log('只选样本清单: ' + JSON.stringify({ csv: csvBtn2 }));
check('改选「样本清单」后 CSV 变为可点（置灰随选择变化）', csvBtn2.disabled === false, JSON.stringify(csvBtn2));

/* ---- 3. CSV 专属约束 ---- */
const csvOnly = await openWith(['csv'], ['samples']);
console.log('纯 CSV 态: ' + JSON.stringify({ photosDisabled: csvOnly.photosDisabled, settings: csvOnly.scopes.find(s => s.id === 'settings').disabled, outcome: csvOnly.outcome }));
check('纯 CSV 下照片开关置灰并说明原因', csvOnly.photosDisabled === true && /CSV/.test(csvOnly.formatNote + csvOnly.outcome), JSON.stringify({ d: csvOnly.photosDisabled }));
check('纯 CSV 下「偏好设置」不可选（配置非表格数据）', csvOnly.scopes.find(s => s.id === 'settings').disabled === true);

/* ---- 4. 多选内容 ---- */
const multi = await openWith(['json'], ['backup', 'samples']);
console.log('多选态: ' + JSON.stringify({ checked: multi.scopes.filter(s => s.checked === 'true').map(s => s.id), outcome: multi.outcome }));
check('内容可同时勾选多项', multi.scopes.filter(s => s.checked === 'true').length === 2, multi.scopes.filter(s => s.checked === 'true').map(s => s.id).join(','));
check('多选时结果说明列出全部所选内容', /完整备份/.test(multi.outcome) && /样本清单/.test(multi.outcome), multi.outcome);

/* ---- 5. 跨维度组合：真的导出过滤后的 JSON ---- */
await openWith(['json'], ['samples']);
await ev(`window.__exportLog.length = 0; document.getElementById('exportConfirm').click()`);
await wait(900);
const cross = await ev(`window.__exportLog.slice()`);
console.log('样本清单 + JSON: ' + JSON.stringify(cross.map(x => ({ n: x.name, s: x.hasSamples, r: x.hasRecords, set: x.hasSettings }))));
check('样本清单 + JSON 导出过滤后的 JSON（含 samples，无 records/settings）',
  cross.length === 1 && /\.json$/.test(cross[0].name) && cross[0].hasSamples === true && cross[0].hasRecords === false && cross[0].hasSettings === false,
  JSON.stringify(cross.map(x => ({ n: x.name, s: x.hasSamples, r: x.hasRecords, set: x.hasSettings }))));

await openWith(['json'], ['settings']);
await ev(`window.__exportLog.length = 0; document.getElementById('exportConfirm').click()`);
await wait(900);
const setRun = await ev(`window.__exportLog.slice()`);
console.log('偏好设置 + JSON: ' + JSON.stringify(setRun.map(x => ({ n: x.name, set: x.hasSettings, s: x.hasSamples, partial: x.isPartial, scope: x.scope }))));
check('偏好设置 + JSON 导出的是真实设置（非空 settings 段）', setRun.length === 1 && setRun[0].hasSettings === true && setRun[0].hasSamples === false, JSON.stringify(setRun.map(x => ({ n: x.name, set: x.hasSettings }))));
check('部分导出显式标记 partial + scope（不会被误当成完整备份导入）',
  setRun[0].isPartial === true && /settings/.test(setRun[0].scope), JSON.stringify({ p: setRun[0].isPartial, s: setRun[0].scope }));

/* ---- 6. 操作记录 + CSV：日期范围出现且真的导出 ---- */
const recCsv = await openWith(['csv'], ['records']);
console.log('记录+CSV: ' + JSON.stringify({ checked: recCsv.scopes.filter(s => s.checked === 'true').map(s => s.id), rangeHidden: recCsv.rangeHidden, outcome: recCsv.outcome }));
check('「操作记录 + CSV」显示日期范围', recCsv.rangeHidden === false);
await ev(`window.__exportLog.length = 0; document.getElementById('exportConfirm').click()`);
await wait(900);
const recRun = await ev(`window.__exportLog.slice()`);
console.log('记录 CSV: ' + JSON.stringify(recRun.map(x => ({ n: x.name, bom: x.isBom, head: x.head.slice(0, 14) }))));
check('操作记录导出 CSV 且带 BOM', recRun.length === 1 && /\.csv$/.test(recRun[0].name) && recRun[0].isBom === true, JSON.stringify(recRun));
check('「操作记录 + CSV」不显示日期范围以外的内容项错乱', recRun[0].hasRecords === true, JSON.stringify(recRun[0]));

/* ---- 7. JSON + CSV 同时选：所选项各写一个文件 ---- */
const both = await openWith(['json', 'csv'], ['samples']);
console.log('双格式态: ' + JSON.stringify({ formats: both.formats.map(f => f.id + ':' + f.checked), confirm: both.confirmLabel, outcome: both.outcome }));
check('两个格式可同时选中', both.formats.filter(f => f.checked === 'true').length === 2, both.formats.map(f => f.id + ':' + f.checked).join(' '));
check('按钮文案写明会写几个文件', /2 个文件/.test(both.confirmLabel), both.confirmLabel);
await ev(`window.__exportLog.length = 0; document.getElementById('exportConfirm').click()`);
await wait(1400);
const bothRun = await ev(`window.__exportLog.slice()`);
console.log('双格式导出: ' + JSON.stringify(bothRun.map(x => x.name)));
check('JSON + CSV 同时选时各写一个文件（无静默丢项）',
  bothRun.filter(x => /\.json$/.test(x.name)).length === 1 && bothRun.filter(x => /\.csv$/.test(x.name)).length === 1,
  JSON.stringify(bothRun.map(x => x.name)));

/* ---- 8. 多内容 + 双格式：文件数 == 内容数 × 格式数 ---- */
const grid = await openWith(['json', 'csv'], ['samples', 'records']);
console.log('多内容双格式: ' + JSON.stringify({ confirm: grid.confirmLabel, outcome: grid.outcome }));
check('多内容 × 双格式时按钮文案给出正确文件数', /4 个文件/.test(grid.confirmLabel), grid.confirmLabel);
await ev(`window.__exportLog.length = 0; document.getElementById('exportConfirm').click()`);
await wait(1600);
const gridRun = await ev(`window.__exportLog.slice()`);
console.log('网格导出: ' + JSON.stringify(gridRun.map(x => x.name)));
check('实际写出的文件数等于 内容数 × 格式数', gridRun.length === 4, JSON.stringify(gridRun.map(x => x.name)));

await ev(`delete window.__vitalsFileSink`);
console.log(`\nTOTAL ${pass} passed, ${fail} failed`);
ws.close();
if (fail) process.exit(1);
