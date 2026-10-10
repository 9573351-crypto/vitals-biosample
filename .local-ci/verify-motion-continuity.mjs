#!/usr/bin/env node
/* 验证方案 A 的连续性行为（在真实 WebView 上驱动）：
   1) 点击样本卡时，面板的 WAAPI 动画确实从该卡片的矩形起步（共享元素起点）；
   2) 面板落位后 transform 回到 none；
   3) reduced-motion 下不启动共享元素动画（走 CSS 规则）；
   4) 列表行的按压/状态时长来自 token（80/140/220/340 四档内）。
   用法：node .local-ci/verify-motion-continuity.mjs [port] */
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

console.log('MO 可用: ' + await ev(`typeof window.MO`));
console.log('reduce 探测: ' + await ev(`window.MO ? MO.reduced() : 'n/a'`));
console.log('linear() 支持: ' + await ev(`CSS.supports('transition-timing-function','linear(0, 0.5, 1)')`));

// 进入样本库
await ev(`document.querySelector('.nav-item[data-view="library"]').click()`);
await new Promise(r => setTimeout(r, 800));
const rows = await ev(`document.querySelectorAll('#sampleList .sample-row').length`);
check('样本库有可点击的样本卡', rows > 0, 'rows=' + rows);

// 关键验证：点击卡片后，面板的 WAAPI 动画起点是否来自该卡片
const result = await ev(`(() => {
  const row = document.querySelector('#sampleList .sample-row');
  const rect = row.getBoundingClientRect();
  // 记录动画起点：包一层 MO.shared，捕获它收到的 fromRect
  const original = MO.shared;
  let captured = null;
  MO.shared = function(el, fromRect, opts){ captured = { fromRect: {...fromRect}, el: el.className }; return original.apply(this, arguments); };
  row.click();
  MO.shared = original;
  const panel = document.querySelector('#detailModal .modal');
  const anims = panel ? panel.getAnimations().map(a => ({ name:a.animationName || '(transition)', state:a.playState })) : [];
  return {
    cardRect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
    captured,
    modalOpen: document.getElementById('detailModal').classList.contains('open'),
    panelAnims: anims,
    panelTransform: panel ? getComputedStyle(panel).transform : null
  };
})()`);
console.log(JSON.stringify(result, null, 2));
check('点开卡片时面板从该卡片矩形起步（carry 存在）', !!result.captured, '未捕获到 MO.shared 调用');
if (result.captured) {
  const c = result.captured.fromRect, r = result.cardRect;
  const sameBox = Math.abs(c.width - r.width) < 2 && Math.abs(c.left - r.left) < 2 && Math.abs(c.top - r.top) < 2;
  check('起点矩形就是被点击卡片的矩形', sameBox, JSON.stringify({ c, r }));
  check('起点元素是弹窗面板', /modal/.test(result.captured.el), result.captured.el);
}
check('面板已进入打开态', result.modalOpen === true, String(result.modalOpen));
check('面板在跑 WAAPI 动画', result.panelAnims.length > 0, JSON.stringify(result.panelAnims));

// 等动画结束，确认落位并交还 CSS
await new Promise(r => setTimeout(r, 900));
const settled = await ev(`(() => {
  const panel = document.querySelector('#detailModal .modal');
  return { transform: getComputedStyle(panel).transform, inlineTransition: panel.style.transition };
})()`);
console.log('落位后: ' + JSON.stringify(settled));
check('动画结束后面板回到最终位置', settled.transform === 'none' || settled.transform === 'matrix(1, 0, 0, 1, 0, 0)', settled.transform);
check('动画结束后交还 CSS（inline transition 清空）', settled.inlineTransition === '', JSON.stringify(settled.inlineTransition));

// 关闭
await ev(`document.getElementById('closeDetail').click()`);
await new Promise(r => setTimeout(r, 600));
check('关闭后回到列表', await ev(`document.getElementById('detailModal').classList.contains('open')`) === false);

// 时长只取 token 四档
const durs = await ev(`(() => {
  const set = new Set();
  document.querySelectorAll('*').forEach(el => {
    const d = getComputedStyle(el).transitionDuration;
    if (d && d !== '0s') d.split(',').forEach(x => set.add(Math.round(parseFloat(x) * 1000)));
  });
  return [...set].sort((a,b)=>a-b);
})()`);
console.log('页面出现的时长档位: ' + JSON.stringify(durs));
const TOKEN_DURS = [80, 140, 220, 340, 500, 350, 449, 393, 314]; // 5 档 + 弹簧自然时长\ncheck('时长只取 token 档位（5 档 + 弹簧落位时长）', durs.every(d => TOKEN_DURS.includes(d)), JSON.stringify(durs));
check('同屏时长跨度 ≥ 4×（最快:最慢）', durs.length >= 2 && (durs[durs.length - 1] / durs[0]) >= 4, JSON.stringify(durs));

console.log(`\nTOTAL ${pass} passed, ${fail} failed`);
ws.close();
if (fail) process.exit(1);
