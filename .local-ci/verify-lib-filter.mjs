#!/usr/bin/env node
/* 样本库类别筛选的功能与无障碍验收（通过 Chrome DevTools 协议驱动真实 WebView）。
   检查项：
   1) chip 集合与计数是否与数据一致；
   2) 点击某类别后列表是否只剩该类别，且「清除筛选」可用；
   3) 触控高度是否 ≥44 CSS px（HIG 最小目标）；
   4) 选中态是否同时提供勾号（不单靠颜色传达含义）；
   5) 键盘 ←/→ 是否能在单选组内切换；
   6) 「全部」态下清除按钮是否隐藏。
   用法：node .local-ci/verify-lib-filter.mjs [端口，默认 9222] */
const port = Number(process.argv[2] || 9222);

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page') || targets[0];
if (!page) { console.error('未找到页面目标'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const messageId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
}
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  const slot = pending.get(message.id);
  if (!slot) return;
  pending.delete(message.id);
  if (message.error) slot.reject(new Error(JSON.stringify(message.error)));
  else slot.resolve(message.result);
});
await new Promise((resolve) => ws.addEventListener('open', resolve));
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// 进入样本库
await evaluate(`document.querySelector('.nav-item[data-view="library"]').click()`);
await new Promise(r => setTimeout(r, 600));

const chips = await evaluate(`Array.from(document.querySelectorAll('#libTypeFilter .lib-chip')).map(c => ({
  type: c.dataset.type, checked: c.getAttribute('aria-checked') === 'true',
  h: Math.round(c.getBoundingClientRect().height), w: Math.round(c.getBoundingClientRect().width),
  label: c.querySelector('.lib-chip-label').textContent,
  count: Number(c.querySelector('.lib-chip-count').textContent),
  hasCheck: getComputedStyle(c.querySelector('.lib-chip-check')).display !== 'none',
  tabindex: c.getAttribute('tabindex'), role: c.getAttribute('role')
}))`);
console.log('chips = ' + JSON.stringify(chips));
check('存在「全部」chip 且默认选中', chips[0]?.type === 'all' && chips[0]?.checked, JSON.stringify(chips[0]));
check('三个标准类别都有 chip', ['全血', '血清', '血浆'].every(t => chips.some(c => c.type === t)), chips.map(c => c.type).join(','));
check('数据中的其它类别也生成 chip（DNA）', chips.some(c => c.type === 'DNA'), chips.map(c => c.type).join(','));
check('单选组语义正确（role=radio，仅选中项 tabindex=0）',
  chips.every(c => c.role === 'radio') && chips.filter(c => c.tabindex === '0').length === 1,
  JSON.stringify(chips.map(c => [c.type, c.tabindex])));
check('触控高度 ≥44px（HIG）', chips.every(c => c.h >= 44), chips.map(c => c.type + ':' + c.h).join(','));
check('选中项另有勾号（不单靠颜色）',
  chips.filter(c => c.checked).every(c => c.hasCheck) && chips.filter(c => !c.checked).every(c => !c.hasCheck),
  JSON.stringify(chips.map(c => [c.type, c.checked, c.hasCheck])));

// 全部态：不做筛选，计数与数据一致
const allCount = chips.find(c => c.type === 'all').count;
const rowsAll = await evaluate(`document.querySelectorAll('#sampleList .sample-row').length`);
check('「全部」显示全部样本', rowsAll === allCount, `rows=${rowsAll} count=${allCount}`);
const clearHiddenAtAll = await evaluate(`document.getElementById('clearTypeFilter').hidden`);
check('「全部」且无搜索时隐藏「清除筛选」', clearHiddenAtAll === true, String(clearHiddenAtAll));

// 点击「血浆」，应只剩血浆样本
const plasma = chips.find(c => c.type === '血浆');
await evaluate(`document.querySelector('#libTypeFilter .lib-chip[data-type="血浆"]').click()`);
await new Promise(r => setTimeout(r, 500));
const afterPlasma = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('#sampleList .sample-row'));
  // 只取「编号 · 类别 · 位置」中的类别片段判断，避免位置名里也含类别字样造成误判
  const types = rows.map(r => ((r.querySelector('.sample-sub')||{}).textContent || '').split('·')[1] || '').map(s => s.trim());
  return {
    rows: rows.length,
    types,
    count: (document.getElementById('libCount')||{}).textContent,
    clearHidden: document.getElementById('clearTypeFilter').hidden,
    plasmaChecked: document.querySelector('#libTypeFilter .lib-chip[data-type="血浆"]').getAttribute('aria-checked'),
    chipCounts: Array.from(document.querySelectorAll('#libTypeFilter .lib-chip')).map(c => c.querySelector('.lib-chip-count').textContent)
  };
})()`);
console.log('after 血浆 = ' + JSON.stringify(afterPlasma));
check('按类别筛选后行数正确', afterPlasma.rows === plasma.count, `rows=${afterPlasma.rows} chip=${plasma.count}`);
check('筛选后列表只含该类别', afterPlasma.rows > 0 && afterPlasma.types.every(t => t === '血浆'), afterPlasma.types.join(','));
check('筛选后「血浆」为选中态', afterPlasma.plasmaChecked === 'true', afterPlasma.plasmaChecked);
check('筛选后「清除筛选」可用', afterPlasma.clearHidden === false, String(afterPlasma.clearHidden));
check('筛选后仍显示总数与显示数', /共 \d+ 个样本 · 显示 \d+/.test(afterPlasma.count || ''), afterPlasma.count);

// 键盘 ←/→ 在单选组内切换
await evaluate(`document.querySelector('#libTypeFilter .lib-chip[aria-checked="true"]').focus()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
await new Promise(r => setTimeout(r, 400));
const afterArrow = await evaluate(`(() => {
  const checked = document.querySelector('#libTypeFilter .lib-chip[aria-checked="true"]');
  return { type: checked.dataset.type, focused: document.activeElement === checked, rows: document.querySelectorAll('#sampleList .sample-row').length };
})()`);
console.log('after ArrowRight = ' + JSON.stringify(afterArrow));
check('方向键可切换选中项且焦点跟随', afterArrow.type !== '血浆' && afterArrow.focused, JSON.stringify(afterArrow));

// 清除筛选回到全部
await evaluate(`document.getElementById('clearTypeFilter').click()`);
await new Promise(r => setTimeout(r, 400));
const afterClear = await evaluate(`(() => ({
  rows: document.querySelectorAll('#sampleList .sample-row').length,
  allChecked: document.querySelector('#libTypeFilter .lib-chip[data-type="all"]').getAttribute('aria-checked'),
  search: document.getElementById('searchInput').value,
  clearHidden: document.getElementById('clearTypeFilter').hidden
}))()`);
console.log('after clear = ' + JSON.stringify(afterClear));
check('清除筛选后恢复全部样本', afterClear.rows === allCount && afterClear.allChecked === 'true', JSON.stringify(afterClear));
check('清除筛选后按钮再次隐藏', afterClear.clearHidden === true, String(afterClear.clearHidden));

// 与搜索联动：类别 + 关键词同时生效
await evaluate(`(() => { const i = document.getElementById('searchInput'); i.value = '血浆'; i.dispatchEvent(new Event('input')); })()`);
await new Promise(r => setTimeout(r, 400));
await evaluate(`document.querySelector('#libTypeFilter .lib-chip[data-type="血清"]').click()`);
await new Promise(r => setTimeout(r, 400));
const combo = await evaluate(`(() => ({
  rows: document.querySelectorAll('#sampleList .sample-row').length,
  empty: (document.querySelector('#sampleList .empty')||{}).textContent || ''
}))()`);
console.log('combo 血清+关键词血浆 = ' + JSON.stringify(combo));
check('类别与关键词同时生效（结果为空且提示清晰）', combo.rows === 0 && /没有符合/.test(combo.empty), JSON.stringify(combo));
await evaluate(`document.getElementById('clearTypeFilter').click()`);

console.log(`\nTOTAL ${passed} passed, ${failed} failed`);
ws.close();
if (failed) process.exit(1);
