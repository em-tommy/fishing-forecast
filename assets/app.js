/*
 * app.js - 釣行ダッシュボード本体
 *
 * データ取得 -> 正規化 -> FF.rating で評価 -> 描画。
 *
 * 気象: Open-Meteo Forecast API（16日先まで / ECMWF・GFS・ICON・JMA の4モデル）
 * 波浪: Open-Meteo Marine API（8日先まで。9日目以降は存在しないので風のみ判定に落ちる）
 * 潮汐: 気象庁 潮位表（data/tide-YYYY.js に同梱。ビルド時に取得）
 */
(function (global) {
  'use strict';

  var FF = (global.FF = global.FF || {});
  var R = FF.rating;
  var TIDE = FF.tide;

  // ================================================================ 定数

  var MODELS = [
    { id: 'ecmwf_ifs025', label: 'ECMWF', color: 'var(--s1)' },
    { id: 'gfs_seamless', label: 'GFS', color: 'var(--s2)' },
    { id: 'icon_seamless', label: 'ICON', color: 'var(--s3)' },
    { id: 'jma_seamless', label: 'JMA', color: 'var(--s4)' }
  ];

  // Open-Meteo は「変数 × 日数 × モデル」で重み付けしてレート制限する。
  // 4モデル16日を6地点ぶん一度に投げると 429 が返るため、モデル比較画面を持つ直江津以外は
  // 3モデルに絞る。ICON を落として GFS を残すのは、16日目まで値があるのが GFS だけで、
  // 外すと最終日が「データなし」になってしまうため。
  var MODELS_LITE = [MODELS[0], MODELS[1], MODELS[3]];

  function modelsFor(spot) {
    return spot.kind === 'boat' ? MODELS : MODELS_LITE;
  }

  // 釣り場マスタは assets/spots.js。増えるのはあちらだけで、ここは触らない。
  var REGIONS = FF.spots.REGIONS;
  var SPOTS = FF.spots.SPOTS;
  var BOATS = FF.spots.BOATS;
  var spotById = FF.spots.byId;

  // 現地で「よく当たる」と言われる Yahoo天気は、日本気象協会経由で気象庁の予報を配信している。
  // アプリからは上流の気象庁を直接使うが、いつもの画面で確かめたいはずなのでリンクも置く。
  var YAHOO_LINKS = [
    { label: '上越市', url: 'https://weather.yahoo.co.jp/weather/jp/15/5430/15222.html' },
    { label: '津南町', url: 'https://weather.yahoo.co.jp/weather/jp/15/5420/15482.html' }
  ];

  var WMO = {
    0: ['快晴', '☀'], 1: ['晴れ', '🌤'], 2: ['薄曇り', '⛅'], 3: ['曇り', '☁'],
    45: ['霧', '🌫'], 48: ['霧氷', '🌫'],
    51: ['霧雨', '🌦'], 53: ['霧雨', '🌦'], 55: ['強い霧雨', '🌦'],
    56: ['着氷性霧雨', '🌧'], 57: ['着氷性霧雨', '🌧'],
    61: ['弱い雨', '🌧'], 63: ['雨', '🌧'], 65: ['強い雨', '🌧'],
    66: ['着氷性の雨', '🌧'], 67: ['着氷性の雨', '🌧'],
    71: ['弱い雪', '🌨'], 73: ['雪', '🌨'], 75: ['強い雪', '🌨'], 77: ['霧雪', '🌨'],
    80: ['にわか雨', '🌦'], 81: ['にわか雨', '🌦'], 82: ['激しいにわか雨', '⛈'],
    85: ['にわか雪', '🌨'], 86: ['強いにわか雪', '🌨'],
    95: ['雷雨', '⛈'], 96: ['雹を伴う雷雨', '⛈'], 99: ['雹を伴う雷雨', '⛈']
  };

  var DOW = ['日', '月', '火', '水', '木', '金', '土'];

  var CACHE_TTL_MS = 30 * 60 * 1000;
  var CACHE_PREFIX = 'ff:cache:v1:';
  var SETTINGS_KEY = 'ff:settings:v1';
  var SPOT_SETTINGS_KEY = 'ff:spotsettings:v1';
  var BOAT_SPOT_KEY = 'ff:boatspot';
  var THEME_KEY = 'ff:theme';
  // 判定する時間帯はタブごとに持つ。出船は朝、東京湾のアジは夕方と、狙う時間が違うため。
  var PERIOD_KEY = { boat: 'ff:period:boat', shore: 'ff:period:shore' };

  // ================================================================ 小物

  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmt(v, d, dash) {
    return isNum(v) ? v.toFixed(d === undefined ? 1 : d) : (dash || '—');
  }
  function pad2(n) { return String(n).padStart(2, '0'); }

  /** 'HH:MM' 部分を小数時に。'2026-07-28T04:48' -> 4.8 */
  function isoTimeToDecimalHour(iso) {
    if (!iso) return null;
    var m = /T(\d{2}):(\d{2})/.exec(iso);
    if (!m) return null;
    return Number(m[1]) + Number(m[2]) / 60;
  }
  function isoTimeHHMM(iso) {
    var m = /T(\d{2}):(\d{2})/.exec(iso || '');
    return m ? m[1] + ':' + m[2] : '—';
  }
  function decimalToHHMM(h) {
    if (!isNum(h)) return '—';
    var hh = Math.floor(h);
    var mm = Math.round((h - hh) * 60);
    if (mm === 60) { hh++; mm = 0; }
    return pad2(hh) + ':' + pad2(mm);
  }

  function haversineKm(a1, o1, a2, o2) {
    var toRad = Math.PI / 180;
    var dLat = (a2 - a1) * toRad, dLon = (o2 - o1) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a1 * toRad) * Math.cos(a2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function weatherOf(code) {
    return WMO[code] || ['—', '·'];
  }

  // ================================================================ 保存領域

  var store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 容量超過は無視 */ }
    }
  };

  function loadSettings() {
    return Object.assign({}, R.DEFAULTS, store.get(SETTINGS_KEY, {}));
  }
  function saveSettings(s) {
    var diff = {};
    Object.keys(s).forEach(function (k) { if (s[k] !== R.DEFAULTS[k]) diff[k] = s[k]; });
    store.set(SETTINGS_KEY, diff);
  }

  /**
   * 釣り場ごとのしきい値。
   *
   * 重ねる順番は 既定 → 全体設定 → 釣り場の profile → 釣り場ごとの上書き。
   * profile を全体設定より後に置くのは、岸の向きが「その海岸の事実」であって
   * 利用者の好みではないため。向きまで全体設定で上書きできると、
   * 直江津の北風ペナルティが三浦にも適用されるという最初の設計ミスに戻る。
   * それでも現地で違うと感じたときのために、釣り場ごとの上書きが最後に来る。
   */
  function loadSpotSettings() {
    return store.get(SPOT_SETTINGS_KEY, {});
  }
  function saveSpotSettings(all) {
    store.set(SPOT_SETTINGS_KEY, all);
  }
  function thresholdsFor(spot) {
    var over = (state.spotSettings && state.spotSettings[spot.id]) || {};
    return Object.assign({}, state.settings, spot.profile || {}, over);
  }
  /** その釣り場で全体設定から外れている項目の数（UI のバッジ用） */
  function overrideCount(spot) {
    var over = (state.spotSettings && state.spotSettings[spot.id]) || {};
    return Object.keys(over).length;
  }

  // ================================================================ 取得

  /**
   * キャッシュ付き fetch。取得に失敗したら期限切れキャッシュでもよいので返す
   * （港でのオフライン時に何も出ないより、古いと明示して出すほうが有用）。
   */
  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * 同時実行数を絞って順に流す。
   * Open-Meteo は「変数 × 日数 × モデル」で重み付けしてレート制限するため、
   * 全地点ぶんを一度に投げると 429 が返る。
   */
  function throttled(tasks, concurrency) {
    var results = new Array(tasks.length);
    var next = 0;
    function worker() {
      if (next >= tasks.length) return Promise.resolve();
      var i = next++;
      return Promise.resolve(tasks[i]()).then(function (v) {
        results[i] = v;
        return worker();
      });
    }
    var workers = [];
    for (var w = 0; w < Math.min(concurrency, tasks.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  function fetchOnce(url) {
    return fetch(url, { mode: 'cors' }).then(function (res) {
      if (res.status === 429) {
        var e = new Error('レート制限（429）');
        e.retryable = true;
        throw e;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function fetchJson(url) {
    var key = CACHE_PREFIX + url;
    var cached = store.get(key, null);
    var now = Date.now();
    if (cached && now - cached.t < CACHE_TTL_MS) {
      return Promise.resolve({ json: cached.json, at: cached.t, fromCache: true });
    }
    return fetchOnce(url)
      .catch(function (err) {
        // 429 は少し待てば通ることが多いので1度だけやり直す
        if (!err || !err.retryable) throw err;
        return delay(2500).then(function () { return fetchOnce(url); });
      })
      .then(function (json) {
        if (json && json.error) throw new Error(json.reason || 'API error');
        store.set(key, { t: now, json: json });
        return { json: json, at: now, fromCache: false };
      })
      .catch(function (err) {
        if (cached) return { json: cached.json, at: cached.t, fromCache: true, stale: true, error: err };
        throw err;
      });
  }

  function forecastUrl(spot) {
    return 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=' + spot.lat + '&longitude=' + spot.lon +
      '&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m' +
      '&models=' + modelsFor(spot).map(function (m) { return m.id; }).join(',') +
      '&timezone=Asia%2FTokyo&forecast_days=16&wind_speed_unit=ms';
  }

  function baseUrl(spot) {
    return 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=' + spot.lat + '&longitude=' + spot.lon +
      '&hourly=temperature_2m,precipitation,precipitation_probability,weather_code' +
      '&daily=sunrise,sunset,weather_code,precipitation_probability_max,temperature_2m_max,temperature_2m_min' +
      '&timezone=Asia%2FTokyo&forecast_days=16&wind_speed_unit=ms';
  }

  function marineUrl(spot) {
    return 'https://marine-api.open-meteo.com/v1/marine' +
      '?latitude=' + spot.lat + '&longitude=' + spot.lon +
      '&hourly=wave_height,wave_period,wave_direction,wind_wave_height,' +
      'swell_wave_height,swell_wave_period,swell_wave_direction' +
      '&timezone=Asia%2FTokyo&forecast_days=8';
  }

  /** 'YYYY-MM-DDTHH:MM' -> {date:'YYYY-MM-DD', hour:0-23} */
  function splitStamp(s) {
    return { date: s.slice(0, 10), hour: Number(s.slice(11, 13)) };
  }

  function loadSpot(spot) {
    return Promise.all([
      fetchJson(forecastUrl(spot)),
      fetchJson(baseUrl(spot)),
      fetchJson(marineUrl(spot)).catch(function (e) { return { json: null, error: e }; })
    ]).then(function (parts) {
      return buildBundle(spot, parts[0], parts[1], parts[2]);
    });
  }

  function buildBundle(spot, modelsRes, baseRes, marineRes) {
    var models = modelsRes.json;
    var base = baseRes.json;
    var marine = marineRes && marineRes.json;

    var hours = {};   // date -> [24]
    var daily = {};   // date -> {...}

    function slot(date, hour) {
      if (!hours[date]) {
        hours[date] = [];
        for (var i = 0; i < 24; i++) {
          hours[date].push({
            hour: i, wind: {}, gust: {}, dir: {},
            wave: null, wavePeriod: null, waveDir: null,
            windWave: null, swellHeight: null, swellPeriod: null, swellDir: null,
            temp: null, precip: null, precipProb: null, weatherCode: null
          });
        }
      }
      return hours[date][hour];
    }

    // --- モデル別の風
    var useModels = modelsFor(spot);
    var mh = models.hourly;
    for (var i = 0; i < mh.time.length; i++) {
      var st = splitStamp(mh.time[i]);
      var rec = slot(st.date, st.hour);
      useModels.forEach(function (m) {
        var w = mh['wind_speed_10m_' + m.id];
        var g = mh['wind_gusts_10m_' + m.id];
        var d = mh['wind_direction_10m_' + m.id];
        if (w && isNum(w[i])) rec.wind[m.id] = w[i];
        if (g && isNum(g[i])) rec.gust[m.id] = g[i];
        if (d && isNum(d[i])) rec.dir[m.id] = d[i];
      });
    }

    // --- 天気・気温・降水（best_match）
    var bh = base.hourly;
    for (var j = 0; j < bh.time.length; j++) {
      var st2 = splitStamp(bh.time[j]);
      if (!hours[st2.date]) continue;
      var rec2 = hours[st2.date][st2.hour];
      rec2.temp = bh.temperature_2m ? bh.temperature_2m[j] : null;
      rec2.precip = bh.precipitation ? bh.precipitation[j] : null;
      rec2.precipProb = bh.precipitation_probability ? bh.precipitation_probability[j] : null;
      rec2.weatherCode = bh.weather_code ? bh.weather_code[j] : null;
    }

    var bd = base.daily;
    for (var k = 0; k < bd.time.length; k++) {
      daily[bd.time[k]] = {
        sunrise: isoTimeToDecimalHour(bd.sunrise[k]),
        sunset: isoTimeToDecimalHour(bd.sunset[k]),
        sunriseText: isoTimeHHMM(bd.sunrise[k]),
        sunsetText: isoTimeHHMM(bd.sunset[k]),
        weatherCode: bd.weather_code[k],
        precipMax: bd.precipitation_probability_max[k],
        tMax: bd.temperature_2m_max[k],
        tMin: bd.temperature_2m_min[k]
      };
    }

    // --- 波浪（8日先まで。無くても止めない）
    var waveLastDate = null;
    var marineMeta = null;
    if (marine && marine.hourly) {
      var wh = marine.hourly;
      for (var n = 0; n < wh.time.length; n++) {
        var st3 = splitStamp(wh.time[n]);
        if (!hours[st3.date]) continue;
        var rec3 = hours[st3.date][st3.hour];
        rec3.wave = pick(wh.wave_height, n);
        rec3.wavePeriod = pick(wh.wave_period, n);
        rec3.waveDir = pick(wh.wave_direction, n);
        rec3.windWave = pick(wh.wind_wave_height, n);
        rec3.swellHeight = pick(wh.swell_wave_height, n);
        rec3.swellPeriod = pick(wh.swell_wave_period, n);
        rec3.swellDir = pick(wh.swell_wave_direction, n);
        if (isNum(rec3.wave)) waveLastDate = st3.date;
      }
      marineMeta = {
        lat: marine.latitude, lon: marine.longitude,
        distanceKm: haversineKm(spot.lat, spot.lon, marine.latitude, marine.longitude)
      };
    }

    var fetchedAt = Math.min(modelsRes.at || Date.now(), baseRes.at || Date.now());
    var stale = !!(modelsRes.stale || baseRes.stale || (marineRes && marineRes.stale));

    return {
      spot: spot,
      dates: Object.keys(hours).sort(),
      hours: hours,
      daily: daily,
      waveLastDate: waveLastDate,
      marine: marineMeta,
      marineError: marineRes && marineRes.error ? String(marineRes.error.message || marineRes.error) : null,
      fetchedAt: fetchedAt,
      stale: stale
    };
  }

  function pick(arr, i) {
    return arr && isNum(arr[i]) ? arr[i] : null;
  }

  // ================================================================ 評価

  function evaluateBundle(bundle, settings) {
    var spot = bundle.spot;
    var official = state.jma[spot.id];
    var period = state.period[spot.kind === 'boat' ? 'boat' : 'shore'];
    return bundle.dates.map(function (date) {
      var d = bundle.daily[date] || {};
      var day = { date: date, sunrise: d.sunrise, sunset: d.sunset, hours: bundle.hours[date] };
      var res = R.evaluateDay(day, settings, {
        checkDirection: spot.kind === 'boat',
        period: period
      });
      res.daily = d;
      res.tide = TIDE.daySummary(spot.tide, date);
      res.dayMaxWave = R.maxOf(bundle.hours[date].map(function (h) { return h.wave; }));
      res.official = official && official.days[date] ? official.days[date] : null;
      res.yahoo = spot.yahoo && FF.yahoo ? FF.yahoo.day(spot.yahoo, date) : null;
      res.conflicts = R.findConflicts(res);
      return res;
    });
  }

  // ================================================================ チャート

  var CH = { W: 720, PADL: 36, PADR: 12, PADT: 12, PADB: 20 };

  function niceMax(v) {
    if (!isNum(v) || v <= 0) return 1;
    var exp = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / exp;
    var step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return step * exp;
  }

  /**
   * 24時間の折れ線チャートを SVG 文字列で返す。
   * 単位の違う量は絶対に同じチャートに混ぜない（2軸チャートは作らない）。
   */
  function lineChart(opts) {
    var H = opts.height || 150;
    var W = CH.W;
    var x0 = CH.PADL, x1 = W - CH.PADR, y0 = CH.PADT, y1 = H - CH.PADB;
    var series = opts.series.filter(function (s) {
      return s.values.some(isNum);
    });

    var allVals = [];
    series.forEach(function (s) { s.values.forEach(function (v) { if (isNum(v)) allVals.push(v); }); });
    (opts.thresholds || []).forEach(function (t) { allVals.push(t.value); });
    // 帯（アンサンブルの分位幅）も軸の範囲に入れる。入れないと帯が枠外にはみ出す
    if (opts.ribbon) {
      opts.ribbon.upper.forEach(function (v) { if (isNum(v)) allVals.push(v); });
      opts.ribbon.lower.forEach(function (v) { if (isNum(v)) allVals.push(v); });
    }
    if (!allVals.length) {
      return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
        esc(opts.title || '') + '（データなし）"><text class="tick" x="' + (W / 2) + '" y="' + (H / 2) +
        '" text-anchor="middle">データなし</text></svg>';
    }

    var dataMax = Math.max.apply(null, allVals);
    var dataMin = isNum(opts.yMin) ? opts.yMin : Math.min(0, Math.min.apply(null, allVals));
    var top = isNum(opts.yMax) ? opts.yMax : niceMax(dataMax * 1.12);
    if (top <= dataMin) top = dataMin + 1;

    function px(h) { return x0 + (h / 23) * (x1 - x0); }
    function py(v) { return y1 - ((v - dataMin) / (top - dataMin)) * (y1 - y0); }

    var out = [];
    out.push('<svg class="chart" viewBox="0 0 ' + W + ' ' + H +
      '" preserveAspectRatio="none" role="img" aria-label="' + esc(opts.title || '') + '">');

    // 判定時間帯の帯
    if (opts.band && isNum(opts.band.from) && isNum(opts.band.to)) {
      out.push('<rect class="band" x="' + px(opts.band.from).toFixed(1) + '" y="' + y0 +
        '" width="' + Math.max(1, px(opts.band.to) - px(opts.band.from)).toFixed(1) +
        '" height="' + (y1 - y0) + '"/>');
    }

    // 横グリッド
    var steps = 4;
    for (var g = 0; g <= steps; g++) {
      var v = dataMin + (top - dataMin) * g / steps;
      var y = py(v);
      out.push('<line class="' + (g === 0 ? 'axis-line' : 'grid-line') + '" x1="' + x0 + '" y1="' +
        y.toFixed(1) + '" x2="' + x1 + '" y2="' + y.toFixed(1) + '"/>');
      out.push('<text class="tick" x="' + (x0 - 5) + '" y="' + (y + 3.5).toFixed(1) +
        '" text-anchor="end">' + fmt(v, opts.decimals === undefined ? 0 : opts.decimals) + '</text>');
    }

    // 縦の時刻目盛
    for (var h = 0; h <= 23; h += 3) {
      out.push('<text class="tick" x="' + px(h).toFixed(1) + '" y="' + (H - 6) +
        '" text-anchor="middle">' + h + '</text>');
    }

    // しきい値ライン
    (opts.thresholds || []).forEach(function (t) {
      if (t.value > top || t.value < dataMin) return;
      var y = py(t.value);
      out.push('<line class="thr" x1="' + x0 + '" y1="' + y.toFixed(1) + '" x2="' + x1 + '" y2="' + y.toFixed(1) + '"/>');
      out.push('<text class="thr-text" x="' + (x1 - 2) + '" y="' + (y - 3).toFixed(1) +
        '" text-anchor="end">' + esc(t.label) + '</text>');
    });

    // 日の出・日の入・満干潮などのマーカー
    (opts.markers || []).forEach(function (m) {
      if (!isNum(m.hour) || m.hour < 0 || m.hour > 23) return;
      var x = px(m.hour);
      out.push('<line class="marker-line" x1="' + x.toFixed(1) + '" y1="' + y0 + '" x2="' + x.toFixed(1) + '" y2="' + y1 + '"/>');
      out.push('<text class="marker-text" x="' + (x + 3).toFixed(1) + '" y="' + (y0 + 9) + '">' + esc(m.label) + '</text>');
    });

    // 帯（上限と下限のあいだを塗る）。アンサンブルの分位幅に使う。
    // 系列より先に描いて背面に置く。
    if (opts.ribbon) {
      var up = [], lo = [];
      function flushRibbon() {
        if (up.length < 2) { up = []; lo = []; return; }
        out.push('<path class="ribbon" fill="' + opts.ribbon.color +
          '" d="M' + up.join(' L') + ' L' + lo.reverse().join(' L') + ' Z"/>');
        up = []; lo = [];
      }
      for (var rh = 0; rh < opts.ribbon.upper.length; rh++) {
        var uv = opts.ribbon.upper[rh], lv = opts.ribbon.lower[rh];
        if (isNum(uv) && isNum(lv)) {
          up.push(px(rh).toFixed(1) + ',' + py(uv).toFixed(1));
          lo.push(px(rh).toFixed(1) + ',' + py(lv).toFixed(1));
        } else {
          flushRibbon();
        }
      }
      flushRibbon();
    }

    // 系列
    series.forEach(function (s) {
      var segs = [], cur = [];
      s.values.forEach(function (v, h) {
        if (isNum(v)) cur.push(px(h).toFixed(1) + ',' + py(v).toFixed(1));
        else if (cur.length) { segs.push(cur); cur = []; }
      });
      if (cur.length) segs.push(cur);

      if (s.area && segs.length) {
        segs.forEach(function (seg) {
          var first = seg[0].split(',')[0], last = seg[seg.length - 1].split(',')[0];
          out.push('<path class="area" fill="' + s.color + '" d="M' + first + ',' + py(dataMin).toFixed(1) +
            ' L' + seg.join(' L') + ' L' + last + ',' + py(dataMin).toFixed(1) + ' Z"/>');
        });
      }
      segs.forEach(function (seg) {
        out.push('<path class="series' + (s.thin ? ' thin' : '') + (s.dash ? ' dash' : '') +
          '" stroke="' + s.color + '" d="M' + seg.join(' L') + '"/>');
      });
    });

    // ホバー用のクロスヘアと当たり判定（描画後に JS が座標を書き換える）
    out.push('<line class="crosshair" x1="0" y1="' + y0 + '" x2="0" y2="' + y1 + '" style="display:none"/>');
    series.forEach(function (s) {
      out.push('<circle class="pt" r="4" fill="' + s.color + '" cx="0" cy="0" style="display:none"/>');
    });
    out.push('<rect class="hit" x="' + x0 + '" y="' + y0 + '" width="' + (x1 - x0) +
      '" height="' + (y1 - y0) + '" fill="transparent"/>');
    out.push('</svg>');

    return {
      svg: out.join(''),
      geom: { x0: x0, x1: x1, y0: y0, y1: y1, top: top, min: dataMin, W: W, H: H },
      series: series,
      unit: opts.unit || '',
      decimals: opts.decimals === undefined ? 1 : opts.decimals,
      title: opts.title || ''
    };
  }

  function legendHtml(series) {
    if (series.length < 2) return '';
    return '<div class="legend">' + series.map(function (s) {
      return '<span><i class="' + (s.dash ? 'dash' : '') + '" style="background:' + s.color +
        ';color:' + s.color + '"></i>' + esc(s.label) + '</span>';
    }).join('') + '</div>';
  }

  // --- ホバー（クロスヘア＋ツールチップ）。同じ日の全パネルで時刻を同期する。
  var tooltipEl = null;
  function ensureTooltip() {
    if (!tooltipEl) {
      tooltipEl = el('div', 'tooltip');
      tooltipEl.style.display = 'none';
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  function attachHover(container, charts) {
    var svgs = container.querySelectorAll('svg.chart');
    var tip = ensureTooltip();

    function update(hour, clientX, clientY) {
      var lines = [];
      charts.forEach(function (c, idx) {
        var svg = svgs[idx];
        if (!svg || !c.geom) return;
        var g = c.geom;
        var x = g.x0 + (hour / 23) * (g.x1 - g.x0);
        var cross = svg.querySelector('.crosshair');
        if (cross) {
          cross.setAttribute('x1', x); cross.setAttribute('x2', x);
          cross.style.display = '';
        }
        var pts = svg.querySelectorAll('circle.pt');
        c.series.forEach(function (s, si) {
          var v = s.values[hour];
          var pt = pts[si];
          if (pt) {
            if (isNum(v)) {
              pt.setAttribute('cx', x);
              pt.setAttribute('cy', g.y1 - ((v - g.min) / (g.top - g.min)) * (g.y1 - g.y0));
              pt.style.display = '';
            } else { pt.style.display = 'none'; }
          }
          if (isNum(v)) {
            lines.push('<div class="t-row"><i style="background:' + s.color + '"></i>' +
              esc(s.label) + '<b>' + fmt(v, c.decimals) + c.unit + '</b></div>');
          }
        });
      });
      tip.innerHTML = '<div class="t-title">' + pad2(hour) + ':00</div>' + lines.join('');
      tip.style.display = '';
      var w = tip.offsetWidth, h = tip.offsetHeight;
      var left = clientX + 14;
      if (left + w > global.innerWidth - 6) left = clientX - w - 14;
      var top = clientY - h - 12;
      if (top < 6) top = clientY + 18;
      tip.style.left = Math.max(6, left) + 'px';
      tip.style.top = top + 'px';
    }

    function hide() {
      tip.style.display = 'none';
      Array.prototype.forEach.call(svgs, function (svg) {
        var c = svg.querySelector('.crosshair');
        if (c) c.style.display = 'none';
        Array.prototype.forEach.call(svg.querySelectorAll('circle.pt'), function (p) { p.style.display = 'none'; });
      });
    }

    Array.prototype.forEach.call(svgs, function (svg, idx) {
      var c = charts[idx];
      if (!c || !c.geom) return;
      function onMove(ev) {
        var rect = svg.getBoundingClientRect();
        var relX = (ev.clientX - rect.left) / rect.width * c.geom.W;
        var t = (relX - c.geom.x0) / (c.geom.x1 - c.geom.x0) * 23;
        var hour = Math.max(0, Math.min(23, Math.round(t)));
        update(hour, ev.clientX, ev.clientY);
      }
      svg.addEventListener('pointermove', onMove);
      svg.addEventListener('pointerdown', onMove);
      svg.addEventListener('pointerleave', hide);
    });
    container.addEventListener('pointerleave', hide);
  }

  // ================================================================ 描画: 共通部品

  function gradeBadge(res) {
    var gi = res.gradeInfo || R.NO_DATA;
    return '<span class="grade grade-' + gi.key + '"><span class="sym">' + gi.symbol +
      '</span><span class="lbl">' + gi.label + '</span></span>';
  }

  function badgesHtml(res) {
    if (!res.flags || !res.flags.length) return '';
    return '<div class="badges">' + res.flags.map(function (f) {
      var d = R.FLAGS[f];
      if (!d) return '';
      return '<span class="badge ' + d.tone + '" title="' + esc(d.desc) + '">' + esc(d.label) + '</span>';
    }).join('') + '</div>';
  }

  var CONF_RANK = { high: 3, mid: 2, low: 1, unknown: 0 };

  /**
   * 選んだ時間帯の判定に合わせた時間帯セレクタ。
   * 出船は朝、東京湾のアジは夕方と狙う時間が違うので、タブごとに別々に保持する。
   */
  function periodPicker(scope, onChange) {
    var wrap = el('div', 'chips');
    wrap.style.marginBottom = '8px';
    R.PERIOD_ORDER.forEach(function (key) {
      var p = R.PERIODS[key];
      var b = el('button', null, p.label);
      b.type = 'button';
      b.title = p.desc;
      b.setAttribute('aria-pressed', String(state.period[scope] === key));
      b.addEventListener('click', function () {
        state.period[scope] = key;
        store.set(PERIOD_KEY[scope], key);
        recomputeAll();
        if (onChange) onChange();
      });
      wrap.appendChild(b);
    });
    var box = el('div');
    box.appendChild(el('div', 'muted', 'どの時間帯で判定するか（日の出・日の入を基準に自動で決まります）'));
    box.appendChild(wrap);
    return box;
  }

  /**
   * 16日ストリップ用の天気マークと降水確率。
   * 判定した時間帯と同じ値をとる
   * （日中の代表値を出すと「強い雨なのに ◎」のように判定と食い違って見える）。
   */
  function weatherCell(res) {
    var w = weatherOf(res.metrics.weatherCode);
    var pop = res.metrics.maxPrecipProb;
    var cls = isNum(pop) && pop >= 50 ? 'pop wet' : 'pop';
    return '<div class="wx" title="' + esc(res.window.label) + '帯の天気と降水確率">' +
      '<span class="ico">' + w[1] + '</span>' +
      '<span class="' + cls + '">' + (isNum(pop) ? pop + '%' : '—') + '</span>' +
      '</div>';
  }

  function dateLabel(dateStr) {
    var d = TIDE.parseDateKey(dateStr);
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[d.getDay()] + ')';
  }

  // ================================================================ 描画: 上越タブ

  var state = {
    settings: loadSettings(),
    spotSettings: loadSpotSettings(),  // spotId -> 全体設定からの差分
    period: {
      boat: store.get(PERIOD_KEY.boat, 'morning'),
      shore: store.get(PERIOD_KEY.shore, 'morning')
    },
    bundles: {},      // spotId -> bundle
    jma: {},          // spotId -> 気象庁の公式予報
    // アンサンブル（51本）は1地点あたり約50KBある。出船地点が増えても取得量が
    // 増えないよう、選択中の1か所だけを都度取りにいく。spotId -> parsed
    ensembles: {},
    ensembleLoading: null,
    results: {},      // spotId -> [dayResult]
    boatSpot: pickInitialBoatSpot(),
    selectedDate: null,
    shoreDate: null,
    showModels: false,
    errors: []
  };

  function pickInitialBoatSpot() {
    var saved = store.get(BOAT_SPOT_KEY, null);
    for (var i = 0; i < BOATS.length; i++) if (BOATS[i].id === saved) return saved;
    return BOATS.length ? BOATS[0].id : null;
  }
  /** いま出船タブが見ている釣り場 */
  function currentBoat() {
    return spotById(state.boatSpot) || BOATS[0] || null;
  }
  /** 選択中の釣り場の判定結果。未取得なら null */
  function boatResults() {
    var b = currentBoat();
    return b ? (state.results[b.id] || null) : null;
  }
  function boatBundle() {
    var b = currentBoat();
    return b ? (state.bundles[b.id] || null) : null;
  }
  /** 選択中の釣り場のアンサンブル。未取得なら null */
  function currentEnsemble() {
    var b = currentBoat();
    return b ? (state.ensembles[b.id] || null) : null;
  }

  /**
   * 出船地点の横断比較（行=釣り場 / 列=日）。
   *
   * 釣り場が1か所のときの問いは「いつ行けるか」だったが、複数になると
   * 「今週どこなら出せるか」が先に来る。ここでは記号だけを敷き詰め、数値は出さない。
   * 比べたいのは各地点の風速そのものではなく、空いている枠がどこにあるかだから。
   * 釣り場が増えても行が増えるだけで、横スクロールは日付方向にしか発生しない。
   */
  function renderMatrix() {
    var host = $('#matrix');
    if (!host) return;
    host.innerHTML = '';
    if (BOATS.length < 2) return;  // 1か所しかないなら表にする意味がない

    // 列（日付）は取得済みのどれかの地点から採る。地点ごとに日数がずれることはない。
    var dates = null;
    for (var i = 0; i < BOATS.length && !dates; i++) {
      var r = state.results[BOATS[i].id];
      if (r && r.length) dates = r.map(function (x) { return x.date; });
    }
    if (!dates) return;

    var card = el('section', 'card');
    card.appendChild(el('h2', null, 'どこなら出せるか'));
    card.insertAdjacentHTML('beforeend',
      '<div class="sub">' + esc(R.PERIODS[state.period.boat].label) +
      '帯の判定を出船地点ごとに並べたもの。記号を押すとその釣り場のその日を開きます。</div>');

    var wrap = el('div', 'tbl-wrap');
    var tbl = el('table', 'matrix');
    var head = '<thead><tr><th class="sticky-col">釣り場</th>';
    dates.forEach(function (d) {
      var dt = TIDE.parseDateKey(d);
      var cls = dt.getDay() === 0 ? 'sun' : dt.getDay() === 6 ? 'sat' : '';
      head += '<th class="' + cls + '"><span class="mx-dow">' + DOW[dt.getDay()] + '</span>' +
        '<span class="mx-md">' + (dt.getMonth() + 1) + '/' + dt.getDate() + '</span></th>';
    });
    head += '</tr></thead>';
    tbl.innerHTML = head;

    var body = el('tbody');
    REGIONS.forEach(function (rg) {
      var inRegion = BOATS.filter(function (b) { return b.region === rg.id; });
      if (!inRegion.length) return;
      var rh = el('tr', 'mx-region');
      rh.innerHTML = '<th class="sticky-col" colspan="1">' + esc(rg.name) + '</th>' +
        '<td colspan="' + dates.length + '"></td>';
      body.appendChild(rh);

      inRegion.forEach(function (spot) {
        var res = state.results[spot.id];
        var tr = el('tr');
        if (spot.id === state.boatSpot) tr.className = 'is-selected';
        var cells = '<th class="sticky-col mx-name">' + esc(spot.short) + '</th>';
        dates.forEach(function (d) {
          if (!res) { cells += '<td class="mx-cell"><span class="muted">…</span></td>'; return; }
          var day = null;
          for (var k = 0; k < res.length; k++) if (res[k].date === d) { day = res[k]; break; }
          if (!day) { cells += '<td class="mx-cell"><span class="muted">—</span></td>'; return; }
          var gi = day.gradeInfo || R.NO_DATA;
          var sel = (spot.id === state.boatSpot && d === state.selectedDate) ? ' is-on' : '';
          cells += '<td class="mx-cell"><button type="button" class="mx-btn grade-' + gi.key + sel +
            '" data-spot="' + esc(spot.id) + '" data-date="' + esc(d) + '" title="' +
            esc(spot.short + ' ' + dateLabel(d) + ' ' + gi.label) + '">' + gi.symbol + '</button></td>';
        });
        tr.innerHTML = cells;
        body.appendChild(tr);
      });
    });
    tbl.appendChild(body);
    wrap.appendChild(tbl);
    card.appendChild(wrap);

    card.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.mx-btn') : null;
      if (!b) return;
      state.selectedDate = b.getAttribute('data-date');
      selectBoat(b.getAttribute('data-spot'));
    });

    var notLoaded = BOATS.filter(function (b) { return !state.results[b.id]; });
    if (notLoaded.length) {
      card.insertAdjacentHTML('beforeend',
        '<div class="hint" style="margin-top:8px">取得中: ' +
        esc(notLoaded.map(function (b) { return b.short; }).join('・')) +
        '。見ている釣り場を先に取るため、他は後回しになります。</div>');
    }
    host.appendChild(card);
  }

  /** 釣り場の切り替え。アンサンブルはその場で取りにいく（30分キャッシュ付き）。 */
  function selectBoat(id) {
    if (!spotById(id) || id === state.boatSpot) {
      renderMatrix(); renderBoatPicker(); renderStrip(); renderDetail();
      return;
    }
    state.boatSpot = id;
    store.set(BOAT_SPOT_KEY, id);
    var spot = currentBoat();
    // 選んだ地点にその日付が無い場合に備えて、無ければ先頭日に寄せる
    var res = state.results[id];
    if (res && res.length && !res.some(function (r) { return r.date === state.selectedDate; })) {
      state.selectedDate = res[0].date;
    }
    renderMatrix(); renderBoatPicker(); renderStrip(); renderDetail();
    renderEnsemble(); renderOfficialPanel(); renderCoverageNote();
    if (spot && !state.ensembles[spot.id]) {
      loadEnsemble(spot).then(function () { renderEnsemble(); renderDetail(); showErrors(); });
    }
  }

  /** 釣り場セレクタ。地域でまとめるので、増えても縦に伸びるだけで済む。 */
  function renderBoatPicker() {
    var host = $('#boat-picker');
    if (!host) return;
    host.innerHTML = '';
    if (BOATS.length < 2) return;

    var box = el('div', 'picker');
    REGIONS.forEach(function (rg) {
      var inRegion = BOATS.filter(function (b) { return b.region === rg.id; });
      if (!inRegion.length) return;
      var grp = el('div', 'picker-group');
      grp.appendChild(el('span', 'picker-label', rg.name));
      inRegion.forEach(function (spot) {
        var btn = el('button', 'chip' + (spot.id === state.boatSpot ? ' is-on' : ''));
        btn.type = 'button';
        btn.setAttribute('aria-pressed', String(spot.id === state.boatSpot));
        var n = overrideCount(spot);
        btn.innerHTML = esc(spot.short) +
          (n ? '<span class="pill" title="この釣り場だけの設定が' + n + '項目あります">設定' + n + '</span>' : '');
        btn.addEventListener('click', function () { selectBoat(spot.id); });
        grp.appendChild(btn);
      });
      box.appendChild(grp);
    });
    host.appendChild(box);
  }

  function renderWindows() {
    var host = $('#windows');
    host.innerHTML = '';
    var results = boatResults();
    if (!results) return;

    host.appendChild(periodPicker('boat'));

    var wins = R.findCalmWindows(results, { minGrade: 2, minLen: 2 });
    var head = el('h2', null, '出船候補（2日以上つづく凪）');
    head.style.fontSize = '.95rem';
    head.style.margin = '0 0 8px';
    host.appendChild(head);

    if (!wins.length) {
      var n = el('div', 'notice warn');
      n.innerHTML = '向こう16日間に「2日連続で出船可（○以上）」の並びはありません。' +
        '<div class="muted" style="margin-top:4px">しきい値は設定タブで変更できます。</div>';
      host.appendChild(n);
      renderSingles(host, results, {});
      return;
    }

    var solid = wins.filter(function (w) { return !w.windOnly; });
    if (!solid.length) {
      var w1 = el('div', 'notice warn');
      w1.innerHTML = '<b>波浪予報のある8日以内には、2日連続の候補がありません。</b>' +
        '以下は9日目以降の、風だけから見た参考候補です。波高が分かっていないので ◎ は付きません。' +
        '<div style="margin-top:4px">先の予報ほど各モデルの値は平均に寄るため、遠い日はどうしても穏やかに見えます。' +
        '長い連続日数そのものを根拠にせず、8日以内に入って波高が出てから確定してください。</div>';
      host.appendChild(w1);
    } else if (solid.length < wins.length) {
      var w2 = el('div', 'muted');
      w2.style.marginBottom = '10px';
      w2.textContent = '波浪予報がある候補を先に並べています。「波高データなし」の候補は風だけの参考値です。';
      host.appendChild(w2);
    }

    var grid = el('div', 'windows');
    wins.slice(0, 3).forEach(function (w) {
      var card = el('button', 'window-card rank-' + (w.minGrade >= 3 ? 'good' : 'fair'));
      card.type = 'button';

      var winds = w.days.map(function (d) { return d.metrics.maxWind; }).filter(isNum);
      var waves = w.days.map(function (d) { return d.metrics.maxWave; }).filter(isNum);
      var ranges = w.days.map(function (d) { return d.tide ? d.tide.range : null; }).filter(isNum);
      var pLabel = w.days[0].window.label;

      // 日数が増えると1日ずつ並べても読めないので、要約する。
      // モデル一致度は窓の中で最も低い日を出す（一番信用できない日が判断を決めるため）。
      var worst = w.days.reduce(function (acc, d) {
        return CONF_RANK[d.confidence.level] < CONF_RANK[acc.confidence.level] ? d : acc;
      }, w.days[0]);
      var phases = [];
      w.days.forEach(function (d) {
        var p = d.tide ? d.tide.phase : '—';
        if (phases[phases.length - 1] !== p) phases.push(p);
      });
      var phaseText = phases.length <= 2 ? phases.join(' → ') : phases[0] + ' 〜 ' + phases[phases.length - 1];

      card.innerHTML =
        '<div class="range">' + esc(dateLabel(w.start)) +
        (w.start === w.end ? '' : ' 〜 ' + esc(dateLabel(w.end))) +
        ' <span class="sub">' + w.length + (w.windOnly ? '日（風のみ）' : '日連続') + '</span></div>' +
        '<div style="margin-top:6px">' + gradeBadge(w.days[0]) + '</div>' +
        '<dl>' +
        '<dt>' + esc(pLabel) + 'の風</dt><dd>最大 ' + fmt(Math.max.apply(null, winds), 1) + ' m/s</dd>' +
        '<dt>' + esc(pLabel) + 'の波</dt><dd>' + (waves.length ? '最大 ' + fmt(Math.max.apply(null, waves), 2) + ' m' : 'データなし') + '</dd>' +
        '<dt>モデル一致</dt><dd>最低 ' + esc(worst.confidence.label) +
        '<span class="muted">（' + esc(dateLabel(worst.date)) + '）</span></dd>' +
        '<dt>潮回り</dt><dd>' + esc(phaseText) +
        (ranges.length ? ' <span class="muted">潮差 最大' + Math.round(Math.max.apply(null, ranges)) + 'cm</span>' : '') +
        '</dd>' +
        '</dl>' +
        (w.windOnly
          ? '<div class="badges"><span class="badge warn">波高データなし・風のみ判定</span>' +
            (w.length >= 4 ? '<span class="badge warn">長期予報は穏やかに寄る</span>' : '') + '</div>'
          : '');

      card.addEventListener('click', function () {
        state.selectedDate = w.start;
        renderStrip();
        renderDetail();
        var d = $('#detail');
        if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      grid.appendChild(card);
    });
    host.appendChild(grid);

    var solidDates = {};
    solid.forEach(function (w) { w.days.forEach(function (d) { solidDates[d.date] = true; }); });
    renderSingles(host, results, solidDates);
  }

  /**
   * 波浪予報のある期間の単日候補。連続日を優先する方針だが、
   * 波高まで揃っている単日のほうが「8日先の風だけの連続 ○」より確実に行動できるので必ず見せる。
   */
  function renderSingles(host, results, alreadyShown) {
    var singles = results.filter(function (r) {
      return r.grade !== null && r.grade >= 2 &&
        r.flags.indexOf('windOnly') < 0 && !alreadyShown[r.date];
    });
    if (!singles.length) return;
    // 良い順、同じなら近い日順
    singles.sort(function (a, b) {
      if (b.grade !== a.grade) return b.grade - a.grade;
      return a.date < b.date ? -1 : 1;
    });

    var sh = el('div', 'muted');
    sh.style.margin = '14px 0 6px';
    sh.textContent = '単日の候補（波浪予報のある期間。連続にはならないが波高まで分かっている日）';
    host.appendChild(sh);

    var srow = el('div', 'windows');
    singles.slice(0, 3).forEach(function (r) {
      var c = el('button', 'window-card rank-' + (r.grade >= 3 ? 'good' : 'fair'));
      c.type = 'button';
      c.innerHTML =
        '<div class="range">' + esc(dateLabel(r.date)) + '</div>' +
        '<div style="margin-top:6px">' + gradeBadge(r) + '</div>' +
        '<dl>' +
        '<dt>' + esc(r.window.label) + 'の風</dt><dd>最大 ' + fmt(r.metrics.maxWind, 1) + ' m/s</dd>' +
        '<dt>' + esc(r.window.label) + 'の波</dt><dd>最大 ' + fmt(r.metrics.maxWave, 2) + ' m</dd>' +
        '<dt>モデル一致</dt><dd>' + esc(r.confidence.label) + '</dd>' +
        '<dt>潮回り</dt><dd>' + (r.tide ? esc(r.tide.phase) +
          ' <span class="muted">潮差' + Math.round(r.tide.range) + 'cm</span>' : '—') + '</dd>' +
        '</dl>' + badgesHtml(r);
      c.addEventListener('click', function () {
        state.selectedDate = r.date;
        renderStrip();
        renderDetail();
        $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      srow.appendChild(c);
    });
    host.appendChild(srow);
  }

  function renderStrip() {
    var host = $('#strip');
    host.innerHTML = '';
    var results = boatResults();
    if (!results) return;

    var h = el('h2', null, '16日間');
    h.style.fontSize = '.95rem';
    h.style.margin = '0 0 6px';
    host.appendChild(h);

    var strip = el('div', 'strip');
    results.forEach(function (res) {
      var d = TIDE.parseDateKey(res.date);
      var gi = res.gradeInfo || R.NO_DATA;
      var b = el('button', 'day');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(res.date === state.selectedDate));
      var dowCls = d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : '';
      b.innerHTML =
        '<div class="dow ' + dowCls + '">' + DOW[d.getDay()] + '</div>' +
        '<div class="md">' + (d.getMonth() + 1) + '/' + d.getDate() + '</div>' +
        '<div class="sym grade-' + gi.key + '" title="' + esc(gi.label) + '">' + gi.symbol + '</div>' +
        weatherCell(res) +
        '<div class="v">' + fmt(res.metrics.maxWind, 1) + 'm/s</div>' +
        '<div class="v">' + (isNum(res.metrics.maxWave) ? fmt(res.metrics.maxWave, 2) + 'm' : '波—') + '</div>' +
        '<div class="dot">' + (res.tide ? esc(res.tide.phase) : '') + '</div>';
      b.addEventListener('click', function () {
        state.selectedDate = res.date;
        renderStrip();
        renderDetail();
      });
      strip.appendChild(b);
    });
    host.appendChild(strip);

    var legend = el('div', 'muted');
    var pl = R.PERIODS[state.period.boat].label;
    legend.textContent = '◎出船適 ／ ○出船可 ／ △要注意 ／ ×出船不可（' + pl + '帯の最悪値で判定）。' +
      '天気マークと％、風速・波高はいずれも' + pl + '帯の値（％は降水確率、50%以上は赤）。';
    host.appendChild(legend);
  }

  function renderDetail() {
    var host = $('#detail');
    host.innerHTML = '';
    var results = boatResults();
    var bundle = boatBundle();
    if (!results || !bundle) return;

    var date = state.selectedDate || results[0].date;
    var res = results.filter(function (r) { return r.date === date; })[0];
    if (!res) return;

    var hours = bundle.hours[date];
    var daily = res.daily;

    var card = el('div', 'card');

    // --- ヘッダ
    var head = el('div');
    head.innerHTML =
      '<h2 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
      esc(dateLabel(date)) + ' ' + esc(currentBoat() ? currentBoat().name : '') + ' ' + gradeBadge(res) +
      '<span class="sub">モデル一致度 ' + esc(res.confidence.label) +
      (isNum(res.confidence.sd) ? '（風速のばらつき ±' + fmt(res.confidence.sd, 2) + ' m/s）' : '') +
      '</span></h2>';
    card.appendChild(head);
    card.insertAdjacentHTML('beforeend', badgesHtml(res));

    // --- 根拠
    var ul = el('ul', 'reasons');
    res.reasons.forEach(function (r) { ul.appendChild(el('li', null, r)); });
    card.appendChild(ul);

    // --- 気象庁と食い違うなら判定のすぐ下で言う。表まで下がらないと気づかないのでは遅い
    if (res.conflicts && res.conflicts.length) {
      var cf = el('div', 'notice warn');
      cf.style.marginTop = '10px';
      cf.innerHTML = '<b>気象庁の公式予報と食い違っています</b><ul class="reasons">' +
        res.conflicts.map(function (c) { return '<li>' + esc(c.text) + '</li>'; }).join('') + '</ul>';
      card.appendChild(cf);
    }
    if (res.official && (res.official.wind || res.official.wave)) {
      var od = el('dl', 'kv');
      od.innerHTML =
        '<dt>気象庁の風</dt><dd>' + esc(res.official.wind || '—') + '</dd>' +
        '<dt>気象庁の沿岸波高</dt><dd>' + esc(res.official.wave || '—') + '</dd>';
      card.appendChild(od);
    }

    // --- サマリ
    var w = weatherOf(daily.weatherCode);
    var tide = res.tide;
    var mazume = tide ? TIDE.extremesInWindow(tide, res.window.from, res.window.to) : [];
    var trend = tide ? TIDE.tideTrend(bundle.spot.tide, date, res.window.from, res.window.to) : null;
    var mw = weatherOf(res.metrics.weatherCode);
    var kv = el('dl', 'kv');
    kv.innerHTML =
      '<dt>' + esc(res.window.label) + 'の天気</dt><dd>' + mw[1] + ' ' + esc(mw[0]) +
      '（降水確率 最大 ' + (isNum(res.metrics.maxPrecipProb) ? res.metrics.maxPrecipProb + '%' : '—') + '）</dd>' +
      '<dt>その日全体</dt><dd class="sub">' + w[1] + ' ' + esc(w[0]) +
      '（降水確率 最大 ' + (isNum(daily.precipMax) ? daily.precipMax + '%' : '—') + '）</dd>' +
      '<dt>気温</dt><dd>' + fmt(daily.tMin, 1) + '〜' + fmt(daily.tMax, 1) + ' ℃</dd>' +
      '<dt>日の出/日の入</dt><dd>' + daily.sunriseText + ' / ' + daily.sunsetText + '</dd>' +
      '<dt>判定時間帯</dt><dd>' + decimalToHHMM(res.window.from) + '〜' + decimalToHHMM(res.window.to) + '（' + esc(res.window.label) + '）</dd>' +
      '<dt>' + esc(res.window.label) + 'の風向</dt><dd>' + (res.metrics.dirName ? esc(res.metrics.dirName) + '（' + res.metrics.dirDeg + '°）' : '—') + '</dd>' +
      (tide
        ? '<dt>潮回り</dt><dd>' + esc(tide.phase) + '　潮差 ' + Math.round(tide.range) + ' cm　月齢 ' + tide.moonAge + '</dd>' +
          '<dt>満潮</dt><dd>' + (tide.highs.map(function (e) { return e.time + '（' + e.level + 'cm）'; }).join('　') || '—') + '</dd>' +
          '<dt>干潮</dt><dd>' + (tide.lows.map(function (e) { return e.time + '（' + e.level + 'cm）'; }).join('　') || '—') + '</dd>' +
          '<dt>' + esc(res.window.label) + 'の潮</dt><dd>' + (trend ? (trend === '停滞' ? 'ほぼ動かない' : trend + '潮') : '—') +
            (mazume.length ? '　<span class="muted">窓内に' + mazume.map(function (m) { return m.kind + ' ' + m.time; }).join('・') + '</span>' : '') +
          '</dd>'
        : '<dt>潮汐</dt><dd>この日のデータがありません</dd>');
    card.appendChild(kv);

    // --- チャート
    var chartHost = el('div');
    var charts = [];

    var band = { from: res.window.from, to: res.window.to };
    var markers = [];
    if (isNum(daily.sunrise)) markers.push({ hour: daily.sunrise, label: '日の出' });
    if (isNum(daily.sunset)) markers.push({ hour: daily.sunset, label: '日の入' });

    // 風（m/s のみ。波と混ぜない）
    var windSeries;
    if (state.showModels) {
      windSeries = MODELS.map(function (m) {
        return {
          label: m.label, color: m.color, thin: true,
          values: hours.map(function (r) { return isNum(r.wind[m.id]) ? r.wind[m.id] : null; })
        };
      });
    } else {
      // グラフの線は判定に使っている代表値と同じ取り方にする。
      // 別々だと「グラフは穏やかなのに × が付く」ことになり、根拠を追えなくなる。
      var aggInfo = R.MODEL_AGG[state.settings.modelAgg] || R.MODEL_AGG.median;
      windSeries = [
        {
          label: '風速（4モデルの' + aggInfo.label + '）', color: 'var(--s1)',
          values: hours.map(function (r) {
            return R.combineModels(Object.keys(r.wind).map(function (k) { return r.wind[k]; }), state.settings.modelAgg);
          })
        },
        {
          label: '最大瞬間', color: 'var(--s2)', dash: true,
          values: hours.map(function (r) {
            return R.combineModels(Object.keys(r.gust).map(function (k) { return r.gust[k]; }), state.settings.modelAgg);
          })
        }
      ];
    }
    var windChart = lineChart({
      title: '風速の推移', unit: ' m/s', decimals: 1, height: 150,
      series: windSeries, band: band, markers: markers,
      thresholds: state.showModels
        ? [{ value: state.settings.goodWind, label: '◎ ' + state.settings.goodWind }]
        : [
            { value: state.settings.goodWind, label: '◎ ' + state.settings.goodWind + ' m/s' },
            { value: state.settings.fairWind, label: '× ' + state.settings.fairWind + ' m/s' }
          ]
    });
    charts.push(windChart);
    chartHost.insertAdjacentHTML('beforeend',
      '<h3 style="font-size:.85rem;margin:14px 0 2px">風速 <span class="muted">m/s</span></h3>');
    chartHost.insertAdjacentHTML('beforeend', legendHtml(windChart.series));
    chartHost.insertAdjacentHTML('beforeend', '<div class="chart-wrap">' + windChart.svg + '</div>');

    // アンサンブル（51本のばらつき）。決定論の4モデルとは意味が違うので別パネルにする。
    var ens = currentEnsemble();
    var bands = ens ? FF.ensemble.hourlyBands(ens, res.date) : null;
    if (bands && bands.p50.some(isNum)) {
      var ensChart = lineChart({
        title: 'アンサンブルのばらつき', unit: ' m/s', decimals: 1, height: 140,
        ribbon: { upper: bands.p90, lower: bands.p10, color: 'var(--s1)' },
        series: [
          { label: '中央値（51本）', color: 'var(--s1)', values: bands.p50 },
          { label: '最も強い1本', color: 'var(--s2)', dash: true, values: bands.max }
        ],
        band: band, markers: markers,
        thresholds: [
          { value: state.settings.goodWind, label: '◎ ' + state.settings.goodWind + ' m/s' },
          { value: state.settings.fairWind, label: '× ' + state.settings.fairWind + ' m/s' }
        ]
      });
      charts.push(ensChart);
      chartHost.insertAdjacentHTML('beforeend',
        '<h3 style="font-size:.85rem;margin:14px 0 2px">アンサンブルのばらつき <span class="muted">m/s</span></h3>' +
        '<div class="hint" style="margin-bottom:4px">帯は51本のうち中央8割が収まる範囲。' +
        '帯が広い時間帯ほど「まだ決まっていない」。破線は最も強い1本で、最悪の場合の目安。</div>');
      chartHost.insertAdjacentHTML('beforeend', legendHtml(ensChart.series));
      chartHost.insertAdjacentHTML('beforeend', '<div class="chart-wrap">' + ensChart.svg + '</div>');
    }

    // 波（m のみ）
    var waveSeries = [
      { label: '有義波高', color: 'var(--s1)', area: true, values: hours.map(function (r) { return r.wave; }) },
      { label: 'うねり', color: 'var(--s3)', dash: true, values: hours.map(function (r) { return r.swellHeight; }) }
    ];
    var hasWave = waveSeries[0].values.some(isNum);
    var waveChart = lineChart({
      title: '波高の推移', unit: ' m', decimals: 2, height: 130,
      series: waveSeries, band: band, markers: markers,
      thresholds: [
        { value: state.settings.goodWave, label: '◎ ' + state.settings.goodWave + ' m' },
        { value: state.settings.fairWave, label: '× ' + state.settings.fairWave + ' m' }
      ]
    });
    charts.push(waveChart);
    chartHost.insertAdjacentHTML('beforeend',
      '<h3 style="font-size:.85rem;margin:14px 0 2px">波高 <span class="muted">m</span>' +
      (hasWave ? '' : ' <span class="badge warn">この日の波浪予報は存在しません（8日先まで）</span>') + '</h3>');
    if (hasWave) chartHost.insertAdjacentHTML('beforeend', legendHtml(waveChart.series));
    chartHost.insertAdjacentHTML('beforeend', '<div class="chart-wrap">' + waveChart.svg + '</div>');

    // 潮位（cm のみ）
    if (tide) {
      var tideMarkers = markers.concat(
        tide.highs.map(function (e) { return { hour: e.hour, label: '満' }; }),
        tide.lows.map(function (e) { return { hour: e.hour, label: '干' }; })
      );
      var tideChart = lineChart({
        title: '潮位の推移', unit: ' cm', decimals: 0, height: 120,
        series: [{ label: '潮位', color: 'var(--s1)', area: true, values: tide.hourly.slice() }],
        band: band, markers: tideMarkers,
        yMin: Math.min.apply(null, tide.hourly) - 10,
        yMax: Math.max.apply(null, tide.hourly) + 10
      });
      charts.push(tideChart);
      chartHost.insertAdjacentHTML('beforeend',
        '<h3 style="font-size:.85rem;margin:14px 0 2px">潮位（気象庁 ' +
      esc(TIDE.STATION_NAMES[currentBoat() ? currentBoat().tide : ''] || '') + '）<span class="muted"> cm</span></h3>');
      chartHost.insertAdjacentHTML('beforeend', '<div class="chart-wrap">' + tideChart.svg + '</div>');
    }

    card.appendChild(chartHost);

    // --- モデル比較
    var toggle = el('button', null, state.showModels ? 'モデル比較を閉じる' : 'モデル比較を開く');
    toggle.style.marginTop = '14px';
    toggle.addEventListener('click', function () {
      state.showModels = !state.showModels;
      renderDetail();
    });
    card.appendChild(toggle);

    if (state.showModels) {
      card.appendChild(modelTable(hours, res, daily));
    }

    host.appendChild(card);
    attachHover(chartHost, charts);
  }

  /** Windy でやっていた「モデルを見比べる」作業をテーブル1枚に置き換える。 */
  function modelTable(hours, res, daily) {
    var wrap = el('div', 'tbl-wrap');
    wrap.style.marginTop = '10px';
    var from = res.window.from, to = res.window.to;

    function windowStats(getter) {
      var vals = [];
      for (var h = 0; h < hours.length; h++) {
        if (h + 1 <= from || h >= to) continue;
        var v = getter(hours[h]);
        if (isNum(v)) vals.push(v);
      }
      if (!vals.length) return null;
      return { max: Math.max.apply(null, vals), min: Math.min.apply(null, vals) };
    }

    var rows = MODELS.map(function (m) {
      var w = windowStats(function (r) { return r.wind[m.id]; });
      var g = windowStats(function (r) { return r.gust[m.id]; });
      var dirs = [];
      for (var h = 0; h < hours.length; h++) {
        if (h + 1 <= from || h >= to) continue;
        if (isNum(hours[h].dir[m.id])) dirs.push(hours[h].dir[m.id]);
      }
      var deg = R.circularMeanDeg(dirs);
      return '<tr>' +
        '<td><span class="swatch" style="background:' + m.color + '"></span>' + esc(m.label) + '</td>' +
        '<td>' + (w ? fmt(w.min, 1) + '〜' + fmt(w.max, 1) : '—') + '</td>' +
        '<td>' + (g ? fmt(g.max, 1) : '—') + '</td>' +
        '<td>' + (isNum(deg) ? esc(R.dirName(deg)) + ' ' + Math.round(deg) + '°' : '—') + '</td>' +
        '<td>' + (w ? R.GRADES[R.levelFor(w.max, state.settings.goodWind, state.settings.fairWind)].symbol : '—') + '</td>' +
        '</tr>';
    }).join('');

    wrap.innerHTML =
      '<table><caption class="muted" style="text-align:left;padding:4px 0">' +
      esc(res.window.label) + '帯（' + decimalToHHMM(from) + '〜' + decimalToHHMM(to) + '）のモデル別の値' +
      '</caption><thead><tr>' +
      '<th>モデル</th><th>風速 m/s</th><th>最大瞬間</th><th>風向</th><th>単独判定</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="muted" style="margin-top:6px">' +
      'モデルがそろって同じ値を示すほど信頼できる。ばらついている日は直前に予報が変わる可能性が高い。' +
      '波浪は単一モデル（Open-Meteo best match）のためモデル比較の対象外。</div>';
    return wrap;
  }

  // ================================================================ 描画: 気象庁の公式予報

  var RELIABILITY_CLASS = { A: '', B: 'info', C: 'warn' };

  /**
   * 気象庁の公式予報を「第2の意見」として並べる。判定そのものは書き換えない。
   * 沿岸の波と海上の風は気象庁のほうが実務的なので、食い違いは目立たせる。
   */
  function renderOfficial(spotId, results) {
    var jma = state.jma[spotId];
    if (!jma) return null;

    var card = el('div', 'card');
    card.appendChild(el('h2', null, '他の予報との突き合わせ（気象庁・Yahoo天気）'));

    var lead = el('div', 'sub');
    lead.innerHTML = esc(jma.office || '気象庁') + ' 発表' +
      (jma.reportDatetime ? '（' + esc(jma.reportDatetime.slice(5, 16).replace('T', ' ')) + '）' +
        '<div class="muted">Yahoo天気や tenki.jp が配信しているのもこの予報です。' +
        '沿岸の波と海上の風は、全球25km格子のモデルより気象庁の予報区の値のほうが岸の実態に近いので、' +
        '食い違うときは気象庁側を重く見てください。</div>' : '');
    card.appendChild(lead);

    // --- 気象台の解説文。数値に出ない「なぜそうなるか」が書いてある
    if (jma.overview && (jma.overview.headline || jma.overview.text)) {
      var det = document.createElement('details');
      det.style.margin = '10px 0';
      var sum = document.createElement('summary');
      sum.style.cursor = 'pointer';
      sum.textContent = '気象台の解説文を読む';
      det.appendChild(sum);
      var body = el('div', 'sub');
      body.style.whiteSpace = 'pre-wrap';
      body.style.marginTop = '6px';
      body.textContent = (jma.overview.headline ? jma.overview.headline + '\n\n' : '') + jma.overview.text;
      det.appendChild(body);
      card.appendChild(det);
    }

    // --- 日別の突き合わせ表
    var hasYahoo = results.some(function (r) { return r.yahoo; });
    var rows = results.map(function (r) {
      var o = r.official;
      if (!o) return '';
      var rel = o.reliability
        ? '<span class="badge ' + RELIABILITY_CLASS[o.reliability] + '" title="' +
          esc(FF.jma.RELIABILITY_NOTE[o.reliability] || '') + '">' + o.reliability + '</span>'
        : '<span class="muted">—</span>';
      var y = r.yahoo;
      var yahooCells = hasYahoo
        ? '<td style="text-align:left">' +
            (y ? FF.yahoo.icon(y.weather) + ' ' + esc(y.weather || '—') : '<span class="muted">—</span>') + '</td>' +
          '<td>' + (y && isNum(y.pop) ? y.pop + '%' : '—') + '</td>'
        : '';
      return '<tr>' +
        '<td>' + esc(dateLabel(r.date)) + '</td>' +
        '<td style="text-align:left">' + FF.jma.icon(o.weatherCode) + ' ' + esc(o.weather || '—') + '</td>' +
        '<td style="text-align:left">' + esc(o.wind || '—') + '</td>' +
        '<td style="text-align:left">' + esc(o.wave || '—') + '</td>' +
        '<td>' + (isNum(r.dayMaxWave) ? fmt(r.dayMaxWave, 2) + ' m' : '—') + '</td>' +
        yahooCells +
        '<td>' + (isNum(o.pop) ? o.pop + '%' : '—') + '</td>' +
        '<td>' + (isNum(r.daily.precipMax) ? r.daily.precipMax + '%' : '—') + '</td>' +
        '<td>' + rel + '</td>' +
        '<td>' + esc(r.confidence.label) + '</td>' +
        '</tr>';
    }).filter(Boolean).join('');

    // 出所が交互に入れ替わる表なので、列グループ（colspan）にせず1行のヘッダに出所を書く。
    // グループ化するとどの列がどちらの値か取り違えやすい。
    var wrap = el('div', 'tbl-wrap');
    wrap.innerHTML =
      '<table><thead><tr>' +
      '<th>日付</th>' +
      '<th style="text-align:left">気象庁 天気</th>' +
      '<th style="text-align:left">気象庁 風</th>' +
      '<th style="text-align:left">気象庁 沿岸の波</th>' +
      '<th>モデル波高</th>' +
      (hasYahoo ? '<th style="text-align:left">Yahoo 天気</th><th>Yahoo 降水</th>' : '') +
      '<th>気象庁 降水</th><th>モデル降水</th>' +
      '<th>気象庁 確度</th><th>モデル一致度</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
    card.appendChild(wrap);

    var noteBits = [
      '気象庁の風・波・天気は3日先まで、週間（7日）は天気・降水確率・確度のみ。8日目以降は出ません。',
      '確度 A=高い / B=やや高い / C=低い。C の日は予報が変わりやすいので直前に見直してください。'
    ];
    if (hasYahoo) {
      var ySpot = currentBoat();
      var yp = ySpot && ySpot.yahoo ? FF.yahoo.point(ySpot.yahoo) : null;
      var cov = ySpot && ySpot.yahoo ? FF.yahoo.coverage(ySpot.yahoo) : null;
      noteBits.push('Yahoo天気は' + (yp ? yp.name : '') +'の週間予報（明後日から6日分）。' +
        (yp && yp.announced ? yp.announced.slice(5, 16).replace('T', ' ') + ' 発表、' : '') +
        '取得 ' + (FF.yahoo.fetchedAt() || '—').slice(5, 16).replace('T', ' ') + '。' +
        (cov ? cov.first.slice(5) + '〜' + cov.last.slice(5) + 'の' + cov.count + '日分。' : '') +
        '信頼度A〜Cと7日目以降はスマホアプリにしか無いため取得していません。');
    }
    if (jma.weeklyAreaName) {
      noteBits.push('週間予報と確度は' + jma.weeklyAreaName + '全体の値です（3日先までは' +
        (results[0] && results[0].official && results[0].official.areaName ?
          results[0].official.areaName : '予報区') + '単位）。');
    }
    card.appendChild(el('div', 'muted', noteBits.join(' ')));

    // --- 食い違いの明示
    var conflicts = results.filter(function (r) { return r.conflicts && r.conflicts.length; });
    if (conflicts.length) {
      var n = el('div', 'notice warn');
      n.style.marginTop = '10px';
      n.innerHTML = '<b>他の予報と食い違っている日</b><ul class="reasons">' +
        conflicts.map(function (r) {
          return r.conflicts.map(function (c) {
            return '<li>' + esc(dateLabel(r.date)) + '：' + esc(c.text) + '</li>';
          }).join('');
        }).join('') + '</ul>';
      card.appendChild(n);
    }

    return card;
  }

  function yahooLinks() {
    var d = el('div', 'muted');
    d.innerHTML = '原典をYahoo天気で確かめる： ' +
      YAHOO_LINKS.map(function (l) {
        return '<a href="' + l.url + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>';
      }).join(' ／ ') +
      '<br>アプリが取り込んでいるのはYahoo天気の週間予報（明後日から6日分）の天気・気温・降水確率です。' +
      '信頼度A〜Cと7日目以降はスマホアプリの中にしかないため、確度は気象庁の公式値（A/B/C・7日）を出しています。';
    return d;
  }

  // ================================================================ 描画: 東京湾タブ

  function renderShore() {
    var host = $('#shore-body');
    host.innerHTML = '';

    var spots = SPOTS.filter(function (s) { return s.kind === 'shore'; });
    var ready = spots.filter(function (s) { return state.results[s.id]; });
    if (!ready.length) return;

    var dates = state.results[ready[0].id].map(function (r) { return r.date; });
    if (!state.shoreDate || dates.indexOf(state.shoreDate) < 0) state.shoreDate = dates[0];

    // 時間帯と日付
    var chipCard = el('div', 'card');
    chipCard.appendChild(periodPicker('shore'));
    chipCard.appendChild(el('h2', null, '日付を選ぶ'));
    var chips = el('div', 'chips');
    dates.forEach(function (d) {
      var b = el('button', null, dateLabel(d));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(d === state.shoreDate));
      b.addEventListener('click', function () { state.shoreDate = d; renderShore(); });
      chips.appendChild(b);
    });
    chipCard.appendChild(chips);
    host.appendChild(chipCard);

    // 比較テーブル
    var cmp = el('div', 'card');
    cmp.appendChild(el('h2', null, dateLabel(state.shoreDate) + ' の5か所比較'));
    var note = el('div', 'muted');
    note.textContent = '陸っぱりなので風向ペナルティは適用していない。東京湾内の波高は約25km格子の推計値で、実際の岸壁の状況とは差が出る。判定は風・波・降水から。';
    cmp.appendChild(note);

    var periodLabel = R.PERIODS[state.period.shore].label;
    var rows = ready.map(function (spot) {
      var res = state.results[spot.id].filter(function (r) { return r.date === state.shoreDate; })[0];
      if (!res) return '';
      var gi = res.gradeInfo || R.NO_DATA;
      var t = res.tide;
      var trend = t ? TIDE.tideTrend(spot.tide, state.shoreDate, res.window.from, res.window.to) : null;
      var w = weatherOf(res.metrics.weatherCode);
      return '<tr>' +
        '<td>' + esc(spot.short) + '<div class="muted">' + esc(spot.target) + '</div></td>' +
        '<td><span class="grade grade-' + gi.key + '"><span class="sym">' + gi.symbol + '</span></span></td>' +
        '<td>' + fmt(res.metrics.maxWind, 1) + '</td>' +
        '<td>' + fmt(res.metrics.maxGust, 1) + '</td>' +
        '<td>' + (res.metrics.dirName ? esc(res.metrics.dirName) : '—') + '</td>' +
        '<td>' + fmt(res.metrics.maxWave, 2) + '</td>' +
        '<td>' + w[1] + ' ' + (isNum(res.metrics.maxPrecipProb) ? res.metrics.maxPrecipProb + '%' : '—') + '</td>' +
        '<td>' + (t ? esc(t.phase) + '<div class="muted">潮差' + Math.round(t.range) + 'cm</div>' : '—') + '</td>' +
        '<td>' + (t ? (t.highs.map(function (e) { return e.time; }).join(' ') || '—') : '—') + '</td>' +
        '<td>' + (t ? (t.lows.map(function (e) { return e.time; }).join(' ') || '—') : '—') + '</td>' +
        '<td>' + (trend ? trend : '—') + '</td>' +
        '</tr>';
    }).join('');

    var wrap = el('div', 'tbl-wrap');
    wrap.innerHTML =
      '<table><thead><tr>' +
      '<th>釣り場</th><th>' + esc(periodLabel) + '判定</th><th>風 m/s</th><th>突風</th><th>風向</th><th>波 m</th>' +
      '<th>天気/降水</th><th>潮回り</th><th>満潮</th><th>干潮</th><th>' + esc(periodLabel) + 'の潮</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
    cmp.appendChild(wrap);
    // 判定を色だけで伝えない。記号の意味をこのタブにも置く。
    cmp.appendChild(el('div', 'muted',
      '◎出船適 ／ ○出船可 ／ △要注意 ／ ×出船不可（日の出前後〜午前中の最悪値で判定）'));
    host.appendChild(cmp);

    // 東京都と神奈川県それぞれの気象庁公式予報。東京湾は湾内の波が湾外と大きく違うので、
    // 予報区単位の沿岸波高はモデル値より参考になる。
    var seen = {};
    ready.forEach(function (spot) {
      if (!spot.jma) return;
      var key = spot.jma.pref + '/' + spot.jma.area;
      if (seen[key]) return;
      seen[key] = true;
      var c = renderOfficial(spot.id, state.results[spot.id]);
      if (c) {
        c.insertBefore(el('div', 'muted', '対象: ' +
          ready.filter(function (s) { return s.jma && s.jma.pref + '/' + s.jma.area === key; })
            .map(function (s) { return s.short; }).join('・')), c.children[1]);
        host.appendChild(c);
      }
    });

    // 各所の16日ストリップ（コンパクト）
    ready.forEach(function (spot) {
      var c = el('div', 'card');
      var res16 = state.results[spot.id];
      c.appendChild(el('h2', null, spot.name));
      var strip = el('div', 'strip');
      res16.forEach(function (res) {
        var d = TIDE.parseDateKey(res.date);
        var gi = res.gradeInfo || R.NO_DATA;
        var b = el('button', 'day');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(res.date === state.shoreDate));
        var dowCls = d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : '';
        b.innerHTML =
          '<div class="dow ' + dowCls + '">' + DOW[d.getDay()] + '</div>' +
          '<div class="md">' + (d.getMonth() + 1) + '/' + d.getDate() + '</div>' +
          '<div class="sym grade-' + gi.key + '" title="' + esc(gi.label) + '">' + gi.symbol + '</div>' +
          weatherCell(res) +
          '<div class="v">' + fmt(res.metrics.maxWind, 1) + 'm/s</div>' +
          '<div class="dot">' + (res.tide ? esc(res.tide.phase) : '') + '</div>';
        b.addEventListener('click', function () { state.shoreDate = res.date; renderShore(); });
        strip.appendChild(b);
      });
      c.appendChild(strip);
      host.appendChild(c);
    });
  }

  // ================================================================ 描画: 設定タブ

  var SETTING_DEFS = [
    { key: 'goodWind', label: '◎ 出船適とする平均風速の上限', unit: ' m/s', min: 1, max: 10, step: .5 },
    { key: 'fairWind', label: '× 出船不可とする平均風速', unit: ' m/s', min: 2, max: 14, step: .5 },
    { key: 'goodGust', label: '◎ とする最大瞬間風速の上限', unit: ' m/s', min: 2, max: 16, step: .5 },
    { key: 'fairGust', label: '× とする最大瞬間風速', unit: ' m/s', min: 3, max: 20, step: .5 },
    { key: 'goodWave', label: '◎ とする有義波高の上限', unit: ' m', min: .1, max: 1.5, step: .05 },
    { key: 'fairWave', label: '× とする有義波高', unit: ' m', min: .2, max: 2.5, step: .05 },
    { key: 'swellPeriodWarn', label: '格下げするうねり周期', unit: ' s', min: 5, max: 14, step: .5,
      hint: 'この周期以上、かつ下のうねり高さ以上のとき1段階格下げ' },
    { key: 'swellHeightWarn', label: '格下げするうねり高さ', unit: ' m', min: .05, max: 1, step: .05 },
    { key: 'windowBeforeSunrise', label: '朝マヅメ帯の開始（日の出の何時間前）', unit: ' 時間', min: 0, max: 3, step: .5 },
    { key: 'windowAfterSunrise', label: '朝マヅメ帯の終了（日の出の何時間後）', unit: ' 時間', min: 1, max: 10, step: .5,
      hint: '「昼間」はこの終わりから、下の夕マヅメの始まりまでになります' },
    { key: 'windowBeforeSunset', label: '夕マヅメ帯の開始（日の入の何時間前）', unit: ' 時間', min: 1, max: 10, step: .5 },
    { key: 'windowAfterSunset', label: '夕マヅメ帯の終了（日の入の何時間後）', unit: ' 時間', min: 0, max: 3, step: .5 },
    { key: 'onshoreMinWind', label: '風向ペナルティを効かせ始める風速', unit: ' m/s', min: 0, max: 8, step: .5,
      hint: 'これ未満の弱い風なら岸向きでも格下げしない' },
    { key: 'afternoonRiseDelta', label: '午後の吹き上がり警告のしきい値', unit: ' m/s', min: 1, max: 10, step: .5 }
  ];

  /**
   * 4つのモデルの値を1つに束ねる方法を選ばせる。
   * 中央値は「最も確からしい値」だが、2馬力3mの船で効くのは外したときの荒れ方なので、
   * 荒天側に寄せて見たい日のために選択肢を出す。判定のされ方が根本から変わるので
   * しきい値より前に置く。
   */
  function renderAggCard(host) {
    var card = el('div', 'card');
    card.appendChild(el('h2', null, 'モデルの代表値の取り方'));
    card.appendChild(el('div', 'sub',
      '4つのモデルが違う値を出したとき、どれを判定に使うかを選びます。' +
      '風速と最大瞬間風速に効きます（波高は単一の予報しかないため変わりません）。'));

    var group = el('div', 'choices');
    R.MODEL_AGG_ORDER.forEach(function (key) {
      var info = R.MODEL_AGG[key];
      var id = 'agg-' + key;
      var lab = el('label', 'choice');
      lab.htmlFor = id;
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'modelAgg';
      input.id = id;
      input.value = key;
      input.checked = state.settings.modelAgg === key;
      input.addEventListener('change', function () {
        if (!input.checked) return;
        state.settings.modelAgg = key;
        saveSettings(state.settings);
        recomputeAll();
      });
      lab.appendChild(input);
      lab.insertAdjacentHTML('beforeend',
        '<span><b>' + esc(info.label) + '</b><br><span class="hint">' + esc(info.desc) + '</span></span>');
      group.appendChild(lab);
    });
    card.appendChild(group);
    card.insertAdjacentHTML('beforeend',
      '<div class="hint" style="margin-top:8px">' +
      'どれを選んでもモデルの一致度（ばらつき）は生の全モデルから測ります。' +
      '荒天側に寄せたせいで「予報が一致している」ように見えることはありません。</div>');
    host.appendChild(card);
  }

  /**
   * モデルの答え合わせ。
   *
   * 表示の原則: サンプルが足りないうちは順位を出さない。
   * 8件の平均で「ECMWFが最も当たる」と書けば、それは読んだ人を誤らせる。
   * 何件必要かを先に示し、足りないことをそのまま出す。
   */
  function renderVerifyCard(host) {
    if (!FF.verify || !FF.verify.available()) return;
    var V = FF.verify;
    var prog = V.progress();
    var st = V.station();
    var keys = V.seriesKeys();
    var bks = V.buckets();
    if (!keys.length || !bks.length) return;

    var card = el('div', 'card');
    card.appendChild(el('h2', null, 'モデルの答え合わせ'));
    card.insertAdjacentHTML('beforeend',
      '<div class="sub">予報と実測を毎日突き合わせています。実測は AMeDAS ' +
      esc(st ? st.name : '') + '（釣り場から約 ' + (st && st.distanceKm ? st.distanceKm : '—') +
      ' km の海岸）の10分平均風速で、朝マヅメ帯の最大値どうしを比べています。' +
      '<b>陸上の1点であって沖の海面ではありません。</b>モデル同士の相対比較には使えますが、絶対的な正解ではありません。</div>');

    // 進捗。「まだ言えない」を先に言う。
    var need = Math.max(0, prog.minUseful - prog.leadPairs);
    var note = el('div', 'notice' + (prog.enough ? '' : ' warn'));
    if (prog.enough) {
      note.innerHTML = '<b>リード別に ' + prog.leadPairs + ' 件たまりました。</b>' +
        '傾向を読み始められますが、季節が一巡するまでは冬型の成績が入りません。';
    } else {
      note.innerHTML = '<b>データ収集中です。あと約 ' + need + ' 件でリード別の比較を始められます。</b>' +
        '<div style="margin-top:4px">1日あたり15件ずつ記録し、その日が来て実測と揃った時点で1件になります。' +
        'いまの件数で順位を付けても偶然と区別がつかないため、順位はまだ出しません。</div>';
    }
    card.appendChild(note);

    // 表。MAE（平均どれだけ外したか）と bias（＋なら強めに予報する癖）。
    var head = ['<tr><th>予報</th>'];
    bks.forEach(function (b) { head.push('<th title="' + esc(b.desc) + '">' + esc(b.label) + '</th>'); });
    head.push('</tr>');

    var body = keys.map(function (m) {
      var tds = ['<td>' + esc(V.modelLabel(m)) + '</td>'];
      bks.forEach(function (b) {
        var c = V.cell(m, b.key);
        if (!c || !c.n) {
          tds.push('<td class="muted">—</td>');
          return;
        }
        var biasTxt = (c.bias > 0 ? '+' : '') + fmt(c.bias, 2);
        tds.push('<td>' + fmt(c.mae, 2) +
          '<span class="muted" style="font-size:.78em"> (' + biasTxt + ')<br>n=' + c.n + '</span></td>');
      });
      return '<tr>' + tds.join('') + '</tr>';
    }).join('');

    card.insertAdjacentHTML('beforeend',
      '<div class="tbl-wrap"><table><thead>' + head.join('') + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="hint" style="margin-top:6px">上段が平均絶対誤差（m/s、小さいほど当たる）、' +
      'かっこ内が偏り（＋は実際より強く予報する癖、−は弱く見積もる癖）。n は突き合わせ件数。</div>');

    // 直近の生データ。集計だけ見せると、数字がどこから来たか追えなくなる。
    var rec = V.recent();
    if (rec.length) {
      var rHead = ['<tr><th>日付</th><th>実測</th>'];
      var mKeys = keys.filter(function (k) { return k.indexOf('ens_') !== 0; });
      mKeys.forEach(function (m) { rHead.push('<th>' + esc(V.modelLabel(m)) + '</th>'); });
      rHead.push('</tr>');
      var rBody = rec.slice().reverse().map(function (row) {
        var tds = ['<td>' + esc(dateLabel(row.target)) + (row.src === 'archive' ? '<span class="muted">*</span>' : '') + '</td>',
          '<td><b>' + fmt(row.obs, 1) + '</b></td>'];
        mKeys.forEach(function (m) { tds.push('<td>' + fmt(row[m], 1) + '</td>'); });
        return '<tr>' + tds.join('') + '</tr>';
      }).join('');
      card.insertAdjacentHTML('beforeend',
        '<h3 style="font-size:.85rem;margin:14px 0 4px">直近の突き合わせ <span class="muted">m/s</span></h3>' +
        '<div class="tbl-wrap"><table><thead>' + rHead.join('') + '</thead><tbody>' + rBody + '</tbody></table></div>' +
        '<div class="hint" style="margin-top:6px">* は過去日をあとから取り寄せた短期予報です。' +
        'リード別の集計には入れていません。</div>');
    }

    card.insertAdjacentHTML('beforeend',
      '<div class="hint" style="margin-top:10px">' +
      '<b>重み付けをまだ入れていない理由。</b>ここに十分なデータが溜まるまで、' +
      'どのモデルを重く見るかは推測にしかなりません。溜まって明確な差が出たら、根拠を持って導入できます。' +
      (prog.updated ? ' 最終更新 ' + esc(String(prog.updated).slice(0, 16).replace('T', ' ')) : '') +
      '</div>');

    host.appendChild(card);
  }

  function renderSettings() {
    var host = $('#settings-body');
    host.innerHTML = '';

    renderAggCard(host);

    var card = el('div', 'card');
    card.appendChild(el('h2', null, '出船判定のしきい値'));
    var lead = el('div', 'sub');
    lead.textContent = '2馬力3mボートを前提にした保守的な初期値です。判定は選んだ時間帯の最悪値で行い、' +
      '◎と×の中間が○、×の直前が△になります。変更はこの端末のブラウザに保存されます。';
    card.appendChild(lead);

    // 編集対象。「全体」は全釣り場の土台で、釣り場を選ぶとその場所だけの上書きになる。
    // 海の条件は場所ごとに違うが、船は同じ1艇なので土台は共有したい、という考え方。
    var target = state.settingsTarget || 'global';
    if (target !== 'global' && !spotById(target)) target = 'global';
    var tabs = el('div', 'chips');
    var opts = [{ id: 'global', label: '全体' }].concat(BOATS.map(function (b) {
      return { id: b.id, label: b.short };
    }));
    opts.forEach(function (o) {
      var btn = el('button', 'chip' + (o.id === target ? ' is-on' : ''));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(o.id === target));
      var n = o.id === 'global' ? 0 : overrideCount(spotById(o.id));
      btn.innerHTML = esc(o.label) + (n ? '<span class="pill">' + n + '</span>' : '');
      btn.addEventListener('click', function () {
        state.settingsTarget = o.id;
        renderSettings();
      });
      tabs.appendChild(btn);
    });
    card.appendChild(tabs);

    var spot = target === 'global' ? null : spotById(target);
    var eff = spot ? thresholdsFor(spot) : state.settings;
    card.insertAdjacentHTML('beforeend', '<div class="hint" style="margin:2px 0 10px">' +
      (spot
        ? esc(spot.short) + 'だけの値を編集します。触っていない項目は全体の値をそのまま使います（「継承」）。'
        : 'すべての釣り場の土台になる値です。釣り場ごとに上書きした項目はそちらが優先されます。') +
      '</div>');

    SETTING_DEFS.forEach(function (def) {
      var over = spot ? (state.spotSettings[spot.id] || {}) : null;
      var isOver = !!(over && Object.prototype.hasOwnProperty.call(over, def.key));
      var cur = eff[def.key];

      var row = el('div', 'setting' + (isOver ? ' is-override' : ''));
      var lab = el('label', null, def.label);
      lab.htmlFor = 'set-' + def.key;
      var val = el('span', 'val', cur + def.unit);
      if (spot && !isOver) val.title = '全体の値を継承しています';
      var input = document.createElement('input');
      input.type = 'range';
      input.id = 'set-' + def.key;
      input.min = def.min; input.max = def.max; input.step = def.step;
      input.value = cur;
      input.addEventListener('input', function () {
        val.textContent = Number(input.value) + def.unit;
      });
      input.addEventListener('change', function () {
        var v = Number(input.value);
        if (spot) {
          state.spotSettings[spot.id] = state.spotSettings[spot.id] || {};
          state.spotSettings[spot.id][def.key] = v;
          saveSpotSettings(state.spotSettings);
        } else {
          state.settings[def.key] = v;
          saveSettings(state.settings);
        }
        renderSettings();
        recomputeAll();
      });
      row.appendChild(lab);
      row.appendChild(val);
      row.appendChild(input);
      if (spot) {
        row.appendChild(el('div', 'hint', isOver
          ? 'この釣り場だけの値（全体は ' + state.settings[def.key] + def.unit + '）'
          : '全体の値を継承中'));
      } else if (def.hint) {
        row.appendChild(el('div', 'hint', def.hint));
      }
      card.appendChild(row);
    });

    var reset = el('button', null, spot ? esc(spot.short) + 'の上書きを消して全体に戻す' : '初期値に戻す');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      if (spot) {
        delete state.spotSettings[spot.id];
        saveSpotSettings(state.spotSettings);
      } else {
        state.settings = Object.assign({}, R.DEFAULTS);
        saveSettings(state.settings);
      }
      renderSettings();
      recomputeAll();
    });
    card.appendChild(reset);
    host.appendChild(card);

    // 風向の扱いは釣り場ごとに違う。海岸の向きは利用者の好みではなく地形の事実なので、
    // 全体設定ではなく釣り場マスタ（profile）に持たせてある。ここはその一覧。
    var dirCard = el('div', 'card');
    dirCard.appendChild(el('h2', null, '風向の扱い（出船地点ごと）'));
    dirCard.insertAdjacentHTML('beforeend',
      '<div class="sub">岸に向かって吹く風は帰航が難しくなるため<b>1段階格下げ</b>、' +
      '沖へ流される陸風は<b>警告のみ</b>で判定は下げません。海岸の向きが違えば危険な風向も変わるので、' +
      '釣り場ごとに持っています。陸っぱりには適用しません。</div>');
    var dirTbl = el('table');
    var rows = '<thead><tr><th>釣り場</th><th>吹き付け風（格下げ）</th><th>沖出し（警告）</th></tr></thead><tbody>';
    BOATS.forEach(function (spot) {
      var t = thresholdsFor(spot);
      rows += '<tr><th class="sticky-col">' + esc(spot.short) + '</th>' +
        '<td>' + esc(R.dirName(t.onshoreFrom)) + '〜' + esc(R.dirName(t.onshoreTo)) +
        ' <span class="muted">(' + fmt(t.onshoreFrom, 1) + '°〜' + fmt(t.onshoreTo, 1) + '°)</span></td>' +
        '<td>' + esc(R.dirName(t.offshoreFrom)) + '〜' + esc(R.dirName(t.offshoreTo)) +
        ' <span class="muted">(' + fmt(t.offshoreFrom, 1) + '°〜' + fmt(t.offshoreTo, 1) + '°)</span></td></tr>';
    });
    dirTbl.innerHTML = rows + '</tbody>';
    var dirWrap = el('div', 'tbl-wrap');
    dirWrap.appendChild(dirTbl);
    dirCard.appendChild(dirWrap);
    dirCard.insertAdjacentHTML('beforeend',
      '<div class="hint" style="margin-top:8px">風速が ' + fmt(state.settings.onshoreMinWind, 1) +
      ' m/s 未満のときは向きを問いません。弱ければどちらから吹いても帰れるためです。</div>');
    host.appendChild(dirCard);

    renderVerifyCard(host);

    // データの限界
    var limitCard = el('div', 'card');
    limitCard.appendChild(el('h2', null, 'このアプリのデータの限界'));
    limitCard.insertAdjacentHTML('beforeend',
      '<ul class="reasons">' +
      '<li><b>波高は8日先までしか存在しません。</b>9日目以降は風だけの暫定判定で、「波高データなし」バッジが付きます。' +
      'それを波が穏やかである根拠にはできません。</li>' +
      '<li>東京湾内の波高は約25km格子の推計値です。湾内の実際の波は地形と船の航跡に強く左右されるので参考程度に。</li>' +
      '<li>潮汐は気象庁の潮位表（天文潮位）です。気圧や風による偏差は含みません。</li>' +
      '<li>直江津は日本海側で潮差が30cm前後しかありません。大潮でも東京湾のようには動かないので、' +
      '潮回りの名前より実際の潮差(cm)を見てください。</li>' +
      '<li>最終判断は現地の海況と海上保安庁・気象庁の警報で行ってください。このアプリは候補日の絞り込み用です。</li>' +
      '</ul>');
    host.appendChild(limitCard);
  }

  // ================================================================ 起動

  function setStamp() {
    var stamp = $('#stamp');
    var bundles = Object.keys(state.bundles).map(function (k) { return state.bundles[k]; });
    if (!bundles.length) { stamp.textContent = ''; return; }
    var at = Math.min.apply(null, bundles.map(function (b) { return b.fetchedAt; }));
    var anyStale = bundles.some(function (b) { return b.stale; });
    var mins = Math.round((Date.now() - at) / 60000);
    var d = new Date(at);
    stamp.textContent = '更新 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) +
      (mins >= 1 ? '（' + mins + '分前）' : '') + (anyStale ? ' ⚠ 取得失敗・キャッシュ表示' : '');
    stamp.className = 'stamp' + (anyStale || mins > 180 ? ' stale' : '');
  }

  /**
   * 選択中の釣り場のアンサンブルを取りにいく。
   * 取得済み・取得中なら何もしない。失敗しても本体の判定は止めない。
   */
  function loadEnsemble(spot) {
    if (!spot || !FF.ensemble) return Promise.resolve();
    if (state.ensembles[spot.id]) return Promise.resolve();
    if (state.ensembleLoading === spot.id) return Promise.resolve();
    state.ensembleLoading = spot.id;
    return fetchJson(FF.ensemble.url(spot.lat, spot.lon, 16)).then(
      function (r) {
        state.ensembles[spot.id] = FF.ensemble.parse(r.json);
        state.ensembleLoading = null;
      },
      function (err) {
        state.ensembleLoading = null;
        // アンサンブルは追加情報なので、落ちても本体の判定は続ける
        state.errors.push(spot.short + ': アンサンブル予報を取得できませんでした（' +
          (err && err.message ? err.message : err) + '）。4モデルの比較のみ表示します。');
      }
    );
  }

  function recomputeAll() {
    SPOTS.forEach(function (s) {
      if (state.bundles[s.id]) state.results[s.id] = evaluateBundle(state.bundles[s.id], thresholdsFor(s));
    });
    renderMatrix();
    renderBoatPicker();
    renderWindows();
    renderStrip();
    renderDetail();
    renderEnsemble();
    renderOfficialPanel();
    renderShore();
    renderManual();
    setStamp();
  }

  function renderManual() {
    // しきい値や時間帯を変えたら説明も追従させる（説明だけ古くなるのを防ぐ）
    if (FF.manual) FF.manual.render($('#manual-body'), state.settings, state.period);
  }

  /**
   * アンサンブル51本の内訳を日ごとに帯で出す。
   *
   * ここが「モデルに重みを付けて中心を精密にする」より価値がある理由:
   * 中央値が 1.3 m/s でも、51本のうち5本が 8 m/s を出しているなら、
   * それは凪ではなく「凪かもしれない」。2馬力3mの船で効くのはその裾のほう。
   *
   * 内訳は風と突風だけで付けた等級であり、波・雷を含む本体の判定とは別物。
   * 混同すると波を無視した判断になるので、ラベルで必ず断る。
   */
  function renderEnsemble() {
    var host = $('#ensemble');
    if (!host) return;
    host.innerHTML = '';
    var results = boatResults();
    var ens = currentEnsemble();
    if (!results || !ens || !ens.members) return;

    var rows = [];
    var covered = 0;
    results.forEach(function (res) {
      if (!res.window || !isNum(res.window.from)) return;
      var s = FF.ensemble.daySummary(ens, res.date, res.window.from, res.window.to, state.settings);
      if (s) covered++;
      rows.push({ res: res, sum: s });
    });
    if (!covered) return;

    var card = el('div', 'card');
    var pLabel = results[0].window.label;
    card.appendChild(el('h2', null, 'アンサンブル予報（' + ens.members + '本の内訳）'));
    card.insertAdjacentHTML('beforeend',
      '<div class="sub">同じモデルを初期値を少しずつ変えて' + ens.members +
      '回走らせた結果です。' + esc(pLabel) + '帯で各本がどの判定になるかの割合を出しています。' +
      '<b>風と最大瞬間風速だけ</b>で付けた内訳で、波・雷は含みません（本体の判定とは別物です）。</div>');

    card.insertAdjacentHTML('beforeend',
      '<div class="legend ens-legend">' +
      '<span><i style="background:var(--good)"></i>◎ 出船適</span>' +
      '<span><i style="background:var(--warning)"></i>○ 出船可</span>' +
      '<span><i style="background:var(--serious)"></i>△ 要注意</span>' +
      '<span><i style="background:var(--critical)"></i>× 出船不可</span>' +
      '</div>');

    var list = el('div', 'ens-list');
    rows.forEach(function (row) {
      var s = row.sum;
      var btn = el('button', 'ens-row');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(row.res.date === state.selectedDate));

      if (!s) {
        btn.innerHTML =
          '<span class="ens-date">' + esc(dateLabel(row.res.date)) + '</span>' +
          '<span class="ens-bar empty"></span>' +
          '<span class="ens-num muted">対象外</span>';
      } else {
        var segs = [
          { pct: s.goodPct, cls: 'good', sym: '◎' },
          { pct: s.fairPct, cls: 'fair', sym: '○' },
          { pct: s.marginalPct, cls: 'marginal', sym: '△' },
          { pct: s.badPct, cls: 'bad', sym: '×' }
        ];
        var bar = segs.filter(function (g) { return g.pct > 0; }).map(function (g) {
          return '<span class="seg seg-' + g.cls + '" style="width:' + g.pct + '%" title="' +
            g.sym + ' ' + g.pct + '%"></span>';
        }).join('');
        // 数字は「中央値 / 最も強い1本」。裾が見えることがこの表示の主目的なので最大値は必ず出す。
        // × の割合は帯の赤い部分がそのまま示しているので、数字では繰り返さない
        // （同じことを2つの表現で出すと、狭い画面で行が入りきらなくなる）。
        btn.title = dateLabel(row.res.date) + '  ' + segs.map(function (g) {
          return g.sym + ' ' + g.pct + '%';
        }).join(' / ') + '（' + s.n + '本）';
        btn.innerHTML =
          '<span class="ens-date">' + esc(dateLabel(row.res.date)) + '</span>' +
          '<span class="ens-bar">' + bar + '</span>' +
          '<span class="ens-num">' + fmt(s.p50, 1) + '<span class="muted"> / </span>' +
          '<b class="' + (s.badPct >= 20 ? 'hot' : '') + '">' + fmt(s.max, 1) + '</b>' +
          '<span class="muted"> m/s</span></span>';
      }
      btn.addEventListener('click', function () {
        state.selectedDate = row.res.date;
        renderStrip();
        renderDetail();
        renderEnsemble();
        var d = $('#detail');
        if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      list.appendChild(btn);
    });
    card.appendChild(list);

    card.insertAdjacentHTML('beforeend',
      '<div class="hint" style="margin-top:8px">数字は判定帯の最大風速の「中央値 / 最も強い1本」（m/s）。' +
      '中央値が穏やかでも右の数字が大きい日は、まだ荒れる可能性が残っています。' +
      (ens.lastDate
        ? 'アンサンブルは ' + esc(dateLabel(ens.lastDate)) + ' まで。それ以降は4モデルの比較のみです。'
        : '') +
      '</div>');

    host.appendChild(card);
  }

  function renderOfficialPanel() {
    var host = $('#official');
    host.innerHTML = '';
    var results = boatResults();
    if (!results) return;
    var card = renderOfficial(currentBoat() ? currentBoat().id : null, results);
    if (card) host.appendChild(card);
    host.appendChild(yahooLinks());
  }

  function showErrors() {
    var host = $('#errors');
    host.innerHTML = '';
    if (!state.errors.length) return;
    var n = el('div', 'notice error');
    n.innerHTML = '<b>データを取得できなかった項目があります</b><ul class="reasons">' +
      state.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
    host.appendChild(n);
  }

  function load() {
    var btn = $('#refresh');
    btn.disabled = true;
    btn.textContent = '取得中…';
    state.errors = [];
    $('#loading').style.display = '';

    // 気象庁の公式予報。府県ごとに1回だけ取り、同じ府県の釣り場で使い回す。
    var byPref = {};
    SPOTS.forEach(function (s) {
      if (s.jma) (byPref[s.jma.pref + '/' + s.jma.area] = byPref[s.jma.pref + '/' + s.jma.area] || []).push(s);
    });
    var jmaJobs = Object.keys(byPref).map(function (key) {
      var parts = key.split('/');
      return FF.jma.load(parts[0], parts[1]).then(
        function (data) { byPref[key].forEach(function (s) { state.jma[s.id] = data; }); },
        function (err) {
          // 気象庁の bosai JSON は正式なAPIではないので落ちうる。本体の判定は続行する。
          state.errors.push('気象庁の公式予報を取得できませんでした（' +
            (err && err.message ? err.message : err) + '）。モデル値のみで表示します。');
        }
      );
    });

    // 取得の優先順位。Open-Meteo は「変数×日数×モデル×地点」で重み付けして制限するため、
    // 釣り場が増えるほど後ろが落ちやすい。落ちて困る順に並べる。
    //   1. いま見ている出船地点  2. 他の出船地点  3. 陸っぱり
    // 出船地点が10か所に増えても、この順序なら「見ている場所は必ず揃う」が保たれる。
    var sel = state.boatSpot;
    function priority(s) {
      if (s.id === sel) return 0;
      return s.kind === 'boat' ? 1 : 2;
    }
    var ordered = SPOTS.slice().sort(function (a, b) { return priority(a) - priority(b); });
    var spotJobs = ordered.map(function (spot) {
      return function () {
        return loadSpot(spot).then(
          function (bundle) {
            state.bundles[spot.id] = bundle;
            if (bundle.marineError) {
              state.errors.push(spot.short + ': 波浪データ ' + bundle.marineError);
            }
          },
          function (err) {
            state.errors.push(spot.short + ': ' + (err && err.message ? err.message : err));
          }
        );
      };
    });

    // アンサンブルは gzip で1地点あたり約50KB ある。出船地点が増えても取得量が
    // 増えないよう、いま見ている1か所だけを取る。釣り場を切り替えたときは
    // loadEnsemble() が改めて呼ばれる（30分キャッシュがあるので戻る操作は無料）。
    var selBoat = currentBoat();
    if (selBoat) {
      // 本体が揃わないうちに重い取得を始めないよう、選択地点の次に差し込む。
      spotJobs.splice(1, 0, function () { return loadEnsemble(selBoat); });
    }

    return Promise.all(jmaJobs.concat([throttled(spotJobs, 2)])).then(function () {
      $('#loading').style.display = 'none';
      btn.disabled = false;
      btn.textContent = '再取得';
      var cb = boatBundle();
      if (!state.selectedDate && cb) state.selectedDate = cb.dates[0];
      recomputeAll();
      showErrors();
      renderCoverageNote();
    });
  }

  function renderCoverageNote() {
    var host = $('#coverage');
    host.innerHTML = '';
    var b = boatBundle();
    if (!b) return;
    var spot = currentBoat();
    var bits = [];
    if (spot) bits.push(esc(spot.name) + '（潮汐: 気象庁 ' + (TIDE.STATION_NAMES[spot.tide] || spot.tide) + '）');
    if (b.waveLastDate) bits.push('波浪予報は ' + dateLabel(b.waveLastDate) + ' まで');
    if (b.marine) bits.push('波浪の格子点は釣り場から約 ' + b.marine.distanceKm.toFixed(1) + ' km');
    var cov = TIDE.coverage(spot ? spot.tide : 'T3');
    if (cov) {
      var lastNeeded = b.dates[b.dates.length - 1];
      if (lastNeeded > cov.last) {
        bits.push('⚠ 潮汐データが ' + cov.last + ' までしかありません（翌年分の生成が必要）');
      }
    }
    if (!bits.length) return;
    var n = el('div', 'muted');
    n.textContent = bits.join(' ／ ');
    host.appendChild(n);
  }

  function initTabs() {
    var buttons = document.querySelectorAll('nav.tabs button');

    function select(name, updateHash) {
      Array.prototype.forEach.call(buttons, function (o) {
        var on = o.dataset.tab === name;
        o.setAttribute('aria-selected', String(on));
        var sec = document.getElementById('tab-' + o.dataset.tab);
        if (sec) sec.hidden = !on;
      });
      // タブを URL に残しておくと、よく見るタブをスマホのホーム画面に置ける
      if (updateHash && global.history && global.history.replaceState) {
        global.history.replaceState(null, '', '#' + name);
      }
    }

    Array.prototype.forEach.call(buttons, function (b) {
      b.addEventListener('click', function () { select(b.dataset.tab, true); });
    });
    global.addEventListener('hashchange', function () {
      select((location.hash || '#boat').slice(1), false);
    });

    var initial = (location.hash || '').slice(1);
    if (initial && document.getElementById('tab-' + initial)) select(initial, false);
  }

  function initTheme() {
    var saved = store.get(THEME_KEY, null);
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    $('#theme').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var isDark = cur ? cur === 'dark'
        : global.matchMedia('(prefers-color-scheme: dark)').matches;
      var next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      store.set(THEME_KEY, next);
      renderDetail();
      renderShore();
    });
  }

  function boot() {
    if (!global.TIDE_DATA) {
      $('#errors').innerHTML =
        '<div class="notice error">潮汐データ（data/tide-YYYY.js）が読み込めていません。' +
        'tools/Build-Tide.ps1 を実行して生成してください。</div>';
    }
    initTabs();
    initTheme();
    renderSettings();
    renderManual();
    $('#refresh').addEventListener('click', function () {
      // 明示的な再取得ではキャッシュを捨てる
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(k);
      });
      load();
    });
    load();
    setInterval(setStamp, 60000);
  }

  FF.app = { SPOTS: SPOTS, MODELS: MODELS, state: state, boot: boot, lineChart: lineChart };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
