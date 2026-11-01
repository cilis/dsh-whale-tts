#requires -Version 5.1
<#
.SYNOPSIS
    Synthesise text to a WAV file with Windows SAPI5 (System.Speech).

.DESCRIPTION
    Used by the dsh-whale-tts `sapi` provider adapter. Kept compatible with
    Windows PowerShell 5.1 (the version shipped with Windows 10/11).

    The text arrives in a UTF-8 file instead of on the command line so quotes,
    newlines and non-ASCII characters cannot break the invocation or depend on
    the console code page.

    Output is 16 kHz, 16-bit, mono PCM WAV (a good default for voice messages).

.PARAMETER TextFile
    UTF-8 file holding the text to speak.

.PARAMETER OutFile
    WAV file to create. An existing file is overwritten.

.PARAMETER Voice
    Installed SAPI voice name. Matched exactly first, then by substring.
    When the name is unknown or missing, a warning goes to stderr and the
    system default voice is used.

.PARAMETER Rate
    SAPI speaking rate, -10..10 (0 is normal). Omitted means 0.

.NOTES
    Exit codes: 0 success, 1 synthesis failure, 2 bad input
    (missing text file or empty text).
#>
param(
    [Parameter(Mandatory = $true)][string]$TextFile,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$Voice = '',
    [int]$Rate = 0
)

$ErrorActionPreference = 'Stop'

# stderr helper: Write-Error is affected by $ErrorActionPreference and adds
# powershell-specific formatting, so write the plain message instead.
function Write-SapiError([string]$Message) {
    [Console]::Error.WriteLine("sapi: $Message")
}

try {
    # ---- input validation -------------------------------------------------
    if (-not (Test-Path -LiteralPath $TextFile -PathType Leaf)) {
        Write-SapiError "text file not found: $TextFile"
        exit 2
    }

    $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($text)) {
        Write-SapiError 'text file is empty'
        exit 2
    }

    Add-Type -AssemblyName System.Speech

    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        # ---- voice selection ---------------------------------------------
        if ($Voice -ne '') {
            $selected = $false
            try {
                $synth.SelectVoice($Voice)
                $selected = $true
            }
            catch {
                # Unknown exact name; try a substring match below.
            }

            if (-not $selected) {
                $match = @(
                    $synth.GetInstalledVoices() |
                        Where-Object {
                            $_.Enabled -and (
                                $_.VoiceInfo.Name -eq $Voice -or
                                $_.VoiceInfo.Name -like "*$Voice*"
                            )
                        } |
                        Select-Object -First 1
                )
                if ($match.Count -gt 0) {
                    try {
                        $synth.SelectVoice($match[0].VoiceInfo.Name)
                        $selected = $true
                    }
                    catch {
                        # Fall through to the default voice.
                    }
                }
            }

            if (-not $selected) {
                Write-SapiError "voice '$Voice' is not installed; using the default voice"
            }
        }

        # ---- rate ---------------------------------------------------------
        if ($PSBoundParameters.ContainsKey('Rate')) {
            $clamped = [Math]::Max(-10, [Math]::Min(10, $Rate))
            $synth.Rate = $clamped
        }

        # ---- output -------------------------------------------------------
        $directory = [System.IO.Path]::GetDirectoryName($OutFile)
        if ($directory -and -not (Test-Path -LiteralPath $directory)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }

        $audioFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
            16000,
            [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
            [System.Speech.AudioFormat.AudioChannel]::Mono
        )
        $synth.SetOutputToWaveFile($OutFile, $audioFormat)
        $synth.Speak($text)
    }
    finally {
        $synth.Dispose()
    }

    $bytes = (Get-Item -LiteralPath $OutFile).Length
    [Console]::Out.WriteLine('{"ok":true,"bytes":' + $bytes + '}')
    exit 0
}
catch {
    Write-SapiError $_.Exception.Message
    exit 1
}
