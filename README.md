# 生息样本库 · Vitals

面向实验室冷库场景的生物样本管理应用：全血 / 血清 / 血浆三类样本独立圆盘存储、温控串口实时追溯、二维码标签打印与扫码核对、动态记录与全量备份迁移，并内置**一键更新**。

| 项目 | 说明 |
| --- | --- |
| 当前版本 | **1.18.2**（versionCode 30） |
| 包名 | `com.vitals.android` |
| 形态 | Android 应用（WebView + JS 桥 + SQLite），`web-preview/` 为浏览器预览版 |
| 更新来源 | 本仓库的 GitHub Release |

---

## 目录结构

```
vitals-android/                  Android 工程（构建入口）
├── app/src/main/java/com/vitals/android/
│   ├── MainActivity.java        WebView 宿主、JS 桥、USB 串口、文件导入导出
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

`tools\test-ui.cjs` 需要本机可用的 Playwright；`tools\test-db.ps1` 与 `tools\test-android.cjs` 需要模拟器与 `adb`，请按本机路径调整其中的常量。

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

---

## 许可

[MIT](LICENSE)
