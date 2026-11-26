// 几个工作台共用的硬规则。每条规则：(ctx) => 拒绝的原因 | null，ctx = { h, state, tool, args, pid }
const isSpec = (name) => /^spec\.(md|py)$/i.test(String(name || ''));

/** 标 main 之前，这次运行里必须对同一个回测跑过 validate_backtest 并且通过（引擎也会再查一次，这里拦得更早、说得更清楚） */
export const mainNeedsValidation = ({ state, tool, args }) => {
  if (tool !== 'update_backtest' || args.role !== 'main') return null;
  const v = state.validations[args.backtestId];
  if (v === true) return null;
  return v === false
    ? `回测 ${args.backtestId} 的 validate_backtest 没通过，不能标 main。照实汇报没通过，不要改标签。`
    : `标 main 之前先对回测 ${args.backtestId} 调用 validate_backtest，通过了才能标。`;
};

/** 写策略代码之前必须读过（或自己写过）这个项目的规则说明 */
export const specFirst = ({ state, tool, args, pid }) => {
  if (tool === 'create_project' && args.code) return '先不带 code 建项目，把规则说明存成 spec.md，再用 write_file 写代码。';
  if (tool !== 'write_file' || pid == null || isSpec(args.name)) return null;
  return state.specSeen[pid] ? null : `写 ${args.name} 之前先 read_project(projectId=${pid}) 读规则说明 spec.md，严格照着写；项目里没有 spec.md 就先写一份存进去。`;
};

// 回测的起止日期那两行：验证期回测只能靠改它们来换时间段（create_backtest 没有日期参数）
const DATE_LINE = /^\s*self\.(set_start_date|set_end_date|SetStartDate|SetEndDate)\s*\(.*\)\s*(#.*)?$/;
const stripDates = (code) => String(code || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => !DATE_LINE.test(l)).map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
/**
 * 这次写入是不是「只改了回测起止日期」：新内容去掉日期行之后，和项目里某个已有的 .py 文件（同名文件，或被照抄的那个）
 * 去掉日期行之后一模一样，而且确实还留着日期行。这样的写入不算改策略——跑验证期必须这么改。
 * existing: 项目里已有的 .py 文件内容（数组）。
 */
export function datesOnlyChange(newCode, existing = []) {
  const n = stripDates(newCode);
  if (!n.trim() || !String(newCode || '').split('\n').some((l) => DATE_LINE.test(l))) return false;
  return existing.some((old) => stripDates(old) === n);
}

/** 验证期回测：只能跑代码没动过的版本（这次运行里刚改过这个项目的代码，就先在开发期跑过再说） */
export const holdoutNeedsDevRun = ({ state, tool, args, pid }) => {
  if (tool !== 'create_backtest' || !['holdout', 'full'].includes(args.period) || pid == null) return null;
  const wrote = (state.wrote[pid] || []).length > 0;
  const devAfter = state.backtests.some((b) => b.pid === pid && b.period === 'dev');
  // 只改回测起止日期的写入不记在 wrote 里（见 datesOnlyChange）：把开发期通过的代码原样换成验证期的日期，正是跑验证期的做法
  return wrote && !devAfter ? '这次运行里你改过这个项目的策略代码（不只是 set_start_date / set_end_date 两行），还没有在开发期跑过：验证期只用来验证已经在开发期通过检验的版本。要跑验证期，把开发期通过的代码原样保留、只改起止日期；改了别的就先跑开发期。' : null;
};
