// 服务端的界面语言：请求带 X-Helm-Lang: zh | en（聊天 / 想法请求还会在请求体里带 lang）。
// 中文是源：代码里的提示仍然写中文，这里只放「最可能被用户在网页上看到」的那一批消息的英文版（精确匹配或正则）。
// 没有对应英文的消息原样返回中文，不会出错。agent 的提示词（server.mjs 里给 claude 的 --append-system-prompt）不走这里：
// 那是给模型看的，只额外加一句「用 English 回复」（见 langPrompt）。
export const LANGS = ['zh', 'en'];
export const isLang = (v) => v === 'zh' || v === 'en';

// 请求用哪种语言：优先请求体里的 lang，其次请求头 X-Helm-Lang；都不是 zh/en 就当中文（现有行为）
export function langOf(req, body) {
  if (body && isLang(body.lang)) return body.lang;
  const h = req && req.headers ? String(req.headers['x-helm-lang'] || '').toLowerCase() : '';
  return isLang(h) ? h : 'zh';
}

// 给 agent 的一句话：zh 不加任何东西（保持原行为）；en 要求用英文回复，工具参数和文件内容照工具的要求写
export function langPrompt(lang) {
  if (lang !== 'en') return '';
  return '\n\n## Reply language\nReply to the user in English. Keep tool arguments and file contents as the tools require.';
}

// [中文（字符串 = 整句精确匹配；正则 = 整句匹配，$1 $2 取括号里的内容）, 英文]
const T = [
  // ---- 请求校验 / 安全检查 ----
  ['请求体过大', 'Request body too large'],
  ['请求体不是合法的 JSON', 'Request body is not valid JSON'],
  ['请求体必须是 JSON 对象', 'Request body must be a JSON object'],
  [/^缺少必填字段 (\S+)$/, 'Missing required field $1'],
  ['projectId 必须是正整数', 'projectId must be a positive integer'],
  [/^(\S+) 必须是非负整数$/, '$1 must be a non-negative integer'],
  [/^(\S+) 必须是字符串$/, '$1 must be a string'],
  [/^(\S+) 太长了（最多 (\d+) 个字符）$/, '$1 is too long (at most $2 characters)'],
  [/^(\S+) 必须是数字$/, '$1 must be a number'],
  [/^(\S+) 必须是 true 或 false$/, '$1 must be true or false'],
  ['tickers 太长了', 'tickers is too long'],
  [/^(\S+) 必须是数组$/, '$1 must be an array'],
  [/^(\S+) 太多了（最多 (\d+) 项）$/, '$1 has too many items (at most $2)'],
  ['context 必须是对象', 'context must be an object'],
  ['lang 只能是 zh 或 en', 'lang must be zh or en'],
  ['请求被拒绝：缺少或错误的页面令牌。如果服务刚重启过，请刷新页面。', 'Request rejected: missing or wrong UI token. If the server was just restarted, reload the page.'],
  ['请求被拒绝：来源（Origin）不是本站。', 'Request rejected: the Origin is not this site.'],
  ['请求被拒绝：不是同源请求。', 'Request rejected: not a same-origin request.'],
  ['没有这个接口', 'No such endpoint'],
  ['projectId 或 backtestId 不对', 'Invalid projectId or backtestId'],
  ['projectId 或 sessionId 不对', 'Invalid projectId or sessionId'],
  ['backtestId 不对', 'Invalid backtestId'],
  ['sessionId 不对', 'Invalid sessionId'],
  ['项目编号不对', 'Invalid project id'],
  // ---- 对话 / agent / 审批 ----
  ['消息为空', 'The message is empty'],
  ['没有这个 agent', 'No such agent'],
  ['对话不存在', 'Chat not found'],
  ['对话正在运行', 'The chat is running'],
  ['找不到正在运行的对话', "Can't find the running chat"],
  ['这个对话还在运行，先等它结束或点停止。', 'This chat is still running. Wait for it to finish or click Stop.'],
  [/^同时运行的对话已经有 (\d+) 个（上限 (\d+)），等其中一个结束再开新的。$/, '$1 chats are already running (limit $2). Wait for one to finish before starting a new one.'],
  [/^没能启动 Claude：(.*)$/, "Couldn't start Claude: $1"],
  [/^无法启动 claude：(.*)。确认 claude 在 PATH 里，或在 .env 里设置 CLAUDE_BIN。$/, "Couldn't start claude: $1. Make sure claude is on your PATH, or set CLAUDE_BIN in .env."],
  [/^claude 异常退出（退出码 (\S+)）$/, 'claude exited abnormally (exit code $1)'],
  ['运行出错', 'Run failed'],
  ['没有这组问题（可能已经过期）', "No such question set (it may have expired)"],
  ['这组问题已经回答过了', 'This question set has already been answered'],
  ['至少选一个选项或写一句话', 'Pick at least one option or write a line'],
  ['没有这个请求（可能已经过期）', 'No such request (it may have expired)'],
  ['这个请求已经处理过了', 'This request has already been handled'],
  ['decision 只能是 allow 或 deny', 'decision must be allow or deny'],
  ['没有这个改动', 'No such change'],
  ['已经撤销过了', 'Already undone'],
  [/^这些文件在这次改动之后又被改过：(.*)。确定要恢复成改动之前的样子吗？$/, 'These files were changed again after this change: $1. Restore them to how they were before the change anyway?'],
  // ---- 项目 / 文件 / 回测 ----
  [/^项目 (\S+) 不存在$/, "Project $1 doesn't exist"],
  ['需要项目名称', 'A project name is required'],
  ['本地引擎目前只支持 Python 策略', 'The local engine currently supports Python strategies only'],
  [/^文件名不合法：(.*)$/, 'Invalid file name: $1'],
  ['文件名不合法', 'Invalid file name'],
  [/^找不到文件 (.*)$/, 'File not found: $1'],
  ['文件名必须是 .py 文件（或规则说明 spec.md），只能包含字母、数字、下划线、点和横线', 'The file name must be a .py file (or the spec, spec.md) and may contain only letters, digits, underscores, dots and hyphens'],
  ['不能删除入口文件 main.py', "main.py is the entry file and can't be deleted"],
  ['回测不存在', "The backtest doesn't exist"],
  ['回测还没跑完或出错了，不能做统计检验', "The backtest hasn't finished or failed, so statistical checks can't run"],
  ['找不到回测结果', 'Backtest result not found'],
  ['还没有结果', 'No result yet'],
  [/^没有名为 (\S+) 的图表$/, 'No chart named $1'],
  ['没有日志（回测可能还没跑完）', 'No logs (the backtest may not have finished)'],
  ['找不到这次回测的代码快照', 'Code snapshot for this backtest not found'],
  ['找不到这个回测的代码快照', 'Code snapshot for this backtest not found'],
  [/^项目里没有 (\S+)，先用 write_file 写好它$/, 'The project has no $1; write it first with write_file'],
  [/^(\S+) 里找不到继承 QCAlgorithm 的类$/, 'No class inheriting QCAlgorithm found in $1'],
  ['代码里找不到继承 QCAlgorithm 的类', 'No class inheriting QCAlgorithm found in the code'],
  ['代码快照里找不到继承 QCAlgorithm 的类', 'No class inheriting QCAlgorithm found in the code snapshot'],
  [/^回测进程启动失败：(.*)$/, "Couldn't start the backtest process: $1"],
  [/^引擎出错：(.*)$/, 'Engine error: $1'],
  ['运行时错误', 'Runtime error'],
  ['找不到 Python 运行环境（engine/.venv 不存在或启动不了），LEAN 跑不起来。按 README 的安装步骤装好引擎后再试。', "Python environment not found (engine/.venv is missing or won't start), so LEAN can't run. Install the engine following the README, then try again."],
  ['LEAN 没有生成结果文件（可能是引擎启动失败）', "LEAN didn't produce a result file (the engine may have failed to start)"],
  [/^缺少回测必需的行情数据：(.*)。本地没有这些代码的数据，下载也失败了：(.*)。请检查网络和代码拼写后重试。?$/, "Missing price data required for the backtest: $1. There's no local data for these tickers and the download failed: $2. Check your network and the ticker spelling, then try again."],
  [/^本地缺少行情数据：(.*)$/, 'Local price data is missing: $1'],
  [/^代码检查没通过：(.*)$/, 'Code check failed: $1'],
  [/^启动失败：(.*)$/, "Couldn't start: $1"],
  [/^role 只能是 (.*)$/, 'role must be one of $1'],
  [/^period 只能是 (.*)$/, 'period must be one of $1'],
  ['回测还没跑完，跑完后才能设为主版本', "The backtest hasn't finished; set it as main after it completes"],
  ['这个回测是以基准身份跑完的，没有计入尝试次数，不能设为主版本。要用这份代码，请用策略角色重新跑一次。', "This backtest was run as a benchmark and wasn't counted as a trial, so it can't be set as main. To use this code, rerun it with a strategy role."],
  [/^不能标为主版本：(.*)$/, "Can't mark as main: $1"],
  ['这个项目还有回测在运行，等它结束再删', 'This project still has a backtest running; delete it after it finishes'],
  ['这个项目还有参数敏感性或调参在运行，等它结束再删', 'This project still has a parameter-sensitivity or tuning run in progress; delete it after it finishes'],
  [/^还有 (\d+) 个模拟实盘在运行，先停掉再删$/, '$1 paper trading session(s) still running; stop them before deleting'],
  ['还有 qlib 研究在运行，等它结束或停掉再删', 'A qlib research job is still running; wait for it to finish or stop it before deleting'],
  [/^还有 (\d+) 个正在用 Alpaca 的模拟，先停掉再断开$/, '$1 simulation(s) are still using Alpaca; stop them before disconnecting'],
  // ---- 参数敏感性 / 调参 ----
  ['这是验证期回测，不能做参数敏感性：对验证期重跑变体，等于多看几次验证期。请对开发期的回测做。', "This is a holdout backtest, so parameter sensitivity can't run: rerunning variants on the holdout amounts to looking at it more times. Run it on a dev-period backtest instead."],
  ['回测还没有跑完（或运行失败），不能做参数敏感性。', "The backtest hasn't finished (or failed), so parameter sensitivity can't run."],
  ['这版代码没有用 self.get_parameter("名字", 默认值) 声明参数，没有可微调的东西。', 'This code declares no parameters with self.get_parameter("name", default), so there is nothing to vary.'],
  ['这个回测的参数敏感性正在运行，等它跑完。', "This backtest's parameter-sensitivity run is in progress; wait for it to finish."],
  ['这个回测正在调参，等它跑完。', 'This backtest is being tuned; wait for it to finish.'],
  ['没有可以搜索的参数。', 'No parameters to search.'],
  [/^budget（候选个数）要在 (\d+)–(\d+) 之间$/, 'budget (number of candidates) must be between $1 and $2'],
  // ---- qlib 研究 / 股票池 ----
  ['找不到装了 qlib 的 Python', 'No Python with qlib installed was found'],
  ['找不到研究用的 Python（engine/.venv）。在 helm 目录运行 npm run doctor 看怎么装', "No Python for research was found (engine/.venv). In the helm folder, run npm run doctor to see how to set it up"],
  ['完整因子研究需要 qlib（LightGBM / qlib 回测引擎），这台机器上没找到装了 qlib 的 Python。想法检验、股票池和导出信号不需要 qlib。安装方法见 engine/qlib_research/run.sh 开头的说明', 'Full factor research needs qlib (LightGBM / the qlib backtest engine), and no Python with qlib was found on this machine. Idea checks, universes and signal export do not need qlib. See the top of engine/qlib_research/run.sh for how to install it'],
  [/^找不到 qlib 研究引擎：(.*)$/, 'qlib research engine not found: $1'],
  ['研究任务不存在', "The research job doesn't exist"],
  ['这个研究还在跑', 'This research job is still running'],
  ['custom 股票池至少要 5 只股票（tickers）', 'A custom universe needs at least 5 tickers (tickers)'],
  ['想法检验是横截面比较，custom 股票池至少要 20 只股票', 'An idea check is a cross-sectional comparison; a custom universe needs at least 20 tickers'],
  ['这个项目已经有 2 个研究在跑了，等它们跑完再开新的（qlib 很吃 CPU）', 'This project already has 2 research jobs running; wait for them to finish before starting another (qlib is CPU-heavy)'],
  [/^股票池只能是 (.*)$/, 'The universe must be one of $1'],
  ['未知股票池', 'Unknown universe'],
  ['start 格式是 YYYY-MM-DD', 'start must be formatted YYYY-MM-DD'],
  ['holdoutYears 要在 0.5 到 5 之间', 'holdoutYears must be between 0.5 and 5'],
  ['idea 要写上这次检验的想法（一句话）', 'idea must state the idea being tested (one sentence)'],
  // ---- 发到 QuantConnect ----
  ['还没有连接 QuantConnect 账户', 'No QuantConnect account is connected yet'],
  ['QuantConnect 拒绝了这组凭据（User ID 或 API token 不对，或电脑时间偏差太大）', 'QuantConnect rejected these credentials (wrong User ID or API token, or your computer clock is off)'],
  ['User ID 应该是一串数字（在 QuantConnect 发给你的邮件里）', 'The User ID should be a number (it is in the email QuantConnect sent you)'],
  ['请填写 API token', 'Enter your API token'],
  ['API token 格式不对（应是一长串没有空格的字符）', "The API token doesn't look right (it should be one long string with no spaces)"],
  ['这次回测的代码快照里没有 .py 文件', "This backtest's code snapshot has no .py files"],
  ['代码快照里没有 main.py（QuantConnect 从 main.py 启动）', 'The code snapshot has no main.py (QuantConnect starts from main.py)'],
  ['QuantConnect 没有返回项目编号', 'QuantConnect did not return a project id'],
  ['QuantConnect 返回的不是 JSON', 'QuantConnect did not return JSON'],
  ['QuantConnect 接口地址不对', 'Wrong QuantConnect API address'],
  ['这个项目正在发送到 QuantConnect，请等它完成', 'This project is already being sent to QuantConnect; wait for it to finish'],
  ['代码用到了 helm_data，在 QuantConnect 上不能直接运行', "The code uses helm_data, so it can't run on QuantConnect as is"],
  ['projectId 或 backtestId 不对', 'Invalid projectId or backtestId'],
  ['编译还在排队，请到 QuantConnect 上查看结果', 'The build is still queued; check the result on QuantConnect'],
  [/^QuantConnect 验证失败：(.*)$/, (m) => `QuantConnect sign-in failed: ${localize('en', m[1])}`],
  [/^凭据保存失败：(.*)$/, "Couldn't save the credentials: $1"],
  [/^在 QuantConnect 建项目失败：(.*)$/, (m) => `Couldn't create the QuantConnect project: ${localize('en', m[1])}`],
  [/^上传 (.+?) 失败：(.*)（QuantConnect 上已建好项目，可以打开看看）$/, (m) => `Uploading ${m[1]} failed: ${localize('en', m[2])} (the project was created on QuantConnect; you can open it)`],
  [/^没能开始编译：(.*)$/, (m) => `Couldn't start the build: ${localize('en', m[1])}`],
  [/^读取编译结果失败：(.*)$/, (m) => `Couldn't read the build result: ${localize('en', m[1])}`],
  [/^连接 QuantConnect 超时（(\d+) 秒）$/, 'QuantConnect timed out ($1 s)'],
  [/^连不上 QuantConnect：(.*)$/, "Can't reach QuantConnect: $1"],
  [/^QuantConnect 返回 HTTP (\d+)：(.*)$/, 'QuantConnect returned HTTP $1: $2'],
  [/^文件太多（(\d+) 个，上限 (\d+)）$/, 'Too many files ($1, limit $2)'],
  [/^文件名不能发到 QuantConnect：(.*)$/, "This file name can't be sent to QuantConnect: $1"],
  [/^文件太大：(.*)$/, 'File too large: $1'],
  [/^Helm 不允许调用 QuantConnect 接口 (.*)$/, 'Helm does not allow the QuantConnect endpoint $1'],
  // ---- 模拟实盘 / Alpaca ----
  ['还没有连接 Alpaca 模拟账户，先在弹窗里连接', 'No Alpaca paper account is connected yet; connect one in the dialog first'],
  [/^Alpaca 连接失败：(.*)$/, 'Alpaca connection failed: $1'],
  ['只能用跑完的回测开始模拟实盘', 'Paper trading can only start from a finished backtest'],
  ['用了 qlib 股票池或信号的策略暂时不能模拟实盘：那些数据不是每天更新的。目前只支持代码里直接写股票/ETF 代码的策略。', "Strategies that use a qlib universe or signals can't be paper traded yet: that data isn't updated daily. Only strategies that name stocks/ETFs directly in the code are supported for now."],
  ['模拟不存在', "The simulation doesn't exist"],
  ['模拟实盘不存在', "The paper trading session doesn't exist"],
  ['这个模拟正在运行', 'This simulation is already running'],
  ['这个模拟已经停止', 'This simulation has stopped'],
  ['模拟已经停止，这次不下单', 'The simulation has stopped; no order this time'],
  ['读不到 SPY 的日线数据', "Can't read SPY daily data"],
  ['Alpaca 账户扣掉已有持仓后没有可用资金，无法开始', 'No capital is available in the Alpaca account after existing holdings; cannot start'],
  [/^模拟运行失败：(.*)$/, 'Simulation run failed: $1'],
  [/^(\S+) 已经跑过，还没有更新的数据$/, '$1 has already run; no newer data yet'],
  ['Alpaca 拒绝了这笔单', 'Alpaca rejected this order'],
  ['这个数据日已经下过单，不再重复', 'Orders were already placed for this data date; not repeating'],
  ['这个数据日的订单已经提交过、还在等待成交，不再重复下单', 'Orders for this data date were already submitted and are waiting to fill; not placing again'],
  ['尚未配置 Alpaca 模拟盘密钥', 'No Alpaca paper keys configured'],
  ['请填写 API Key ID', 'Enter the API Key ID'],
  ['请填写 Secret Key', 'Enter the Secret Key'],
  [/^密钥保存失败：(.*)$/, "Couldn't save the keys: $1"],
  [/^Alpaca 显示 (\S+) 不可交易（tradable=false），跳过买入$/, 'Alpaca shows $1 is not tradable (tradable=false); skipping the buy'],
  [/^Alpaca 找不到代码 (\S+)，跳过买入$/, 'Alpaca could not find ticker $1; skipping the buy'],
  ['缺少价格，无法计算股数', "No price, can't compute the share count"],
  ['按整股取整后无需调整', 'No adjustment needed after rounding to whole shares'],
  ['空头持仓，调仓计划不处理，请手动平仓', 'Short position: the rebalance plan does not handle it; close it manually'],
  ['不在目标中，全部卖出', 'Not in the target; selling all'],
  ['目标权重为 0，清仓', 'Target weight is 0; closing the position'],
  ['内部模拟按 LEAN 的成交规则记账，没有真实成交可以对比，不计算执行偏差。', 'The internal simulation books fills by LEAN rules, so there are no real fills to compare and execution shortfall is not computed.'],
  ['还没有上一次的下单记录可以对比：第一次下单之后，下一个交易日的运行会显示成交偏差。', "There's no previous order record to compare yet: after the first orders, the next trading day's run will show execution shortfall."],
  [/^LEAN 只跑到 (\S+)，没有跑到数据日 (\S+)。通常是还没过美东午夜（LEAN 最多跑到美东的昨天），Helm 会自动重试；一直这样的话，检查代码里有没有自己设结束日期。$/, "LEAN only ran through $1, not the data date $2. Usually it's not yet past midnight ET (LEAN runs at most through yesterday ET); Helm retries automatically. If it keeps happening, check whether the code sets its own end date."],
  [/^LEAN 只跑到 (\S+)，没有跑到数据日 (\S+)。检查代码里的 set_end_date 写法。$/, 'LEAN only ran through $1, not the data date $2. Check how the code calls set_end_date.'],
  [/^策略运行出错：([\s\S]*)$/, 'The strategy hit a runtime error: $1'],
  ['LEAN 结果里没有权益曲线', 'The LEAN result has no equity curve'],
  [/^数据只更新到 (\S+)，还没有 (\S+) 的收盘数据，今天不下单，下次定时运行会重试$/, 'Data is only updated through $1; no close for $2 yet. No orders today; the next scheduled run will retry'],
  [/^这些目标持仓的日线没有更新到 (\S+)：(.*)，今天不下单，下次定时运行会重试$/, 'Daily bars for these target holdings are not updated through $1: $2. No orders today; the next scheduled run will retry'],
  [/^数据更新失败（(.*)），今天不下单，下次定时运行会重试$/, 'Data update failed ($1). No orders today; the next scheduled run will retry'],
  [/^下载失败：([\s\S]*)$/, 'Download failed: $1'],
  [/^撤销之前的挂单还没完成（(\d+) 笔），这次不下单，稍后会自动重试$/, 'Cancelling earlier open orders has not finished ($1 orders). No orders this time; it will retry automatically'],
  [/^这个模拟还有没结束的订单（(\S+) (\S+)，状态 (\S+)），算不清自己的仓位，这次不下单$/, "This simulation still has an open order ($1 $2, status $3), so its own position is unclear. No orders this time"],
  [/^订单 (\S+) 有成交但没有成交均价，算不清自己的资金，这次不下单$/, "Order $1 has fills but no average fill price, so the simulation's cash is unclear. No orders this time"],
  [/^不是这个模拟买的股数不卖：(.*)$/, "Shares this simulation didn't buy are not sold: $1"],
  ['正在进行的这次运行会在下单前看到“已停止”，不会再下单。', 'The run in progress will see "stopped" before ordering and will not place orders.'],
  ['Alpaca 账户里的持仓不会自动平掉，需要的话请到 Alpaca 网站手动处理。', "Holdings in the Alpaca account aren't closed automatically; close them on the Alpaca website if needed."],
  [/^算执行偏差失败：([\s\S]*)$/, "Couldn't compute the execution shortfall: $1"],
  [/^参考价是 (\S+) 收盘后做计划时用的价格（LEAN 日线收盘价，复权数据），订单在下一个交易日开盘成交，所以滑点包含隔夜跳空。正数 = 比计划差。实际权重用的是现在的持仓市值，包含成交之后的行情变化。$/, "The reference price is the one used when planning after $1's close (LEAN daily close, adjusted data). Orders fill at the next trading day's open, so slippage includes the overnight gap. Positive = worse than planned. Actual weights use current market value, including moves after the fill."],
  ['当时持仓现价', 'position price at the time'],
  [/^(\S+) 收盘价$/, '$1 close'],
  ['计划估算价', 'planned estimate price'],
  ['全部成交', 'Filled'], ['部分成交', 'Partially filled'], ['被拒绝', 'Rejected'], ['已撤销未成交', 'Cancelled, unfilled'], ['过期未成交', 'Expired, unfilled'],
  ['还在等待成交', 'Waiting to fill'], ['Alpaca 查不到这笔单', "Alpaca can't find this order"], ['无需下单', 'No order needed'],
  // 网页按角色自动起的回测名：「候选 #4」
  [/^候选 #(\d+)$/, 'Candidate #$1'], [/^主版本 #(\d+)$/, 'Main #$1'], [/^对照 #(\d+)$/, 'Control #$1'], [/^消融 #(\d+)$/, 'Ablation #$1'], [/^基准 #(\d+)$/, 'Benchmark #$1'], [/^调试 #(\d+)$/, 'Debug #$1'],
  // ---- 数据集 ----
  [/^行数太多：(\d+)，最多 (\d+) 行$/, 'Too many rows: $1 (at most $2)'],
  [/^数据太大：(\S+) MB，最多 5 MB$/, 'Data too large: $1 MB (at most 5 MB)'],
  ['缺少 columns（列名数组）', 'Missing columns (an array of column names)'],
  ['rows 必须是非空数组', 'rows must be a non-empty array'],
  // ---- 统计关卡 / 流程 / 研究阶段 / 稳健性（服务端算出来的中文，网页按语言显示）----
  ['风险调整后跑赢基准（夏普差自助法 P(≤0) < 10%，且最大回撤 ≤ 基准的 2/3）', 'Beats the benchmark on a risk-adjusted basis (Sharpe-difference bootstrap P(≤0) < 10%, and max drawdown ≤ 2/3 of the benchmark\'s)'],
  ['夏普 95% 置信区间下限 > 0（无风险利率按 0 计，和 qlib 引擎一致）', 'Lower bound of the 95% Sharpe confidence interval > 0 (risk-free rate taken as 0, same as the qlib engine)'],
  ['有 90% 以上把握跑赢基准（超额收益自助法 P(≤0) < 10%）', 'At least 90% confident of beating the benchmark (excess-return bootstrap P(≤0) < 10%)'],
  [/^去膨胀夏普 ≥ 95%（同一段历史共试过 (\d+) 个版本(?:：本项目 (\d+)、其他项目 (\d+))?）$/, (m) => `Deflated Sharpe ≥ 95% (${m[1]} versions tried on the same history${m[2] != null ? `: ${m[2]} in this project, ${m[3]} in other projects` : ''})`],
  ['至少 1 年数据', 'At least 1 year of data'],
  ['指标自洽（LEAN 统计和权益曲线、订单记录互相核对）', 'Metrics are self-consistent (LEAN statistics cross-checked against the equity curve and order log)'],
  ['指标互相矛盾', 'Metrics contradict each other'],
  ['样本太短', 'Sample too short'],
  ['没有基准数据', 'No benchmark data'],
  ['没有可比较的结果', 'No results to compare'],
  [/^(-?[\d.]+) 年$/, '$1 years'],
  [/^(\d+) 项核对全部一致$/, 'All $1 checks agree'],
  [/^(\d+) 项一致；(.*)$/, '$1 checks agree; $2'],
  [/^夏普差 (\S+)，95% 区间 \[(\S+), (\S+)\]，P\(≤0\) = (\S+)%；最大回撤 (\S+)% vs 基准 (\S+)%（上限 (\S+)%）$/, 'Sharpe difference $1, 95% interval [$2, $3], P(≤0) = $4%; max drawdown $5% vs benchmark $6% (limit $7%)'],
  [/^超额 (\S+)%\/年(?:，95% 区间 \[(\S+)%, (\S+)%\]，P\(≤0\) = (\S+)%)?$/, (m) => `Excess ${m[1]}%/yr${m[2] != null ? `, 95% interval [${m[2]}%, ${m[3]}%], P(≤0) = ${m[4]}%` : ''}`],
  [/^(\S+)%(?:（(\d+) 次尝试里最好的夏普，靠运气也能到 (\S+)）)?$/, (m) => `${m[1]}%${m[2] != null ? ` (best Sharpe out of ${m[2]} tries; luck alone can reach ${m[3]})` : ''}`],
  ['有一个变体的夏普正负号和原来相反', "One variant's Sharpe has the opposite sign to the original"],
  ['有变体没跑成功，无法判断', "A variant didn't run successfully, so it can't be judged"],
  [/^夏普变化超出允许范围（(.*)）$/, 'Sharpe change is outside the allowed range ($1)'],
  [/^两个变体的夏普方向不变、都在(.*)以内$/, "Both variants' Sharpe keep their sign and stay within $1"],
  ['想法', 'Idea'], ['想法检验', 'Idea check'], ['开发期回测', 'Dev-period backtest'], ['统计检验', 'Statistical gates'], ['验证期', 'Validation period'], ['模拟实盘', 'Paper trading'],
  ['写规则说明、选路线', 'Write the rule spec, pick the route'],
  ['qlib 因子在开发期有没有信号', 'Does the qlib factor show signal in the dev period'],
  ['照 spec 写 LEAN 代码，跑开发期', 'Write the LEAN code from the spec, run the dev period'],
  ['置信区间、去膨胀夏普，通过才标 main', 'Confidence interval and deflated Sharpe; tag main only on pass'],
  ['样本外只跑一次', 'Out-of-sample, run only once'],
  ['冻结代码，每天收盘后前向跑', 'Freeze the code, run forward after each close'],
  ['环境', 'Environment'], ['股票池', 'Universe'], ['价格数据', 'Price data'], ['冻结实验设计', 'Freeze the experiment design'], ['计算因子', 'Compute factors'], ['因子筛选', 'Factor screening'],
  ['模型训练', 'Model training'], ['稳健性检验', 'Robustness checks'], ['进阶模型', 'Advanced models'], ['组合构建', 'Portfolio construction'], ['风险叠加', 'Risk overlay'], ['验证期检验', 'Validation-period check'], ['报告', 'Report'],
  ['找不到装了 qlib 的 Python（engine/qlib_research/run.sh --which-python 没有结果）', 'No Python with qlib installed was found (engine/qlib_research/run.sh --which-python returned nothing)'],
  // ---- 统计检验的提醒 / 想法记录（journal）/ 参数敏感性的结论 ----
  [/^这是本项目第 (\d+) 次看验证期：之前的结果可能已经影响了策略设计，验证期不再是干净的样本外。$/, 'This is the project\'s look #$1 at the holdout period: earlier results may already have influenced the strategy design, so the holdout is no longer clean out-of-sample.'],
  ['这是开发期（样本内）结果：参数是在这段数据上挑的，通过检验也不代表样本外有效，还要在验证期验证一次。', 'This is a development-period (in-sample) result: the parameters were picked on this data, so passing the checks does not mean it works out-of-sample. It still has to be validated once on the holdout period.'],
  ['基准数据和策略日期对不齐的天数较多，超额收益仅供参考。', 'Many days do not line up between the benchmark and the strategy, so excess return is indicative only.'],
  ['数据太少，无法做统计检验', 'Too little data to run the statistical checks'],
  ['候选', 'Candidate'], ['主版本', 'Main version'], ['调试', 'Debug'], ['对照', 'Control'], ['消融', 'Ablation'],
  ['运行中', 'Running'], ['没跑完', "Didn't finish"], ['未完成', 'Incomplete'], ['已删除', 'Deleted'], ['进行中', 'Active'], ['已停止', 'Stopped'],
  ['有信号', 'Signal'], ['信号弱', 'Weak signal'], ['没有信号', 'No signal'],
  ['夏普', 'Sharpe'], ['IC t 值', 'IC t-stat'],
  ['你选定的主版本', 'Main version you picked'],
  ['已通过统计检验', 'Passed the statistical checks'],
  [/^没过统计检验（(\d+) 项没达标）$/, 'Failed the statistical checks ($1 not met)'],
  [/^验证期第 (\S+) 次$/, 'Holdout look #$1'],
  ['用过验证期', 'Holdout used'],
  [/^冻结 (.*)$/, 'Frozen $1'],
  ['没有因子结果', 'No factor results'],
  [/^(\d+) 个因子((?: · 最好：.*?)?)((?: · \d+ 日)?)$/, (m) => `${m[1]} factor${m[1] === '1' ? '' : 's'}${m[2] ? ` · best: ${m[2].slice(' · 最好：'.length)}` : ''}${m[3] ? ` · ${m[3].match(/\d+/)[0]}-day` : ''}`],
  ['回测文件已删除，只剩尝试记录', 'Backtest files deleted; only the trial record remains'],
  [/^已删除的回测 (\S+)$/, 'Deleted backtest $1'],
  [/^(.*)（来自 回测）$/, '$1 (from backtest)'],
  [/^(.*)（来自 (.*)）$/, '$1 (from $2)'],
  [/^项目 #(\d+)$/, 'Project #$1'],
  [/^没有可判断的参数(?:（另有 (\d+) 个参数没跑成功，没法判断）)?。$/, (m) => `No parameters could be judged${m[1] ? ` (another ${m[1]} failed to run and cannot be judged)` : ''}.`],
  [/^(\d+) 个参数各微调 ±20% 后，夏普方向不变、变化不大：结果对这些参数不敏感(?:（另有 (\d+) 个参数没跑成功，没法判断）)?。$/, (m) => `After nudging each of ${m[1]} parameter${m[1] === '1' ? '' : 's'} by ±20%, the Sharpe keeps its sign and barely changes: the result is not sensitive to these parameters${m[2] ? ` (another ${m[2]} failed to run and cannot be judged)` : ''}.`],
  [/^(\d+) 个参数（(.*?)）微调 ±20% 后夏普明显变化(?:，其中 (.*?) 的夏普方向翻转)?：原来的表现可能依赖这些参数的具体取值(?:（另有 (\d+) 个参数没跑成功，没法判断）)?。$/, (m) => `After nudging ${m[1]} parameter${m[1] === '1' ? '' : 's'} (${m[2].split('、').join(', ')}) by ±20%, the Sharpe changes noticeably${m[3] ? `, and the Sharpe sign flips for ${m[3].split('、').join(', ')}` : ''}: the original performance may depend on the exact values of these parameters${m[4] ? ` (another ${m[4]} failed to run and cannot be judged)` : ''}.`],
  ['这些重跑只是诊断。挑出“看起来最好”的那个变体并采用，就是调参：必须把它当作一次新的回测重新跑，并计入尝试次数。', 'These reruns are diagnostics only. Picking the variant that "looks best" and adopting it is tuning: it must be rerun as a new backtest and counted as a trial.'],
  // ---- 健康检查 / 启动 ----
  ['检查超时或出错', 'The check timed out or failed'],
  ['找不到装了 qlib 的 Python', 'No Python with qlib installed was found'],
  [/^本地已有 (\d+) 个代码的日线$/, '$1 tickers of daily data available locally'],
  // AI 连接（lib/ai.mjs、server 的 aiLogin）
  ['连接方式只能是 auto、subscription、apiKey 或 custom', 'Connection type must be auto, subscription, apiKey or custom'],
  ['接口地址要是完整的网址，例如 https://api.deepseek.com/anthropic', 'The endpoint must be a full URL, e.g. https://api.deepseek.com/anthropic'],
  ['接口地址要用 https（只有本机的 localhost 可以用 http）', 'The endpoint must use https (only localhost may use http)'],
  ['接口地址填到 /v1 之前就行，不要带 /v1/messages', 'Enter the endpoint up to before /v1; leave out /v1/messages'],
  ['请填写 API key', 'Please enter an API key'],
  ['API key 格式不对（不能有空格，最长 500 个字符）', 'The API key looks wrong (no spaces, at most 500 characters)'],
  ['请填写模型名（对方文档里的模型 ID，例如 deepseek-chat）', "Please enter a model name (the model ID from the provider's docs, e.g. deepseek-chat)"],
  ['模型名只能有字母、数字和 . _ - : / @ +', 'The model name may contain only letters, digits and . _ - : / @ +'],
  ['没有保存 API key', 'No API key saved'],
  ['Claude Code 还没有登录 Claude 账号：在终端运行 claude，按提示用订阅账号登录', 'Claude Code is not signed in to a Claude account: run claude in a terminal and sign in with your subscription account'],
  ['还没有连接 AI：在终端运行 claude 登录，或在 Helm 里填 API key', 'No AI connected yet: run claude in a terminal to sign in, or enter an API key in Helm'],
  ['未知（Claude Code 版本较旧）', 'Unknown (older Claude Code version)'],
  ['自动（沿用 Claude Code 的登录）', "Auto (uses Claude Code's own sign-in)"],
  ['Claude 订阅', 'Claude subscription'],
  ['兼容接口', 'Compatible API'],
  [/^连接测试没通过：密钥无效或没有权限（HTTP (\d+)）(?:：([\s\S]*))?$/, (m) => `Connection test failed: invalid key or no permission (HTTP ${m[1]})${m[2] ? `: ${m[2]}` : ''}`],
  [/^连接测试没通过：接口地址或模型名不对（HTTP 404）(?:：([\s\S]*))?$/, (m) => `Connection test failed: wrong endpoint or model name (HTTP 404)${m[1] ? `: ${m[1]}` : ''}`],
  [/^连接测试没通过：额度用完或请求太频繁（HTTP 429）(?:：([\s\S]*))?$/, (m) => `Connection test failed: out of credit or rate-limited (HTTP 429)${m[1] ? `: ${m[1]}` : ''}`],
  [/^连接测试没通过：接口返回 HTTP (\d+)(?:：([\s\S]*))?$/, (m) => `Connection test failed: the endpoint returned HTTP ${m[1]}${m[2] ? `: ${m[2]}` : ''}`],
  [/^连接测试没通过：连接超时（(\d+) 秒没有回应）$/, 'Connection test failed: timed out (no answer in $1 s)'],
  [/^连接测试没通过：连不上接口：([\s\S]*)$/, 'Connection test failed: could not reach the endpoint: $1'],
  [/^连接测试没通过：接口有回应，但不是 Anthropic Messages 格式。[\s\S]*$/, "Connection test failed: the endpoint answered, but not in Anthropic Messages format. Make sure you entered the provider's Anthropic-compatible URL (usually ending in /anthropic), not an OpenAI-format one"],
  [/^保存失败：([\s\S]*)$/, 'Saving failed: $1'],
  [/^([\s\S]+)。点顶栏的「AI」按钮，可以改用 Claude 订阅、Anthropic API key 或其它兼容接口（DeepSeek、Kimi、GLM、OpenRouter 等）$/, (m) => `${localize('en', m[1])}. Click "AI" in the top bar to use your Claude subscription, an Anthropic API key, or another compatible API (DeepSeek, Kimi, GLM, OpenRouter and others).`],
  // ---- 环境体检 / 安装（server.mjs computeHealth、claudeError）----
  [/^找不到 claude 命令（(.+)）：Claude Code 还没有安装，或者不在 PATH 里$/, 'The claude command ($1) was not found: Claude Code is not installed, or not on PATH'],
  [/^claude 命令（(.+)）没有执行权限$/, 'The claude command ($1) is not executable'],
  ['claude 命令没有响应（超时）', 'The claude command did not respond (timed out)'],
  ['claude 命令运行失败', 'The claude command failed'],
  [/^([\s\S]+)，无法检查 AI 连接$/, (m) => `${localize('en', m[1])}; cannot check the AI connection`],
  [/^检查 AI 连接失败：([\s\S]*)$/, 'Checking the AI connection failed: $1'],
  ['先安装 Claude Code（见上一项），装好后重启 Helm', 'Install Claude Code first (see the item above), then restart Helm'],
  ['无法检查（缺少 claude 命令）', 'Cannot check (the claude command is missing)'],
  ['未知（Claude Code 版本较旧）', 'Unknown (older Claude Code version)'],
  ['要先有 engine/.venv', 'Needs engine/.venv first'],
  [/^本地已有 (\d+) 个代码的日线$/, 'Daily bars for $1 tickers on disk'],
  ['找不到装了 qlib 的 Python', 'No Python with qlib found'],
  ['找不到研究用的 Python（engine/.venv）', 'No Python for research found (engine/.venv)'],
  ['没装：想法检验、股票池不受影响', 'Not installed: idea checks and universes are not affected'],
  ['找不到 engine/qlib_research/run.sh', 'engine/qlib_research/run.sh not found'],
  ['检查超时或出错', 'Check timed out or failed'],
  ['已关闭（HELM_EXEC_SANDBOX=off）：策略代码不在沙盒里运行', 'Off (HELM_EXEC_SANDBOX=off): strategy code runs outside the sandbox'],
  ['不可用：回测会被拒绝', 'Unavailable: backtests will be refused'],
  ['策略沙盒不可用（这台机器没有 macOS 的 /usr/bin/sandbox-exec），为了安全不运行 AI 写的策略代码。确实要在没有沙盒的情况下运行，请在 .env 里加一行 HELM_EXEC_SANDBOX=off 后重启 Helm（策略代码将能读写你的文件、联网）。',
    'The strategy sandbox is unavailable (this machine has no macOS /usr/bin/sandbox-exec), so Helm will not run AI-written strategy code. To run it without a sandbox anyway, add HELM_EXEC_SANDBOX=off to .env and restart Helm (strategy code will be able to read and write your files and use the network).'],
  [/^Yahoo Finance 限流（请求太多），重试 (\d+) 次仍失败：等几分钟后再运行一次$/, 'Yahoo Finance is throttling requests (too many requests); still failing after $1 tries. Wait a few minutes and run it again'],
  [/^连不上 Yahoo Finance（([\s\S]*)），重试 (\d+) 次仍失败：检查网络 \/ 代理后再试$/, 'Could not reach Yahoo Finance ($1); still failing after $2 tries. Check your network / proxy and try again'],
  ['engine/.venv 里没有 yfinance：在 Helm 安装目录运行 scripts/setup.sh', 'yfinance is not installed in engine/.venv: run scripts/setup.sh in the Helm install folder'],
  ['只能修改项目里已有的 .py 文件', 'Only existing .py files in the project can be edited'],
  ['content 必须是字符串', 'content must be a string'],
  [/^文件太大了（最多 (\d+) KB）$/, 'The file is too large (at most $1 KB)'],
  // ---- 运行阶段（回测 / 参数敏感性 / 调参的 phase）----
  ['排队', 'Queued'],
  ['启动', 'Starting'],
  ['准备数据', 'Preparing data'],
  ['运行 LEAN', 'Running LEAN'],
  [/^候选 (\d+)\/(\d+)：([\s\S]*)$/, 'Candidate $1/$2: $3'],
  [/^重跑 (\d+)\/(\d+)：([\s\S]*)$/, 'Rerun $1/$2: $3'],
  // ---- 股票池名字（engine/qlib_bridge.py 的 INDEXES）----
  ['纳斯达克 100', 'Nasdaq 100'],
  ['道琼斯 30', 'Dow Jones 30'],
  ['费城半导体', 'PHLX Semiconductor'],
  ['罗素 2000（80 只样本）', 'Russell 2000 (80-stock sample)'],
  ['Qlib 到 2020-10 + Wikipedia 成分股变更表（未经价格核对）', 'Qlib up to 2020-10 + Wikipedia membership changes (not price-checked)'],
  // ---- 回测数据更新提示（backtests/read 的 dataChangedNote）----
  ['这次回测之后行情数据已经更新过，现在重跑结果可能不同；重跑一次可以对比', 'The price data has been updated since this run, so a rerun may give different numbers; rerun it to compare'],
];

const EXACT = new Map(T.filter(([z]) => typeof z === 'string'));
const PATTERNS = T.filter(([z]) => z instanceof RegExp);

// 一条消息翻成英文；没有对应翻译就原样返回
export function localize(lang, text) {
  if (lang !== 'en' || typeof text !== 'string' || !text) return text;
  const e = EXACT.get(text);
  if (e) return e;
  for (const [re, en] of PATTERNS) {
    const m = text.match(re);
    if (m) return typeof en === 'function' ? en(m) : en.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
  }
  // 「甲 · 乙 · 丙」这种拼起来的说明：逐段翻译，没有对应翻译的段（用户的文件名、因子名等）原样保留
  if (text.includes(' · ')) {
    const parts = text.split(' · ');
    const out = parts.map((x) => localize(lang, x));
    if (out.some((x, i) => x !== parts[i])) return out.join(' · ');
  }
  return text;
}

// 接口返回值里用户会看到的文字字段：error / errors[] / reason / why / skipReason / note / message / warnings[]
const TEXT_KEYS = new Set(['statusZh', 'source', 'refSource', 'sourceName', 'notes', 'name', 'error', 'errors', 'reason', 'why', 'skipReason', 'note', 'message', 'warnings', 'conflictNote', 'detail', 'zh', 'desc', 'stage', 'outcome', 'label', 'what', 'projectName', 'conclusion', 'warning', 'phase', 'membership_source', 'dataChangedNote']);
export function localizeData(lang, data, depth = 0) {
  if (lang !== 'en' || data == null || typeof data !== 'object' || depth > 6) return data;
  if (Array.isArray(data)) { for (let i = 0; i < data.length && i < 5000; i++) data[i] = typeof data[i] === 'object' ? localizeData(lang, data[i], depth + 1) : data[i]; return data; }
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (k === 'byStage' && v && typeof v === 'object' && !Array.isArray(v)) { data[k] = Object.fromEntries(Object.entries(v).map(([a, b]) => [localize(lang, a), b])); continue; } // 想法记录：阶段名是键
    if (typeof v === 'string') { if (TEXT_KEYS.has(k)) data[k] = localize(lang, v); }
    else if (Array.isArray(v) && TEXT_KEYS.has(k)) data[k] = v.map((x) => (typeof x === 'string' ? localize(lang, x) : localizeData(lang, x, depth + 1)));
    else if (v && typeof v === 'object') localizeData(lang, v, depth + 1);
  }
  return data;
}

// 环境体检的英文：每项的名字（en）和怎么补（hintEn）。中文在 server.mjs 里（zh / hint）。
// claude / ai / dotnet / lean / python / libpython / sandbox 的 hintEn 由 server.mjs（lib/setup-hints.mjs）按当前状态算
export const HEALTH_EN = {
  claude: { en: 'Claude Code CLI' },
  ai: { en: 'AI connection' },
  dotnet: { en: '.NET runtime' },
  lean: { en: 'LEAN engine (compiled)' },
  python: { en: 'Python virtual environment' },
  libpython: { en: 'Python shared library (used by LEAN to load strategies)' },
  sandbox: { en: 'Strategy sandbox (macOS sandbox-exec)' },
  priceData: { en: 'Price data', hintEn: "No manual setup needed: the first time a backtest runs, it downloads the daily bars for the stocks/ETFs the code uses (you can ignore this item)." },
  research: { en: 'Research engine (idea checks, universes)', hintEn: "Uses Helm's own engine/.venv (the same environment as backtests); qlib is not needed. If it is missing, set up the Python virtual environment item above first." },
  qlib: { en: 'qlib (only for full factor research)', hintEn: 'Only full factor research (LightGBM, qlib backtests) needs it. In the helm folder run: engine/qlib_research/run.sh --which-python and see what it reports missing (the recommended place is a dedicated env in engine/.qlib-venv; you can also add QS_PYTHON=/absolute/path/to/python to .env).' },
  qlibData: { en: 'qlib US data', hintEn: 'Only needed for qlib research: put the qlib US daily data in ~/.qlib/qlib_data/us_data (the folder must contain calendars, features and instruments).' },
};
