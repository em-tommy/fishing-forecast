/*
 * manual.js - 「使い方」タブ
 *
 * しきい値・判定記号・警告バッジの説明は、判定エンジン（rating.js）の定義から生成する。
 * 手書きの文章として持つと、ルールを直したときにマニュアルだけ古くなるため。
 * 現在のしきい値も設定タブの値をそのまま出すので、初期値から変えていても説明と食い違わない。
 */
(function (global) {
  'use strict';

  var FF = (global.FF = global.FF || {});

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var section = 0;
  function card(title, innerHtml) {
    section++;
    return '<div class="card"><h2>' + section + '. ' + esc(title) + '</h2>' + innerHtml + '</div>';
  }

  /** 16日ストリップの1コマを、実物と同じマークアップで並べて説明する。 */
  function cellDiagram() {
    return '' +
      '<div class="manual-figure">' +
      '  <div class="strip" style="overflow:visible">' +
      '    <div class="day" aria-hidden="true" style="cursor:default">' +
      '      <div class="dow sat">土</div>' +
      '      <div class="md">8/1</div>' +
      '      <div class="sym grade-good">◎</div>' +
      '      <div class="wx"><span class="ico">☀</span><span class="pop">10%</span></div>' +
      '      <div class="v">1.4m/s</div>' +
      '      <div class="v">0.26m</div>' +
      '      <div class="dot">中潮</div>' +
      '    </div>' +
      '  </div>' +
      '  <ol class="manual-callouts">' +
      '    <li><b>曜日</b>　土曜は青、日曜は赤</li>' +
      '    <li><b>日付</b></li>' +
      '    <li><b>判定</b>　◎○△×。この1文字だけ見れば行けるかどうかは分かる</li>' +
      '    <li><b>天気と降水確率</b>　判定時間帯の値。50%以上は赤字</li>' +
      '    <li><b>風速</b>　判定時間帯の最大値（m/s）</li>' +
      '    <li><b>波高</b>　判定時間帯の最大値（m）。「波—」は予報が存在しない日</li>' +
      '    <li><b>潮回り</b>　大潮・中潮など</li>' +
      '  </ol>' +
      '</div>';
  }

  function gradeTable(R, s) {
    var rows = [
      ['◎', '出船適', '≤ ' + s.goodWind, '≤ ' + s.goodGust, '≤ ' + s.goodWave, 'good'],
      ['○', '出船可', '≤ ' + mid(s.goodWind, s.fairWind), '≤ ' + mid(s.goodGust, s.fairGust),
        '≤ ' + mid(s.goodWave, s.fairWave), 'fair'],
      ['△', '要注意', '≤ ' + s.fairWind, '≤ ' + s.fairGust, '≤ ' + s.fairWave, 'marginal'],
      ['×', '出船不可', 'それ超', 'それ超', 'それ超', 'bad']
    ];
    return '<div class="tbl-wrap"><table><thead><tr>' +
      '<th>判定</th><th>平均風速 m/s</th><th>最大瞬間 m/s</th><th>有義波高 m</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td><span class="grade grade-' + r[5] + '">' +
          '<span class="sym">' + r[0] + '</span><span class="lbl">' + r[1] + '</span></span></td>' +
          '<td>' + r[2] + '</td><td>' + r[3] + '</td><td>' + r[4] + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
  }

  /** 実際の windowFor() を通して時間帯の境目を示す。説明と実装がずれないように。 */
  function periodTable(R, s) {
    var sunrise = 5, sunset = 19; // 夏の直江津に近い例
    var wSunrise = 7, wSunset = 16.5; // 冬の例
    function span(period, sr, ss) {
      var w = R.windowFor(period, sr, ss, Object.assign({}, R.DEFAULTS, s));
      return hhmm(w[0]) + '〜' + hhmm(w[1]);
    }
    return '<div class="tbl-wrap"><table><thead><tr>' +
      '<th style="text-align:left">時間帯</th><th style="text-align:left">範囲の決め方</th>' +
      '<th>夏の例<br><span class="muted">日の出5:00 日の入19:00</span></th>' +
      '<th>冬の例<br><span class="muted">日の出7:00 日の入16:30</span></th>' +
      '</tr></thead><tbody>' +
      R.PERIOD_ORDER.map(function (k) {
        return '<tr><td style="text-align:left"><b>' + esc(R.PERIODS[k].label) + '</b></td>' +
          '<td style="text-align:left;white-space:normal">' + esc(R.PERIODS[k].desc) + '</td>' +
          '<td>' + span(k, sunrise, sunset) + '</td>' +
          '<td>' + span(k, wSunrise, wSunset) + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
  }

  function hhmm(h) {
    var hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    if (mm === 60) { hh++; mm = 0; }
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  function mid(good, fair) {
    return Math.round((good + (fair - good) / 2) * 100) / 100;
  }

  function flagTable(R) {
    var order = ['thunder', 'windOnly', 'longSwell', 'onshore', 'heavyRain', 'afternoonBuildup', 'offshore'];
    return '<div class="tbl-wrap"><table><thead><tr>' +
      '<th>バッジ</th><th>判定への影響</th><th style="text-align:left">意味</th>' +
      '</tr></thead><tbody>' +
      order.map(function (k) {
        var f = R.FLAGS[k];
        if (!f) return '';
        return '<tr>' +
          '<td><span class="badge ' + f.tone + '">' + esc(f.label) + '</span></td>' +
          '<td>' + esc(f.effect) + '</td>' +
          '<td style="text-align:left;white-space:normal">' + esc(f.desc) + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table></div>';
  }

  /**
   * @param {HTMLElement} host 描画先
   * @param {Object} settings 現在のしきい値（設定タブの値）
   * @param {Object} period   タブごとに選ばれている時間帯 { boat, shore }
   */
  function render(host, settings, period) {
    var R = FF.rating;
    var s = settings || R.DEFAULTS;
    var p = period || { boat: 'morning', shore: 'morning' };
    var html = [];
    section = 0;

    html.push('<div class="notice">' +
      '<b>このダッシュボードは「行く日を絞り込む」ための道具です。</b>' +
      '出船するかどうかの最終判断は、現地の海況と気象庁・海上保安庁の警報で行ってください。' +
      '</div>');

    // ---- 1. 最短の使い方
    html.push(card('最短の使い方', '' +
      '<ol class="manual-steps">' +
      '<li><b>「出船」タブを開く。</b>一番上の<b>「どこなら出せるか」</b>で、' +
      '出船地点ごとの16日分の判定が一覧できます。行きたい場所と日が交わるところを押すと、' +
      'その釣り場のその日が開きます。</li>' +
      '<li>釣り場を決めたら、その下の<b>出船候補カード</b>が答えです。' +
      '2日以上つづけて出船できる並びを、良い順に3件まで出します。</li>' +
      '<li>連続にならなくても行ける日は、その下の<b>単日の候補</b>に出ます。' +
      '波高まで分かっている日なので、遠い日の連続候補より確実です。</li>' +
      '<li>カードを押すと、その日の詳細（根拠・グラフ・潮汐）に飛びます。</li>' +
      '</ol>' +
      '<p class="sub">迷ったら「◎ が付いていて、モデル一致が<b>高</b>で、警告バッジが無い日」を選べば外しません。</p>'));

    // ---- 時間帯の選択
    html.push(card('判定する時間帯を選ぶ', '' +
      '<p class="sub">各タブの上にある<b>朝マヅメ / 昼間 / 夕マヅメ / 終日</b>で、' +
      'その時間帯だけを見て判定します。狙う時間が違えば同じ日でも判定は変わります。</p>' +
      '<p class="sub">境目は固定の時刻ではなく<b>日の出・日の入から決まります</b>。' +
      '固定時刻だと季節でずれるためです。夏は昼が長く、冬は自動的に短くなります。</p>' +
      periodTable(R, s) +
      '<p class="sub">選択は<b>タブごとに別々に保存されます</b>。' +
      '出船は朝マヅメ、東京湾のアジは夕マヅメ、といった使い分けができます。</p>' +
      '<p class="sub">いまの選択：出船＝<b>' + esc(R.PERIODS[p.boat].label) + '</b>／' +
      '陸っぱり＝<b>' + esc(R.PERIODS[p.shore].label) + '</b></p>' +
      '<p class="muted">「午後に吹き上がり」の警告は、判定窓より後の時間の話なので朝マヅメを選んだときだけ出ます。</p>'));

    // ---- 出船地点
    html.push(card('出船地点の選び方', '' +
      '<p class="sub">出船タブの一番上は<b>「どこなら出せるか」</b>の一覧です。' +
      '行が釣り場、列が日で、記号だけを敷き詰めてあります。数値を出していないのは、' +
      'ここで知りたいのが各地点の風速そのものではなく<b>空いている枠がどこにあるか</b>だからです。</p>' +
      '<p class="sub">その下の<b>釣り場ボタン</b>で表示する地点を切り替えます。' +
      '以下のカード（候補日・16日間・詳細・アンサンブル・公式予報）は、すべて選択中の1か所についての表示です。</p>' +
      '<p class="sub"><b>危険な風向は釣り場ごとに違います。</b>' +
      '岸に向かって吹く風は帰航が難しくなるため1段階格下げしますが、' +
      '直江津は北向きの海岸なので北西風、走水は東北東向きなので東風、と当たる風向が変わります。' +
      'これは海岸の向きという地形の事実なので設定では動かしません（設定タブの一覧で確認できます）。</p>' +
      '<p class="muted">アンサンブル予報は通信量が大きいため、いま見ている釣り場の分だけ取得します。' +
      '切り替えた直後は少し遅れて出ます。</p>'));

    // ---- 2. ストリップの読み方
    html.push(card('16日間の見方', '' +
      '<p class="sub">横スクロールする1日1コマの帯です。コマを押すと下に詳細が開きます。</p>' +
      cellDiagram() +
      '<p class="sub" style="margin-top:10px">' +
      '数値はどれも<b>選んだ時間帯</b>の値です。日中の代表値ではありません。' +
      '釣るのはその時間帯なので、そこだけで判定しています。</p>'));

    // ---- 3. 判定のしくみ
    html.push(card('判定のしくみ', '' +
      '<p class="sub">選んだ時間帯の<b>最悪値</b>で決めます。平均だと一瞬の突風や短時間のうねりを見落とすためです。' +
      '風・突風・波の3つを別々に判定し、<b>一番悪いものがその日の判定</b>になります。</p>' +
      '<p class="sub">いま設定されているしきい値（設定タブで変更できます）:</p>' +
      gradeTable(R, s) +
      '<p class="sub" style="margin-top:12px">これに次の補正がかかります。' +
      '判定の下に出るバッジがその印です。</p>' +
      flagTable(R)));

    // ---- 4. モデル一致度
    html.push(card('モデル一致度（信頼度）', '' +
      '<p class="sub">4つの気象モデル（ECMWF・GFS・ICON・気象庁）の風速がどれだけそろっているかです。' +
      'Windy でモデルを見比べていた作業を、この1語に置き換えています。</p>' +
      '<dl class="kv">' +
      '<dt>高</dt><dd>ばらつきが 1 m/s 未満。予報はほぼ固まっている</dd>' +
      '<dt>中</dt><dd>1〜2 m/s。まだ動く余地がある</dd>' +
      '<dt>低</dt><dd>2 m/s 以上。<b>直前に大きく変わる可能性が高い</b>。予定を固めない</dd>' +
      '<dt>不明</dt><dd>その日まで値を出しているモデルが1つしかない（16日目付近で起きます）</dd>' +
      '</dl>' +
      '<p class="sub">日別詳細の<b>「モデル比較を開く」</b>を押すと、モデルごとの風速・風向と、' +
      'そのモデル単独ならどう判定されるかを並べた表が出ます。ばらけている日は、どのモデルが外れ値かをここで確認してください。</p>'));

    // ---- アンサンブル。モデル一致度のすぐ後に置く（同じ「どれだけ確からしいか」の話なので）
    var aggRows = R.MODEL_AGG_ORDER.map(function (k) {
      return '<dt>' + esc(R.MODEL_AGG[k].label) + '</dt><dd>' + esc(R.MODEL_AGG[k].desc) + '</dd>';
    }).join('');
    var aggNow = R.MODEL_AGG[settings.modelAgg] || R.MODEL_AGG.median;

    html.push(card('アンサンブル予報（51本の内訳）', '' +
      '<p class="sub">4モデル比較が「別々の機関の予報がどれだけ割れているか」なのに対し、' +
      'アンサンブルは<b>同じモデルを初期値を少しずつ変えて51回走らせた</b>結果です。' +
      '「大気の状態が少し違っていたらどうなっていたか」の分布がそのまま出ます。</p>' +
      '<p class="sub">16日間の表の下にある帯グラフがそれです。1日ぶんの帯が、' +
      '51本それぞれを ◎○△× に振り分けた割合を示します。右の数字は' +
      '<b>「中央値 / 最も強い1本」</b>です。</p>' +
      '<p class="sub"><b>ここが一番大事です。</b>中央値が 1.3 m/s でも、51本のうち数本が 8 m/s を出しているなら、' +
      'それは「凪」ではなく<b>「凪かもしれない」</b>です。2馬力3mの船で効くのはその裾のほうなので、' +
      '右の太字の数字を必ず見てください。</p>' +
      '<p class="sub">日別詳細のグラフでは、帯が51本のうち中央8割が収まる範囲です。' +
      '<b>帯が広い時間帯ほど、まだ決まっていません。</b></p>' +
      '<p class="sub">注意が2つあります。アンサンブルに含まれるのは<b>風と突風だけ</b>で、' +
      '波・雷は入っていません（内訳は本体の判定とは別物です）。また期間は<b>約15日</b>までで、' +
      '16日目は4モデルの比較しかありません。</p>'));

    html.push(card('モデルの代表値の取り方（設定タブ）', '' +
      '<p class="sub">4つのモデルが違う値を出したとき、どれを判定に使うかを選べます。' +
      '風速と最大瞬間風速に効きます（波高は予報が1つしかないので変わりません）。</p>' +
      '<dl class="kv">' + aggRows + '</dl>' +
      '<p class="sub">いまの設定は <b>' + esc(aggNow.label) + '</b> です。' +
      '中央値以外にしていると、判定に「荒天側で判定」のバッジが付きます。</p>' +
      '<p class="sub">どれを選んでも<b>モデル一致度は生の全モデルから測ります</b>。' +
      '荒天側に寄せたせいで「予報が一致している」ように見えることはありません。</p>' +
      '<p class="sub">なお<b>「よく当たるモデルの重みを上げる」ことは、あえてしていません。</b>' +
      'どのモデルが当たるかを実測していない段階で係数を置いても、思い込みに数式の見た目を与えるだけだからです。' +
      'いま毎日その実測を貯めています（設定タブの「モデルの答え合わせ」）。</p>'));

    // ---- 5. 気象庁の第2の意見
    html.push(card('他の予報との突き合わせ（気象庁・Yahoo天気）', '' +
      '<p class="sub">画面の下のほうにある表です。判定そのものは書き換えず、' +
      '<b>食い違いをそのまま見せる</b>ようにしてあります。</p>' +
      '<p class="sub">全球モデルが苦手で、気象庁のほうが当てになるのは次の2つです。</p>' +
      '<ul class="reasons">' +
      '<li><b>沿岸の波</b>　その釣り場の予報区ごとの値。全球モデルより岸の実態に近い</li>' +
      '<li><b>海上の風</b>　「北の風 後 西の風 <b>海上では南西の風強く</b>」のように陸と海を分けて書かれる</li>' +
      '</ul>' +
      '<p class="sub"><b>「気象庁の予報と食い違っている日」</b>の警告が出たら、' +
      '波は高いほう、風は強いほうで考えてください。安全側に倒すためです。</p>' +
      '<p class="sub">同じ表に <b>Yahoo天気（日本気象協会）の週間予報</b> も並べています。' +
      'Yahoo天気は気象庁をそのまま流しているのではなく独自の補正が入っており、実測でも値は一致しません' +
      '（例 2026-07-30 の降水確率は気象庁80%・Yahoo50%）。' +
      '<b>気象庁とYahooが割れている日は、素直に予報が固まっていない日</b>と考えてください。</p>' +
      '<p class="sub">Yahoo天気から取れるのは<b>明後日から6日分</b>の天気・気温・降水確率までです。' +
      'アプリで見える<b>信頼度A〜Cと7日目以降は、スマホアプリの中にしかありません</b>（Webページに存在しない）。' +
      'その代わりに気象庁の公式な確度A/B/C（7日分）を出しています。' +
      '画面下部にYahoo天気（上越市・津南町）へのリンクも置いてあるので、原典もすぐ確認できます。</p>' +
      '<p class="sub"><b>確度 A / B / C</b> は気象庁の週間予報の自信度です。C の日は予報が変わりやすいので、' +
      '直前にもう一度見てください。</p>'));

    // ---- 6. 東京湾タブ
    html.push(card('陸っぱりタブ', '' +
      '<ol class="manual-steps">' +
      '<li>上の<b>日付</b>を選ぶと、5か所を横並びで比較する表が出ます。</li>' +
      '<li>風・波・天気に加えて、<b>潮回り・満潮・干潮・潮の向き</b>が並びます。行き先選びはここだけで決まります。</li>' +
      '<li>その下に釣り場ごとの16日間の帯があります。押すとその日付の比較表に切り替わります。</li>' +
      '</ol>' +
      '<p class="sub">陸っぱりなので<b>風向による格下げは適用していません</b>（岸に打ち付ける風は、船と違って危険ではないため）。</p>' +
      '<p class="sub">潮汐の参照地点は、若洲＝東京、それ以外の4か所＝横浜です。</p>'));

    // ---- 7. 設定
    html.push(card('しきい値を自分に合わせる', '' +
      '<p class="sub">「設定・データの限界」タブのスライダーで、◎ と × の境目を変えられます。' +
      '初期値は2馬力3mボートを前提にした<b>保守的な</b>値です。</p>' +
      '<ul class="reasons">' +
      '<li>候補が出なさすぎると感じたら、まず<b>◎とする有義波高</b>を上げてみてください。効きが一番大きい項目です。</li>' +
      '<li>マヅメ帯の長さは<b>朝マヅメ帯・夕マヅメ帯の開始/終了</b>で変えられます。' +
      'ここを動かすと「昼間」の範囲も連動します。</li>' +
      '<li>変更はこの端末のブラウザに保存されます。別の端末には引き継がれません。</li>' +
      '<li><b>「初期値に戻す」</b>でいつでも元に戻せます。</li>' +
      '</ul>'));

    // ---- 答え合わせ
    html.push(card('モデルの答え合わせ（設定タブ）', '' +
      '<p class="sub">毎日、予報とその日の実測を突き合わせて記録しています。' +
      '実測は<b>AMeDAS 大潟</b>（釣り場から約4.2kmの海岸）の10分平均風速で、' +
      '朝マヅメ帯の最大値どうしを比べます。</p>' +
      '<p class="sub">表の数字は<b>平均絶対誤差（小さいほど当たる）</b>で、かっこ内が偏りです。' +
      '＋なら実際より強く予報する癖、−なら弱く見積もる癖を意味します。' +
      '<b>何日前の予報か（リード）で分けてあります。</b>' +
      'モデルの優劣はリードで入れ替わるので、ひとまとめの平均はあまり意味がないためです。</p>' +
      '<p class="sub">サンプルが少ないうちは<b>順位を出しません</b>。' +
      '数件の平均で「このモデルが当たる」と書けば、偶然を実力と読み違えるからです。' +
      '各リードで30件たまってから比較を始めます。冬型の成績が入るのは季節が一巡してからです。</p>' +
      '<p class="sub">注意点です。大潟は<b>陸上の1点であって沖の海面ではありません</b>。' +
      'モデル同士の相対比較には使えますが、絶対的な正解ではありません。' +
      'また「*」が付いた行は過去日をあとから取り寄せた短期予報で、リード別の集計には入れていません' +
      '（実際より当たって見えるためです）。</p>'));

    // ---- 8. スマホ
    html.push(card('スマホでの使い方', '' +
      '<ul class="reasons">' +
      '<li><b>ホーム画面に追加</b>すると、アプリのように開けます（Safari は共有ボタン →「ホーム画面に追加」）。</li>' +
      '<li>タブごとにURLが変わるので、よく見るタブを開いた状態で追加すれば次からそこが開きます。' +
      '<span class="muted">末尾が #boat / #shore / #settings / #manual</span></li>' +
      '<li>データは30分キャッシュします。<b>再取得</b>ボタンでいつでも取り直せます。</li>' +
      '<li>圏外のときは前回のデータを表示し、ヘッダに<b>「⚠ 取得失敗・キャッシュ表示」</b>と出ます。' +
      '古い値だと分かった上で見てください。</li>' +
      '<li>右上の <b>◐</b> で明るい表示と暗い表示を切り替えられます。</li>' +
      '</ul>'));

    // ---- 9. 限界
    html.push(card('信用してはいけないところ', '' +
      '<ul class="reasons">' +
      '<li><b>波高は8日先までしか存在しません。</b>9日目以降は風だけの暫定判定で、' +
      '<span class="badge warn">波高データなし・風のみ判定</span> が付きます。' +
      'また、先の予報ほどモデルの値は平均に寄るので、<b>遠い日はどうしても穏やかに見えます</b>。' +
      '長い連続日数そのものを根拠にしないでください。</li>' +
      '<li>東京湾内の波高は約25km格子の推計値です。実際の岸壁の波は地形と船の航跡に強く左右されます。</li>' +
      '<li>潮汐は気象庁の<b>天文潮位</b>です。気圧や風による偏差は含みません。</li>' +
      '<li>直江津は日本海側で潮差が30cm前後しかありません。<b>大潮でも東京湾のようには動きません。</b>' +
      '潮回りの名前より、併記してある実潮差(cm)を見てください。</li>' +
      '<li>波浪の格子点は釣り場から10km前後離れています。距離は画面上部に表示しています。</li>' +
      '</ul>'));

    // ---- 10. 困ったとき
    html.push(card('困ったとき', '' +
      '<dl class="kv">' +
      '<dt>データが出ない</dt>' +
      '<dd>画面上部に赤い枠でエラーが出ます。<b>再取得</b>を押してください。' +
      '短時間に何度も読み込むと取得制限にかかることがあります。少し待てば戻ります。</dd>' +
      '<dt>「取得失敗・キャッシュ表示」</dt>' +
      '<dd>通信できず前回のデータを出しています。表示時刻を確認してください。</dd>' +
      '<dt>気象庁の表が出ない</dt>' +
      '<dd>気象庁のデータ配信が一時的に止まっているときに起きます。' +
      'モデルによる判定は通常どおり動きます。</dd>' +
      '<dt>潮汐が「データなし」</dt>' +
      '<dd>年をまたぐと翌年分の潮位表が要ります。毎月自動で取り込む仕組みが入っていますが、' +
      '出ない場合は上部に警告が出ます。</dd>' +
      '</dl>'));

    host.innerHTML = html.join('');
  }

  FF.manual = { render: render };
})(typeof window !== 'undefined' ? window : globalThis);
