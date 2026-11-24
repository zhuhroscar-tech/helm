// Agent 配置：工具目录、每个 agent 实际能用哪些工具、校验和保存 agents.json。
// 网页「Agents」页和 server.mjs 的 buildArgs 共用这里的口径，保证页面上看到的就是 agent 真正拿到的权限。
import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// qc MCP 工具（和 mcp/qc-mcp.mjs 的 TOOLS 一一对应；test/agents.test.mjs 会核对两边一致）
export const QC_TOOLS = [
  ['handoff', '交接', '协作'], ['ask_user', '开工前问你', '协作'], ['autopilot_plan', '登记想法清单（自动研究）', '协作'],
  ['approve', '权限审批（内部）', '自我修复'], ['verify_changes', '检查改动（跑测试）', '自我修复'], ['revert_my_changes', '撤销自己的改动', '自我修复'],
  ['list_projects', '列出项目', '项目'], ['read_project', '读取项目', '项目'], ['create_project', '新建项目', '项目'], ['update_project', '更新项目', '项目'],
  ['read_file', '读取文件', '代码'], ['write_file', '写入代码', '代码'], ['delete_file', '删除文件', '代码'], ['compile', '语法检查', '代码'],
  ['fetch_data', '下载数据', '数据'], ['fetch_macro', '下载宏观数据', '数据'], ['list_data', '查看本地数据', '数据'],
  ['save_dataset', '保存自建数据集', '数据'], ['list_datasets', '列出自建数据集', '数据'], ['read_dataset', '读取自建数据集', '数据'],
  ['create_backtest', '运行回测', '回测'], ['wait_for_backtest', '等待回测', '回测'], ['read_backtest', '读取回测', '回测'], ['list_backtests', '列出回测', '回测'],
  ['read_backtest_orders', '读取订单', '回测'], ['read_backtest_log', '读取日志', '回测'], ['read_backtest_code', '读取代码快照', '回测'],
  ['update_backtest', '更新回测（含标 main）', '回测'], ['delete_backtest', '删除回测', '回测'],
  ['robustness_backtest', '稳健性分析', '检验'], ['attribute_backtest', '因子归因', '检验'], ['sensitivity_backtest', '参数敏感性', '检验'], ['tune_backtest', '调参（开始）', '检验'], ['read_tuning', '读取调参结果', '检验'], ['validate_backtest', '统计检验', '检验'],
  ['list_universes', '查看股票池', '研究'], ['universe_members', '查询成分股', '研究'], ['prepare_universe', '准备股票池数据', '研究'],
  ['test_idea', '想法检验', '研究'], ['start_research', '开始 qlib 研究', '研究'], ['research_status', '查看研究进度', '研究'], ['read_research', '读取研究报告', '研究'],
  ['resume_research', '继续研究', '研究'], ['stop_research', '停止研究', '研究'], ['export_signals', '导出信号到 LEAN', '研究'], ['build_breadth', '计算市场宽度', '研究'], ['test_timing_signal', '择时信号检验', '研究'], ['list_signals', '查看信号', '研究'],
  ['list_paper_sessions', '列出模拟实盘', '模拟实盘'], ['read_paper_session', '读取模拟实盘', '模拟实盘'],
].map(([id, label, group]) => ({ id, label, group }));
const QC_IDS = new Set(QC_TOOLS.map((t) => t.id));

export const BASE_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill'];

// 改文件 / 跑命令：不是全开也不是全关，每次都经过 lib/change-policy.mjs 的规则
export function localTools(agent) {
  if (agent.orchestrator) {
    const why = '调度者不自己改代码或跑命令，交给策略工程师';
    return [{ id: 'Edit', label: '改文件', state: 'denied', why }, { id: 'Bash', label: '跑命令', state: 'denied', why }];
  }
  return [
    { id: 'Edit', label: '改文件', state: 'limited', why: '研究引擎 engine/qlib_research/、新建测试和技能直接改（只在沙盒里运行；先存原文、改完跑测试，没过自动恢复）；lib/ mcp/ 等平台代码、改已有测试、删除、服务和网页、权限、研究规则要你批准' },
    { id: 'Bash', label: '跑命令', state: 'limited', why: '测试和只读命令直接跑；删除、安装和其它命令要你批准' },
  ];
}
export const DANGEROUS = ['delete_file', 'delete_backtest'];

// 一个 agent 实际拿到的 qc 工具：全部 − deniedTools −（没开「允许删除」时）危险工具
export function effectiveTools(agent, { allowDanger = false } = {}) {
  const denied = new Set(Array.isArray(agent.deniedTools) ? agent.deniedTools : []);
  return QC_TOOLS.map((t) => {
    let state = 'allowed'; let why = '';
    if (denied.has(t.id)) { state = 'denied'; why = '这个 agent 的配置里禁用了'; } else if (!allowDanger && DANGEROUS.includes(t.id)) { state = 'ask'; why = '只有打开「允许删除」的那条消息能用'; } else if (t.id === 'write_file' && Array.isArray(agent.writeOnly) && agent.writeOnly.length) { state = 'limited'; why = `只能写 ${agent.writeOnly.join('、')}`; }
    return { ...t, state, why };
  });
}

// 网页可以改的字段；其余（id、glyph、color、权限）只能改 agents.json 文件本身
export const EDITABLE = ['name', 'role', 'prompt', 'model', 'effort', 'starters'];
const LIMITS = { name: 20, role: 120, prompt: 20000 };

export function validateAgentPatch(patch, { models = [], efforts = [] } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: '请求格式不对' };
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.includes(k)) return { error: `不能修改 ${k}` };
    if (k === 'starters') {
      if (!Array.isArray(v) || v.length > 6 || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)) return { error: '示例任务最多 6 条，每条 1–200 字' };
      out.starters = v.map((x) => x.trim());
      continue;
    }
    if (k === 'model' || k === 'effort') {
      if (v === null || v === '') { out[k] = null; continue; }
      const ok = (k === 'model' ? models : efforts).some((m) => m.id === v);
      if (!ok) return { error: `${k === 'model' ? '模型' : '思考深度'} ${v} 不在可选列表里` };
      out[k] = v;
      continue;
    }
    if (typeof v !== 'string') return { error: `${k} 必须是文字` };
    const t = k === 'prompt' ? v.replace(/\r\n/g, '\n').trim() : v.replace(/\s+/g, ' ').trim();
    if (!t) return { error: `${k === 'prompt' ? '系统提示词' : k === 'name' ? '名字' : '定位'}不能为空` };
    if (t.length > LIMITS[k]) return { error: `${k} 太长（最多 ${LIMITS[k]} 字）` };
    out[k] = t;
  }
  if (!Object.keys(out).length) return { error: '没有要修改的内容' };
  return { patch: out };
}

// 原地改内存里的 AGENTS（server、handoff 都引用同一个数组），再原子写回 agents.json；
// 写之前把旧文件备份到 data/agents-backups/，网页上改坏了可以找回
export async function saveAgentPatch(agents, id, patch, { file, backupDir }) {
  const a = agents.find((x) => x.id === id);
  if (!a) return { error: `没有 id 为 ${id} 的 agent` };
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(file, path.join(backupDir, `agents-${stamp}.json`)).catch(() => {});
  const next = agents.map((x) => (x.id === id ? applyPatch(x, patch) : x));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, file);
  Object.assign(a, applyPatch(a, patch));
  for (const k of ['model', 'effort']) if (a[k] == null) delete a[k];
  return { agent: a, backup: `agents-${stamp}.json` };
}
function applyPatch(a, patch) {
  const n = { ...a, ...patch };
  for (const k of ['model', 'effort']) if (n[k] == null) delete n[k];
  return n;
}

export async function readAgentsFile(file) { return JSON.parse(await readFile(file, 'utf8')); }
export const isQcTool = (id) => QC_IDS.has(id);
