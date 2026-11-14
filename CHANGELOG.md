# 更新记录

## 2026-11-14（还没提交）

### 性能和健壮性（代码审查 P1 / P2，`docs/REVIEW-2026-11-14.md`）
实测（项目 1002 最大的回测，7720 个曲线点；改前 → 改后，每项都和原来的写法逐位比较过结果）：

| | 改前 | 改后 |
|---|---|---|
| 统计检验 `validateResult` | 184 ms | 68 ms |
| 风险调整模式（配对自助法） | 654 ms | 98 ms |
| 稳健性分析 `analyzeRobust` | 71 ms | 12 ms |
| 市场状态标签 `regimeLabels` | 63 ms | 0.6 ms |
| 打开回测页：read / chart / orders | 各 16–18 ms | 0–1.5 ms（缓存命中） |
| 日线导出（每只股票，Python） | 约 100 ms | 13–17 ms |

- `lib/stats.mjs`：均值 / 标准差改用普通循环（Float64Array 上的 reduce 慢约 6 倍）；新增 `blockBootstrapIdx`，配对检验按同日下标算夏普，不再每次复制两个数组。数值和原来逐位相同。
- `lib/robust.mjs`：`regimeLabels` 的 252 日中位数改成有序窗口（二分插入 / 删除），不再每天重新排序；结果完全一样。
- `lib/engine.mjs`：LEAN 结果文件按「路径 + 修改时间 + 大小」缓存最近 3 个（`loadResult`），文件变了就重读。
- `lib/paper.mjs`：日线 zip 的读取按「路径 + 修改时间 + 大小」缓存，一次运行里同一只股票不再开多个 unzip 进程。
- `engine/fetch_data.py`、`engine/qlib_bridge.py`：生成 LEAN 日线行改成整表计算（`lean_lines` / `lean_rows`），和逐行 iterrows 的输出完全一样（含四舍六入五成双、负价跳过、缺失成交量）。S&P 500 全量导出约 150 秒 → 约 20 秒。
- `engine/helm_data.py`：`HelmUniverse.members` 同一天只算一次（返回副本）。
- `server.mjs`：对话列表按文件修改时间缓存摘要，没变的对话不再整份解析。
- **交易日按日历判断**（`stats.mjs` / `robust.mjs`）：以前把「基准收盘价和前一天一样」当成休市，会丢掉真实交易日（本机 22 个回测共 788 天）。现在用美股休市日历；`public/calendar.js` 补上 1994 年以后的全部临时休市（9·11、飓风桑迪、几次国葬）和「马丁·路德·金日 1998 年起才休市」。核对过：日历判为休市的日子，真实数据里基准都没有变化；22 个真实回测的指标一致性全部照常通过。统计检验的年数和日收益会有小变化。
- **落盘**：新增 `lib/fs-atomic.mjs`。写 JSON 先 fsync 再 rename（断电后不会是空文件）；追加 `.jsonl`（尝试记录、模拟实盘记录）前先补上崩溃留下的半行的换行（以前半行会把下一条也弄坏，尝试次数少算）；损坏的文件记日志，不再悄悄当成「没有」。`engine.mjs`、`paper.mjs`、`qlib.mjs` 都改用它。
- **主版本正好一个**：改别的回测的角色时在那个文件的锁里重读、只改 role（`patchMeta`），不再整份写回旧内容（会盖掉回测进程刚写的「已完成」和摘要）；「设主版本 + 降级其它主版本」在项目级锁里进行，并发时结果总是正好一个主版本。回测进程的 `save`、`updateBacktest`、`setMainByUser` 都在文件锁里读改写。
- **停止模拟不会被撤销**：`setSession` 和 `stopSession` 用同一把文件锁，运行中途点停止，写回时不会把状态改回 active。
- **同时运行的 agent 有上限**：默认 8 个（`HELM_MAX_RUNS`），超过返回 429；交接也会收到这个错误而不是 500。
- 长轮询（等用户批准 / 回答）改用 `res` 的 close 事件：MCP 进程崩了，卡片会马上撤掉，不再挂 15 分钟。
- 研究任务编号的随机部分 1 字节 → 4 字节（同一秒启动两个任务不会撞号）。
- `test/all.mjs`：清单外的 `*.test.mjs` 自动加入；每个文件最多跑 10 分钟（`HELM_TEST_TIMEOUT_MS`）。
- 测试：新增 `test/efficiency.test.mjs`（17 项：提速前后逐位相同、日历、半行保护、损坏可见、并发设主版本正好一个、降级不盖掉摘要、结果缓存失效、Python 整表 = 逐行）。几个测试的合成数据原来在休市日也有涨跌（真实的 LEAN 结果不会），改成只在交易日变化（`smoke.mjs`、`robust-analysis.test.mjs`、`audit-fixes.test.mjs`）。
- 已知：`test/tune.test.mjs`（调参，另一轮改动）里「推荐参数在真实最优附近」不稳定：抽样种子来自随机的任务编号，6 次里有 1 次推荐 11（要求 14–18 左右），和这一轮的改动无关。

### 代码审查的 4 个最高优先级问题（`docs/REVIEW-2026-11-14.md`），以及手动设主版本
- **agent 绕过审批**：新增 `lib/exec-sandbox.mjs`。规则直接放行的 Bash 命令通过审批返回的 `updatedInput` 改写成在 macOS 沙盒里跑；改完后的自动检查（`lib/changes.mjs`）、qlib 研究 / 想法检验 / 股票池导出 / 桥接脚本（`lib/qlib.mjs`）也在沙盒里跑，环境变量去掉密钥。沙盒：读不到密钥和凭据、连不上 Helm 的端口（不能拿网页令牌自己批准自己）、只能写临时目录（研究另可写 `projects/<id>/research/`、缓存、导出目录）。`lib/change-policy.mjs`：只有沙盒里运行的代码可以直接改（`engine/qlib_research/`、新建测试、技能）；`lib/`、`mcp/`、`engine/` 顶层脚本、`run.sh`、已有测试改为要批准；路径按真实路径 + 不分大小写比较；`git diff --output` / `--no-index`、绝对路径、`~`、`..` 不再算只读命令；跑真实 LEAN 的测试命令要批准；技能开头有 name / description 以外的设置要批准；`helm_data.py`、`lint_strategy.py`、`exec-sandbox.mjs` 和验证期记录相关函数列入受保护定义。沙盒不可用时全部收紧为要批准（`HELM_SANDBOX_ASSUME` 只给测试用）。**沙盒规则只在 Linux 上检查过文本，没有在 Mac 上真实运行过**。
- **自助法首尾权重**：`lib/stats.mjs` 的块自助法改成循环块（Politis–Romano），首尾的日子和中间一样会被抽到；同样的亏损放在中间还是最后，置信区间中点从差 1.18 变成差 0.01。现有回测的统计检验数字会有小变化。
- **策略能读到未来数据**：`engine/helm_data.py` 的完整数据改存在下划线属性（`_by`、`_dates`、`_spells`、`_values`、`_avail`）；`engine/lint_strategy.py` 新规则 `private-attr`：不许在 self 以外的对象上读下划线属性、不许 getattr 下划线名字、不许从 helm_data 导入下划线名字、不许继承 helm_data 的类。现有策略没有误报。
- **验证期记录丢条目**：`lib/engine.mjs` 新增 `withFileLock`（进程内排队 + `<file>.lock` 跨进程锁，30 秒没释放视为残留）；`logHoldout` 和补记验证期都在锁里读改写。3 个进程同时登记 24 个回测，24 条全在，编号 1–24。
- **手动设主版本**：回测页和主版本诊断里加「设为主版本」按钮，回测列表的角色下拉选「主版本」也走这条路（`POST /api/actions/backtest-main` → `setMainByUser`，只有网页能调）。用户选定的主版本（`mainBy: "user"`）不经过统计检验关卡，可以直接开 Alpaca 模拟；检验面板照常显示数字，措辞改成中性的「没有全部通过」。agent 不能把别的回测标成主版本来顶替它（`update_backtest` 拒绝，跑完通过检验的新 main 先标为候选）；以基准身份跑完的回测仍不能设为主版本（它没记进尝试次数）。`workspace/CLAUDE.md`：agent 照常把它当主版本，不劝换、不反复提醒。
- 测试：新增 `test/p0-fixes.test.mjs`（22 项）；`self-fix.test.mjs` 按新规则更新（新增大小写、平台代码、沙盒不可用、只读命令、LEAN 测试命令、技能设置等检查）；`paper-safety.test.mjs` 关卡文案；`test/all.mjs` 去掉重复的 `dataset.test.mjs`。`npm test -- --fast` 全部通过（Linux，没有 LEAN）。
- 清理：删除 `projects/.trash`（两个 11-09 删除的项目 1001、1003，共 2.1 GB）。`projects/` 现在 115 MB。

### 调参（2026-11-14）
- LEAN：`lib/tune.mjs`（拉丁超立方随机搜索、参数平台选参、CSCV PBO、固定结论规则）+ `engine.mjs` 的 `runTune` / `tuneRead` / `runTuneJob`（后台进程，原参数不重跑，候选的 LEAN 输出用完即删，每个跑成功的候选记进 `trials.jsonl`，source = tune）。只允许开发期回测。MCP `tune_backtest` / `read_tuning`；`POST /api/actions/tune`、`GET /api/data/backtests/tune`；回测稳健性页加「调参」区；想法记录不把调参候选列成已删除的回测，但计入试验次数。
- qlib：`qs_core.py` 的 `TUNE_SPACE` / `lhs_configs` / `halving_folds` / `promote` / `cscv_pbo` / `tune_select`；`qs_pipeline.py` 的 `_tune_lgb`（逐轮淘汰，只用验证年，可续跑）和 `_lgb_params`（模型、置换检验、验证期都用选中的参数）；`--tune N`（冻结键 `tune_trials`）；`start_research(tune=6–30)`；报告写明调参过程、PBO 和「置换检验没有重新搜索」的说明。
- 规则：`workspace/CLAUDE.md` 新增「调参」一节；工程师 / 研究员 / 分析师 / 总控提示词；总控禁用 `tune_backtest`（交给工程师）；`lib/tune.mjs` 和 PBO / 选参函数列入研究规则（改动要批准）。
- 测试：`test/tune.test.mjs`（36 项）；`test_qs_core.py` 新增 5 项。

### qlib 研究：线性对照（ridge）
- `start_research` 完整模式里，LightGBM 之后用同样的特征、标签、折数再跑一个 ridge 回归（L2），惩罚强度在每一折的验证年上选，测试年只预测。报告里多一行：ridge 的滚动 IC、LightGBM 减 ridge 的日 IC 差和 t 值；t < 2 就写明「LightGBM 没有比线性模型好出可测量的幅度」。只是诊断，不换模型、不计尝试次数。

## 2026-11-13（还没提交）

### 交接看得见 + 总控只做调度
- 交接说明还在写的时候（工具参数流式生成，长的要十几秒），对话里就显示「正在写交接说明 → 研究员 · 已写 N 字符」，运行状态条同步；不再只显示「思考中」。
- 总控改成严格的调度者：`agents.json` 里 `orchestrator: true`、`writeOnly: ["spec.md"]`、禁用 17 个执行类工具（回测、想法检验、统计检验、标 main、下载数据等）。它写规则说明、建项目、按阶段 handoff（wait=true）给研究员 → 工程师 → 分析师 → 工程师（验证期）→ 风控官，最后汇总。被总控派活的 agent 只做自己那一段就回报。MCP 侧也拦：调度者 write_file 只能写 spec.md，create_project 不能带代码。

### 研究流水线（#/pipeline）
- 六列：想法 → 想法检验 → 开发期回测 → 统计检验 → 验证期 → 模拟实盘，每列标出通常负责的 agent。
- 每个项目一张卡片：阶段关卡条（过 / 弱 / 没过）、最近结论和关键数字、此刻谁在做、agent 接力链（点圆点打开对应对话）。
- 顶部「此刻」：正在工作的 agent、谁交来的、做了多久，以及正在写的交接。
- 点卡片看完整经过：阶段记录和 agent 任务按时间合在一起，交接说明原文可见；「让总控继续推进」。
- 接口：`GET /api/pipeline`、`GET /api/pipeline/:projectId`（只读）。

### Agents 页（#/agents）
- 名单：定位、模型、任务数、状态，「配置」「新任务」。
- 任务：所有对话（谁做、谁交来、哪个项目、状态），可筛选。
- 单个 agent：统计、可编辑配置（名字、定位、系统提示词、模型、思考深度、示例任务；保存前备份到 `data/agents-backups/`）、自动附加的团队与调度者规则（只读）、实际拿到的工具权限（只读）。
- 接口：`GET /api/tasks`、`GET /api/agents/:id`、`PUT /api/agents/:id`（只能改上面这些字段，要页面令牌）。

### 开工前问用户 + 总控不再拒绝派活（2026-11-13 第三轮）
- 新 MCP 工具 `ask_user`：agent 开工前一次问 1–4 个带选项的问题，工具暂停等用户在网页上回答（`POST /api/ask` ↔ `GET /api/questions`、`POST /api/questions/:id`），回答以文字交回 agent；跳过 / 15 分钟没回答按推荐（第一个）选项继续。自带的 AskUserQuestion 在 `-p` 下用不了，已禁用。
- 所有 agent 的系统提示词加「开工前问，不在结尾问」；总控、工程师、`workspace/CLAUDE.md`、首页想法模板里的「定不下来就问我并停下」改成用 `ask_user`。
- 网页：对话里的问题卡片（单选 / 多选 / 补充 / 跳过）、输入框在等回答时直接发回答、顶栏「等你处理」、回答过的显示为可展开的问答记录。
- 总控：明确「禁用的工具 = 交给专职 agent 做，不是不能做；交接不算绕过规则；不让用户自己去跑、改、提交」，引擎缺功能交给 engineer / researcher；调度者被拒时的提示不再说「不要绕过」。
- 测试：新增 `test/ask-user.test.mjs`；`pipeline-agents` 检查总控提示词。

### agent 自己补功能（2026-11-13 第二轮）
- agent 可以用 Edit / Write / Bash 改 Helm 的代码，每次都经过 `mcp__qc__approve`（`--permission-prompt-tool`）→ `lib/change-policy.mjs`：`engine/ mcp/ lib/ test/` 和技能直接改，测试和只读命令直接跑；删除、核心文件（服务、网页、agents.json、权限、共享规则、package.json）、研究规则（按函数 / 常量识别：统计门槛、多重检验登记、验证期、尝试次数）、安装和其它命令要用户批准；Helm 外、密钥、data/、projects/、.git/ 一律不行；总控（调度者）改文件和跑命令直接禁用。
- `lib/changes.mjs`：每次运行一个改动集，改前存原文；新 MCP 工具 `verify_changes`（跑相关测试，没过自动恢复）和 `revert_my_changes`；运行结束时还有没检查的改动会自动检查；改动结果写进对话消息和 handoff 的回报。
- 接口：`POST /api/approval`、`/api/changes/verify`、`/api/changes/revert-mine`（agent 令牌）；`GET /api/approvals`、`POST /api/approvals/:id`、`GET /api/changes`、`GET /api/changes/:id`、`POST /api/changes/:id/revert`（页面令牌）。
- 网页：对话里的审批卡片（差异 / 命令 / 理由，允许 / 本对话都允许 / 拒绝 + 留言）、顶栏「待你批准」、Agents →「改动」页（规则、改动记录、差异、一键撤销、重启提示）、agent 详情页显示改代码权限。技能（Skill 工具）放开。
- 研究流水线排版修正：卡片改成名字 / 关卡条 / 状态行 / 结论 / 接力链上下排列；看板在常见宽度不再横向滚动；交接说明行的圆点不再被拉长；整页不再横移；点卡片后详情滚进视野，再点一次收起。
- 测试：新增 `test/self-fix.test.mjs`（规则、快照 / 测试 / 自动恢复 / 撤销、审批端到端：放行、拒绝带留言、本对话都允许、超时拒绝、测试失败恢复、总控被拒）。

### 想法检验：`$mkt`
- 新字段 `$mkt`：股票池自己的等权市场日收益（当天成分股、当天和前一天都有收盘价，至少 20 只），只在公式用到时由 `phase_data` 写进这次运行的 Qlib provider。可以写滚动 beta、残差波动这类“去掉市场敏感度”的因子。只用 `$mkt` 的公式会被拒绝。

本次未提交的改动（`git diff --stat HEAD`：17 个已有文件改动，约 +4400 / −1300 行；另有新增文件）。

## 研究有效性
- 新增 `lib/robust.mjs`：回测稳健性分析（分段稳定性 / 成本压力 / 市场状态），只读已保存的结果。
- 参数敏感性：`self.get_parameter("名字", 默认值)` 声明的参数 ×0.8 / ×1.2 重跑；验证期回测拒绝；变体不进回测列表、不能标 main、不能开始模拟实盘、不计入尝试次数。
- 新增 `lib/drift.mjs`：模拟实盘「是否在预期内」（块自助法，不足 20 个交易日显示「太早」）。
- 新增 `lib/journal.mjs`：想法记录，只汇报已保存的数字。
- `lib/stats.mjs` 有小改动；`engine/lint_strategy.py`、`engine/helm_data.py`、`engine/fetch_data.py` 有改动。

## 稳定性与安全
- 请求体统一校验，不合格返回 400（`server.mjs`）。
- 优雅退出（SIGINT / SIGTERM）；端口被占用时给出明确提示。
- 参数敏感性：每次运行有任务编号，旧进程被替换后不再写文件；读取接口不再写文件（陈旧任务只在返回值里标成中断）。
- 统计检验（`/api/data/backtests/validate`）加了最多 100 条的内存缓存，键含回测文件、尝试记录、验证期记录、项目检验模式。
- `/api/health` 环境体检，缺什么、怎么补。
- `lib/qlib.mjs`、`mcp/qc-mcp.mjs`、`agents.json`、`workspace/CLAUDE.md` 同步调整。

## 网站
- `public/app.js`、`public/index.html`、`public/styles.css` 大幅改动：离线渲染（无 CDN / 网络字体，内置 Markdown 渲染器）、稳健性标签、规则说明标签、回测对比、想法记录页、搬回 QuantConnect 对话框、模拟实盘「运行情况」。

## 新功能
- 自建数据集：缺数据时 agent 上网查公开来源，用 `save_dataset` 存成表（每行带公开日期和来源），策略里用 `HelmDataset` 只读当时已公开的行；新增 `list_datasets` / `read_dataset`、`lib/datasets.mjs`、`GET /api/datasets`；回测指纹和结果页记录数据集版本与来源，并固定提醒「数据是网上整理的」；「股票池与数据」页新增自建数据集列表；agent 提示词新增「缺数据时」流程。
- 稳健性标签；参数敏感性；对比（勾选 2–4 个回测）；规则说明（`spec.md`）；想法记录；「是否在预期内」；搬回 QuantConnect 对话框；`/api/health`。

## 2026-11-12 这一轮（同样还没提交）

### 交接卡片（总控 → 专家）
- 对方的对话在运行中时，交接卡片就能打开它：以前 wait=true 时要等对方做完、工具结果返回后才有 threadId，中途看不到对方在哪。现在运行列表带上「来源对话」（`server.mjs` 的 `runningList` 和 `run_start` 事件），卡片按来源对话 + agent 找到它，并显示「策略工程师正在处理：<标题>」。
- 卡片顶部加了一行流向「总控 → 策略工程师 · 等待结果 / 不等待」。
- 等待结果的交接做完后，卡片下方有「查看 …的回答」，直接展开对方的最终回答，不用再点进去。
- 对方开始或结束时，正在看的对话会刷新卡片。
- 第二轮修订：没有 agent / 未知 agent 的卡片不再显示成「总控 → 总控」；被停止的交接显示「已中断」而不是「已完成」；重新打开对话后，没跑完的交接不再一直转圈；浅色主题下流向那行看得清；回答折叠不会在每次刷新时自己合上；同时交给同一个 agent 两个任务时，两张卡片各认各的对话；工具名前缀兼容带 `-` / `_` 的 MCP 服务名。
- 运行条：总控在等别人时显示「总控在等策略工程师…」和「看策略工程师」；总控已结束、对方还在跑时显示「X正在处理交接的任务…」（这时没有停止按钮）。
- 测试：`test/handoff-card.test.mjs`（卡片渲染 22 项）、`test/handoff-flow.test.mjs`（起真实的 server + 假 claude 做一次真实交接：事件带来源、wait=true 拿回回答、wait=false 立即返回、各种拒绝情况，33 项）。服务端没有发现 bug。
- 已用真实浏览器（Chromium + 假 claude）跑过一次完整交接，深色 / 浅色 / 手机宽度各一遍：卡片、运行条、打开对方对话、「查看来源对话」都正常，控制台没有 CSP 或脚本报错。**没有用真实的 claude 跑过**（真实输出里的流式事件、MCP 工具自己发请求那一段）。
- 已知：总控被停止时，它 wait=true 交出去的任务不会跟着停，要到对方的对话里单独停。

### 统计和稳健性（审计里复现出来的 4 个问题，`test/audit-fixes.test.mjs`）
- **周一开始的回测丢掉第一天的收益**（`lib/stats.mjs` 的 `byDay`）：起点是周一凌晨的一个点，被当成周末丢掉，结果「Helm 日收益复利」和曲线首尾对不上，一个正确的回测会被判成「指标互相矛盾」、标不了主版本；稳健性分析也少算第一天。现在周末 / 周一凌晨的点在周五没有值时补到周五。改完后重新核对了本机 22 个有结果文件的真实回测，指标一致性全部照常通过。
- **基准只覆盖一部分时间时，年化超额算错**（`lib/robust.mjs`）：以前拿策略全程的年化去减基准那一段的年化；现在只在两边都有数据的日子上比。结论里的「N 年跑赢基准」以前按比例乘总年数，会把没有基准的年份也算进去；现在数实际年数，并注明「只有 N 年有基准数据」。
- **零波动曲线的夏普**：`stats.mjs` 和 `robust.mjs` 判断方差为 0 的阈值不一致，前者会被浮点噪声算出天文数字并通过置信区间关卡。统一成 1e-12。真实 LEAN 输出（权益舍入到分）碰不到。
- **想法记录在带空格 / 中文的路径下是空的**（`lib/journal.mjs` 用了 URL 的 pathname）。现在的仓库路径碰不到，换目录就会碰到。

### 模拟实盘
- 运行失败也写进每日记录 `log.jsonl`（`failed: true` + 原因 + 时间，没有净值和持仓）；同一个原因连续失败只记第一条。网页「最近 10 次运行」和「每日记录」、MCP `read_paper_session` 都认这种行；账本、执行偏差、“这个数据日下过单没有”不受影响（有测试）。
- 失败原因里的绝对路径换成相对写法（`projects/…`、`~`）。
- 新增美股休市日历（`public/calendar.js`，服务端经 `lib/market-calendar.mjs` 共用同一份）：休市日的“应有数据日”是上一个交易日，不再被当成数据过期、每 3 小时白跑一次；网页「下次运行」跳过休市日并说明原因（例：11-26 感恩节休市，顺延）。读日线的上限仍按老口径，由数据本身决定有没有那天的日线，日历出错也不会漏掉真实数据。
- 上一次运行被打断（Helm 被关掉或崩了，`session.json` 里留着 `runningSince`）时，下次启动马上补跑，不再等 3 小时。关闭服务时如果有模拟正在更新，会提示一句。纠正了 README 和代码注释里“模拟实盘是独立进程、会继续跑完”的说法：它在服务进程里跑，会被打断。

### 安全
- 首页带内容安全策略（CSP：脚本只许本站文件、不许内联和 eval、只能连本站接口、不能被嵌进 iframe），所有响应带 `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer`。`server-auth.test.mjs` 同时检查页面本身没有内联脚本和 `on*` 属性（否则会被策略拦下）。

### 测试
- 修了一个测试副作用：`server-auth` / `server-robust` / `contract` 三个测试里起的服务会重写真实的 `data/mcp.json`（在别的机器或路径上跑测试时，会把正在运行的 Helm 的 agent 指到测试环境）。现在测试用 `HELM_MCP_CONFIG` 写到临时目录，并有一条检查。这一轮在沙盒里跑测试时踩到了它：`data/mcp.json` 已手动改回本机路径（`command` 暂时写的是 `node`），**重启一次 Helm 会自动重写成正确的内容**。
- 新增 `calendar.test.mjs`（和 NYSE 2019–2027 公布的休市日逐年核对；把 `app.js` 里「下次运行」那段代码取出来和服务端逐小时对比）。
- `paper-safety.test.mjs` 新增 (g) 失败记录、(h) 休市日、(i) 定时任务要不要跑；`server-auth.test.mjs` 新增安全头。
- `npm test -- --fast` 全部通过（在 Linux 沙盒里跑的，没有 LEAN）。CSP 后来用真实浏览器（Chromium）打开首页和对话面板验证过，控制台没有报错；其余页面（回测页、模拟实盘页等）没有逐个打开看。

## 测试
- 新增：`robust.test.mjs`、`robust-analysis.test.mjs`、`sensitivity.test.mjs`、`drift.test.mjs`、`journal.test.mjs`、`contract.test.mjs`、`round2.test.mjs`、`server-robust.test.mjs`、`validate-cache.test.mjs`。
- 修改：`all.mjs`、`lint.test.mjs`、`paper-safety.test.mjs`。
- `npm test -- --fast` 不跑 LEAN；完整模式才跑真实 LEAN（含参数敏感性的真实参数通路检查）。

## 还没在真实 LEAN 上验证
- 参数通过 `--parameters` 传给 LEAN（只有完整模式的 `sensitivity.test.mjs` 会测，本次没有跑）。
- 独立进程里的参数敏感性任务（测试里用替身 `E._hooks` 代替）。
- 完整 `npm test`（两轮都只跑了 `--fast`）。
- 2026-11-12 这一轮的改动（失败记录、休市日历、被打断后补跑）没有用真实 LEAN 的模拟实盘跑过。

## 已知遗留
- FRED 给的是修订后的数值，不是首次公布值。
- CSS 里有重复的选择器：2026-11-12 按「同一个 @media 环境里选择器完全相同」数是 11 个，声明都不一样（一条管布局、一条管外观），没有完全重复的规则，没有动。
- 休市日历只有固定假日和已知的临时休市日（2018-12-05、2025-01-09）；以后新的临时休市要手动加到 `public/calendar.js` 的 `SPECIAL` 里。
- 契约测试跳过 10 个有副作用的路由（`SKIPPED` 列表里实际是 10 个，不是 9 个）。
