/**
 * Provider resolution, retry policy and fallback chain.
 *
 * Contract (design §七):
 * - validation errors never retry and never fall back;
 * - retryable errors (timeout / network / 429 / 5xx) retry once per provider,
 *   then move along `fallback`;
 * - everything else (auth / quota / content-filter / platform / not-implemented)
 *   moves along `fallback` without retrying;
 * - when every provider fails, one aggregate `TtsError` names each reason.
 */
import type {
  LoggerLike,
  ProviderAdapter,
  ProviderConfig,
  ProviderRuntime,
  SynthesisRequest,
  SynthesisResult,
} from '../types.js'
import { TtsError, asTtsError, isTtsError } from '../types.js'
import {
  BUILTIN_ADAPTERS,
  adapterAvailable,
  getAdapter,
  providerConfigFor,
} from '../providers/registry.js'

/** One provider attempt, as reported by the aggregate error. */
export interface ChainAttempt {
  readonly provider: string
  readonly ok: boolean
  readonly skipped?: 'disabled' | 'platform' | 'missing-key' | 'unknown-adapter'
  readonly error?: TtsError
}

/** Successful chain outcome. */
export interface ChainSuccess {
  readonly result: SynthesisResult
  readonly provider: string
  readonly attempts: readonly ChainAttempt[]
}

/** Chain inputs. */
export interface ChainOptions {
  readonly provider: string
  readonly fallback: readonly string[]
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly request: SynthesisRequest
  readonly runtime: ProviderRuntime
  readonly adapters?: ReadonlyMap<string, ProviderAdapter>
  readonly logger?: LoggerLike
  /** Inject a sleep for tests; defaults to a real timer. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Default retry delay: rate limits wait longer than transient failures. */
export function retryDelayMs(kind: string, attempt: number): number {
  const base = kind === 'rate-limit' ? 1000 : 250
  return Math.min(base * Math.pow(2, attempt), 4000)
}

/** Real timer sleep that rejects with an aborted error. */
export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new TtsError('aborted', 'synthesis aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectPromise(new TtsError('aborted', 'synthesis aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Providers to try, primary first, deduplicated, empties removed. */
export function attemptOrder(
  provider: string,
  fallback: readonly string[],
): string[] {
  const order: string[] = []
  for (const candidate of [provider, ...fallback]) {
    const id = typeof candidate === 'string' ? candidate.trim() : ''
    if (id !== '' && !order.includes(id)) order.push(id)
  }
  return order
}

/** Summary of a failed chain used to build the aggregate error message. */
export function describeFailures(attempts: readonly ChainAttempt[]): string {
  return attempts
    .map((attempt) => {
      if (attempt.skipped === 'disabled') return `${attempt.provider} disabled`
      if (attempt.skipped === 'platform') return `${attempt.provider} unavailable on this platform`
      if (attempt.skipped === 'missing-key') return `${attempt.provider} credential not configured`
      if (attempt.skipped === 'unknown-adapter') return `${attempt.provider} unknown provider`
      const error = attempt.error
      const status = error?.status === undefined ? '' : ` ${error.status}`
      return `${attempt.provider}${status} ${error?.message ?? 'failed'}`
    })
    .join('; ')
}

/**
 * Synthesise through the provider chain.
 *
 * @param options - provider order, request, runtime and injected adapter table.
 * @returns the first successful result with its attempt log.
 * @throws TtsError when no provider succeeds (validation errors throw at once).
 */
export async function runChain(options: ChainOptions): Promise<ChainSuccess> {
  const adapters = options.adapters ?? BUILTIN_ADAPTERS
  const logger = options.logger
  const sleep = options.sleep ?? sleepWithSignal
  const order = attemptOrder(options.provider, options.fallback)
  const attempts: ChainAttempt[] = []

  if (order.length === 0) {
    throw new TtsError('config', 'no provider configured (set provider or fallback)')
  }

  for (const [index, id] of order.entries()) {
    const adapter = getAdapter(id, adapters)
    if (adapter === undefined) {
      if (index === 0) {
        const known = [...adapters.keys()].join(', ')
        throw new TtsError(
          'config',
          `unknown provider "${id}"; available providers: ${known}`,
          { detail: { provider: id } },
        )
      }
      attempts.push({ provider: id, ok: false, skipped: 'unknown-adapter' })
      continue
    }

    const config = providerConfigFor(id, options.providers)
    if (config.enabled === false) {
      attempts.push({ provider: id, ok: false, skipped: 'disabled' })
      continue
    }
    if (!adapterAvailable(adapter, options.runtime.platform)) {
      attempts.push({ provider: id, ok: false, skipped: 'platform' })
      continue
    }

    if (adapter.capabilities.requiresKey) {
      const ref = config.apiKeyEnv ?? ''
      if (ref === '') {
        attempts.push({ provider: id, ok: false, skipped: 'missing-key' })
        continue
      }
      const key = await options.runtime.resolveKey(ref)
      if (key === undefined || key === '') {
        attempts.push({ provider: id, ok: false, skipped: 'missing-key' })
        logger?.debug?.('[whale-tts] provider %s has no credential for %s', id, ref)
        continue
      }
    }

    const retries = Math.max(0, Math.min(config.retry ?? 0, 5))
    let lastError: TtsError | undefined
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (options.request.signal.aborted) {
        throw new TtsError('aborted', 'synthesis aborted', { provider: id })
      }
      try {
        const result = await adapter.synthesize(options.request, config, options.runtime)
        attempts.push({ provider: id, ok: true })
        return { result, provider: id, attempts }
      } catch (rawError) {
        const error = asTtsError(rawError, id)
        lastError = error
        if (error.kind === 'aborted') throw error
        if (error.kind === 'validation') throw error
        if (!error.retryable) break
        if (attempt < retries) {
          const delay = retryDelayMs(error.kind, attempt)
          logger?.debug?.('[whale-tts] provider %s failed (%s); retrying in %dms', id, error.kind, delay)
          await sleep(delay, options.request.signal)
        }
      }
    }

    attempts.push({ provider: id, ok: false, error: lastError })
    logger?.debug?.(
      '[whale-tts] provider %s failed: %s',
      id,
      lastError?.message ?? 'unknown error',
    )
  }

  const primary = attempts.find((attempt) => attempt.skipped === undefined && attempt.error)
  const kind = primary?.error?.kind ?? 'provider'
  throw new TtsError(kind, `all TTS providers failed: ${describeFailures(attempts)}`, {
    provider: options.provider,
    status: primary?.error?.status,
    detail: {
      attempts: attempts.map((attempt) => ({
        provider: attempt.provider,
        ok: attempt.ok,
        skipped: attempt.skipped,
        kind: attempt.error?.kind,
        message: attempt.error?.message,
        status: attempt.error?.status,
      })),
    },
  })
}

/** Re-exported for callers that need to classify a caught value. */
export { isTtsError }
