#!/usr/bin/env node
// 本地 LEAN 引擎的 MCP 服务器（stdio，零依赖）
// 工具名和 QuantConnect 的习惯保持一致，策略代码与 QC 云端完全兼容。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as E from '../lib/engine.mjs';
import { fetchMacro } from '../lib/macro.mjs';
import { saveDataset, listDatasets, readDataset } from '../lib/datasets.mjs';
import * as Q from '../lib/qlib.mjs';
import * as Paper from '../lib/paper.mjs';
import { GATE_RULES } from '../lib/stats.mjs';
import { loadRobust, robustText } from '../lib/robust.mjs';
import { localize } from '../lib/i18n.mjs';

// 界面语言（server.mjs 启动 agent 时通过 HELM_LANG 传进来）：en 时，工具返回的「错误：…」换成英文，其余内容不变。
// 工具内部和 isError 的判断仍然用中文前缀；只在最后一步输出时转换。
const LANG = process.env.HELM_LANG === 'en' ? 'en' : 'zh';
const userText = (text) => (LANG === 'en' && typeof text === 'string' && text.startsWith('错误：')
  ? `Error: ${text.slice(3).split('; ').map((x) => localize('en', x)).join('; ')}` : text);

const AGENTS = JSON.parse(readFileSync(path.join(E.ROOT, 'agents.json'), 'utf8'));

const int = { type: 'integer' };
const str = { type: 'string' };
const P = { projectId: { ...int, description: '项目 ID' } };
const PB = { ...P, backtestId: { ...str, description: '回测 ID' } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 想法检验能用的 SEC 财报字段（和 engine/qlib_research/qs_fundamentals.py 一致）
const FUND_FIELDS = Object.entries(Q.FUND_FIELDS).map(([k, v]) => `${k}（${v}）`).join('、');
const failText = (r) => `错误：${(r.errors || []).join('; ') || '未知错误'}`;
const clip = (s, n = 60000) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字符）` : s);
// 编译结果（语法 + 静态检查）。有「必须修复」时明确告诉 agent：先修好再重新 compile，不要直接重跑回测
const compileText = (c) => {
  let s = `编译 ${c.state}${c.logs && c.logs.length ? `\n${c.logs.join('\n')}` : ''}`;
  const nErr = c.lint ? c.lint.errors.length : 0;
  const nWarn = c.lint ? c.lint.warnings.length : 0;
  if (c.state !== 'BuildSuccess') s += `\n下一步：按行号把「必须修复」里的${nErr ? ` ${nErr} 处` : '问题'}全部改好（write_file 传完整文件），再运行 compile，确认是 BuildSuccess 后才 create_backtest。没通过检查不会运行回测，也不算一次尝试。`;
  else if (nWarn) s += `\n可以回测。上面 ${nWarn} 条警告不阻止回测，但请逐条确认是有意为之，不是的话先改掉再回测。`;
  return s;
};

function summarize(b) {
  const keep = ['Net Profit', 'Compounding Annual Return', 'Sharpe Ratio', 'Sortino Ratio', 'Probabilistic Sharpe Ratio', 'Drawdown',
    'Win Rate', 'Loss Rate', 'Profit-Loss Ratio', 'Total Orders', 'Total Fees', 'Alpha', 'Beta', 'Annual Standard Deviation',
    'Information Ratio', 'Tracking Error', 'Portfolio Turnover', 'Start Equity', 'End Equity', 'Average Win', 'Average Loss',
    'Expectancy', 'Drawdown Recovery'];
  const s = b.statistics || {};
  return {
    backtestId: b.backtestId, name: b.name, status: b.status, phase: b.phase || undefined,
    created: b.created, completed: b.completed || undefined,
    error: b.error || undefined, stacktrace: b.stacktrace ? String(b.stacktrace).slice(0, 3000) : undefined,
    data: b.data, dataWarnings: b.dataWarnings && b.dataWarnings.length ? b.dataWarnings : undefined,
    statistics: Object.fromEntries(keep.filter((k) => k in s).map((k) => [k, s[k]])),
    runtimeStatistics: b.runtimeStatistics,
  };
}

const TAGS = {
  role: { type: 'string', enum: ['main', 'candidate', 'control', 'ablation', 'benchmark', 'debug'], description: '这次回测的角色：main=最终主版本（每个时间段只有一个）；candidate=候选版本；control=对照策略；ablation=消融实验；benchmark=基准（如 SPY 买入持有）；debug=调试或已被取代的回测' },
  period: { type: 'string', enum: ['dev', 'holdout', 'full'], description: '时间段：dev=开发期（样本内）；holdout=验证期（样本外，只用来验证）；full=全期' },
};

// 调 Helm 服务（只在 Helm 网站发起的对话里可用）：带上本对话 id 和只走环境变量的令牌
async function helmPost(p, body, timeoutMs = 60000) {
  const url = process.env.HELM_URL;
  if (!url || !process.env.HELM_THREAD_ID) throw new Error('只能在 Helm 网站发起的对话里使用');
  const r = await fetch(`${url}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-helm-token': process.env.HELM_TOKEN || '' },
    body: JSON.stringify({ threadId: process.env.HELM_THREAD_ID, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const suiteText = (s) => s.map((x) => `- ${x.name}：${x.state === 'pass' ? '通过' : x.state === 'skipped' ? '没跑（本机缺环境）' : '没过'}${x.state === 'fail' && x.tail ? `\n${x.tail.split('\n').slice(-25).join('\n')}` : ''}`).join('\n');

const TOOLS = [
  {
    // Claude Code 在 agent 要改文件 / 跑命令时自动调用（--permission-prompt-tool），由 Helm 按改动规则放行、拒绝或请用户批准
    name: 'approve',
    description: 'Helm 内部的权限审批，Claude Code 会在你改文件或跑命令时自动调用。不要自己调用它。',
    inputSchema: { type: 'object', properties: {} },
    async run(args) {
      try {
        const j = await helmPost('/api/approval', { tool_name: args.tool_name ?? args.toolName, input: args.input ?? args.tool_input ?? {}, tool_use_id: args.tool_use_id ?? null }, 16 * 60 * 1000);
        return JSON.stringify(j.behavior === 'allow' ? { behavior: 'allow', updatedInput: j.updatedInput ?? args.input ?? {} } : { behavior: 'deny', message: j.message || '被拒绝' });
      } catch (e) {
        return JSON.stringify({ behavior: 'deny', message: `权限审批失败（${e.message}），这次操作没有执行` });
      }
    },
  },
  {
    name: 'ask_user',
    description: '开工前问用户：网页上会弹出带选项的问题卡片，这个工具会一直等到用户选完（最多约 15 分钟），然后返回用户的回答，你接着干活。一次最多 4 个问题，每个 2–4 个具体选项，第一个是你推荐的（label 末尾写「（推荐）」），description 写清选它的后果；用户也可以写补充或跳过（跳过 / 超时就按每题第一个选项继续）。只问会明显改变结果的事。不要把问题写在回复末尾等用户回复，用这个工具问。',
    inputSchema: {
      type: 'object',
      properties: {
        intro: { ...str, description: '（可选）一句话说明为什么要问' },
        questions: {
          type: 'array', description: '1–4 个问题',
          items: {
            type: 'object',
            properties: {
              question: { ...str, description: '完整的问题，以问号结尾' },
              header: { ...str, description: '很短的标签（≤12 字），比如「基准」「调仓」' },
              multiSelect: { type: 'boolean', description: '可以多选时为 true' },
              options: { type: 'array', description: '2–4 个选项', items: { type: 'object', properties: { label: { ...str, description: '选项（1–5 个词）' }, description: { ...str, description: '选它会怎样' } }, required: ['label'] } },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    async run({ intro, questions }) {
      try {
        const j = await helmPost('/api/ask', { intro, questions }, 16 * 60 * 1000);
        return j.text;
      } catch (e) {
        return `错误：${e.message}`;
      }
    },
  },
  {
    name: 'verify_changes',
    description: '检查你这次对 Helm 代码做的改动：跑相关测试（JS 快速测试集 / 引擎单元测试）。没通过会自动把你这次改的所有文件恢复原样，并返回失败输出——读输出、修好、重新改、再调用一次。改完代码后、给最终总结之前必须调用。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      try {
        const j = await helmPost('/api/changes/verify', {}, 15 * 60 * 1000);
        if (j.status === 'none') return '这次运行还没有改过文件，不用检查。';
        const head = j.reverted ? '❌ 测试没过，已经把你这次改的文件全部恢复原样。' : j.ok ? '✅ 测试通过，改动保留。' : '⚠ 测试没过（没有自动恢复）。';
        return `${head}\n改动编号 ${j.id}，文件：${(j.files || []).join('、')}\n${suiteText(j.suites || [])}${j.needsRestart ? '\n注意：改到了服务进程加载的文件（server.mjs / lib/*.mjs / agents.json），要重启 Helm 才生效，在最终总结里告诉用户。' : ''}`;
      } catch (e) {
        return `错误：${e.message}`;
      }
    },
  },
  {
    name: 'revert_my_changes',
    description: '把你这次运行里改过的所有 Helm 文件恢复成改之前的样子（新建的文件会删掉）。改坏了、想换个做法时用。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      try {
        const j = await helmPost('/api/changes/revert-mine', {});
        return j.status === 'none' ? '这次运行没有改过文件。' : `已恢复：${(j.files || []).join('、')}`;
      } catch (e) {
        return `错误：${e.message}`;
      }
    },
  },
  {
    name: 'handoff',
    description: `把任务交给团队里的另一个 agent。网站会立即为对方开一个新对话并开始执行，用户点对方的标签就能实时看到。可选 agent：${AGENTS.map((a) => `${a.id}（${a.name}）`).join('、')}。task 必须完整自洽：对方看不到你的对话，要写清 projectId/backtestId、具体要做什么、怎样算完成。wait=true 会等对方做完，并返回对方的最终回答（最多约 15 分钟）；wait=false 立即返回。`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: AGENTS.map((a) => a.id) },
        task: { ...str, description: '完整的任务说明' },
        projectId: { ...int, description: '相关项目（可选）' },
        backtestId: { ...str, description: '相关回测（可选）' },
        wait: { type: 'boolean', description: '是否等对方完成并拿回结果，默认 false' },
      },
      required: ['agent', 'task'],
    },
    async run({ agent, task, projectId, backtestId, wait = false }) {
      const url = process.env.HELM_URL;
      if (!url || !process.env.HELM_THREAD_ID) return '错误：handoff 只能在 Helm 网站发起的对话里使用';
      let r;
      try {
        r = await fetch(`${url}/api/handoff`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-helm-token': process.env.HELM_TOKEN || '' },
          body: JSON.stringify({ fromThreadId: process.env.HELM_THREAD_ID, agent, task, projectId, backtestId, wait }),
          signal: AbortSignal.timeout(16 * 60 * 1000),
        });
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return '交接请求等待超时：对方很可能已经开始工作了。不要再交接一次（会开出重复的对话），请让用户在网站上查看对方的进度。';
        return `错误：交接请求失败（${e.message}）`;
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return `错误：${j.error || `HTTP ${r.status}`}`;
      if (j.stillRunning) return `${j.agentName}还在运行（已等约 14 分钟），threadId=${j.threadId}。不要再交接一次；先做别的，或告诉用户到网站右侧的「${j.agentName}」标签查看进度。`;
      if (!wait) return `已交给${j.agentName}，threadId=${j.threadId}。对方已经开始工作，用户可以点网站右侧的「${j.agentName}」标签实时查看。`;
      if (j.error && !j.text) return `错误：${j.agentName}运行出错（threadId=${j.threadId}）：${j.error}`;
      return `${j.agentName}已完成，threadId=${j.threadId}${j.stopped ? '（用户中途停止了它）' : ''}。它的最终回答：\n\n${j.text || '（没有文字回答）'}`;
    },
  },
  {
    name: 'list_projects', description: '列出所有项目（按修改时间倒序），可用关键词过滤。',
    inputSchema: { type: 'object', properties: { filter: { ...str, description: '按名称过滤（可选）' } } },
    async run({ filter }) {
      let ps = await E.listProjects();
      if (filter) ps = ps.filter((p) => p.name.toLowerCase().includes(String(filter).toLowerCase()));
      return JSON.stringify(ps.map(({ projectId, name, modified, description }) => ({ projectId, name, modified, description: description || undefined })), null, 1);
    },
  },
  {
    name: 'read_project', description: '读取项目信息和全部代码文件。',
    inputSchema: { type: 'object', properties: P, required: ['projectId'] },
    async run({ projectId }) {
      const p = await E.projectsRead({ projectId });
      if (!p.success) return failText(p);
      const f = await E.filesRead({ projectId });
      const files = (f.files || []).map((x) => `### ${x.name}\n\`\`\`python\n${x.content}\n\`\`\``).join('\n\n');
      const proj = p.projects[0];
      return clip(`项目：${proj.name}（projectId=${projectId}）${proj.description ? `\n说明：${proj.description}` : ''}\n\n${files}`);
    },
  },
  {
    name: 'create_project', description: '新建项目（Python）。可以同时提供 main.py 的完整代码，会写入并编译。一个策略想法只建一个项目：基准、对照、消融都放在同一个项目里（另写 benchmark.py 等文件，或直接用 LEAN 自带的基准曲线），不要为它们另建项目。',
    inputSchema: { type: 'object', properties: { name: str, description: str, code: { ...str, description: 'main.py 完整代码（可选）' } }, required: ['name'] },
    async run({ name, description, code }) {
      if (code && String(process.env.HELM_WRITE_ONLY || '').trim()) {
        return '错误：你不能写策略代码。先不带 code 建项目、存好 spec.md，再用 handoff 交给 engineer（策略工程师）写 main.py。';
      }
      const r = await E.createProject({ name, description, code });
      if (!r.success) return failText(r);
      const p = r.projects[0];
      let out = `已创建项目「${p.name}」，projectId=${p.projectId}`;
      if (code) out += `\n${compileText(await E.compileProject({ projectId: p.projectId }))}`;
      return out;
    },
  },
  {
    name: 'update_project', description: '修改项目名称或说明。',
    inputSchema: { type: 'object', properties: { ...P, name: str, description: str }, required: ['projectId'] },
    async run(a) { const r = await E.updateProject(a); return r.success ? '已更新' : failText(r); },
  },
  {
    name: 'read_file', description: '读取项目里的一个文件。',
    inputSchema: { type: 'object', properties: { ...P, name: { ...str, description: '文件名，如 main.py' } }, required: ['projectId', 'name'] },
    async run({ projectId, name }) {
      const r = await E.filesRead({ projectId, name });
      return r.success ? clip(r.files[0].content) : failText(r);
    },
  },
  {
    name: 'write_file', description: '写入（覆盖）或新建项目里的 .py 文件，写完自动编译并返回结果。修改代码时先 read_file，再传入完整的新内容。',
    inputSchema: { type: 'object', properties: { ...P, name: str, content: str }, required: ['projectId', 'name', 'content'] },
    async run({ projectId, name, content }) {
      // 调度型 agent（总控）只能写规则说明：代码由策略工程师写。名单来自 agents.json 的 writeOnly，由 server 经环境变量传进来
      const only = String(process.env.HELM_WRITE_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (only.length && !only.includes(String(name))) {
        return `错误：你只能写 ${only.join('、')}。${name} 是代码，请用 handoff 交给 engineer（策略工程师）写，把规则说明完整写进任务说明。`;
      }
      const r = await E.writeProjectFile({ projectId, name, content });
      if (!r.success) return failText(r);
      const c = await E.compileProject({ projectId });
      return `${r.created ? '已新建' : '已更新'} ${name}（${String(content).split('\n').length} 行）\n${compileText(c)}`;
    },
  },
  {
    name: 'delete_file', description: '删除项目里的文件（危险操作，不能删 main.py）。',
    inputSchema: { type: 'object', properties: { ...P, name: str }, required: ['projectId', 'name'] },
    async run(a) { const r = await E.deleteProjectFile(a); return r.success ? `已删除 ${a.name}` : failText(r); },
  },
  {
    name: 'compile', description: '检查项目代码的语法错误，以及是否有继承 QCAlgorithm 的类。',
    inputSchema: { type: 'object', properties: P, required: ['projectId'] },
    async run({ projectId }) { const c = await E.compileProject({ projectId }); return c.success ? compileText(c) : failText(c); },
  },
  {
    name: 'fetch_data', description: '下载或更新美股/ETF 日线数据（Yahoo 复权价）到本地 LEAN 数据目录。回测时会自动下载代码里 add_equity 用到的代码，一般不用手动调用；动态选股前要先用它准备股票池。',
    inputSchema: { type: 'object', properties: { tickers: { type: 'array', items: str, description: '如 ["AAPL","MSFT","BRK.B"]' }, force: { type: 'boolean', description: '强制重新下载' } }, required: ['tickers'] },
    async run({ tickers, force }) {
      const r = await E.fetchData(tickers, { force });
      return r.error ? `下载失败：${r.error}` : JSON.stringify(r.results, null, 1);
    },
  },
  {
    name: 'fetch_macro', description: '下载或更新 FRED 宏观序列（利率、信用利差、收益率曲线、失业率等）到本地 LEAN 数据目录，策略里用 helm_data.HelmMacro("<ID>") 读取，只给当时已经公布的值。回测前会自动下载代码里用到的序列；先手动调用可以确认序列代码对不对、数据从哪年开始。常用：DGS2（2 年期美债）、DGS10、T10Y2Y（10 年减 2 年）、T10Y3M、DFF（联邦基金有效利率）、BAA10Y（Baa 公司债减 10 年美债，1986 年起，信用利差首选）、VIXCLS（1990 起）、NFCI（芝加哥联储金融条件，周度）、UNRATE、CPIAUCSL。注意：ICE BofA 系列（如 BAMLH0A0HYM2 高收益债利差）在 FRED 上只有最近 3 年，不能用来做长期回测。',
    inputSchema: { type: 'object', properties: { series: { type: 'array', items: str, description: 'FRED 序列代码，如 ["DGS2","BAMLH0A0HYM2"]' }, force: { type: 'boolean', description: '强制重新下载' } }, required: ['series'] },
    async run({ series, force }) {
      const r = await fetchMacro(series, { dataDir: E.DATA_DIR, force });
      return r.results.map((x) => x.status === 'error' ? `${x.id}: 失败 ${x.error}${x.stale ? `（本地有旧数据 ${x.start} → ${x.end}）` : ''}` : `${x.id}: ${x.start} → ${x.end}，${x.rows} 个观测，间隔约 ${x.gapDays} 天${x.status === 'cached' ? '（20 小时内已下载）' : ''}`).join('\n');
    },
  },
  {
    name: 'list_data', description: '列出本地已有数据的代码和日期范围。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const d = await E.listData();
      const rows = Object.entries(d).map(([t, m]) => `${t.toUpperCase()}: ${m.start} → ${m.end}`);
      return rows.length ? rows.join('\n') : '本地还没有通过 Yahoo 下载的数据。';
    },
  },
  {
    name: 'save_dataset',
    description: '把你从网上查到的信息整理成「自建数据集」，存进本地 LEAN 数据目录；策略里用 helm_data.HelmDataset("<name>") 读取（只给当时已公开的行，没有前视）。只在 Helm 本地没有这类数据时用（价格用 fetch_data，宏观用 fetch_macro）。规则：1) 每一行必须来自你抓取到的网页，不许凭记忆或猜测填；2) 每行必须有 available_date（YYYY-MM-DD）= 这条信息第一次公开的日期（公告、申报、发布日），不是事件生效日；3) 每行必须有 source = sources 的序号（或网址），保证能追溯；4) 公司层面的数据要有 symbol（美股代码，和 fetch_data 一样）。kind=events：列 available_date、symbol（可选）、event、value（可选）、source；kind=attributes：列 available_date、symbol、field、value、source，属性随时间变化就加 available_date 更晚的新行；kind=timeseries：列 available_date、date、symbol（可选）、value（数字）、source，available_date 不能早于 date。最多 50,000 行、5 MB，同一（symbol、available_date、event/field/date）不能重复。只找到一部分就存下找到的，在 notes 里写清缺了哪些年份/公司。限制：不收集、不推断具体个人的健康、残疾、宗教、性取向等敏感特征，命中会被拒绝；改用公司层面的公开代理指标。同名再存会替换并升版本号。',
    inputSchema: { type: 'object', properties: {
      name: { ...str, description: '小写字母、数字、下划线，2–40 个字符，如 sp500_adds' },
      description: { ...str, description: '一句话：这是什么数据、覆盖哪些年份和公司' },
      kind: { ...str, enum: ['events', 'attributes', 'timeseries'] },
      columns: { type: 'array', items: str, description: '列名，如 ["available_date","symbol","event","source"]' },
      rows: { type: 'array', items: { type: 'object' }, description: '每行一个对象，键是列名；source 是 sources 的序号（从 0 开始）' },
      sources: { type: 'array', items: { type: 'object', properties: { url: str, title: str, retrieved_at: { ...str, description: 'YYYY-MM-DD，你抓取它的日期' } } }, description: '来源网页' },
      notes: { ...str, description: '覆盖范围和已知缺口（哪些年份/公司没找到）' },
    }, required: ['name', 'description', 'kind', 'columns', 'rows', 'sources'] },
    async run(a) {
      const r = await saveDataset(a, { dataDir: E.DATA_DIR });
      if (!r.success) return failText(r);
      const m = r.meta;
      return `已保存自建数据集 ${m.name} v${m.version}${r.replaced ? '（替换了旧版本）' : ''}：${m.rows} 行，${m.symbols} 个代码，公开日期 ${m.firstAvailable} → ${m.lastAvailable}，${m.sources.length} 个来源。策略里：from helm_data import HelmDataset; ds = HelmDataset("${m.name}")。注意：每一行都要能追溯到来源；回测结论会标注「数据是 agent 从网上整理的」。`;
    },
  },
  {
    name: 'list_datasets', description: '列出已有的自建数据集（名字、类型、行数、代码数、公开日期范围、版本、来源数、说明和覆盖缺口）。缺数据时先看这里有没有现成的。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const r = await listDatasets({ dataDir: E.DATA_DIR });
      return r.datasets.length ? r.datasets.map((m) => `- ${m.name} v${m.version}（${m.kind}）：${m.description}｜${m.rows} 行，${m.symbols} 个代码，公开日期 ${m.firstAvailable} → ${m.lastAvailable}，${(m.sources || []).length} 个来源，更新 ${String(m.updated).slice(0, 10)}${m.notes ? `｜备注：${m.notes}` : ''}`).join('\n') : '还没有自建数据集。';
    },
  },
  {
    name: 'read_dataset', description: '分页读取一个自建数据集的内容和来源（只读）。start 是起始行，limit 每页最多 500 行。',
    inputSchema: { type: 'object', properties: { name: { ...str, description: '数据集名' }, start: { ...int, description: '起始行，默认 0' }, limit: { ...int, description: '行数，默认 100，最多 500' } }, required: ['name'] },
    async run({ name, start, limit }) {
      const r = await readDataset({ dataDir: E.DATA_DIR, name, start, limit });
      if (!r.success) return failText(r);
      return clip(JSON.stringify({ meta: r.meta, total: r.total, start: r.start, rows: r.rows }, null, 1));
    },
  },
  {
    name: 'create_backtest', description: '编译并在本地 LEAN 引擎上运行回测（自动下载需要的数据）。运行前必须先想清楚这次回测的角色（role）和时间段（period）。基准、对照策略不要另建项目：写成同一项目里的另一个文件（如 benchmark.py），用 file 参数运行。返回 backtestId，然后用 wait_for_backtest 等结果，通常几秒到一分钟。',
    inputSchema: { type: 'object', properties: { ...P, name: { ...str, description: '回测名称，建议写清这次改了什么' }, ...TAGS, file: { ...str, description: '要运行的入口文件，默认 main.py；基准/对照用 benchmark.py、control.py 这类同项目文件' } }, required: ['projectId', 'name', 'role', 'period'] },
    async run({ projectId, name, role, period, file }) {
      const r = await E.createBacktest({ projectId, name, role, period, file });
      if (!r.success) return failText(r);
      if (!r.backtest) return `没有运行回测，因为代码检查没通过（这次不算尝试）：\n${compileText(r.compile)}`;
      const b = r.backtest;
      const warn = b.holdoutSeq > 1 ? `\n⚠ 这是本项目第 ${b.holdoutSeq} 次看验证期。验证期已经不是干净的样本外了，结论里必须写明这一点；不要根据这次结果再改参数。` : '';
      const mainNote = b.role === 'main' ? '\n注意：选了 main，跑完后要通过统计检验（validate_backtest 的同一套门槛）才会保留，否则自动降为 candidate。' : '';
      return `已开始回测「${b.name}」，backtestId=${b.backtestId}（projectId=${projectId}）。网站会自动显示进度。${warn}${mainNote}`;
    },
  },
  {
    name: 'wait_for_backtest', description: '等待回测完成（每 2 秒查一次，最多 timeoutSec 秒，默认 180），完成后返回统计或错误。',
    inputSchema: { type: 'object', properties: { ...PB, timeoutSec: { ...int, description: '默认 180，上限 600' } }, required: ['projectId', 'backtestId'] },
    async run({ projectId, backtestId, timeoutSec = 180 }) {
      const deadline = Date.now() + Math.min(Math.max(timeoutSec, 5), 600) * 1000;
      let r;
      while (Date.now() < deadline) {
        r = await E.backtestsRead({ projectId, backtestId });
        if (!r.success) return failText(r);
        if (/Completed|Error/.test(r.backtest.status)) break;
        await sleep(2000);
      }
      return JSON.stringify(summarize(r.backtest), null, 1);
    },
  },
  {
    name: 'read_backtest', description: '读取回测的状态、错误和主要统计。',
    inputSchema: { type: 'object', properties: PB, required: ['projectId', 'backtestId'] },
    async run(a) {
      const r = await E.backtestsRead(a);
      if (!r.success) return failText(r);
      // 数据与代码指纹：只给摘要（完整的每只股票列表在网页上看），同样的代码数据变了时明确提醒
      const b = r.backtest;
      const fp = b.fingerprint;
      const c = b.fingerprintCheck || {};
      const kindZh = { altered: '同一段日期内价格被改过', extended: '数据变长', shortened: '数据变短', changed: '起点或行数变了', added: '这次才有数据', removed: '这次缺数据', newTicker: '新订阅', droppedTicker: '不再订阅' };
      let fingerprint;
      if (!fp || !fp.code) fingerprint = '没有记录（指纹功能上线前的回测）';
      else {
        fingerprint = {
          code: fp.code.hash.slice(0, 12), codeFiles: Object.fromEntries(Object.entries(fp.code.files || {}).map(([n, h]) => [n, String(h).slice(0, 12)])),
          data: fp.data ? fp.data.hash.slice(0, 12) : (fp.dataError ? `没记下：${fp.dataError}` : '还没记下'),
          tickers: fp.data ? fp.data.count : undefined, missingData: fp.data && fp.data.missing.length ? fp.data.missing.slice(0, 50) : undefined,
        };
        if (c.status === 'dataChanged') {
          fingerprint.warning = `同样的代码，数据和之前不同：和回测 ${c.ref.backtestId}（${c.ref.name}）比，${c.changedCount} 只股票的数据变了${c.altered ? `，其中 ${c.altered} 只是同一段日期内价格被改过` : ''}。结果差异可能来自数据而不是策略，解读时要告诉用户。`;
          fingerprint.changed = (c.changed || []).slice(0, 30).map((x) => `${x.ticker}：${kindZh[x.kind] || x.kind}`);
          if (c.changedFiles && c.changedFiles.length) fingerprint.changedFiles = c.changedFiles.map((f) => f.file);
        } else if (c.status === 'codeChanged') fingerprint.vsPrevious = `代码和回测 ${c.ref.backtestId}（${c.ref.name}）不同：${(c.codeFiles || []).map((f) => `${f.file} ${f.kind}`).join('，') || '入口文件不同'}`;
        else if (c.status === 'same') fingerprint.vsPrevious = `和 ${c.sameDataPeers} 个代码相同的回测数据也相同`;
      }
      return JSON.stringify({ ...summarize(b), fingerprint }, null, 1);
    },
  },
  {
    name: 'list_backtests', description: '列出某个项目的所有回测和关键指标。',
    inputSchema: { type: 'object', properties: P, required: ['projectId'] },
    async run(a) {
      const r = await E.backtestsList(a);
      if (!r.success) return failText(r);
      return JSON.stringify(r.backtests.map(({ backtestId, name, status, created, netProfit, compoundingAnnualReturn, sharpeRatio, drawdown, winRate, trades, note, role, period, holdoutSeq, mainRejected }) => ({ backtestId, name, status, role, period, holdoutSeq: holdoutSeq || undefined, mainRejected: mainRejected || undefined, created, netProfit, cagr: compoundingAnnualReturn, sharpe: sharpeRatio, drawdown, winRate, trades, note: note || undefined })), null, 1);
    },
  },
  {
    name: 'read_backtest_orders', description: '读取回测的订单（每次最多 100 条，用 start/end 翻页）。',
    inputSchema: { type: 'object', properties: { ...PB, start: int, end: int }, required: ['projectId', 'backtestId'] },
    async run({ projectId, backtestId, start = 0, end = 100 }) {
      const r = await E.ordersRead({ projectId, backtestId, start, end: Math.min(end, start + 100) });
      return r.success ? clip(JSON.stringify({ total: r.length, orders: r.orders }, null, 1)) : failText(r);
    },
  },
  {
    name: 'read_backtest_log', description: '读取回测日志（self.debug / self.log 的输出），可以按关键词过滤。',
    inputSchema: { type: 'object', properties: { ...PB, query: str, start: int, end: int }, required: ['projectId', 'backtestId'] },
    async run(a) { const r = await E.logRead(a); return r.success ? clip(`共 ${r.length} 行\n${r.logs.join('\n')}`) : failText(r); },
  },
  {
    name: 'read_backtest_code', description: '读取某次回测当时运行的代码快照。',
    inputSchema: { type: 'object', properties: PB, required: ['projectId', 'backtestId'] },
    async run(a) { const r = await E.backtestCode(a); return r.success ? clip(r.files.map((f) => `### ${f.name}\n${f.content}`).join('\n\n')) : failText(r); },
  },
  {
    name: 'update_backtest', description: '给回测改名、写备注，或修改角色/时间段标签（比如把被取代的回测标为 debug，把最终版本标为 main）。',
    inputSchema: { type: 'object', properties: { ...PB, name: str, note: str, ...TAGS }, required: ['projectId', 'backtestId'] },
    async run(a) { const r = await E.updateBacktest(a); return r.success ? '已更新' : failText(r); },
  },
  {
    name: 'delete_backtest', description: '永久删除回测（危险操作）。',
    inputSchema: { type: 'object', properties: PB, required: ['projectId', 'backtestId'] },
    async run(a) { const r = await E.deleteBacktest(a); return r.success ? '已删除' : failText(r); },
  },

  /* ---------------- 统计检验 ---------------- */
  {
    name: 'robustness_backtest',
    description: '稳健性分析（只读，只用这个回测已存的结果文件，不重跑）：按年和三等份的收益/夏普/回撤/超额、成交成本压力（额外 5/10/25/50 个基点，和让超额归零的临界成本；换手由成交额估算）、市场状态（基准 200 日均线趋势 × 20 日波动，只用前一日信息）、一句话结论。引用稳健性数字时用这个工具的结果，不要自己另算。',
    inputSchema: { type: 'object', properties: PB, required: ['projectId', 'backtestId'] },
    async run(a) { const r = await loadRobust(E.PROJECTS_DIR, a.projectId, a.backtestId, LANG); return r.success ? robustText(r.robust, LANG) : failText(r); },
  },
  {
    name: 'sensitivity_backtest',
    description: '参数敏感性结果（只读，不会触发重跑）：策略里用 self.get_parameter("名字", 默认值) 声明的参数，各 ×0.8、×1.2 重跑后，原版 vs 变体的年化、夏普、最大回撤，以及每个参数的判定（稳 / 敏感 / 方向翻转）。运行由用户在网页稳健性页点按钮触发；验证期回测不提供。这些变体只是诊断，不是回测记录；挑最好的变体采用就是调参，必须作为新的回测重跑并计入尝试次数。引用数字时用这个工具的结果。',
    inputSchema: { type: 'object', properties: PB, required: ['projectId', 'backtestId'] },
    async run(a) {
      const r = await E.sensitivityRead(a);
      if (!r.success) return failText(r);
      const S = r.sensitivity;
      if (!S) return `还没有运行过参数敏感性。${r.canRun ? `可以运行：${r.params.length} 个参数，共 ${r.plan.length} 次重跑（在网页稳健性页点「运行参数敏感性」）。` : `不能运行：${r.reason}`}`;
      const L = [`状态：${S.status === 'running' ? `运行中 ${Math.round((S.progress || 0) * 100)}%（${S.phase || ''}）` : S.status === 'done' ? '已完成' : `出错：${S.error}`}`];
      if (S.base) L.push(`原版：年化 ${S.base.annualReturn ?? '—'}，夏普 ${S.base.sharpe ?? '—'}，最大回撤 ${S.base.maxDrawdown ?? '—'}`);
      const v = (x) => (x ? (x.status === 'ok' ? `${x.value}：年化 ${x.annualReturn ?? '—'}，夏普 ${x.sharpe ?? '—'}，回撤 ${x.maxDrawdown ?? '—'}` : `${x.value}：没跑成功（${x.error}）`) : '没跑（值不可用）');
      for (const row of S.rows || []) L.push(`【${row.name}】默认 ${row.default} → ${row.verdict || '无法判断'}（${row.reason}）`, `  −20%：${v(row.lo)}`, `  +20%：${v(row.hi)}`);
      if (S.conclusion) L.push(`结论：${S.conclusion}`);
      if (S.dataChanged) L.push('注意：本地行情数据在原回测之后更新过，原版和变体的数据不完全相同。');
      L.push(`共重跑 ${S.variantsRun || 0} 个变体。${S.warning}`);
      return L.join('\n');
    },
  },
  {
    name: 'tune_backtest',
    description: `开始调参（超参数搜索）：对一个已完成的开发期回测，在 self.get_parameter 参数的范围里做拉丁超立方随机搜索，每组参数在同一段开发期上跑一次 LEAN（后台进程，原参数直接用原回测）。
选参不挑单点最好，挑「参数平台」（附近的参数也好）；用 CSCV 估计回测过拟合概率 PBO；结论按固定规则给出（PBO > 0.5 或改进不够大就保持原参数）。
**每个候选都计入尝试次数**，之后所有统计检验的门槛都会抬高，所以只在有理由时调：参数敏感性显示「敏感」、或规则说明里的参数本来就是拍脑袋定的。不要为了让检验通过而调。
验证期回测、全期回测不能调。budget = 候选个数（默认 16，6–40）；ranges 可选，{参数名: [下限, 上限]}，同号、离默认值不超过 10 倍；不写就是默认值 ÷2 到 ×2。
开始后用 read_tuning(waitSec) 等结果。`,
    inputSchema: { type: 'object', properties: { ...PB, budget: { ...int, description: '候选个数，默认 16' }, ranges: { type: 'object', description: '{参数名: [下限, 上限]}，可选' } }, required: ['projectId', 'backtestId'] },
    async run(a) {
      const r = await E.runTune(a);
      if (!r.success) return failText(r);
      const t = r.tuning;
      return `${r.message}\n搜索范围：${t.ranges.map((x) => `${x.name} ${x.lo}–${x.hi}（默认 ${x.default}）`).join('；')}\n用 read_tuning(projectId=${a.projectId}, backtestId=${a.backtestId}, waitSec=600) 等结果。`;
    },
  },
  {
    name: 'read_tuning',
    description: '读取调参结果（只读）：进度、每组参数的夏普、推荐参数（参数平台）、原参数、PBO 和结论。waitSec > 0 时最多等这么多秒直到跑完。',
    inputSchema: { type: 'object', properties: { ...PB, waitSec: { ...int, description: '最多等几秒（0–900）' } }, required: ['projectId', 'backtestId'] },
    async run({ projectId, backtestId, waitSec = 0 }) {
      const until = Date.now() + Math.min(900, Math.max(0, Number(waitSec) || 0)) * 1000;
      let r = await E.tuneRead({ projectId, backtestId });
      while (r.success && r.tuning && r.tuning.status === 'running' && Date.now() < until) {
        await new Promise((ok) => setTimeout(ok, 3000));
        r = await E.tuneRead({ projectId, backtestId });
      }
      if (!r.success) return failText(r);
      const T = r.tuning;
      if (!T) return `还没有调过参。${r.canRun ? `可以调：${r.params.map((p) => `${p.name}=${p.default}`).join('，')}。用 tune_backtest 开始。` : `不能调：${r.reason}`}`;
      if (T.status === 'running') return `运行中 ${Math.round((T.progress || 0) * 100)}%（${T.phase || ''}），已完成 ${T.done}/${T.total}，已计入尝试 ${T.trialsAdded} 次。`;
      if (T.status === 'error') return `错误：${T.error}`;
      const R = T.result;
      const fmt = (v) => Object.entries(v || {}).map(([k, x]) => `${k}=${x}`).join(', ');
      const L = [`方法：${T.method}`, `候选 ${R.candidatesOk} 组跑成功，共 ${R.days} 个交易日；新增尝试 ${T.trialsAdded} 次（之后的统计检验门槛会更高）。`];
      L.push(`原参数：${fmt(R.default.values)}，夏普 ${R.default.sharpe ?? '—'}，平台夏普 ${R.default.smooth != null ? R.default.smooth.toFixed(2) : '—'}`);
      if (R.recommended) L.push(`推荐（参数平台最高）：${fmt(R.recommended.values)}，夏普 ${R.recommended.sharpe ?? '—'}，平台夏普 ${R.recommended.smooth.toFixed(2)}`);
      if (R.rawBest) L.push(`单点最好（仅供参考，不采用）：${fmt(R.rawBest.values)}，夏普 ${R.rawBest.sharpe}`);
      L.push(R.pbo ? `PBO（回测过拟合概率，CSCV，${R.pbo.S} 段 ${R.pbo.combos} 种组合）= ${R.pbo.pbo.toFixed(2)}；样本内最好的参数在样本外亏损的概率 ${R.pbo.probLoss.toFixed(2)}` : 'PBO：开发期太短或候选太少，没法估计');
      L.push(`结论：${R.verdict.text}`, `下一步：${R.next}`);
      L.push('所有候选：', ...T.candidates.map((c) => `  ${c.id}${c.isDefault ? '（原参数）' : ''} ${fmt(c.values)} → ${c.status === 'ok' ? `夏普 ${c.sharpe}，年化 ${c.annualReturn ?? '—'}，回撤 ${c.maxDrawdown ?? '—'}` : `失败：${c.error}`}`));
      return L.join('\n');
    },
  },
  {
    name: 'validate_backtest',
    description: `对一个已完成的回测做统计检验（指标一致性核对、块自助法夏普置信区间、相对基准的超额收益、按本项目尝试次数去膨胀的夏普、验证期被看过几次）。${GATE_RULES}判断一个回测“是不是真的好”时用它，不要凭感觉。`,
    inputSchema: { type: 'object', properties: PB, required: ['projectId', 'backtestId'] },
    async run(a) {
      const r = await E.validateBacktest(a);
      if (!r.success) return failText(r);
      const v = r.validation;
      const c = v.consistency;
      const clash = c && !c.ok ? `⛔ 指标互相矛盾：LEAN 报出的数字之间对不上，这个回测的收益、回撤等数字都不可信，不能标 main，也不要据此下结论；把下面每一条矛盾原样告诉用户（工具不会自动修正任何数字）。\n${c.failures.map((f) => `  - ${f}`).join('\n')}` : null;
      if (!v.ok) return clash ? `${clash}\n${v.reason.split('；另外指标互相矛盾')[0]}` : v.reason;
      const lines = [`结论：${v.pass ? '✅ 通过，可以标为主版本' : '❌ 没通过，不能标为主版本'}`];
      if (clash) lines.push(clash);
      for (const g of v.gates) lines.push(`${g.ok ? '✓' : '✗'} ${g.zh} —— ${g.id === 'consistency' && !g.ok ? `${c.failures.length} 处矛盾，见上` : g.detail}`);
      for (const w of v.warnings) lines.push(`⚠ ${w}`);
      const n = v.numbers;
      lines.push(`数字：夏普(rf=0) ${n.sharpe.toFixed(2)}，P(夏普≤0)=${n.pSharpeLe0 == null ? '—' : n.pSharpeLe0.toFixed(3)}，概率夏普 ${n.psr == null ? '—' : (n.psr * 100).toFixed(1) + '%'}，相对基准概率夏普 ${n.psrVsBenchmark == null ? '—' : (n.psrVsBenchmark * 100).toFixed(1) + '%'}，信息比率 ${n.infoRatio == null ? '—' : n.infoRatio.toFixed(2)}，样本 ${n.years.toFixed(1)} 年`);
      lines.push(v.rules);
      return lines.join('\n');
    },
  },

  /* ---------------- qlib：股票池 ---------------- */
  {
    name: 'list_universes',
    description: '列出可用的股票池（来自本机 qlib）：S&P 500、纳斯达克 100（历史成分股，去除幸存者偏差）、道琼斯 30、费城半导体、S&P 100、罗素样本（快照）。显示成分股是“历史真实”还是“今天的快照”，以及 LEAN 数据是否已经准备好。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const r = await Q.listUniverses({ fresh: true });
      if (!r.success) return failText(r);
      const kindZh = { 'point-in-time': '历史成分（逐日精确）', 'partial-point-in-time': '历史成分（只记录到名单截止日，之后按那天的名单冻结）', snapshot: '今天的快照（有幸存者偏差）' };
      return r.universes.map((u) => {
        const ex = u.exported;
        const job = u.job && u.job.status === 'running' ? `准备中：${u.job.phase || ''} ${Math.round((u.job.progress || 0) * 100)}%` : null;
        return `- ${u.key}（${u.label}）：${kindZh[u.kind] || u.kind}${u.kind === 'partial-point-in-time' ? `【名单截止 ${u.qlib_as_of}】` : ''}${u.membership_source ? `【名单到 ${u.qlib_as_of}，来源：${u.membership_source}】` : ''}${u.data_warning ? `【⚠ ${u.data_warning}】` : ''}，历史上共 ${u.names_ever ?? '?'} 只；基准 ${u.bench}；LEAN 数据：${job || (ex ? `已就绪（${ex.start} → ${ex.end}，${ex.names_with_prices} 只有价格，每天约 ${ex.members_per_day && ex.members_per_day.median} 只成员，导出于 ${ex.exported}）` : '未准备（用 prepare_universe）')}`;
      }).join('\n');
    },
  },
  {
    name: 'universe_members',
    description: '查询某个股票池在某一天的真实成分股（历史成分股，不是今天的名单）。',
    inputSchema: { type: 'object', properties: { index: { type: 'string', enum: Q.UNIVERSE_KEYS }, date: { ...str, description: 'YYYY-MM-DD' } }, required: ['index', 'date'] },
    async run(a) {
      const r = await Q.universeMembers(a);
      if (!r.success) return failText(r);
      return `${r.index} 在 ${r.date}：${r.count} 只（${r.kind}；来源 ${r.source}）\n${r.members.join(', ')}${r.notes && r.notes.length ? `\n注：${r.notes.join(' ')}` : ''}`;
    },
  },
  {
    name: 'prepare_universe',
    description: '把一个股票池的全部历史成员（含已退市、改名的股票）的日线数据和逐日成分名单导出到本地 LEAN。价格来源、日期对齐、改名识别全部由项目里的 qlib 研究引擎完成。准备好之后，策略里用 `from helm_data import HelmUniverse` 读取。第一次准备 S&P 500 要下载约 800 只股票，可能要 5–15 分钟；wait=true 会等到完成（最多 20 分钟）。',
    inputSchema: { type: 'object', properties: { index: { type: 'string', enum: Q.UNIVERSE_KEYS }, start: { ...str, description: '数据起始日，默认 2008-01-01' }, wait: { type: 'boolean' } }, required: ['index'] },
    async run({ index, start, wait = false }) {
      const r = await Q.prepareUniverse({ index, start });
      if (!r.success) return failText(r);
      if (!wait) return `${r.already ? '已经在准备中' : '已开始准备'} ${index}。网站首页会显示进度；用 list_universes 查看是否就绪。`;
      const deadline = Date.now() + 20 * 60 * 1000;
      let st;
      while (Date.now() < deadline) {
        await sleep(5000);
        st = await Q.universeStatus({ index });
        if (st.job && st.job.status !== 'running') break;
      }
      if (!st || !st.job) return '状态未知';
      if (st.job.status === 'failed') return `错误：准备失败：${st.job.error}`;
      if (st.job.status === 'running') return `还在准备（${st.job.phase}），稍后用 list_universes 查看。`;
      const s = st.summary;
      return `✅ ${index} 已就绪：${s.membership_kind}，${s.names_with_prices}/${s.names_ever} 只有价格（成员日覆盖率 ${(s.coverage * 100).toFixed(1)}%），${s.start} → ${s.end}，每天 ${s.members_per_day.min}–${s.members_per_day.max} 只成员。${s.survivorship_note || ''}\n用法：\nfrom helm_data import HelmUniverse\nuni = HelmUniverse("${index}")\nfor t in uni.tickers(): self.add_equity(t, Resolution.DAILY)\nmembers = uni.members(self.time)`;
    },
  },

  /* ---------------- qlib：研究任务 ---------------- */
  {
    name: 'test_idea',
    description: `想法检验（选股类想法的第一步）：把用户一句话的想法写成 1–5 个打分因子，在历史成分股（去除幸存者偏差）上只用开发期数据检验，几分钟出结果，验证期不碰。
输出每个因子在不同持有天数下的 IC（打分和未来收益的相关性）、分五组的年化收益和多空价差（扣成本）、换手率、逐年是否成立、和动量/反转/波动/规模/价值这些已知因子的相关性，以及按多重检验校正后的结论：有信号 / 信号弱 / 没有信号。“没有信号”是有效结论，照实告诉用户，不要换着公式一直试（每试一个都会提高以后的门槛）。
每个因子由 1–4 个组成部分构成，每部分二选一：
- expr：Qlib 表达式，只能用 $open $high $low $close $volume $vwap $mkt 和运算符 Ref Mean Std Var Sum Max Min Med Mad Skew Kurt Delta Slope Rsquare Resi Corr Cov Rank Abs Log Sign Power If Gt Ge Lt Le Eq Ne And Or Not Greater Less Quantile IdxMax IdxMin EMA WMA Count Mask，例如 12-1 动量 "Ref($close,21)/Ref($close,252)-1"；$mkt 是这个股票池自己的等权市场日收益（当天成分股、当天和前一天都有价格的股票的日收益平均，只用当天和前一天的数据），用来去掉市场敏感度，例如滚动 beta "Cov($close/Ref($close,1)-1,$mkt,252)/Var($mkt,252)"、残差波动 "Std($close/Ref($close,1)-1-Cov($close/Ref($close,1)-1,$mkt,252)/Var($mkt,252)*$mkt,252)"（只用 $mkt、不用股票自己字段的公式会被拒绝）；
- fundamental：SEC 财报字段名（时点正确，只用当时已公布的财报）：${FUND_FIELDS}。
多个组成部分各自按天做横截面排名，按 weight 加权（负权重表示越低越好）。分数越高越该买。
只适合“在一批股票里比较挑选”的想法；少数几个 ETF 择时的想法用不上，直接写 LEAN。完成后用 research_status / read_research 看结果，有信号再用 export_signals(ideaFactor=...) 导出，写 LEAN 策略回测。`,
    inputSchema: {
      type: 'object',
      properties: {
        ...P,
        idea: { ...str, description: '用户的原话（一句话想法）' },
        target: { ...str, description: 'sp500（默认）/ QQQ（纳指100）/ SOX / DIA / spy100 / iwm80 / custom' },
        tickers: { type: 'array', items: str, description: 'target=custom 时的股票列表（至少 20 只）' },
        factors: {
          type: 'array', description: '1–5 个因子',
          items: { type: 'object', properties: { name: { ...str, description: '小写英文名，如 low_pe' }, label: { ...str, description: '中文名' }, components: { type: 'array', items: { type: 'object', properties: { expr: str, fundamental: str, weight: { type: 'number' } } } } }, required: ['name', 'components'] },
        },
        horizons: { type: 'array', items: int, description: '持有天数，默认 [5, 20, 60]' },
        start: { ...str, description: '数据起点，默认 2008-01-01' },
        title: str,
      },
      required: ['projectId', 'idea', 'factors'],
    },
    async run(a) {
      const r = await Q.startIdea(a);
      if (!r.success) return failText(r);
      return `已开始想法检验 jobId=${r.job.jobId}「${r.job.title}」：${r.job.spec.factors.map((f) => f.label || f.name).join('、')}。一般几分钟，网站「研究」标签实时显示；用 research_status(waitSec) 等完成，再用 read_research 读结果。`;
    },
  },
  {
    name: 'start_research',
    description: `用 qlib 研究引擎做一次系统化研究（后台运行，网站“研究”标签实时显示）。流程：历史成分股 → 价格对齐 → 冻结滚动训练/验证期 → Alpha158 价量因子和/或 SEC 财报基本面因子 → 只在训练期筛因子和预测周期 → LightGBM 滚动训练 → 打乱标签检验、种子和行情分段 → 组合构建（与等权、动量、随机组合对比）→ 验证期只检验一次 → 判定（候选策略 / 不确定 / 没有可靠策略，后者也是有效结论）。
mode=factors 只做到因子筛选（几分钟，适合先看一个股票池有没有信号）；mode=full 完整研究（30 只股票约 5–10 分钟，100 只约 25 分钟，S&P 500 更久）。advanced=auto 会在 LightGBM 不显著时再试 TRA 模型（多花 30–90 分钟），探索阶段用 off。
target：sp500 / QQQ（纳指100）/ SOX / DIA / spy100 / iwm80，或 custom + tickers。features：alpha158（价量）/ fundamental（SEC 财报：估值、质量、成长、盈利惊喜）/ both。neutralize=sector 做行业中性。`,
    inputSchema: {
      type: 'object',
      properties: {
        ...P,
        target: { ...str, description: 'sp500、QQQ、SOX、DIA、spy100、iwm80 或 custom' },
        tickers: { type: 'array', items: str, description: 'target=custom 时的股票列表（至少 5 只，会被标为快照，有幸存者偏差）' },
        benchmark: { ...str, description: '基准 ETF，默认按 target（sp500→SPY，QQQ→QQQ，SOX→SOXX）' },
        features: { type: 'string', enum: ['alpha158', 'fundamental', 'both'] },
        neutralize: { type: 'string', enum: ['none', 'sector'] },
        mode: { type: 'string', enum: ['factors', 'full'] },
        advanced: { type: 'string', enum: ['off', 'auto', 'tra'] },
        start: { ...str, description: '默认 2008-01-01' },
        holdoutYears: { type: 'number', description: '验证期年数，默认 2' },
        tune: { ...int, description: 'LightGBM 调参的候选个数：0 = 不调（默认，用固定参数）；6–30 = 拉丁超立方随机搜索 + 逐轮淘汰，只用各折的验证年打分，测试年和验证期都不看；PBO > 0.5 或提升 < 0.002 IC 就保留固定参数。大约多花 2–3 倍模型训练时间，只在完整研究里有用。' },
        title: { ...str, description: '给这次研究起个名字' },
      },
      required: ['projectId', 'target'],
    },
    async run(a) {
      const r = await Q.startResearch(a);
      if (!r.success) return failText(r);
      return `已开始研究「${r.job.title}」，jobId=${r.job.jobId}。网站项目页“研究”标签会显示每个阶段的进度。用 research_status（可设 waitSec 等待）查看，完成后用 read_research 读报告。`;
    },
  },
  {
    name: 'research_status',
    description: '查看研究任务的进度。给 jobId 时查单个任务（waitSec>0 会等到任务结束或超时，最多 900 秒）；不给就列出项目的全部研究。',
    inputSchema: { type: 'object', properties: { ...P, jobId: str, waitSec: int }, required: ['projectId'] },
    async run({ projectId, jobId, waitSec = 0 }) {
      if (!jobId) {
        const r = await Q.listResearch({ projectId });
        if (!r.success) return failText(r);
        if (!r.jobs.length) return '这个项目还没有研究任务。';
        return r.jobs.map((j) => `- ${j.jobId}「${j.title}」${j.status}（${Math.round(j.progress * 100)}%${j.current ? `，正在${j.current}` : ''}）${j.verdict ? ` → ${j.verdict}` : ''}`).join('\n');
      }
      const deadline = Date.now() + Math.min(Math.max(waitSec, 0), 900) * 1000;
      let r;
      do {
        r = await Q.readResearch({ projectId, jobId });
        if (!r.success) return failText(r);
        if (r.job.status !== 'running') break;
        if (Date.now() < deadline) await sleep(5000);
      } while (Date.now() < deadline);
      const j = r.job;
      const ph = j.phases.map((p) => `${p.status === 'complete' ? '✓' : p.status === 'running' ? '…' : p.status === 'failed' ? '✗' : '·'}${p.zh}`).join(' ');
      return `「${j.title}」${j.status}，${Math.round(j.progress * 100)}%\n${ph}${j.error ? `\n错误：${j.error}` : ''}${j.logTail && j.logTail.length ? `\n最近日志：\n${j.logTail.slice(-8).join('\n')}` : ''}`;
    },
  },
  {
    name: 'read_research',
    description: '读取研究结果：判定、通过/没通过的门槛、最强的因子、报告全文（含数据覆盖、幸存者偏差和验证期是否被看过的说明）。引用数字时照抄报告，不要自己推算。',
    inputSchema: { type: 'object', properties: { ...P, jobId: str }, required: ['projectId', 'jobId'] },
    async run(a) {
      const r = await Q.readResearch(a);
      if (!r.success) return failText(r);
      const j = r.job;
      const head = [`「${j.title}」状态 ${j.status}（${Math.round(j.progress * 100)}%）`];
      if (j.mode === 'idea') {
        head.push(`想法：${j.idea}`);
        const res = j.ideaResult;
        if (!res) { head.push(j.status === 'failed' ? `出错：${j.error || ''}` : '还没有结果'); return head.join('\n'); }
        head.push(`股票池 ${res.universe}（${res.membership_kind}），开发期 ${(res.dev_window || []).join(' → ')}；验证期 ${(res.holdout_window || []).join(' → ')} 没有用到。成本 ${res.cost_bps} bp。`);
        if (res.trials) head.push(`多重检验：这次 ${res.trials.this_idea} 个因子，这个股票池累计检验过 ${res.trials.universe_total} 个（门槛随之提高）。`);
        for (const f of res.factors || []) {
          const ic = Object.entries(f.ic || {}).map(([h, v]) => `${h}天 IC ${v.mean} (t ${v.t}, 正的比例 ${v.pos_share})`).join('；');
          const q = f.quantiles || {};
          head.push(`\n【${f.label || f.name}】结论：${f.verdict_zh}\n  ${ic}\n  ${q.horizon} 天持有分五组年化：${(q.annual_returns || []).join(' / ')}；多空 ${q.long_short_annual}，扣成本 ${q.long_short_net_annual}${q.monotonic ? '（单调）' : ''}\n  头部换手 ${f.turnover_top_quintile}；逐年成立比例 ${f.share_years_positive}\n  和已知因子相关：${JSON.stringify(f.corr_known || {})}\n  理由：${(f.reasons_zh || []).join('；')}`);
        }
        if (res.summary_zh) head.push(`\n总结：${res.summary_zh}`);
        head.push(`\n有信号的因子用 export_signals(projectId=${j.projectId}, jobId=${j.jobId}, ideaFactor="<因子名>") 导出到 LEAN。`);
        if (j.report) head.push(`\n=== 报告 ===\n${clip(j.report, 20000)}`);
        return head.join('\n');
      }
      if (j.universe) head.push(`股票池：${j.universe.kind}，${j.universe.n} 只；${j.universe.note}`);
      if (j.data) head.push(`价格覆盖：成员日 ${(j.data.coverage * 100).toFixed(1)}%（${j.data.start} → ${j.data.end}，缺 ${j.data.missing} 只）`);
      if (j.topFactors) head.push(`因子筛选（${j.factorWindow ? j.factorWindow.join('→') : '首个训练窗口'}，预测周期 ${j.horizon} 天）：\n${j.topFactors.map((f) => `  ${f.factor}: IC ${f.mean_ic}, ICIR ${f.icir}, t ${f.t_nonoverlap}`).join('\n')}`);
      if (j.weakFactorSignal) head.push('⚠ 引擎判断：因子信号很弱。');
      if (j.verdict) head.push(`判定：${j.verdict}`);
      if (j.hasSignals) head.push(`可以用 export_signals 把模型的滚动预测导出到 LEAN（jobId=${j.jobId}）。`);
      if (j.report) head.push(`\n=== 报告 ===\n${clip(j.report, 30000)}`);
      else if (j.mode === 'factors' && j.status === 'complete') head.push('（因子扫描模式没有完整报告；要继续完整研究用 resume_research full=true）');
      return head.join('\n');
    },
  },
  {
    name: 'resume_research',
    description: '继续一个停下或失败的研究（引擎从第一个没完成的阶段接着跑）。full=true 把“因子扫描”升级成完整研究。',
    inputSchema: { type: 'object', properties: { ...P, jobId: str, full: { type: 'boolean' } }, required: ['projectId', 'jobId'] },
    async run(a) { const r = await Q.resumeResearch(a); return r.success ? `已继续：${r.job.title}（${r.job.mode === 'full' ? '完整研究' : '因子扫描'}）` : failText(r); },
  },
  {
    name: 'stop_research',
    description: '停止一个正在跑的研究（之后可以用 resume_research 接着跑）。',
    inputSchema: { type: 'object', properties: { ...P, jobId: str }, required: ['projectId', 'jobId'] },
    async run(a) { const r = await Q.stopResearch(a); return r.success ? (r.stopped ? '已停止' : '它本来就没在跑') : failText(r); },
  },
  {
    name: 'export_signals',
    description: '把研究得到的每日打分导出到本地 LEAN，让策略按打分交易（真实订单、手续费、成交）。默认导出模型的滚动样本外预测（开发期每年用之前的数据训练，验证期用冻结的模型）；给 feature（如 WVMA60、F_EP）就导出单个因子的原始值。策略里用 `from helm_data import HelmSignals`，`sig.latest(self.time)` 只取严格早于今天的打分，没有前视。',
    inputSchema: { type: 'object', properties: { ...P, jobId: str, feature: { ...str, description: '可选：完整研究里的单个因子名' }, ideaFactor: { ...str, description: '想法检验：要导出的因子名（只有一个因子时可省略）' } }, required: ['projectId', 'jobId'] },
    async run(a) {
      const r = await Q.exportSignals(a);
      if (!r.success) return failText(r);
      const s = r.signals;
      const seg = Object.entries(s.segments || {}).map(([k, v]) => `${k === 'dev' ? '开发期（滚动样本外）' : k === 'holdout' ? '验证期' : '因子'} ${v.start} → ${v.end}`).join('；');
      return `✅ 已导出信号 "${s.name}"：${s.rows} 行，${s.tickers} 只股票；${seg}。预测周期 ${s.horizon_days ?? '?'} 天${s.suggested_portfolio ? `；研究选出的组合参数 ${JSON.stringify(s.suggested_portfolio)}` : ''}${s.verdict ? `；研究判定：${s.verdict}` : ''}。
用法：
from helm_data import HelmSignals, HelmUniverse
sig = HelmSignals("${s.name}")
for t in sig.tickers(): self.add_equity(t, Resolution.DAILY)
picks = sig.top(self.time, k=10)   # 当天可用的打分最高 10 只
回测的时间段要和信号的时间段对齐，并按开发期/验证期分别打 period 标签。`;
    },
  },
  {
    name: 'list_signals',
    description: '列出已经导出到 LEAN 的信号。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const r = await Q.listSignals();
      if (!r.success) return failText(r);
      return r.signals.length ? r.signals.map((s) => `- ${s.name}：${s.kind === 'factor' ? `因子 ${s.feature}` : s.kind === 'idea' ? `想法因子 ${s.factor || ''}` : '模型打分'}，${s.tickers} 只，${Object.entries(s.segments || {}).map(([k, v]) => `${k} ${v.start}→${v.end}`).join('，')}${s.verdict ? `，研究判定 ${s.verdict}` : ''}`).join('\n') : '还没有导出过信号。';
    },
  },

  /* ---------------- 模拟实盘（只读；开始/停止只能由用户在网页上操作） ---------------- */
  {
    name: 'list_paper_sessions',
    description: '列出模拟实盘（前向检验）：把一个跑完的回测冻结后，每个交易日收盘后用最新数据自动重跑，冻结日之后的收益是真正的样本外。mode=sim 是 Helm 内部模拟，mode=alpaca 会在用户自己的 Alpaca 模拟账户下单（只能从通过检验的 main 回测开始；只买卖这个模拟自己买入的仓位，账户里别的持仓不动；数据下载失败或过期的那天不下单）。只能查看，开始和停止只能由用户在网页上操作。',
    inputSchema: { type: 'object', properties: { projectId: { ...int, description: '项目 ID（不填列出全部）' } } },
    async run({ projectId } = {}) {
      const r = await Paper.listSessions({ projectId });
      if (!r.success) return failText(r);
      if (!r.sessions.length) return '还没有模拟实盘。用户可以在回测页面点“开始模拟实盘”。';
      const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);
      return r.sessions.map((s) => {
        const m = s.summary;
        return `- [${s.sessionId}] 项目 ${s.projectId}「${s.name}」：${s.mode === 'alpaca' ? 'Alpaca 模拟账户' : '内部模拟'}，${s.status === 'active' ? '运行中' : '已停止'}，冻结于 ${s.frozenAt || '（首次运行中）'}，来源回测 ${s.sourceBacktestId}` +
          (m ? `；截至 ${m.dataDate} 共 ${m.days} 个交易日，收益 ${pct(m.return)}，基准 ${pct(m.benchmarkReturn)}，最大回撤 ${pct(m.maxDrawdown)}${m.invalidOrders ? `，⚠ ${m.invalidOrders} 笔无效订单` : ''}` : '') +
          (s.lastRun && !s.lastRun.ok ? `；⚠ 上次运行失败：${s.lastRun.error}` : '');
      }).join('\n');
    },
  },
  {
    name: 'read_paper_session',
    description: '读取一个模拟实盘的详情：前向权益曲线、基准、当前目标持仓、冻结后的订单、每日记录（Alpaca 模式含当天的调仓计划和下单结果；策略资金 = 起始资金 + 这个模拟自己的盈亏，不含账户里别的持仓；数据有问题跳过下单的那天有 skipReason；运行失败的那次是 failed: true 加 error，没有净值和持仓，同一个原因连续失败只记第一条）。',
    inputSchema: { type: 'object', properties: { ...P, sessionId: { ...str, description: '模拟 ID（p 开头）' } }, required: ['projectId', 'sessionId'] },
    async run({ projectId, sessionId }) {
      const r = await Paper.readSession({ projectId, sessionId, remote: false });
      if (!r.success) return failText(r);
      const L = r.latest;
      const log = r.log.slice(-10).map((x) => (x.failed ? { dataDate: x.dataDate, runAt: x.runAt, failed: true, error: x.error } : { dataDate: x.dataDate, skipReason: x.skipReason || undefined, equity: x.equity, benchmarkEquity: x.benchmarkEquity, holdings: x.holdings, fetchErrors: x.fetchErrors && x.fetchErrors.length ? x.fetchErrors : undefined, alpaca: x.alpaca ? { equity: x.alpaca.account && x.alpaca.account.equity, orders: x.alpaca.plan && x.alpaca.plan.orders, submitted: x.alpaca.submitted, errors: x.alpaca.errors, note: x.alpaca.note } : undefined }));
      // 执行偏差（上一次下的单实际成交 vs 计划）放在最前面，避免被截断
      const D = (L && L.drift) || (r.log.slice().reverse().find((x) => x.drift) || {}).drift;
      const f2 = (v) => (v == null ? '—' : (+v).toFixed(2));
      const w = (v) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
      let drift;
      if (r.session.mode !== 'alpaca') drift = '执行偏差：不适用（内部模拟按 LEAN 成交规则记账，没有真实成交可对比）。';
      else if (!D) drift = '执行偏差：还没有记录（下一次运行时会对比上一次下的单）。';
      else if (!D.available) drift = `执行偏差：${D.error || D.reason}`;
      else {
        const T = D.totals;
        drift = [`执行偏差（${D.against} 收盘后下的单，正数 = 比计划差）：合计 $${f2(T.shortfallUsd)} = ${f2(T.shortfallBps)} bps 净值；成交滑点 $${f2(T.executionCostUsd)}（成交额加权 ${f2(T.avgSlippageBps)} bps）；未成交机会成本 $${f2(T.opportunityCostUsd)}；${T.notFullyFilled}/${T.orders} 笔没有全部成交${T.missingPrice && T.missingPrice.length ? `；缺现价未计：${T.missingPrice.join('、')}` : ''}`,
          '代码 | 方向 | 状态 | 成交/计划股数 | 参考价→成交均价 | 滑点 bps | 滑点 $ | 目标→实际权重',
          ...D.rows.map((x) => `${x.symbol} | ${x.side === 'buy' ? '买' : x.side === 'sell' ? '卖' : '—'} | ${x.statusZh}${x.error ? `（${x.error}）` : ''} | ${x.filledQty}/${x.qty} | ${f2(x.refPrice)}→${f2(x.fillPrice)} | ${f2(x.slippageBps)} | ${f2(x.slippageUsd)} | ${w(x.targetWeight)}→${w(x.actualWeight)}`),
          `策略不要的持仓：${D.untargeted.length ? D.untargeted.map((u) => `${u.symbol} ${u.qty} 股 $${f2(u.marketValue)}（${w(u.weight)}）`).join('、') : '无'}`,
          D.note].join('\n');
      }
      return clip(`${drift}\n\n${JSON.stringify({ session: r.session, running: r.running, summary: L && L.summary, equity: L && L.equity, benchmark: L && L.benchmark, holdings: L && L.holdings, orders: L && L.orders, recentLog: log }, null, 1)}`);
    },
  },
];

/* ---------------- 参数校验：按每个工具的 inputSchema 检查，类型不对 / 缺字段 / 太长都返回短的中文错误，不进业务代码 ---------------- */

const LONG_FIELDS = { content: 500000, code: 500000 };
const LONG_ARRAYS = { rows: 50000 }; // 自建数据集最多 50,000 行（其余数组最多 2000 项）
export function validateArgs(schema, value, key = '参数', depth = 0) {
  if (!schema || depth > 6) return null;
  const t = schema.type;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${key} 必须是对象`;
    for (const r of schema.required || []) if (value[r] === undefined || value[r] === null || value[r] === '') return `缺少必填参数 ${r}`;
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (value[k] === undefined || value[k] === null) continue;
      const bad = validateArgs(sub, value[k], k, depth + 1);
      if (bad) return bad;
    }
    return null;
  }
  if (t === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return `${key} 必须是整数`;
    if ((key === 'projectId' || key.endsWith('Id')) && value <= 0) return `${key} 必须是正整数`;
    return null;
  }
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : `${key} 必须是数字`;
  if (t === 'boolean') return typeof value === 'boolean' ? null : `${key} 必须是 true 或 false`;
  if (t === 'string') {
    if (typeof value !== 'string') return `${key} 必须是字符串`;
    const max = LONG_FIELDS[key] || (key === 'name' || key === 'title' ? 120 : 20000);
    if (value.length > max) return `${key} 太长了（最多 ${max} 个字符）`;
    if (schema.enum && !schema.enum.includes(value)) return `${key} 只能是：${schema.enum.join(' / ')}`;
    return null;
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return `${key} 必须是数组`;
    const maxN = LONG_ARRAYS[key] || 2000;
    if (value.length > maxN) return `${key} 太多了（最多 ${maxN} 项）`;
    for (const item of value) { const bad = validateArgs(schema.items, item, key, depth + 1); if (bad) return bad; }
    return null;
  }
  return null;
}

/* ---------------- 最小 MCP stdio 实现 ---------------- */

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function onMessage(msg) {
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
  if (id === undefined) return;
  try {
    if (method === 'initialize') {
      return write({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'helm-lean', version: '2.0.0' } } });
    }
    if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      return write({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: LANG === 'en' ? `Unknown tool ${params.name}` : `未知工具 ${params.name}` }], isError: true } });
      const bad = validateArgs(tool.inputSchema, params.arguments === undefined || params.arguments === null ? {} : params.arguments);
      if (bad) return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: userText(`错误：${bad}`) }], isError: true } });
      const text = await tool.run(params.arguments || {});
      return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: userText(text) }], isError: /^错误：|^没有运行回测|^下载失败/.test(text) } });
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: LANG === 'en' ? `Tool failed: ${e.message}` : `工具运行出错：${e.message}` }], isError: true } });
  }
}

let buf = '';
let pending = 0;
let ended = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    // JSON-RPC 2.0：解析不了的行回 -32700（id 为 null），而不是悄悄丢掉
    try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    // 合法 JSON 但不是对象（null、数字……）：onMessage 解构时会抛错，变成未处理的 rejection 让整个 MCP 进程退出
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
    pending++;
    onMessage(msg).finally(() => { pending--; if (ended && !pending) process.exit(0); });
  }
});
process.stdin.on('end', () => { ended = true; if (!pending) process.exit(0); });
