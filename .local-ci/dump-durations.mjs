#!/usr/bin/env node
/* 枚举页面里所有"带过渡/动画"的元素，打印 computed transitionDuration/Property 与来源。
   用来定位审计 tokens 腿量到的 180ms 究竟来自哪条规则。
   用法：node .local-ci/dump-durations.mjs [port] */
const port = Number(process.argv[2] || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page') || targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', e => { const m = JSON.parse(e.data); const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.rej(new Error(JSON.stringify(m.error))) : s.res(m.result); });
await new Promise(r => ws.addEventListener('open', r));
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

const rows = await ev(`(() => {
  const out = [];
  document.querySelectorAll('*').forEach(el => {
    const cs = getComputedStyle(el);
    const dur = cs.transitionDuration;
    const prop = cs.transitionProperty;
    const anim = cs.animationName;
    const inline = el.getAttribute('style') || '';
    const hasTrans = dur && dur !== '0s' && prop && prop !== 'none';
    const hasAnim = anim && anim !== 'none';
    if (!hasTrans && !hasAnim) return;
    out.push({
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''),
      dur, prop, anim,
      inline: inline.slice(0, 120)
    });
  });
  return out;
})()`);

const byDur = new Map();
for (const r of rows) {
  const key = r.dur + ' | ' + r.prop + (r.anim !== 'none' ? ' | anim:' + r.anim : '');
  if (!byDur.has(key)) byDur.set(key, { n: 0, sample: r });
  byDur.get(key).n++;
}
console.log(`共 ${rows.length} 个元素带过渡/动画\n`);
for (const [key, v] of [...byDur.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`×${String(v.n).padStart(3)}  ${key}`);
  console.log(`       例: ${v.sample.sel}`);
  if (v.sample.inline) console.log(`       inline: ${v.sample.inline}`);
}
const inlineOnes = rows.filter(r => /transition|animation/.test(r.inline));
if (inlineOnes.length) {
  console.log(`\n带内联 transition/animation 的元素（${inlineOnes.length}）：`);
  for (const r of inlineOnes.slice(0, 20)) console.log(`  ${r.sel}  inline="${r.inline}"  computed=${r.dur}`);
}
ws.close();
