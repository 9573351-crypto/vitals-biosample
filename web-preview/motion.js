/* onemotion · lib/motion.js — 网页动效的运动库（纯数值核心 + 一层 DOM 封装）
 *
 * 这是什么：onemotion 技能的运动库。动效 =「状态 / 输入 / 滚动进度」的纯函数，时间只是单次 transition 内部的轴。
 *
 * 与 onetake 的关系：onetake/lib/motion.js 是影片版（动效是绝对时间的纯函数 f(t)，为逐帧渲染服务：
 * 相机键帧、快门、预积分 sim）。这里复用它经得起检验的数学——cubic-bezier 牛顿+二分求解、阻尼阶跃响应与
 * 速度、settle 扫描、xorshift32 rng——但去掉视频专用 move（flyThrough/iris/zoomThrough/shutter/sim），
 * 换成网页真正需要的东西：可中断状态机（presence/cancel）、手势（drag/swipe/rubberband/inertia）、
 * 滚动驱动（scrollProgress/onScrollFrame/parallax/camera/view）、衔接（flip/flipMany/shared/morphTransform）、
 * 无障碍（reduced/onReducedChange）。数字全部来自 onemotion/_contract.md 的冻结表，不自行发明。
 *
 * 用法（classic script / UMD —— file:// 下 ES module import 会被 CORS 拦住）：
 *   <script src="lib/motion.js"></script>     →  window.MO
 *   const MO = require('./lib/motion.js')     →  Node（纯数值函数可直接测；DOM 函数被调用时抛清晰错误）
 *
 * 纪律：零依赖；无 Math.random（要随机用 MO.rng(seed)）；除「滚动订阅注册表」外没有任何跨调用状态
 * （那张表是 onScrollFrame 基准要求的唯一全局 rAF 节流器）。
 *
 * 单位约定：时长 ms（toLinear/spring/springSpec 内部用秒）；位移 px；速度 px/s（swipe 的阈值 velocity 是 px/ms）。
 * `overshoot` 是比例（0.046 = 4.6%），`overshootPct` 是百分数（4.6）。
 */
(function (root) {
  'use strict';

  const VERSION = '1.0.0';
  const LINEAGE = 'otk-7f3e1c';   // 与 onetake 同源的血统号

  // ───────────────────────────── 标量 ─────────────────────────────
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  // 归一化位置：x 在 [x0, x1] 中的比例，夹在 0..1（x1 === x0 时按「已越过」处理）
  const seg = (x0, x1, x) => (x1 === x0 ? (x >= x1 ? 1 : 0) : clamp((x - x0) / (x1 - x0), 0, 1));
  const sstep = (e0, e1, x) => { if (e1 === e0) return x >= e1 ? 1 : 0; const k = clamp((x - e0) / (e1 - e0), 0, 1); return k * k * (3 - 2 * k); };
  const ssstep = (e0, e1, x) => { if (e1 === e0) return x >= e1 ? 1 : 0; const k = clamp((x - e0) / (e1 - e0), 0, 1); return k * k * k * (k * (k * 6 - 15) + 10); };

  // xorshift32 —— 确定性随机（布局抖动在 setup 里定一次，绝不在每帧路径上）
  function rng(seed = 1) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }

  // ───────────────────────────── 曲线 ─────────────────────────────
  // CSS cubic-bezier(x1, y1, x2, y2) 的数值解：先用牛顿法，退化时二分。
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = s => ((ax * s + bx) * s + cx) * s, sy = s => ((ay * s + by) * s + cy) * s, dsx = s => (3 * ax * s + 2 * bx) * s + cx;
    const solve = x => {
      let s = x;
      for (let i = 0; i < 8; i++) {
        const e = sx(s) - x; if (Math.abs(e) < 1e-7) return s;
        const d = dsx(s); if (Math.abs(d) < 1e-6) break;
        s -= e / d; if (s < 0 || s > 1) break;
      }
      let lo = 0, hi = 1; s = x;
      for (let i = 0; i < 60; i++) { const v = sx(s); if (Math.abs(v - x) < 1e-7) return s; if (x > v) lo = s; else hi = s; s = (lo + hi) / 2; }
      return s;
    };
    return u => (u <= 0 ? 0 : u >= 1 ? 1 : sy(solve(u)));
  }

  // t80 = 走完 frac（默认 80%）距离所花的时间比例。低 = 先冲后收（decelerate），~.7 = 对称 S 曲线。
  function t80(curve, frac = 0.8, steps = 4000) {
    for (let i = 0; i <= steps; i++) { const u = i / steps; if (curve(u) >= frac) return u; }
    return 1;
  }

  // 冻结缓动：值来自基准表（t80 为本机实测，不得改动）
  const CSS_EASE = {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    enter: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
    exit: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
    emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
    linear: 'linear',
  };
  const ease = {
    linear: u => u,
    standard: bezier(0.4, 0, 0.2, 1),
    enter: bezier(0.05, 0.7, 0.1, 1),
    exit: bezier(0.3, 0, 0.8, 0.15),
    emphasized: bezier(0.2, 0, 0, 1),
  };
  ease.bezier = {
    standard: [0.4, 0, 0.2, 1],
    enter: [0.05, 0.7, 0.1, 1],
    exit: [0.3, 0, 0.8, 0.15],
    emphasized: [0.2, 0, 0, 1],
  };

  // ───────────────────────────── 弹簧 ─────────────────────────────
  // 阻尼阶跃响应 0 → 1（静止起步）。zeta < 1 过冲，= 1 临界，> 1 过阻尼。
  function spring(tau, zeta = 0.85, omega = 17.95) {
    if (tau <= 0) return 0;
    if (zeta < 1) {
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * omega * tau) * (Math.cos(wd * tau) + (zeta * omega / wd) * Math.sin(wd * tau));
    }
    if (zeta === 1) return 1 - Math.exp(-omega * tau) * (1 + omega * tau);
    const q = omega * Math.sqrt(zeta * zeta - 1), r1 = -zeta * omega + q, r2 = -zeta * omega - q;
    return 1 - (r2 * Math.exp(r1 * tau) - r1 * Math.exp(r2 * tau)) / (r2 - r1);
  }

  // d/dtau spring()：每秒进度（速度），用于按速度做挤压 / 决定接管时的初速。
  function springVel(tau, zeta = 0.85, omega = 17.95) {
    if (tau <= 0) return 0;
    if (zeta < 1) { const s = Math.sqrt(1 - zeta * zeta); return (omega / s) * Math.exp(-zeta * omega * tau) * Math.sin(omega * s * tau); }
    if (zeta === 1) return omega * omega * tau * Math.exp(-omega * tau);
    const q = omega * Math.sqrt(zeta * zeta - 1), r1 = -zeta * omega + q, r2 = -zeta * omega - q;
    return omega * omega * (Math.exp(r1 * tau) - Math.exp(r2 * tau)) / (r1 - r2);
  }

  // 过冲峰值（比例）。zeta < 1 时解析解 exp(-πζ/√(1-ζ²))，基准表 4.6% ↔ 0.046。
  const overshootOf = zeta => (zeta < 1 ? Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta)) : 0);

  // 落位时间（秒）：最后一次 |1 - spring| > eps 的时刻（1 ms 扫描，与基准表同口径）
  function settle(zeta = 0.85, omega = 17.95, eps = 0.02) {
    let last = 0;
    for (let i = 1; i <= 20000; i++) { const t = i / 1000; if (Math.abs(1 - spring(t, zeta, omega)) > eps) last = t; }
    return last;
  }

  const round4 = v => v.toFixed(4);
  const linearString = samples => 'linear(' + samples.map(round4).join(',') + ')';

  // 弹簧采样函数 → CSS 原生 linear()（compositor 友好）
  function toLinear(springFn, opts = {}) {
    if (typeof springFn !== 'function') throw new Error('onemotion·toLinear：第一个参数必须是 (tau秒)=>0..1 的函数');
    const duration = opts.duration ?? 0.5;
    const steps = opts.steps ?? 32;
    const samples = [];
    for (let i = 0; i <= steps; i++) samples.push(springFn(duration * i / steps));
    return linearString(samples);
  }

  // 冻结 token 表（数字全部来自 _contract.md，不要改）
  const tokens = {
    dur: { instant: 80, fast: 140, base: 220, slow: 340, slower: 500 },
    ease: { standard: CSS_EASE.standard, enter: CSS_EASE.enter, exit: CSS_EASE.exit, emphasized: CSS_EASE.emphasized, linear: CSS_EASE.linear },
    spring: {
      snappy: { zeta: 0.85, omega: 17.95 },
      smooth: { zeta: 1.0, omega: 12.57 },
      bouncy: { zeta: 0.7, omega: 12.57 },
      drag: { zeta: 0.85, omega: 14.0 },
      sheet: { zeta: 0.9, omega: 16.0 },
      firm: { zeta: 0.6, omega: 20.0 },
    },
    move: { sm: 8, md: 16, lg: 24, xl: 40 },
    stagger: { tight: 20, base: 35, loose: 60 },
    exitRatio: 0.7,
    staggerCap: 240,
    staggerMaxItems: 8,
  };

  // 基准表里其余常量（不属于 tokens 的冻结形状，单独放这里）
  const consts = {
    scale: { in: 0.96, pop: 1.04 },
    blurDepth: 8,          // px，只给 scrim / 景深，不当运动模糊
    flashHz: 3,            // 闪烁上限
    frame: { fps60: 16.7, fps120: 8.3, p95: 20, fail: 50 },
    noStaggerAbove: 12,    // > 12 项不 stagger
  };

  // springSpec(name|{zeta,omega}, {duration, steps=32})
  // duration 默认 2π/ω（基准表给的是 ζ 与 ω；2π/12.57 → 0.4999 s 正是 bouncy 表里那串 32 步的来源）。
  // samples 长度 = steps + 1（i = 0…steps，tau = duration·i/steps，第 0 个恒为 0）。
  function springSpec(token, opts = {}) {
    let spec, name = null;
    if (typeof token === 'string') {
      name = token; spec = tokens.spring[token];
      if (!spec) throw new Error('onemotion·springSpec：未知弹簧 token「' + token + '」（可用：' + Object.keys(tokens.spring).join(' / ') + '）');
    } else {
      spec = token || {};
    }
    const zeta = spec.zeta ?? 0.85, omega = spec.omega ?? 17.95;
    const duration = opts.duration ?? spec.duration ?? (2 * Math.PI / omega);
    const steps = opts.steps ?? 32;
    const samples = [];
    for (let i = 0; i <= steps; i++) samples.push(spring(duration * i / steps, zeta, omega));
    const ov = overshootOf(zeta);
    const settleS = settle(zeta, omega, opts.eps ?? 0.02);
    return {
      name, samples, css: linearString(samples), duration, steps, zeta, omega,
      // 单位：duration / settle 是【秒】（与 W3C 弹簧参数、与 ω 的单位一致）；
      // durationMs / settleMs 是毫秒，方便直接喂给 tokens.dur.* 或 WAAPI 的 duration。
      durationMs: Math.round(duration * 1000), settleMs: Math.round(settleS * 1000),
      overshoot: ov, overshootPct: ov * 100,
      settle: settleS,
    };
  }

  // ───────────────────────── 时长 / 幅度 ─────────────────────────
  // 距离缩放：clamp(80, round(base·√(d/ref)), 500)
  function scaledDuration(distancePx, opts = {}) {
    const base = opts.base ?? tokens.dur.base, ref = opts.ref ?? 16;
    const min = opts.min ?? tokens.dur.instant, max = opts.max ?? tokens.dur.slower;
    const d = Math.max(0, Number(distancePx) || 0);
    return clamp(Math.round(base * Math.sqrt(d / ref)), min, max);
  }
  // 出入非对称：exit = 0.7 × enter，下限 80ms
  const exitDuration = enterMs => Math.max(tokens.dur.instant, Math.round(enterMs * tokens.exitRatio));

  // 名字 / 数字 → 位移 px
  function movePx(from) {
    if (typeof from === 'number') return from;
    const m = tokens.move[from];
    if (m == null) throw new Error('onemotion：未知位移 token「' + from + '」（可用：' + Object.keys(tokens.move).join(' / ') + '，或直接给数字 px）');
    return m;
  }
  // 名字 / 数字 / 'auto' → 时长 ms
  function durPx(token, dist) {
    if (typeof token === 'number') return Math.max(0, Math.round(token));
    if (token === 'auto') return scaledDuration(dist ?? tokens.move.md);
    const d = tokens.dur[token];
    if (d == null) throw new Error('onemotion：未知时长 token「' + token + '」（可用：' + Object.keys(tokens.dur).join(' / ') + ' / auto，或直接给数字 ms）');
    return d;
  }

  // ───────────────────────── 手势数学（纯） ─────────────────────────
  // 橡皮筋：越界越多、走得越少，上界 dimPx（x=1000, dim=600, k=.55 → 287）
  const rubberband = (offsetPx, dimPx, k = 0.55) => {
    const dim = Math.max(1e-6, Math.abs(dimPx));
    return offsetPx * dim * k / (dim + k * Math.abs(offsetPx));
  };

  // 惯性滑行距离（px）。decel 是「每毫秒速度乘数」，min 是收尾速度阈值（px/s）。
  // 闭式：Σ (v/1000)·decel^n = (v/1000)·(1 - decel^N)/(1 - decel)。1000 px/s → ≈ 500 px。
  function inertia(velocityPxPerSec, opts = {}) {
    const decel = clamp(opts.decel ?? 0.998, 1e-6, 0.999999);
    const min = Math.max(0, opts.min ?? 0.5);
    const v = Number(velocityPxPerSec) || 0;
    const a = Math.abs(v);
    if (a <= min || a === 0) return 0;
    const n = Math.ceil(Math.log(min / a) / Math.log(decel));   // 到阈值还要几毫秒
    const steps = Math.max(1, n);
    const dist = (a / 1000) * (1 - Math.pow(decel, steps)) / (1 - decel);
    return Math.sign(v) * dist;
  }

  // ───────────────────────── 运镜 / 连续性（纯） ─────────────────────────
  // 滚动进度 → 相机。keys = [{p, x, y, zoom, rot, ease}]，zoom 在 log 空间插值。
  // 每段用「该 key 的 ease」，缺省 ease.standard（滚动 scrub 想 1:1 跟手就显式写 ease.linear）。
  function camera(progress, keys) {
    const ks = keys || [];
    if (!ks.length) return { x: 0, y: 0, zoom: 1, rot: 0 };
    const pick = k => ({ x: k.x ?? 0, y: k.y ?? 0, zoom: k.zoom ?? 1, rot: k.rot ?? 0 });
    const p = Number(progress) || 0;
    if (p <= ks[0].p) return pick(ks[0]);
    const L = ks.length;
    if (p >= ks[L - 1].p) return pick(ks[L - 1]);
    let i = 0;
    while (i < L - 2 && ks[i + 1].p < p) i++;
    const A = pick(ks[i]), B = pick(ks[i + 1]);
    const k = (ks[i].ease || ease.standard)(seg(ks[i].p, ks[i + 1].p, p));
    return {
      x: lerp(A.x, B.x, k), y: lerp(A.y, B.y, k),
      zoom: Math.exp(lerp(Math.log(Math.max(1e-6, A.zoom)), Math.log(Math.max(1e-6, B.zoom)), k)),
      rot: lerp(A.rot, B.rot, k),
    };
  }

  // 一层在相机里的投影：depth 0 = 焦点层（全量跟随），> 0 更远（动得少），< 0 更近（动得多）。
  // 返回 CSS 'matrix(a, b, c, d, e, f)'，绕元素 transform-origin（默认中心）旋转 + 缩放 + 平移。
  function view(cam, opts = {}) {
    const depth = opts.depth ?? 0;
    const f = 1 / (1 + Math.max(-0.9, depth));
    const z = Math.exp(Math.log(Math.max(1e-6, (cam && cam.zoom) ?? 1)) * f);
    const rot = ((cam && cam.rot) ?? 0) * f, x = ((cam && cam.x) ?? 0) * f, y = ((cam && cam.y) ?? 0) * f;
    const c = Math.cos(rot) * z, s = Math.sin(rot) * z;
    const n = v => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; };
    return 'matrix(' + n(c) + ', ' + n(s) + ', ' + n(-s) + ', ' + n(c) + ', ' + n(x) + ', ' + n(y) + ')';
  }

  // 共享元素差值（transform-origin: top left）：把 after 用 transform 摆成 before 的样子
  function morphTransform(beforeRect, afterRect) {
    const b = beforeRect || {}, a = afterRect || {};
    const aw = Number(a.width) || 0, ah = Number(a.height) || 0;
    return {
      dx: (Number(b.left) || 0) - (Number(a.left) || 0),
      dy: (Number(b.top) || 0) - (Number(a.top) || 0),
      sx: aw > 0 ? (Number(b.width) || 0) / aw : 1,
      sy: ah > 0 ? (Number(b.height) || 0) / ah : 1,
    };
  }

  // ───────────────────────── DOM 环境 ─────────────────────────
  const browserWin = () => (typeof window !== 'undefined' ? window : null);
  const hasDom = () => typeof document !== 'undefined' && !!document.createElement;
  function needDom(where) {
    if (!hasDom()) {
      throw new Error('onemotion·' + where + '：需要浏览器 DOM（当前环境没有 document）。' +
        '纯数值函数（clamp/lerp/seg/sstep/ssstep/rng/bezier/t80/ease/spring/springVel/springSpec/settle/tokens/' +
        'scaledDuration/exitDuration/toLinear/rubberband/inertia/camera/view/morphTransform/staggerDelays）在 Node 里可直接调用。');
    }
    return true;
  }
  const docOf = el => (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  function winOf(el) { const d = docOf(el); return (d && d.defaultView) || browserWin(); }
  function styleOf(el) { const w = winOf(el); return w && w.getComputedStyle ? w.getComputedStyle(el) : null; }
  function requireEl(el, where) {
    if (!el || typeof el.animate !== 'function') throw new Error('onemotion·' + where + '：第一个参数必须是带 .animate() 的 Element');
    return el;
  }
  const supportsLinear = () => {
    // 必须用【属性名】探测：'easing-function' 是数据类型不是属性名，CSS.supports 对它恒返回 false
    // （本机 Chrome 实测：属性名写法 true / 数据类型写法 false），写错会让所有支持 linear() 的浏览器
    // 都被判成不支持，弹簧全部退化成 --ease-emphasized。
    try { return typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 0.5, 1)'); }
    catch (e) { return false; }
  };
  const nowMs = () => { const w = browserWin(); return (w && w.performance && w.performance.now) ? w.performance.now() : Date.now(); };

  // ───────────────────────── animate / enter / exit ─────────────────────────
  // 把 {ease|spring} 解析成 WAAPI 能吃的 easing 字符串。spring → linear()（不支持就退化为 ease-emphasized）。
  function easingFor(opts, dur) {
    const steps = opts.steps ?? 32;
    if (opts.spring != null && opts.spring !== false) {
      if (typeof opts.spring === 'function') {
        return supportsLinear() ? toLinear(opts.spring, { duration: (dur ?? tokens.dur.base) / 1000, steps }) : CSS_EASE.emphasized;
      }
      const spec = typeof opts.spring === 'string' ? tokens.spring[opts.spring] : opts.spring;
      if (!spec) throw new Error('onemotion·animate：未知弹簧 token「' + opts.spring + '」（可用：' + Object.keys(tokens.spring).join(' / ') + '）');
      const s = springSpec(spec, { duration: (dur ?? tokens.dur.base) / 1000, steps });
      return supportsLinear() ? s.css : CSS_EASE.emphasized;
    }
    const e = opts.ease ?? 'standard';
    if (typeof e === 'function') return supportsLinear() ? toLinear(e, { duration: (dur ?? tokens.dur.base) / 1000, steps }) : CSS_EASE.standard;
    if (typeof e === 'string' && CSS_EASE[e]) return CSS_EASE[e];
    return typeof e === 'string' ? e : CSS_EASE.standard;
  }

  function animate(el, keyframes, opts = {}) {
    needDom('animate');
    requireEl(el, 'animate');
    const dur = Math.max(0, opts.dur ?? tokens.dur.base);
    const o = { duration: dur, delay: Math.max(0, opts.delay ?? 0), fill: opts.fill ?? 'both', easing: easingFor(opts, dur) };
    if (opts.composite) o.composite = opts.composite;
    if (opts.iterations != null) o.iterations = opts.iterations;
    if (opts.direction) o.direction = opts.direction;
    return el.animate(keyframes, o);
  }

  // 进入：默认 translateY(--move-md) + opacity 0→1，ease-enter，dur = token 或按距离缩放
  function enter(el, opts = {}) {
    needDom('enter');
    requireEl(el, 'enter');
    const red = opts.reduce !== false && reduced();
    const axis = opts.axis ?? 'y';
    const dist = red ? 0 : movePx(opts.from ?? 'md');
    const dur = red ? 1 : durPx(opts.token ?? 'base', dist);
    const sc = (!red && opts.scale != null) ? opts.scale : 1;
    const dx = axis === 'x' ? dist : 0, dy = axis === 'y' ? dist : 0;
    const from = { opacity: 0, transform: 'translate3d(' + dx + 'px, ' + dy + 'px, 0px) scale(' + sc + ')' };
    const to = { opacity: 1, transform: 'translate3d(0px, 0px, 0px) scale(1)' };
    return animate(el, [from, to], { dur, delay: opts.delay ?? 0, fill: opts.fill ?? 'both', ease: opts.ease ?? 'enter', spring: opts.spring });
  }

  // 出场：dur = 0.7 × 进入（下限 80ms），ease-exit；默认沿进场方向继续走（向上），给 --move-sm 的小位移。
  // keepSpace=true（默认）保留布局位置；false 则在结束后 display:none。
  function exit(el, opts = {}) {
    needDom('exit');
    requireEl(el, 'exit');
    const red = opts.reduce !== false && reduced();
    const axis = opts.axis ?? 'y';
    const dist = red ? 0 : movePx(opts.to ?? 'sm');
    const enterMs = durPx(opts.token ?? 'base', dist);
    const dur = red ? 1 : exitDuration(enterMs);
    const dir = opts.dir ?? -1;
    const dx = (axis === 'x' ? dist : 0) * dir, dy = (axis === 'y' ? dist : 0) * dir;
    const sc = (!red && opts.scale != null) ? opts.scale : 1;
    const from = { opacity: 1, transform: 'translate3d(0px, 0px, 0px) scale(1)' };
    const to = { opacity: 0, transform: 'translate3d(' + dx + 'px, ' + dy + 'px, 0px) scale(' + sc + ')' };
    const a = animate(el, [from, to], { dur, delay: opts.delay ?? 0, fill: opts.fill ?? 'both', ease: opts.ease ?? 'exit', spring: opts.spring });
    if (opts.keepSpace === false && a && a.finished) {
      a.finished.then(() => { el.style.display = 'none'; }).catch(() => {});
    }
    return a;
  }

  // ───────────────────────── 错峰 ─────────────────────────
  // 纯函数：n 项的延迟表（ms）。规则（基准「stagger 总时长上限 240ms」）：
  //   · n > 12（consts.noStaggerAbove）→ 全 0，不 stagger；
  //   · 否则 delay_i = min(min(i, 8-1) · by, 240) —— 只错峰前 8 项，总延迟硬上限 240ms。
  function staggerDelays(n, opts = {}) {
    const by = opts.by ?? tokens.stagger.base;
    const cap = opts.max ?? opts.cap ?? tokens.staggerCap;
    const maxItems = opts.maxItems ?? tokens.staggerMaxItems;
    const noAbove = opts.noStaggerAbove ?? consts.noStaggerAbove;
    const count = Math.max(0, Math.floor(n) || 0);
    const out = [];
    for (let i = 0; i < count; i++) out.push(count > noAbove ? 0 : Math.min(Math.min(i, maxItems - 1) * by, cap));
    return out;
  }

  function stagger(els, opts = {}) {
    needDom('stagger');
    const list = Array.prototype.slice.call(els || []);
    const delays = staggerDelays(list.length, opts);
    const each = typeof opts.each === 'function'
      ? opts.each
      : (el, i, d) => enter(el, { delay: d, token: opts.token ?? 'base', from: opts.from ?? 'md', axis: opts.axis ?? 'y' });
    const anims = [];
    for (let i = 0; i < list.length; i++) { const a = each(list[i], i, delays[i]); if (a) anims.push(a); }
    return anims;
  }

  // 取消并保留当前值：先读 computed，再 cancel，最后把读到的值写回内联样式（不回跳）
  function cancel(animOrEl) {
    needDom('cancel');
    const isAnim = !!(animOrEl && typeof animOrEl.cancel === 'function' && animOrEl.effect);
    const el = isAnim ? (animOrEl.effect.target || null) : animOrEl;
    if (el && typeof el.getAnimations === 'function') {
      const cs = styleOf(el);
      const t = cs ? cs.transform : null, o = cs ? cs.opacity : null;
      const list = isAnim ? [animOrEl] : el.getAnimations();
      for (let i = 0; i < list.length; i++) { try { list[i].cancel(); } catch (e) { /* 已结束的动画 */ } }
      if (t && t !== 'none') el.style.transform = t;
      if (o != null && o !== '') el.style.opacity = o;
      return el;
    }
    if (isAnim) { try { animOrEl.cancel(); } catch (e) { /* noop */ } return el; }
    throw new Error('onemotion·cancel：参数必须是 Animation 或 Element');
  }

  // ───────────────────────── 存在性状态机 ─────────────────────────
  // 幂等（重复 show/hide 不叠加）；反向调用从当前 computed 值继续；隐藏动画结束后才挂 hiddenAttr。
  function presence(el, opts = {}) {
    needDom('presence');
    if (!el || typeof el.setAttribute !== 'function') throw new Error('onemotion·presence：第一个参数必须是 Element');
    const hiddenAttr = opts.hiddenAttr ?? 'hidden';
    const eo = opts.enter || {}, xo = opts.exit || {};
    const red = opts.reduced !== false;
    let state = el.hasAttribute(hiddenAttr) ? 'hidden' : 'shown';
    let cur = null, gen = 0;

    function show() {
      if (state === 'shown' || state === 'showing') return el;    // 幂等
      const my = ++gen;
      if (cur) { cancel(cur); cur = null; }                       // 反向：从当前值接管
      el.removeAttribute(hiddenAttr);
      state = 'showing';
      const a = enter(el, Object.assign({ reduce: red }, eo));
      cur = a;
      const done = () => { if (my === gen) { state = 'shown'; cur = null; } };
      if (a && a.finished) a.finished.then(done, done);           // 正常结束 / 被取消都归位（gen 守卫反向接管）
      else done();
      return el;
    }
    function hide() {
      if (state === 'hidden' || state === 'hiding') return el;    // 幂等
      const my = ++gen;
      if (cur) { cancel(cur); cur = null; }
      state = 'hiding';
      const a = exit(el, Object.assign({ reduce: red, keepSpace: true }, xo));
      cur = a;
      const done = () => { if (my === gen) { el.setAttribute(hiddenAttr, ''); state = 'hidden'; cur = null; } };
      if (a && a.finished) a.finished.then(done, done);
      else done();
      return el;
    }
    const api = {
      show, hide,
      toggle() { return (state === 'shown' || state === 'showing') ? hide() : show(); },
      destroy() { gen++; if (cur) { cancel(cur); cur = null; } },
    };
    Object.defineProperty(api, 'state', { get() { return state; }, enumerable: true });
    return api;
  }

  // ───────────────────────── 手势 ─────────────────────────
  // 拖动：pointerdown 起立刻跟手（transform，不碰 layout），越界走橡皮筋，松手按速度用 --spring-drag 落位。
  // bounds = [min, max]（px）或 (state) => [min, max]；**默认不设边界**（基准写的是 bounds=[0,1]，
  // 那在实战里等于「几乎不可拖动」，所以这里默认自由拖动，需要约束时务必显式传真实 px 区间）。
  // 新 pointerdown 会立刻取消上一条落位动画并从当前值接管；返回 {state, cancel(), destroy()}。
  function drag(el, opts = {}) {
    needDom('drag');
    if (!el || typeof el.addEventListener !== 'function') throw new Error('onemotion·drag：第一个参数必须是 Element');
    const axis = opts.axis ?? 'y';
    const rubber = opts.rubber ?? 0.55;
    const decel = opts.decel ?? 0.998, minV = opts.min ?? 0.5;
    const state = { active: false, offset: 0, velocity: 0, start: 0 };
    let cur = null, pid = null, anchor = 0, base = 0, samples = [];

    const isOff = () => (typeof opts.disabled === 'function' ? !!opts.disabled() : !!opts.disabled);
    const tf = off => (axis === 'x' ? 'translate3d(' + off + 'px, 0, 0)' : 'translate3d(0, ' + off + 'px, 0)');
    const dim = () => {
      if (typeof opts.dim === 'number') return opts.dim;
      const r = axis === 'x' ? (el.offsetWidth || 0) : (el.offsetHeight || 0);
      return r || 600;
    };
    const bounds = () => {
      const b = typeof opts.bounds === 'function' ? opts.bounds(state) : opts.bounds;
      if (!b) return null;
      return [Math.min(b[0], b[1]), Math.max(b[0], b[1])];
    };
    // 越界部分走橡皮筋：x·dim·k/(dim + k|x|)，单调、有上界（dim）
    function resisted(off) {
      const b = bounds(); if (!b) return off;
      if (off < b[0]) return b[0] - rubberband(b[0] - off, dim(), rubber);
      if (off > b[1]) return b[1] + rubberband(off - b[1], dim(), rubber);
      return off;
    }
    function render() {
      if (typeof opts.render === 'function') opts.render(state.offset, state);
      else el.style.transform = tf(state.offset);
    }
    function velocity() {
      const n = samples.length;
      if (n < 2) return 0;
      const last = samples[n - 1];
      let i = n - 1;
      while (i > 0 && last.t - samples[i - 1].t < 100) i--;     // ~100ms 窗口
      const first = samples[i], dt = (last.t - first.t) / 1000;
      return dt > 0 ? (last.p - first.p) / dt : 0;
    }
    function onDown(e) {
      if (isOff()) return;
      if (e.pointerType === 'mouse' && e.button != null && e.button !== 0) return;
      if (cur) { cancel(cur); cur = null; }                     // 新 pointerdown 立即接管，取消上一条落位动画
      pid = e.pointerId ?? null;
      state.active = true;
      state.velocity = 0;
      anchor = axis === 'x' ? e.clientX : e.clientY;
      base = state.offset;
      state.start = base;
      samples = [{ t: nowMs(), p: anchor }];
      try { if (pid != null && el.setPointerCapture) el.setPointerCapture(pid); } catch (err) { /* 某些元素不支持 */ }
      el.style.willChange = 'transform';
      if (opts.onStart) opts.onStart(state, e);
    }
    function onMove(e) {
      if (!state.active || (pid != null && e.pointerId !== pid)) return;
      const p = axis === 'x' ? e.clientX : e.clientY;
      state.offset = resisted(base + (p - anchor));
      samples.push({ t: nowMs(), p });
      if (samples.length > 8) samples.shift();
      state.velocity = velocity();
      render();
      if (opts.onMove) opts.onMove(state, e);
    }
    function onUp(e) {
      if (!state.active) return;
      if (e && pid != null && e.pointerId != null && e.pointerId !== pid) return;
      state.active = false;
      try { if (pid != null && el.releasePointerCapture) el.releasePointerCapture(pid); } catch (err) { /* noop */ }
      const v = velocity();
      state.velocity = v;
      const b = bounds();
      let target = state.offset + inertia(v, { decel, min: minV });
      if (b) target = clamp(target, b[0], b[1]);
      const from = state.offset;
      state.offset = target;
      if (Math.abs(target - from) > 0.5) {
        const dur = opts.dur ?? Math.round(springSpec(opts.spring ?? 'drag').duration * 1000);
        const a = animate(el, [{ transform: tf(from) }, { transform: tf(target) }], { dur, spring: opts.spring ?? 'drag', fill: 'both' });
        cur = a;
        const mine = a;
        if (a.finished) a.finished.then(() => { if (cur === mine) { cur = null; el.style.transform = tf(target); el.style.willChange = ''; } }).catch(() => {});
      } else {
        el.style.transform = tf(target);
        el.style.willChange = '';
      }
      if (opts.onEnd) opts.onEnd(v, state);
    }
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return {
      state,
      cancel() { if (cur) { cancel(cur); cur = null; } },
      destroy() {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        if (cur) { cancel(cur); cur = null; }
        el.style.willChange = '';
      },
    };
  }

  // 滑动判定：位移过 threshold 或速度过 velocity（px/ms）即 commit，方向取符号
  function swipe(el, opts = {}) {
    needDom('swipe');
    if (!el || typeof el.addEventListener !== 'function') throw new Error('onemotion·swipe：第一个参数必须是 Element');
    const axis = opts.axis ?? 'x';
    const threshold = opts.threshold ?? 64;
    const velTh = opts.velocity ?? 0.35;            // px/ms
    let pid = null, anchor = 0, t0 = 0, tracking = false;
    const pos = e => (axis === 'x' ? e.clientX : e.clientY);
    function down(e) {
      if (opts.disabled && (typeof opts.disabled === 'function' ? opts.disabled() : opts.disabled)) return;
      pid = e.pointerId ?? null; tracking = true; anchor = pos(e); t0 = nowMs();
      try { if (pid != null && el.setPointerCapture) el.setPointerCapture(pid); } catch (err) { /* noop */ }
    }
    function up(e) {
      if (!tracking) return;
      tracking = false;
      const d = pos(e) - anchor;
      const dt = Math.max(1, nowMs() - t0);
      const v = d / dt;                              // px/ms
      const hit = Math.abs(d) >= threshold || Math.abs(v) >= velTh;
      const dir = Math.sign(Math.abs(v) >= velTh ? v : d) || 0;
      if (hit) { if (opts.onCommit) opts.onCommit(dir, { delta: d, velocity: v }); }
      else if (opts.onCancel) opts.onCancel({ delta: d, velocity: v });
      pid = null;
    }
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return {
      destroy() {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      },
    };
  }

  // ───────────────────────── 滚动 ─────────────────────────
  // 全局唯一的 rAF 节流器：只绑一组 scroll/resize，订阅者全部在下一帧里跑（避免每元素一个 listener）
  const scrollSubs = new Set();
  let scrollBound = false, scrollPending = false;
  function scrollTick() {
    scrollPending = false;
    scrollSubs.forEach(f => { try { f(); } catch (e) { /* 单个订阅出错不影响其它 */ } });
  }
  function scrollKick() {
    if (scrollPending || !scrollSubs.size) return;
    const w = browserWin();
    if (!w || !w.requestAnimationFrame) { scrollTick(); return; }
    scrollPending = true;
    w.requestAnimationFrame(scrollTick);
  }
  function bindScroll() {
    const w = browserWin();
    if (scrollBound || !w) return;
    w.addEventListener('scroll', scrollKick, { passive: true });
    w.addEventListener('resize', scrollKick, { passive: true });
    scrollBound = true;
  }
  function unbindScroll() {
    const w = browserWin();
    if (!scrollBound || !w) return;
    w.removeEventListener('scroll', scrollKick);
    w.removeEventListener('resize', scrollKick);
    scrollBound = false;
  }
  function onScrollFrame(fn) {
    needDom('onScrollFrame');
    if (typeof fn !== 'function') throw new Error('onemotion·onScrollFrame：需要回调函数');
    scrollSubs.add(fn);
    bindScroll();
    fn();                                            // 立刻给一次初值
    return () => { scrollSubs.delete(fn); if (!scrollSubs.size) unbindScroll(); };
  }

  // 'top bottom' → {e:'top', v:'bottom'}（元素边 · 视口边）
  function parseAnchor(s) {
    const p = String(s ?? '').trim().split(/\s+/);
    const edge = ['top', 'bottom', 'center'], view = ['top', 'bottom', 'center'];
    const e = edge.indexOf(p[0]) >= 0 ? p[0] : 'top';
    const v = view.indexOf(p[1]) >= 0 ? p[1] : 'bottom';
    return { e, v };
  }
  function anchorScroll(rect, docTop, vp, a) {
    const eh = a.e === 'top' ? docTop : a.e === 'bottom' ? docTop + rect.height : docTop + rect.height / 2;
    const vo = a.v === 'top' ? 0 : a.v === 'bottom' ? vp : vp / 2;
    return eh - vo;                                  // 该对齐发生时的 scrollY
  }
  function scrollProgress(el, opts = {}) {
    needDom('scrollProgress');
    if (!el || typeof el.getBoundingClientRect !== 'function') throw new Error('onemotion·scrollProgress：第一个参数必须是 Element');
    const start = parseAnchor(opts.start ?? 'top bottom');
    const end = parseAnchor(opts.end ?? 'bottom top');
    const cache = { p: 0 };
    function update() {
      const w = winOf(el);
      if (!w) return cache.p;
      const rect = el.getBoundingClientRect();
      const vp = w.innerHeight || 0;
      const y = w.scrollY ?? w.pageYOffset ?? 0;
      const s0 = anchorScroll(rect, rect.top + y, vp, start);
      const s1 = anchorScroll(rect, rect.top + y, vp, end);
      cache.p = s1 === s0 ? (y >= s1 ? 1 : 0) : clamp((y - s0) / (s1 - s0), 0, 1);
      return cache.p;
    }
    const un = onScrollFrame(update);                // 内部只读 rAF + 缓存
    const fn = () => cache.p;                        // 返回的读取函数：零成本读缓存
    fn.update = update;
    fn.destroy = un;
    fn.progress = () => cache.p;
    return fn;
  }

  // 视差：progress 可以是 0..1 的数字（每帧自己调 update）或返回 0..1 的函数（自动订阅滚动）
  function parallax(el, opts = {}) {
    needDom('parallax');
    if (!el || !el.style) throw new Error('onemotion·parallax：第一个参数必须是 Element');
    const depth = opts.depth ?? 0.15;
    const red = opts.reduce !== false && reduced();
    const ctl = { p: 0 };
    let un = null;
    function update() {
      const p = clamp(typeof opts.progress === 'function' ? opts.progress() : (opts.progress ?? ctl.p), 0, 1);
      ctl.p = p;
      if (red) return p;
      const w = winOf(el);
      const span = opts.span ?? ((w && w.innerHeight) || 800);
      const y = -(p - 0.5) * depth * span;
      el.style.transform = 'translate3d(0, ' + (Math.round(y * 100) / 100) + 'px, 0)';
      return p;
    }
    if (typeof opts.progress === 'function') un = onScrollFrame(update);
    else update();
    return { update, destroy() { if (un) { un(); un = null; } } };
  }

  // ───────────────────────── 衔接（FLIP） ─────────────────────────
  function invertFrames(first, last) {
    const d = morphTransform(first, last);
    return {
      from: 'translate3d(' + d.dx + 'px, ' + d.dy + 'px, 0) scale(' + d.sx + ', ' + d.sy + ')',
      to: 'translate3d(0, 0, 0) scale(1, 1)',
      d,
    };
  }
  function playInvert(el, first, last, opts) {
    const f = invertFrames(first, last);
    if (opts.origin !== false) el.style.transformOrigin = opts.origin || 'top left';
    return animate(el, [{ transform: f.from }, { transform: f.to }], {
      dur: opts.dur ?? tokens.dur.slow, delay: opts.delay ?? 0, fill: 'both',
      ease: opts.ease ?? 'standard', spring: opts.spring,
    });
  }
  function settleAnim(a) { try { cancel(a); } catch (e) { /* noop */ } }

  // First-Last-Invert-Play：先量 before，mutate()（可返回 Promise，会等它），再量 after，用 transform 归位
  function flip(el, mutate, opts = {}) {
    needDom('flip');
    if (!el || typeof el.getBoundingClientRect !== 'function') throw new Error('onemotion·flip：第一个参数必须是 Element');
    const first = el.getBoundingClientRect();
    let m;
    try { m = mutate ? mutate() : null; } catch (e) { return Promise.reject(e); }
    return Promise.resolve(m).then(() => {
      const last = el.getBoundingClientRect();
      const a = playInvert(el, first, last, opts);
      return a.finished.then(() => { settleAnim(a); return [a]; });
    });
  }

  function flipMany(els, mutate, opts = {}) {
    needDom('flipMany');
    const list = Array.prototype.slice.call(els || []);
    const firsts = list.map(el => el.getBoundingClientRect());
    let m;
    try { m = mutate ? mutate() : null; } catch (e) { return Promise.reject(e); }
    return Promise.resolve(m).then(() => {
      const delays = staggerDelays(list.length, { by: opts.stagger ?? opts.by ?? tokens.stagger.base, max: opts.max, maxItems: opts.maxItems });
      const anims = list.map((el, i) => playInvert(el, firsts[i], el.getBoundingClientRect(), Object.assign({}, opts, { delay: (opts.delay ?? 0) + delays[i] })));
      return Promise.all(anims.map(a => a.finished.catch(() => {}))).then(() => { anims.forEach(settleAnim); return anims; });
    });
  }

  // 共享元素：从 fromRect 的位置/尺寸播到它「现在」的位置/尺寸，返回 Animation
  function shared(el, fromRect, opts = {}) {
    needDom('shared');
    if (!el || typeof el.getBoundingClientRect !== 'function') throw new Error('onemotion·shared：第一个参数必须是 Element');
    return playInvert(el, fromRect, el.getBoundingClientRect(), opts);
  }

  // ───────────────────────── 无障碍 ─────────────────────────
  const mq = () => {
    const w = browserWin();
    return (w && typeof w.matchMedia === 'function') ? w.matchMedia('(prefers-reduced-motion: reduce)') : null;
  };
  // Node / 无 matchMedia 环境返回 false（不抛错：probe 不该打断调用方）
  function reduced() { const m = mq(); return !!(m && m.matches); }
  function onReducedChange(fn) {
    if (typeof fn !== 'function') throw new Error('onemotion·onReducedChange：需要回调函数');
    const m = mq();
    if (!m) return () => {};
    const h = e => fn(!!(e && e.matches != null ? e.matches : reduced()));
    if (m.addEventListener) m.addEventListener('change', h);
    else if (m.addListener) m.addListener(h);        // 老 Safari
    return () => {
      if (m.removeEventListener) m.removeEventListener('change', h);
      else if (m.removeListener) m.removeListener(h);
    };
  }

  // ───────────────────────── 自检 ─────────────────────────
  function __selftest() {
    const checks = [];
    const ck = (name, got, want, tol) => {
      const pass = (typeof want === 'number' && typeof got === 'number' && tol != null)
        ? Math.abs(got - want) <= tol
        : JSON.stringify(got) === JSON.stringify(want);
      checks.push({ name, pass, got, want });
    };
    // 标量
    ck('clamp(1.4,-1,1)', clamp(1.4, -1, 1), 1);
    ck('lerp(0,10,.25)', lerp(0, 10, 0.25), 2.5);
    ck('seg(0,10,5)', seg(0, 10, 5), 0.5);
    ck('sstep(0,1,.5)', sstep(0, 1, 0.5), 0.5);
    ck('ssstep(0,1,.5)', ssstep(0, 1, 0.5), 0.5);
    const r = rng(7); const a1 = r(), a2 = rng(7)();
    ck('rng(seed) 确定性', a1 === a2 && a1 >= 0 && a1 < 1, true);
    // 曲线 t80（基准实测值）
    ck('t80(standard)', t80(ease.standard), 0.520, 0.005);
    ck('t80(enter)', t80(ease.enter), 0.215, 0.005);
    ck('t80(exit)', t80(ease.exit), 0.944, 0.005);
    ck('t80(emphasized)', t80(ease.emphasized), 0.398, 0.005);
    ck('t80(linear)', t80(ease.linear), 0.8, 0.005);
    // 弹簧
    ck('spring(0)=0', spring(0), 0);
    ck('springVel(0)=0', springVel(0), 0);
    ck('bouncy 过冲 4.6%', springSpec('bouncy').overshootPct, 4.6, 0.06);
    ck('firm 过冲 9.5%', springSpec('firm').overshootPct, 9.5, 0.06);
    ck('smooth 不过冲', springSpec('smooth').overshootPct, 0, 0.05);
    ck('bouncy settle .476s', springSpec('bouncy').settle, 0.476, 0.005);
    ck('smooth settle .464s', springSpec('smooth').settle, 0.464, 0.005);
    ck('snappy settle .233s', springSpec('snappy').settle, 0.233, 0.005);
    // springSpec 形状
    const sp = springSpec('bouncy');
    ck('springSpec samples = steps+1', sp.samples.length, 33);
    ck('springSpec 首值 0', sp.samples[0], 0);
    ck('springSpec 末值 ≈1', Math.abs(sp.samples[32] - 1.0145) <= 0.001, true);
    ck('springSpec css 前缀', sp.css.slice(0, 7), 'linear(');
    ck('toLinear === springSpec.css', toLinear(t => spring(t, 0.7, 12.57), { duration: sp.duration }), sp.css);
    ck('toLinear 首尾', toLinear(t => spring(t, 0.85, 17.95), { duration: 0.35, steps: 32 }).replace(/^linear\(|\)$/g, '').split(',')[0].trim(), '0.0000');
    // tokens
    ck('tokens.dur', tokens.dur, { instant: 80, fast: 140, base: 220, slow: 340, slower: 500 });
    ck('tokens.move', tokens.move, { sm: 8, md: 16, lg: 24, xl: 40 });
    ck('tokens.stagger', tokens.stagger, { tight: 20, base: 35, loose: 60 });
    ck('tokens.exitRatio', tokens.exitRatio, 0.7);
    ck('tokens.staggerCap', tokens.staggerCap, 240);
    ck('tokens.staggerMaxItems', tokens.staggerMaxItems, 8);
    ck('tokens.spring.snappy', tokens.spring.snappy, { zeta: 0.85, omega: 17.95 });
    ck('tokens.spring.firm', tokens.spring.firm, { zeta: 0.6, omega: 20 });
    // 时长缩放（基准实测 8 点）
    const sd = [[2, 80], [4, 110], [8, 156], [16, 220], [24, 269], [40, 348], [64, 440], [96, 500], [400, 500]];
    ck('scaledDuration 实测 8 点', sd.every(([d, ms]) => scaledDuration(d) === ms), true);
    ck('exitDuration(220)', exitDuration(220), 154);
    ck('exitDuration 下限 80', exitDuration(20), 80);
    // 手势数学
    ck('rubberband(1000,600)≈287', rubberband(1000, 600), 287, 0.5);
    ck('rubberband 有上界', rubberband(1e9, 600) < 600, true);
    ck('rubberband 奇对称', rubberband(-1000, 600), -rubberband(1000, 600));
    ck('inertia 方向保留', inertia(-1000) < 0 && inertia(1000) > 0, true);
    ck('inertia(1000)≈500px', inertia(1000), 500, 1);
    ck('inertia 阈值以下为 0', inertia(0.2), 0);
    // 错峰
    const d12 = staggerDelays(12, { by: 35 });
    ck('stagger 上限 240', Math.max.apply(null, d12) <= 240, true);
    ck('stagger 8 项截断', d12[7] === d12[8] && d12[8] === 240, true);
    ck('stagger >12 项不 stagger', staggerDelays(13, { by: 35 }).every(d => d === 0), true);
    ck('stagger 3 项 0/35/70', staggerDelays(3, { by: 35 }), [0, 35, 70]);
    // 连续性 / 运镜
    const mt = morphTransform({ left: 100, top: 50, width: 200, height: 100 }, { left: 300, top: 150, width: 400, height: 200 });
    ck('morphTransform', mt, { dx: -200, dy: -100, sx: 0.5, sy: 0.5 });
    ck('camera 中点 zoom log 插值（linear 键）', camera(0.5, [{ p: 0, zoom: 1, ease: ease.linear }, { p: 1, zoom: 4 }]).zoom, 2, 1e-9);
    ck('camera 默认 ease = standard', camera(0.5, [{ p: 0, x: 0 }, { p: 1, x: 100 }]).x, 100 * ease.standard(0.5), 1e-9);
    ck('camera 越界夹到端点', camera(2, [{ p: 0, x: 5 }, { p: 1, x: 9 }]).x, 9);
    ck('view 返回 matrix', /^matrix\(/.test(view(camera(0, [{ p: 0 }]), { depth: 0.4 })), true);
    ck('view depth 0 = 全量', view({ x: 10, y: -4, zoom: 1, rot: 0 }, { depth: 0 }), 'matrix(1, 0, 0, 1, 10, -4)');
    // Node 下 DOM 函数必须抛清晰错误
    if (!hasDom()) {
      const names = ['animate', 'enter', 'exit', 'stagger', 'cancel', 'presence', 'drag', 'swipe', 'scrollProgress', 'onScrollFrame', 'parallax', 'flip', 'flipMany', 'shared'];
      let threw = 0;
      names.forEach(n => { try { MO[n](null, null, {}); } catch (e) { if (/需要浏览器 DOM/.test(e.message)) threw++; } });
      ck('Node 下 ' + names.length + ' 个 DOM 函数抛「需要浏览器 DOM」', threw, names.length);
      ck('Node 下 reduced() = false', reduced(), false);
    }
    return { ok: checks.every(c => c.pass), checks, version: VERSION, lineage: LINEAGE };
  }

  const MO = {
    version: VERSION, lineage: LINEAGE,
    // 标量 / 曲线
    clamp, lerp, seg, sstep, ssstep, rng, bezier, t80, ease,
    // 弹簧
    spring, springVel, springSpec, settle, toLinear,
    // token / 时长
    tokens, consts, scaledDuration, exitDuration, movePx, durPx,
    // 手势数学（纯）
    rubberband, inertia,
    // 运镜 / 连续性（纯）
    camera, view, morphTransform, staggerDelays,
    // CSS / WAAPI
    animate, enter, exit, stagger, cancel,
    // 存在性
    presence,
    // 手势
    drag, swipe,
    // 滚动
    scrollProgress, onScrollFrame, parallax,
    // 衔接
    flip, flipMany, shared,
    // 无障碍 / 自检
    reduced, onReducedChange, __selftest,
  };

  root.MO = MO;
  if (typeof module === 'object' && module.exports) module.exports = MO;
})(typeof window !== 'undefined' ? window : globalThis);
