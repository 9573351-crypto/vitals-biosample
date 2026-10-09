## 生息样本库 1.20.0 · 数据存储与导入导出重构

本次针对此前提出的数据层问题做了系统性改造，重点是**照片不再进数据库**、**备份可校验可合并**、**记录可在数据库层查询与留存**。

### 数据存储

- **照片外置**：`samples` 新增 `photo_path` / `photo_hash` / `thumb` 三列。照片以内容寻址写入 `files/photos/<hash 前 2 位>/<hash>.jpg`，行内不再保存整张 base64；列表与详情先用 ≤160px 缩略图渲染，全图在打开详情时按需读取（`getSamplePhoto(id,true)`）。旧库升级时自动把既有 base64 落盘并回填，幂等且失败不留半状态。
- **照片三态语义**：编辑保存不携带 `photo` 键＝保留现有照片；`photo:null`／空串＝移除；`photo:<dataURL>`＝落盘覆盖。
- **历史曲线容量策略**：每样本 `env` 上限 2000 点，超出后较早的点按分钟聚合（仍超限则逐级加粗），最近 200 点始终保留原始；写入与导入两条路径都生效。
- **记录结构化与留存**：`records` 新增 `operator` / `source`（CHECK 枚举 `manual`/`hardware`/`scanner`/`system`）/ `type_code`，`time` 统一 ISO 8601，新增 `records_time` 与 `records_type_code` 索引；超过 5000 条时最旧记录自动搬入 `records_archive`。
- **并发与一致性**：启用 WAL 与 `busy_timeout=5000`；新增 `snapshot()` 在单个事务内一次读齐 revision/samples/records/settings，前端不再依赖 revision 轮询比对。
- **备份覆盖全部真源**：`db_meta` 的 `legacy_s_extra` / `legacy_migrated_at` 随备份往返（`legacyMeta`，不参与 checksum）。

### 导入导出

- **自描述 + 完整性校验**：备份头新增 `schemaVersion` / `appVersion` / `counts` / `checksum`（规范化 JSON 的 SHA-256）。导入前校验 app、schema 版本、条目计数与校验和，任一不符即拒绝且**库不变**。
- **不再破坏性整体替换**：`importBackupEx(payload, mode, filterJson)` 支持 `preview`（只算差异不改库）/ `replace`（仅空库）/ `merge`（按 id 去重、条码冲突拒绝、记录按内容指纹去重），并支持按样本 ID／条码子集恢复；界面为「预览差异 → 确认导入」两段式，非空库默认合并。
- **CSV 导出**：records / samples / env 三张表，带 BOM（Excel 可直接打开），落盘 MIME 按扩展名推断（`.csv` → `text/csv`）。
- **可选照片**：`exportBackup(includePhotos)` 默认不含照片以缩小体积，设置页可勾选包含。

### 界面

- 记录页：分页（默认 200 条 + 加载更多）、时间范围与类型筛选、来源/操作人列。
- 标签过期提示：冻结的 `qrSnap` 与实际位置/状态不一致时，详情与打印处提示「建议重新打印」。

### 工程与验证

- 新增 `tools/sync-assets.mjs`：两份前端副本（assets 与 web-preview）一致性校验与 `--fix`，白名单外哈希不一致即失败。
- 测试脚本不再写死本机路径：`adb` 从 `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `local.properties` 推导，Playwright 缺失时跳过而非中断。
- 新增 `vitals-android/docs/DATA-DICTIONARY.md`（全表字段、`extra_json` 保留策略、照片四列、记录枚举、备份格式）与 README「开发约定」。
- `.local-ci/` 纳入可复现验证资产：11 个备份夹具（含篡改／截断／计数不符／高版本 schema／条码冲突）、真实 **sqlite3** 迁移复现脚本、跨端校验和比对。

### 本次验证结果

| 验证 | 结果 |
| --- | --- |
| `gradlew assembleDebug` + `assembleDebugAndroidTest` | BUILD SUCCESSFUL |
| `tools/test-core.cjs` | 10/10 |
| `tools/updater.test.mjs` | 45/45 |
| `tools/bridge-checksum.test.mjs`（浏览器桥 vs 原生校验和） | 11/11，checksum 与原生逐字节一致 |
| `web-preview/tools/verify-preview.mjs` | 46/46 |
| `.local-ci/verify-schema-sqlite.ps1`（真实 sqlite3 迁移） | 26/26 |
| `tools/sync-assets.mjs` | 两份副本 14 文件一致 |
| 全新 `git clone` 复现上述脚本 | 全部通过 |

**未覆盖项（如实说明）**：`connectedDebugAndroidTest`（15 条新增设备断言）已在本地编译并打包进 `app-debug-androidTest.apk`，但**未实跑**——本机 Android 模拟器缺少 hypervisor 驱动（需管理员安装），也无实体设备。设备端仍需在真机上执行一次以覆盖 WAL、Android 事务语义与 Java 侧照片落盘。

### 安装

- 版本 `1.20.0`（versionCode 34），包名 `com.vitals.android`
- SHA-256：`a1ada7506053e0dccd07740da83a070e7756a4e75adce16b22004f9b036bb4ab`
- 从 1.18.2 及以上升级时，首次会执行一次数据库升级（加列 + records 重建 + 照片外置），升级前建议先导出备份；升级过程失败会保留原库。
