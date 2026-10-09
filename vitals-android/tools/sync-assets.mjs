#!/usr/bin/env node
/**
 * assets 两份副本一致性校验 / 同步
 *
 * 背景：同一套前端同时存在于两处——
 *   1) vitals-android/app/src/main/assets/web   （随 APK 打包）
 *   2) web-preview/                             （浏览器预览版）
 * 除白名单文件外，两份副本必须逐字节一致，否则 APK 与预览版行为会漂移。
 *
 * 白名单（允许不同，不参与比较）：
 *   index.html          —— 两份的 <script> 注入方式不同
 *   web-bridge.js       —— 仅预览版提供 localStorage 桥
 *   web-preview.css     —— 仅预览版提供的预览外壳样式
 *   .update-styles.tmp.css —— 更新流程的临时产物
 *
 * 说明：web-preview/tools/ 是「预览专属工具目录」（如 verify-preview.mjs），
 *       不随 APK 打包，也不参与对比；.git/ 与 node_modules/ 一律忽略。
 *
 * 用法：
 *   node vitals-android/tools/sync-assets.mjs          # 校验，差异则退出码 1
 *   node vitals-android/tools/sync-assets.mjs --fix    # 把 assets 侧的白名单外文件复制到 web-preview
 *   node vitals-android/tools/sync-assets.mjs --help
 *
 * 仅使用 Node 标准库，无第三方依赖，Windows / Linux 均可运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const ASSETS_DIR = path.join(repoRoot, 'vitals-android', 'app', 'src', 'main', 'assets', 'web');
const PREVIEW_DIR = path.join(repoRoot, 'web-preview');

/** 允许两份副本不同的文件（相对路径，POSIX 分隔符）。 */
const WHITELIST = new Set(['index.html', 'web-bridge.js', 'web-preview.css', '.update-styles.tmp.css']);
/** 非随包资源目录，两侧都跳过（web-preview/tools 只放预览自检脚本）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tools']);

function usage() {
  console.log(`用法：
  node vitals-android/tools/sync-assets.mjs          校验两份 assets（差异 → 退出码 1）
  node vitals-android/tools/sync-assets.mjs --fix    将 assets 侧的白名单外文件复制到 web-preview
  node vitals-android/tools/sync-assets.mjs --help   显示本帮助

白名单（允许不同）：${[...WHITELIST].join('、')}`);
}

/** 递归收集目录内所有文件的相对路径（POSIX 分隔符），跳过 SKIP_DIRS。 */
function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (error) {
      throw new Error(`无法读取目录 ${abs}：${error.message}`);
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireDir(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`[sync-assets] 找不到${label}目录：${dir}`);
    process.exit(1);
  }
}

/** 比较两侧文件集合与哈希。返回 { entries: [{file, kind, assetsHash, previewHash}], compared, whitelisted } */
function compare() {
  const assetsFiles = listFiles(ASSETS_DIR);
  const previewFiles = listFiles(PREVIEW_DIR);
  const assetsMap = new Map(assetsFiles.map((f) => [f, path.join(ASSETS_DIR, f)]));
  const previewMap = new Map(previewFiles.map((f) => [f, path.join(PREVIEW_DIR, f)]));
  const all = [...new Set([...assetsFiles, ...previewFiles])].sort();

  const entries = [];
  let compared = 0;
  let whitelisted = 0;
  for (const file of all) {
    if (WHITELIST.has(file)) { whitelisted++; continue; }
    compared++;
    const inAssets = assetsMap.has(file);
    const inPreview = previewMap.has(file);
    if (inAssets && !inPreview) {
      entries.push({ file, kind: '仅存在于 assets（web-preview 缺失）', assetsHash: sha256(assetsMap.get(file)), previewHash: null });
    } else if (!inAssets && inPreview) {
      entries.push({ file, kind: '仅存在于 web-preview（assets 缺失）', assetsHash: null, previewHash: sha256(previewMap.get(file)) });
    } else {
      const a = sha256(assetsMap.get(file));
      const p = sha256(previewMap.get(file));
      if (a !== p) entries.push({ file, kind: '内容不一致（sha256 不同）', assetsHash: a, previewHash: p });
    }
  }
  return { entries, compared, whitelisted };
}

function report(result) {
  const { entries, compared } = result;
  if (entries.length === 0) {
    console.log(`PASS: ${compared} 个文件两份副本一致（白名单 ${WHITELIST.size} 项允许不同，已跳过）`);
    return 0;
  }
  console.error(`FAIL: 发现 ${entries.length} 处差异（已比较 ${compared} 个文件，白名单 ${WHITELIST.size} 项跳过）`);
  for (const entry of entries) console.error(`  ${entry.file}: ${entry.kind}`);
  console.error('  提示：运行 node vitals-android/tools/sync-assets.mjs --fix 可从 assets 侧补齐 web-preview。');
  return 1;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { usage(); process.exit(0); }
const unknown = args.filter((a) => a !== '--fix' && a !== '--help' && a !== '-h');
if (unknown.length) { console.error(`[sync-assets] 未知参数：${unknown.join(' ')}`); usage(); process.exit(2); }

requireDir(ASSETS_DIR, 'assets');
requireDir(PREVIEW_DIR, 'web-preview');
console.log(`[sync-assets] assets : ${ASSETS_DIR}`);
console.log(`[sync-assets] preview: ${PREVIEW_DIR}`);

if (args.includes('--fix')) {
  const before = compare();
  let copied = 0;
  for (const entry of before.entries) {
    if (!entry.assetsHash) continue; // 只从 assets 侧复制，不回删 web-preview 独有文件
    const source = path.join(ASSETS_DIR, entry.file);
    const target = path.join(PREVIEW_DIR, entry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    copied++;
    console.log(`[sync-assets] 已复制 ${entry.file} → web-preview`);
  }
  console.log(`[sync-assets] --fix 完成，复制 ${copied} 个文件`);
  process.exit(report(compare()));
}

process.exit(report(compare()));
