#!/usr/bin/env node
/* 量「录入样本」弹窗里的表单控件（下拉/日期/数字），确认与全站统一。
   用法：node .local-ci/audit-modal-controls.mjs [port] */
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
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
  return r.result.value;
};

await ev(`document.getElementById('addSampleBtn').click()`);
await new Promise(r => setTimeout(r, 800));
const report = await ev(`JSON.stringify([...document.querySelectorAll('#sampleModal input, #sampleModal select')].filter(el => !el.classList.contains('sp-native')).map(el => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { id: el.id, kind: el.type || el.tagName.toLowerCase(), h: Math.round(r.height),
           appearance: cs.appearance, radius: cs.borderTopLeftRadius, pad: cs.padding };
}))`);
console.log(report);
const parsed = JSON.parse(report);
console.log('高度档位: ' + JSON.stringify([...new Set(parsed.map(c => c.h))]));
console.log('圆角档位: ' + JSON.stringify([...new Set(parsed.map(c => c.radius))]));
console.log('select 的 appearance: ' + JSON.stringify([...new Set(parsed.filter(c => c.kind === 'select-one').map(c => c.appearance))]));
console.log('未达 44px: ' + (parsed.filter(c => c.h < 44).map(c => c.id + '(' + c.h + ')').join(', ') || '无'));
await ev(`document.getElementById('closeModal').click()`);
ws.close();
