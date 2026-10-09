# 更新日志

本项目的应用版本与 GitHub Release 标签（`vX.Y.Z`）保持一致；Android 端内置的一键更新会读取最新 Release 作为升级来源。

## v1.20.0

### 数据存储

- **照片外置**：samples 新增 `photo_path` / `photo_hash` / `thumb` 三列，照片以内容寻址写入 `files/photos/<hash 前 2 位>/<hash>.jpg`，行内不再保存整张 base64。列表与详情先用缩略图（长边 ≤160）渲染，全图在打开详情时经 `getSamplePhoto(id,true)` 按需读取。旧库升级时自动把既有 base64 落盘并回填（幂等，记 `db_meta.photo_migrated`）。
- **照片三态语义**：编辑保存时不携带 `photo` 键＝保留现有照片；`photo:null`/空串＝移除；`photo:<dataURL>`＝落盘覆盖。
- **历史曲线容量策略**：每样本 `env` 上限 2000 点，超出后较早的点按分钟聚合（仍超限则逐级加粗），最近 200 点始终保留原始；写入与导入两条路径都生效。
- **记录结构化与留存**：records 新增 `operator` / `source`（CHECK 枚举 manual/hardware/scanner/system）/ `type_code` 三列，`time` 统一为 ISO 8601，新增 `records_time` 与 `records_type_code` 索引；超过 5000 条时最旧记录自动搬入 `records_archive`。
- **并发与一致性**：启用 WAL 与 `busy_timeout=5000`；新增 `snapshot()` 在单个事务内一次读齐 revision/samples/records/settings，前端不再靠轮询比对 revision。
- **备份覆盖全部真源**：`db_meta` 的 `legacy_s_extra` / `legacy_migrated_at` 随备份往返（`legacyMeta` 字段，不参与 checksum）。

### 导入导出

- **备份自描述与完整性校验**：备份头新增 `schemaVersion` / `appVersion` / `counts` / `checksum`（规范化 JSON 的 SHA-256，算法与浏览器预览桥逐字节一致）；导入先校验 app、schema 版本、条目数与校验和，任一不符即拒绝且库不变。
- **可选照片**：`exportBackup(includePhotos)` 默认不含照片（体积小），设置页可勾选包含。
- **导入不再破坏性整体替换**：`importBackupEx(payload, mode, filterJson)` 支持 `preview`（只算差异）/ `replace`（仅空库）/ `merge`（按 id 去重、条码冲突拒绝、记录按内容指纹去重），并支持按样本 ID／条码子集恢复；界面为「预览差异 → 确认导入」两段式。旧 `importBackup`/`replaceBackup` 保留原语义。
- **CSV 导出**：records / samples / env 三张表，带 BOM（Excel 可直接打开），落盘 MIME 按扩展名推断（.csv → text/csv）。
- **记录与照片界面**：记录页分页（默认 200，加载更多）、时间范围与类型筛选、来源/操作人列；标签信息过期（冻结的 `qrSnap` 与实际位置/状态不一致）时提示重打。

### 工程

- 新增 `vitals-android/tools/sync-assets.mjs`：两份前端副本（assets 与 web-preview）一致性校验与 `--fix` 同步，白名单外哈希不一致即失败。
- 测试脚本不再写死本机路径：`adb` 从 `ANDROID_HOME`/`ANDROID_SDK_ROOT`/`local.properties` 推导，Playwright 缺失时跳过而非中断；新增 `.local-ci` 系列验证（备份夹具、真实 sqlite3 迁移复现、跨端校验和比对）。
- 补充 `vitals-android/docs/DATA-DICTIONARY.md` 数据字典与 README 开发约定（含「所有 .ps1 必须带 UTF-8 BOM」这一 Windows PowerShell 5.1 兼容要求）。

## v1.19.2

### 修复：自动更新检测不到新版本

- **根因一**：v1.18.2 的发布资产是打包方提供的原始 APK，**不含更新模块**，因此侧边栏没有检测能力。
- **根因二**：当时不存在比 1.18.2 更新的版本，即使有模块也只会显示「已是最新」。
- **根因三（致命）**：GitHub 的 Release 资产下载现在跳转到 `release-assets.githubusercontent.com`，而域名白名单里只有旧的 `objects.githubusercontent.com` —— 真实下载必然被拦下。

### 修复内容

- 下载域名白名单补齐实际跳转目标（`release-assets.githubusercontent.com` 等）；新增「API 直链 + 浏览器下载地址」双候选下载与最多 3 次重试（指数退避）；读超时由 20 秒放宽到 90 秒，避免国内网络下大包必然失败。
- 当前版本显示不再依赖同步桥：原生在 `checking` / `checked` 事件中直接带回本机版本，桥不可用时依次回退到界面构建标记与 `window.__VITALS.version`，避免「当前版本未知」被误判为检测失败。
- 错误原因可诊断：区分超时、DNS 失败、TLS 失败、连接被拦截、GitHub 限流等，并写入日志（tag `VitalsUpdate`）。
- 安装前校验签名一致性：签名不一致时直接提示「请先导出备份后卸载旧版本再安装」，不再只得到系统的「应用未安装」。

### 验证

- `tools/updater.test.mjs`：45 项行为断言全部通过（含 6 项版本回退与错误透传回归断言）。
- 以真实 GitHub API 驱动原生 `VitalsUpdater`：模拟旧版本设备 26/26 通过（检测新版本 → 解析资产 → 真实下载 2.7MB → SHA-256 校验 → 包名校验 → 签名不一致提示）；模拟最新版本设备 26/26 通过（正确判定无更新）。

## v1.19.0

- 新增「一体机内部自动备份」设置卡片：首次通过 Android 系统目录选择器授权内部存储目录，不依赖 U 盘。
- 样本、记录或设置成功变更后，5 秒防抖生成完整 JSON 备份；应用启动且超过 24 小时未备份时自动补做一次。
- 自动保留最近 30 份备份，支持立即备份和关闭自动备份；关闭时不删除已有文件。
- 合并最新温度逻辑：预警状态需持续 3 秒才切换，告警记录冷却为 3 秒；7 天后仅清理正常温度聚合桶，异常时段继续保留并设安全上限。
- 构建脚本改为从 `app/build.gradle` 读取版本号，并优先使用已有 `JAVA_HOME`，避免产物文件名和代码版本不一致。

## v1.18.2

### 上游功能（1.11.0 → 1.18.2）

- **1.18.2 人工出库免扫码**：人工模式出库只需勾选「我已核实样本已取出」；硬件模式收到有效 `OK` 后自动出库，进入到位或待核实状态时仍保留扫码核对。
- **1.18.1 精简扫码入口**：样本库移除单独的扫码录入按钮，录入弹窗内的扫码枪扫描编号保持可用。
- **1.18.0 分类温度追溯**：B1/B2/B3 分别对应全血 `30—65℃`、血清 `25—65℃`、血浆 `25—60℃`；串口温度使用 EMA 平滑与连续 5 次采样去抖，告警 10 秒冷却；原始温度点保留 30 分钟，更早数据按 1 分钟聚合，总追溯期 7 天。
- **1.17.0 / 1.16.0 录入预选位置**：存放位置改为 `1—5` 下拉框，按类别自动填入第一个空位，入库时优先使用。
- **1.15.0 / 1.13.0 / 1.12.0 三圆盘存储**：全血、血清、血浆分别对应 A/B/C 圆盘，每盘 5 位，共 15 位；数据库 schema 升至 3，「样本类型 + 槽位」唯一。
- **1.14.0 / 1.8.0 温度界面与串口实时显示**：三路温度卡、解析格式、最近接收时间与最近 100 条原始数据。
- **1.11.0**：出入库并入「样本库」页面。

### 本仓库新增

- **内置一键更新**：侧边栏底部「检查更新」入口与设置页「软件更新」卡片；查询 GitHub 最新 Release、展示更新说明、后台下载 APK（带进度）、校验包名与 SHA-256 后交给系统安装器；未授权「安装未知应用」时自动引导到系统设置。
- 更新检查与下载具备域名白名单；桥接口只接受版本标签，安装包地址由原生重新解析，不信任前端传入的 URL。
- 新增 `tools/updater.test.mjs` 行为测试与 `release.ps1` 发布脚本。
