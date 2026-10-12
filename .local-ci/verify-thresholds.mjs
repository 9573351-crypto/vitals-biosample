#!/usr/bin/env node
/* 阈值设置页验收（真实 WebView 驱动）：
   1) 侧边栏有「阈值设置」入口，设置页不再有阈值控件但保留备份卡片；
   2) 分组口径与样本库一致（存储三类 + 库中实际出现的类别）；
   3) 每组显示默认值且初始为「默认」而非「已自定义」；
   4) 改一组阈值 → 存进 state.set.thresholds 并持久化（重新加载仍在）；
   5) 阈值变化立即重算该组样本的告警（收窄到一定报警）；
   6) 上下限反了会拒绝；「恢复默认」清除该组自定义；「全部恢复默认」清空；
   7) 触控高度 ≥44px、输入框符合统一控件体系。
   用法：node .local-ci/verify-thresholds.mjs [port] */
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

const openPage = async () => {
  await ev(`document.querySelector('.nav-item[data-view="thresholds"]').click()`);
  await wait(700);
  return ev(`(() => ({
    view: document.querySelector('.view.active').id,
    title: document.getElementById('pageTitle').textContent,
    pill: (document.getElementById('thresholdPill')||{}).textContent || '',
    rows: [...document.querySelectorAll('.threshold-row')].map(r => ({
      code: r.dataset.code,
      name: r.querySelector('.threshold-name b').textContent,
      note: r.querySelector('.threshold-name small').textContent,
      lo: r.querySelector('input[data-th="lo"]').value,
      hi: r.querySelector('input[data-th="hi"]').value,
      btnH: Math.round(r.querySelector('.btn.mini').getBoundingClientRect().height),
      inputH: Math.round(r.querySelector('input[data-th="lo"]').getBoundingClientRect().height),
      radius: getComputedStyle(r.querySelector('input[data-th="lo"]')).borderTopLeftRadius
    })),
    hasResetAll: !!document.getElementById('thresholdResetAll')
  }))()`);
};

/* 每次从干净状态开始：清掉阈值自定义（否则上一轮的残留会让"初始不显示已自定义"失败） */
await ev(`(() => {
  state.set.thresholds = {};
  delete state.set.thresholdsSeeded;
  saveAll();
  if(typeof seedThresholds === 'function' && seedThresholds()) saveAll();
  return true;
})()`);
await wait(500);

/* ---- 1. 入口与页面 ---- */
const navOk = await ev(`!!document.querySelector('.nav-item[data-view="thresholds"]')`);
check('侧边栏有「阈值设置」入口', navOk === true);
const page1 = await openPage();
console.log('页面 = ' + JSON.stringify({ view: page1.view, title: page1.title, pill: page1.pill, groups: page1.rows.map(r => r.name) }));
check('进入阈值设置页且标题正确', page1.view === 'view-thresholds' && page1.title === '阈值设置', JSON.stringify(page1.title));
check('分组与样本库口径一致（含库中出现的 DNA）',
  ['全血', '血清', '血浆', 'DNA'].every(n => page1.rows.some(r => r.name === n)), page1.rows.map(r => r.name).join(','));
check('每组显示默认区间', page1.rows.every(r => /默认 -?\d+(\.\d+)? ~ -?\d+(\.\d+)? ℃/.test(r.note)), JSON.stringify(page1.rows.map(r => r.note)));
check('初始不显示「已自定义」', page1.rows.every(r => !/已自定义/.test(r.note)), JSON.stringify(page1.rows.map(r => r.note)));
check('输入控件符合统一体系（≥44px、11px 圆角）', page1.rows.every(r => r.inputH >= 44 && r.radius === '11px'), JSON.stringify(page1.rows.map(r => r.inputH + '/' + r.radius)));
check('按钮高度 ≥44px', page1.rows.every(r => r.btnH >= 44), JSON.stringify(page1.rows.map(r => r.btnH)));
check('有「全部恢复默认」', page1.hasResetAll === true);

/* ---- 2. 设置页现状 ---- */
await ev(`document.querySelector('.nav-item[data-view="settings"]').click()`);
await wait(600);
const settings = await ev(`(() => ({
  view: document.querySelector('.view.active').id,
  hasThresholdInputs: !!document.querySelector('#view-settings input#setHi, #view-settings input#setLo'),
  hint: (document.querySelector('#view-settings .muted')||{}).textContent || '',
  cards: [...document.querySelectorAll('#view-settings > section')].map(s => (s.querySelector('h3')||{}).textContent || '')
}))()`);
console.log('设置页 = ' + JSON.stringify(settings));
check('设置页已无阈值输入控件', settings.hasThresholdInputs === false);
check('设置页指向新的阈值页', /阈值设置/.test(settings.hint), settings.hint);
check('设置页保留「一体机内部自动备份」卡片', settings.cards.some(c => /自动备份/.test(c)), JSON.stringify(settings.cards));

/* ---- 3. 改一组阈值：持久化 + 告警联动 ---- */
const target = await ev(`(() => {
  // 选一个在库样本所属的分组
  const s = Object.values(state.s.samples)[0];
  return s ? s.type : '全血';
})()`);
console.log('测试分组 = ' + target);
const before = await ev(`(() => {
  const s = Object.values(state.s.samples).find(x => x.type === ${JSON.stringify(target)});
  const th = thresholdForSample(s);
  return JSON.stringify({ temp: s && s.lastTemp, alert: s && s.alert, th: th });
})()`);
console.log('改前 = ' + before);

await ev(`(() => {
  document.querySelector('.nav-item[data-view="thresholds"]').click();
  return true;
})()`);
await wait(600);
// 把该组上下限收窄成 [temp-0.1, temp+0.1]（必然报警）
await ev(`(() => {
  const row = [...document.querySelectorAll('.threshold-row')].find(r => r.querySelector('.threshold-name b').textContent === ${JSON.stringify(target)});
  const s = Object.values(state.s.samples).find(x => x.type === ${JSON.stringify(target)});
  const t = (s && s.lastTemp != null) ? s.lastTemp : 20;
  const lo = row.querySelector('input[data-th="lo"]'), hi = row.querySelector('input[data-th="hi"]');
  lo.value = String(t - 0.1); hi.value = String(t + 0.1);
  hi.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await wait(700);
const after = await ev(`(() => {
  const s = Object.values(state.s.samples).find(x => x.type === ${JSON.stringify(target)});
  const saved = (state.set.thresholds || {})[MotionCore.categoryCodes[${JSON.stringify(target)}]];
  const row = [...document.querySelectorAll('.threshold-row')].find(r => r.querySelector('.threshold-name b').textContent === ${JSON.stringify(target)});
  // 从持久化层重新读一次，确认真的落库（而不是只在内存里）
  const persisted = (Store.load() || {}).set || {};
  return JSON.stringify({ alert: s && s.alert, saved: saved, note: row.querySelector('.threshold-name small').textContent,
    persistedCodes: Object.keys(persisted.thresholds || {}),
    persistedEntry: (persisted.thresholds || {})[MotionCore.categoryCodes[${JSON.stringify(target)}]] || null });
})()`);
console.log('改后 = ' + after);
const aft = JSON.parse(after);
check('阈值已写入 state.set.thresholds 且带 custom 标志', aft.saved && aft.saved.custom === true, JSON.stringify(aft.saved));
check('收窄阈值后该组样本立刻报警', aft.alert === 'bad' || aft.alert === 'warn', String(aft.alert));
check('该组标记为「已自定义」', /已自定义/.test(aft.note), aft.note);
check('阈值已持久化到原生设置表', Array.isArray(aft.persistedCodes) && aft.persistedCodes.length > 0 && aft.persistedEntry && aft.persistedEntry.custom === true, JSON.stringify({ codes: aft.persistedCodes, entry: aft.persistedEntry }));

/* ---- 4. 上限 ≤ 下限会被拒绝 ---- */
const invalid = await ev(`(() => {
  const row = [...document.querySelectorAll('.threshold-row')].find(r => r.querySelector('.threshold-name b').textContent === ${JSON.stringify(target)});
  const lo = row.querySelector('input[data-th="lo"]'), hi = row.querySelector('input[data-th="hi"]');
  const before = (state.set.thresholds[MotionCore.categoryCodes[${JSON.stringify(target)}]] || {}).hi;
  lo.value = '50'; hi.value = '40';
  hi.dispatchEvent(new Event('change', { bubbles: true }));
  const after = (state.set.thresholds[MotionCore.categoryCodes[${JSON.stringify(target)}]] || {}).hi;
  return JSON.stringify({ unchanged: before === after, before: before, after: after });
})()`);
console.log('非法输入 = ' + invalid);
check('上限 ≤ 下限时拒绝保存（值不变）', JSON.parse(invalid).unchanged === true, invalid);

/* ---- 5. 恢复默认 ---- */
await ev(`(() => {
  const row = [...document.querySelectorAll('.threshold-row')].find(r => r.querySelector('.threshold-name b').textContent === ${JSON.stringify(target)});
  row.querySelector('[data-th-reset]').click();
  return true;
})()`);
await wait(700);
const reset = await ev(`(() => {
  const code = MotionCore.categoryCodes[${JSON.stringify(target)}];
  const row = [...document.querySelectorAll('.threshold-row')].find(r => r.querySelector('.threshold-name b').textContent === ${JSON.stringify(target)});
  const s = Object.values(state.s.samples).find(x => x.type === ${JSON.stringify(target)});
  return JSON.stringify({ savedGone: !(state.set.thresholds || {})[code] || (state.set.thresholds[code] || {}).custom !== true,
    note: row.querySelector('.threshold-name small').textContent, alert: s && s.alert });
})()`);
console.log('恢复默认 = ' + reset);
const rst = JSON.parse(reset);
check('「恢复默认」清除该组自定义', rst.savedGone === true, JSON.stringify(rst));
check('恢复后不再显示「已自定义」', !/已自定义/.test(rst.note), rst.note);

/* ---- 6. 全部恢复默认 ---- */
await ev(`document.getElementById('thresholdResetAll').click()`);
await wait(400);
await ev(`document.getElementById('confirmYes').click()`);
await wait(700);
const resetAll = await ev(`(() => ({
  count: Object.keys(state.set.thresholds || {}).length,
  custom: Object.values(state.set.thresholds || {}).filter(v => v && v.custom === true).length,
  notes: [...document.querySelectorAll('.threshold-name small')].map(e => e.textContent)
}))()`);
console.log('全部恢复 = ' + JSON.stringify(resetAll));
check('「全部恢复默认」清除所有自定义', resetAll.custom === 0, JSON.stringify(resetAll.count));
check('全部恢复后所有分组都不显示「已自定义」', resetAll.notes.every(n => !/已自定义/.test(n)), JSON.stringify(resetAll.notes));

console.log(`\nTOTAL ${pass} passed, ${fail} failed`);
ws.close();
if (fail) process.exit(1);
