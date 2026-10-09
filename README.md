# 生息样本库 · Vitals

面向实验室冷库场景的生物样本管理应用：全血 / 血清 / 血浆三类样本独立圆盘存储、温控串口实时追溯、二维码标签打印与扫码核对、动态记录与全量备份迁移，并内置**一键更新**与**本机自动备份**。

| 项目 | 说明 |
| --- | --- |
| 当前版本 | **1.20.1**（versionCode 35） |
| 包名 | `com.vitals.android` |
| 形态 | Android 应用（WebView + JS 桥 + SQLite），`web-preview/` 为浏览器预览版 |
| 更新来源 | 本仓库的 GitHub Release |

---
## 目录结构

```
vitals-android/                  Android 工程（构建入口）
├── app/src/main/java/com/vitals/android/
│   ├── MainActivity.java        WebView 宿主、JS 桥、USB 串口、文件导入导出
│   ├── BackupManager.java       一体机内部目录自动备份与保留策略
│   ├── VitalsDbHelper.java      SQLite 唯一持久化真源（schema v3）
│   ├── VitalsUpdater.java       内置更新：检查 / 下载 / 校验
│   └── UsbLabelPrinter.java     得力 DL-720 标签打印（TSPL）
├── app/src/main/assets/web/     前端全部资源（HTML/CSS/JS + 本地 vendor 库）
├── app/src/androidTest/         数据库插桩测试
├── tools/                       核心逻辑、界面与数据库测试工具
├── docs/                        schema、协议、测试报告、许可证
└── output/                      构建产出的安装包
web-preview/                     网页预览版（同一套前端 + localStorage 桥，硬件模拟）
release.ps1                      构建并发布 Release 到 GitHub
```

---

## 构建

要求：JDK 17+、Android SDK（`compileSdk 36`，需 `platforms;android-36` 与 `build-tools;36.0.0`）。

```powershell
cd vitals-android

# 告知 Gradle 本机 SDK 位置（该文件不入库）
"sdk.dir=D:\Android\Sdk" | Set-Content local.properties

# 方式一：脚本（自动定位 JAVA_HOME，并把 APK 复制到 output\，按版本号命名）
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1

# 方式二：Gradle Wrapper
.\gradlew.bat assembleDebug
```

产物：`vitals-android/output/Vitals-Android-<版本>.apk`。

### 测试

```powershell
cd vitals-android
node tools\test-core.cjs        # 核心逻辑（无需设备）
node tools\updater.test.mjs     # 一键更新：入口、状态机、原生调用参数
```

`tools\test-ui.cjs` 需要本机可用的 Playwright；`tools\test-db.ps1` 与 `tools\test-android.cjs` 需要模拟器与 `adb`。三者都会自动推导工具路径（见下节「开发约定」），无需再改脚本里的常量。

---

## 开发约定

### 1. 两份前端副本必须同步

同一套前端同时存在两处，除白名单外必须逐字节一致，否则 APK 与网页预览版会行为漂移：

- `vitals-android/app/src/main/assets/web/`（随 APK 打包）
- `web-preview/`（浏览器预览版）

```powershell
node vitals-android/tools/sync-assets.mjs          # 校验两份副本；有差异时退出码 1 并打印「文件: 差异类型」
node vitals-android/tools/sync-assets.mjs --fix    # 用 assets 侧覆盖 web-preview 侧的白名单外文件
```

白名单（允许不同）：`index.html`、`web-bridge.js`、`web-preview.css`、`.update-styles.tmp.css`。
`web-preview/tools/` 是预览专属工具目录，不参与比较。

### 2. 桥契约变更必须同时改三处

`MainActivity.java` / `VitalsDbHelper.java` 中 `@JavascriptInterface` 的签名一旦变更，必须同步更新：

1. 原生实现；
2. 两份前端副本（`assets/web` 与 `web-preview`，以及所有调用点）；
3. 数据字典 [vitals-android/docs/DATA-DICTIONARY.md](vitals-android/docs/DATA-DICTIONARY.md)——列定义、枚举值与桥方法映射。

### 3. 测试工具的路径自动推导

`tools/test-ui.cjs` 依次尝试 `PLAYWRIGHT_PATH`、`require.resolve('playwright')` 与常见缓存/全局目录，全部失败时打印提示并以退出码 0 跳过（不阻塞其他测试）。
`tools/test-android.cjs` 与 `tools/test-db.ps1` 从 `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `vitals-android/local.properties` 的 `sdk.dir` 推导 `adb`，找不到时给出可读提示。

`.ps1` 一律保存为 **UTF-8 with BOM**：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读取，中文注释与提示文本可能导致解析失败。

### 4. 发版流程

```powershell
cd vitals-android
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1   # 构建 → output\Vitals-Android-<版本>.apk
cd ..
.\release.ps1                                             # 读取 versionName，构建并发布到 GitHub Release
.\release.ps1 -SkipBuild                                  # 只上传 output\ 中已有的 APK
```

发布前先跑：`node vitals-android/tools/sync-assets.mjs`、`node vitals-android/tools/updater.test.mjs`、`node vitals-android/tools/test-core.cjs`。
版本号只改 `app/build.gradle` 的 `versionName` / `versionCode`；Release 资产名必须是 `Vitals-Android-<versionName>.apk`（应用内一键更新按该命名匹配）。

---

## 发布与一键更新

发布流程（构建 + 打标签 + 上传 APK）：

```powershell
.\release.ps1                   # 读取 versionName，构建后发布 v<versionName>
.\release.ps1 -SkipBuild        # 只发布已有 APK
```

也可以推送标签由 GitHub Actions 自动构建发布（`.github/workflows/release.yml`）。

发布时必须遵守 APK 资产命名约定 **`Vitals-Android-<versionName>.apk`**：应用内更新会在 Release 资产中优先匹配包含该版本号的 `.apk`。

应用内的更新入口有两处：侧边栏底部「检查更新」按钮，以及设置页「软件更新」卡片。其行为：

1. 通过 GitHub 公开 API 查询最新 Release（只允许 `https` + 白名单域名）；
2. 用 `tag_name` 与本地 `versionName` 比较，忽略 `v` 前缀与预发布后缀；
3. 有新版本时展示版本号、发布时间与更新说明，用户确认后后台下载（带进度）；
4. 下载完成校验 APK 包名与当前应用一致，并在 Release 提供摘要时校验 SHA-256；
5. 通过 `FileProvider` 交给系统安装器；未授予「安装未知应用」权限时自动引导到系统设置。

> **签名提示**：仓库不含签名私钥，默认使用本机调试签名。要让老用户能覆盖安装新版本，所有 Release 的 APK 必须使用**同一签名**；更换签名时用户需先卸载（会清除本机数据，请先导出备份）。

---

## 数据存储与迁移

- SQLite 为唯一持久化真源，四张表：`samples` / `records` / `settings` / `db_meta`（schema v3：槽位唯一约束为「样本类型 + 槽位」，全血 / 血清 / 血浆各占一个圆盘，每盘 5 位，共 15 位）。
- 写入采用行级差分 + `revision` 乐观锁 + 单事务提交；前端只发送变化的行。
- 备份为 JSON：`{app, version, exportedAt, samples, records, settings}`；导入为事务内整体替换，失败自动回滚并保留原数据，含未完成机械任务的备份会被拒绝导入。
- 1.19.0 起可在「设置 → 一体机内部自动备份」首次选择内部存储目录。之后数据变化会在 5 秒防抖后自动生成 JSON，应用启动且超过 24 小时未备份时会补做一次，目录内保留最近 30 份。目录通过 Android 系统授权，不需要 U 盘；卸载应用不会主动删除已生成的公共存储备份。

---

## 许可

[MIT](LICENSE)
