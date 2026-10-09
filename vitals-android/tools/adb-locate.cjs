'use strict';
/* 共享的 adb 定位逻辑：避免各个测试脚本各自写死本机路径。
   顺序：ANDROID_HOME → ANDROID_SDK_ROOT → 工程 local.properties 的 sdk.dir → 常见安装目录。
   仅用 Node 标准库，Windows / Linux / macOS 均可运行。 */
const fs = require('node:fs');
const path = require('node:path');

function resolveAdb(projectRoot) {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const roots = [];
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const value = process.env[key];
    if (value) roots.push(value);
  }
  const base = projectRoot || path.resolve(__dirname, '..');
  const localProperties = path.join(base, 'local.properties');
  if (fs.existsSync(localProperties)) {
    for (const line of fs.readFileSync(localProperties, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*sdk\.dir\s*=\s*(.+?)\s*$/);
      // local.properties 里 Windows 路径会写成 D\:\\path 形式，需要反转义
      if (match) roots.push(match[1].replace(/\\\\/g, '\\').replace(/\\:/g, ':'));
    }
  }
  roots.push('D:/android-studio/SDK', 'D:/download3/AndroidSdk', path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'));
  for (const root of roots) {
    if (!root) continue;
    for (const candidate of [path.join(root, 'platform-tools', exe), path.join(root, exe)]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const ADB_HELP = '未找到 adb：请设置 ANDROID_HOME 或 ANDROID_SDK_ROOT，或在 vitals-android/local.properties 写入 sdk.dir=<SDK 路径>。';

module.exports = { resolveAdb, ADB_HELP };
