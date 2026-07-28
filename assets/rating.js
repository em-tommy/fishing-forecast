/*
 * rating.js - 出船可否スコアリングエンジン
 *
 * 純関数のみ。DOM にも fetch にも触らないので、tests.html から単体で検証できる。
 *
 * 判定は「朝マヅメ帯（日の出の1時間前〜4時間後）の最悪値」で決める。
 * 平均だと一瞬の突風や短時間のうねりを見落とすため、小型艇では最悪値を採る。
 */
(function (global) {
  'use strict';

  var FF = (global.FF = global.FF || {});

  var DEFAULTS = {
    // ◎ の上限
    goodWind: 4.0,   // m/s 平均風速
    goodGust: 7.0,   // m/s 最大瞬間
    goodWave: 0.30,  // m 有義波高
    // △ の上限（これを超えると ×）
    fairWind: 6.0,
    fairGust: 9.0,
    fairWave: 0.50,

    // うねり補正: 周期が長く、かつ一定の高さがあると数字以上に船が揺れる
    swellPeriodWarn: 8.0,   // s
    swellHeightWarn: 0.20,  // m

    // 吹き付け風（岸に向かって吹く＝帰航が危険）とみなす風向レンジ。
    // 直江津の海岸は北〜北北東向きで、日本海の北西季節風が最も危ない。
    onshoreFrom: 292.5,  // WNW
    onshoreTo: 67.5,     // ENE
    onshoreMinWind: 3.0, // これ未満の弱い風なら向きは問わない

    // 沖出し（陸風）注意。判定は下げず警告のみ。
    offshoreFrom: 112.5, // ESE
    offshoreTo: 247.5,   // WSW

    // 午後の吹き上がり警告のしきい値
    afternoonRiseDelta: 3.0, // m/s

    // 雷は小型艇では逃げ場がないので、他がどれだけ穏やかでも × にする
    thunderBlocks: true,

    // 朝マヅメ判定窓（日の出基準の時間オフセット）
    windowBeforeSunrise: 1,
    windowAfterSunrise: 4,
    // 夕マヅメ判定窓（日の入基準）。朝と対称に取る
    windowBeforeSunset: 4,
    windowAfterSunset: 1,

    // モデル一致度（風速の標準偏差 m/s）
    confidenceHigh: 1.0,
    confidenceMid: 2.0
  };

  var GRADES = {
    3: { symbol: '◎', label: '出船適', key: 'good' },
    2: { symbol: '○', label: '出船可', key: 'fair' },
    1: { symbol: '△', label: '要注意', key: 'marginal' },
    0: { symbol: '×', label: '出船不可', key: 'bad' }
  };

  var NO_DATA = { symbol: '—', label: 'データなし', key: 'none' };

  /**
   * 判定に付くバッジ。表示にも「使い方」の説明にもここを使う。
   * 説明文を別に持つとコードを直したときにマニュアルだけ古くなるため。
   *   tone: 'warn' 危険側の情報 / 'info' 参考情報 / '' 中立
   *   effect: 判定への影響
   */
  var FLAGS = {
    thunder: {
      label: '雷予報・出船不可', tone: 'warn', effect: '判定を × に固定',
      desc: '朝マヅメ帯に雷の予報がある日。風も波も穏やかでも × にする。小型艇は逃げ場がないため。'
    },
    windOnly: {
      label: '波高データなし・風のみ判定', tone: 'warn', effect: '判定の上限を ○ に制限',
      desc: '波浪予報は8日先までしか存在しない。9日目以降は風だけの暫定判定なので ◎ は付けない。' +
        'これを「波が穏やか」の根拠にはできない。'
    },
    longSwell: {
      label: '長周期うねり', tone: 'warn', effect: '1段階格下げ',
      desc: '周期が長く高さもあるうねりが入る日。波高の数字以上に3m艇は揺れる。'
    },
    onshore: {
      label: '吹き付け風（岸向き）', tone: 'warn', effect: '1段階格下げ',
      desc: '岸に向かって吹く風。うねりが立ちやすく帰航が難しくなる。直江津のみ適用し、陸っぱりでは見ない。'
    },
    offshore: {
      label: '沖出し注意', tone: 'info', effect: '判定は下げない',
      desc: '陸から海へ吹く風。海面は穏やかになるが沖へ流されやすい。'
    },
    heavyRain: {
      label: '強い雨・雪', tone: 'warn', effect: '1段階格下げ',
      desc: '視界が落ち、体温も奪われるため下げる。弱い雨では下げない。'
    },
    afternoonBuildup: {
      label: '午後に吹き上がり', tone: 'warn', effect: '判定は下げない',
      desc: '朝は穏やかでも昼から強まる日。早上がりを前提に組み立てること。'
    },
    noData: {
      label: 'データなし', tone: '', effect: '判定しない',
      desc: 'その日の気象データが取れていない。'
    }
  };

  var DIR16 = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
    '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];

  /**
   * 判定する時間帯。すべて日の出・日の入を基準にする。
   * 固定時刻で切ると季節でずれるが、太陽基準なら夏は昼が長く冬は短く、自動で実態に合う。
   * 昼間は「朝マヅメの終わり〜夕マヅメの始まり」と定義するので、隙間も重複も出ない。
   */
  var PERIODS = {
    morning: { key: 'morning', label: '朝マヅメ', short: '朝', desc: '日の出前後から午前中' },
    day: { key: 'day', label: '昼間', short: '昼', desc: '朝マヅメの終わりから夕マヅメの始まりまで' },
    evening: { key: 'evening', label: '夕マヅメ', short: '夕', desc: '午後から日の入前後' },
    allday: { key: 'allday', label: '終日', short: '終日', desc: '日の出前から日の入後まで通し' }
  };
  var PERIOD_ORDER = ['morning', 'day', 'evening', 'allday'];

  // WMO 天気コード
  var THUNDER_CODES = [95, 96, 99];
  var HEAVY_RAIN_CODES = [65, 67, 82, 75, 86];

  // ------------------------------------------------------------ 数値ユーティリティ

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function compact(values) {
    var out = [];
    for (var i = 0; i < values.length; i++) if (isNum(values[i])) out.push(values[i]);
    return out;
  }

  /** null / undefined / NaN を除いた中央値。有効値ゼロなら null。 */
  function median(values) {
    var v = compact(values);
    if (!v.length) return null;
    v.sort(function (a, b) { return a - b; });
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  /** 母集団標準偏差。有効値が 2 未満なら null（ばらつきを語れない）。 */
  function stdev(values) {
    var v = compact(values);
    if (v.length < 2) return null;
    var mean = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
    var sq = v.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / v.length;
    return Math.sqrt(sq);
  }

  function maxOf(values) {
    var v = compact(values);
    if (!v.length) return null;
    return Math.max.apply(null, v);
  }

  /** 風向は循環量なのでベクトル平均を採る（350° と 10° の平均は 0° であって 180° ではない）。 */
  function circularMeanDeg(values) {
    var sx = 0, sy = 0, n = 0;
    for (var i = 0; i < values.length; i++) {
      if (!isNum(values[i])) continue;
      var r = values[i] * Math.PI / 180;
      sx += Math.cos(r);
      sy += Math.sin(r);
      n++;
    }
    if (!n) return null;
    var deg = Math.atan2(sy / n, sx / n) * 180 / Math.PI;
    return (deg + 360) % 360;
  }

  /** from > to のときは 0°をまたぐレンジとして扱う。 */
  function inDirRange(deg, from, to) {
    if (!isNum(deg)) return false;
    var d = (deg + 360) % 360;
    if (from <= to) return d >= from && d <= to;
    return d >= from || d <= to;
  }

  function dirName(deg) {
    if (!isNum(deg)) return null;
    var i = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
    return DIR16[i];
  }

  /**
   * 値を 3(◎) / 2(○) / 1(△) / 0(×) に落とす。
   * ○ は ◎ と △ の中間帯とする。値が無ければ null（＝この指標では判定しない）。
   */
  function levelFor(value, good, fair) {
    if (!isNum(value)) return null;
    if (value <= good) return 3;
    if (value <= good + (fair - good) / 2) return 2;
    if (value <= fair) return 1;
    return 0;
  }

  function round(v, digits) {
    if (!isNum(v)) return null;
    var f = Math.pow(10, digits);
    return Math.round(v * f) / f;
  }

  /**
   * 判定する時間帯の [開始, 終了]（小数時）を返す。
   * @param {string} period PERIODS のキー
   * @param {number} sunrise 日の出（小数時）
   * @param {number} sunset  日の入（小数時）
   */
  function windowFor(period, sunrise, sunset, T) {
    var mFrom = sunrise - T.windowBeforeSunrise;
    var mTo = sunrise + T.windowAfterSunrise;
    var eFrom = sunset - T.windowBeforeSunset;
    var eTo = sunset + T.windowAfterSunset;
    var from, to;

    if (period === 'evening') {
      from = eFrom; to = eTo;
    } else if (period === 'allday') {
      from = mFrom; to = eTo;
    } else if (period === 'day') {
      from = mTo; to = eFrom;
      // 冬至前後は日照が短く、朝と夕の窓が重なって昼が消える。
      // そのときは南中前後の2時間を昼とみなす。
      if (to - from < 1) {
        var noon = (sunrise + sunset) / 2;
        from = noon - 1;
        to = noon + 1;
      }
    } else {
      from = mFrom; to = mTo;
    }

    from = Math.max(0, Math.min(23, from));
    to = Math.max(0, Math.min(23, to));
    if (to <= from) to = Math.min(23, from + 1);
    return [from, to];
  }

  // ------------------------------------------------------------ 日別評価

  /**
   * 1日分を評価する。
   *
   * @param {Object} day
   *   {
   *     date: 'YYYY-MM-DD',
   *     sunrise: number,        // 小数時（例 4.8 = 04:48）。無い場合は 5 を仮定
   *     hours: [                // 24 要素。index = その日の現地時刻
   *       { hour, wind:{model:val,...}, gust:{...}, dir:{...},
   *         wave, swellHeight, swellPeriod, precipProb, weatherCode, temp }
   *     ]
   *   }
   * @param {Object} [thresholds] DEFAULTS を上書きする値
   * @param {Object} [opts] { checkDirection: boolean, period: 'morning'|'day'|'evening'|'allday' }
   */
  function evaluateDay(day, thresholds, opts) {
    var T = Object.assign({}, DEFAULTS, thresholds || {});
    var O = Object.assign({ checkDirection: true, period: 'morning' }, opts || {});
    var period = PERIODS[O.period] ? O.period : 'morning';

    var sunrise = isNum(day.sunrise) ? day.sunrise : 5;
    var sunset = isNum(day.sunset) ? day.sunset : 18;
    var span = windowFor(period, sunrise, sunset, T);
    var from = span[0];
    var to = span[1];
    var periodInfo = PERIODS[period];

    var winds = [], gusts = [], waves = [], swellH = [], swellT = [];
    var dirs = [], spreads = [], precip = [], codes = [];
    var usedHours = [];

    for (var h = 0; h < day.hours.length; h++) {
      var rec = day.hours[h];
      if (!rec) continue;
      var hr = isNum(rec.hour) ? rec.hour : h;
      // 判定窓に少しでもかかる整数時を対象にする
      if (hr + 1 <= from || hr >= to) continue;
      usedHours.push(hr);

      var windVals = values(rec.wind);
      var w = median(windVals);
      if (w !== null) winds.push(w);
      var sd = stdev(windVals);
      if (sd !== null) spreads.push(sd);

      var g = median(values(rec.gust));
      if (g !== null) gusts.push(g);

      var d = circularMeanDeg(values(rec.dir));
      if (d !== null) dirs.push({ hour: hr, deg: d, wind: w });

      if (isNum(rec.wave)) waves.push(rec.wave);
      if (isNum(rec.swellHeight)) swellH.push(rec.swellHeight);
      if (isNum(rec.swellPeriod)) swellT.push(rec.swellPeriod);
      if (isNum(rec.precipProb)) precip.push(rec.precipProb);
      if (isNum(rec.weatherCode)) codes.push(rec.weatherCode);
    }

    var maxWind = maxOf(winds);
    var maxGust = maxOf(gusts);
    var maxWave = maxOf(waves);
    var maxSwellH = maxOf(swellH);
    var maxSwellT = maxOf(swellT);
    var maxPrecip = maxOf(precip);

    var levels = compact([
      levelFor(maxWind, T.goodWind, T.fairWind),
      levelFor(maxGust, T.goodGust, T.fairGust),
      levelFor(maxWave, T.goodWave, T.fairWave)
    ]);

    var flags = [];
    var reasons = [];

    if (!levels.length) {
      return {
        date: day.date,
        grade: null,
        gradeInfo: NO_DATA,
        window: { from: round(from, 2), to: round(to, 2), period: period, label: periodInfo.label },
        metrics: {},
        flags: ['noData'],
        reasons: ['この日の気象データがありません'],
        confidence: { sd: null, level: 'unknown', label: '不明' }
      };
    }

    var grade = Math.min.apply(null, levels);

    // 判定の根拠を残す（数字だけ出しても信用できないため）
    if (isNum(maxWind)) {
      reasons.push(periodInfo.label + '帯の最大風速 ' + round(maxWind, 1) + ' m/s → ' +
        symbolOf(levelFor(maxWind, T.goodWind, T.fairWind)));
    }
    if (isNum(maxGust)) {
      reasons.push('最大瞬間風速 ' + round(maxGust, 1) + ' m/s → ' +
        symbolOf(levelFor(maxGust, T.goodGust, T.fairGust)));
    }
    if (isNum(maxWave)) {
      reasons.push('有義波高 ' + round(maxWave, 2) + ' m → ' +
        symbolOf(levelFor(maxWave, T.goodWave, T.fairWave)));
    } else {
      flags.push('windOnly');
      reasons.push('波高データなし（8日先までしか存在しない）ため風のみで暫定判定');
    }

    // --- 荒天。雷は小型艇では避けようがないので他がどれだけ穏やかでも × にする
    var hasThunder = codes.some(function (c) { return THUNDER_CODES.indexOf(c) >= 0; });
    var hasHeavyRain = codes.some(function (c) { return HEAVY_RAIN_CODES.indexOf(c) >= 0; });
    if (hasThunder && T.thunderBlocks) {
      grade = 0;
      flags.push('thunder');
      reasons.push(periodInfo.label + '帯に雷の予報 → 風・波によらず出船不可');
    } else if (hasHeavyRain) {
      grade = Math.max(0, grade - 1);
      flags.push('heavyRain');
      reasons.push('強い雨・雪の予報 → 1段階格下げ（視界不良と体温低下）');
    }

    // --- うねり補正
    if (isNum(maxSwellT) && isNum(maxSwellH) &&
        maxSwellT >= T.swellPeriodWarn && maxSwellH >= T.swellHeightWarn) {
      grade = Math.max(0, grade - 1);
      flags.push('longSwell');
      reasons.push('周期 ' + round(maxSwellT, 1) + ' s / 高さ ' + round(maxSwellH, 2) +
        ' m の長周期うねり → 1段階格下げ（波高の数字以上に3m艇は揺れる）');
    }

    // --- 吹き付け風ペナルティ
    var onshore = null;
    if (O.checkDirection) {
      for (var i = 0; i < dirs.length; i++) {
        if (inDirRange(dirs[i].deg, T.onshoreFrom, T.onshoreTo) &&
            (!isNum(dirs[i].wind) || dirs[i].wind >= T.onshoreMinWind)) {
          onshore = dirs[i];
          break;
        }
      }
    }
    if (onshore) {
      grade = Math.max(0, grade - 1);
      flags.push('onshore');
      reasons.push(dirName(onshore.deg) + 'の吹き付け風（岸向き）→ 1段階格下げ。' +
        'うねりが立ちやすく帰航が難しくなる');
    }

    // --- 沖出し警告（判定は下げない）
    var avgDir = circularMeanDeg(dirs.map(function (x) { return x.deg; }));
    if (O.checkDirection && !onshore && inDirRange(avgDir, T.offshoreFrom, T.offshoreTo) &&
        isNum(maxWind) && maxWind >= T.onshoreMinWind) {
      flags.push('offshore');
      reasons.push(dirName(avgDir) + 'の陸風。海面は穏やかだが沖へ流されやすいので注意');
    }

    // --- 午後の吹き上がり。判定窓より後の時間の話なので、朝マヅメで判定するときだけ意味がある
    var afternoon = [];
    for (var k = 12; k <= 16 && k < day.hours.length; k++) {
      if (day.hours[k]) {
        var pm = median(values(day.hours[k].wind));
        if (pm !== null) afternoon.push(pm);
      }
    }
    var maxAfternoon = maxOf(afternoon);
    if (period === 'morning' && isNum(maxAfternoon) && isNum(maxWind) &&
        maxAfternoon - maxWind >= T.afternoonRiseDelta) {
      flags.push('afternoonBuildup');
      reasons.push('午後（12〜16時）に ' + round(maxAfternoon, 1) +
        ' m/s まで吹き上がる見込み。早上がり推奨');
    }

    // --- 波高が無い日は ◎ を名乗れない。
    // 制約が1つ欠けているだけの日が、実際に凪だと分かっている日より上位に来てはいけない。
    if (flags.indexOf('windOnly') >= 0 && grade > 2) {
      grade = 2;
      reasons.push('波高が未知のため ◎ ではなく ○ 止まり（風だけでは凪と断定できない）');
    }

    // --- モデル一致度
    var meanSd = spreads.length
      ? spreads.reduce(function (a, b) { return a + b; }, 0) / spreads.length
      : null;
    var conf = { sd: round(meanSd, 2), level: 'unknown', label: '不明' };
    if (meanSd !== null) {
      if (meanSd < T.confidenceHigh) { conf.level = 'high'; conf.label = '高'; }
      else if (meanSd < T.confidenceMid) { conf.level = 'mid'; conf.label = '中'; }
      else { conf.level = 'low'; conf.label = '低'; }
    }

    return {
      date: day.date,
      grade: grade,
      gradeInfo: GRADES[grade],
      window: {
        from: round(from, 2), to: round(to, 2), hours: usedHours,
        period: period, label: periodInfo.label, short: periodInfo.short
      },
      metrics: {
        maxWind: round(maxWind, 1),
        minWind: round(winds.length ? Math.min.apply(null, winds) : null, 1),
        maxGust: round(maxGust, 1),
        maxWave: round(maxWave, 2),
        maxSwellHeight: round(maxSwellH, 2),
        maxSwellPeriod: round(maxSwellT, 1),
        maxPrecipProb: maxPrecip,
        // 判定窓の中で最も悪い天気コード。日中の代表値を出すと
        // 「強い雨なのに ○」のように判定と食い違って見えるため、窓内の値を持つ。
        weatherCode: maxOf(codes),
        maxAfternoonWind: round(maxAfternoon, 1),
        dirDeg: round(avgDir, 0),
        dirName: dirName(avgDir)
      },
      flags: flags,
      reasons: reasons,
      confidence: conf
    };
  }

  function values(obj) {
    if (!obj) return [];
    return Object.keys(obj).map(function (k) { return obj[k]; });
  }

  function symbolOf(level) {
    return level === null || level === undefined ? '—' : GRADES[level].symbol;
  }

  // ------------------------------------------------------------ 気象庁との突き合わせ

  var CONFLICT = {
    // 沿岸の波がこれ以上食い違ったら知らせる。気象庁の予報区の波高のほうが
    // 全球25km格子のモデルより岸の実態に近いので、差は「気象庁が高い側」だけ見る。
    waveGap: 0.3,
    popGap: 30   // 降水確率のポイント差
  };

  /**
   * 気象庁の公式予報と当アプリのモデル値を突き合わせ、食い違いを返す。
   * どちらが正しいかは決められないので、平均して均すのではなく差を差のまま提示する。
   *
   * @param {Object} res evaluateDay の結果に official / dayMaxWave / daily を足したもの
   */
  function findConflicts(res) {
    var o = res && res.official;
    if (!o) return [];
    var out = [];
    var modelWave = res.dayMaxWave;
    var modelPop = res.daily ? res.daily.precipMax : null;

    if (isNum(o.waveMeters) && isNum(modelWave) && o.waveMeters - modelWave >= CONFLICT.waveGap) {
      out.push({
        kind: 'wave',
        text: '気象庁は沿岸の波を最大 ' + o.waveMeters + ' m と予報（当アプリのモデル値は ' +
          round(modelWave, 2) + ' m）。沿岸波高は気象庁のほうが実態に近いので、高いほうで考えること'
      });
    }
    if (isNum(o.pop) && isNum(modelPop) && Math.abs(o.pop - modelPop) >= CONFLICT.popGap) {
      out.push({
        kind: 'pop',
        // どちらもその日の最大値。一覧表に出しているのは朝マヅメ帯の値なので、
        // 数字が合わなく見えないように何の値かを書いておく。
        text: '降水確率が食い違う（その日の最大で 気象庁 ' + o.pop + '% / 当アプリ ' + modelPop + '%）'
      });
    }
    if (o.reliability === 'C' && res.confidence && res.confidence.level === 'high') {
      out.push({
        kind: 'reliability',
        text: '当アプリはモデルが一致しているが、気象庁は週間予報の確度を C（低い）としている'
      });
    }
    return out;
  }

  // ------------------------------------------------------------ 連続凪ウィンドウ

  /**
   * grade が minGrade 以上の日が minLen 日以上連続する区間を抽出する。
   * 品川から片道4時間かけて行く以上、単日より連泊できる並びのほうが価値が高い。
   *
   * @param {Array} results evaluateDay の結果を日付順に並べたもの
   */
  function findCalmWindows(results, options) {
    var opt = Object.assign({ minGrade: 2, minLen: 2 }, options || {});
    var windows = [];
    var run = [];

    function flush() {
      if (run.length >= opt.minLen) {
        var grades = run.map(function (r) { return r.grade; });
        windows.push({
          start: run[0].date,
          end: run[run.length - 1].date,
          length: run.length,
          minGrade: Math.min.apply(null, grades),
          days: run.slice(),
          windOnly: run.every(function (r) { return r.flags.indexOf('windOnly') >= 0; })
        });
      }
      run = [];
    }

    for (var i = 0; i < results.length; i++) {
      if (results[i].grade !== null && results[i].grade >= opt.minGrade) run.push(results[i]);
      else flush();
    }
    flush();

    // 波高データが揃っている窓を先に出す。風だけしか分からない窓は、
    // 制約が1つ少ないぶん高く出やすいので、同列に並べると判断を誤らせる。
    windows.sort(function (a, b) {
      if (a.windOnly !== b.windOnly) return a.windOnly ? 1 : -1;
      if (b.minGrade !== a.minGrade) return b.minGrade - a.minGrade;
      if (b.length !== a.length) return b.length - a.length;
      return a.start < b.start ? -1 : 1;
    });
    return windows;
  }

  FF.rating = {
    DEFAULTS: DEFAULTS,
    GRADES: GRADES,
    NO_DATA: NO_DATA,
    FLAGS: FLAGS,
    PERIODS: PERIODS,
    PERIOD_ORDER: PERIOD_ORDER,
    windowFor: windowFor,
    median: median,
    stdev: stdev,
    maxOf: maxOf,
    circularMeanDeg: circularMeanDeg,
    inDirRange: inDirRange,
    dirName: dirName,
    levelFor: levelFor,
    evaluateDay: evaluateDay,
    findConflicts: findConflicts,
    CONFLICT: CONFLICT,
    findCalmWindows: findCalmWindows
  };
})(typeof window !== 'undefined' ? window : globalThis);
