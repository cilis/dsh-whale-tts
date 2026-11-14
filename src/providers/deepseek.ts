/**
 * DeepSeek official TTS adapter.
 *
 * The whole-text endpoint streams raw audio and returns `audio/wav`:
 *   POST https://api.deepseek.com/v1/tools/tts
 *
 * The plugin buffers the stream and writes one WAV file. The optional
 * WebSocket endpoint is documented in docs/tts-apis/deepseek-tts.md but is not
 * part of this adapter yet.
 */
import { validateAudio } from '../core/audio.js'
import {
  TtsError,
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

const PROVIDER = 'deepseek'

const DEFAULTS = {
  baseURL: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  voice: 'stella',
  timeoutMs: 120_000,
} as const

const FORMATS: readonly AudioFormat[] = ['wav']

const VOICES: readonly VoiceDescriptor[] = [
  { id: 'stella', label: 'Stella / 海星', description: '默认女声' },
  { id: 'tide', label: 'Tide / 暗潮', description: '男声' },
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

const MAX_ERROR_SNIPPET = 200

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function timeoutFor(config: ProviderConfig): number {
  const value = config.timeoutMs
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULTS.timeoutMs
  return Math.max(1, Math.min(Math.floor(value), 600_000))
}

function endpointFor(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, '')
  if (/\/v1\/tools\/tts$/.test(base)) return base
  if (/\/v1$/.test(base)) return `${base}/tools/tts`
  return `${base}/v1/tools/tts`
}

function classifyFetchError(error: unknown, request: SynthesisRequest, timeoutMs: number): TtsError {
  if (error instanceof TtsError) return error
  if (request.signal.aborted) {
    return new TtsError('aborted', 'synthesis aborted', { provider: PROVIDER, cause: error })
  }
  const name =
    error !== null && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new TtsError('timeout', `${PROVIDER} request timed out after ${timeoutMs}ms`, {
      provider: PROVIDER,
      retryable: true,
      cause: error,
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new TtsError('network', redact(`${PROVIDER} network error: ${message}`), {
    provider: PROVIDER,
    retryable: true,
    cause: error,
  })
}

function classifyStatus(status: number, body: string): TtsError {
  const snippet = redact(body.trim().slice(0, MAX_ERROR_SNIPPET))
  const suffix = snippet === '' ? '' : `: ${snippet}`
  const lower = body.toLowerCase()
  if (status === 401 || status === 403) {
    return new TtsError('auth', `${PROVIDER} authentication failed (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: false,
    })
  }
  if (status === 402) {
    return new TtsError('quota', `${PROVIDER} quota exhausted (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: false,
    })
  }
  if (status === 429) {
    return new TtsError('rate-limit', `${PROVIDER} concurrency limit (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: true,
    })
  }
  if (status === 504) {
    return new TtsError('timeout', `${PROVIDER} synthesis timed out (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: true,
    })
  }
  if (status === 503 || status >= 500) {
    return new TtsError('server', `${PROVIDER} service unavailable (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: true,
    })
  }
  if (status === 400) {
    if (lower.includes('content exists risk') || lower.includes('content_filter')) {
      return new TtsError(
        'content-filter',
        `${PROVIDER} rejected the text (HTTP ${status})${suffix}`,
        { provider: PROVIDER, status, retryable: false },
      )
    }
    return new TtsError('validation', `${PROVIDER} invalid input (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: false,
    })
  }
  return new TtsError('provider', `${PROVIDER} request failed (HTTP ${status})${suffix}`, {
    provider: PROVIDER,
    status,
    retryable: false,
  })
}

/** A WAV whose RIFF chunk claims more bytes than the response contained. */
function wavTruncated(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return true
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
    return false
  }
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)
  if (declared === 0 || declared === 0xffffffff) return false
  return declared + 8 > bytes.byteLength
}

export const deepseekAdapter: ProviderAdapter = {
  id: PROVIDER,
  capabilities: CAPABILITIES,

  async synthesize(
    request: SynthesisRequest,
    config: ProviderConfig,
    runtime: ProviderRuntime,
  ): Promise<SynthesisResult> {
    if (request.signal.aborted) {
      throw new TtsError('aborted', 'synthesis aborted', { provider: PROVIDER })
    }

    const voice = firstNonEmpty(request.voice, config.voice, DEFAULTS.voice) ?? DEFAULTS.voice
    const baseURL = firstNonEmpty(config.baseURL, DEFAULTS.baseURL) ?? DEFAULTS.baseURL
    const ref = firstNonEmpty(config.apiKeyEnv, DEFAULTS.apiKeyEnv) ?? DEFAULTS.apiKeyEnv
    const key = await runtime.resolveKey(ref)
    if (typeof key !== 'string' || key.trim() === '') {
      throw new TtsError('auth', `credential "${ref}" is not configured`, {
        provider: PROVIDER,
        retryable: false,
      })
    }

    const timeoutMs = timeoutFor(config)
    const headers: Record<string, string> = {
      ...(config.headers ?? {}),
      Authorization: `Bearer ${key.trim()}`,
      'Content-Type': 'application/json',
    }
    const payload = {
      text: request.text,
      voice_id: voice,
      format: 'wav',
      filter_markdown: config.filterMarkdown ?? true,
    }

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
    let response: Response
    try {
      response = await runtime.fetch(endpointFor(baseURL), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      })
    } catch (error) {
      throw classifyFetchError(error, request, timeoutMs)
    }

    if (!response.ok) {
      let body = ''
      try {
        body = await response.text()
      } catch {
        body = ''
      }
      throw classifyStatus(response.status, body)
    }

    const contentLength = Number(response.headers.get('content-length') ?? Number.NaN)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      throw classifyFetchError(error, request, timeoutMs)
    }
    if (
      Number.isFinite(contentLength) &&
      contentLength > 0 &&
      bytes.byteLength < contentLength
    ) {
      throw new TtsError(
        'provider',
        `${PROVIDER} audio stream ended early (${bytes.byteLength}/${contentLength} bytes)`,
        { provider: PROVIDER, status: response.status, retryable: true },
      )
    }
    if (wavTruncated(bytes)) {
      throw new TtsError('provider', `${PROVIDER} returned a truncated WAV`, {
        provider: PROVIDER,
        status: response.status,
        retryable: true,
      })
    }
    if (bytes.byteLength === 0) {
      throw new TtsError('provider', `${PROVIDER} returned no audio`, {
        provider: PROVIDER,
        status: response.status,
        retryable: true,
      })
    }

    const validated = validateAudio(bytes, 'wav', PROVIDER)
    return {
      data: bytes,
      format: validated,
      voice,
      meta: {
        status: response.status,
        bytes: bytes.byteLength,
        filterMarkdown: config.filterMarkdown ?? true,
      },
    }
  },
}
