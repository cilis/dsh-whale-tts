/**
 * `minimax` provider adapter.
 *
 * Synchronous MiniMax TTS: `POST {baseURL}/t2a_v2` with a Bearer key. The
 * response is JSON and carries the audio as a **hex** string, not base64:
 * `{ data: { audio: "fffb..." }, extra_info: {...}, base_resp: {...} }`.
 *
 * Only the non-streaming path is implemented. Voice cloning/design stay out of
 * this release; the settings card therefore exposes `voiceClone: false` and
 * `voiceDesign: false` for this provider.
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

const PROVIDER = 'minimax'

const DEFAULTS = {
  baseURL: 'https://api.minimax.cn/v1',
  apiKeyEnv: 'MINIMAX_API_KEY',
  model: 'speech-2.8-turbo',
  voice: 'male-qn-jingying',
  timeoutMs: 30_000,
} as const

/** Formats MiniMax can emit that this plugin supports. */
const FORMATS: readonly AudioFormat[] = ['mp3', 'wav']

const VOICES: readonly VoiceDescriptor[] = [
  { id: 'male-qn-jingying', label: '精英男声', description: '沉稳精英男声' },
  { id: 'male-qn-qingse', label: '青涩男声', description: '青涩青年男声' },
  { id: 'female-shaonv', label: '少女音色', description: '甜美少女' },
  { id: 'female-yujie', label: '御姐音色', description: '成熟御姐' },
  { id: 'female-chengshu', label: '成熟女声', description: '成熟稳重女声' },
  { id: 'presenter_male', label: '主持男声', description: '节目主持风格' },
  { id: 'presenter_female', label: '主持女声', description: '节目主持风格' },
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
const MAX_TIMEOUT_MS = 600_000

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

function timeoutFor(config: ProviderConfig): number {
  const configured = config.timeoutMs
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULTS.timeoutMs
  }
  return Math.max(1, Math.min(Math.floor(configured), MAX_TIMEOUT_MS))
}

function resolveFormat(request: SynthesisRequest, config: ProviderConfig): AudioFormat {
  const wanted = request.format ?? config.format
  return wanted !== undefined && FORMATS.includes(wanted) ? wanted : 'mp3'
}

function endpointFor(baseURL: string, path: string): string {
  return `${baseURL.trim().replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

function abortError(): TtsError {
  return new TtsError('aborted', 'synthesis aborted', { provider: PROVIDER })
}

function timeoutError(timeoutMs: number): TtsError {
  return new TtsError('timeout', `${PROVIDER} request timed out after ${timeoutMs}ms`, {
    provider: PROVIDER,
    retryable: true,
  })
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
  if (name === 'TimeoutError' || name === 'AbortError') return timeoutError(timeoutMs)
  const message = error instanceof Error ? error.message : String(error)
  return new TtsError('network', redact(`${PROVIDER} network error: ${message}`), {
    provider: PROVIDER,
    retryable: true,
    cause: error,
  })
}

function classifyHttpStatus(status: number, snippet: string): TtsError {
  const suffix = snippet === '' ? '' : `: ${snippet}`
  if (status === 401 || status === 403) {
    return new TtsError('auth', `${PROVIDER} authentication failed (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: false,
    })
  }
  if (status === 402) {
    return new TtsError('quota', `${PROVIDER} quota or balance exhausted (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: false,
    })
  }
  if (status === 429) {
    return new TtsError('rate-limit', `${PROVIDER} rate limited (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: true,
    })
  }
  if (status >= 500) {
    return new TtsError('server', `${PROVIDER} server error (HTTP ${status})${suffix}`, {
      provider: PROVIDER,
      status,
      retryable: true,
    })
  }
  return new TtsError('provider', `${PROVIDER} request failed (HTTP ${status})${suffix}`, {
    provider: PROVIDER,
    status,
    retryable: false,
  })
}

function classifyBaseResponse(code: number, message: string): TtsError {
  const suffix = message.trim() === '' ? '' : `: ${redact(message.trim())}`
  if (code === 1004) {
    return new TtsError('auth', `${PROVIDER} authentication failed${suffix}`, {
      provider: PROVIDER,
      retryable: false,
      detail: { code },
    })
  }
  if (code === 1008) {
    return new TtsError('quota', `${PROVIDER} quota or balance exhausted${suffix}`, {
      provider: PROVIDER,
      retryable: false,
      detail: { code },
    })
  }
  if (code === 1002 || code === 1029 || code === 1039) {
    return new TtsError('rate-limit', `${PROVIDER} rate limited${suffix}`, {
      provider: PROVIDER,
      retryable: true,
      detail: { code },
    })
  }
  if (code === 1027) {
    return new TtsError('content-filter', `${PROVIDER} refused the text${suffix}`, {
      provider: PROVIDER,
      retryable: false,
      detail: { code },
    })
  }
  return new TtsError('provider', `${PROVIDER} request failed (code ${code})${suffix}`, {
    provider: PROVIDER,
    retryable: false,
    detail: { code },
  })
}

function errorSnippet(body: string): string {
  const raw = body.trim()
  if (raw === '') return ''
  let text = raw
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const base = parsed['base_resp']
    if (base !== null && typeof base === 'object') {
      const record = base as Record<string, unknown>
      for (const key of ['status_msg', 'message']) {
        const candidate = record[key]
        if (typeof candidate === 'string' && candidate.trim() !== '') {
          text = candidate
          break
        }
      }
    }
    if (text === raw) {
      for (const key of ['message', 'detail', 'error']) {
        const candidate = parsed[key]
        if (typeof candidate === 'string' && candidate.trim() !== '') {
          text = candidate
          break
        }
      }
    }
  } catch {
    // Keep the raw body.
  }
  const scrubbed = redact(text).replace(/\s+/g, ' ').trim()
  return scrubbed.length > MAX_ERROR_SNIPPET
    ? `${scrubbed.slice(0, MAX_ERROR_SNIPPET)}…`
    : scrubbed
}

function hexToBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string') return undefined
  const hex = value.replace(/\s+/g, '')
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

interface MiniMaxResponse {
  readonly data?: { readonly audio?: unknown; readonly status?: unknown }
  readonly base_resp?: { readonly status_code?: unknown; readonly status_msg?: unknown }
}

export const minimaxAdapter: ProviderAdapter = {
  id: PROVIDER,

  capabilities: CAPABILITIES,

  async synthesize(
    request: SynthesisRequest,
    config: ProviderConfig,
    runtime: ProviderRuntime,
  ): Promise<SynthesisResult> {
    if (request.signal.aborted) throw abortError()

    const model = firstNonEmpty(request.model, config.model) ?? DEFAULTS.model
    const voice = firstNonEmpty(request.voice, config.voice) ?? DEFAULTS.voice
    const format = resolveFormat(request, config)
    const timeoutMs = timeoutFor(config)
    const ref = firstNonEmpty(config.apiKeyEnv) ?? DEFAULTS.apiKeyEnv
    const key = await runtime.resolveKey(ref)
    const apiKey = typeof key === 'string' ? key.trim() : ''
    if (apiKey === '') {
      throw new TtsError('auth', `${PROVIDER} credential "${ref}" is not configured`, {
        provider: PROVIDER,
        retryable: false,
        detail: { ref },
      })
    }

    const baseURL = firstNonEmpty(config.baseURL) ?? DEFAULTS.baseURL
    const url = endpointFor(baseURL, '/t2a_v2')
    const payload = {
      model,
      text: request.text,
      stream: false,
      voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
      audio_setting: {
        sample_rate: 32_000,
        bitrate: 128_000,
        format,
        channel: 1,
      },
      output_format: 'hex',
    }

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
    let response: Response
    try {
      response = await runtime.fetch(url, {
        method: 'POST',
        headers: {
          ...(config.headers ?? {}),
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
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
      } catch (error) {
        throw classifyFetchError(error, request, timeoutMs)
      }
      throw classifyHttpStatus(response.status, errorSnippet(body))
    }

    let json: MiniMaxResponse
    try {
      json = (await response.json()) as MiniMaxResponse
    } catch (error) {
      throw classifyFetchError(error, request, timeoutMs)
    }

    const base = json.base_resp
    if (base !== null && typeof base === 'object') {
      const code = base.status_code
      if (typeof code === 'number' && code !== 0) {
        throw classifyBaseResponse(code, typeof base.status_msg === 'string' ? base.status_msg : '')
      }
    }

    const bytes = hexToBytes(json.data?.audio)
    if (bytes === undefined) {
      throw new TtsError('provider', `${PROVIDER} returned no decodable audio`, {
        provider: PROVIDER,
        retryable: false,
      })
    }
    const validated = validateAudio(bytes, format, PROVIDER)

    return {
      data: bytes,
      format: validated,
      voice,
      meta: { model, status: response.status, bytes: bytes.byteLength },
    }
  },
}
