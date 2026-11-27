# Lee la sesion multimedia de Windows (SMTC) y emite una linea JSON cada ~300 ms.
# Funciona con Spotify (app y web), YouTube, YouTube Music, Apple Music, Deezer, Tidal, etc.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($winRtTask, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $netTask = $asTask.Invoke($null, @($winRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$tMgr   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$tProps = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  $mgr = Await ($tMgr::RequestAsync()) $tMgr
} catch {
  Emit ([ordered]@{ active = $false; fatal = $true; error = $_.Exception.Message })
  exit 1
}

# Plan B para Spotify de escritorio cuando Windows no lo registra como reproductor:
# su ventana muestra "Artista - Canción" mientras suena y "Spotify Free/Premium" en pausa.
$script:lastSpot = $null
$script:spotTick = 0
$script:props = $null
$script:propsApp = ''
$script:propsEnd = -1
function Update-Spotify {
  $p = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  if (-not $p) { $script:lastSpot = $null; return }
  $t = [string]$p.MainWindowTitle
  if ($t -notmatch '^Spotify( Free| Premium)?$' -and $t -match '^(?<a>.+?) - (?<t>.+)$') {
    $script:lastSpot = @{ artist = $Matches['a']; title = $Matches['t']; playing = $true }
  } elseif ($script:lastSpot) {
    $script:lastSpot.playing = $false
  }
}

while ($true) {
  try {
    if (($script:spotTick % 5) -eq 0) { Update-Spotify }
    $script:spotTick++
    $chosen = $null
    $seen = @()
    foreach ($s in $mgr.GetSessions()) {
      $st = ''
      try { $st = $s.GetPlaybackInfo().PlaybackStatus.ToString() } catch { $st = 'error' }
      $seen += ([string]$s.SourceAppUserModelId + ' [' + $st + ']')
      if (-not $chosen -and $st -eq 'Playing') { $chosen = $s }
    }
    if (-not $chosen) { $chosen = $mgr.GetCurrentSession() }

    $hasSpotSession = [bool]($seen | Where-Object { $_ -match 'spotify' })
    $otherPlaying = $false
    if ($chosen) { $otherPlaying = ($chosen.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') }
    if ((-not $hasSpotSession) -and $script:lastSpot -and (-not $otherPlaying)) {
      $nowFb = [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      Emit ([ordered]@{
        active = $true; title = [string]$script:lastSpot.title; artist = [string]$script:lastSpot.artist; album = ''
        app = 'Spotify.exe (por título de ventana)'; playing = [bool]$script:lastSpot.playing
        positionMs = 0; durationMs = 0; updatedMs = 0; nowMs = $nowFb; hasTimeline = $false
        sessions = @($seen)
      })
      Start-Sleep -Milliseconds 200
      continue
    }

    if (-not $chosen) {
      Emit ([ordered]@{ active = $false; sessions = @($seen) })
    } else {
      $tl      = $chosen.GetTimelineProperties()
      $appId   = [string]$chosen.SourceAppUserModelId
      $endChk  = [int64]$tl.EndTime.TotalMilliseconds
      # El título/artista se pide solo cada ~1 s o si cambia la app o la duración (pedirlo cada 200 ms gastaba CPU)
      if ((-not $script:props) -or ($script:propsApp -ne $appId) -or ($script:propsEnd -ne $endChk) -or (($script:spotTick % 5) -eq 0)) {
        $script:props = Await ($chosen.TryGetMediaPropertiesAsync()) $tProps
        $script:propsApp = $appId
        $script:propsEnd = $endChk
      }
      $props   = $script:props
      $nowMs   = [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $playing = ($chosen.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing')
      $endMs   = [int64]$tl.EndTime.TotalMilliseconds
      $startMs = [int64]$tl.StartTime.TotalMilliseconds
      $posMs   = [int64]$tl.Position.TotalMilliseconds
      $updMs   = [int64]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
      Emit ([ordered]@{
        active      = $true
        title       = [string]$props.Title
        artist      = [string]$props.Artist
        album       = [string]$props.AlbumTitle
        app         = [string]$chosen.SourceAppUserModelId
        playing     = $playing
        positionMs  = $posMs
        durationMs  = ($endMs - $startMs)
        updatedMs   = $updMs
        nowMs       = $nowMs
        hasTimeline = ($endMs -gt 0)
        sessions    = @($seen)
      })
    }
  } catch {
    Emit ([ordered]@{ active = $false; error = $_.Exception.Message })
  }
  Start-Sleep -Milliseconds 200
}
