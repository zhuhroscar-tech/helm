# Helm：个人量化指挥台

[English](README.en.md) · [上手指南](docs/GETTING-STARTED.md) · [配置](docs/CONFIGURATION.md) · [架构](docs/ARCHITECTURE.md) · [参与贡献](CONTRIBUTING.md) · [路线图](docs/ROADMAP.md)

在网页上输入策略想法，你本机的 Claude 会把它写成 QuantConnect 格式的 LEAN 代码，在你 Mac 上的 **LEAN 引擎**（QuantConnect 的开源回测引擎）里回测，再把结果解读给你。完全免费。

```
网页 (localhost:4377) ──► server.mjs ──► 本机 claude -p ──► mcp/qc-mcp.mjs ──► lib/engine.mjs ──► 本地 LEAN（.NET + Python）
        ▲                                                                        │
        └──────────── 实时显示每一步、回测曲线、统计、订单和结论 ────────────────┘
```

## 启动

```
cd helm        # 这个仓库的目录
npm start
```

然后打开 http://localhost:4377

- **环境体检**：`/api/health`（网页上缺东西时会直接提示）逐项检查 Claude Code 命令行、.NET、LEAN、Python 虚拟环境、libpython（这几项必需），以及行情数据、qlib 引擎、qlib 美股数据（可选），缺什么、怎么补都写在结果里；`/api/health?refresh=1` 强制重新检查。
- 端口被占用时会提示「Helm 可能已经在运行了」，并给出换端口的写法：`PORT=4378 node server.mjs`。
- Ctrl+C（SIGINT / SIGTERM）会优雅退出：不再接新连接，结束网页的事件流，终止网页发起的 claude 对话；回测、研究和参数敏感性是独立进程，会继续跑完。模拟实盘的每日运行在服务进程里，正在跑的那一次会被打断，下次启动后马上补跑（不等 3 小时，也不会重复下单）。

## 安装（已经装好，换电脑时参考）

1. Node 20+，以及已经登录的 `claude` 命令
2. .NET 10 SDK，装在 `~/.dotnet`：
   `curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir ~/.dotnet`
3. LEAN 源码，然后编译：
   ```
   git clone --depth 1 https://github.com/QuantConnect/Lean.git engine/Lean
   ~/.dotnet/dotnet build engine/Lean/Launcher/QuantConnect.Lean.Launcher.csproj -c Release
   ```
4. Python 3.11 环境（版本按 LEAN 官方锁定）：
   ```
   uv venv --python 3.11 engine/.venv
   uv pip install --python engine/.venv/bin/python numpy==1.26.4 pandas==2.3.3 scipy==1.13.1 matplotlib==3.8.4 scikit-learn==1.6.1 statsmodels==0.14.6 yfinance
   ```

## 数据

- 来自 Yahoo Finance 的**美股和 ETF 复权日线**，从上市日到上一个交易日。
- 回测时会自动下载策略里用到的代码，20 小时内不会重复下载。
- 没有分钟数据、期权、期货、外汇、加密货币。
- qlib 研究引擎另有：S&P 500 / 纳斯达克 100 的历史成分股、SEC 财报基本面（只在想法检验和因子研究里用，LEAN 策略里通过导出的打分 `HelmSignals` 间接使用）。
- FRED 宏观序列（利率、信用利差等）：`fetch_macro` 下载，策略里用 `HelmMacro` 读，只给当时已经公布的值（FRED 是修订后的数值，不是初值）。
- 自建数据集：想法需要 Helm 本地没有的数据（事件名单、公司属性、公告日期等）时，agent 先上网查公开来源，用 `save_dataset` 整理成表存到 `helm/custom/<名字>.csv`（附 `.meta.json`：来源、版本、哈希、备注），策略里用 `HelmDataset` 读。每行必须有 `available_date`（信息第一次公开的日期）和来源，读取时只给严格早于当天公开的行；行只能来自抓取的网页，不许凭记忆填。数据是网上整理的，可能不全或有错，回测页会固定提醒，并记录用了哪个版本。不收集具体个人的健康、宗教等敏感特征。「股票池与数据」页可以查看（只读）。
- LEAN 的基准固定读小时数据，所以下载器会用日线合成一份每天一根的小时文件，只给基准用。

## 结构

| 路径 | 作用 |
|---|---|
| `server.mjs` | 本地服务器：页面、只读数据接口、启动 claude 并把输出流式转给网页 |
| `mcp/qc-mcp.mjs` | MCP 服务器，Claude 通过它建项目、写代码、回测、读结果 |
| `lib/engine.mjs` | 本地引擎：项目和文件存储、语法检查、启动 LEAN、解析结果 |
| `lib/paper.mjs` | 模拟实盘：冻结回测代码，每个交易日收盘后用最新数据重跑，算前向收益；Alpaca 模式下同步调仓 |
| `lib/alpaca.mjs` | Alpaca 模拟盘客户端（地址写死为 paper-api，不能连实盘） |
| `lib/run-backtest.mjs` | 独立的回测进程，网页或 agent 退出都不影响它跑完 |
| `engine/fetch_data.py` | Yahoo 数据转 LEAN 格式 |
| `engine/helm_data.py` | 策略里读历史成分股、研究打分、FRED 宏观序列、自建数据集（`HelmUniverse` / `HelmSignals` / `HelmMacro` / `HelmDataset`） |
| `engine/lint_strategy.py` | 回测前的代码检查（只解析不执行） |
| `lib/macro.mjs` | 下载 FRED 宏观序列 |
| `lib/datasets.mjs` | 自建数据集：校验（每行公开日期、来源、敏感特征检查）、保存、列表、读取 |
| `lib/robust.mjs` | 回测稳健性分析（分段稳定性 / 成本压力 / 市场状态，只读已保存的结果）和参数敏感性的参数发现、变体取值、判定 |
| `lib/drift.mjs` | 模拟实盘「是否在预期内」：用来源回测的日收益做块自助法（只读） |
| `lib/journal.mjs` | 想法记录：把想法检验、回测、验证期、模拟实盘按时间排成一张表（只读） |
| `lib/fingerprint.mjs` | 回测指纹：记下代码和数据的版本，发现“代码相同但数据变了” |
| `lib/qlib.mjs` | 启动 qlib 研究引擎、读结果、把股票池和信号转成 LEAN 格式 |
| `lib/agent-perms.mjs` | agent 的敏感路径黑名单（见「安全」） |
| `public/i18n.js`、`public/i18n-dict.js`、`lib/i18n.mjs` | 界面语言：网页的文字字典（中 / 英）和服务端提示的英文表 |
| `public/calendar.js`、`lib/market-calendar.mjs` | 美股休市日历（按规则推算 + 已知的临时休市日），网页和服务端共用一份 |
| `engine/qlib_research/` | qlib 研究引擎（原 quant-strategy）：历史成分股、因子、LightGBM、检验、验证期。`docs/` 里是方法说明 |
| `engine/qlib_bridge.py` | Helm 和研究引擎之间的桥：股票池导出到 LEAN、读研究结果、导出信号 |
| `agents.json` | 5 个 agent 的定位和提示词，可以直接改 |
| `workspace/CLAUDE.md` | 所有 agent 共用的工作规则 |
| `projects/` | 你的策略项目。每次回测都保存代码快照、结果和日志 |
| `data/threads/` | 对话记录 |

## 外部依赖（不在这个文件夹里）

| 位置 | 是什么 | 为什么在外面 |
|---|---|---|
| `~/.qlib/` | qlib 的美股日线、成分股名单、SEC 财报缓存、S&P 500 历史名单（2.8 GB） | 和 Quant Strategy 项目共用 |
| `/Library/Frameworks/Python.framework/Versions/3.12` | 装了 qlib / LightGBM 的 Python | 系统级安装 |
| `~/.dotnet/` | 运行 LEAN 的 .NET | 系统级安装 |
| `~/.cache/quant-strategy/`、`~/.config/quant-strategy/` | 研究引擎的缓存和 SEC 请求设置 | 引擎沿用的旧目录名 |

## 安全

- 服务只监听 127.0.0.1，所有请求都校验 Host。所有会改状态的请求（POST/DELETE）还必须同时满足：带上本次启动随机生成的页面令牌（`X-Helm-UI-Token`，只注入在网页 index.html 里，不进任何子进程的环境变量或文件）、Origin 必须是本站、浏览器发的 `Sec-Fetch-Site` 必须是 same-origin，否则返回 403。服务重启后旧页面要刷新一次。只读的 GET 接口不需要令牌。
  这能挡住别的网站和不知道令牌的本机脚本，但本机进程仍可以先 GET 首页拿到令牌，所以它是纵深防御，不是对本机恶意程序的隔离。agent 交接用的 `/api/handoff` 用另一把只通过环境变量传给 MCP 的令牌。
- 网页上能直接做的写操作只有：新建项目、语法检查、运行回测、改回测标签、参数敏感性、qlib 研究、模拟实盘；改代码和删除都要经过 agent。
- 删除文件或回测默认禁止，要在输入框下方打开“允许删除”，而且只对那一条消息生效。
- Agent 改文件、跑命令都要经过审批规则（见「agent 自己补功能」）。规则直接放行的命令（测试、只读 git / ls）和 agent 可以直接改的代码（研究引擎、新建测试）只在 macOS 沙盒里运行（`lib/exec-sandbox.mjs`）：读不到密钥和凭据、连不上正在运行的 Helm（拿不到网页令牌、不能自己批准自己）、改不了仓库。沙盒不可用时这些都改为要你批准。
- Agent 的 Read/Glob/Grep 有敏感路径黑名单（`lib/agent-perms.mjs`，通过 `--disallowedTools` 的 `Read(...)` 规则，`~/` 和 `//绝对路径` 两种写法都加）：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config`、`~/.kube`、`~/.docker`、`~/.netrc`、`~/.npmrc`、`~/.pypirc`、`~/.git-credentials`、shell 历史、整个 `~/Library`（含钥匙串）、Claude 的凭据/设置/其它会话记录、任何位置的 `.env` / `.env.*` / `*.pem` / SSH 私钥，以及仓库里的 `data/secrets`、`data/threads`、`data/server.log`。仓库代码、`projects/`、`engine/`（含 LEAN 数据）、`data/qlib` 照常可读。这是黑名单不是白名单：其它位置仍可读，WebFetch 也没有限制域名。
- Alpaca 密钥保存在 `data/secrets/alpaca.json`（权限 0600）。网页接口从不返回 secret；agent 的 Read/Grep/Glob 被禁止访问这个目录；LEAN（会运行 agent 写的策略代码）跑在 macOS 沙盒（sandbox-exec）里，同样读不到这个目录；环境变量里的 `ALPACA_*` / `APCA_*` 不会传给 agent 和 LEAN。开始/停止模拟和连接 Alpaca 只能在网页上操作，agent 只能查看。
- Agent 写的策略代码在 LEAN 里跑在 macOS 沙盒（sandbox-exec）中：不能联网（包括本机 127.0.0.1），不能读用户目录、仓库、别的项目和尝试记录，只能写本次回测的输出目录和一个用完即删的临时目录；环境变量只传白名单（不含任何密钥和 HELM_*）。回测前还有一道代码检查（`engine/lint_strategy.py`），拦下 os/requests/open/eval 之类的写法——它只是第一道关，真正的边界是沙盒。

- 页面带内容安全策略（CSP）：脚本只能来自本站的文件（没有内联脚本、不能 eval），只能连本站接口，不能被别的页面嵌进 iframe；所有响应带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。页面令牌在 index.html 里，这一层是为了万一哪里漏了转义，注入的脚本也跑不起来。改页面时不要加内联 `<script>` 或 `onclick=` 这类属性（`server-auth.test.mjs` 会查）。
- 所有接口的请求体都会校验（必填字段、projectId 必须是正整数、字符串长度、数字、布尔、数组大小）；不合格或 JSON 坏了返回 400 和一句中文原因，不会变成 500。

## 网页

- **离线渲染**：页面不依赖任何 CDN 或网络字体，图表是自己画的，规则说明里的 Markdown 用内置的渲染器；断网也能打开。
- **规则说明**：agent 把想法写成项目里的 `spec.md`（股票池、进场出场、仓位、调仓、成本、基准）。项目页有「规则说明」标签，回测页也有一个，显示的是这次回测存档的那一份；早期回测没有存档就显示“还没有规则说明”。
- **对比**：在回测列表里勾选 2–4 个已完成的回测，点「对比」并排看。
- **想法记录**（`#/journal`）：想法检验 → 开发期回测 → 统计检验 → 验证期 → 模拟实盘，按时间排成一张表，只汇报已保存的数字，不算新的统计量。
- **搬回 QuantConnect**：回测页的对话框，一键复制 `main.py` 和项目里其他 `.py` 文件；代码用到 `helm_data`（`HelmSignals` / `HelmUniverse` / `HelmMacro`）时会提示不能直接在 QC 上运行。

## 语言（中文 / English）

- 侧栏底部「外观」下面有「语言」：自动 / 中文 / English。自动 = 浏览器语言以 zh 开头用中文，否则 English。选择存在浏览器的 `localStorage`（`helm.lang`），不刷新页面就整页切换，同时设置 `<html lang>`，数字和日期也按语言格式化。
- 网页上所有文字都走 `t(key, vars)`：`public/i18n-dict.js` 放中西两份（中文是源，键必须一一对应），`public/i18n.js` 是查表和切换。新增界面文字时两边都要加；`node test/i18n.test.mjs` 会查键一致、占位符一致、页面里不再有写死的汉字。
- 发给 agent 的聊天 / 想法请求带 `lang`（`zh` 或 `en`，服务器校验）。英文时服务器给 agent 多加一句「用英文回复」；agent 的提示词（`agents.json`、`workspace/CLAUDE.md`）和交接用的内部文字仍是中文，不翻译。
- 服务器和 MCP 返回给用户看的提示（校验错误、环境体检、模拟实盘的跳过原因、统计关卡说明等）按请求头 `X-Helm-Lang` 返回英文，表在 `lib/i18n.mjs`；没有对应英文的原样返回中文，不会出错。体检的每一项带英文名 `en` 和英文补救办法 `hintEn`。
- 已知限制：Python 研究引擎（`engine/qlib_research/`）生成的研究结论文字、因子的中文说明和报告是中文，不翻译；对话里已有的消息保持 agent 当时的语言；你自己写的项目名、想法、代码注释原样显示。

## 从想法到策略

项目页顶部的流程条：**想法检验 → 回测 → 统计检验 → 模拟实盘**。

- **想法检验**（选股类想法的第一步）：研究员把一句话想法写成 1–3 个 qlib 因子公式（方向事先定好），`test_idea` 在历史成分股上**只用开发期**检验：各持有天数的 IC 和 Newey-West t 值、五分组收益（扣成本）、逐年稳定性、和已知因子（动量、反转、波动率、规模、E/P）的相关性，结论是「有信号 / 信号弱 / 没有信号」。每个检验过的公式都记进登记表，同一个股票池试得越多，显著性门槛越高；没有信号就到此为止。
- 有信号：导出这个公式的每日打分（`HelmSignals`），写成 LEAN 策略，先回测开发期；回测会记下信号来自哪次检验，列表里点来源标签能跳回去。
- **完整研究**（高级）：没有具体想法时，系统扫描 Alpha158 / 基本面因子并训练 LightGBM。
- 少数 ETF 的择时想法不走 qlib，直接写 LEAN。

## 稳健性与参数敏感性

回测页的「稳健性」标签，全部只用这个回测已经保存的结果（权益曲线、基准、订单），不重跑 LEAN、不联网：

- **分段稳定性**：按年、按三等份看收益和夏普是不是靠某一段撑起来的。
- **成本压力**：按成交记录估算换手，加上额外成交成本（5 / 10 / 25 / 50 bp）后收益和夏普怎么变。
- **市场状态**：按趋势 × 波动把交易日分类，各类状态下的表现；样本太少的状态不下结论。

**参数敏感性**（同一个标签里，点按钮才运行）：策略里想让它微调的参数，要用 `self.get_parameter("名字", 默认值)` 声明（默认值必须是数字常量，默认值为 0 的没法按比例微调）。Helm 用这个回测冻结的代码快照，把每个参数分别 ×0.8、×1.2 各重跑一次（一次只改一个），最多 6 个参数，在独立进程里跑，关掉页面也不影响；结果判成「稳 / 敏感 / 方向翻转」。

- 验证期的回测不允许做（对验证期重跑变体就是多看几次）。
- 变体只是诊断：结果只放在 `backtests/<id>/sensitivity/`，不是回测记录，不进回测列表，不能标主版本，也不能开始模拟实盘，**不计入尝试次数**。挑最好看的变体来用，就是调参过拟合。
- 每次运行有自己的任务编号；被新一轮运行替换后，旧进程不会再写文件。超过 25 分钟没更新的任务在读取时显示为中断，下一次运行会替换它。

统计检验（`/api/data/backtests/validate`，每次约 100–200 ms）有一个最多 100 条的内存缓存，键里包含回测文件、尝试记录、验证期记录和项目声明的检验模式，任何一个变了就重算，结果和不缓存时完全一样。

## 模拟实盘

在一个跑完的回测页面点「开始模拟实盘」，选：

- **Helm 内部模拟**：不需要账户，Helm 自己记账。
- **Alpaca 模拟账户**：先在 app.alpaca.markets 切到 Paper 账户生成密钥，在弹窗里连接。之后每个交易日收盘后按策略的目标权重提交市价单（下一个交易日开盘成交）。一个 Alpaca 账户同时只跟一个模拟。安全规则：
  - **只能从主版本（main）回测开始**：agent 标的主版本要通过统计检验；你在回测页点「设为主版本」选定的直接算（你的决定）。其他回测只能用内部模拟（已经在跑的模拟不受影响）。
  - **只买卖这个模拟自己买入的仓位**（client_order_id 以 `<sessionId>-` 开头、有成交的订单），账户里其他持仓一律不动；开始时会列出这些持仓（“不会动这些持仓”）。
  - **策略资金 = 起始资金 + 这个模拟自己的已实现和未实现盈亏** = 归属它的现金 + 它自己持仓的市值，不含账户里别的持仓。起始资金默认 = 开始时的账户净值 − 已有持仓市值；账户里只有这个模拟时，就等于账户净值。
  - **数据下载失败或过期**（不是最新交易日、某个目标的日线没更新）的那天一笔都不下，只记录原因，3 小时后自动重试。
  - Alpaca 显示不可交易的目标跳过，其他照常。

模拟页有两块只读的信息：

- **运行情况**：冻结日、冻结后的收益（和基准同期比）、上次运行、下次运行（估计值，已跳过周末和休市日）、最近 10 次运行（成功 / 跳过 / 失败和原因）。
- **是否在预期内**：用来源回测的日收益做块自助法，看冻结后这 n 个交易日的累计收益落在回测可能范围的哪个位置：在预期范围内 / 低于 / 高于。冻结后不到 20 个交易日显示「太早，还看不出来」。它只检验“和回测是否一致”，不证明策略有效。

代码在第一次运行那天冻结，冻结之后的收益才是样本外。Helm 每 10 分钟检查一次，美东交易日 17:15 之后自动运行（Helm 要开着；关着的话下次启动会补跑最新一天）。美股休市日（元旦、感恩节等，见 `public/calendar.js`）不算数据过期，也不会白跑；临时休市日历里没有，那天按“没拿到新数据”处理，3 小时后重试。每次运行的结果追加到 `projects/<id>/paper/<sessionId>/log.jsonl`：成功、跳过（`skipReason`）和失败（`failed: true` 加 `error`）都记，同一个原因连续失败只记第一条。

## 搬回 QuantConnect

项目里的 `main.py` 可以直接粘贴到 QuantConnect 网页 IDE 运行（回测页的「搬回 QuantConnect」对话框会帮你复制，并列出要一起添加的文件）。用了 `HelmSignals` / `HelmUniverse` / `HelmMacro` 的策略读的是本机文件，不能直接在 QC 上运行。注意 QC 云端的数据是未复权的原始价格，结果会和本地有些差别。

## 调参（防过拟合的超参数搜索）

两个引擎各有一个调参工具，agent 要调参时只能用它们，不能自己手动反复改参数回测：

| | LEAN 策略（`tune_backtest` / `read_tuning`，回测页「稳健性」也有按钮） | qlib 研究（`start_research` 的 `tune`） |
|---|---|---|
| 调什么 | `self.get_parameter` 声明的参数（默认值 ÷2 到 ×2） | LightGBM 的学习率、叶子数、深度、最小样本、L1/L2、采样比例 |
| 怎么搜 | 拉丁超立方随机搜索（默认 16 组，6–40） | 拉丁超立方随机搜索 + 逐轮淘汰（全部候选先在 3 个分散的折上打分，前三分之一再上全部折） |
| 用哪段数据打分 | 只用开发期回测 | 只用各折的验证年；测试年和验证期都不看 |
| 怎么挑 | 参数平台：和最近几组取平均夏普，不挑单点最好 | 验证年平均 IC 最高 |
| 过拟合检查 | CSCV 估计 PBO（开发期切 4–8 段） | CSCV 估计 PBO（按折） |
| 什么时候保持原参数 | PBO > 0.5，或平台夏普提升不到 max(0.1, 10%) | PBO > 0.5，或 IC 提升不到 0.002，或没法估计 PBO |
| 计数 | 每个候选都记进 `trials.jsonl`，去膨胀夏普门槛随之抬高 | 报告里写明调了几组、拟合了几次 |

依据：Bergstra & Bengio (2012) 随机搜索；Li et al. (2018) Hyperband / 逐轮淘汰；Bailey, Borwein, López de Prado & Zhu (2017) PBO 与 CSCV；Bailey & López de Prado (2014) 去膨胀夏普。调参的规则代码（`lib/tune.mjs`、`qs_core.py` 里的 PBO 和选参）属于研究规则，agent 改它们要你批准。

## agent 开工前先问你

agent 需要你拍板的事（会明显改变结果的歧义、二选一的做法），在开始干活之前用 `ask_user` 一次问清：对话里出现问题卡片（最多 4 个问题，每个 2–4 个选项，第一个是它推荐的，带说明），选完点「回答并继续」它就接着做；也可以直接在输入框里写回答，或「跳过，按推荐的做」。15 分钟没回答就按推荐的继续，并在总结里说明。agent 不再把问题写在回复末尾等你回复。顶栏「等你处理」同时数待回答的问题和待批准的改动。

## agent 自己补功能（要删东西时先问你）

agent 遇到工具或引擎缺功能、有 bug 时，会先自己改代码补上，而不是只汇报「做不了」。每次改文件、跑命令都会先经过 Helm 的审批（`claude -p --permission-prompt-tool mcp__qc__approve` → `lib/change-policy.mjs`）：

| | 范围 |
|---|---|
| 直接做（只在沙盒里运行） | 改研究引擎 `engine/qlib_research/`（研究规则部分除外）、新建测试文件，写技能 `workspace/.claude/skills/<名字>/SKILL.md`（开头只有 name / description）；跑快速测试和只读 git / ls 命令 |
| 先问你 | 删除 / 清空 / 移动文件；改在沙盒外运行的平台代码（`lib/`、`mcp/`、`engine/` 顶层脚本、`run.sh`）和已有的测试；要跑真实 LEAN 的测试（`npm test` 完整模式）；改 `server.mjs`、网页、`agents.json`、权限和安全代码、`workspace/CLAUDE.md`、`package.json`；改研究规则（统计门槛、多重检验登记、验证期、尝试次数，会给你看差异）；安装任何东西（pip、npm、插件、MCP）；其它命令 |
| 不行 | Helm 文件夹以外、`.env` 和密钥、`data/`、`projects/`（项目代码走 `write_file`）、`.git/`；总控不改代码，交给策略工程师 |

- 需要你批准时，对话里出现卡片（差异、命令、agent 刚才说的理由），顶栏显示「待你批准」。可以「允许」「本对话都允许」（同一个文件 / 同一条命令不再问）或「拒绝」并附一句话；15 分钟没处理自动拒绝。被拒绝后 agent 不会换办法绕过。
- 安全网：改每个文件之前先存原文（`data/changes/`，不碰 git）；agent 改完调用 `verify_changes` 跑相关测试，没过就把这次的改动全部恢复，agent 读失败输出再修；运行结束时还有没检查的改动，Helm 自己再跑一次。
- 「Agents → 改动」列出每次改动（差异、测试结果、审批记录），可以一键撤销。改到 `server.mjs` / `lib/` / `agents.json` 的要重启 Helm 才生效，会提示。
- 规则管「改哪个文件」，沙盒管「改完的代码运行时能做什么」。agent 可以直接改的代码只会在沙盒里运行：agent 跑的测试、改完后的自动检查用 agent 沙盒（只能写临时目录，只能连本机、连不上 Helm）；qlib 研究、想法检验、股票池导出用研究沙盒（可以联网下载 SEC 数据，但只能写 `projects/<id>/research/`、缓存和导出目录，读不到密钥、连不上 Helm）。路径按真实路径、不分大小写比较（`lib/Stats.mjs` 和 `lib/stats.mjs` 是同一个文件）。启动时会用 `/usr/bin/true` 试一次沙盒规则，不能用（不是 macOS、规则编译失败、或设置了 `HELM_EXEC_SANDBOX=off`）时自动收紧为要你批准。

## 测试

- `npm test`：完整模式，每个测试文件一个进程。除了下面的快速模式内容，还会跑真实 LEAN：冒烟测试里的一次回测（约半分钟，覆盖验证期编号、尝试记录、删回测不减次数、main 关卡）、模拟实盘（内部模拟跑真实 LEAN，Alpaca 模式用假的模拟盘服务器，不联网）、指标一致性的两次真实回测、LEAN 沙盒测试（`sandbox.test.mjs`），以及参数敏感性的真实 LEAN 参数通路检查（`--parameters` 能不能真的改到策略里的参数）。**这一项只在完整模式跑。**
- `npm test -- --fast`：不跑 LEAN。覆盖统计检验、一致性核对（合成数据）、回测指纹、Alpaca 客户端（假 fetch）和模拟实盘安全规则的纯函数、「是否在预期内」、想法记录、FRED 宏观、美股休市日历（和 NYSE 2019–2027 公布的休市日核对，网页和服务端逐小时一致）、稳健性分析、参数敏感性（用替身 LEAN：发现参数、变体取值、判定、拒绝情况、任务编号、读取无副作用）、统计检验缓存、服务鉴权与健壮性（400 而不是 500）、前后端契约（按 `app.js` 真实请求打后端；10 个有副作用的路由跳过不发）、静态检查、项目删除等。LEAN 沙盒测试在快速模式里跳过。
- `node test/alpaca.test.mjs` 等任何测试文件可以单独跑。
- 测试全程用临时目录，不会动真实项目和记录。

## 许可

[MIT](LICENSE)。LEAN（Apache 2.0）和 qlib（MIT）不在这个仓库里，按各自的许可证另行安装。
