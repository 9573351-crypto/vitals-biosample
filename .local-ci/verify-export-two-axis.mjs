#!/usr/bin/env node
/* 导出弹窗验收（真实 WebView 驱动）：
   - 导出内容：多选（checkbox）
   - 文件类型：**单选**（radio）—— 选中 CSV 后 JSON 必须取消选中，反之亦然
   核心不变量：不会有"勾了却不导出"的组合；所选内容 × 1 种格式 = 写出的文件数。

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
    label: (b.querySelector('.esi-text b') ? String(b.querySelector('.esi-text b').childNodes[0].textContent).trim() : ''),
    formats: b.querySelector('.esi-format') ? b.querySelector('.esi-format').textContent : '',
    count: (b.querySelector('.esi-count')||{}).textContent || '',
    title: b.title
  })),
  formats: [...document.querySelectorAll('#exportFormat .seg-btn')].map(b => ({
    id: b.dataset.format, role: b.getAttribute('role'), checked: b.getAttribute('aria-checked'),
    disabled: b.disabled, title: b.title
  })),
  formatNote: document.getElementById('exportFormatNote').textContent,
  photosHidden: document.getElementById('exportPhotosRow').hidden,
  photosDisabled: document.getElementById('exportPhotos').disabled,
  rangeHidden: document.getElementById('exportRange').hidden,
  outcome: document.getElementById('exportOutcome').textContent,
  confirmDisabled: document.getElementById('exportConfirm').disabled,
  confirmLabel: document.getElementById('exportConfirm').textContent
}))()`);

/* 打开弹窗并设定状态：内容多选（可多点几次收敛）+ 格式单选。 */
async function openWith(format, scopes){
  await ev(`document.getElementById('exportBtn').click()`);
  await wait(400);
  const wantS = JSON.stringify(scopes);
  for (let round = 0; round < 6; round++) {
    const changed = await ev(`(() => {
      const wantS = ${wantS};
      let n = 0;
      document.querySelectorAll('#exportScope .export-scope-item').forEach(b => {
        const on = b.getAttribute('aria-checked') === 'true';
        if (!b.disabled && wantS.includes(b.dataset.scope) !== on) { b.click(); n++; }
      });
      const f = document.querySelector('#exportFormat .seg-btn[data-format="${format}"]');
      if (f && !f.disabled && f.getAttribute('aria-checked') !== 'true') { f.click(); n++; }
      return n;
    })()`);
    await wait(300);
    if (!changed) break;
  }
  return snapshot();
}

// 落盘钩子：saveTextFile 是函数声明且不可配置，应用预留了 window.__vitalsFileSink（仅测试用）。
await ev(`(() => {
  window.__exportLog = [];
  window.__vitalsFileSink = function(name, content, mime, msg){
    const text = String(content||'');
    window.__exportLog.push({
      name: name, mime: mime, len: text.length, msg: msg,
      head: text.slice(0, 60),
      isBom: text.charCodeAt(0) === 0xFEFF,
      hasSamples: /内部ID,/.test(text) || /"samples":\\s*\\{\\s*"/.test(text),
      hasRecords: /时间,样本,编号/.test(text) || /"records":\\s*\\[\\s*\\{/.test(text),
      hasSettings: /"settings":\\s*\\{\\s*"hi"/.test(text),
      isPartial: /"partial":\\s*true/.test(text),
      scope: (/"scope":\\s*"([^"]+)"/.exec(text) || [])[1] || '',
      hasChecksum: /checksum/.test(text)
    });
    if (typeof toast === 'function') toast(msg || '已导出');
  };
  return true;
})()`);

check('设置页无重复的「数据导出」卡片', await ev(`!document.getElementById('exportCard')`) === true);

/* ---- 1. 默认态 ---- */
const open = await openWith('json', ['backup']);
console.log('默认态: ' + JSON.stringify({ scopes: open.scopes.map(s => s.id + ':' + s.checked), formats: open.formats.map(f => f.id + ':' + f.checked) }));
check('点「导出」打开弹窗', await ev(`document.getElementById('exportModal').classList.contains('open')`) === true);
check('导出内容是复选语义（可多选）', open.scopes.every(s => s.role === 'checkbox'), open.scopes.map(s => s.role).join(','));
check('文件类型是单选语义（radio）', open.formats.every(f => f.role === 'radio'), open.formats.map(f => f.role).join(','));
check('内容项触控高度 ≥44px', open.scopes.every(s => s.h >= 44), open.scopes.map(s => s.h).join(','));
check('导出内容含「阈值设置」', open.scopes.some(s => s.label === '阈值设置'), open.scopes.map(s => s.label).join(','));

/* ---- 2. 单选：选中 CSV 后 JSON 必须取消选中（用户反馈的核心） ---- */
const csvSel = await openWith('csv', ['samples']);
const checkedF = csvSel.formats.filter(f => f.checked === 'true').map(f => f.id);
console.log('选 CSV 后: ' + JSON.stringify({ formats: csvSel.formats.map(f => f.id + ':' + f.checked), outcome: csvSel.outcome }));
check('选 CSV 后 CSV 选中、JSON 取消选中（格式单选）', checkedF.length === 1 && checkedF[0] === 'csv', checkedF.join(','));
check('格式说明只描述当前格式', /UTF-8/.test(csvSel.formatNote) && !/schema/.test(csvSel.formatNote), csvSel.formatNote);
check('纯 CSV 下照片开关置灰并说明原因', csvSel.photosDisabled === true, JSON.stringify({ d: csvSel.photosDisabled }));

/* ---- 3. 单选：切回 JSON 时 CSV 取消选中；阈值设置在 CSV 下置灰 ---- */
const csvState = await openWith('csv', ['samples']);
check('纯 CSV 下「阈值设置」不可选（配置非表格数据）', csvState.scopes.find(s => s.id === 'settings').disabled === true &&
  /表格数据/.test(csvState.scopes.find(s => s.id === 'settings').title || ''), csvState.scopes.find(s => s.id === 'settings').title);

const jsonSel = await openWith('json', ['samples']);
const checkedJ = jsonSel.formats.filter(f => f.checked === 'true').map(f => f.id);
console.log('切回 JSON: ' + JSON.stringify({ formats: jsonSel.formats.map(f => f.id + ':' + f.checked) }));
check('切回 JSON 后 CSV 取消选中（格式单选）', checkedJ.length === 1 && checkedJ[0] === 'json', checkedJ.join(','));
check('JSON 下「阈值设置」可选', jsonSel.scopes.find(s => s.id === 'settings').disabled === false);
check('JSON 下照片开关可用', jsonSel.photosDisabled === false);

/* ---- 4. 只选「完整备份」时 CSV 不可点（能力约束，且给出原因） ---- */
const backupOnly = await openWith('json', ['backup']);
const csvBtn = backupOnly.formats.find(f => f.id === 'csv');
console.log('只选完整备份: ' + JSON.stringify({ csv: csvBtn }));
check('只选「完整备份」时 CSV 不可点', csvBtn.disabled === true, JSON.stringify(csvBtn));
check('CSV 置灰给出具体原因', /只能导出为 JSON/.test(csvBtn.title || ''), csvBtn.title);
check('改选「样本清单」后 CSV 变为可点（置灰随选择变化）',
  (await openWith('json', ['samples'])).formats.find(f => f.id === 'csv').disabled === false);

/* ---- 5. 关键场景：只导出 CSV（此前做不到） ---- */
await openWith('csv', ['samples']);
await ev(`window.__exportLog.length = 0; document.getElementById('exportConfirm').click()`);
await wait(900);
const csvRun = await ev(`window.__exportLog.slice()`);
console.log('只导出 CSV: ' + JSON.stringify(csvRun.map(x => ({ n: x.name, bom: x.isBom, head: x.head.slice(0, 14) }))));
check('只导出 CSV 时写出的是 .csv 且带 BOM（无 JSON 混入）',
  csvRun.length === 1 && /\.csv$/.test(csvRun[0].name) && csvRun[0].isBom === true, JSON.stringify(csvRun.map(x => x.name)));

/* ---- 6. 多选内容 + 单一格式：每项一个文件 ---- */
const multi = await openWith('csv', ['samples', 'records']);
console.log('多选内容 CSV: ' + JSON.stringify({ confirm: multi.confirmLabel, outcome: multi.outcome }));
check('多选内容时按钮写明文件数', /2 个文件/.test(multi.confirmLabel), multi.confirmLabel);
await ev(`window.__exportLog.length = 0; document.getElementById('exportConfirm').click()`);
await wait(1400);
const multiRun = await ev(`window.__exportLog.slice()`);
console.log('多选内容导出: ' + JSON.stringify(multiRun.map(x => x.name)));
check('多选内容 + CSV 时每项写一个 CSV', multiRun.length === 2 && multiRun.every(x => /\.csv$/.test(x.name)), JSON.stringify(multiRun.map(x => x.name)));

/* ---- 7. 阈值设置 + JSON：只导出 hi/lo，且标记 partial ---- */
await openWith('json', ['settings']);
const thState = await snapshot();
console.log('阈值设置: ' + JSON.stringify({ count: thState.scopes.find(s => s.id === 'settings').count, outcome: thState.outcome }));
check('阈值设置显示阈值条数（2 条）', /^2 条/.test(thState.scopes.find(s => s.id === 'settings').count.trim()), thState.scopes.find(s => s.id === 'settings').count);
await ev(`window.__exportLog.length = 0; document.getElementById('exportConfirm').click()`);
await wait(900);
const thRun = await ev(`window.__exportLog.slice()`);
console.log('阈值导出: ' + JSON.stringify(thRun.map(x => ({ n: x.name, set: x.hasSettings, s: x.hasSamples, partial: x.isPartial, scope: x.scope }))));
check('阈值设置导出含 hi/lo 的 settings 段（不含样本）', thRun.length === 1 && thRun[0].hasSettings === true && thRun[0].hasSamples === false, JSON.stringify(thRun.map(x => ({ n: x.name, set: x.hasSettings }))));
check('部分导出显式标记 partial + scope', thRun[0].isPartial === true && /settings/.test(thRun[0].scope), JSON.stringify({ p: thRun[0].isPartial, s: thRun[0].scope }));

/* ---- 8. 完整备份 + JSON：仍是可导入的整份（有 checksum） ---- */
await openWith('json', ['backup']);
await ev(`window.__exportLog.length = 0; document.getElementById('exportConfirm').click()`);
await wait(1200);
const backupRun = await ev(`window.__exportLog.slice()`);
console.log('完整备份: ' + JSON.stringify(backupRun.map(x => ({ n: x.name, checksum: x.hasChecksum, partial: x.isPartial }))));
check('完整备份仍带 checksum 且不标 partial（可导入恢复）',
  backupRun.length === 1 && /\.json$/.test(backupRun[0].name) && backupRun[0].hasChecksum === true && backupRun[0].isPartial === false,
  JSON.stringify(backupRun.map(x => ({ n: x.name, c: x.hasChecksum, p: x.isPartial }))));

/* ---- 9. 操作记录 + CSV：日期范围出现 ---- */
const recCsv = await openWith('csv', ['records']);
check('「操作记录 + CSV」显示日期范围', recCsv.rangeHidden === false);

await ev(`delete window.__vitalsFileSink`);
console.log(`\nTOTAL ${pass} passed, ${fail} failed`);
ws.close();
if (fail) process.exit(1);
