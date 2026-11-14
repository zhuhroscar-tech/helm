// 美股休市日历：和 NYSE 公布的休市日逐年核对（2019–2027），再查几条边界规则。
import { holidays, holidayName, isTradingDay, prevTradingDay, nextTradingDay } from '../lib/market-calendar.mjs';

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed++; };

// NYSE 公布的全天休市日
const NYSE = {
  2019: ['01-01', '01-21', '02-18', '04-19', '05-27', '07-04', '09-02', '11-28', '12-25'],
  2020: ['01-01', '01-20', '02-17', '04-10', '05-25', '07-03', '09-07', '11-26', '12-25'],
  2021: ['01-01', '01-18', '02-15', '04-02', '05-31', '07-05', '09-06', '11-25', '12-24'],
  2022: ['01-17', '02-21', '04-15', '05-30', '06-20', '07-04', '09-05', '11-24', '12-26'],
  2023: ['01-02', '01-16', '02-20', '04-07', '05-29', '06-19', '07-04', '09-04', '11-23', '12-25'],
  2024: ['01-01', '01-15', '02-19', '03-29', '05-27', '06-19', '07-04', '09-02', '11-28', '12-25'],
  2025: ['01-01', '01-09', '01-20', '02-17', '04-18', '05-26', '06-19', '07-04', '09-01', '11-27', '12-25'],
  2026: ['01-01', '01-19', '02-16', '04-03', '05-25', '06-19', '07-03', '09-07', '11-26', '12-25'],
  2027: ['01-01', '01-18', '02-15', '03-26', '05-31', '06-18', '07-05', '09-06', '11-25', '12-24'],
};
for (const [y, list] of Object.entries(NYSE)) {
  const got = Object.keys(holidays(Number(y))).map((d) => d.slice(5)).sort();
  check(`${y} 年休市日和 NYSE 公布的一致`, JSON.stringify(got) === JSON.stringify(list.slice().sort()), got.join(' '));
}
check('元旦落在周六（2022）：周五 12-31 照常开市，不补休', isTradingDay('2021-12-31') && !holidayName('2022-01-01') && isTradingDay('2022-01-03'));
check('周末不是交易日，也不算假日', !isTradingDay('2026-11-07') && holidayName('2026-11-07') === null);
check('感恩节次日（半日市）算交易日', isTradingDay('2026-11-27'));
check('上一个交易日跨过假日和周末', prevTradingDay('2026-11-27') === '2026-11-25' && prevTradingDay('2026-07-06') === '2026-07-02', `${prevTradingDay('2026-11-27')} ${prevTradingDay('2026-07-06')}`);
check('下一个交易日跨过假日和周末', nextTradingDay('2026-11-25') === '2026-11-27' && nextTradingDay('2026-12-24') === '2026-12-28', `${nextTradingDay('2026-11-25')} ${nextTradingDay('2026-12-24')}`);
check('休市原因是中文', holidayName('2026-11-26') === '感恩节' && holidayName('2026-04-03') === '耶稣受难日');


// 网页里的「下次运行」估计（public/app.js）和服务端（lib/paper.mjs）用的是同一份日历：把那段代码原样取出来跑，逐小时对一遍
{
  const vm = await import('node:vm');
  const { readFile } = await import('node:fs/promises');
  const PP = await import('../lib/paper.mjs');
  // 界面文字走 i18n：装入真正的 i18n 脚本，语言固定中文
  const gi = { navigator: { language: 'zh-CN' }, localStorage: { getItem: () => 'zh', setItem() {}, removeItem() {} } };
  gi.window = gi; gi.globalThis = gi; vm.createContext(gi);
  for (const f of ['i18n-dict.js', 'i18n.js']) vm.runInContext(await readFile(new URL(`../public/${f}`, import.meta.url), 'utf8'), gi);
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const a = src.indexOf('const ET_FMT = '); const b = src.indexOf('const localWhen = ');
  check('app.js 里能找到「下次运行」那段代码', a > 0 && b > a);
  const ctx = vm.createContext({ HELM_I18N: gi.HELM_I18N, _t: gi._t, _regT: gi._regT, window: { HelmCalendar: globalThis.HelmCalendar }, Intl, Date, Object, Number, Math });
  vm.runInContext(`${src.slice(a, b)}\nthis.api = { expectedDataDateET, paperNextRun };`, ctx);
  const { expectedDataDateET, paperNextRun } = ctx.api;
  let diff = null; let n = 0;
  for (let t = Date.parse('2026-06-01T00:07:00Z'); t < Date.parse('2027-02-01T00:00:00Z'); t += 3600e3) {
    const d = new Date(t); n++;
    if (expectedDataDateET(d) !== PP.expectedTradingDate(d)) { diff = `${d.toISOString()} 网页 ${expectedDataDateET(d)} 服务端 ${PP.expectedTradingDate(d)}`; break; }
  }
  check('网页和服务端的「应有数据日」逐小时一致（2026-06 至 2027-01）', diff === null, diff || `${n} 个时刻`);
  // 周三 11-25 收盘后跑完：下次是周五 11-27（感恩节顺延），不是周四
  const done = { status: 'active', lastRun: { ok: true, dataDate: '2026-11-25', at: '2026-11-25T22:30:00Z' }, lastAttemptAt: '2026-11-25T22:20:00Z' };
  const nx = paperNextRun(done, new Date('2026-11-26T02:00:00Z'));
  check('感恩节前一天跑完：下次运行是 11-27 美东 17:15，并说明感恩节休市', nx.kind === 'sched' && nx.at.toISOString() === '2026-11-27T22:15:00.000Z' && nx.closed && nx.closed.date === '2026-11-26' && nx.closed.name === '感恩节', JSON.stringify(nx));
  const hol = paperNextRun(done, new Date('2026-11-26T23:30:00Z'));
  check('感恩节当天收盘后：不算“还没跑”，仍等 11-27', hol.kind === 'sched' && hol.at.toISOString() === '2026-11-27T22:15:00.000Z', JSON.stringify(hol));
  const plain = paperNextRun({ status: 'active', lastRun: { ok: true, dataDate: '2026-11-09', at: '2026-11-09T22:30:00Z' } }, new Date('2026-11-10T02:00:00Z'));
  check('普通交易日：下次是第二天 17:15，没有休市说明', plain.kind === 'sched' && plain.at.toISOString() === '2026-11-10T22:15:00.000Z' && !plain.closed, JSON.stringify(plain));
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
