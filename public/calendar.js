// 美股（NYSE）休市日历：纯函数，网页（经典脚本，挂在 globalThis.HelmCalendar）和服务端（lib/market-calendar.mjs）共用这一份。
// 只按规则推算固定假日，加上已知的临时休市日；以后新增的临时休市这里不知道，那天会像以前一样按“数据没更新”处理。
// 半日市（感恩节次日、平安夜等）照常算交易日：当天有收盘数据。
(function (g) {
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  var iso = function (y, m, d) { return y + '-' + pad(m) + '-' + pad(d); };
  var dow = function (y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }; // 0 = 周日
  var addDays = function (s, n) { var t = new Date(s + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  // 某月第 n 个星期 w
  var nth = function (y, m, w, n) { var first = dow(y, m, 1); return iso(y, m, 1 + ((w - first + 7) % 7) + (n - 1) * 7); };
  // 某月最后一个星期 w
  var last = function (y, m, w) { var days = new Date(Date.UTC(y, m, 0)).getUTCDate(); var l = dow(y, m, days); return iso(y, m, days - ((l - w + 7) % 7)); };
  // 固定日期的假日：周六提前到周五，周日顺延到周一。元旦落在周六时不补休（NYSE 规则 7.2）
  var observed = function (y, m, d, satToFri) {
    var w = dow(y, m, d);
    if (w === 6) return satToFri ? addDays(iso(y, m, d), -1) : null;
    if (w === 0) return addDays(iso(y, m, d), 1);
    return iso(y, m, d);
  };
  // 复活节（公历，匿名算法）
  var easter = function (y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    var f = Math.floor((b + 8) / 25), gg = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - gg + 15) % 30;
    var i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return iso(y, month, day);
  };
  // 临时休市（国葬等），规则推不出来，只能列出来
  // 1994 年以后（Yahoo 日线和 SPY 都从 1993 年起）的全部临时休市
  var SPECIAL = {
    '1994-04-27': '国家哀悼日（尼克松）',
    '2001-09-11': '9·11 事件', '2001-09-12': '9·11 事件', '2001-09-13': '9·11 事件', '2001-09-14': '9·11 事件',
    '2004-06-11': '国家哀悼日（里根）', '2007-01-02': '国家哀悼日（福特）',
    '2012-10-29': '飓风桑迪', '2012-10-30': '飓风桑迪',
    '2018-12-05': '国家哀悼日（老布什）', '2025-01-09': '国家哀悼日（卡特）',
  };
  var cache = {};
  function holidays(y) {
    if (cache[y]) return cache[y];
    var h = {};
    var put = function (d, name) { if (d) h[d] = name; };
    put(observed(y, 1, 1, false), '元旦');
    if (y >= 1998) put(nth(y, 1, 1, 3), '马丁·路德·金日'); // NYSE 从 1998 年起才休这一天
    put(nth(y, 2, 1, 3), '总统日');
    put(addDays(easter(y), -2), '耶稣受难日');
    put(last(y, 5, 1), '阵亡将士纪念日');
    if (y >= 2022) put(observed(y, 6, 19, true), '六月节');
    put(observed(y, 7, 4, true), '独立日');
    put(nth(y, 9, 1, 1), '劳动节');
    put(nth(y, 11, 4, 4), '感恩节');
    put(observed(y, 12, 25, true), '圣诞节');
    for (var k in SPECIAL) if (k.slice(0, 4) === String(y)) h[k] = SPECIAL[k];
    cache[y] = h;
    return h;
  }
  // 休市原因（默认中文，第二个参数传 'en' 得到英文）；不是休市日返回 null。周末不算“假日”，用 isTradingDay 判断
  // 英文界面用的休市原因：键是上面的中文名（中文仍是源）。holidayName(s, 'en') 返回英文，其余返回中文
  var EN = {
    '元旦': "New Year's Day", '马丁·路德·金日': 'Martin Luther King Jr. Day', '总统日': "Presidents' Day", '耶稣受难日': 'Good Friday',
    '阵亡将士纪念日': 'Memorial Day', '六月节': 'Juneteenth', '独立日': 'Independence Day', '劳动节': 'Labor Day', '感恩节': 'Thanksgiving', '圣诞节': 'Christmas Day',
    '国家哀悼日（尼克松）': 'National Day of Mourning (Nixon)', '国家哀悼日（里根）': 'National Day of Mourning (Reagan)', '国家哀悼日（福特）': 'National Day of Mourning (Ford)',
    '国家哀悼日（老布什）': 'National Day of Mourning (George H. W. Bush)', '国家哀悼日（卡特）': 'National Day of Mourning (Carter)', '9·11 事件': 'September 11 attacks', '飓风桑迪': 'Hurricane Sandy',
  };
  function holidayName(s, lang) { var n = holidays(Number(String(s).slice(0, 4)))[s] || null; return n && lang === 'en' ? (EN[n] || n) : n; }
  function isWeekend(s) { var w = new Date(s + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; }
  function isTradingDay(s) { return !isWeekend(s) && !holidayName(s); }
  function prevTradingDay(s) { var d = addDays(s, -1); while (!isTradingDay(d)) d = addDays(d, -1); return d; }
  function nextTradingDay(s) { var d = addDays(s, 1); while (!isTradingDay(d)) d = addDays(d, 1); return d; }
  g.HelmCalendar = { holidays: holidays, holidayName: holidayName, isWeekend: isWeekend, isTradingDay: isTradingDay, prevTradingDay: prevTradingDay, nextTradingDay: nextTradingDay, addDays: addDays };
})(typeof globalThis !== 'undefined' ? globalThis : window);
