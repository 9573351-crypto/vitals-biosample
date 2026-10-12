#!/usr/bin/env node
/* 导航到指定视图并（可选）聚焦某个控件，便于截图观察原生下拉/日期控件的实际观感。
   用法：node .local-ci/show-view.mjs [port] [view] [selector] */
const port = Number(process.argv[2] || 9222);
const view = process.argv[3] || 'records';
const selector = process.argv[4] || '';
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
await ev(`document.querySelector('.nav-item[data-view="${view}"]').click()`);
await new Promise(r => setTimeout(r, 900));
if (selector) {
  console.log(await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if(!el) return 'selector not found';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ id: el.id, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), h: Math.round(r.height) });
  })()`));
}
console.log('view=' + await ev(`document.querySelector('.view.active').id`));
ws.close();
