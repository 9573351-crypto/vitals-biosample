# VITALS 数据字典（SQLite）

> 真源：`vitals-android/app/src/main/java/com/vitals/android/VitalsDbHelper.java`（DDL 常量 `SAMPLES_COLUMNS` / `RECORDS_COLUMNS`）
> 本文核对时的状态：**schema v4 列已落地，但 `DB_VERSION` 仍为 3**——新列由 `onOpen → ensureSchema()` 幂等补齐（见第 12 节第 1 条）。
> 数据库文件：应用私有目录 `databases/vitals.db`（插桩测试使用独立测试库）。
> 照片文件：`files/photos/<sha256 前 2 位>/<sha256>.jpg`（由 `VitalsPhotos` 管理）。
> 前端运行时模型（`state.s` / `state.rec` / `state.set`）只是 ViewModel；持久化真源始终是 SQLite。

标注 **⚠ 复核** 的条目是仍然需要 Lead 确认的实现细节，汇总在第 12 节。

---

## 0. 通用约定

| 约定 | 说明 |
| --- | --- |
| 主键 | `samples.sample_id` 文本主键；`records.id` 自增整数；`settings.key` / `db_meta.key` 文本主键 |
| 内部 ID 规则 | `sample_id` 必须匹配 `[-a-zA-Z0-9_]+`，且不得为 `__proto__` / `constructor` / `prototype`（防原型污染） |
| 布尔 | SQLite 无布尔类型，统一 `INTEGER 0/1` + `CHECK(col IN (0,1))`；JS 侧为 `true/false` |
| 时间戳 | `created_at` / `updated_at` 为 **epoch 毫秒整数**；业务时间文本见第 9.5 节 |
| JSON | `extra_json` / `settings.value` / `db_meta.value` 为 JSON 文本，空对象默认 `'{}'` |
| 空值 | 未设置的可空列写 `NULL`；前端读到「字段不存在」 |
| 外键 | `PRAGMA foreign_keys=ON`（`onConfigure` → `setForeignKeyConstraintsEnabled(true)`） |
| 并发 | `onConfigure` 中 `enableWriteAheadLogging()`（WAL）+ `PRAGMA busy_timeout=5000`；失败时静默退回默认 journal 模式 |
| 迁移幂等 | 标记写 `db_meta`；`ensureSchema()` / `migratePhotos()` / `migrateLegacy()` 均可在每次打开时安全重跑 |

---

## 1. samples —— 样本主体

JS 字段 ↔ SQL 列映射由 `VitalsDbHelper` 的 `JS[]` / `SQL[]` 两个数组定义（顺序一一对应）。
**新增列必须同时加进这两个数组**，否则该字段会落进 `extra_json`。

| # | SQL 列 | 类型 / 约束 | JS 字段 | 含义 |
| --- | --- | --- | --- | --- |
| 1 | `sample_id` | `TEXT PRIMARY KEY NOT NULL` | `id` | 内部样本 ID（非条码），全局唯一 |
| 2 | `name` | `TEXT NOT NULL` | `name` | 样本名称 |
| 3 | `barcode` | `TEXT UNIQUE`（空串写 `NULL`） | `code` | 样本编号/条码；非空值唯一，导入时冲突即拒绝 |
| 4 | `status` | `TEXT NOT NULL CHECK(status IN ('in','out'))` | `status` | `in`=在库，`out`=未在库/已出库 |
| 5 | `slot` | `INTEGER CHECK(slot IS NULL OR (typeof(slot)='integer' AND slot BETWEEN 1 AND 5))` | `slot` | 所在圆盘槽位 1—5；出库后为 `NULL` |
| 6 | `last_slot` | `INTEGER CHECK(... 1—5)` | `lastSlot` | 最近一次占用的槽位（出库后保留的历史位置） |
| 7 | `pending_intake` | `INTEGER NOT NULL DEFAULT 0 CHECK(... IN (0,1))` | `pendingIntake` | 已录入但尚未完成入库 |
| 8 | `type` | `TEXT` | `type` | 样本类别：`全血` / `血清` / `血浆`（占用槽位时必须是这三类之一） |
| 9 | `location` | `TEXT` | `loc` | 位置文本，如 `圆盘-1` |
| 10 | `collected_at` | `TEXT` | `timeRaw` | 采集时间原始值（`datetime-local`） |
| 11 | `collected_time_text` | `TEXT` | `timeTxt` | 采集时间展示文本 |
| 12 | `temperature` | `REAL` | `temp` | 采集温度（℃） |
| 13 | `note` | `TEXT` | `note` | 备注 |
| 14 | `photo` | `TEXT` | `photo` | 历史内联照片 `data:image/(png\|jpeg\|webp);base64,...`。**新写入不再填全图**；仅在照片迁移失败的行上保留，见第 7 节 |
| 15 | `photo_path` | `TEXT`（可空） | `photoPath` | 外置照片相对路径，形如 `photos/<sha256[:2]>/<sha256>.jpg`（相对 `getFilesDir()`） |
| 16 | `photo_hash` | `TEXT`（可空） | `photoHash` | 照片内容 sha256（hex）；文件去重键与缓存键 |
| 17 | `thumb` | `TEXT`（可空） | `thumb` | 小图 `data:image/jpeg;base64,...`，长边 ≤160、质量 70；源图不可解码时为 `NULL` |
| 18 | `created_at` | `INTEGER` | `createdAt` | 创建时间（epoch ms） |
| 19 | `updated_at` | `INTEGER` | `updatedAt` | 最近更新时间（epoch ms） |
| 20 | `monitor` | `INTEGER NOT NULL DEFAULT 0 CHECK(... IN (0,1))` | `monitor` | 是否纳入温度监控 |
| 21 | `last_temperature` | `REAL` | `lastTemp` | 最近一次温度读数 |
| 22 | `last_humidity` | `REAL` | `lastHum` | 最近一次湿度读数（1.3.1 起界面移除湿度，字段仅兼容保留） |
| 23 | `last_light` | `REAL` | `lastLight` | 最近一次光照读数（同上，兼容保留） |
| 24 | `last_update` | `TEXT` | `lastUpdate` | 最近读数时间文本 |
| 25 | `alert` | `TEXT CHECK(alert IS NULL OR alert IN ('good','warn','bad'))` | `alert` | 温度状态：正常 / 预警 / 异常 |
| 26 | `qr_snapshot` | `TEXT` | `qrSnap` | **标签二维码快照**：样本创建时冻结的标签内容文本，之后编辑/温度变化不改动，用于判断已打印标签是否过期 |
| 27 | `extra_json` | `TEXT NOT NULL DEFAULT '{}'` | 其余字段 | 未建列的字段（含 `env`）以 JSON 保存，见第 6 节 |

表级约束：

```sql
UNIQUE(type, slot)                                    -- 同一圆盘内槽位唯一；不同类别可复用同一槽号
CHECK(slot IS NULL OR type IN ('全血','血清','血浆'))    -- 占用槽位必须归属三圆盘之一
CHECK(status='in' OR slot IS NULL)                    -- 只有在库样本可以占用槽位
```

> `status='out'` 且带 `slot` 的写入会被 `normalizeSample()` 自动改写为 `lastSlot` 并清空 `slot`。
> 写库前校验：`thumb` 与 `photo` 都必须匹配 `data:image/(png|jpeg|webp);base64,...`；`alert` 必须是三值之一。

---

## 2. records —— 动态记录

| # | SQL 列 | 类型 / 约束 | JS 字段 | 含义 |
| --- | --- | --- | --- | --- |
| 1 | `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | `recordId` | 记录 ID；删除与去重以它为准 |
| 2 | `sample_id` | `TEXT`，`FOREIGN KEY → samples(sample_id) ON DELETE SET NULL` | `sampleId` | 关联样本；删除样本后记录保留、外键置 NULL |
| 3 | `sample_name` | `TEXT NOT NULL DEFAULT ''` | `sample` | 记录发生时的样本名称快照（系统记录为 `系统`） |
| 4 | `time` | `TEXT NOT NULL DEFAULT ''` | `time` | 记录时间，ISO 8601，见第 9.5 节 |
| 5 | `type` | `TEXT NOT NULL DEFAULT ''` | `type` | **业务动作**中文类型（非样本类别），见第 9.1 节 |
| 6 | `detail` | `TEXT NOT NULL DEFAULT ''` | `detail` | 明细文本 |
| 7 | `barcode` | `TEXT` | `code` | 发生时的条码快照 |
| 8 | `slot` | `INTEGER CHECK(slot IS NULL OR ... 1—5)` | `slot` | 发生时的槽位快照 |
| 9 | `status` | `TEXT CHECK(status IS NULL OR status IN ('in','out'))` | `status` | 发生时的库存状态快照 |
| 10 | `task_id` | `TEXT` | `taskId` | 关联机械任务号（如 `CAM-1`） |
| 11 | `operator` | `TEXT`（可空） | `operator` | 操作人；**当前前端不写该列**，见第 12 节第 3 条 |
| 12 | `source` | `TEXT CHECK(source IS NULL OR source IN ('manual','hardware','scanner','system'))`（可空） | `source` | 记录来源，见第 9.3 节 |
| 13 | `type_code` | `TEXT`（可空） | `typeCode` | `type` 的稳定机器码，见第 9.2 节 |
| 14 | `extra_json` | `TEXT NOT NULL DEFAULT '{}'` | 其余字段 | 未建列的扩展字段 |

- 读取顺序：`records()` 与 `recordsPage()` 均按 `id DESC`（最新在前）。
- 写入归一化（`normalizeRecord`）：接受 `typeCode` 或 `type_code` 两种命名，统一为 camelCase（避免同一字段在 `extra_json` 里重复留存）；`source` **可选**，仅在非空时校验枚举；`time` 经 `isoTimeValue()` 归一为 ISO 8601。
- 内容指纹去重（merge 导入）使用：`time | sample | type | detail | code | slot | status`。

索引：

| 索引 | 列 | 用途 |
| --- | --- | --- |
| `records_sample_time` | `(sample_id, time)` | 按样本取历史记录 |
| `records_time` | `(time)` | `recordsPage` 的时间范围筛选 |
| `records_type_code` | `(type_code)` | 按类型码筛选 |

---

## 3. records_archive —— 归档表

结构与 `records` **完全一致**（同一个 `RECORDS_COLUMNS` 常量，含 `operator` / `source` / `type_code`）。

DB 级留存策略（契约 C）：

- 阈值 `recordLimit = 5000`（包内可写，便于测试用更小阈值快速验证）。
- 在 `commit()` / 导入的**同一事务内**调用：超过上限时把**最旧**的行 `INSERT OR REPLACE INTO records_archive (...) SELECT ... ORDER BY id ASC LIMIT 超出条数`，再从 `records` 删除。
- 归档行不参与 `recordsPage()` 分页（分页只查 `records`）。

---

## 4. settings —— 键值设置

`key TEXT PRIMARY KEY NOT NULL` + `value TEXT NOT NULL`；`value` 是该键对应值的 **JSON 文本**。

| key | 值类型 | 含义 |
| --- | --- | --- |
| `hi` | number | 温度上限阈值（℃）；**允许为 0** |
| `lo` | number | 温度下限阈值（℃）；允许为负数 |
| `simOn` | boolean | 是否开启温度模拟 |
| `online` | integer | 设备在线汇总计数（前端展示缓存） |
| `motionTask` | object \| null | 未完成机械任务：`{taskId, sampleId, action:'in'\|'out', slot, mode:'manual'\|'hardware', phase, createdAt, error?}`；`phase ∈ sent\|accepted\|arrived\|verify\|uncertain` |
| `templog:<sampleId>` | object | 单样本温度追溯缓存 `{raw:[...], agg:[...]}`；删除样本时同步删除该键 |
| `labelPrintedAt` | number \| object | ⚠ **复核**：标签打印时间戳，用于「标签信息已过期」提示去重；是否真的落库以最终前端实现为准 |

约束：键名非空、长度 ≤200，且不得为 `__proto__` / `constructor` / `prototype`。
`motionTask` 存在时由 `validateTask()` 校验（样本存在、出入库方向与槽位一致、槽位未被他人占用）；导入备份时含未完成机械任务会被拒绝（旧库迁移路径除外）。

**不在本表内**：一体机自动备份的目录 URI 与上次成功时间是 `SharedPreferences`（`vitals_backup`: `tree_uri` / `last_success`），属 Android 侧偏好，不进 SQLite、也不随备份导出。

---

## 5. db_meta —— 数据库内部元数据

`key TEXT PRIMARY KEY NOT NULL` + `value TEXT NOT NULL`。**只存内部标记，不存业务快照。**

| key | 值 | 含义 |
| --- | --- | --- |
| `revision` | 十进制整数字符串 | 乐观锁版本号；每次成功写入事务递增。`commitChanges` 用 `expectedRevision` 比对，不匹配即拒绝整批写入 |
| `legacy_migration` | `done` | 旧 `app_state` 一次性迁移完成标记 |
| `legacy_s_extra` | JSON 文本 | 见第 8 节 |
| `legacy_migrated_at` | epoch 毫秒字符串 | 见第 8 节 |
| `photo_migrated` | `done` | 照片外置迁移完成标记（`migratePhotos()`，幂等） |

`info()` 返回 `{version, revision, legacyMigration}`。

---

## 6. `extra_json` 与「未知字段保留」策略

`extra_json` 是**未被建列的前向兼容区**：写入时先复制原始对象，逐列 `remove()` 已知字段，剩余序列化进 `extra_json`（`sampleValues()` / 记录写入）；读取时先反序列化 `extra_json`，再用真实列值覆盖同名键（`sample()` / `records()`）。

两条必须遵守的规则：

1. **未知字段不会丢**：旧版前端字段、新版字段、第三方导入的自定义键都会原样往返。
2. **建列即升级映射**：某键从 `extra_json` 提升为真实列时，必须同步加入 `JS[]` / `SQL[]`（或 `RJS[]` / `RSQL[]`），否则会被 `extra_json` 里的同名旧值覆盖或反向漏写。

已知落在 `extra_json` 的字段：

- `env`：样本温度历史数组 `[{time, temp, hum?, light?}]`（`ENV_FIELDS = temp/hum/light`）。
  **容量策略（契约 D，已落地）**：`ENV_LIMIT = 2000`、`ENV_KEEP = 200`；超限时最近 200 点原样保留，更早的点按桶聚合取 **avg**（`time` 用分钟时间戳）；
  若仍超限则按 `ENV_BUCKETS = {1,2,5,10,15,30,60,120,240,720,1440}` 逐级加粗桶宽，极端数据只保留最新部分，硬保证 ≤2000 点。
  该策略在 `normalizeSample()` 内实现，**写入与导入备份两条路径共用**。

---

## 7. 照片四列（`photo` / `photo_path` / `photo_hash` / `thumb`）

| 列/文件 | 说明 |
| --- | --- |
| `photo` | 历史内联全图 `data:image/...;base64,...`。**新写入不再填**；迁移失败的行保留原值以保证不丢数据 |
| `photo_path` | 外置文件相对路径 `photos/<sha256[:2]>/<sha256>.jpg`（绝对根 `context.getFilesDir()`） |
| `photo_hash` | 照片内容 sha256（hex），文件名与去重键 |
| `thumb` | 小图 data URL（JPEG base64，长边 ≤160，质量 70），列表/详情首屏直接渲染 |
| 物理文件 | `files/photos/<hash 前 2 位>/<hash>.jpg` |

迁移规则（`migratePhotos()`，幂等，标记 `db_meta.photo_migrated=done`）：

1. 只处理 `photo IS NOT NULL AND photo<>''` 的行；
2. 解码 base64 → 算 sha256 → 写文件 → 回填 `photo_path` / `photo_hash` → 生成 `thumb` → 清空 `photo`；
3. 解码或落盘失败时 **跳过该行并保留内联照片**（不制造半状态）；
4. 整个过程在一个事务内完成，最后写入 `photo_migrated=done`。

读取规则：

- `getSamplePhoto(id, full)` 返回 `{id, hash, thumb, photo, missing}`：`full=true` 才读全图 base64；文件缺失返回 `missing:true`，**不抛异常**；缺 `photo_path` 时回退旧的内联 `photo`。
- `snapshot()` 返回的样本**一律不含全图**（只有 `thumb` / `photoPath` / `photoHash`），供启动加载。

---

## 8. legacy 迁移标记

| key | 写入时机 | 含义 |
| --- | --- | --- |
| `legacy_migration` = `done` | 首次成功执行 `migrateLegacy()` | 幂等闸门。若 `samples` / `records` / `settings` 三表全空且存在旧表 `app_state`，则在**单事务**内读取 `app_state.payload`（id=`1`）导入；无论是否真的导入都会打标记，清空数据后也不会重复迁移 |
| `legacy_s_extra` | 仅当旧 payload 含 `s` 键 | 旧 `state.s` 中除 `samples` / `records` / `settings` 之外的其余元信息 JSON 快照；`loadState()` 以它为基底再覆盖三张表数据 |
| `legacy_migrated_at` | 同上 | 迁移发生的 epoch 毫秒时间戳，仅用于排查/审计 |

失败语义：任何异常都会回滚并抛出 `IllegalStateException("旧数据库迁移失败，原数据已保留：…")`，绝不静默删改。

> `legacy_s_extra` 是历史遗留区，**不要**当作新字段存放处；新字段请建列或写 `extra_json`。

---

## 9. records 的枚举与时间约定

### 9.1 `type`（展示用中文，业务动作）

| 值 | 触发 |
| --- | --- |
| `录入` | 新增样本 |
| `编辑` | 修改样本信息 |
| `删除` | 删除样本 |
| `入库` / `出库` | 人工或硬件确认的出入库完成 |
| `槽位绑定` | 人工核实并绑定历史样本槽位 |
| `任务取消` | 人工取消机械任务并恢复原状态 |
| `告警` / `恢复` | 温度异常 / 恢复正常（3 秒告警冷却） |
| `连接` | 设备串口连接 |
| `初始化` | 示例数据载入 |

`type` 无 CHECK 约束（自由文本）。

### 9.2 `type_code`（记录类型机器码）

- 原生侧**不做映射**，原样保存（同时接受 `typeCode` / `type_code` 两种入参命名）。
- 前端「动态记录」页的类型下拉**取自本机已有记录的 `typeCode`**，老库回退中文 `type`；筛选时只有 `code:` 前缀的值会传给原生 `recordsPage(..., typeCode, ...)`。
- ⚠ **复核**：目前没有集中的「中文 type → type_code」映射表，跨设备/跨版本筛选依赖写入端命名一致，见第 12 节第 4 条。

### 9.3 `source`（来源枚举）

CHECK 约束与原生校验集合一致：`source IS NULL OR source IN ('manual','hardware','scanner','system')`（`RECORD_SOURCES`）。
前端展示映射：`{manual:'人工', hardware:'硬件', scanner:'扫码枪', system:'系统'}`（`RECORD_SOURCE_LABELS`），空值显示 `—`。

| 值 | 含义 |
| --- | --- |
| `manual` | 人工界面操作 |
| `hardware` | 机械板/串口回执驱动的自动完成 |
| `scanner` | 扫码枪核对触发 |
| `system` | 系统自身（初始化、迁移、自动任务） |

原生在字段为空时**不填默认值**（写入 `NULL`）。

### 9.4 `operator`

操作人文本；当前应用没有登录体系，取值来源未定义（⚠ 复核）。缺省应为 `NULL` 而非空串。

### 9.5 时间格式

| 位置 | 格式 |
| --- | --- |
| `records.time` | **ISO 8601 `YYYY-MM-DDTHH:mm`**。写入经 `isoTimeValue()` 归一；历史 `'YYYY-MM-DD HH:MM'` 由 `ensureSchema()` 的幂等 SQL 迁移（`substr(time,1,10)||'T'||substr(time,12)`，以第 11 位是否为空格 + 第 5/8 位是否为 `-` 判定，转换后不再匹配） |
| `samples.collected_at` / `collected_time_text` | 界面展示文本，不参与排序 |
| `created_at` / `updated_at` / `legacy_migrated_at` | epoch 毫秒整数 |

因 ISO 8601 字典序与时间序一致，`recordsPage(fromIso, toIso, ...)` 的范围比较可直接用字符串比较。`limit` 默认 200、上限 500。

---

## 10. 桥方法 ↔ 表映射

`MainActivity.java` 的 `@JavascriptInterface` 现状：

| 桥方法 | 读/写 | 涉及表 |
| --- | --- | --- |
| `getDatabaseInfo()` | 读 | `db_meta` |
| `snapshot()` | 读 | `db_meta` + `samples` + `records` + `settings`（**单事务一致读**，替代下面四次调用） |
| `getSamples()` / `getSample(id)` / `getSampleByBarcode(code)` | 读 | `samples` |
| `getSamplePhoto(id, full)` | 读 | `samples`（`photo_path`/`photo_hash`/`thumb`/`photo`）+ 照片文件 |
| `getRecords(sampleId)` / `recordsPage(fromIso,toIso,typeCode,limit,offset)` | 读 | `records` |
| `getSettings()` | 读 | `settings` |
| `loadState()` | 读 | 三张表 + `db_meta(legacy_s_extra)` |
| `saveSample` / `deleteSample` / `addRecord` / `setSetting` | 写 | `samples` / `records` / `settings` |
| `commitChanges(payload)` | 写（单事务 + revision 乐观锁 + 留存搬移） | 以上全部 + `records_archive` |
| `importBackup(payload)` | 写（旧 1 参入口，整体替换语义） | 以上全部 |
| `importBackupEx(payload, mode, filterJson)` | 写（`preview`/`replace`/`merge` + 子集恢复） | 以上全部 + `records_archive` |
| `exportBackup(includePhotos)` / `getBackup()` | 读 | 以上全部（JSON 导出；`includePhotos=true` 时把外置照片读回 base64 内嵌） |
| `exportCsv(kind, optionsJson)` | 读 | `records` / `samples` / `samples.extra_json.env` |

> **命名注意**：契约文案写的是 `importBackup(payload, mode[, filterJson])`，实际实现为 **`importBackupEx`**——
> 因为 `@JavascriptInterface` 不支持同名重载，旧 1 参 `importBackup` 必须保留给自动备份与旧前端。
> 前端调用点必须使用 `importBackupEx`（见第 12 节第 2 条）。
> CSV 列定义见 `CsvExporter`：`records` = 时间,样本,编号,类型,明细,槽位,状态,任务号,来源；`samples` = 内部ID,名称,编号,类别,位置,状态,采集时间,温度,备注；`env` = 样本ID,样本名称,时间,温度。返回 UTF-8 带 BOM。

**约定**：桥契约一旦变更，必须同时更新三处 —— 原生实现、两份前端副本（`app/src/main/assets/web` 与 `web-preview`）、以及本文档。详见两个 README 的「开发约定」一节。

---

## 11. 备份格式（JSON）

`BackupFormat.SCHEMA_VERSION = 4`。导出结构：

```json
{"app":"vitals-biosample","schemaVersion":4,"appVersion":"<versionName>","exportedAt":"<ISO>",
 "counts":{"samples":N,"records":M},"checksum":"sha256:<hex>",
 "legacyMeta":{"legacy_s_extra":"<JSON 文本>","legacy_migrated_at":"<epoch 毫秒字符串>"},
 "samples":{...},"records":[...],"settings":{...}}
```

`legacyMeta` 是可选的：仅当库的 `db_meta` 里存在这两个键时才输出，用于让旧库迁移信息随备份往返（否则 `loadState()` 重建的 `state.s` 会丢字段）。恢复发生在导入事务内，只写存在的键，不影响 `photo_migrated` / `revision` / `legacy_migration`。**`legacyMeta` 不参与 checksum**（`app` / `appVersion` / `exportedAt` / `counts` 同样不参与），校验和只覆盖业务三段。

`checksum = "sha256:" + hex(sha256(UTF-8(canonical(samples) + canonical(records) + canonical(settings))))`，
`canonical` 为键排序的规范化 JSON；因此「导出 → 导入 → 再导出」应得到逐字符等价的规范文本与相同 checksum。

导入模式（`importBackupEx`）：`preview` 只校验并返回差异（不改库）；`replace` 仅当库为空（samples+records 均为 0）时允许；`merge` 按 `sample_id` 去重（同 id 覆盖，条码冲突报错回滚），records 按内容指纹去重后追加。
导入前校验：`app` 匹配、`schemaVersion ≤ 当前`、`counts` 与内容一致、`checksum` 匹配；任一不符返回 `ok=false` 且库不变（先校验后进事务）。

---

## 12. 需要 Lead 复核的条目

1. **`DB_VERSION` 仍为 3**，但 schema 实际已含 v4 列/索引/表；升级依赖 `onOpen → ensureSchema()` 幂等补列而非版本号分支。是否需要把 `DB_VERSION` 提到 4（语义更清晰），或维持现状？注意备份里的 `schemaVersion=4` 与数据库版本号目前不同步。
2. **导入方法名偏移**：契约 F 的 `importBackup(payload, mode[, filterJson])` 实际实现为 `importBackupEx(payload, mode, filterJson)`（重载限制）。请确认前端所有调用点（含自动备份、子集恢复）都已改用 `importBackupEx`。
3. **新记录不写 `source` / `typeCode` / `operator`**：前端 `addRecord` 只写 `time/sample/type/detail/sampleId/code/slot/status`，原生对空 `source` 也不填默认值。因此新记录这三列为 `NULL`，记录表的「来源/操作人」列只在导入数据上出现，契约 C 的枚举语义未真正生效。需要 Lead 决定由前端补齐（推荐）还是原生按写入路径推断。
4. **`type_code` 无集中映射表**：当前是写入端自由文本、下拉取自已有记录，跨设备筛选依赖命名约定。建议在前端或文档里固定一份「中文 type → type_code」映射。
5. **`operator` 取值来源未定义**（无登录体系）：界面输入、设备名还是留空？
6. **`settings.labelPrintedAt`**：标签过期提示的「已打印」标记是否落库、键名与形状仍需以最终前端实现确认。
7. **`records_archive` 与总数语义**：`recordsPage()` 只查 `records`，归档行不计入 `total`。若界面上的「记录总数」需要包含归档，请明确口径。
8. **`env` 降采样实现增强**：契约写「1 分钟聚合」，实现是 `ENV_BUCKETS` 逐级加粗桶宽（1→1440 分钟）直到 ≤2000 点，属合理增强，但文档/契约需同步。
9. **`docs/schema.sql` 已严重过期**（v2 快照，槽位还是全库唯一）。建议改为由 `VitalsDbHelper` 常量生成，或删掉以免误用。

---

## 13. 相关文档

- [字段审计](SCHEMA-AUDIT.md) —— v3 字段级审计与映射推导
- [重构报告](SCHEMA-REFACTOR-REPORT.md) —— 三圆盘 schema 改造记录
- [通信协议](PROTOCOL.md) —— 串口/机械板协议
- [测试报告](TEST-REPORT.md) / `docs/database-test-results.txt` —— 插桩测试结果
- `docs/schema.sql` —— schema v2 历史 DDL 快照（**已过期**，勿作为真源，见第 12 节第 9 条）
