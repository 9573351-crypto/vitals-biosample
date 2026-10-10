# 动效规范 · 生息样本库（Android WebView 前端）

本文件是这套界面动效的**唯一基准**：中心思想、状态表、token 取向、验收数字。
数值来自 [onemotion](https://developer.apple.com/design/human-interface-guidelines/) 的冻结 token 表与本机实测，
不是印象。改任何数字必须同时改 `tokens.css` 与本文档，并重跑审计。

## 0 · 中心思想（一句话关于画面）

> **一张样本卡贯穿它的一切状态。**

同一个样本在列表里是一行卡片，被点开时**从它自己的位置长成录入/编辑面板**，
它的位置、尺寸、身份全程存活（carry），而不是"换了一页"。
浏览靠连续性，不靠装饰；所有其它动效只服务于"我做了什么、发生了什么"。

- **首个可见帧（hook）**：`pointerdown` 的同一帧里，被按的卡片就缩到 `scale(.994)`（80ms，跟手，不等动画结束）。
- **每个状态边界靠什么存活（carry）**：被点击的卡片 —— 记录它的 `getBoundingClientRect()`，
  面板用 `MO.shared()` 从该矩形长到最终位置（共享元素 + 弹簧落位）。
- **排除什么**：不用整页交叉淡入、不用粒子/彩带/sparkle、不用 `filter: blur()` 假装运动模糊、
  idle 不做任何呼吸/漂浮装饰动画。
- **token 取向**：偏快（状态反馈 140ms 级）、位移用弹簧而非曲线假装弹性、
  一个强调色（既有品牌蓝），面板进入比状态层慢一档形成层级差。

## 1 · token（冻结值，见 `tokens.css`）

| 档 | 值 | 用在哪（本项目的语义） |
| --- | --- | --- |
| `--dur-instant` | 80ms | 按压反馈、图标/机架格缩放、hover 到位 |
| `--dur-fast` | 140ms | 筛选 chip 选中、导航项状态、输入框边框与焦点、弹窗遮罩淡入 |
| `--dur-base` | 220ms | 卡片/行位移、列表重排、模态面板位移与透明度、toast |
| `--dur-slow` | 340ms | 面板/内容块进入、共享元素长出来的总时长 |
| `--dur-slower` | 500ms | 页面级转场（上限）、字段抖动的完整周期、无限脉冲的周期 |

缓动按 **t80 方向**选，不搞一条曲线走天下：

| token | t80 | 方向 | 本项目用途 |
| --- | --- | --- | --- |
| `--ease-enter` | .215 | 进入（快起慢收） | 面板/内容块进入、遮罩淡入 |
| `--ease-exit` | .944 | 退出（慢起快走） | 面板关闭、toast 消失 |
| `--ease-standard` | .520 | 双向（位置/重排/状态） | 背景色、边框、位移、缩放 |
| `--ease-emphasized` | .398 | 大位移强减速 | 全屏/页面级 |
| `--ease-linear` | .800 | 只给跟手/scrub（本页未用） | — |

弹簧以 CSS 原生 `linear()` 落地（32 步，见 `tokens.css`），必须配 `--dur-spring-*` 使用：
`--spring-snappy`（0.6% 过冲 / 233ms 落位）用于面板与按钮的落位手感，
`--spring-sheet` 用于窄屏侧栏抽屉。`@supports not (transition-timing-function: linear(...))`
时统一退化为 `--ease-emphasized`（**不是** `ease-in-out`）。

幅度：位移只用 `--move-sm(8) / --move-md(16) / --move-lg(24)`，内容位移上限 24px；
`--scale-in .96`、`--scale-pop 1.04`。错峰 20/35/60ms，总量 ≤240ms。

## 2 · 状态表（触发 · 从→到 · 存活元素(carry) · 它做什么 · 时长/曲线 · 什么保持静止）

| 触发 | 从 → 到 | 存活元素（carry） | 它做什么 | 时长 / 曲线 | 什么保持静止 |
| --- | --- | --- | --- | --- | --- |
| 手指按下样本卡 | 静止 → 按下 | 卡片本身 | `scale(1→.994)` | 80ms / standard | 其它卡片、侧栏、标题 |
| 点击样本卡 | 列表 → 录入/编辑面板 | **该卡片矩形** | 面板从卡片矩形长到最终位置（共享元素 + 弹簧），遮罩淡入 | 340ms / spring-snappy（遮罩 140ms / enter） | 侧栏、页面标题、其余卡片 || 关闭面板 | 面板 → 列表 | 同一卡片矩形 | 面板回落到卡片（base 规则走 exit 曲线） | 220ms / exit | 列表内容（不重排、不闪烁） |
| 切换类别 chip | 旧选中 → 新选中 | **筛选条本身** | 勾号 + 底色切换，列表按新集合重排 | 140ms / standard（列表位移 220ms） | 顶部工具栏、侧栏 |
| 输入关键词 | 有结果 → 无结果 | 筛选条 + 计数行 | 列表瞬时替换，空态出现 | 140ms / standard | 搜索框焦点环 |
| 切换视图（侧栏） | 视图 A → 视图 B | 侧栏高亮项 | 新视图 `viewIn` 进入（透明 + 8px 位移）；侧栏保持 | 220ms / enter | 侧栏、顶栏、品牌区 |
| 切换样本库子页签 | 列表 ↔ 入库 | 子页签本身 | 面板内容替换 | 140ms / standard | 搜索框与筛选条 |
| 表单字段无效 | 正常 → 无效 | 该字段 | 抖动（transform）+ 边框转红，播完自动恢复 | 500ms / standard | 其它字段 |
| 出/入库完成 | 处理中 → 完成 | 圆盘槽位 | 槽位脉冲（`scale`/`opacity` 无限） | 500ms / standard 周期 | 其余槽位 |
| 更新检查进度 | 进行中 → 完成 | 进度文字 | 进度条瞬时到位（不做宽度动画，宽度是布局属性） | 无（瞬时） | 面板其它部分 |

### 变形强度上限（按用户反馈收紧）

卡片→面板的变形**不是**全额 FLIP：全额插值在「卡片宽 980px / 面板宽 560px」这种尺寸差下会被放大成
`scale 1.75× + 位移 327px`，读起来是"炸开"。现在统一限幅，只保留"从哪来"的信息：

| 量 | 上限 | 依据 |
| --- | --- | --- |
| 位移 | **≤40px**（`translate3d` 逐轴 clamp） | 与 `--move-xl` 同界；内容位移常规上限 24px，弹窗允许到 40px |
| 缩放 | **0.96–1.04** | 与 `--scale-in` / `--scale-pop` 同界，即"卡片→面板"只做一次轻微缩放 |
| 透明度 | 0.6 → 1 | 变形变弱后需要淡入补足"出现感" |
| 时长 | 220ms（`--dur-base`），曲线 `--ease-enter` | 幅度小了时长也收一档，避免"慢慢扭" |

实测（设备端）：起点 `translate3d(-40px,40px,0) scale(1.04,0.96)`，位移降幅约 8×。
`.local-ci/verify-motion-continuity.mjs` 会断言这三个上限——把强度改回去会立刻 FAIL。

**允许硬切的场景**（其余一律要 carry）：模态关闭后回到原处、错误兜底、
以及 `prefers-reduced-motion` 下的一切。

## 3 · 实现纪律（写代码当下就要守）

- **只动 `transform` / `opacity`**。`box-shadow`、`filter`、`width/height/top/left/margin/padding` 一律不进 transition。
  深度变化（hover 抬升、焦点环）改为**瞬时赋值 + 轻微 scale**，把帧预算留给真正的运动。
- **不写裸时长**：只用上表 5 档。**不写 blanket `transition-duration`** —— 一条规则给整组元素统一时长
  会把各语义层级压平（本项目改动前正是 117 条时长挤成 7 档、CV 0.21 的根因）。
- **不用 `setTimeout` 串联或清理动画**：用 `Animation.finished` / `animationend`。
- **不做无限装饰动画**：唯一允许的无限动画是 `role`/状态为"处理中"的槽位脉冲（且只用 transform/opacity）。
- **动画属性不双写**：共享元素动画期间由 WAAPI 独占 `transform`，结束后交还 CSS 规则。
- **`prefers-reduced-motion`**：时长压到 **1ms**（不是 0，0 会让 `transitionend` 不触发），
  位移/缩放/视差归零，**保留**颜色与透明度反馈。绝不 `animation: none` 一刀切。

## 4 · 验收（先让脚本开口，再请人看）

```bash
# 7 条腿：tokens / curves / compositor / reduced / budget / stillness / interrupt
node <onemotion>/scripts/audit_motion.mjs http://127.0.0.1:8899/index.html --json motion.audit.json
```

改造前 → 改造后（实测）：

| 腿 | 改造前 | 改造后 |
| --- | --- | --- |
| `tokens` | ❌ CV **0.21**，117 条挤成 7 档 | ✅ 67 条 / **4 档 [80,140,220,340]** / CV **0.65** |
| `curves` | ✅ t80 p50 0.50，87% 同一条 ease | ✅ t80 p50 0.52，standard 78% + soft + snap |
| `compositor` | ❌ **22 条**非合成属性（box-shadow×N、filter） | ✅ 只有 transform/opacity（82 条声明） |
| `reduced` | ✅（js ✗） | ✅（css ✓ / js ✓） |
| `budget` | ✅ p95 18.2ms | ✅ p95 17.7ms / 最长 22.1ms / >50ms 0 帧 |
| `stillness` | ✅ | ✅ idle 0 个元素在动 |
| `interrupt` | ⚠️ 计时器写样式 1 处 | ✅ 0 处 |

参考站点量化（技能要求"先量参考"）：developer.apple.com/design/human-interface-guidelines
实测 `dur p50/p90 240/320 · distinct 15 · CV 0.71`。本页 CV 0.65 与之同量级，
但档位更少（4 档）—— 本项目交互面窄于参考站，刻意不为凑数造语义。

**人工部分（不能省）**：CPU 6× 降速拖一遍、真实 reduced-motion 开关、
只用键盘走一遍筛选与视图切换、触屏（平板）实测、放慢到 10% 看卡片→面板的连续性。
