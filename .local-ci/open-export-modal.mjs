#!/usr/bin/env node
/* 打开导出弹窗（供人工/截图检查用）。用法：node .local-ci/open-export-modal.mjs [port] */
const port = Number(process.argv[2] || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page') || targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', e => { const m = JSON.parse(e.data); const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.rej(new Error(JSON.stringify(m.error))) : s.res(m.result); });
await new Promise(r => ws.addEventListener('open', r));
const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result.value;
const scope = process.argv[3] || 'backup';
await ev(`document.getElementById('exportBtn').click()`);
await new Promise(r => setTimeout(r, 500));
if (scope !== 'backup') {
  await ev(`document.querySelector('#exportModal .export-scope-item[data-scope="${scope}"]').click()`);
  await new Promise(r => setTimeout(r, 400));
}
console.log(await ev(`JSON.stringify({
  open: document.getElementById('exportModal').classList.contains('open'),
  scope: (document.querySelector('#exportModal .export-scope-item[aria-checked="true"]')||{}).dataset && document.querySelector('#exportModal .export-scope-item[aria-checked="true"]').dataset.scope,
  outcome: document.getElementById('exportOutcome').textContent
})`));
ws.close();
