// 每个 agent 一份工作台（harness）。server.mjs 启动 agent、每次工具调用前后、运行结束时都按这里的定义来。
// 设计见 docs/HARNESS.md。
import { READ_ONLY } from './core.mjs';
import mia from './mia.mjs';
import engineer from './engineer.mjs';
import researcher from './researcher.mjs';
import analyst from './analyst.mjs';
import risk from './risk.mjs';

export * from './core.mjs';
export { datesOnlyChange } from './rules.mjs';
export * as Directions from './directions.mjs';

export const HARNESSES = { mia, engineer, researcher, analyst, risk };

// agents.json 里用户自己加的 agent：没有专门的工作台，用通用的（不额外禁工具、不能派子 agent、不能定研究方向）
const generic = (agent) => ({
  id: agent.id, title: agent.name || agent.id, mission: agent.role || '完成交给你的任务。',
  deny: [], loop: {}, subagents: null, direction: agent.orchestrator ? 'decide' : 'suggest', rules: [], ruleNotes: [], deliver: [], contract: () => [],
});

export function harnessFor(agent) {
  const a = typeof agent === 'string' ? { id: agent } : agent || {};
  const h = HARNESSES[a.id];
  return h ? { ...h, title: a.name || h.title } : generic(a);
}

const SCOUT_LOOP = { maxToolCalls: 40, maxMinutes: 15, maxContinuations: 1, perTool: {} };
/** 这次运行实际用的工作台：子 agent（thread.sub）在自己那份上再收紧 */
export function resolve(agent, thread = {}) {
  const base = harnessFor(agent);
  const sub = thread && thread.sub;
  if (!sub) return base;
  if (sub.mode === 'scout') {
    return { ...base, sub: 'scout', deny: [], allowOnly: READ_ONLY, writeExt: null, loop: SCOUT_LOOP, subagents: null, direction: 'read', rules: [], ruleNotes: [], capNotes: {},
      deliver: ['给出结论和依据'], contract: ({ text }) => (String(text).trim() ? [] : ['没有给出结论：回答交给你的那个问题，写明依据']) };
  }
  return { ...base, sub: 'worker', subagents: null };
}

/** 给 Agents 页和 /api/harness 看的说明（不含函数） */
export function describe(agent) {
  const h = harnessFor(agent);
  return { id: h.id, title: h.title, mission: h.mission, deny: h.deny || [], writeExt: h.writeExt || null, loop: { ...DEFAULT_LOOP_VIEW, ...(h.loop || {}) },
    subagents: h.subagents || null, direction: h.direction || 'read', rules: h.ruleNotes || [], deliver: h.deliver || [] };
}
const DEFAULT_LOOP_VIEW = { maxToolCalls: 120, hardFactor: 3, maxMinutes: 120, maxContinuations: 2, repeatErrors: 3, repeatSame: 5 };
