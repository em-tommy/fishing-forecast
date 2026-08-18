/*
 * verify.js - モデルの答え合わせ（data/verify.js の読み出しと表示）
 *
 * なぜこれがあるか:
 *   「当たるモデルの重みを上げる」には、どのモデルがどれだけ外したかの実測が要る。
 *   持っていない状態で係数を置けば、それは思い込みに数式の見た目を与えただけになる。
 *   だからまず測る。重み付けを入れるとしたら、ここに十分なデータが溜まってから。
 *
 * 実測値は AMeDAS 大潟（54586）の10分平均風速の毎時最大。
 * 釣り場から約4.2kmの海岸沿いだが、陸上の1点であって沖の海面ではない。
 * したがってこの数字は「モデル同士の相対比較」には使えるが、
 * 「絶対的な正解」ではない。断定的な結論を出す用途には使わないこと。
 *
 * リード（何日前の予報か）を必ず分けている。モデルの優劣はリードで入れ替わるので、
 * ひとまとめの平均は実務上ほとんど意味がない。
 */
(function (global) {
  'use strict';

  var FF = (global.FF = global.FF || {});

  var STATION = {
    '54586': { name: '大潟', kana: 'おおがた', distanceKm: 4.2 }
  };

  var MODEL_LABEL = {
    ecmwf_ifs025: 'ECMWF',
    gfs_seamless: 'GFS',
    icon_seamless: 'ICON',
    jma_seamless: '気象庁',
    ens_p50: 'アンサンブル中央値',
    ens_p90: 'アンサンブル上位10%'
  };

  var BUCKET = {
    archive: {
      key: 'archive', label: '短期（参考）',
      desc: '過去日をあとから取り寄せた予報。発表直前の値に近いため実際より当たって見える。' +
        'リード別の成績とは混ぜていない。'
    },
    d1_3: { key: 'd1_3', label: '1〜3日前', desc: '出船の直前判断に使うリード。' },
    d4_7: { key: 'd4_7', label: '4〜7日前', desc: '週末の予定を決めるリード。' },
    d8_16: { key: 'd8_16', label: '8〜16日前', desc: '月1回の釣行を先に計画するリード。' },
    all: { key: 'all', label: '全体', desc: 'リードを問わない平均。参考程度に。' }
  };

  // これ未満のサンプル数では、差が出ていても偶然と区別がつかない。
  // 数字を出すことより「まだ言えない」と言うことのほうが大事なので明示する。
  var MIN_USEFUL = 30;

  function data() {
    return global.VERIFY_DATA || null;
  }

  function available() {
    var d = data();
    return !!(d && d.stats);
  }

  function station() {
    var d = data();
    if (!d) return null;
    var s = STATION[d.station] || { name: d.station, distanceKm: null };
    return { id: d.station, name: s.name, distanceKm: s.distanceKm };
  }

  function modelLabel(key) {
    return MODEL_LABEL[key] || key;
  }

  /** 表示するリード区分。データが1件も無い区分は落とす。 */
  function buckets() {
    var d = data();
    if (!d) return [];
    var keys = d.buckets || ['archive', 'd1_3', 'd4_7', 'd8_16', 'all'];
    return keys.filter(function (k) {
      return Object.keys(d.stats).some(function (m) {
        return d.stats[m] && d.stats[m][k] && d.stats[m][k].n > 0;
      });
    }).map(function (k) { return BUCKET[k] || { key: k, label: k, desc: '' }; });
  }

  /** 系列（4モデル＋アンサンブル）のうち、実際に値があるものだけ返す。 */
  function seriesKeys() {
    var d = data();
    if (!d) return [];
    return Object.keys(d.stats).filter(function (m) {
      return Object.keys(d.stats[m]).some(function (k) {
        return d.stats[m][k] && d.stats[m][k].n > 0;
      });
    });
  }

  function cell(model, bucket) {
    var d = data();
    if (!d || !d.stats[model]) return null;
    return d.stats[model][bucket] || null;
  }

  /**
   * その区分で最も平均誤差が小さい系列。
   * サンプルが足りないうちは順位を出さない（少数の偶然を「実力」と読ませないため）。
   */
  function bestIn(bucket) {
    var d = data();
    if (!d) return null;
    var best = null;
    seriesKeys().forEach(function (m) {
      var c = cell(m, bucket);
      if (!c || c.n < MIN_USEFUL) return;
      if (!best || c.mae < best.mae) best = { model: m, mae: c.mae, n: c.n };
    });
    return best;
  }

  /** 収集の進み具合。まだ結論を出せない段階であることを伝えるために使う。 */
  function progress() {
    var d = data();
    if (!d) return null;
    var maxN = 0;
    seriesKeys().forEach(function (m) {
      ['d1_3', 'd4_7', 'd8_16'].forEach(function (k) {
        var c = cell(m, k);
        if (c && c.n > maxN) maxN = c.n;
      });
    });
    return {
      pairs: d.pairs || 0,
      obsDays: d.obsDays || 0,
      records: d.forecastRecords || 0,
      leadPairs: maxN,
      enough: maxN >= MIN_USEFUL,
      minUseful: MIN_USEFUL,
      updated: d.updated || null
    };
  }

  function recent() {
    var d = data();
    return (d && d.recent) || [];
  }

  FF.verify = {
    MIN_USEFUL: MIN_USEFUL,
    BUCKET: BUCKET,
    available: available,
    data: data,
    station: station,
    modelLabel: modelLabel,
    buckets: buckets,
    seriesKeys: seriesKeys,
    cell: cell,
    bestIn: bestIn,
    progress: progress,
    recent: recent
  };
})(typeof window !== 'undefined' ? window : globalThis);
