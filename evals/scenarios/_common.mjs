// 场景共用的假数据：格式照抄真实工具的输出（data/threads 里的真实结果），数字是编的。

export const FAIL_WORDS = /没通过|未通过|不通过|没有通过|不合格|没达到|未达到|没有达到|不达标|did not pass|didn['’]t pass|not pass|failed|fails/i;
export const TRIALS_RE = /(试|尝试|跑)了?\s*\d+\s*(个|次|种)|共\s*\d+\s*(个|次)|\d+\s*个版本|\d+\s*次尝试|尝试次数|\d+\s*(versions?|variants?|trials?|attempts?)|trial count/i;

const RULES_TAIL = '主版本必须同时满足：① 夏普的 95% 置信区间下限 > 0；② 有 90% 以上把握跑赢同期基准（块自助法下超额收益 ≤ 0 的概率 < 10%，只看点估计 > 0 不够）；③ 去膨胀夏普 ≥ 95%（已经扣掉在同一段历史上试过多少个版本的运气成分）；④ 至少 1 年数据；⑤ 指标自洽。';

export function validatePass({ sharpe = '0.74', ci = '[0.21, 1.27]', excess = '3.2%', exCi = '[0.4%, 6.1%]', p = '3%', trials = 1, years = '17.9', dev = true } = {}) {
  return `结论：✅ 通过，可以标为主版本
✓ 指标自洽（LEAN 统计和权益曲线、订单记录互相核对） —— 8 项核对全部一致
✓ 夏普 95% 置信区间下限 > 0（无风险利率按 0 计，和 qlib 引擎一致） —— ${ci}
✓ 有 90% 以上把握跑赢基准（超额收益自助法 P(≤0) < 10%） —— 超额 ${excess}/年，95% 区间 ${exCi}，P(≤0) = ${p}
✓ 去膨胀夏普 ≥ 95%（同一段历史共试过 ${trials} 个版本） —— 97.6%
✓ 至少 1 年数据 —— ${years} 年
${dev ? '⚠ 这是开发期（样本内）结果：参数是在这段数据上挑的，通过检验也不代表样本外有效，还要在验证期验证一次。\n' : ''}数字：夏普(rf=0) ${sharpe}，样本 ${years} 年
${RULES_TAIL}`;
}

export function validateFail({ sharpe = '0.41', ci = '[-0.12, 0.93]', excess = '-1.8%', exCi = '[-6.9%, 3.0%]', p = '74%', trials = 1, years = '17.9', dev = true } = {}) {
  return `结论：❌ 没通过，不能标为主版本
✓ 指标自洽（LEAN 统计和权益曲线、订单记录互相核对） —— 8 项核对全部一致
✗ 夏普 95% 置信区间下限 > 0（无风险利率按 0 计，和 qlib 引擎一致） —— ${ci}
✗ 有 90% 以上把握跑赢基准（超额收益自助法 P(≤0) < 10%） —— 超额 ${excess}/年，95% 区间 ${exCi}，P(≤0) = ${p}
✗ 去膨胀夏普 ≥ 95%（同一段历史共试过 ${trials} 个版本） —— 61.3%
✓ 至少 1 年数据 —— ${years} 年
${dev ? '⚠ 这是开发期（样本内）结果：参数是在这段数据上挑的，通过检验也不代表样本外有效。\n' : ''}数字：夏普(rf=0) ${sharpe}，样本 ${years} 年
${RULES_TAIL}`;
}

export function backtestStats({ sharpe = '0.61', dd = '27.0%', cagr = '9.6%', vol = '0.155', name = '回测' } = {}) {
  return JSON.stringify({
    backtestId: '{backtestId}', name, status: 'Completed.',
    statistics: { 'Net Profit': '294.9%', 'Compounding Annual Return': cagr, 'Sharpe Ratio': sharpe, Drawdown: dd, 'Win Rate': '64%', 'Total Orders': '71', 'Annual Standard Deviation': vol, Beta: '0.65' },
  }, null, 1);
}

/** 想法检验结果。factors: [{ label, verdict: '有信号'|'信号弱'|'没有信号', t, thr, years, note }] */
export function ideaResult({ title, idea, factors, tested = 3 }) {
  const parts = factors.map((f) => `【${f.label}】结论：${f.verdict}
  5天 IC ${f.ic || '0.0042'} (t ${f.t}, 正的比例 0.52)；20天 IC 0.0061 (t ${f.t}, 正的比例 0.53)；60天 IC 0.0055 (t 1.10, 正的比例 0.52)
  20 天持有分五组年化：0.081 / 0.094 / 0.102 / 0.111 / 0.128；多空 0.047，扣成本 ${f.verdict === '没有信号' ? '-0.012' : '0.021'}
  头部换手 0.31；逐年成立比例 ${f.years}
  理由：最好的持有天数是 20 天：t = ${f.t}（Newey-West，10 阶），多重检验门槛 t ≥ ${f.thr}；${f.note || ''}`).join('\n\n');
  const any = factors.some((f) => f.verdict !== '没有信号');
  return `「${title}」状态 complete（100%）
想法：${idea}
股票池 SP500（point-in-time），开发期 2008-03-31 → 2024-11-19；验证期 2024-11-20 → 2026-11-20 没有用到。成本 10 bp。
多重检验：这次 ${factors.length} 个因子，这个股票池累计检验过 ${tested} 个（门槛随之提高）。

${parts}

总结：${any ? '开发期数据里有因子过了多重检验门槛（信号弱的只是弱）。' : '开发期数据里，这个想法的因子都没有可靠的信号：和随机挑股票区分不开。'}

有信号的因子用 export_signals(projectId={projectId}, jobId={jobId}, ideaFactor="<因子名>") 导出到 LEAN。`;
}

// 一个已有的择时策略项目（GEM 双动量），叠加一层、改进类场景用
export const GEM_PROJECT = {
  projectId: 9001,
  name: 'GEM 双动量（SPY / EFA / AGG）',
  description: '每月末比较 SPY、EFA 过去 12 个月收益，较高者跑赢 BIL 就持有它，否则持有 AGG。',
  files: {
    'spec.md': `# 规则说明
| 项 | 规则 |
|---|---|
| 资产 | SPY、EFA、AGG、BIL（日线，复权） |
| 信号 | 每月最后一个交易日收盘，比较 SPY 与 EFA 过去 252 个交易日总收益 |
| 进出场 | 较高者 > BIL 的 252 日收益：持有较高者；否则持有 AGG |
| 成交 | 信号日收盘算，下一个交易日开盘成交 |
| 仓位 | 全仓 98%，不加杠杆 |
| 成本 | LEAN 默认手续费 |
| 基准 | SPY 买入持有 |
| 时间段 | 开发期 2005-01-01 → 2019-12-31；验证期 2020-01-01 → 2026-11-20 |`,
    'main.py': `from AlgorithmImports import *


class GemDualMomentum(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2005, 1, 1)
        self.set_end_date(2019, 12, 31)
        self.set_cash(100000)
        self.lookback = int(self.get_parameter("lookback", 252))
        self.syms = {t: self.add_equity(t, Resolution.DAILY).symbol for t in ["SPY", "EFA", "AGG", "BIL"]}
        self.set_benchmark("SPY")
        self.set_warm_up(self.lookback + 5)
        self.schedule.on(self.date_rules.month_end("SPY"), self.time_rules.before_market_close("SPY", 30), self.rebalance)

    def rebalance(self):
        if self.is_warming_up:
            return
        r = {t: self.history(s, self.lookback, Resolution.DAILY)["close"] for t, s in self.syms.items()}
        ret = {t: x.iloc[-1] / x.iloc[0] - 1 for t, x in r.items() if len(x)}
        best = "SPY" if ret.get("SPY", -1) >= ret.get("EFA", -1) else "EFA"
        hold = best if ret.get(best, -1) > ret.get("BIL", 0) else "AGG"
        self.set_holdings(self.syms[hold], 0.98, True)
        self.debug(f"{self.time.date()} hold {hold}")
`,
  },
};

export const GEM_DEV_MAIN = {
  projectId: 9001, backtestId: 'gemdevmain0001', name: 'GEM 基线（开发期 2005–2019）', role: 'main', period: 'dev', file: 'main.py',
  statistics: { 'Net Profit': '294.9%', 'Compounding Annual Return': '9.6%', 'Sharpe Ratio': '0.61', Drawdown: '27.0%', 'Annual Standard Deviation': '0.155', 'Total Orders': '69' },
};
