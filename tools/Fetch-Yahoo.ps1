<#
.SYNOPSIS
    Fetch the weekly forecast table from Yahoo! JAPAN Weather point pages and emit data/yahoo.js.

.DESCRIPTION
    Yahoo! Weather publishes no forecast API (the YOLP weather API only returns rainfall
    intensity for the surrounding hour), so this reads the public point page and parses the
    "weekly forecast" table that the page renders server-side.

    WHAT IS AND IS NOT AVAILABLE
      Available on the web page : 6 days of Yahoo's own weather text, high/low temperature
                                  and precipitation probability, starting the day after tomorrow.
      NOT available on the web  : the reliability grade (A/B/C) and days 7-15. Those exist only
                                  inside the Yahoo Weather smartphone app, which talks to a
                                  private API. This script does not attempt to reach that.
      For a reliability grade, the app already shows the JMA weekly forecast confidence
      (A/B/C, 7 days) from assets/jma.js.

    The verified values match the app exactly for the overlapping days.

    POLITENESS
      Two pages per run, a handful of runs per day, with an identifying User-Agent.
      Do not lower the interval. This exists so one person can compare forecasts.

    NOTE: this file is deliberately ASCII-only, because Windows PowerShell 5.1 decodes .ps1
    files as the system ANSI code page unless they carry a UTF-8 BOM. Japanese characters are
    matched through \uXXXX regex escapes; Japanese place names live in assets/app.js.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\Fetch-Yahoo.ps1
#>
[CmdletBinding()]
param(
    [string] $OutDir = '',
    [switch] $AllowMissing
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $root = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
    if ([string]::IsNullOrWhiteSpace($root)) { throw 'Cannot determine the script directory; pass -OutDir explicitly.' }
    $OutDir = Join-Path $root '..\data'
}

# Yahoo point pages. One per boat spot in assets/spots.js (plus Tsunan, kept as a
# second opinion for the Joetsu area). When a spot is added there with a 'yahoo'
# code, add the matching page here or the Yahoo column stays empty for that spot.
$Points = @(
    [pscustomobject]@{ Code = '15222'; Ascii = 'Joetsu';   Url = 'https://weather.yahoo.co.jp/weather/jp/15/5430/15222.html' }
    [pscustomobject]@{ Code = '15482'; Ascii = 'Tsunan';   Url = 'https://weather.yahoo.co.jp/weather/jp/15/5420/15482.html' }
    [pscustomobject]@{ Code = '14201'; Ascii = 'Yokosuka'; Url = 'https://weather.yahoo.co.jp/weather/jp/14/4610/14201.html' }
    [pscustomobject]@{ Code = '14210'; Ascii = 'Miura';    Url = 'https://weather.yahoo.co.jp/weather/jp/14/4610/14210.html' }
    [pscustomobject]@{ Code = '14108'; Ascii = 'Kanazawa'; Url = 'https://weather.yahoo.co.jp/weather/jp/14/4610/14108.html' }
)

# The page labels dates in Japanese. Build those characters from code points so this
# file stays pure ASCII (see the note in the header about PowerShell 5.1 and encoding).
$C_YEAR = [string][char]0x5E74   # "year"
$C_MONTH = [string][char]0x6708  # "month"
$C_DAY = [string][char]0x65E5    # "day"
$C_HOUR = [string][char]0x6642   # "hour"
$C_MIN = [string][char]0x5206    # "minute"

# e.g. 7<month>30<day>
$RX_MONTH_DAY = '(\d{1,2})' + $C_MONTH + '(\d{1,2})' + $C_DAY
# e.g. 2026<year>7<month>28<day> 20<hour>00<minute>
$RX_ANNOUNCE = '(\d{4})' + $C_YEAR + '(\d{1,2})' + $C_MONTH + '(\d{1,2})' + $C_DAY +
    '\s*(\d{1,2})' + $C_HOUR + '(\d{1,2})' + $C_MIN

# ---------------------------------------------------------------- helpers

function Get-Page {
    param([string] $Url)
    $client = New-Object System.Net.WebClient
    $client.Encoding = [System.Text.Encoding]::UTF8
    # Identify the tool rather than pretending to be a browser.
    $ua = 'fishing-forecast/1.0 (personal forecast comparison; https://github.com/em-tommy/fishing-forecast)'
    $client.Headers.Add('User-Agent', $ua)
    try { return $client.DownloadString($Url) } finally { $client.Dispose() }
}

function Get-WeekSection {
    param([string] $Html)
    $i = $Html.IndexOf('id="yjw_week"')
    if ($i -lt 0) { return $null }
    $len = [Math]::Min(9000, $Html.Length - $i)
    return $Html.Substring($i, $len)
}

function Get-Rows {
    param([string] $Section)
    $t = [regex]::Match($Section, '(?s)<table.*?</table>')
    if (-not $t.Success) { return @() }
    return [regex]::Matches($t.Value, '(?s)<tr.*?</tr>')
}

function Strip-Tags {
    param([string] $Html)
    return (($Html -replace '(?s)<[^>]+>', ' ') -replace '\s+', ' ').Trim()
}

<#
    Rows are identified by what they contain rather than by their Japanese label,
    so a change in row order does not silently shift the columns.
#>
function ConvertFrom-WeekTable {
    param([string] $Section, [string] $Code, [string] $Ascii)

    $rows = Get-Rows $Section
    if ($rows.Count -lt 4) { throw "$Ascii : weekly table not found (rows=$($rows.Count))" }

    $dateRow = $null; $weatherRow = $null; $tempRow = $null; $popRow = $null
    foreach ($r in $rows) {
        $html = $r.Value
        if (-not $dateRow -and ([regex]::Matches($html, $RX_MONTH_DAY)).Count -ge 3) { $dateRow = $html; continue }
        if (-not $weatherRow -and ([regex]::Matches($html, 'alt="[^"]+"')).Count -ge 3) { $weatherRow = $html; continue }
        if (-not $tempRow -and $html -match '#ff3300') { $tempRow = $html; continue }
        if (-not $popRow -and ([regex]::Matches($html, '(?s)<small>\s*\d{1,3}\s*</small>')).Count -ge 3) { $popRow = $html; continue }
    }
    if (-not $dateRow) { throw "$Ascii : date row not found" }

    $dates = [regex]::Matches($dateRow, $RX_MONTH_DAY)
    $weathers = @()
    if ($weatherRow) { $weathers = [regex]::Matches($weatherRow, 'alt="([^"]+)"') }
    $highs = @()
    $lows = @()
    if ($tempRow) {
        $highs = [regex]::Matches($tempRow, '#ff3300"?>\s*(-?\d{1,2})\s*<')
        $lows = [regex]::Matches($tempRow, '#0066ff"?>\s*(-?\d{1,2})\s*<')
    }
    $pops = @()
    if ($popRow) { $pops = [regex]::Matches($popRow, '(?s)<small>\s*(\d{1,3})\s*</small>') }

    # The table shows month/day only. Derive the year from the announcement date and roll over.
    $ann = [regex]::Match($Section, $RX_ANNOUNCE)
    if ($ann.Success) {
        $annYear = [int] $ann.Groups[1].Value
        $annMonth = [int] $ann.Groups[2].Value
        $announced = '{0:0000}-{1:00}-{2:00}T{3:00}:{4:00}' -f $annYear, $annMonth,
            [int] $ann.Groups[3].Value, [int] $ann.Groups[4].Value, [int] $ann.Groups[5].Value
    } else {
        $now = Get-Date
        $annYear = $now.Year
        $annMonth = $now.Month
        $announced = $null
    }

    # PowerShell 5.1 cannot use an if-expression inside a hashtable literal,
    # so each value is computed first.
    $days = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $dates.Count; $i++) {
        $mo = [int] $dates[$i].Groups[1].Value
        $dd = [int] $dates[$i].Groups[2].Value
        if ($mo -lt $annMonth) { $year = $annYear + 1 } else { $year = $annYear }  # December -> January

        $weather = $null
        if ($i -lt $weathers.Count) { $weather = $weathers[$i].Groups[1].Value }
        $high = $null
        if ($i -lt $highs.Count) { $high = [int] $highs[$i].Groups[1].Value }
        $low = $null
        if ($i -lt $lows.Count) { $low = [int] $lows[$i].Groups[1].Value }
        $pop = $null
        if ($i -lt $pops.Count) { $pop = [int] $pops[$i].Groups[1].Value }

        # -f inside a hashtable literal breaks: its commas are read as entry separators.
        $dateKey = '{0:0000}-{1:00}-{2:00}' -f $year, $mo, $dd

        [void] $days.Add([pscustomobject]@{
            Date = $dateKey
            Weather = $weather
            High = $high
            Low = $low
            Pop = $pop
        })
    }

    return [pscustomobject]@{
        Code = $Code
        Announced = $announced
        Days = $days
    }
}

function Escape-Js {
    param([string] $Text)
    if ($null -eq $Text) { return 'null' }
    $t = $Text -replace '\\', '\\\\' -replace '"', '\"' -replace '[\r\n]', ' '
    return '"' + $t + '"'
}

function Num {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    return [string] $Value
}

# ---------------------------------------------------------------- main

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$parsed = New-Object System.Collections.ArrayList

foreach ($p in $Points) {
    Write-Host "Fetching $($p.Ascii) ($($p.Code)): $($p.Url)"
    try {
        $html = Get-Page $p.Url
        $section = Get-WeekSection $html
        if (-not $section) { throw 'weekly section (id="yjw_week") not found' }
        $rec = ConvertFrom-WeekTable -Section $section -Code $p.Code -Ascii $p.Ascii
        if ($rec.Days.Count -lt 3) { throw "only $($rec.Days.Count) days parsed" }
        Write-Host ("  -> {0} days, announced {1}" -f $rec.Days.Count, $rec.Announced)
        foreach ($d in $rec.Days) {
            Write-Host ("     {0}  high={1} low={2} pop={3}" -f $d.Date, $d.High, $d.Low, $d.Pop)
        }
        [void] $parsed.Add($rec)
    }
    catch {
        $msg = "Could not read $($p.Ascii) ($($p.Code)): $($_.Exception.Message)"
        if ($AllowMissing) { Write-Warning $msg; continue }
        throw $msg
    }
    Start-Sleep -Seconds 2   # be gentle: two pages, spaced out
}

if ($parsed.Count -eq 0) {
    if ($AllowMissing) { Write-Warning 'Nothing fetched; leaving the previous data in place.'; return }
    throw 'No Yahoo forecast could be fetched.'
}

# ---------------------------------------------------------------- emit

$stamp = (Get-Date).ToUniversalTime().AddHours(9).ToString('yyyy-MM-ddTHH:mm')
$sb = New-Object System.Text.StringBuilder
[void] $sb.AppendLine('// GENERATED FILE - do not edit by hand.')
[void] $sb.AppendLine('// Source: Yahoo! JAPAN Weather point pages (weekly forecast table).')
[void] $sb.AppendLine('// Regenerate: powershell -ExecutionPolicy Bypass -File tools\Fetch-Yahoo.ps1')
[void] $sb.AppendLine('(function () {')
# Braces are awkward inside -f format strings, so build these lines by concatenation.
[void] $sb.AppendLine('  var D = (window.YAHOO_DATA = { fetchedAt: "' + $stamp + '", points: {} });')
[void] $sb.AppendLine('  var p;')

foreach ($rec in $parsed) {
    [void] $sb.AppendLine('  p = D.points["' + $rec.Code + '"] = { code: "' + $rec.Code +
        '", announced: ' + (Escape-Js $rec.Announced) + ', days: {} };')
    foreach ($d in $rec.Days) {
        [void] $sb.AppendLine('  p.days["' + $d.Date + '"] = { weather: ' + (Escape-Js $d.Weather) +
            ', high: ' + (Num $d.High) + ', low: ' + (Num $d.Low) + ', pop: ' + (Num $d.Pop) + ' };')
    }
}

[void] $sb.AppendLine('})();')

$null = New-Item -ItemType Directory -Force -Path $OutDir
$outPath = Join-Path (Resolve-Path $OutDir) 'yahoo.js'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outPath, $sb.ToString(), $utf8NoBom)
Write-Host "Wrote $outPath" -ForegroundColor Green
