/*
 * ensemble.js - ECMWF アンサンブル予報（51本の「あり得た予報」）
 *
 * 決定論的な4モデル比較との役割の違い:
 *   4モデル比較は「別々の機関の予報がどれくらい割れているか」を見るもの。
 *   アンサンブルは同じモデルを初期値を少しずつ変えて51回走らせたもので、
 *   「大気の状態が少し違ったらどうなっていたか」の分布そのものが出る。
 *
 * これが要る理由は 2馬力3m のボートだから。中央値が 1.3 m/s でも、
 * 51本のうち数本が 8 m/s を出しているなら、それは「凪」ではなく「凪かもしれない」。
 * 決定論モデルを何本重み付けして平均しても、この裾は絶対に見えない。
 *
 * 注意:
 *   - 取れるのは風と突風だけ。波・天気・雷は含まれないので、
 *     ここで出す内訳は「風と突風だけで見たらどうなるか」であって本体の判定とは別物。
 *     必ずその旨をラベルに書くこと。混同すると波を無視した判断になる。
 *   - 期間は約15日。16日目は本体（GFS）にしか無い。
 *   - 51メンバー×2変数×384時間で gzip 約50KB。他のAPIより重いので、
 *     出船判断をする直江津の1地点だけに使う。東京湾の陸っぱりでは取らない。
 */
(function (global) {
  'use strict';

  var FF = (global.FF = global.FF || {});
  var R = FF.rating;

  var BASE = 'https://ensemble-api.open-meteo.com/v1/ensemble';

  // ECMWF IFS 0.25° は 51メンバー・約15日で、利用できるものの中で最も本数が多く最も先まで届く。
  // GFS(31本/10日) や ICON(40本/7日) も取れるが、期間が短く出船計画には届かない。
  var MODEL = 'ecmwf_ifs025';
  var MODEL_LABEL = 'ECMWF アンサンブル';

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function dayKey(iso) {
    return String(iso).slice(0, 10);
  }

  function hourOf(iso) {
    return Number(String(iso).slice(11, 13));
  }

  /**
   * 取得URL。fetch 自体は app.js の fetchJson に任せる
   * （キャッシュと 429 リトライを他のAPIと同じ扱いにするため）。
   */
  function url(lat, lon, days) {
    return BASE +
      '?latitude=' + lat + '&longitude=' + lon +
      '&hourly=wind_speed_10m,wind_gusts_10m' +
      '&models=' + MODEL +
      '&wind_speed_unit=ms&timezone=Asia%2FTokyo' +
      '&forecast_days=' + (days || 16);
  }

  function memberKeys(hourly, prefix) {
    var keys = [];
    Object.keys(hourly).forEach(function (k) {
      if (k === prefix || k.indexOf(prefix + '_member') === 0) keys.push(k);
    });
    // member01, member02 ... の順に揃える。制御ラン（添字なし）が先頭。
    keys.sort();
    return keys;
  }

  /**
   * 日付→時刻→メンバー配列 の形に整える。
   * メンバーごとの並びは崩さないこと。時刻ごとに独立して分位を取ると
   * 「どのメンバーでも起こらない、つぎはぎの1日」を作ってしまう。
   */
  function parse(json) {
    if (json && json.error) throw new Error(json.reason || 'ensemble error');
    var h = (json && json.hourly) || {};
    var time = h.time || [];
    var windKeys = memberKeys(h, 'wind_speed_10m');
    var gustKeys = memberKeys(h, 'wind_gusts_10m');

    var days = {};
    var lastDate = null;

    for (var i = 0; i < time.length; i++) {
      var date = dayKey(time[i]);
      var hr = hourOf(time[i]);
      var wind = [];
      var gust = [];
      var any = false;
      for (var m = 0; m < windKeys.length; m++) {
        var wv = h[windKeys[m]][i];
        wind.push(isNum(wv) ? wv : null);
        if (isNum(wv)) any = true;
        var gk = gustKeys[m];
        var gv = gk ? h[gk][i] : null;
        gust.push(isNum(gv) ? gv : null);
      }
      if (!any) continue;
      if (!days[date]) days[date] = { date: date, hours: {} };
      days[date].hours[hr] = { wind: wind, gust: gust };
      lastDate = date;
    }

    return {
      model: MODEL,
      label: MODEL_LABEL,
      members: windKeys.length,
      days: days,
      lastDate: lastDate,
      dates: Object.keys(days).sort()
    };
  }

  /**
   * メンバーごとに判定窓の中の最悪値を取る。
   * 「窓の中の最悪値」を先に取ってから分位を計算する順番が重要。
   * 先に時刻ごとの分位を取ると、朝は A メンバー・昼は B メンバーという
   * 実在しない最悪シナリオが出来上がってしまう。
   *
   * @returns {Array<{wind:number|null, gust:number|null}>} メンバー数ぶん
   */
  function memberWorst(dayData, from, to) {
    if (!dayData) return [];
    var hours = Object.keys(dayData.hours);
    var n = 0;
    hours.forEach(function (k) { n = Math.max(n, dayData.hours[k].wind.length); });
    var out = [];
    for (var m = 0; m < n; m++) out.push({ wind: null, gust: null });

    hours.forEach(function (key) {
      var hr = Number(key);
      // 判定窓に少しでもかかる整数時を対象にする（evaluateDay と同じ扱い）
      if (hr + 1 <= from || hr >= to) return;
      var rec = dayData.hours[key];
      for (var m2 = 0; m2 < n; m2++) {
        var w = rec.wind[m2];
        if (isNum(w) && (out[m2].wind === null || w > out[m2].wind)) out[m2].wind = w;
        var g = rec.gust[m2];
        if (isNum(g) && (out[m2].gust === null || g > out[m2].gust)) out[m2].gust = g;
      }
    });
    return out;
  }

  /**
   * 1日ぶんの分布をまとめる。
   *
   * @param bundle load() の戻り
   * @param date   'YYYY-MM-DD'
   * @param from,to 判定窓（小数時）
   * @param T      しきい値（R.DEFAULTS を上書きしたもの）
   */
  function daySummary(bundle, date, from, to, T) {
    if (!bundle || !bundle.days[date]) return null;
    var worst = memberWorst(bundle.days[date], from, to);
    var winds = [];
    var counts = [0, 0, 0, 0]; // index = grade
    var graded = 0;

    for (var i = 0; i < worst.length; i++) {
      var w = worst[i].wind;
      if (!isNum(w)) continue;
      winds.push(w);
      // 風と突風だけで見た等級。波・雷は含まれないので本体の判定とは別物。
      var lv = [R.levelFor(w, T.goodWind, T.fairWind)];
      if (isNum(worst[i].gust)) lv.push(R.levelFor(worst[i].gust, T.goodGust, T.fairGust));
      var g = Math.min.apply(null, lv);
      counts[g]++;
      graded++;
    }
    if (!winds.length) return null;

    var pct = function (n) { return graded ? Math.round((n / graded) * 100) : 0; };

    return {
      date: date,
      n: graded,
      p10: R.percentile(winds, 0.10),
      p50: R.percentile(winds, 0.50),
      p90: R.percentile(winds, 0.90),
      min: Math.min.apply(null, winds),
      max: Math.max.apply(null, winds),
      counts: counts,
      // 「51本のうち何%が出船不可を示すか」。これが本命の出力。
      badPct: pct(counts[0]),
      marginalPct: pct(counts[1]),
      fairPct: pct(counts[2]),
      goodPct: pct(counts[3]),
      // ○以上（＝出せる見込み）の割合。候補日の並び替えに使う。
      okPct: pct(counts[2] + counts[3])
    };
  }

  /** 指定日の時刻ごとの分位。ファンチャート用。値が無い時刻は null を入れて位置を保つ。 */
  function hourlyBands(bundle, date) {
    if (!bundle || !bundle.days[date]) return null;
    var day = bundle.days[date];
    var p10 = [], p50 = [], p90 = [], mx = [];
    for (var hr = 0; hr < 24; hr++) {
      var rec = day.hours[hr];
      if (!rec) { p10.push(null); p50.push(null); p90.push(null); mx.push(null); continue; }
      var vals = rec.wind.filter(isNum);
      if (!vals.length) { p10.push(null); p50.push(null); p90.push(null); mx.push(null); continue; }
      p10.push(R.percentile(vals, 0.10));
      p50.push(R.percentile(vals, 0.50));
      p90.push(R.percentile(vals, 0.90));
      mx.push(Math.max.apply(null, vals));
    }
    return { p10: p10, p50: p50, p90: p90, max: mx };
  }

  FF.ensemble = {
    MODEL: MODEL,
    MODEL_LABEL: MODEL_LABEL,
    url: url,
    parse: parse,
    memberWorst: memberWorst,
    daySummary: daySummary,
    hourlyBands: hourlyBands
  };
})(typeof window !== 'undefined' ? window : globalThis);
