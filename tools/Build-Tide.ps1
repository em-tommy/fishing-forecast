<#
.SYNOPSIS
    Download the JMA (Japan Meteorological Agency) annual tide table text file and
    emit data/tide-<year>.js, loadable from the browser via a plain <script> tag.

.DESCRIPTION
    Source: https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/<year>/<code>.txt

    Fixed-width record layout (verified against real 2026 data). 1-based columns:
        1 - 72   hourly tide level in cm, 3 chars x 24 hours (00:00-23:00, may be negative)
       73 - 78   date as YY MM DD, 2 chars each, space padded
       79 - 80   station code, 2 chars
       81 - 108  high tides: (HHMM 4 chars + level 3 chars) x 4
      109 - 136  low tides:  same layout x 4
      Absent entries are marked with time 9999 / level 999.

    The time field is "hour(2) + minute(2)", each right-aligned with spaces, so
    " 4 8" means 04:08. It must NOT be parsed as a single integer.

    NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 decodes .ps1
    files as the system ANSI code page unless they carry a UTF-8 BOM, so any non-ASCII
    character here would corrupt the script. Japanese station names are emitted into
    the generated JavaScript as \uXXXX escapes instead.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Build-Tide.ps1 -Year 2026
    pwsh -File tools/Build-Tide.ps1 -Year 2026
#>
[CmdletBinding()]
param(
    [int] $Year = 0,
    [string] $OutDir = '',
    [switch] $AllowMissing
)

$ErrorActionPreference = 'Stop'

if ($Year -le 0) { $Year = (Get-Date).Year }

# $PSScriptRoot is not reliably populated inside param() defaults, so resolve it here.
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $root = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
    if ([string]::IsNullOrWhiteSpace($root)) { throw 'Cannot determine the script directory; pass -OutDir explicitly.' }
    $OutDir = Join-Path $root '..\data'
}

# Tide stations, by JMA station code. Display names are intentionally NOT stored here:
# the generated file carries data only, and assets/app.js supplies the Japanese labels.
$Stations = @(
    [pscustomobject]@{ Code = 'T3'; Ascii = 'Naoetsu';  Lat = 37.183; Lon = 138.250 }
    [pscustomobject]@{ Code = 'TK'; Ascii = 'Tokyo';    Lat = 35.650; Lon = 139.767 }
    [pscustomobject]@{ Code = 'QS'; Ascii = 'Yokohama'; Lat = 35.450; Lon = 139.650 }
    [pscustomobject]@{ Code = 'QN'; Ascii = 'Yokosuka'; Lat = 35.288; Lon = 139.665 }
)

$BaseUrl = 'https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt'

# ---------------------------------------------------------------- helpers

function Get-Field {
    # Slice by 1-based column position, tolerating short lines.
    param([string] $Line, [int] $Start, [int] $Length)
    $i = $Start - 1
    if ($i -ge $Line.Length) { return '' }
    $len = [Math]::Min($Length, $Line.Length - $i)
    return $Line.Substring($i, $len)
}

function ConvertTo-IntOrNull {
    param([string] $Text)
    $t = $Text.Trim()
    if ($t -eq '') { return $null }
    $n = 0
    if ([int]::TryParse($t, [ref] $n)) { return $n }
    return $null
}

function Read-Extreme {
    # One high/low tide entry (7 chars) -> [hhmm, cm]; $null when absent.
    param([string] $Chunk)
    if ($Chunk.Length -lt 7) { return $null }
    $hh = ConvertTo-IntOrNull (Get-Field $Chunk 1 2)
    $mm = ConvertTo-IntOrNull (Get-Field $Chunk 3 2)
    $cm = ConvertTo-IntOrNull (Get-Field $Chunk 5 3)
    if ($null -eq $hh -or $null -eq $mm -or $null -eq $cm) { return $null }
    if ($hh -eq 99 -and $mm -eq 99) { return $null }   # absent marker
    if ($cm -eq 999) { return $null }
    if ($hh -gt 23 -or $mm -gt 59) { return $null }
    return , @(($hh * 100 + $mm), $cm)
}

function ConvertFrom-TideLine {
    param([string] $Line, [string] $ExpectCode, [int] $ExpectYear)

    if ($Line.Trim() -eq '') { return $null }

    $code = (Get-Field $Line 79 2).Trim()
    if ($code -ne $ExpectCode) {
        throw "Station code mismatch: expected=$ExpectCode actual='$code' line=[$Line]"
    }

    $yy = ConvertTo-IntOrNull (Get-Field $Line 73 2)
    $mo = ConvertTo-IntOrNull (Get-Field $Line 75 2)
    $dd = ConvertTo-IntOrNull (Get-Field $Line 77 2)
    if ($null -eq $yy -or $null -eq $mo -or $null -eq $dd) {
        throw "Cannot parse date: line=[$Line]"
    }
    $full = 2000 + $yy
    if ($full -ne $ExpectYear) {
        throw "Year mismatch: expected=$ExpectYear actual=$full"
    }
    $date = '{0:0000}-{1:00}-{2:00}' -f $full, $mo, $dd

    $hourly = New-Object int[] 24
    for ($h = 0; $h -lt 24; $h++) {
        $v = ConvertTo-IntOrNull (Get-Field $Line (1 + $h * 3) 3)
        if ($null -eq $v) { throw "Missing hourly level: $date hour=$h line=[$Line]" }
        $hourly[$h] = $v
    }

    $high = New-Object System.Collections.ArrayList
    for ($k = 0; $k -lt 4; $k++) {
        $e = Read-Extreme (Get-Field $Line (81 + $k * 7) 7)
        if ($null -ne $e) { [void] $high.Add($e) }
    }
    $low = New-Object System.Collections.ArrayList
    for ($k = 0; $k -lt 4; $k++) {
        $e = Read-Extreme (Get-Field $Line (109 + $k * 7) 7)
        if ($null -ne $e) { [void] $low.Add($e) }
    }

    return [pscustomobject]@{
        Date   = $date
        Hourly = $hourly
        High   = $high
        Low    = $low
    }
}

function Format-Extremes {
    param($Items)
    if ($Items.Count -eq 0) { return '[]' }
    $parts = foreach ($it in $Items) { '[{0},{1}]' -f $it[0], $it[1] }
    return '[' + ($parts -join ',') + ']'
}

# ---------------------------------------------------------------- main

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$parsed = @{}
$ok = New-Object System.Collections.ArrayList

foreach ($st in $Stations) {
    $url = "$BaseUrl/$Year/$($st.Code).txt"
    Write-Host "Fetching $($st.Ascii) ($($st.Code)): $url"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("jma-tide-{0}-{1}.txt" -f $Year, $st.Code)
    try {
        # Route through -OutFile so PS 5.1 and pwsh behave identically
        # (Invoke-WebRequest .Content is string in one and byte[] in the other).
        Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 60 -OutFile $tmp
        $text = [System.IO.File]::ReadAllText($tmp, [Text.Encoding]::ASCII)
    }
    catch {
        $msg = "Could not fetch $($st.Ascii) ($($st.Code)) for $Year : $($_.Exception.Message)"
        if ($AllowMissing) { Write-Warning $msg; continue }
        throw $msg
    }

    $lines = $text -split "`r?`n" | Where-Object { $_.Trim() -ne '' }
    $days = New-Object System.Collections.ArrayList
    foreach ($line in $lines) {
        $d = ConvertFrom-TideLine -Line $line -ExpectCode $st.Code -ExpectYear $Year
        if ($null -ne $d) { [void] $days.Add($d) }
    }

    if ([DateTime]::IsLeapYear($Year)) { $expected = 366 } else { $expected = 365 }
    if ($days.Count -ne $expected) {
        Write-Warning "$($st.Ascii): got $($days.Count) days (expected $expected)"
    }
    $nHigh = (($days | ForEach-Object { $_.High.Count }) | Measure-Object -Sum).Sum
    $nLow = (($days | ForEach-Object { $_.Low.Count }) | Measure-Object -Sum).Sum
    Write-Host ("  -> {0} days, {1} high tides, {2} low tides" -f $days.Count, $nHigh, $nLow)

    $parsed[$st.Code] = $days
    [void] $ok.Add($st)
}

if ($ok.Count -eq 0) {
    # Next year's tide table is only published early in the year, so a scheduled
    # run that finds nothing is expected rather than a failure.
    if ($AllowMissing) {
        Write-Warning "No station data available for $Year yet; nothing written."
        return
    }
    throw 'No station data could be fetched.'
}

# Self-check: Yokohama 2026-01-01 is high 04:08/163cm, 14:08/169cm; low 08:58/123cm, 21:32/1cm
if ($Year -eq 2026 -and $parsed.ContainsKey('QS')) {
    $d0 = $parsed['QS'] | Where-Object { $_.Date -eq '2026-01-01' }
    $sig = (Format-Extremes $d0.High) + '/' + (Format-Extremes $d0.Low)
    $want = '[[408,163],[1408,169]]/[[858,123],[2132,1]]'
    if ($sig -ne $want) { throw "Self-check failed. expected=$want actual=$sig" }
    Write-Host 'Self-check OK: Yokohama 2026-01-01 matches the published JMA tide table' -ForegroundColor Green
}

# ---------------------------------------------------------------- emit

$sb = New-Object System.Text.StringBuilder
[void] $sb.AppendLine('// GENERATED FILE - do not edit by hand.')
[void] $sb.AppendLine("// Source: JMA tide tables, $BaseUrl/$Year/")
[void] $sb.AppendLine("// Regenerate: powershell -ExecutionPolicy Bypass -File tools\Build-Tide.ps1 -Year $Year")
[void] $sb.AppendLine('(function () {')
[void] $sb.AppendLine('  var D = (window.TIDE_DATA = window.TIDE_DATA || { years: [], stations: {} });')
[void] $sb.AppendLine("  if (D.years.indexOf($Year) < 0) D.years.push($Year);")
[void] $sb.AppendLine('  function st(c, la, lo) {')
[void] $sb.AppendLine('    return D.stations[c] || (D.stations[c] = { code: c, lat: la, lon: lo, days: {} });')
[void] $sb.AppendLine('  }')
[void] $sb.AppendLine('  var s, d;')

foreach ($st in $ok) {
    [void] $sb.AppendLine(('  s = st("{0}", {1}, {2}); d = s.days;' -f $st.Code, $st.Lat, $st.Lon))
    foreach ($day in $parsed[$st.Code]) {
        [void] $sb.AppendLine(('  d["{0}"]={{h:[{1}],hi:{2},lo:{3}}};' -f `
            $day.Date, ($day.Hourly -join ','), (Format-Extremes $day.High), (Format-Extremes $day.Low)))
    }
}

[void] $sb.AppendLine('})();')

$null = New-Item -ItemType Directory -Force -Path $OutDir
$outPath = Join-Path (Resolve-Path $OutDir) "tide-$Year.js"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outPath, $sb.ToString(), $utf8NoBom)

$kb = [Math]::Round((Get-Item $outPath).Length / 1KB, 1)
Write-Host "Wrote $outPath ($kb KB)" -ForegroundColor Green

# ---------------------------------------------------------------- wire up the HTML

# Keep the <script> tags in sync with whatever tide-*.js files now exist, so that
# generating next year's table is enough to make the pages load it (year rollover).
$siteRoot = Split-Path -Parent (Resolve-Path $OutDir)
$years = Get-ChildItem -Path $OutDir -Filter 'tide-*.js' |
    ForEach-Object { if ($_.BaseName -match '^tide-(\d{4})$') { [int] $Matches[1] } } |
    Sort-Object

$tags = ($years | ForEach-Object { '<script src="data/tide-{0}.js"></script>' -f $_ }) -join "`n"
$block = "<!-- tide-data:start / rewritten by tools/Build-Tide.ps1 -->`n" +
    $tags + "`n<!-- tide-data:end -->"

foreach ($page in @('index.html', 'tests.html')) {
    $path = Join-Path $siteRoot $page
    if (-not (Test-Path $path)) { continue }
    $html = [System.IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    $pattern = '(?s)<!-- tide-data:start.*?<!-- tide-data:end -->'
    if ($html -notmatch $pattern) {
        Write-Warning "$page has no tide-data marker block; skipping."
        continue
    }
    $updated = [regex]::Replace($html, $pattern, [System.Text.RegularExpressions.MatchEvaluator] { param($m) $block })
    if ($updated -ne $html) {
        [System.IO.File]::WriteAllText($path, $updated, $utf8NoBom)
        Write-Host "Updated tide script tags in $page ($($years -join ', '))"
    }
}
