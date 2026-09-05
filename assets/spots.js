/*
 * spots.js - 釣り場マスタ（データのみ）
 *
 * app.js から切り出してあるのは、出船地点が今後 横浜・湘南・千葉 と増えるため。
 * 釣り場を1か所足す作業が「このファイルに1行足す」だけで完結し、
 * 描画も判定も触らずに済む状態を保つ。DOM にも fetch にも触らないので
 * tests.html から読み込んで中身を検査できる。
 */
(function (global) {
  'use strict';

  var FF = (global.FF = global.FF || {});

  // 釣り場マスタ。
  //
  // 出船地点は今後 横浜・湘南・千葉 と増える前提で組んである。追加はこの配列に1行足すだけでよい。
  //   - region … UI のグループ見出し。REGIONS に無い id を書かないこと
  //   - profile … その海岸固有の値。岸の向きは釣り場ごとに違うので全体設定に混ぜない
  //   - tide, jma, yahoo … それぞれ別ソースの地点コード。近い順ではなく代表性で選ぶ
  var REGIONS = [
    { id: 'joetsu', name: '上越' },
    { id: 'yokohama', name: '横浜' },
    { id: 'miura', name: '三浦半島' },
    { id: 'tokyobay', name: '東京湾' }
  ];

  // 岸の向きから吹き付け風／沖出しのレンジを作る。
  // 直江津の既定値（正面Nに対し 292.5〜67.5）と同じ幅135度を、正面方位に合わせて回すだけ。
  function facing(deg) {
    function n(x) { return ((x % 360) + 360) % 360; }
    return {
      onshoreFrom: n(deg - 67.5), onshoreTo: n(deg + 67.5),
      offshoreFrom: n(deg + 180 - 67.5), offshoreTo: n(deg + 180 + 67.5)
    };
  }

  var SPOTS = [
    {
      id: 'naoetsu', name: '直江津 第三堤防沖', short: '直江津', kind: 'boat',
      region: 'joetsu',
      lat: 37.219960, lon: 138.278409, tide: 'T3',
      jma: { pref: '150000', area: '150030' }, // 新潟県 / 上越
      yahoo: '15222',                          // Yahoo!天気の上越市
      target: '尺アジ・マダイ・青物',
      // 北〜北北東向きの海岸。日本海の北西季節風が最も危ない。
      profile: facing(0),
      note: '日本海。品川から片道約4時間の遠征。潮差は30cm前後しかない。'
    },
    {
      id: 'hashirimizu', name: '走水海岸', short: '走水', kind: 'boat',
      region: 'miura',
      lat: 35.265925, lon: 139.722459, tide: 'QN',
      jma: { pref: '140000', area: '140010' }, // 神奈川県 / 東部
      yahoo: '14201',                          // 横須賀市
      target: 'アジ・マゴチ・タチウオ',
      // 浦賀水道に面した東北東向き。正面は房総側。
      profile: facing(67.5),
      note: '浦賀水道。潮流が速く、大型船の航跡波がある。'
    },
    {
      id: 'miurakaigan', name: '三浦海岸', short: '三浦海岸', kind: 'boat',
      region: 'miura',
      lat: 35.189392, lon: 139.664276, tide: 'QN',
      jma: { pref: '140000', area: '140010' },
      yahoo: '14210',                          // 三浦市
      target: 'アジ・マダイ・青物',
      // 金田湾に面した東〜東南東向き。外洋のうねりが入る。
      profile: facing(101.25),
      note: '金田湾。東〜南東の外洋うねりが入る。'
    },
    {
      id: 'negishi', name: '横浜 根岸湾', short: '根岸湾', kind: 'boat',
      region: 'yokohama',
      // 指定された座標は陸ではなく海上（国土地理院の逆ジオコーディングが住所を返さない）。
      // 直江津の「第三堤防沖」と同じく、出艇地ではなく釣り座の位置として持っている。
      lat: 35.379788, lon: 139.680464, tide: 'HM',
      jma: { pref: '140000', area: '140010' }, // 神奈川県 / 東部
      yahoo: '14108',                          // 横浜市金沢区
      target: 'アジ・シロギス・タチウオ',
      // 帰る岸（根岸〜金沢）は東北東を向いている。東寄りの風が岸に押し付ける。
      profile: facing(67.5),
      note: '東京湾内。吹送距離が短く波は小さいが、波浪の格子点は約10km沖の値になる。'
    },
    { id: 'wakasu', name: '若洲海浜公園', short: '若洲', kind: 'shore', region: 'tokyobay', lat: 35.618, lon: 139.822, tide: 'TK', jma: { pref: '130000', area: '130010' }, target: 'アジ・タコ' },
    { id: 'ogishima', name: '東扇島西公園', short: '東扇島西', kind: 'shore', region: 'tokyobay', lat: 35.494, lon: 139.757, tide: 'QS', jma: { pref: '140000', area: '140010' }, target: 'アジ・タコ' },
    { id: 'fureyu', name: 'ふれーゆ裏', short: 'ふれーゆ裏', kind: 'shore', region: 'tokyobay', lat: 35.475, lon: 139.700, tide: 'QS', jma: { pref: '140000', area: '140010' }, target: 'アジ・タコ' },
    { id: 'daikoku', name: '大黒ふ頭海釣り施設', short: '大黒ふ頭', kind: 'shore', region: 'tokyobay', lat: 35.463, lon: 139.679, tide: 'QS', jma: { pref: '140000', area: '140010' }, target: 'アジ・タコ' },
    { id: 'honmoku', name: '本牧海づり施設', short: '本牧', kind: 'shore', region: 'tokyobay', lat: 35.418, lon: 139.668, tide: 'QS', jma: { pref: '140000', area: '140010' }, target: 'アジ・タコ' }
  ];

  var BOATS = SPOTS.filter(function (s) { return s.kind === 'boat'; });

  function spotById(id) {
    for (var i = 0; i < SPOTS.length; i++) if (SPOTS[i].id === id) return SPOTS[i];
    return null;
  }
  function regionName(id) {
    for (var i = 0; i < REGIONS.length; i++) if (REGIONS[i].id === id) return REGIONS[i].name;
    return id;
  }

  FF.spots = {
    REGIONS: REGIONS,
    SPOTS: SPOTS,
    BOATS: BOATS,
    byId: spotById,
    regionName: regionName,
    facing: facing
  };
})(typeof window !== 'undefined' ? window : globalThis);
