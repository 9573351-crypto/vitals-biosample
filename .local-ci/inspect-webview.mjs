#!/usr/bin/env node
/* 通过 Chrome DevTools 协议直连应用 WebView，检查平板布局的关键事实：
   1) CSS 视口尺寸与关键断点是否命中；
   2) 各滚动容器的 scrollHeight / clientHeight，判断是否存在"内容被裁切且无法滚动"；
   3) 侧栏宽度、概览卡片列数等实际计算样式。
   用法：node .local-ci/inspect-webview.mjs [端口，默认 9222] */
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

const report = await evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const box = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
  const scrollInfo = (el, name) => {
    if (!el) return { name, missing: true };
    const style = getComputedStyle(el);
    return {
      name,
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
      overflowY: style.overflowY,
      canScroll: el.scrollHeight > el.clientHeight + 2,
      scrollable: /auto|scroll/.test(style.overflowY),
      clipped: el.scrollHeight > el.clientHeight + 2 && !/auto|scroll/.test(style.overflowY)
    };
  };
  const cards = q('.cards');
  const cardCount = cards ? getComputedStyle(cards).gridTemplateColumns.split(' ').length : 0;
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    breakpoints: {
      isFullTablet: innerWidth > 1100,        // android.css: >1100 完整布局
      cardsFourCols: innerWidth > 1080,       // styles.css: <=1080 降为 2 列
      sidebarFull: innerWidth > 860            // styles.css: <=860 收成 64px
    },
    sidebar: (() => { const el = q('.sidebar'); return el ? { width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) } : null; })(),
    main: box(q('.main')),
    cardColumns: cardCount,
    activeView: (() => { const el = q('.view.active'); return el ? el.id : null; })(),
    scroll: [
      scrollInfo(document.documentElement, 'html'),
      scrollInfo(document.body, 'body'),
      scrollInfo(q('.main'), '.main'),
      scrollInfo(q('.view.active'), '.view.active'),
      scrollInfo(q('.content'), '.content')
    ]
  };
})()`);

console.log(JSON.stringify(report, null, 2));

const problems = report.scroll.filter(s => s.clipped);
if (problems.length) {
  console.log('\n[!] 存在"内容超出且不可滚动"的容器：');
  for (const p of problems) console.log(`    ${p.name}: clientH=${p.clientH} scrollH=${p.scrollH} overflowY=${p.overflowY}`);
} else {
  console.log('\n[OK] 没有"超出且不可滚动"的容器');
}
ws.close();
