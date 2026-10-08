# Vitals · 生息 — 生物样本动态管理库

面向实验室冷库场景的生物样本管理应用：五槽位圆盘出入库、温控串口实时监测、二维码标签打印与扫码核对、动态记录与全量备份迁移。

本仓库同时包含两个运行形态，它们共用同一套 Web 前端代码：

| 目录 | 形态 | 数据存储 | 硬件 |
| --- | --- | --- | --- |
| `vitals-android/` | Android 应用（WebView + JS 桥） | 本机 SQLite（`vitals.db`） | 真实 USB 串口：温控板 / CH340 机械板 / 得力扫码枪 / DL-720 标签机 |
| `web-preview/` | 网页预览版 | 浏览器 `localStorage` | 全部模拟，扫码改为手工输入编号 |

---

## 功能一览

- **样本库**：录入 / 编辑 / 详情 / 删除，样本照片（自动压缩）、二维码信息卡、条码唯一性校验。
- **出入库**：五槽位（显示为 0—4 号）圆盘管理，人工模式与硬件联调模式；硬件模式下发 `IN,A-0` 形式的机械指令，出库需扫码枪核对二维码。
- **实时监测**：温控板串口数据入图，温度阈值 `hi`/`lo` 预警，支持模拟数据用于演示。
- **设备连接**：USB 串口设备选择、波特率、STM32 调试控制台、标签打印。
- **动态记录**：入库 / 出库 / 编辑 / 删除 / 任务取消等操作留痕（最多保留 500 条）。
- **设置与迁移**：温度阈值、全量 JSON 备份导出 / 导入、一键清空、**内置一键更新**。

---

## Android 端构建

要求：JDK 17+、Android SDK（`compileSdk 36`）、Android Studio 或命令行 Gradle。

```powershell
cd vitals-android

# 首次构建前告知 Gradle Android SDK 位置（该文件不入库）
"sdk.dir=D\:\\Android\\Sdk" | Set-Content local.properties

# 方式一：脚本（会额外把 APK 复制到 output\）
.\build-apk.ps1

# 方式二：直接调用 Gradle
.\gradlew.bat assembleDebug
```

产物：`vitals-android/app/build/outputs/apk/debug/app-debug.apk`

`build-apk.ps1` 会读取 `JAVA_HOME`，未设置时自动回退到 Android Studio 自带 JBR。

### 数据库测试

`app/src/androidTest/java/com/vitals/android/DatabaseInstrumentation.java` 是不依赖测试框架的插桩测试入口，覆盖建表、唯一约束、槽位占用、事务回滚、旧库迁移、导入导出等价性等。

```powershell
.\gradlew.bat connectedDebugAndroidTest
```

---

## 网页预览版

直接以静态站点方式提供即可（无构建步骤）：

```powershell
cd web-preview
python -m http.server 8080
# 或 npx serve .
```

浏览器打开 `http://localhost:8080/`。首次进入会注入 5 条演示样本；数据只写入当前浏览器的 `localStorage`，与 Android 端互不影响。预览版对「检查更新」只做只读查询与提示，不具备安装能力。

---

## 版本号与发布

- 应用版本：`vitals-android/app/build.gradle` 中的 `versionCode` / `versionName`。
- 构建发布：

```powershell
cd vitals-android
.\build-apk.ps1
gh release create v1.10.0 .\output\Vitals-Android-1.10.0.apk `
  --repo 9573351-crypto/vitals-biosample --title "v1.10.0" --notes "更新说明"
```

发布时请遵守 APK 资产命名约定 **`Vitals-Android-<versionName>.apk`**，内置更新功能据此在 Release 资产中定位安装包（同时兼容资产名包含 `vitals` 且以 `.apk` 结尾的写法）。

---

## 内置一键更新

侧边栏底部「检查更新」按钮 + 设置页「软件更新」卡片，两级入口共用同一逻辑：

1. 访问 GitHub 公开 API `GET /repos/9573351-crypto/vitals-biosample/releases/latest`，只接受 `https` + `api.github.com` 域名；
2. 以 `tag_name` 与本地 `versionName` 比较，忽略 `v` 前缀与预发布后缀；
3. 有新版本时展示版本号、发布时间与 Release 说明，用户确认后后台下载 APK（带进度）；
4. 下载完成校验 APK 包名与当前应用一致，再由 `FileProvider` 授权交给系统安装器；
5. 未授予「安装未知应用」权限时，引导用户到系统设置页开启。

更新逻辑在 Android 端由 `VitalsUpdater` 实现（网络、下载、校验都在工作线程），前端只负责展示；网页预览版与 Electron 桌面版走 `fetch` 只读回退。发布新版本后，老用户点击一次即可完成升级。

---

## 数据存储与导入导出

- **Android**：SQLite 为唯一持久化真源，`samples` / `records` / `settings` / `db_meta` 四张表；照片以 base64 存 TEXT 列；外键 `ON DELETE SET NULL` 保证删除样本后仍保留历史快照。
- **写入模型**：前端维护渲染模型，普通保存只把**变化的行**打包成 `{expectedRevision, upsertSamples, deleteSamples, addRecords, deleteRecords, setSettings, deleteSettings}` 差分，交由原生在一个事务内提交，并用 `revision` 做乐观锁。
- **备份格式**：`{app, version, exportedAt, samples, records, settings}`。导入为**整体替换**（单事务，失败自动回滚并保留原数据），体积上限 24 MB，读取上限 20 MB；含未完成机械任务的备份会被拒绝导入。

---

## 维护须知

`web-preview/` 与 `vitals-android/app/src/main/assets/web/` 是两份需要手工保持同步的前端副本，除以下文件外应逐字节一致：

- `index.html`：Android 端加载 `persistence.js`，网页端额外加载 `web-bridge.js`、`web-preview.css` 并使用带 `?v=` 的缓存键。

修改前端后请同步两处，可用哈希比对快速确认：

```powershell
Get-FileHash web-preview\app.js, vitals-android\app\src\main\assets\web\app.js
```

---

## 许可

[MIT](LICENSE)
