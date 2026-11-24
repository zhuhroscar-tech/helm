// 快速探针共用的东西：从一轮自动研究的中途开始（scenario.seed 写进运行记录，scenario.note 接在开工说明后面），
// 只看 agent 在关键那一步怎么做，看到了就停（scenario.stopWhen），不等整轮走完。一个探针通常一两分钟。

export const TIMING_PLAN = [
  { title: 'SPY/TLT 3 个月动量轮动', logic: '股债之间的趋势会延续', kind: 'timing', failIf: '开发期没通过检验' },
  { title: 'QQQ 200 日均线择时', logic: '跌破长期均线时回避大跌', kind: 'timing', failIf: '开发期没通过检验' },
];
export const STOCK_PLAN = [
  { title: '低波动 50 只', logic: '低风险异象：杠杆受限的投资者高估高波动股', kind: 'stock', failIf: '想法检验没有信号' },
  { title: '12-1 动量 30 只', logic: '投资者对信息反应不足', kind: 'stock', failIf: '想法检验没有信号' },
];
export const project = (projectId, name, kind = 'timing') => ({
  projectId, name, description: `自动研究：${name}`,
  files: {
    'spec.md': `# 规则说明\n${name}。${kind === 'timing' ? '每月最后一个交易日收盘判断，下一个交易日开盘成交，全仓 98%。' : '标普 500 历史成分股，每月末调仓，等权，成本 10bp。'}开发期 2008–2022，验证期 2023 至今。`,
    'main.py': 'from AlgorithmImports import *\n\nclass Strategy(QCAlgorithm):\n    def initialize(self):\n        self.set_start_date(2008, 1, 1)\n        self.set_end_date(2022, 12, 31)\n',
  },
});
export const bt = (projectId, backtestId, period = 'dev', role = 'candidate') => ({ projectId, backtestId, name: `${period === 'dev' ? '开发期' : '验证期'} ${backtestId}`, role, period, file: 'main.py' });

// stopWhen 的常用写法
export const childStarted = (live) => live.some((x) => x.kind === 'child');
export const rootCalled = (...tools) => (live) => live.some((x) => x.kind === 'tool' && x.root && tools.includes(x.tool) && !x.isError);
export const any = (...fs) => (live) => fs.some((f) => f(live));
