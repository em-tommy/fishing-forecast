/*
 * yahoo.js - Yahoo!天気（日本気象協会）の週間予報を読む
 *
 * data/yahoo.js が定義する window.YAHOO_DATA を扱う。取得は tools/Fetch-Yahoo.ps1。
 *
 * なぜ別に持つのか:
 *   Yahoo!天気は気象庁の予報をそのまま流しているわけではない。実測で比べると
 *   確度も降水確率も食い違う（例 2026-07-30: 気象庁 80% / Yahoo 50%）。
 *   日本気象協会の統計補正が入っているためで、現地で「よく当たる」と言われるのはこの部分。
 *
 * 取れるもの / 取れないもの:
 *   Webページ    … 明後日から6日分の 天気・最高最低気温・降水確率。値はアプリと完全一致する。
 *   アプリのみ   … 信頼度 A〜C と 7〜15日目。非公開APIの中にしか無いので取得しない。
 *   確度が要る場合は assets/jma.js が持ってくる気象庁の公式確度（A/B/C・7日）を見ること。
 */
(function (global) {
  'use strict';

  var FF = (global.FF = global.FF || {});

  // 地点コード → 表示名（生成データ側は数値と天気テキストだけを持つ）
  var POINT_NAMES = {
    '15222': '上越市',
    '15482': '津南町'
  };

  function data() {
    return global.YAHOO_DATA || null;
  }

  function available() {
    var d = data();
    return !!(d && d.points && Object.keys(d.points).length);
  }

  function point(code) {
    var d = data();
    if (!d || !d.points) return null;
    var p = d.points[code];
    if (!p) return null;
    return {
      code: code,
      name: POINT_NAMES[code] || code,
      announced: p.announced,
      days: p.days
    };
  }

  /** 指定日の予報。無ければ null。 */
  function day(code, date) {
    var p = point(code);
    if (!p) return null;
    return p.days[date] || null;
  }

  /** 収録されている日付の範囲。 */
  function coverage(code) {
    var p = point(code);
    if (!p) return null;
    var keys = Object.keys(p.days).sort();
    if (!keys.length) return null;
    return { first: keys[0], last: keys[keys.length - 1], count: keys.length };
  }

  /** データの取得時刻（JST）。何時点の情報かを画面に出すために使う。 */
  function fetchedAt() {
    var d = data();
    return d ? d.fetchedAt : null;
  }

  /** 天気テキストからおおまかな絵文字を決める。Yahooの表記は「曇一時雨」のような形。 */
  function icon(text) {
    if (!text) return '·';
    if (/雷/.test(text)) return '⛈';
    if (/雪/.test(text)) return '🌨';
    if (/雨/.test(text)) return /晴/.test(text) ? '🌦' : '🌧';
    if (/曇|くもり/.test(text)) return /晴/.test(text) ? '⛅' : '☁';
    if (/晴/.test(text)) return '☀';
    return '·';
  }

  FF.yahoo = {
    POINT_NAMES: POINT_NAMES,
    available: available,
    point: point,
    day: day,
    coverage: coverage,
    fetchedAt: fetchedAt,
    icon: icon
  };
})(typeof window !== 'undefined' ? window : globalThis);
