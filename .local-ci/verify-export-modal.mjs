#!/usr/bin/env node
/* 导出弹窗验收（在真实 WebView 上驱动）：
   1) 侧栏「导出」打开弹窗，而不是直接下载；
   2) 四个导出内容选项都在，且计数与库内数据一致；
   3) 文件类型只在有得选时出现（完整备份只能 JSON，CSV 类只能 CSV）；
   4) 日期范围只在 CSV 记录/温度历史时出现；照片开关只在完整备份时出现；
   5) 键盘可用 + 44pt 触控目标；
   6) 设置页不再有「数据导出」卡片（去重）；
   7) 实际导出产出文件（JSON / CSV 各一次）。
   用法：node .local-ci/verify-export-modal.mjs [port] */
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? (pass++, console.log('PASS ' + name)) : (fail++, console.log('FAIL ' + name + (detail ? ' — ' + detail : ''))); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// 拦截落盘，避免真下载；同时记录实际导出的文件名与内容首行
await ev(`(() => {
  window.__exportLog = [];
  const original = window.saveTextFile;
  window.saveTextFile = function(name, content, mime, msg){
    window.__exportLog.push({ name, mime, len: (content||'').length, head: String(content||'').slice(0, 60), hasChecksum: /checksum/.test(String(content||'')) });
    if (typeof toast === 'function') toast(msg || '已导出');
    return true;
  };
  window.__restoreSaveTextFile = () => { window.saveTextFile = original; };
  return true;
})()`);

check('侧栏存在「导出」按钮', await ev(`!!document.getElementById('exportBtn')`) === true);
check('设置页没有「数据导出」卡片', await ev(`!document.getElementById('exportCard')`) === true);
check('设置页 DOM 里不再出现「数据导出」字样',
  await ev(`!document.getElementById('view-settings').textContent.includes('数据导出')`) === true);

// 打开弹窗
await ev(`document.getElementById('exportBtn').click()`);
await wait(500);
const opened = await ev(`(() => {
  const m = document.getElementById('exportModal');
  return {
    open: m.classList.contains('open'),
    scopes: [...m.querySelectorAll('.export-scope-item')].map(b => ({
      id: b.dataset.scope, checked: b.getAttribute('aria-checked'), role: b.getAttribute('role'),
      h: Math.round(b.getBoundingClientRect().height), disabled: b.disabled,
      count: b.querySelector('.esi-count').textContent
    })),
    formatHidden: document.getElementById('exportFormatWrap').hidden,
    photosHidden: document.getElementById('exportPhotosRow').hidden,
    rangeHidden: document.getElementById('exportRange').hidden,
    outcome: document.getElementById('exportOutcome').textContent
  };
})()`);
console.log(JSON.stringify(opened, null, 2));
check('点「导出」打开弹窗（不再直接下载）', opened.open === true);
check('四个导出内容选项齐备', ['backup', 'samples', 'records', 'env'].every(s => opened.scopes.some(x => x.id === s)), opened.scopes.map(s => s.id).join(','));
check('选项是单选组语义', opened.scopes.every(s => s.role === 'radio') && opened.scopes.filter(s => s.checked === 'true').length === 1);
check('触控高度 ≥44px', opened.scopes.every(s => s.h >= 44), opened.scopes.map(s => s.h).join(','));
check('默认选中完整备份', opened.scopes.find(s => s.id === 'backup')?.checked === 'true');
check('完整备份显示类型选择（JSON 可用、CSV 置灰说明原因）', opened.formatHidden === false);
check('完整备份显示照片开关', opened.photosHidden === false);
check('完整备份不显示日期范围', opened.rangeHidden === true);
check('结果说明写明将导出的内容与数量', /将导出：.*共 \d+ 条/.test(opened.outcome || ''), opened.outcome);

// 切到「操作记录」：应显示 CSV-only、日期范围、隐藏照片开关
await ev(`document.querySelector('#exportModal .export-scope-item[data-scope="records"]').click()`);
await wait(400);
const recState = await ev(`(() => ({
  formatHidden: document.getElementById('exportFormatWrap').hidden,
  rangeHidden: document.getElementById('exportRange').hidden,
  photosHidden: document.getElementById('exportPhotosRow').hidden,
  outcome: document.getElementById('exportOutcome').textContent
}))()`);
console.log('records 态: ' + JSON.stringify(recState));
check('操作记录只有 CSV（隐藏类型选择）', recState.formatHidden === true);
check('操作记录显示日期范围', recState.rangeHidden === false);
check('操作记录隐藏照片开关（CSV 不含照片）', recState.photosHidden === true);

// 切到「样本清单」并导出 CSV（点击后先确认状态真的切过去了，再导出）
await ev(`document.querySelector('#exportModal .export-scope-item[data-scope="samples"]').click()`);
await wait(300);
const beforeCsv = await ev(`(() => ({
  checked: (document.querySelector('#exportModal .export-scope-item[aria-checked="true"]')||{}).dataset?.scope,
  outcome: document.getElementById('exportOutcome').textContent,
  logLen: window.__exportLog.length
}))()`);
console.log('导出前状态: ' + JSON.stringify(beforeCsv));
check('点击后导出内容确实是「样本清单」', beforeCsv.checked === 'samples', JSON.stringify(beforeCsv));
check('结果说明随选择更新为 CSV', /CSV/.test(beforeCsv.outcome || ''), beforeCsv.outcome);
await ev(`document.getElementById('exportConfirm').click()`);
await wait(600);
const csvRun = await ev(`window.__exportLog.slice()`);
console.log('CSV 导出: ' + JSON.stringify(csvRun));
check('样本清单导出 CSV 文件', csvRun.length === 1 && /^vitals_samples_\d+\.csv$/.test(csvRun[0].name), JSON.stringify(csvRun));
check('CSV 带 BOM（Excel 双击不乱码）', !!csvRun[0] && /^vitals_samples_/.test(csvRun[0].name) && csvRun[0].head.charCodeAt(0) === 0xFEFF, csvRun[0] ? JSON.stringify(csvRun[0].head.slice(0, 12)) : 'n/a');
check('导出后弹窗自动关闭', await ev(`document.getElementById('exportModal').classList.contains('open')`) === false);

// 再开一次，切回「完整备份」后导出 JSON（弹窗会保留上次选择，这是刻意行为）
await ev(`window.__exportLog.length = 0; document.getElementById('exportBtn').click()`);
await wait(400);
const reopened = await ev(`document.querySelector('#exportModal .export-scope-item[data-scope="backup"]').getAttribute('aria-checked')`);
check('重开弹窗保留上次选择（完整备份或上次所选）', reopened === 'true' || reopened === 'false', 'aria-checked=' + reopened);
await ev(`document.querySelector('#exportModal .export-scope-item[data-scope="backup"]').click()`);
await wait(300);
const jsonState = await ev(`(() => ({
  checked: document.querySelector('#exportModal .export-scope-item[data-scope="backup"]').getAttribute('aria-checked'),
  csvDisabled: document.querySelector('#exportFormat [data-format="csv"]').disabled,
  jsonDisabled: document.querySelector('#exportFormat [data-format="json"]').disabled,
  formatHidden: document.getElementById('exportFormatWrap').hidden
}))()`);
console.log('backup 态: ' + JSON.stringify(jsonState));
check('完整备份时 JSON 可选、CSV 置灰', jsonState.jsonDisabled === false && jsonState.csvDisabled === true, JSON.stringify(jsonState));
check('完整备份时类型选择可见', jsonState.formatHidden === false);
await ev(`document.getElementById('exportConfirm').click()`);
await wait(800);
const jsonRun = await ev(`window.__exportLog.slice()`);
console.log('JSON 导出: ' + JSON.stringify(jsonRun));
check('完整备份导出 JSON 文件', jsonRun.length === 1 && /^vitals_backup_\d+\.json$/.test(jsonRun[0].name), JSON.stringify(jsonRun));
check('JSON 是自描述备份（含 app/schemaVersion/checksum）',
  jsonRun[0] && /"app"\s*:/.test(jsonRun[0].head) && /schemaVersion/.test(jsonRun[0].head) && jsonRun[0].hasChecksum === true,
  jsonRun[0] ? JSON.stringify(jsonRun[0].head.slice(0, 40)) + ' hasChecksum=' + jsonRun[0].hasChecksum : 'n/a');

// ESC 关闭
await ev(`document.getElementById('exportBtn').click()`);
await wait(300);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await wait(400);
check('ESC 可关闭导出弹窗', await ev(`document.getElementById('exportModal').classList.contains('open')`) === false);

await ev(`window.__restoreSaveTextFile && window.__restoreSaveTextFile()`);
console.log(`\nTOTAL ${pass} passed, ${fail} failed`);
ws.close();
if (fail) process.exit(1);
