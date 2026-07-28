/*
 * tide.js - 潮汐ユーティリティ
 *
 * data/tide-<year>.js が定義した window.TIDE_DATA（気象庁 潮位表の実データ）を読み、
 * 釣行判断に使う形に整える。
 *
 * 注意: 潮回り（大潮・中潮…）は旧暦日にひもづく「暦」の分類でしかない。
 * 日本海側の直江津は潮差が 30cm 前後しかなく、大潮でも東京湾のようには動かない。
 * そのため UI では必ず実測ベースの潮差(cm)を併記すること。
 */
(function (global) {
  'use strict';

  var FF = (global.FF = global.FF || {});

  // 潮汐地点の表示名（生成データ側は data のみを持ち、表示名はここで与える）
  var STATION_NAMES = {
    T3: '直江津',
    TK: '東京',
    QS: '横浜'
  };

  // 旧暦日 -> 潮回り。日本で一般に使われている対応表。
  var TIDE_PHASE_BY_LUNAR_DAY = [
    null, // index 0 は未使用（旧暦日は 1 始まり）
    '大潮', '大潮', '大潮', '中潮', '中潮', '中潮', '小潮', '小潮', '小潮', '長潮',
    '若潮', '中潮', '中潮', '大潮', '大潮', '大潮', '大潮', '中潮', '中潮', '中潮',
    '中潮', '小潮', '小潮', '小潮', '長潮', '若潮', '中潮', '中潮', '大潮', '大潮'
  ];

  var SYNODIC_MONTH = 29.530588853;
  // 基準新月: 2000-01-06 18:14 UTC
  var NEW_MOON_REF_MS = Date.UTC(2000, 0, 6, 18, 14, 0);

  /**
   * 月齢を返す（0〜29.53）。誤差はおよそ±0.5日で、潮回りの表示には十分。
   * @param {Date} date 判定したい日（日本時間の正午で評価する）
   */
  function moonAge(date) {
    var noonJst = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12 - 9, 0, 0);
    var age = ((noonJst - NEW_MOON_REF_MS) / 86400000) % SYNODIC_MONTH;
    if (age < 0) age += SYNODIC_MONTH;
    return age;
  }

  /** 潮回り名（大潮/中潮/小潮/長潮/若潮）を返す。 */
  function tidePhase(date) {
    var lunarDay = Math.floor(moonAge(date)) + 1; // 1〜30
    if (lunarDay > 30) lunarDay = 30;
    return TIDE_PHASE_BY_LUNAR_DAY[lunarDay] || '中潮';
  }

  /** 'YYYY-MM-DD' 形式のローカル日付キー。 */
  function dateKey(date) {
    return (
      date.getFullYear() +
      '-' + String(date.getMonth() + 1).padStart(2, '0') +
      '-' + String(date.getDate()).padStart(2, '0')
    );
  }

  function stationData(code) {
    var d = global.TIDE_DATA;
    if (!d || !d.stations) return null;
    return d.stations[code] || null;
  }

  /** 潮汐データが存在する日付範囲を返す（データ切れの警告表示に使う）。 */
  function coverage(code) {
    var st = stationData(code);
    if (!st) return null;
    var keys = Object.keys(st.days).sort();
    if (!keys.length) return null;
    return { first: keys[0], last: keys[keys.length - 1], count: keys.length };
  }

  /**
   * 指定日の潮汐サマリを返す。データが無ければ null。
   * @returns {{date, hourly:number[], highs:Array, lows:Array, min, max, range, phase, moonAge}}
   */
  function daySummary(code, date) {
    var st = stationData(code);
    if (!st) return null;
    var key = typeof date === 'string' ? date : dateKey(date);
    var rec = st.days[key];
    if (!rec) return null;

    var min = Infinity, max = -Infinity;
    for (var i = 0; i < rec.h.length; i++) {
      if (rec.h[i] < min) min = rec.h[i];
      if (rec.h[i] > max) max = rec.h[i];
    }

    var d = typeof date === 'string' ? parseDateKey(date) : date;
    return {
      code: code,
      name: STATION_NAMES[code] || code,
      date: key,
      hourly: rec.h,
      highs: rec.hi.map(toExtreme),
      lows: rec.lo.map(toExtreme),
      min: min,
      max: max,
      range: max - min,
      phase: tidePhase(d),
      moonAge: Math.round(moonAge(d) * 10) / 10
    };
  }

  function toExtreme(pair) {
    var hh = Math.floor(pair[0] / 100);
    var mm = pair[0] % 100;
    return {
      hhmm: pair[0],
      hour: hh + mm / 60,
      time: String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'),
      level: pair[1]
    };
  }

  function parseDateKey(key) {
    var p = key.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  /**
   * 任意の時刻（小数時、0〜24）の潮位を補間して返す。
   * 毎時値しかないため、隣接する2点をコサイン補間する（線形より潮汐カーブに近い）。
   * 日をまたぐ場合は翌日の 0 時値を使う。
   */
  function levelAt(code, date, decimalHour) {
    var st = stationData(code);
    if (!st) return null;
    var key = typeof date === 'string' ? date : dateKey(date);
    var rec = st.days[key];
    if (!rec) return null;

    var h = Math.max(0, Math.min(23.999, decimalHour));
    var i = Math.floor(h);
    var f = h - i;
    var a = rec.h[i];
    var b;
    if (i < 23) {
      b = rec.h[i + 1];
    } else {
      var next = st.days[shiftDateKey(key, 1)];
      b = next ? next.h[0] : a;
    }
    var w = (1 - Math.cos(Math.PI * f)) / 2;
    return a + (b - a) * w;
  }

  function shiftDateKey(key, days) {
    var d = parseDateKey(key);
    d.setDate(d.getDate() + days);
    return dateKey(d);
  }

  /**
   * ある時間帯が上げ潮か下げ潮かを判定する。
   * @returns {'上げ'|'下げ'|'停滞'|null}
   */
  function tideTrend(code, date, fromHour, toHour) {
    var a = levelAt(code, date, fromHour);
    var b = levelAt(code, date, toHour);
    if (a === null || b === null) return null;
    var diff = b - a;
    if (Math.abs(diff) < 5) return '停滞'; // 5cm 未満は動いていないとみなす
    return diff > 0 ? '上げ' : '下げ';
  }

  /**
   * 指定時間帯に満潮/干潮の転流が含まれるか（マヅメと潮変わりの重なり判定用）。
   */
  function extremesInWindow(summary, fromHour, toHour) {
    if (!summary) return [];
    var out = [];
    summary.highs.forEach(function (e) {
      if (e.hour >= fromHour && e.hour <= toHour) out.push({ kind: '満潮', time: e.time, level: e.level });
    });
    summary.lows.forEach(function (e) {
      if (e.hour >= fromHour && e.hour <= toHour) out.push({ kind: '干潮', time: e.time, level: e.level });
    });
    out.sort(function (x, y) { return x.time < y.time ? -1 : 1; });
    return out;
  }

  FF.tide = {
    STATION_NAMES: STATION_NAMES,
    moonAge: moonAge,
    tidePhase: tidePhase,
    dateKey: dateKey,
    parseDateKey: parseDateKey,
    shiftDateKey: shiftDateKey,
    coverage: coverage,
    daySummary: daySummary,
    levelAt: levelAt,
    tideTrend: tideTrend,
    extremesInWindow: extremesInWindow
  };
})(typeof window !== 'undefined' ? window : globalThis);
