/**
 * `mimo` provider adapter (Xiaomi MiMo-V2.5-TTS).
 *
 * MiMo speaks the OpenAI Chat Completions shape with an `audio` extension:
 * the text to synthesise goes in the `assistant` message, the style direction in
 * the `user` message, and the response carries **base64** audio at
 * `choices[0].message.audio.data`.
 *
 * The same endpoint serves three models:
 * - `mimo-v2.5-tts` (preset voices, singing tags),
 * - `mimo-v2.5-tts-voicedesign` (style description in `user`, no `voice`),
 * - `mimo-v2.5-tts-voiceclone` (base64 data URI in `audio.voice`).
 *
 * Errors are always {@link TtsError} with a redacted message (no key, no text).
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
const MIMO_DEFAULTS = {
  baseURL: 'https://api.xiaomimimo.com/v1',
  apiKeyEnv: 'MIMO_API_KEY',
  model: 'mimo-v2.5-tts',
  designModel: 'mimo-v2.5-tts-voicedesign',
  cloneModel: 'mimo-v2.5-tts-voiceclone',
  voice: '苏打',
  timeoutMs: 30_000,
} as const

/** Provider id; also the `provider` field of every error it raises. */
const PROVIDER = 'mimo'

/** Formats this adapter can produce; the first one is the default. */
const FORMATS: readonly AudioFormat[] = ['wav', 'mp3']

/** The nine preset voices documented for `mimo-v2.5-tts`. */
const VOICES: readonly VoiceDescriptor[] = [
  { id: 'mimo_default', label: 'MiMo-默认', description: '默认音色（中文集群为冰糖）' },
  { id: '冰糖', label: '冰糖', description: '活泼少女（中文）' },
  { id: '茉莉', label: '茉莉', description: '知性女声（中文）' },
  { id: '苏打', label: '苏打', description: '阳光少年（中文）' },
  { id: '白桦', label: '白桦', description: '成熟男声（中文）' },
  { id: 'Mia', label: 'Mia', description: '英文女声' },
  { id: 'Chloe', label: 'Chloe', description: '英文女声（明亮）' },
  { id: 'Milo', label: 'Milo', description: '英文男声' },
  { id: 'Dean', label: 'Dean', description: '英文男声（低沉）' },
]

const CAPABILITIES: ProviderCapabilities = {
  speech: true,
  // Singing is a real MiMo capability, kept for a later release; no tool or UI
  // exposes it yet (the current release never synthesises singing).
  singing: true,
  formats: FORMATS,
  voices: VOICES,
  requiresKey: true,
  voiceDesign: true,
  voiceClone: true,
}

/** Longest provider error text we echo into a TtsError message. */
const MAX_ERROR_SNIPPET = 200

/** Longest timeout we accept, mirroring the config schema ceiling. */
const MAX_TIMEOUT_MS = 600_000

/** `finish_reason` / error codes that mean "the provider refused the text". */
const CONTENT_FILTER_PATTERN = /content[-_ ]?filter|sensitive|moderation|refus/i

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
function voiceLabel(voice: string | undefined): string {
  if (voice === undefined) return '<none>'
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

/** True when a string marks a content-filter refusal. */
function isContentFilterMarker(value: string | undefined): boolean {
  return value !== undefined && CONTENT_FILTER_PATTERN.test(value)
}

/** Turn a MiMo `error` object into a classified error. */
function classifyMimoError(error: unknown, secrets: readonly string[]): TtsError {
  if (isTtsError(error)) return error
  if (error === null || typeof error !== 'object') {
    const text = scrubSecrets(String(error), secrets)
    return new TtsError('provider', `${PROVIDER} error: ${text}`, {
      provider: PROVIDER,
      retryable: false,
    })
  }
  const record = error as Record<string, unknown>
  const code = [record['code'], record['type']].filter(
    (value): value is string => typeof value === 'string',
  )
  const message = [record['message'], record['detail']].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )
  if (isContentFilterMarker([...code, message ?? ''].join(' '))) {
    return new TtsError('content-filter', `${PROVIDER} refused the text (content filter)`, {
      provider: PROVIDER,
      retryable: false,
      detail: { code: code.join(' ') || undefined },
    })
  }
  const snippet = scrubSecrets(
    message ?? (code.join(' ') || JSON.stringify(record)),
    secrets,
  )
  return new TtsError('provider', `${PROVIDER} error${snippet === '' ? '' : `: ${snippet}`}`, {
    provider: PROVIDER,
    retryable: false,
    detail: { code: code.join(' ') || undefined },
  })
}

/** One decoded audio payload plus the format the provider actually returned. */
interface MimoAudioPayload {
  readonly base64: string
  readonly format: AudioFormat
  readonly finishReason?: string
}

/** Read `choices[0].message.audio` out of a MiMo completion body. */
function extractAudioPayload(
  body: unknown,
  requestedFormat: AudioFormat,
  secrets: readonly string[],
): MimoAudioPayload {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TtsError('provider', `${PROVIDER} returned an unexpected JSON payload`, {
      provider: PROVIDER,
      retryable: false,
    })
  }
  const record = body as Record<string, unknown>

  // Some gateways answer HTTP 200 with an `error` object instead of choices.
  const topLevelError = record['error']
  if (topLevelError !== undefined && topLevelError !== null) {
    throw classifyMimoError(topLevelError, secrets)
  }

  const choices = record['choices']
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new TtsError('provider', `${PROVIDER} response has no choices`, {
      provider: PROVIDER,
      retryable: false,
    })
  }
  const firstChoice = choices[0]
  if (firstChoice === null || typeof firstChoice !== 'object') {
    throw new TtsError('provider', `${PROVIDER} response has an invalid choice`, {
      provider: PROVIDER,
      retryable: false,
    })
  }
  const choice = firstChoice as Record<string, unknown>
  const finishReason =
    typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : undefined
  if (isContentFilterMarker(finishReason)) {
    throw new TtsError(
      'content-filter',
      `${PROVIDER} refused the text (finish_reason: ${finishReason})`,
      {
        provider: PROVIDER,
        retryable: false,
        detail: { finishReason },
      },
    )
  }

  const message = choice['message']
  const audio =
    message !== null && typeof message === 'object'
      ? (message as Record<string, unknown>)['audio']
      : undefined
  if (audio === null || typeof audio !== 'object') {
    throw new TtsError(
      'provider',
      `${PROVIDER} response has no audio payload (choices[0].message.audio)`,
      { provider: PROVIDER, retryable: false, detail: { finishReason } },
    )
  }
  const audioRecord = audio as Record<string, unknown>
  const base64 = typeof audioRecord['data'] === 'string' ? audioRecord['data'] : ''
  if (base64.trim() === '') {
    throw new TtsError('provider', `${PROVIDER} returned an empty audio payload`, {
      provider: PROVIDER,
      retryable: false,
      detail: { finishReason },
    })
  }
  const reportedFormat = audioRecord['format']
  const format: AudioFormat =
    reportedFormat === 'wav' || reportedFormat === 'mp3' ? reportedFormat : requestedFormat
  return { base64, format, finishReason }
}

/** Decode a base64 payload into bytes, rejecting empty/garbage input. */
function decodeBase64Audio(value: string): Uint8Array {
  const cleaned = value.replace(/\s+/g, '')
  const decoded = Buffer.from(cleaned, 'base64')
  if (decoded.byteLength === 0) {
    throw new TtsError('provider', `${PROVIDER} returned an empty audio payload`, {
      provider: PROVIDER,
      retryable: false,
    })
  }
  return new Uint8Array(decoded)
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * MiMo speech adapter.
 *
 * `POST {baseURL}/chat/completions` with an `api-key` header; the response is
 * JSON and carries base64 audio, decoded and magic-byte validated here.
 */
export const mimoAdapter: ProviderAdapter = {
  id: PROVIDER,

  capabilities: CAPABILITIES,

  async synthesize(
    request: SynthesisRequest,
    config: ProviderConfig,
    runtime: ProviderRuntime,
  ): Promise<SynthesisResult> {
    if (request.signal.aborted) throw abortError(PROVIDER)

    const model =
      firstNonEmpty(request.model, config.model, MIMO_DEFAULTS.model) ?? MIMO_DEFAULTS.model
    const designModel = firstNonEmpty(config.designModel, MIMO_DEFAULTS.designModel)
    const cloneModel = firstNonEmpty(config.cloneModel, MIMO_DEFAULTS.cloneModel)
    const isVoiceDesign = model === designModel
    const isVoiceClone = model === cloneModel
    // Voice rules per model (see the MiMo TTS docs):
    // - voicedesign takes NO `audio.voice` at all; the voice comes from the
    //   `user` message. Sending a preset voice here makes the API ignore the
    //   design description, which is exactly the bug this guards against.
    // - voiceclone MUST use the sample data URL from the request; falling back
    //   to a preset voice would silently clone nothing.
    // - the preset model uses the request voice, then the configured voice.
    const voice = isVoiceDesign
      ? undefined
      : isVoiceClone
        ? firstNonEmpty(request.voice)
        : firstNonEmpty(request.voice, config.voice)
    const style = request.style ?? config.style ?? ''
    const format = resolveFormat(request, config, FORMATS)
    const timeoutMs = timeoutFor(config, MIMO_DEFAULTS.timeoutMs)
    const ref =
      firstNonEmpty(config.apiKeyEnv, MIMO_DEFAULTS.apiKeyEnv) ?? MIMO_DEFAULTS.apiKeyEnv

    const key = await runtime.resolveKey(ref)
    const apiKey = typeof key === 'string' ? key.trim() : ''
    if (apiKey === '') {
      throw new TtsError('auth', `${PROVIDER} credential "${ref}" is not configured`, {
        provider: PROVIDER,
        retryable: false,
        detail: { ref },
      })
    }

    const baseURL = firstNonEmpty(config.baseURL, MIMO_DEFAULTS.baseURL) ?? MIMO_DEFAULTS.baseURL
    const url = endpointFor(baseURL, '/chat/completions')
    const headers: Record<string, string> = {
      ...(config.headers ?? {}),
      'Content-Type': 'application/json',
      // MiMo authenticates with `api-key`, not `Authorization: Bearer`.
      'api-key': apiKey,
    }
    const audio: Record<string, unknown> = { format }
    if (voice !== undefined) audio['voice'] = voice
    // The design model can polish the demo sentence so it fits the designed
    // voice; the official examples enable this for `mimo-v2.5-tts-voicedesign`.
    if (isVoiceDesign && config.designOptimizeText !== false) {
      audio['optimize_text_preview'] = true
    }
    const payload: Record<string, unknown> = {
      model,
      messages: [
        { role: 'user', content: style },
        { role: 'assistant', content: request.text },
      ],
      audio,
      stream: false,
    }

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

    let rawBody = ''
    try {
      rawBody = await response.text()
    } catch (error) {
      throw classifyFetchError(error, request, PROVIDER, timeoutMs)
    }
    if (!response.ok) {
      throw classifyHttpStatus(
        response.status,
        PROVIDER,
        errorSnippetFromBody(rawBody, [apiKey, request.text]),
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody) as unknown
    } catch {
      throw new TtsError(
        'provider',
        `${PROVIDER} returned invalid JSON (${rawBody.length} bytes)`,
        { provider: PROVIDER, retryable: false, status: response.status },
      )
    }

    const payloadAudio = extractAudioPayload(parsed, format, [apiKey, request.text])
    const audioBytes = decodeBase64Audio(payloadAudio.base64)
    const validated = validateAudio(audioBytes, payloadAudio.format, PROVIDER)
    const meta: Record<string, unknown> = {
      model,
      format: validated,
      status: response.status,
      bytes: audioBytes.byteLength,
    }
    if (payloadAudio.finishReason !== undefined) {
      meta['finishReason'] = payloadAudio.finishReason
    }

    return {
      data: audioBytes,
      format: validated,
      voice: voice ?? 'default',
      meta,
    }
  },
}
