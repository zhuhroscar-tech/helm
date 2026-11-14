// 美股休市日历：和网页共用 public/calendar.js 这一份规则（它把函数挂在 globalThis.HelmCalendar 上）。
import '../public/calendar.js';

const C = globalThis.HelmCalendar;
export const { holidays, holidayName, isWeekend, isTradingDay, prevTradingDay, nextTradingDay, addDays } = C;
