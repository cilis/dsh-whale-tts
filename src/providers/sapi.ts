/**
 * `sapi` provider adapter: Windows SAPI5 speech synthesis through the bundled
 * PowerShell script (`scripts/sapi.ps1`).
 *
 * This is the offline fallback: it needs no key and no network, only Windows.
 * Text travels through a temporary UTF-8 file (never a command line) so quotes,
 * newlines and non-ASCII text cannot become command injection or get mangled by
 * the console code page. Temporary files are always removed.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { validateAudio } from '../core/audio.js'
import { expandTemplate } from '../core/paths.js'
import {
  TtsError,
  redact,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderRuntime,
  type SynthesisRequest,
  type SynthesisResult,
} from '../types.js'

/** Fallbacks used when the provider block omits a key. */
const SAPI_DEFAULTS = {
  timeoutMs: 60_000,
} as const

/** Provider id; also the `provider` field of every error it raises. */
const PROVIDER = 'sapi'

/** SAPI always emits a WAV file. */
const FORMAT = 'wav' as const

const CAPABILITIES: ProviderCapabilities = {
  speech: true,
  singing: false,
  formats: [FORMAT],
  // Installed voices are machine-specific; the script reports the real ones.
  voices: [],
  requiresKey: false,
  voiceDesign: false,
  voiceClone: false,
  platforms: ['win32'],
}

/** Longest timeout we accept, mirroring the config schema ceiling. */
const MAX_TIMEOUT_MS = 600_000

/** Cap on captured child-process output. */
const MAX_PROCESS_OUTPUT = 8192

/** Longest child stderr text echoed into an error message. */
const MAX_ERROR_SNIPPET = 300

// ---------------------------------------------------------------------------
// Invocation builder (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Inputs for {@link buildSapiInvocation}. */
export interface SapiInvocationOptions {
  /** Absolute path of `sapi.ps1`. */
  readonly scriptPath: string
  /** Temporary UTF-8 file holding the text to speak. */
  readonly textFile: string
  /** Temporary WAV file the script writes. */
  readonly outFile: string
  /** SAPI voice name; empty/omitted means "system default". */
  readonly voiceName?: string
  /** SAPI rate in -10..10; `0`/omitted means "script default". */
  readonly rate?: number
  /** Environment used to locate `powershell.exe`, injectable for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** One deterministic process invocation. */
export interface SapiInvocation {
  readonly command: string
  readonly args: string[]
}

/** First non-empty (after trimming) string, or `undefined`. */
function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed !== '') return trimmed
    }
  }
  return undefined
}

/**
 * Absolute `powershell.exe` path derived from the environment, or the bare
 * command name (PATH lookup) when the environment does not name a system root.
 */
function powershellCommand(
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const systemRoot = firstNonEmpty(env['SystemRoot'], env['SYSTEMROOT'], env['windir'], env['WINDIR'])
  if (systemRoot === undefined) return 'powershell'
  const root = systemRoot.replace(/[\\/]+$/, '')
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * Normalise the configured rate: rounded, clamped to -10..10, with the neutral
 * `0` treated as "not set" so it never emits a flag.
 */
function normalizeSapiRate(rate: number | undefined): number | undefined {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return undefined
  const rounded = Math.round(rate)
  if (rounded === 0) return undefined
  return Math.max(-10, Math.min(10, rounded))
}

/**
 * Build the deterministic PowerShell invocation for one synthesis.
 *
 * Kept free of random names/clock reads so the arguments can be asserted by
 * unit tests. Voice and rate flags only appear when they carry a value.
 *
 * @param options - script and temporary file paths plus optional overrides.
 * @returns the command and its argument list.
 */
export function buildSapiInvocation(options: SapiInvocationOptions): SapiInvocation {
  const voiceName = typeof options.voiceName === 'string' ? options.voiceName.trim() : ''
  const rate = normalizeSapiRate(options.rate)
  const args: string[] = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    options.scriptPath,
    '-TextFile',
    options.textFile,
    '-OutFile',
    options.outFile,
  ]
  if (voiceName !== '') args.push('-Voice', voiceName)
  if (rate !== undefined) args.push('-Rate', String(rate))
  return { command: powershellCommand(options.env ?? {}), args }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp the configured timeout into a sane range. */
function timeoutFor(config: ProviderConfig, fallback: number): number {
  const configured = config.timeoutMs
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return fallback
  }
  return Math.max(1, Math.min(Math.floor(configured), MAX_TIMEOUT_MS))
}

/** Message of any thrown value, without its stack. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Remove the text being synthesised from provider output before echoing it. */
function scrubSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text
  for (const secret of secrets) {
    if (secret.length >= 3) scrubbed = scrubbed.split(secret).join('***')
  }
  return redact(scrubbed).replace(/\s+/g, ' ').trim()
}

/** Resolve the script path: configured template first, bundled script otherwise. */
function scriptPathFor(config: ProviderConfig, runtime: ProviderRuntime): string {
  const configured = (config.scriptPath ?? '').trim()
  if (configured === '') return runtime.paths.sapiScript
  return expandTemplate(configured, {
    env: runtime.env,
    home: runtime.env['USERPROFILE'] ?? runtime.env['HOME'],
    tmp: runtime.env['TEMP'] ?? runtime.env['TMP'],
  })
}

/** Result of one finished child process. */
interface ProcessOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Cancellation requested by the tool/HTTP caller. */
function abortError(provider: string): TtsError {
  return new TtsError('aborted', 'synthesis aborted', { provider })
}

/** The adapter's own deadline expired. */
function timeoutError(provider: string, timeoutMs: number): TtsError {
  return new TtsError('timeout', `${provider} request timed out after ${timeoutMs}ms`, {
    provider,
    retryable: true,
  })
}

/**
 * Run PowerShell to completion, observing both the caller abort signal and the
 * adapter timeout. Killing the child is best effort.
 *
 * @param options - invocation, deadline and caller signal.
 * @returns exit code plus captured stdout/stderr.
 */
function runPowerShell(options: {
  readonly invocation: SapiInvocation
  readonly timeoutMs: number
  readonly request: SynthesisRequest
  readonly provider: string
}): Promise<ProcessOutcome> {
  const { invocation, timeoutMs, request, provider } = options
  return new Promise<ProcessOutcome>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(abortError(provider))
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation.command, invocation.args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(
        new TtsError(
          'provider',
          `${provider} failed to start PowerShell: ${redact(messageOf(error))}`,
          { provider, retryable: false, cause: error },
        ),
      )
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
    }
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }
    const stopChild = (): void => {
      try {
        child.kill()
      } catch {
        // Already exited.
      }
    }
    const appendOutput = (current: string, chunk: unknown): string => {
      if (current.length >= MAX_PROCESS_OUTPUT) return current
      return (current + String(chunk)).slice(0, MAX_PROCESS_OUTPUT)
    }
    const onAbort = (): void => {
      finish(() => {
        stopChild()
        reject(abortError(provider))
      })
    }

    request.signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      finish(() => {
        stopChild()
        reject(timeoutError(provider, timeoutMs))
      })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: unknown) => {
      stdout = appendOutput(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      stderr = appendOutput(stderr, chunk)
    })
    child.on('error', (error: Error) => {
      finish(() => {
        reject(
          new TtsError(
            'provider',
            `${provider} failed to run PowerShell: ${redact(error.message)}`,
            { provider, retryable: false, cause: error },
          ),
        )
      })
    })
    child.on('close', (code: number | null) => {
      finish(() => {
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Windows SAPI adapter.
 *
 * Runs the bundled script with the text in a temporary UTF-8 file, then reads
 * the produced WAV back and validates its magic bytes. Never available off
 * Windows and never requires a credential.
 */
export const sapiAdapter: ProviderAdapter = {
  id: PROVIDER,

  capabilities: CAPABILITIES,

  async synthesize(
    request: SynthesisRequest,
    config: ProviderConfig,
    runtime: ProviderRuntime,
  ): Promise<SynthesisResult> {
    if (runtime.platform !== 'win32') {
      throw new TtsError('platform', 'sapi is only available on Windows', {
        provider: PROVIDER,
        retryable: false,
        detail: { platform: runtime.platform },
      })
    }
    if (request.signal.aborted) throw abortError(PROVIDER)

    const timeoutMs = timeoutFor(config, SAPI_DEFAULTS.timeoutMs)
    // `voiceName` is the SAPI-specific knob and wins over the generic voice
    // fields, which usually carry a preset id belonging to another provider.
    const voiceName = firstNonEmpty(config.voiceName, request.voice, config.voice)
    const rate = normalizeSapiRate(config.rate)
    const scriptPath = scriptPathFor(config, runtime)

    const token = randomBytes(8).toString('hex')
    const textFile = join(runtime.paths.stateDir, `sapi-${token}.txt`)
    const outFile = join(runtime.paths.stateDir, `sapi-${token}.wav`)

    try {
      try {
        await mkdir(runtime.paths.stateDir, { recursive: true })
        await writeFile(textFile, request.text, 'utf8')
      } catch (error) {
        throw new TtsError(
          'config',
          `sapi could not prepare temporary files: ${redact(messageOf(error))}`,
          { provider: PROVIDER, retryable: false, cause: error },
        )
      }

      let invocation = buildSapiInvocation({
        scriptPath,
        textFile,
        outFile,
        voiceName,
        rate,
        env: runtime.env,
      })
      if (invocation.command !== 'powershell' && !existsSync(invocation.command)) {
        runtime.logger.warn(
          '[whale-tts] sapi: PowerShell not found at %s; falling back to PATH',
          invocation.command,
        )
        invocation = buildSapiInvocation({
          scriptPath,
          textFile,
          outFile,
          voiceName,
          rate,
          env: {},
        })
      }

      runtime.logger.debug?.(
        `[whale-tts] sapi synthesising (voice=${voiceName ?? 'default'} ` +
          `rate=${rate ?? 'default'} timeoutMs=${timeoutMs})`,
      )

      const outcome = await runPowerShell({
        invocation,
        timeoutMs,
        request,
        provider: PROVIDER,
      })
      if (outcome.code !== 0) {
        const detail = scrubSecrets(outcome.stderr, [request.text]).slice(0, MAX_ERROR_SNIPPET)
        throw new TtsError(
          'provider',
          `${PROVIDER} exited with code ${outcome.code}${detail === '' ? '' : `: ${detail}`}`,
          {
            provider: PROVIDER,
            retryable: false,
            detail: { exitCode: outcome.code },
          },
        )
      }

      let data: Uint8Array
      try {
        data = new Uint8Array(await readFile(outFile))
      } catch (error) {
        throw new TtsError('provider', `${PROVIDER} did not produce an audio file`, {
          provider: PROVIDER,
          retryable: false,
          cause: error,
        })
      }
      const validated = validateAudio(data, FORMAT, PROVIDER)

      return {
        data,
        format: validated,
        voice: voiceName ?? 'system-default',
        meta: { script: scriptPath, bytes: data.byteLength },
      }
    } finally {
      // Temporary files never outlive the call, on success or failure.
      await rm(textFile, { force: true }).catch(() => undefined)
      await rm(outFile, { force: true }).catch(() => undefined)
    }
  },
}
