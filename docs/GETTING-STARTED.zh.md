# 上手指南

[English](GETTING-STARTED.md)

从下载代码到跑出第一个回测。

- **只支持 macOS**。在 Apple Silicon 上测试过；Intel Mac 没测过；Linux 和 Windows 不支持（Helm 的沙盒要用 macOS 的 `sandbox-exec`）。
- 第一次安装大约要 2–3 GB 硬盘空间、15–30 分钟（看网速），大部分时间在等下载和一次编译。
- Helm 本身免费、开源，但 agent 用的 AI 模型要花钱：Claude 订阅、Anthropic API 用量，或者兼容接口的用量（第 4 步）。

Helm 全部在你自己的电脑上运行。唯一会发出去的，是你和第 4 步里接入的 AI 模型之间的对话。

## 1. 开始前先装好这几样

| | 怎么确认装了 | 没装的话 |
|---|---|---|
| Node 20 或更新 | `node -v` | `brew install node`，或者去 nodejs.org 下安装包 |
| Git | `git --version` | `xcode-select --install` |
| Claude Code | `claude --version` | `curl -fsSL https://claude.ai/install.sh \| bash`，然后运行一次 `claude` 登录 |
| uv（Python 工具） | `uv --version` | `brew install uv`（安装脚本也会问你要不要装）。没有 Homebrew：`curl -LsSf https://astral.sh/uv/install.sh \| sh`（[说明](https://docs.astral.sh/uv/getting-started/installation/)） |

想用 npm 装也可以：`npm install -g @anthropic-ai/claude-code`。但用 nodejs.org 安装包装的 Node 常会报 `EACCES`（没有权限），这时别加 `sudo`，改用上面的安装脚本。装好后开一个新终端，`claude` 命令才能找到。

agent 实际上是靠 Claude Code 跑的。但不一定要有 Claude 订阅：Anthropic 的 API key，或者 DeepSeek、Kimi 这类兼容接口也可以，第 4 步再选。

## 2. 下载代码，装好回测引擎

捷径：`curl -fsSL https://raw.githubusercontent.com/zhuhroscar-tech/helm/main/install.sh | bash` 会替你做完第 2、3 步（还会提议安装 Claude Code、构建 App），每一步改动之前都会先问。手动步骤如下：

```
git clone https://github.com/zhuhroscar-tech/helm.git
cd helm
scripts/setup.sh --check
```

不想用 git clone 的话，在 GitHub 页面点「Code → Download ZIP」也行。解压出来的文件夹叫 `helm-main`，那就 `cd helm-main`。

加 `--check` 只检查、列出缺什么，不动你的电脑。看过没问题，再正式跑：

```
scripts/setup.sh
```

每一步做之前都会先告诉你要做什么、问你同不同意（加 `--yes` 就不问了）。全程不用 `sudo`，东西只装在你的用户目录和这个文件夹里：

- .NET 10 SDK，装到 `~/.dotnet`（约 650 MB）
- QuantConnect 开源的 LEAN 回测引擎，固定在 Helm 测试过的版本，下载到 `engine/Lean` 并编译（约 950 MB，编译要几分钟）
- Python 3.11 环境，在 `engine/.venv`，装 `engine/requirements.txt` 里列的包（约 370 MB）

脚本的提示跟着系统语言走（`LANG` 以 `zh` 开头就是中文，否则英文）。

不需要 `npm install`，Helm 没有 npm 依赖。

最后看到「必需的组件都已就绪。」（英文系统是 `Required components are in place.`）就是装好了。如果显示「还没装完，仍缺少：…」，按它说的补上，再跑一次 `scripts/setup.sh --check`。

## 3. 启动

```
npm start
```

终端里出现地址 `http://localhost:4377` 后，在浏览器打开它。终端别关，按 Ctrl+C 就是停止 Helm。缺不缺东西不用看终端，网页上会直接告诉你。

第一次打开时会弹出设置向导，带你做一遍和这份文档一样的检查，再指给你看各个功能在哪。以后想再看，点左下角的「设置」，在里面点「设置向导」。

浏览器是中文就显示中文。想换语言或深浅色，点左下角的「设置」，在「外观和语言」里改。

如果还缺什么，页面上会出现环境体检，每一项都写了该运行哪条命令。补好后点「重新检查」。有两种情况要重启 Helm（Ctrl+C，再 `npm start`）：刚装好 Claude Code，或者改了 `.env`。

### 想用 App？

```
macos/build.sh --install
```

会在你的 Mac 上从源码构建一个很小的原生 Mac App，装到「应用程序」。它自己启动服务；关掉窗口后继续在后台跑；agent 等你批准或回答时会发系统通知。没有现成可下载的 App：要自己构建，用的是 ad-hoc 签名，只适合构建它的这台 Mac。详见 [MACOS-APP.md](MACOS-APP.md)。

## 4. 接入 AI

点顶栏的「AI」，有四种方式：

- **自动**：用 `claude` 当前登录的账号。以前在终端里登录过 `claude` 的话，什么都不用改。
- **Claude 订阅**（Pro / Max / Team）：先在终端运行一次 `claude`，用这个账号登录。
- **Anthropic API key**：粘贴在 console.anthropic.com 创建的 key，按用量付费。
- **其它兼容接口**：兼容 Anthropic Messages 格式的地址，比如 `https://api.deepseek.com/anthropic`，模型填 `deepseek-chat`。

保存前 Helm 会先测一次，key 填错当场就会报错，不会等到任务做到一半才失败。key 存在 `~/Library/Application Support/Helm/secrets/ai.json`（早期安装在 `data/secrets/ai.json`），只有你自己的账户能读，网页和 agent 都拿不到。

关于便宜的模型：agent 做一件事要连续调用很多工具，能力弱一点的模型在长任务里容易走偏。如果结果看着不对劲，先换个强一点的模型试试，再怀疑是想法的问题。

## 5. 第一个策略

打开右边的对话框，选「总控」，输入：

> 帮我写一个 SPY 50/200 均线交叉策略，建项目并回测

第一次用很适合拿这个试：只需要 SPY 的行情，会自动下载。

接下来会发生的事：

1. **规则说明**。写代码之前，总控先写一页规则：股票池、什么时候买卖、仓位、交易成本、对比基准、时间范围，存在项目的「规则说明」标签里。花一分钟看一眼，理解有偏差的话在这一步改最省事。
2. **提问**。想法里有会影响结果的地方没说清楚，对话里会弹出一张问题卡片。回答就行；15 分钟没回答的话，agent 会按它推荐的选项继续，并在最后的总结里说明用了哪些默认。
3. **写代码、回测**。策略工程师写 LEAN 代码，先查一遍有没有不安全的写法，然后在你的电脑上回测。第一次要下载行情，会慢一点。
4. **看结果**。回测页有资金曲线、各项统计、每一笔订单，还有稳健性分析。agent 会解释结果，告诉你站不站得住。

agent 做的每一步都会实时显示。它要改 Helm 自己的代码，或者运行常规以外的命令时，会先弹卡片等你批准。删除任何东西还要先打开输入框下面的「允许删除」，而且只对那一条消息有效。

## 6. 想法会走哪条路：LEAN 和 qlib

Helm 里有两个引擎，但它们不是两条并排的路线。**LEAN 是每个想法都要走的主干**；**qlib 只是选股类想法在进 LEAN 之前可以多加的一关**：先看看这个想法在历史上有没有信号。

```
你的想法
 ├─ 择时类：什么时候买卖（比如「SPY 跌破 20 日均线就清仓」）
 │     └──────────────────────────────────────────────┐
 │                                                    ▼
 └─ 选股类：从一大堆股票里挑哪些              LEAN：写策略 → 回测 → 统计检验 → 定主版本 → 模拟实盘
       └→ qlib：检验有没有信号 ──有信号──→ 导出每天的打分，策略照着选股
                  └─ 没有信号 → 到此为止
```

**LEAN**（QuantConnect 开源的回测引擎）：把规则写成代码，在你的电脑上回测，再做统计检验，通过了设为主版本，最后进模拟实盘。不管什么想法，最后都在这里定结论。

**qlib**（微软开源的量化研究框架）：只用于横截面选股，也就是「每个月从标普 500 里挑出某一类股票」这种想法。它有两档：

| | 做什么 | 什么时候用 |
|---|---|---|
| 想法检验 | 研究员把想法写成 1–3 个因子公式，在开发期上看分数高的股票是不是真的涨得更好，给出「有信号 / 信号弱 / 没有信号」 | 选股想法的第一步 |
| 完整研究 | 用 LightGBM 等模型，带检验和验证期，看模型能不能比单个因子做得更好；要几十分钟 | 想法检验有信号之后，还想往深里做时 |

有信号的话，Helm 会把每天的打分和当天真实的指数成分股名单导出成 LEAN 能读的格式，策略按这两样选股（项目说明里写的 `HelmSignals` 和 `HelmUniverse` 就是它们）。这样回测用的是当时真实在指数里的股票，不会只挑到今天还活着的公司。

**没有信号就到此为止。** 这是结论，不是失败。把没有信号的想法硬写成策略，多半只是在拟合噪声。也不要换公式反复试：每试一个公式 Helm 都会记下来，试得越多，判定「有信号」的门槛就越高。

### 在页面上怎么选

首页「写下一个想法」的输入框下面有三个选项，就是在选走哪条路：

| 选项 | 怎么走 | 多久 |
|---|---|---|
| **自动**（默认） | 总控判断：选股类先用 qlib 看信号再进 LEAN，择时类直接进 LEAN | 看想法 |
| **快速** | 只用 LEAN：写代码、回测、统计检验 | 几分钟 |
| **深入** | 选股类直接做完整的 qlib 研究，导出信号后再进 LEAN | 几十分钟 |

拿不准就用「自动」。

项目页顶上的进度条分四步：想法检验 → 回测 → 统计检验 → 模拟实盘。择时类项目不经过 qlib，第一步会显示「跳过」，这是正常的。

qlib 是选装的，装法见下面的 [选装：qlib 研究引擎](#选装qlib-研究引擎)。只做 ETF、单只股票或择时策略，用不到它。

## 7. 接下来可以做什么

**选股类想法**会先做想法检验，见上一节。很多想法的结论是「没有信号」，这省得你去调一个本来就不存在的策略。

**开发期和验证期**。Helm 会把最近的一段数据留着不用。你在前面那段上开发，验证期留到最后只跑一次。反复跑到好看为止就失去意义了，所以每一次尝试 Helm 都会记下来。

**模拟实盘**。在跑完的回测上点「开始模拟实盘」，代码会被冻结，每个美股交易日收盘后用新数据重跑，看它在没见过的日子里表现如何。也可以把订单同步到 Alpaca 的模拟账户。Helm 只连 Alpaca 的模拟盘接口，不可能下真钱的单。

**给团队或客户汇报**。项目页右上角「生成汇报」：先选模板（可以上传公司的 PowerPoint 模板），确认大纲后几分钟出一份 PowerPoint 和 PDF，数字全部取自回测记录。转 PDF 需要 LibreOffice：`brew install --cask libreoffice`。

左侧栏的「想法记录」和「研究流水线」里能看到你试过的所有想法，以及每个走到了哪一步。

**语言**。项目名、规则说明、报告和对话，会用你接入的 AI 在后台翻成界面语言。不懂中文的人也能看懂你用中文做的研究，反过来也一样。译文存在本机，每段只翻一次。

## 选装：qlib 研究引擎

选装，以后再装也行。只有选股研究（想法检验、因子研究）和标普 500 / 纳斯达克 100 股票池需要。ETF 和单只股票的策略用不到。

**1. 一个装了 qlib 和 LightGBM 的 Python。** 用单独的环境 `engine/.qlib-venv`，不要装进 `engine/.venv`（那里的版本是按 LEAN 锁定的）。在 Helm 文件夹里用 uv（安装脚本已经装好了）：

```
brew install libomp                       # macOS 上 LightGBM 需要它
uv venv --python 3.11 engine/.qlib-venv
uv pip install --python engine/.qlib-venv/bin/python pyqlib lightgbm matplotlib yfinance
```

qlib 需要 Python 3.8–3.12。没有 Homebrew 就先跳过 `libomp`；之后 LightGBM 导入失败的话，再用别的办法装 libomp。Helm 会自己找到 `engine/.qlib-venv`；`engine/qlib_research/run.sh --which-python` 会显示用的是哪个 Python。想用别的 Python，在 `.env` 里写 `QS_PYTHON=/python/的/完整路径`（没有 `.env` 就先 `cp .env.example .env`），再重启 Helm。

**2. 数据。** 研究用的行情会自动从 Yahoo Finance 下载，缓存在 `~/.qlib/qs_cache/`。`~/.qlib/qlib_data/us_data` 里的 qlib 美股数据是额外选装的：它提供历史指数成分股，以及后来退市的股票的行情。qlib 自带的下载器可以拿一份社区维护的公开快照：

```
engine/.qlib-venv/bin/python -m qlib.run.get_data qlib_data --target_dir ~/.qlib/qlib_data/us_data --region us
```

注意这份快照很旧（大约到 2020 年 11 月），不是 Helm 维护的，也可能已经下载不到。之后的行情 Helm 会用 Yahoo 的补上；依赖 2020 年以后指数成分股的结果，有 README「数据」一节里说的那些局限。

## 遇到问题

| 看到什么 | 怎么办 |
|---|---|
| 启动时提示「端口 4377 已被占用」 | 多半是 Helm 已经开着了，直接打开 http://localhost:4377；或者换个端口：`PORT=4378 npm start` |
| 页面变灰，提示页面已过期 | 服务重启过了，刷新一下页面 |
| 环境体检说找不到 `claude` | 装好 Claude Code（`curl -fsSL https://claude.ai/install.sh \| bash`）后重启 Helm。装在特别的位置的话，先从示例建一个 `.env`（`cp .env.example .env`），在里面写 `CLAUDE_BIN=/claude/的/完整路径`（`which claude` 能看到路径），再重启 Helm |
| 环境体检说缺 `libpython` | Python 环境是用一个没有动态库的 Python 建的。删掉 `engine/.venv`，重新跑 `scripts/setup.sh` |
| 回测拒绝运行，提到沙盒 | Helm 用不了 macOS 的 `sandbox-exec`。见 [配置里的沙盒一节](CONFIGURATION.md#sandbox-helm_exec_sandbox) |
| `npm install -g` 报 `EACCES` | 改用 Claude Code 的安装脚本：`curl -fsSL https://claude.ai/install.sh \| bash` |
| AI 对话框说 key 不对 | 重新复制一次 key，注意别带空格。兼容接口要检查地址是不是以 `/anthropic` 结尾（不是 `/v1/messages`），模型名要一字不差 |
| agent 停下来说没登录或额度不够 | 点顶栏的「AI」，用「测试已保存的连接」看看问题出在哪 |
| 内容还是另一种语言 | 翻译在后台进行，好了页面会自己刷新。一直不变的话，检查 AI 连接 |
| Helm 关着的时候模拟实盘没跑 | 只有 Helm 开着才会跑。下次启动时会补上漏掉的那天，不会重复下单 |
| 按了 Ctrl+C，回测还在跑 | 正常。回测和研究是独立进程，会自己跑完 |

还有问题：[常见问题](FAQ.md) · [全部设置](CONFIGURATION.md) · [整体结构](ARCHITECTURE.md)
