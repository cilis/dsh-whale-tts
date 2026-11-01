/**
 * `openai-compatible` provider adapter.
 *
 * Speaks the OpenAI `/audio/speech` protocol (the de-facto standard for TTS
 * gateways such as SiliconFlow or a self-hosted proxy): the response body is
 * raw audio bytes, never JSON.
 *
 * Everything the adapter touches is injected through {@link ProviderRuntime},
 * so the unit tests can drive it with a fake `fetch`, and a failure is always a
 * {@link TtsError} whose message is redacted (no key, no text).
 */
import { validateAudio } from '../core/audio.js'
import {
  TtsError,
  isTtsError,
  redact,
  type AudioFormat,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderRuntime,
  type SynthesisRequest,
  type SynthesisResult,
  type VoiceDescriptor,
} from '../types.js'

/** Fallbacks used when the provider block omits a key. */
const OPENAI_DEFAULTS = {
  baseURL: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  timeoutMs: 30_000,
} as const

/** Provider id; also the `provider` field of every error it raises. */
const PROVIDER = 'openai-compatible'

/** Formats this adapter can produce; the first one is the default. */
const FORMATS: readonly AudioFormat[] = ['mp3', 'wav']

/** Built-in OpenAI voices (also accepted by most compatible gateways). */
const VOICES: readonly VoiceDescriptor[] = [
  { id: 'alloy', label: 'Alloy', description: '中性平衡' },
  { id: 'echo', label: 'Echo', description: '沉稳男声' },
  { id: 'fable', label: 'Fable', description: '叙事感' },
  { id: 'onyx', label: 'Onyx', description: '低沉男声' },
  { id: 'nova', label: 'Nova', description: '明亮女声' },
  { id: 'shimmer', label: 'Shimmer', description: '温柔女声' },
  { id: 'ash', label: 'Ash', description: '冷静中性' },
  { id: 'ballad', label: 'Ballad', description: '抒情' },
  { id: 'coral', label: 'Coral', description: '温暖女声' },
  { id: 'sage', label: 'Sage', description: '知性女声' },
  { id: 'verse', label: 'Verse', description: '多变' },
]

const CAPABILITIES: ProviderCapabilities = {
  speech: true,
  singing: false,
  formats: FORMATS,
  voices: VOICES,
  requiresKey: true,
  voiceDesign: false,
  voiceClone: false,
}

/** Longest provider error text we echo into a TtsError message. */
const MAX_ERROR_SNIPPET = 200

/** Longest timeout we accept, mirroring the config schema ceiling. */
const MAX_TIMEOUT_MS = 600_000

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

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

/** Clamp the configured timeout into a sane range. */
function timeoutFor(config: ProviderConfig, fallback: number): number {
  const configured = config.timeoutMs
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return fallback
  }
  return Math.max(1, Math.min(Math.floor(configured), MAX_TIMEOUT_MS))
}

/**
 * Pick the emitted format: the requested one when supported, the adapter
 * default (first capability) otherwise.
 */
function resolveFormat(
  request: SynthesisRequest,
  config: ProviderConfig,
  formats: readonly AudioFormat[],
): AudioFormat {
  const wanted = request.format ?? config.format
  if (wanted !== undefined && formats.includes(wanted)) return wanted
  return formats[0] ?? 'wav'
}

/** Trim trailing slashes so joining a path never doubles them. */
function endpointFor(baseURL: string, path: string): string {
  const base = baseURL.trim().replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/** Describe a voice for a log line without dumping a data URL. */
function voiceLabel(voice: string): string {
  if (voice.startsWith('data:')) return '<data-url>'
  return voice.length > 48 ? `${voice.slice(0, 48)}…` : voice
}

/** Remove known secrets from an arbitrary provider string. */
function scrubSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text
  for (const secret of secrets) {
    if (secret.length >= 3) scrubbed = scrubbed.split(secret).join('***')
  }
  return redact(scrubbed).replace(/\s+/g, ' ').trim()
}

/** Extract a short human-readable error text from a provider JSON body. */
function jsonErrorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const error = record['error']
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const nested = error as Record<string, unknown>
    for (const key of ['message', 'detail', 'type', 'code']) {
      const candidate = nested[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
  }
  for (const key of ['message', 'detail', 'error_description']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return undefined
}

/**
 * Build a redacted, length-limited error snippet from an HTTP response body.
 *
 * @param body - raw response body.
 * @param secrets - key/text values that must never appear in a message.
 */
function errorSnippetFromBody(body: string, secrets: readonly string[]): string {
  const raw = body.trim()
  if (raw === '') return ''
  let text = raw
  try {
    const extracted = jsonErrorText(JSON.parse(raw) as unknown)
    if (extracted !== undefined) text = extracted
  } catch {
    // Not JSON: fall back to the raw body.
  }
  const scrubbed = scrubSecrets(text, secrets)
  return scrubbed.length > MAX_ERROR_SNIPPET
    ? `${scrubbed.slice(0, MAX_ERROR_SNIPPET)}…`
    : scrubbed
}

/** Map an HTTP status onto the shared error taxonomy. */
function classifyHttpStatus(
  status: number,
  provider: string,
  snippet: string,
): TtsError {
  const suffix = snippet === '' ? '' : `: ${snippet}`
  const message = (text: string): string => `${provider} ${text}${suffix}`
  if (status === 401 || status === 403) {
    return new TtsError('auth', message(`authentication failed (HTTP ${status})`), {
      provider,
      status,
      retryable: false,
    })
  }
  if (status === 402) {
    return new TtsError('quota', message(`quota or balance exhausted (HTTP ${status})`), {
      provider,
      status,
      retryable: false,
    })
  }
  if (status === 429) {
    return new TtsError('rate-limit', message(`rate limited (HTTP ${status})`), {
      provider,
      status,
      retryable: true,
    })
  }
  if (status >= 500) {
    return new TtsError('server', message(`server error (HTTP ${status})`), {
      provider,
      status,
      retryable: true,
    })
  }
  return new TtsError('provider', message(`request failed (HTTP ${status})`), {
    provider,
    status,
    retryable: false,
  })
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
 * Classify a value thrown by `fetch` (or by reading its body).
 *
 * A caller abort wins over everything; an abort caused by our timeout signal
 * is a `timeout`; anything else is a network failure.
 */
function classifyFetchError(
  error: unknown,
  request: SynthesisRequest,
  provider: string,
  timeoutMs: number,
): TtsError {
  if (isTtsError(error)) return error
  if (request.signal.aborted) {
    return new TtsError('aborted', 'synthesis aborted', { provider, cause: error })
  }
  const name =
    error !== null && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return timeoutError(provider, timeoutMs)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new TtsError('network', redact(`${provider} network error: ${message}`), {
    provider,
    retryable: true,
    cause: error,
  })
}

/** Combined caller + timeout signal. */
function requestSignal(request: SynthesisRequest, timeoutMs: number): AbortSignal {
  return AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
}

/**
 * Await `fetch` while guaranteeing the adapter returns on abort/timeout even
 * when the injected `fetch` implementation ignores the signal.
 */
async function fetchResponse(options: {
  readonly runtime: ProviderRuntime
  readonly request: SynthesisRequest
  readonly provider: string
  readonly url: string
  readonly init: RequestInit
  readonly timeoutMs: number
}): Promise<Response> {
  const { runtime, request, provider, timeoutMs } = options
  if (request.signal.aborted) throw abortError(provider)
  const signal = requestSignal(request, timeoutMs)
  let pending: Promise<Response>
  try {
    pending = runtime.fetch(options.url, { ...options.init, signal })
  } catch (error) {
    // A misbehaving injected fetch may throw synchronously; treat it like any
    // other transport failure instead of leaking a raw error.
    throw classifyFetchError(error, request, provider, timeoutMs)
  }
  return await new Promise<Response>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      action()
    }
    const onAbort = (): void => {
      finish(() => {
        reject(
          request.signal.aborted
            ? abortError(provider)
            : timeoutError(provider, timeoutMs),
        )
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (response) => finish(() => resolve(response)),
      (error) => finish(() => reject(classifyFetchError(error, request, provider, timeoutMs))),
    )
  })
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible speech adapter.
 *
 * `POST {baseURL}/audio/speech` with a Bearer token; the response body is the
 * audio file itself, so it is validated by magic bytes before it is returned.
 */
export const openaiAdapter: ProviderAdapter = {
  id: PROVIDER,

  capabilities: CAPABILITIES,

  async synthesize(
    request: SynthesisRequest,
    config: ProviderConfig,
    runtime: ProviderRuntime,
  ): Promise<SynthesisResult> {
    if (request.signal.aborted) throw abortError(PROVIDER)

    const model =
      firstNonEmpty(request.model, config.model, OPENAI_DEFAULTS.model) ??
      OPENAI_DEFAULTS.model
    const voice =
      firstNonEmpty(request.voice, config.voice, OPENAI_DEFAULTS.voice) ??
      OPENAI_DEFAULTS.voice
    const style = request.style ?? config.style ?? ''
    const format = resolveFormat(request, config, FORMATS)
    const timeoutMs = timeoutFor(config, OPENAI_DEFAULTS.timeoutMs)
    const ref =
      firstNonEmpty(config.apiKeyEnv, OPENAI_DEFAULTS.apiKeyEnv) ?? OPENAI_DEFAULTS.apiKeyEnv

    const key = await runtime.resolveKey(ref)
    const apiKey = typeof key === 'string' ? key.trim() : ''
    if (apiKey === '') {
      throw new TtsError(
        'auth',
        `${PROVIDER} credential "${ref}" is not configured`,
        { provider: PROVIDER, retryable: false, detail: { ref } },
      )
    }

    const baseURL = firstNonEmpty(config.baseURL, OPENAI_DEFAULTS.baseURL) ?? OPENAI_DEFAULTS.baseURL
    const url = endpointFor(baseURL, '/audio/speech')
    const headers: Record<string, string> = {
      ...(config.headers ?? {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }
    const payload: Record<string, unknown> = {
      model,
      voice,
      input: request.text,
      response_format: format,
    }
    if (style.trim() !== '') payload['instructions'] = style

    runtime.logger.debug?.(
      `[whale-tts] ${PROVIDER} request model=${model} voice=${voiceLabel(voice)} ` +
        `format=${format} timeoutMs=${timeoutMs}`,
    )

    const response = await fetchResponse({
      runtime,
      request,
      provider: PROVIDER,
      url,
      timeoutMs,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
    })

    if (!response.ok) {
      let snippet = ''
      try {
        snippet = errorSnippetFromBody(await response.text(), [apiKey, request.text])
      } catch (error) {
        throw classifyFetchError(error, request, PROVIDER, timeoutMs)
      }
      throw classifyHttpStatus(response.status, PROVIDER, snippet)
    }

    let audio: Uint8Array
    try {
      audio = new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      throw classifyFetchError(error, request, PROVIDER, timeoutMs)
    }
    const validated = validateAudio(audio, format, PROVIDER)

    return {
      data: audio,
      format: validated,
      voice,
      meta: { model, status: response.status, bytes: audio.byteLength },
    }
  },
}
