#!/usr/bin/env node
/* 量「动态记录」页（及全站）表单控件的真实尺寸与样式，用于 HIG 审计：
   - 高度是否 ≥44px（HIG 最小触控目标）
   - 文本对比度、边框、圆角是否一致
   - select 是否自定义外观（Android 上未设 appearance 会保留系统箭头/内边距）
   - date 输入的原生指示器是否可见、是否被裁切
   用法：node .local-ci/audit-form-controls.mjs [port] [viewId] */
const port = Number(process.argv[2] || 9222);
const view = process.argv[3] || 'records';
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

const report = await ev(`(() => {
  const out = { view: document.querySelector('.view.active').id, controls: [], viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } };
  const sel = 'input, select, textarea';
  document.querySelectorAll(sel).forEach(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 自绘下拉的原生 select 被刻意隐藏（1px、只作数据源），真正可点的是 .sp-trigger
    if (el.classList.contains('sp-native')) return;
    const cs = getComputedStyle(el);
    const label = el.closest('label');
    out.controls.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      id: el.id || '',
      label: label && label.querySelector('span') ? label.querySelector('span').textContent.trim() : '',
      w: Math.round(r.width), h: Math.round(r.height),
      fontSize: cs.fontSize,
      color: cs.color,
      bg: cs.backgroundColor,
      border: cs.borderTopWidth + ' ' + cs.borderTopColor,
      radius: cs.borderTopLeftRadius,
      appearance: cs.appearance || cs.webkitAppearance,
      padding: cs.padding,
      pass44: r.height >= 44
    });
  });
  out.fail44 = out.controls.filter(c => !c.pass44).map(c => c.id + '(' + c.h + 'px)');
  out.distinctHeights = [...new Set(out.controls.map(c => c.h))].sort((a,b)=>a-b);
  out.distinctFontSizes = [...new Set(out.controls.map(c => c.fontSize))];
  out.distinctRadius = [...new Set(out.controls.map(c => c.radius))];
  out.selectAppearance = [...new Set(out.controls.filter(c => c.tag === 'select').map(c => c.appearance))];
  out.selectPadding = [...new Set(out.controls.filter(c => c.tag === 'select').map(c => c.padding))];
  return out;
})()`);

console.log(JSON.stringify(report, null, 1));
console.log('\n=== 结论 ===');
console.log('控件高度档位: ' + JSON.stringify(report.distinctHeights));
console.log('未达 44px 的控件: ' + (report.fail44.length ? report.fail44.join(', ') : '无'));
console.log('字体档位: ' + JSON.stringify(report.distinctFontSizes));
console.log('圆角档位: ' + JSON.stringify(report.distinctRadius));
console.log('select 的 appearance: ' + JSON.stringify(report.selectAppearance));
console.log('select 的 padding: ' + JSON.stringify(report.selectPadding));
ws.close();
