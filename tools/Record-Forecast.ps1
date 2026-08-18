<#
  Record-Forecast.ps1 - record forecasts and observations so the models can be scored later.

  Why this exists
    "Weight the accurate models higher" is a fair idea, but nothing in this repo
    knows which model is accurate at Naoetsu. Without measurements any weight is
    just a guess wearing a number. This script starts the measurement.

  What it does, once a day
    1. Fetch the deterministic forecast (4 models) for the boat spot, 16 days out.
       For every target day take the worst wind inside the morning window and
       append one record per (issue date, target date).
    2. Fetch the ECMWF ensemble and store p50 / p90 / max for the same window,
       so we can also check whether the pessimistic number actually bounds reality.
    3. Fetch AMeDAS Ogata (54586, 4.2 km from the spot, on the coast) and store
       the hourly maximum of the 10-minute mean wind for recent days.
    4. Join the two logs and regenerate data/verify.js for the browser.

  Notes
    - ASCII only, on purpose. Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1
      as the system ANSI code page, so any Japanese here would corrupt the file.
      Display names live in assets/verify.js instead.
    - Observations are the 10-minute MEAN wind. The AMeDAS "gust" field is a
      running daily maximum whose timestamp we could not pin down, so it is only
      used as a whole-day maximum and never scored per window.
    - AMeDAS Ogata is 4.2 km away and on land. It is not the sea surface at the
      fishing spot. Treat the scores as relative model comparison, not absolute truth.
#>
param(
  [string]$Root = '',
  [int]$ObsDays = 5,
  [int]$BackfillDays = 0,
  [switch]$NoEnsemble,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------- settings

# The boat spot. Keep in sync with SPOTS in assets/app.js.
$LAT = 37.219960
$LON = 138.278409

# Nearest coastal AMeDAS station. 54586 = Ogata, 4.2 km from the spot, altitude 13 m.
# Takada (54651) is closer to the city but 12.9 km inland, so it is a worse proxy for wind at sea.
$AMEDAS_ID = '54586'

$MODELS = @('ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'jma_seamless')

# Morning window offsets. These MUST match DEFAULTS.windowBeforeSunrise /
# windowAfterSunrise in assets/rating.js. tests.html asserts the recorded
# window equals R.windowFor('morning', ...) so a drift here is caught.
$WINDOW_BEFORE = 1.0
$WINDOW_AFTER = 4.0

$UA = 'fishing-forecast/1.0 (personal dashboard; verification logger)'

# ---------------------------------------------------------------- paths

if (-not $Root) {
  $here = $PSScriptRoot
  if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
  $Root = Split-Path -Parent $here
}
$dataDir = Join-Path $Root 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }

$fcLog = Join-Path $dataDir 'verify-forecast.jsonl'
$obsLog = Join-Path $dataDir 'verify-obs.jsonl'
$outJs = Join-Path $dataDir 'verify.js'

function Say([string]$msg) {
  if (-not $Quiet) { Write-Host $msg }
}

# ---------------------------------------------------------------- helpers

function Get-JsonWithRetry([string]$Url, [int]$Tries = 3) {
  for ($i = 1; $i -le $Tries; $i++) {
    try {
      return Invoke-RestMethod -Uri $Url -Headers @{ 'User-Agent' = $UA } -TimeoutSec 180
    } catch {
      if ($i -eq $Tries) { throw }
      Start-Sleep -Seconds (5 * $i)
    }
  }
}

function Append-Line([string]$Path, [string]$Line) {
  # Write without a BOM and with LF. Add-Content -Encoding utf8 would add a BOM
  # in PowerShell 5.1, which then shows up in the middle of an appended file.
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::AppendAllText($Path, $Line + "`n", $enc)
}

function Read-Jsonl([string]$Path) {
  $out = @()
  if (-not (Test-Path $Path)) { return $out }
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    $t = $line.Trim()
    if (-not $t) { continue }
    try { $out += (ConvertFrom-Json $t) } catch { }
  }
  return $out
}

function Round-Or-Null($v, [int]$digits) {
  if ($null -eq $v) { return $null }
  return [math]::Round([double]$v, $digits)
}

# Same clamping as windowFor('morning', ...) in assets/rating.js.
function Get-MorningWindow([string]$SunriseIso) {
  $t = [datetime]::ParseExact($SunriseIso.Substring(0, 16), 'yyyy-MM-ddTHH:mm', $null)
  $h = $t.Hour + ($t.Minute / 60.0)
  $from = $h - $WINDOW_BEFORE
  $to = $h + $WINDOW_AFTER
  if ($from -lt 0) { $from = 0 }
  if ($from -gt 23) { $from = 23 }
  if ($to -lt 0) { $to = 0 }
  if ($to -gt 23) { $to = 23 }
  if ($to -le $from) {
    $to = $from + 1
    if ($to -gt 23) { $to = 23 }
  }
  return @($from, $to)
}

# An integer hour counts when it overlaps the window at all - identical to evaluateDay.
function Test-HourInWindow([int]$Hour, [double]$From, [double]$To) {
  if (($Hour + 1) -le $From) { return $false }
  if ($Hour -ge $To) { return $false }
  return $true
}

function Get-Percentile($Values, [double]$P) {
  $v = @($Values | Where-Object { $null -ne $_ }) | Sort-Object
  if ($v.Count -eq 0) { return $null }
  $i = [math]::Round(($v.Count - 1) * $P)
  if ($i -lt 0) { $i = 0 }
  if ($i -ge $v.Count) { $i = $v.Count - 1 }
  return $v[$i]
}

# ---------------------------------------------------------------- 1. forecast

$today = (Get-Date).ToString('yyyy-MM-dd')

$fcUrl = 'https://api.open-meteo.com/v1/forecast' +
  '?latitude=' + $LAT + '&longitude=' + $LON +
  '&hourly=wind_speed_10m,wind_gusts_10m' +
  '&daily=sunrise,sunset' +
  '&models=' + ($MODELS -join ',') +
  '&wind_speed_unit=ms&timezone=Asia%2FTokyo&forecast_days=16'

Say 'fetching deterministic forecast...'
$fc = Get-JsonWithRetry $fcUrl

$times = $fc.hourly.time
$hourIndex = @{}
for ($i = 0; $i -lt $times.Count; $i++) {
  $d = $times[$i].Substring(0, 10)
  $hr = [int]$times[$i].Substring(11, 2)
  if (-not $hourIndex.ContainsKey($d)) { $hourIndex[$d] = @{} }
  $hourIndex[$d][$hr] = $i
}

# Sunrise is astronomical, so every model returns the same value. Use the first.
$sunKey = 'sunrise_' + $MODELS[0]
$dailyDates = $fc.daily.time
$sunrises = $fc.daily.$sunKey

function Get-WindowMax($Series, $DateKey, [double]$From, [double]$To) {
  if (-not $hourIndex.ContainsKey($DateKey)) { return $null }
  $best = $null
  foreach ($hr in $hourIndex[$DateKey].Keys) {
    if (-not (Test-HourInWindow ([int]$hr) $From $To)) { continue }
    $v = $Series[$hourIndex[$DateKey][$hr]]
    if ($null -eq $v) { continue }
    if ($null -eq $best -or $v -gt $best) { $best = $v }
  }
  return $best
}

# ---------------------------------------------------------------- 2. ensemble

$ensDays = @{}
if (-not $NoEnsemble) {
  $ensUrl = 'https://ensemble-api.open-meteo.com/v1/ensemble' +
    '?latitude=' + $LAT + '&longitude=' + $LON +
    '&hourly=wind_speed_10m&models=ecmwf_ifs025' +
    '&wind_speed_unit=ms&timezone=Asia%2FTokyo&forecast_days=16'
  Say 'fetching ensemble...'
  try {
    $ens = Get-JsonWithRetry $ensUrl
    $ensTimes = $ens.hourly.time
    $memberNames = @()
    foreach ($p in $ens.hourly.PSObject.Properties) {
      if ($p.Name -eq 'wind_speed_10m' -or $p.Name -like 'wind_speed_10m_member*') {
        $memberNames += $p.Name
      }
    }
    Say ('  ensemble members: ' + $memberNames.Count)

    # Per member, take the worst value inside the window FIRST, then rank the members.
    # Taking percentiles hour by hour would invent a member that never existed.
    $ensIndex = @{}
    for ($i = 0; $i -lt $ensTimes.Count; $i++) {
      $d = $ensTimes[$i].Substring(0, 10)
      $hr = [int]$ensTimes[$i].Substring(11, 2)
      if (-not $ensIndex.ContainsKey($d)) { $ensIndex[$d] = @{} }
      $ensIndex[$d][$hr] = $i
    }
    for ($di = 0; $di -lt $dailyDates.Count; $di++) {
      $dk = $dailyDates[$di]
      if (-not $ensIndex.ContainsKey($dk)) { continue }
      $span = Get-MorningWindow $sunrises[$di]
      $worst = @()
      foreach ($name in $memberNames) {
        $series = $ens.hourly.$name
        $best = $null
        foreach ($hr in $ensIndex[$dk].Keys) {
          if (-not (Test-HourInWindow ([int]$hr) $span[0] $span[1])) { continue }
          $v = $series[$ensIndex[$dk][$hr]]
          if ($null -eq $v) { continue }
          if ($null -eq $best -or $v -gt $best) { $best = $v }
        }
        if ($null -ne $best) { $worst += $best }
      }
      if ($worst.Count -gt 0) {
        $mx = ($worst | Measure-Object -Maximum).Maximum
        $ensDays[$dk] = [ordered]@{
          n = $worst.Count
          p50 = Round-Or-Null (Get-Percentile $worst 0.50) 2
          p90 = Round-Or-Null (Get-Percentile $worst 0.90) 2
          max = Round-Or-Null $mx 2
        }
      }
    }
  } catch {
    Say ('  ensemble failed, continuing without it: ' + $_.Exception.Message)
  }
}

# ---------------------------------------------------------------- 3. append forecast records

$existing = @{}
foreach ($rec in (Read-Jsonl $fcLog)) {
  $existing[($rec.issued + '|' + $rec.target)] = $true
}

$added = 0
for ($di = 0; $di -lt $dailyDates.Count; $di++) {
  $target = $dailyDates[$di]
  if ($target -le $today) { continue }   # only future days can be verified later
  $key = $today + '|' + $target
  if ($existing.ContainsKey($key)) { continue }

  $span = Get-MorningWindow $sunrises[$di]
  $wind = [ordered]@{}
  $gust = [ordered]@{}
  $anyWind = $false
  foreach ($m in $MODELS) {
    $w = Get-WindowMax $fc.hourly.('wind_speed_10m_' + $m) $target $span[0] $span[1]
    $g = Get-WindowMax $fc.hourly.('wind_gusts_10m_' + $m) $target $span[0] $span[1]
    $wind[$m] = Round-Or-Null $w 2
    $gust[$m] = Round-Or-Null $g 2
    if ($null -ne $w) { $anyWind = $true }
  }
  if (-not $anyWind) { continue }

  $lead = ([datetime]$target - [datetime]$today).Days
  $obj = [ordered]@{
    issued = $today
    target = $target
    lead = $lead
    from = Round-Or-Null $span[0] 2
    to = Round-Or-Null $span[1] 2
    sunrise = $sunrises[$di]
    wind = $wind
    gust = $gust
  }
  if ($ensDays.ContainsKey($target)) { $obj['ens'] = $ensDays[$target] }

  Append-Line $fcLog (ConvertTo-Json $obj -Depth 6 -Compress)
  $added++
}
Say ('forecast records added: ' + $added)

# ------------------------------------------------- 3b. backfill from the archive
#
# Real lead-time records only start accumulating from today, so the score table
# would sit empty for weeks. The historical forecast API lets us fill in what the
# models said for days that have already happened - but it serves the most recent
# run available for each hour, which is a SHORT lead time, not "issued N days ago".
#
# So these records are marked src=archive and scored into their own bucket. They
# must never be mixed into the lead-time buckets, or the models would look far
# better than they are at the lead times that actually matter for planning a trip.

if ($BackfillDays -gt 0) {
  $endD = (Get-Date).AddDays(-1)
  $startD = (Get-Date).AddDays(-$BackfillDays)
  $arcUrl = 'https://historical-forecast-api.open-meteo.com/v1/forecast' +
    '?latitude=' + $LAT + '&longitude=' + $LON +
    '&start_date=' + $startD.ToString('yyyy-MM-dd') +
    '&end_date=' + $endD.ToString('yyyy-MM-dd') +
    '&hourly=wind_speed_10m,wind_gusts_10m&daily=sunrise' +
    '&models=' + ($MODELS -join ',') +
    '&wind_speed_unit=ms&timezone=Asia%2FTokyo'
  Say ('backfilling from archive ' + $startD.ToString('yyyy-MM-dd') + ' .. ' + $endD.ToString('yyyy-MM-dd'))
  try {
    $arc = Get-JsonWithRetry $arcUrl
    $arcIndex = @{}
    for ($i = 0; $i -lt $arc.hourly.time.Count; $i++) {
      $d = $arc.hourly.time[$i].Substring(0, 10)
      $hr = [int]$arc.hourly.time[$i].Substring(11, 2)
      if (-not $arcIndex.ContainsKey($d)) { $arcIndex[$d] = @{} }
      $arcIndex[$d][$hr] = $i
    }
    $arcSunrise = $arc.daily.$sunKey
    $backAdded = 0
    for ($di = 0; $di -lt $arc.daily.time.Count; $di++) {
      $target = $arc.daily.time[$di]
      $key = 'archive|' + $target
      if ($existing.ContainsKey($key)) { continue }
      if (-not $arcIndex.ContainsKey($target)) { continue }

      $span = Get-MorningWindow $arcSunrise[$di]
      $wind = [ordered]@{}
      $gust = [ordered]@{}
      $anyW = $false
      foreach ($m in $MODELS) {
        $sw = $arc.hourly.('wind_speed_10m_' + $m)
        $sg = $arc.hourly.('wind_gusts_10m_' + $m)
        $bw = $null
        $bg = $null
        foreach ($hr in $arcIndex[$target].Keys) {
          if (-not (Test-HourInWindow ([int]$hr) $span[0] $span[1])) { continue }
          $idx = $arcIndex[$target][$hr]
          $vw = $sw[$idx]
          if ($null -ne $vw -and ($null -eq $bw -or $vw -gt $bw)) { $bw = $vw }
          $vg = $sg[$idx]
          if ($null -ne $vg -and ($null -eq $bg -or $vg -gt $bg)) { $bg = $vg }
        }
        $wind[$m] = Round-Or-Null $bw 2
        $gust[$m] = Round-Or-Null $bg 2
        if ($null -ne $bw) { $anyW = $true }
      }
      if (-not $anyW) { continue }

      $obj = [ordered]@{
        issued = 'archive'
        target = $target
        lead = 0
        src = 'archive'
        from = Round-Or-Null $span[0] 2
        to = Round-Or-Null $span[1] 2
        sunrise = $arcSunrise[$di]
        wind = $wind
        gust = $gust
      }
      Append-Line $fcLog (ConvertTo-Json $obj -Depth 6 -Compress)
      $existing[$key] = $true
      $backAdded++
    }
    Say ('  archive records added: ' + $backAdded)
  } catch {
    Say ('  backfill failed, continuing: ' + $_.Exception.Message)
  }
}

# ---------------------------------------------------------------- 4. observations

$obsHave = @{}
foreach ($rec in (Read-Jsonl $obsLog)) { $obsHave[$rec.date] = $true }

$obsAdded = 0
for ($back = 1; $back -le $ObsDays; $back++) {
  $day = (Get-Date).AddDays(-$back)
  $dk = $day.ToString('yyyy-MM-dd')
  if ($obsHave.ContainsKey($dk)) { continue }

  $stamp = $day.ToString('yyyyMMdd')
  $hourly = @{}
  $gustMax = $null
  $ok = $true
  foreach ($chunk in @('00', '03', '06', '09', '12', '15', '18', '21')) {
    $url = 'https://www.jma.go.jp/bosai/amedas/data/point/' + $AMEDAS_ID + '/' + $stamp + '_' + $chunk + '.json'
    try {
      $part = Get-JsonWithRetry $url 2
    } catch {
      $ok = $false
      continue
    }
    foreach ($p in $part.PSObject.Properties) {
      $ts = $p.Name              # yyyyMMddHHmmss
      $r = $p.Value
      $hr = [int]$ts.Substring(8, 2)
      if ($null -ne $r.wind -and $r.wind.Count -ge 2 -and [int]$r.wind[1] -eq 0) {
        $v = [double]$r.wind[0]
        if (-not $hourly.ContainsKey($hr) -or $v -gt $hourly[$hr]) { $hourly[$hr] = $v }
      }
      # The gust field is a running daily maximum, so taking the maximum over the
      # whole day is correct under either reading. Never slice it by window.
      if ($null -ne $r.gust -and $r.gust.Count -ge 2 -and [int]$r.gust[1] -eq 0) {
        $gv = [double]$r.gust[0]
        if ($null -eq $gustMax -or $gv -gt $gustMax) { $gustMax = $gv }
      }
    }
    Start-Sleep -Milliseconds 400
  }

  if ($hourly.Keys.Count -lt 20) {
    Say ('  observations for ' + $dk + ' incomplete (' + $hourly.Keys.Count + ' hours), skipping')
    continue
  }

  $arr = @()
  for ($h = 0; $h -lt 24; $h++) {
    if ($hourly.ContainsKey($h)) { $arr += (Round-Or-Null $hourly[$h] 1) } else { $arr += $null }
  }
  $obj = [ordered]@{
    date = $dk
    station = $AMEDAS_ID
    wind = $arr          # hourly maximum of the 10-minute mean wind, m/s
    gustMax = Round-Or-Null $gustMax 1
    complete = $ok
  }
  Append-Line $obsLog (ConvertTo-Json $obj -Depth 4 -Compress)
  $obsAdded++
  Say ('  observations recorded for ' + $dk)
}
Say ('observation days added: ' + $obsAdded)

# ---------------------------------------------------------------- 5. score

$fcRecs = Read-Jsonl $fcLog
$obsRecs = Read-Jsonl $obsLog

$obsByDate = @{}
foreach ($o in $obsRecs) { $obsByDate[$o.date] = $o }

# Lead-time buckets. Per-lead numbers would be too thin to read for a long time,
# and model skill really does change with lead time, so one bucket is not enough either.
$BUCKETS = @(
  @{ key = 'd1_3'; min = 1; max = 3 },
  @{ key = 'd4_7'; min = 4; max = 7 },
  @{ key = 'd8_16'; min = 8; max = 16 }
)

$series = @()
foreach ($m in $MODELS) { $series += $m }
$series += 'ens_p50'
$series += 'ens_p90'

$ALL_KEYS = @('archive', 'd1_3', 'd4_7', 'd8_16', 'all')

$acc = @{}
foreach ($s in $series) {
  $acc[$s] = @{}
  foreach ($k in $ALL_KEYS) {
    $acc[$s][$k] = @{ n = 0; sumAbs = 0.0; sumErr = 0.0 }
  }
}

$pairs = 0
$recent = @()

foreach ($f in $fcRecs) {
  if (-not $obsByDate.ContainsKey($f.target)) { continue }
  $o = $obsByDate[$f.target]

  $obsMax = $null
  for ($h = 0; $h -lt 24; $h++) {
    if (-not (Test-HourInWindow $h ([double]$f.from) ([double]$f.to))) { continue }
    $v = $o.wind[$h]
    if ($null -eq $v) { continue }
    if ($null -eq $obsMax -or $v -gt $obsMax) { $obsMax = [double]$v }
  }
  if ($null -eq $obsMax) { continue }
  $pairs++

  $vals = @{}
  foreach ($m in $MODELS) { $vals[$m] = $f.wind.$m }
  if ($null -ne $f.ens) {
    $vals['ens_p50'] = $f.ens.p50
    $vals['ens_p90'] = $f.ens.p90
  }

  foreach ($s in $series) {
    if (-not $vals.ContainsKey($s)) { continue }
    $v = $vals[$s]
    if ($null -eq $v) { continue }
    $err = [double]$v - $obsMax
    # Archive records are short-lead and must stay out of the lead-time buckets
    # and out of 'all'. Mixing them would flatter every model.
    $targets = @()
    if ($f.src -eq 'archive') {
      $targets = @('archive')
    } else {
      foreach ($b in $BUCKETS) {
        if ($f.lead -ge $b.min -and $f.lead -le $b.max) { $targets += $b.key }
      }
      $targets += 'all'
    }
    foreach ($k in $targets) {
      $acc[$s][$k].n++
      $acc[$s][$k].sumAbs += [math]::Abs($err)
      $acc[$s][$k].sumErr += $err
    }
  }

  if ($f.lead -eq 1 -or $f.src -eq 'archive') {
    $row = [ordered]@{ target = $f.target; obs = Round-Or-Null $obsMax 1; lead = $f.lead }
    if ($f.src -eq 'archive') { $row['src'] = 'archive' }
    foreach ($m in $MODELS) { $row[$m] = $f.wind.$m }
    if ($null -ne $f.ens) { $row['ens_p90'] = $f.ens.p90 }
    # Cast to PSCustomObject: Sort-Object -Property cannot see the keys of an
    # OrderedDictionary in PowerShell 5.1, so sorting silently does nothing.
    $recent += [pscustomobject]$row
  }
}

$stats = [ordered]@{}
foreach ($s in $series) {
  $entry = [ordered]@{}
  foreach ($k in $ALL_KEYS) {
    $a = $acc[$s][$k]
    if ($a.n -eq 0) {
      $entry[$k] = $null
    } else {
      $entry[$k] = [ordered]@{
        n = $a.n
        mae = [math]::Round($a.sumAbs / $a.n, 2)
        bias = [math]::Round($a.sumErr / $a.n, 2)
      }
    }
  }
  $stats[$s] = $entry
}

$recentTail = @()
if ($recent.Count -gt 0) {
  $sorted = @($recent | Sort-Object -Property target)
  $take = [math]::Min(14, $sorted.Count)
  $recentTail = @($sorted[($sorted.Count - $take)..($sorted.Count - 1)])
}

$out = [ordered]@{
  updated = (Get-Date).ToString('yyyy-MM-ddTHH:mmzzz')
  station = $AMEDAS_ID
  window = [ordered]@{ before = $WINDOW_BEFORE; after = $WINDOW_AFTER; period = 'morning' }
  models = $MODELS
  buckets = $ALL_KEYS
  forecastRecords = $fcRecs.Count
  obsDays = $obsRecs.Count
  pairs = $pairs
  stats = $stats
  recent = $recentTail
}

$json = ConvertTo-Json $out -Depth 8
$header = "/* generated by tools/Record-Forecast.ps1 - do not edit by hand */" + "`n"
$body = $header + 'window.VERIFY_DATA = ' + $json + ";`n"
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outJs, $body, $enc)

Say ('pairs scored: ' + $pairs + ' / forecast records: ' + $fcRecs.Count + ' / obs days: ' + $obsRecs.Count)
Say ('wrote ' + $outJs)
