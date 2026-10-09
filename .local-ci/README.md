# .local-ci —— 集成与独立验证资产

这个目录存放**不随 APK 发布**的验证工具与测试数据。它们不是应用代码，但需要在仓库里长期存在，
以便任何人在没有真机的情况下复现本次数据层改动的关键结论。

## 内容

| 文件 | 用途 |
| --- | --- |
| `make-backup-fixtures.mjs` | 生成备份夹具（正常／篡改／计数不符／外部 app／高版本 schema／截断／合并／子集／旧形状／含照片／条码冲突） |
| `fixtures/*.json` | 上述夹具，含各自正确的 `checksum`，供原生与浏览器两侧导入校验测试使用 |
| `verify-schema-sqlite.ps1` + `sqlite-check/` | 用**真实 sqlite3** 复现「旧 v3 库 → 新 schema」升级：加列、records 重建、索引、CHECK 约束、ISO 时间归一、归档搬运、DDL 幂等 |
| `updater-check/` | 在 JVM 上用 stub 驱动真实的 `VitalsUpdater`：版本比较、Release 解析、真实下载、SHA-256 校验、域名白名单、签名不一致提示 |
| `run-native-harness.ps1` | 上述 JVM 验证台的环境检查与运行入口 |
| `release-notes-*.md` | 历次 Release 的发布说明草稿 |

## 运行

```powershell
# 1) 生成/刷新备份夹具
node .local-ci/make-backup-fixtures.mjs

# 2) 真实 sqlite3 的 schema 升级验证（26 项断言）
#    注意：本目录下的 .ps1 必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 ANSI 读取而解析失败
& .\.local-ci\verify-schema-sqlite.ps1

# 3) 跨端校验和一致性（浏览器桥 vs 原生夹具）
node vitals-android\tools\bridge-checksum.test.mjs
```

## 已知边界

- `verify-schema-sqlite.ps1` 里的 `sqlite-check/new-ddl.sql` 是**人工转写**的新 schema DDL（与
  `VitalsDbHelper.java` 的 `SAMPLES_COLUMNS` / `RECORDS_COLUMNS` 常量逐字对应）。之所以不自动抽取：
  实现里部分语句由字符串拼接构造，字面量抽取会静默截断。
- 这些脚本**不能替代** `connectedDebugAndroidTest`：覆盖不到 WAL、Android 事务语义与 Java 侧的照片落盘。
  设备级测试仍需真机或模拟器（本机模拟器因缺少 hypervisor 驱动未跑）。
