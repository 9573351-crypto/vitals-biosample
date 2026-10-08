#!/usr/bin/env node
/* updater.js 行为测试：用最小 DOM 桩驱动真实脚本，验证侧边栏入口、状态机与原生桥调用参数。
   运行：node vitals-android/tools/updater.test.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'app', 'src', 'main', 'assets', 'web', 'updater.js'), 'utf8');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; console.log('PASS ' + name); return; }
  failures.push(name + (detail ? ' — ' + detail : ''));
  console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

/* ==================== 最小 DOM 桩 ==================== */
function parseAttrs(text) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(text)) !== null) if (m[1] !== '') attrs[m[1]] = m[2] === undefined ? '' : m[2];
  return attrs;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, on) => { if (on === undefined) on = !this.classList._s.has(c); on ? this.classList._s.add(c) : this.classList._s.delete(c); return on; }
    };
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this._text = '';
    this._html = '';
  }
  set className(value) { this._class = String(value); this.classList._s = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return this._class || ''; }
  set textContent(value) { this._text = String(value); if (value === '') this.children = []; }
  get textContent() { return this._text; }
  set innerHTML(markup) { this._html = String(markup); this._text = String(markup).replace(/<[^>]*>/g, ''); parseInto(this, String(markup)); }
  get innerHTML() { return this._html; }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node, ref) {
    node.parentNode = this;
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  click() { (this.listeners.click || []).forEach((fn) => fn({ target: this, preventDefault() { }, stopPropagation() { } })); }
  querySelector(sel) { return this._lookup(sel); }
  querySelectorAll(sel) { return this._lookup(sel, true); }
  _walk(out) { for (const child of this.children) { out.push(child); child._walk(out); } return out; }
  _lookup(sel, all) {
    const found = this._walk([]).filter((node) => {
      if (sel.startsWith('#')) return node.id === sel.slice(1);
      if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
      return node.tagName === sel.toLowerCase();
    });
    return all ? found : (found[0] || null);
  }
}

function parseInto(parent, markup) {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  const stack = [parent];
  let last = 0;
  let m;
  while ((m = tagRe.exec(markup)) !== null) {
    const text = markup.slice(last, m.index).trim();
    if (text && stack.length) stack[stack.length - 1]._text += text;
    last = tagRe.lastIndex;
    if (m[1] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const node = new El(m[2]);
    const attrs = parseAttrs(m[3]);
    Object.keys(attrs).forEach((key) => {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'id') node.id = attrs[key];
      else node.attributes[key] = attrs[key];
    });
    stack[stack.length - 1].appendChild(node);
    if (!m[4] && !['input', 'br', 'meta', 'link', 'img', 'hr'].includes(node.tagName)) stack.push(node);
  }
}

function makeEnv(options) {
  const opts = options || {};
  const body = new El('body');
  const ids = {};
  const add = (id, tag) => { const node = new El(tag || 'div'); node.id = id; body.appendChild(node); ids[id] = node; return node; };

  const sidebarFoot = add('sidebarFoot', 'div'); sidebarFoot.className = 'sidebar-foot';
  const updateGroupShell = new El('div'); updateGroupShell.className = 'migrate-group';
  const buildTag = new El('div'); buildTag.id = 'buildTag'; buildTag.className = 'build-tag';
  if (opts.buildTag) buildTag.textContent = opts.buildTag;
  sidebarFoot.appendChild(updateGroupShell);
  sidebarFoot.appendChild(buildTag);
  ids.buildTag = buildTag;

  // 可选：模拟 scripts 查询串里的构建版本（原生桥不可用时的回退来源）
  if (opts.scriptSrc) {
    const script = new El('script');
    script.attributes.src = opts.scriptSrc;
    body.appendChild(script);
  }

  const viewSettings = add('view-settings', 'section'); viewSettings.className = 'view';
  const toastBox = { messages: [] };

  const calls = [];
  const listeners = {};
  const host = {
    // opts.version = undefined → 桥不支持 getAppVersion；null → 返回空串；字符串 → 原样返回
    getAppVersion: opts.version === undefined
      ? () => JSON.stringify({ version: '1.10.0', versionCode: 20 })
      : () => (opts.version === null ? '' : JSON.stringify({ version: opts.version, versionCode: 31 })),
    checkUpdate: () => calls.push(['checkUpdate']),
    downloadUpdate: (tag, size, sha) => calls.push(['downloadUpdate', tag, size, sha]),
    installUpdate: () => calls.push(['installUpdate'])
  };

  const document = {
    readyState: 'complete',
    body,
    listeners: {},
    getElementById: (id) => ids[id] || body._lookup('#' + id),
    createElement: (tag) => new El(tag),
    querySelector: (sel) => body._lookup(sel),
    querySelectorAll: (sel) => body._lookup(sel, true),
    addEventListener: (type, fn) => { (document.listeners[type] = document.listeners[type] || []).push(fn); }
  };

  const sandbox = {
    document,
    window: null,
    location: { href: '' },
    fetch: () => Promise.reject(new Error('测试中不应走 fetch 回退')),
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => { },
    console,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Error,
    Date
  };
  // 可选：模拟页面自报版本（web-preview / 桌面端注入的 window.__VITALS）
  if (opts.vitalsVersion) sandbox.__VITALS = { version: opts.vitalsVersion, build: 0 };
  sandbox.window = sandbox;
  sandbox.AndroidHost = host;
  sandbox.toast = (text) => toastBox.messages.push(text);
  sandbox.open = (url) => { toastBox.opened = url; };
  sandbox.parent = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'updater.js' });
  (document.listeners.DOMContentLoaded || []).forEach((fn) => fn({}));
  return { sandbox, ids, body, calls, toastBox, host, updateGroupShell };
}

const find = (root, id) => root.body._lookup('#' + id);
const emit = (sandbox, payload) => sandbox.onVitalsUpdateEvent(typeof payload === 'string' ? payload : JSON.stringify(payload));

/* ==================== 用例 ==================== */
{
  const env = makeEnv();
  ok('入口按钮已注入侧边栏底部', !!find(env, 'updateBtn'));
  ok('设置页卡片已注入', !!find(env, 'updateCard') && !!find(env, 'updateCheckBtn'));
  eq('Android 环境启动即自动查询一次', env.calls.filter((c) => c[0] === 'checkUpdate').length, 1);
  eq('自动查询期间处于查询态', find(env, 'updatePill').textContent, '查询中');
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: false, latestVersion: '1.10.0' });
  eq('查询结束后显示当前版本', find(env, 'updateLine').textContent, '当前已是最新版本（1.10.0）');
  eq('查询结束后状态归位', find(env, 'updatePill').textContent, '已是最新');
}

{
  const env = makeEnv();
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: true, latestVersion: '1.10.1', tag: 'v1.10.1', apkName: 'Vitals-Android-1.10.1.apk', apkSize: 1540000, sha256: 'abc', hasApk: true });
  eq('发现新版本 → pill', find(env, 'updatePill').textContent, '有新版本');
  eq('发现新版本 → 侧栏文案', find(env, 'updateLine').textContent, '发现新版本 1.10.1，当前 1.10.0');
  eq('发现新版本 → 按钮文案', find(env, 'updateBtn').textContent, '一键更新');
  ok('自动弹出确认对话框', env.body._lookup('#updateDialogMask').classList.contains('open'));
  const title = find(env, 'updateDialogTitle').textContent;
  const meta = find(env, 'updateDialogMeta').textContent;
  ok('对话框标题带目标版本', title.includes('1.10.1'), title);
  ok('对话框展示当前版本与包体积', meta.includes('当前版本 1.10.0') && meta.includes('1.5 MB'), meta);
  ok('对话框展示更新说明', find(env, 'updateDialogNotes').textContent.length > 0);
}

{
  const env = makeEnv();
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: true, latestVersion: '1.10.1', tag: 'v1.10.1', apkSize: 100, hasApk: true });
  find(env, 'updateDialogOk').click();
  eq('确认后只向原生传 tag（不传 URL）', env.calls[env.calls.length - 1], ['downloadUpdate', 'v1.10.1', 100, '']);
  eq('进入下载态', find(env, 'updatePill').textContent, '下载中');
  ok('对话框已关闭', !env.body._lookup('#updateDialogMask').classList.contains('open'));
}

{
  const env = makeEnv();
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: true, latestVersion: '1.10.1', tag: 'v1.10.1', apkSize: 2000, hasApk: true });
  emit(env.sandbox, { status: 'progress', percent: 42, percentText: '42%', downloaded: 840, total: 2000 });
  eq('进度条宽度', find(env, 'updateBar').style.width, '42%');
  eq('进度文本', find(env, 'updatePercent').textContent, '42%');
  ok('进度区可见', find(env, 'updateProgress').hidden === false);
  emit(env.sandbox, { status: 'progress', percent: 42, percentText: '1.2 MB', downloaded: 1200000, total: -1 });
  eq('总长未知时展示已下载体积', find(env, 'updatePercent').textContent, '1.2 MB');
}

{
  const env = makeEnv();
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: true, latestVersion: '1.10.1', tag: 'v1.10.1', apkSize: 2000, hasApk: true });
  emit(env.sandbox, { status: 'downloaded', sizeText: '1.5 MB' });
  eq('下载完成状态', find(env, 'updatePill').textContent, '待安装');
  eq('按钮切到立即安装', find(env, 'updateInstallBtn').textContent, '立即安装');
  find(env, 'updateInstallBtn').click();
  eq('点击安装调用原生 installUpdate', env.calls.filter((c) => c[0] === 'installUpdate').length, 1);
}

{
  const env = makeEnv();
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: false, latestVersion: '1.10.0' });
  eq('已是最新文案', find(env, 'updateLine').textContent, '当前已是最新版本（1.10.0）');
  ok('无更新时不弹对话框', !env.body._lookup('#updateDialogMask'));
}

{
  const env = makeEnv();
  emit(env.sandbox, { status: 'error', message: 'GitHub API 访问受限' });
  eq('错误态文案', find(env, 'updateLine').textContent, 'GitHub API 访问受限');
  ok('错误态标红', find(env, 'updateLine').classList.contains('bad'));
  ok('错误也会 toast', env.toastBox.messages.some((m) => m.includes('GitHub API 访问受限')));
}

{
  const env = makeEnv();
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: true, latestVersion: '1.10.1', tag: 'v1.10.1', apkSize: 2000, hasApk: true });
  emit(env.sandbox, { status: 'permissionRequired', message: '请在系统中允许本应用安装未知应用' });
  eq('权限引导后回到可更新态', find(env, 'updatePill').textContent, '有新版本');
  ok('权限提示已 toast', env.toastBox.messages.some((m) => m.includes('安装未知应用')));
}

{
  const env = makeEnv();
  emit(env.sandbox, { status: 'busy' });
  ok('并发保护提示', env.toastBox.messages.some((m) => m.includes('正在进行')));
}

{
  const env = makeEnv();
  const before = find(env, 'updatePill').textContent;
  emit(env.sandbox, '不是 JSON');
  eq('坏事件不破坏状态', find(env, 'updatePill').textContent, before);
}

{
  const env = makeEnv();
  find(env, 'updateCheckBtn').click();
  eq('手动检查调用原生 checkUpdate', env.calls[0], ['checkUpdate']);
  eq('进入查询态', find(env, 'updatePill').textContent, '查询中');
}

/* ==================== 回归：当前版本解析失败时必须仍能正常检测 ==================== */
/* 症状：同步桥取不到版本 → 当前版本为空 → 界面显示「未知」，且比较退化为“无更新”。 */

{
  // 桥不支持 getAppVersion，但 checking/checked 事件带回原生版本
  const env = makeEnv({ version: undefined });
  emit(env.sandbox, { status: 'checking', version: '1.19.0', versionCode: 31 });
  eq('事件带回版本：查询中即显示当前版本', find(env, 'updateLine').textContent, '正在查询最新版本…');
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: false, latestVersion: '1.19.0', currentVersion: '1.19.0', tag: 'v1.19.0' });
  eq('同步桥缺失时不显示未知', find(env, 'updateLine').textContent, '当前已是最新版本（1.19.0）');
  eq('设置卡当前版本列已填充', find(env, 'updateCurrent').textContent, '1.19.0');
}

{
  // 事件带回 1.18.2、仓库最新 1.19.0 → 必须判定为有新版本
  const env = makeEnv({ version: undefined });
  emit(env.sandbox, { status: 'checking', version: '1.18.2', versionCode: 30 });
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: true, latestVersion: '1.19.0', currentVersion: '1.18.2', tag: 'v1.19.0', apkSize: 1547599, hasApk: true });
  eq('检测到新版本', find(env, 'updatePill').textContent, '有新版本');
  eq('文案给出当前与最新版本', find(env, 'updateLine').textContent, '发现新版本 1.19.0，当前 1.18.2');
  eq('设置卡最新版本列已填充', find(env, 'updateLatest').textContent, '1.19.0');
}

{
  // 桥返回空串，构建标记里带版本（「Android 1.19.0 · …」）
  const env = makeEnv({ version: null, buildTag: 'Android 1.19.0 · 人工出库免扫码' });
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: false, latestVersion: '1.19.0' });
  eq('构建标记回退生效', find(env, 'updateLine').textContent, '当前已是最新版本（1.19.0）');
}

{
  // 桥返回空串、构建标记无版本，则回退到页面自报的 __VITALS.version
  const env = makeEnv({ version: null, vitalsVersion: 'v1.19.0-preview-20261008a' });
  emit(env.sandbox, { status: 'checked', ok: true, hasUpdate: false, latestVersion: '1.19.0' });
  eq('__VITALS.version 回退生效', find(env, 'updateLine').textContent, '当前已是最新版本（1.19.0-preview）');
}

{
  // 签名不一致的错误必须原样透出，用户才知道该卸载重装而不是反复点更新
  const env = makeEnv();
  const text = '更新包与本机应用的签名不一致，系统会拒绝覆盖安装。请先导出备份后卸载旧版本再安装';
  emit(env.sandbox, { status: 'error', message: text });
  eq('签名错误原样展示', find(env, 'updateLine').textContent, text);
  ok('签名错误也会 toast', env.toastBox.messages.some((m) => m === text));
}

{
  // 网络不可达的错误应可据此排查
  const env = makeEnv();
  emit(env.sandbox, { status: 'error', message: '连接 GitHub 超时，请检查本机网络或代理后重试' });
  eq('超时提示原样展示', find(env, 'updateLine').textContent, '连接 GitHub 超时，请检查本机网络或代理后重试');
}

console.log('\nTOTAL ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
