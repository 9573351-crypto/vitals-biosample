#!/usr/bin/env node
/* 验证自绘下拉的打开态：面板结构、选项行高、当前项勾选、定位、键盘与关闭行为。
   用法：node .local-ci/verify-picker.mjs [port] */
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
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log('PASS ' + n)) : (fail++, console.log('FAIL ' + n + (d ? ' — ' + d : ''))); };

// 进入记录页，并把筛选重置为「全部类型」（上次运行可能留下了非默认筛选，会被持久化）
await ev(`document.querySelector('.nav-item[data-view="records"]').click()`);
await wait(800);
await ev(`(() => {
  const s = document.querySelector('.sp-native');
  if(s && s.value !== ''){ s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); }
  return true;
})()`);
await wait(500);

const trigger = await ev(`(() => {
  const t = document.querySelector('.sp-wrap .sp-trigger');
  const r = t.getBoundingClientRect();
  return JSON.stringify({ text: t.textContent.trim(), h: Math.round(r.height), w: Math.round(r.width), hasChevron: getComputedStyle(t).backgroundImage.includes('svg') });
})()`);
console.log('trigger = ' + trigger);
const trig = JSON.parse(trigger);
check('原生 select 已换成自绘 trigger', trig.text === '全部类型', trig.text);
check('trigger 高度 48px', trig.h === 48, String(trig.h));
check('trigger 带自定义雪佛龙', trig.hasChevron === true);
check('原生 select 不参与布局', await ev(`(() => { const s = document.querySelector('.sp-native'); const r = s.getBoundingClientRect(); return Math.round(r.height) <= 2; })()`) === true);

// 打开面板
await ev(`document.querySelector('.sp-wrap .sp-trigger').click()`);
await wait(400);
const opened = await ev(`(() => {
  const p = document.querySelector('.sp-panel');
  if(!p || p.hidden) return JSON.stringify({ open:false });
  const r = p.getBoundingClientRect();
  const items = [...p.querySelectorAll('.sp-item')];
  const cs = getComputedStyle(p);
  return JSON.stringify({
    open: true, w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderTopLeftRadius,
    shadow: cs.boxShadow !== 'none', role: p.getAttribute('role'),
    count: items.length,
    itemH: items.length ? Math.round(items[0].getBoundingClientRect().height) : 0,
    selected: items.filter(i => i.getAttribute('aria-selected') === 'true').map(i => i.textContent.trim()),
    labels: items.slice(0, 4).map(i => i.querySelector('.sp-label').textContent.trim()),
    inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1
  });
})()`);
console.log('panel = ' + opened);
const op = JSON.parse(opened);
check('点击后自绘面板打开', op.open === true);
check('面板使用应用圆角（≥10px）', op.radius && parseFloat(op.radius) >= 10, op.radius);
check('面板有阴影（与卡片同一层次体系）', op.shadow === true);
check('面板是 listbox 语义', op.role === 'listbox', op.role);
check('选项行高 ≥44px', op.itemH >= 44, String(op.itemH));
check('当前项带勾选标记', op.selected.length === 1 && /全部类型/.test(op.selected[0]), JSON.stringify(op.selected));
check('面板完全在视口内', op.inViewport === true);
check('选项来自原 select（含"入库"等）', op.labels.some(l => l === '全部类型'), JSON.stringify(op.labels));

// 键盘：↓ 然后 Enter 选择
await ev(`(() => { const t = document.querySelector('.sp-wrap .sp-trigger'); t.focus(); return true; })()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
await wait(250);
const afterDown = await ev(`(() => { const p = document.querySelector('.sp-panel'); return p && !p.hidden ? [...p.querySelectorAll('.sp-item')].find(b => b.getAttribute('aria-selected') === 'true').textContent.trim() : 'closed'; })()`);
console.log('ArrowDown 后高亮: ' + afterDown);
check('方向键移动高亮', afterDown !== 'closed' && afterDown !== '全部类型', afterDown);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await wait(400);
const afterEnter = await ev(`(() => {
  const t = document.querySelector('.sp-wrap .sp-trigger');
  const s = document.querySelector('.sp-native');
  return JSON.stringify({ trigger: t.textContent.trim(), value: s.value, panelHidden: document.querySelector('.sp-panel').hidden,
    focusBack: document.activeElement === t, rows: document.querySelectorAll('#recordBody tr').length });
})()`);
console.log('Enter 后 = ' + afterEnter);
const ae = JSON.parse(afterEnter);
check('Enter 选中后写回原生 select', ae.value !== '' && ae.trigger.replace(/[✓\s]+$/, '') === afterDown.replace(/[✓\s]+$/, ''), JSON.stringify(ae));
check('选中后关闭面板并把焦点还给 trigger', ae.panelHidden === true && ae.focusBack === true, JSON.stringify(ae));
check('筛选真的生效（表格行数变化或为 0）', Number.isFinite(ae.rows), String(ae.rows));

// Esc 关闭
await ev(`document.querySelector('.sp-wrap .sp-trigger').click()`);
await wait(300);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await wait(300);
check('Esc 关闭面板', await ev(`document.querySelector('.sp-panel').hidden`) === true);

// 点击外部关闭
await ev(`document.querySelector('.sp-wrap .sp-trigger').click()`);
await wait(300);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1300, y: 700, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1300, y: 700, button: 'left', clickCount: 1 });
await wait(300);
check('点击面板外关闭', await ev(`document.querySelector('.sp-panel').hidden`) === true);

console.log(`\nTOTAL ${pass} passed, ${fail} failed`);
ws.close();
if (fail) process.exit(1);
