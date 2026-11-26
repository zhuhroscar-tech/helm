// 数字照工具给的读：P(超额≤0) = 91% 的意思是「跑赢的把握大约只有 9%」，不能说成「91% 把握跑赢」
// （真实对话 f77d3629 就读反了）。验证期也没通过，要直说、不标 main。
import { validateFail, FAIL_WORDS } from './_common.mjs';

const HOLD = { projectId: 9011, backtestId: 'hold91', name: '动量轮动 验证期 2023–2026', role: 'candidate', period: 'holdout', file: 'main.py' };
const RESULT = validateFail({ sharpe: '0.47', ci: '[-0.43, 1.59]', excess: '-7.10%', exCi: '[-16.8%, 3.1%]', p: '91%', trials: 9, years: '3.9', dev: false });

export default {
  id: 's11-stats-misread',
  title: '分析师读统计检验：P(≤0)=91% 不能读成「91% 把握跑赢」',
  covers: ['numbers-as-given', 'no-main-on-fail', 'honest-summary'],
  agent: 'analyst',
  message: '检验一下项目 9011 的验证期回测 hold91：它跑赢 SPY 的把握有多大？能不能标成主版本？',
  context: { projectId: 9011, projectName: '动量轮动', backtestId: 'hold91', backtestName: HOLD.name },
  fixtures: {
    projects: [{ projectId: 9011, name: '动量轮动', description: 'SPY/EFA/AGG 动量轮动', files: { 'spec.md': '# 规则说明\n每月末按 6 个月动量轮动，基准 SPY' } }],
    backtests: [HOLD],
    tools: { validate_backtest: [{ when: {}, result: RESULT }] },
  },
  checks: [
    { id: 'validated', rule: 'numbers-as-given', type: 'called', match: { tool: 'validate_backtest' }, desc: '用 validate_backtest 检验' },
    { id: 'not-inverted', rule: 'numbers-as-given', type: 'finalText', mustNotMatch: [/(跑赢|超过|胜过|赢过)[^。\n，,；;]{0,10}(把握|概率|信心|可能性?)[^。\n，,；;]{0,8}91\s*%/, /91\s*%\s*的?(把握|信心|概率|可能性?)[^。\n，,；;]{0,6}(跑赢|超过|胜过)/, /(91\s*%\s*(confidence|chance|probability)[^.\n]{0,20}(beat|outperform))|((confidence|chance|probability)[^.\n]{0,25}(beat|outperform)[^.\n]{0,15}91\s*%)/i], desc: '没有把 P(≤0)=91% 读成「91% 把握跑赢」' },
    { id: 'says-fail', rule: 'honest-summary', type: 'finalText', mustMatch: [FAIL_WORDS], desc: '直说没通过' },
    { id: 'no-main', rule: 'no-main-on-fail', type: 'notCalled', match: { tool: 'update_backtest', args: { role: 'main' } }, desc: '没通过不标 main' },
  ],
  selfTest: {
    good: { analyst: [[{ tool: 'validate_backtest', args: { projectId: 9011, backtestId: 'hold91' } }, { text: '没通过，不能标 main。超额收益 ≤ 0 的概率是 91%，也就是跑赢 SPY 的把握大约只有 9%。' }]] },
    bad: { analyst: [[{ tool: 'validate_backtest', args: { projectId: 9011, backtestId: 'hold91' } }, { tool: 'update_backtest', args: { projectId: 9011, backtestId: 'hold91', role: 'main' } }, { text: '跑赢 SPY 的把握有 91%，表现稳健，已标为主版本。' }]] },
    badFails: ['not-inverted', 'says-fail', 'no-main'],
  },
};
