/*
 * jma.js - 気象庁の公式予報（第2の意見）
 *
 * 全球モデル（Open-Meteo）だけでは日本の実務的な予報が拾えないので、気象庁の公式予報も併記する。
 * Yahoo!天気は別系統の第3の意見として assets/yahoo.js が持ってくる。
 * 気象庁と Yahoo は上流が同じではなく、確度も降水確率も実測で食い違う
 * （例 2026-07-30: 気象庁 80% / Yahoo 50%）ので、どちらかで代用しないこと。
 *
 * 全球モデル（Open-Meteo）に対して、気象庁の予報がとくに強いのは次の2点。
 *   - 沿岸の波: 予報区ごとの実務的な波高予報。25km格子の全球波浪モデルより岸の実態に近い
 *   - 海上の風: 「海上では南西の風強く」のように陸と海を分けて書かれる
 *
 * 注意: bosai の JSON は気象庁が API として公開しているものではないため、
 * 予告なく仕様が変わりうる。取得に失敗しても本体の判定は止めない設計にすること。
 */
(function (global) {
  'use strict';

  var FF = (global.FF = global.FF || {});

  var BASE = 'https://www.jma.go.jp/bosai/forecast/data';

  // 気象庁の天気コード（テロップ番号）。実際に予報で出る主要なものを収録し、
  // 未収録は百の位（1=晴 2=曇 3=雨 4=雪）にフォールバックする。
  var TELOP = {
    100: '晴', 101: '晴時々曇', 102: '晴一時雨', 103: '晴時々雨', 104: '晴一時雪',
    105: '晴時々雪', 106: '晴一時雨か雪', 107: '晴時々雨か雪', 108: '晴一時雨か雷雨',
    110: '晴後時々曇', 111: '晴後曇', 112: '晴後一時雨', 113: '晴後時々雨', 114: '晴後雨',
    115: '晴後一時雪', 116: '晴後時々雪', 117: '晴後雪', 118: '晴後雨か雪', 119: '晴後雨か雷雨',
    120: '晴朝夕一時雨', 121: '晴朝の内一時雨', 122: '晴夕方一時雨', 123: '晴山沿い雷雨',
    124: '晴山沿い雪', 125: '晴午後は雷雨', 126: '晴昼頃から雨', 127: '晴夕方から雨',
    128: '晴夜は雨', 130: '朝の内霧後晴', 131: '晴明け方霧', 132: '晴朝夕曇',
    140: '晴時々雨で雷を伴う', 160: '晴一時雪か雨', 170: '晴時々雪か雨', 181: '晴後雪か雨',
    200: '曇', 201: '曇時々晴', 202: '曇一時雨', 203: '曇時々雨', 204: '曇一時雪',
    205: '曇時々雪', 206: '曇一時雨か雪', 207: '曇時々雨か雪', 208: '曇一時雨で雷を伴う',
    209: '霧', 210: '曇後時々晴', 211: '曇後晴', 212: '曇後一時雨', 213: '曇後時々雨',
    214: '曇後雨', 215: '曇後一時雪', 216: '曇後時々雪', 217: '曇後雪', 218: '曇後雨か雪',
    219: '曇後雨で雷を伴う', 220: '曇朝夕一時雨', 221: '曇朝の内一時雨', 222: '曇夕方一時雨',
    223: '曇日中時々晴', 224: '曇昼頃から雨', 225: '曇夕方から雨', 226: '曇夜は雨',
    228: '曇昼頃から雪', 229: '曇夕方から雪', 230: '曇夜は雪', 231: '曇海上海岸は霧か霧雨',
    240: '曇時々雨で雷を伴う', 250: '曇時々雪で雷を伴う', 260: '曇一時雪か雨',
    270: '曇時々雪か雨', 281: '曇後雪か雨',
    300: '雨', 301: '雨時々晴', 302: '雨時々止む', 303: '雨時々雪', 304: '雨か雪',
    306: '大雨', 308: '雨で暴風を伴う', 309: '雨一時雪', 311: '雨後晴', 313: '雨後曇',
    314: '雨後時々雪', 315: '雨後雪', 316: '雨か雪後晴', 317: '雨か雪後曇',
    320: '朝の内雨後晴', 321: '朝の内雨後曇', 322: '雨朝晩一時雪', 323: '雨昼頃から晴',
    324: '雨夕方から晴', 325: '雨夜は晴', 326: '雨夕方から雪', 327: '雨夜は雪',
    328: '雨一時強く降る', 329: '雨一時みぞれ', 340: '雪か雨', 350: '雨で雷を伴う',
    361: '雪か雨後晴', 371: '雪か雨後曇',
    400: '雪', 401: '雪時々晴', 402: '雪時々止む', 403: '雪時々雨', 405: '大雪',
    406: '風雪強い', 407: '暴風雪', 409: '雪一時雨', 411: '雪後晴', 413: '雪後曇',
    414: '雪後雨', 420: '朝の内雪後晴', 421: '朝の内雪後曇', 422: '雪昼頃から雨',
    423: '雪夕方から雨', 425: '雪一時強く降る', 426: '雪後みぞれ', 427: '雪一時みぞれ',
    450: '雪で雷を伴う'
  };

  var CATEGORY = { 1: '晴', 2: '曇', 3: '雨', 4: '雪' };
  var ICON = { 1: '☀', 2: '☁', 3: '🌧', 4: '🌨' };

  var RELIABILITY_NOTE = {
    A: '確度が高い（気象庁）',
    B: '確度がやや高い（気象庁）',
    C: '確度が低い（気象庁）'
  };

  function telop(code) {
    var n = Number(code);
    if (TELOP[n]) return TELOP[n];
    var head = Math.floor(n / 100);
    return CATEGORY[head] || '—';
  }

  function icon(code) {
    return ICON[Math.floor(Number(code) / 100)] || '·';
  }

  /** 全角数字・記号を半角にする。気象庁の予報文は全角（例: ０．５メートル）。 */
  function toHalfWidth(s) {
    return String(s)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[．　]/g, function (c) { return c === '．' ? '.' : ' '; });
  }

  /**
   * 気象庁の波の予報文から最大波高(m)を取り出す。
   * 「０．５メートル 後 １．５メートル」→ 1.5
   * 予報区内の代表的な値なので、釣り場ピンポイントの値ではないことに注意。
   *
   * tidy() を通した後の文字列（「0.5m 後 1.5m」）も受け取れるようにしてある。
   * 表示用に単位を短くしても解析側が壊れないようにするため。
   * m の直後に英字が続くものは拾わない（mm などを誤って読まないように）。
   */
  function parseWaveMeters(text) {
    if (!text) return null;
    var t = toHalfWidth(text);
    var m = t.match(/(\d+(?:\.\d+)?)\s*(?:メートル|m(?![a-zA-Z]))/g);
    if (!m) return null;
    var vals = m.map(function (x) { return parseFloat(x); }).filter(function (v) { return isFinite(v); });
    return vals.length ? Math.max.apply(null, vals) : null;
  }

  /**
   * 予報文を読みやすく整形する。
   * 気象庁は語の区切りに全角スペース、数値に全角数字、単位に「メートル」を使う
   * （例「０．５メートル　後　１．５メートル」→「0.5m 後 1.5m」）。
   * 表の他の数値はすべて半角＋m なので、混ざると狭い画面で読みにくい。
   */
  function tidy(text) {
    return toHalfWidth(String(text || ''))
      .replace(/メートル/g, 'm')
      .replace(/ +/g, ' ')
      .trim();
  }

  function dayKey(iso) {
    return String(iso).slice(0, 10);
  }

  function getJson(url) {
    return fetch(url, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /**
   * 府県予報区の予報を取得して日付キーの辞書に整える。
   * @param {string} prefCode 例 '150000'（新潟県）
   * @param {string} areaCode 例 '150030'（上越）
   */
  function load(prefCode, areaCode) {
    return Promise.all([
      getJson(BASE + '/forecast/' + prefCode + '.json'),
      getJson(BASE + '/overview_forecast/' + prefCode + '.json').catch(function () { return null; })
    ]).then(function (res) {
      var data = res[0];
      var overview = res[1];
      var out = {
        prefCode: prefCode,
        areaCode: areaCode,
        office: data[0] && data[0].publishingOffice,
        reportDatetime: data[0] && data[0].reportDatetime,
        days: {},     // 'YYYY-MM-DD' -> { weather, wind, wave, waveMeters, pop, reliability, source }
        overview: overview ? {
          headline: tidy(overview.headlineText),
          text: tidy(overview.text),
          at: overview.reportDatetime
        } : null
      };

      function day(key) {
        return out.days[key] || (out.days[key] = {
          date: key, weather: null, weatherCode: null, wind: null, wave: null,
          waveMeters: null, pop: null, reliability: null, source: null
        });
      }

      // --- 3日予報（天気・風・波は一次細分区域＝上越などの単位）
      var short = data[0];
      if (short && short.timeSeries && short.timeSeries[0]) {
        var ts = short.timeSeries[0];
        var area = pickArea(ts.areas, areaCode);
        if (area) {
          ts.timeDefines.forEach(function (t, i) {
            var d = day(dayKey(t));
            d.weather = tidy(area.weathers && area.weathers[i]);
            d.weatherCode = area.weatherCodes && area.weatherCodes[i];
            d.wind = tidy(area.winds && area.winds[i]);
            d.wave = tidy(area.waves && area.waves[i]);
            d.waveMeters = parseWaveMeters(d.wave);
            d.source = 'short';
            d.areaName = area.area && area.area.name;
          });
        }
      }

      // 3日予報の降水確率は6時間刻みなので、日ごとの最大にまとめる
      if (short && short.timeSeries && short.timeSeries[1]) {
        var ps = short.timeSeries[1];
        var parea = pickArea(ps.areas, areaCode);
        if (parea) {
          ps.timeDefines.forEach(function (t, i) {
            var v = Number(parea.pops[i]);
            if (!isFinite(v)) return;
            var d = day(dayKey(t));
            d.pop = d.pop === null ? v : Math.max(d.pop, v);
          });
        }
      }

      // --- 週間予報（府県単位。信頼度 A/B/C が付く）
      var week = data[1];
      if (week && week.timeSeries && week.timeSeries[0]) {
        var ws = week.timeSeries[0];
        var warea = ws.areas[0];
        ws.timeDefines.forEach(function (t, i) {
          var key = dayKey(t);
          var d = day(key);
          // 3日予報がある日はそちらが詳しいので天気は上書きしない
          if (d.source !== 'short') {
            d.weatherCode = warea.weatherCodes && warea.weatherCodes[i];
            d.weather = d.weatherCode ? telop(d.weatherCode) : null;
            d.source = 'week';
          }
          // 降水確率は別扱い。3日予報の降水確率は約36時間分しか無く、
          // 3日目が空欄になるので、埋まっていなければ週間の値で補う。
          if (d.pop === null || d.pop === undefined) {
            var pop = Number(warea.pops && warea.pops[i]);
            d.pop = isFinite(pop) ? pop : null;
          }
          var r = warea.reliabilities && warea.reliabilities[i];
          if (r) d.reliability = r;
        });
        out.weeklyAreaName = warea.area && warea.area.name;
      }

      return out;
    });
  }

  function pickArea(areas, code) {
    if (!areas || !areas.length) return null;
    for (var i = 0; i < areas.length; i++) {
      if (areas[i].area && areas[i].area.code === code) return areas[i];
    }
    return areas[0];
  }

  FF.jma = {
    load: load,
    telop: telop,
    icon: icon,
    parseWaveMeters: parseWaveMeters,
    tidy: tidy,
    toHalfWidth: toHalfWidth,
    RELIABILITY_NOTE: RELIABILITY_NOTE
  };
})(typeof window !== 'undefined' ? window : globalThis);
