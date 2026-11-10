/**
 * Qwen-TTS cloud adapter (Alibaba Cloud Model Studio / DashScope).
 *
 * This is the hosted `qwen3-tts-flash` API, not the local Qwen3-TTS weights.
 * The API returns a 24-hour audio URL; the adapter downloads it immediately and
 * hands raw WAV bytes to the service. It never exposes the URL or the API key
 * in an error message.
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

const PROVIDER = 'qwen'

const DEFAULTS = {
  baseURL: 'https://dashscope.aliyuncs.com/api/v1',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  model: 'qwen3-tts-flash',
  voice: 'Cherry',
  timeoutMs: 60_000,
} as const

const FORMATS: readonly AudioFormat[] = ['wav']

const VOICES: readonly VoiceDescriptor[] = [
  { id: 'Cherry', label: 'Cherry', description: '芊悦；温暖女声' },
  { id: 'Serena', label: 'Serena', description: '苏瑶；知性女声' },
  { id: 'Ethan', label: 'Ethan', description: '晨煦；阳光男声' },
  { id: 'Chelsie', label: 'Chelsie', description: '千雪；二次元女声' },
  { id: 'Momo', label: 'Momo', description: '茉兔；活泼女声' },
  { id: 'Moon', label: 'Moon', description: '月白；沉稳男声' },
  { id: 'Vivian', label: 'Vivian', description: '自信可爱女声' },
  { id: 'Maia', label: 'Maia', description: '知性温柔女声' },
  { id: 'Kai', label: 'Kai', description: '舒缓男声' },
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
  if (/\/services\/aigc\/multimodal-generation\/generation$/.test(base)) return base
  return `${base}/services/aigc/multimodal-generation/generation`
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
  if (status === 401 || status === 403) {
    return new TtsError('auth', `${PROVIDER} authentication failed (HTTP ${status})${suffix}`, {
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

function parseError(payload: unknown, status: number): TtsError | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code : ''
  const message = typeof record.message === 'string' ? record.message : ''
  const statusCode = typeof record.status_code === 'number' ? record.status_code : status
  if (code === '' && (statusCode === 200 || statusCode === 0)) return undefined
  const text = redact(
    `${code === '' ? '' : code + ': '}${message}`.trim().slice(0, MAX_ERROR_SNIPPET),
  )
  const kind =
    statusCode === 401 || statusCode === 403
      ? 'auth'
      : statusCode === 429
        ? 'rate-limit'
        : statusCode >= 500
          ? 'server'
          : 'provider'
  return new TtsError(kind, `${PROVIDER} API error${text === '' ? '' : `: ${text}`}`, {
    provider: PROVIDER,
    status: statusCode,
    retryable: kind === 'rate-limit' || kind === 'server',
  })
}

export const qwenAdapter: ProviderAdapter = {
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

    const model = firstNonEmpty(request.model, config.model, DEFAULTS.model) ?? DEFAULTS.model
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
      model,
      input: {
        text: request.text,
        voice,
      },
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

    let document: unknown
    try {
      document = await response.json()
    } catch (error) {
      throw new TtsError('provider', `${PROVIDER} returned invalid JSON`, {
        provider: PROVIDER,
        retryable: true,
        cause: error,
      })
    }
    const failure = parseError(document, response.status)
    if (failure !== undefined) throw failure

    const output =
      document !== null && typeof document === 'object'
        ? (document as Record<string, unknown>).output
        : undefined
    const audio =
      output !== null && typeof output === 'object'
        ? (output as Record<string, unknown>).audio
        : undefined
    const url =
      audio !== null && typeof audio === 'object'
        ? (audio as Record<string, unknown>).url
        : undefined
    if (typeof url !== 'string' || url.trim() === '') {
      throw new TtsError('provider', `${PROVIDER} response did not contain output.audio.url`, {
        provider: PROVIDER,
        retryable: true,
      })
    }

    let download: Response
    try {
      download = await runtime.fetch(url.trim(), { method: 'GET', signal })
    } catch (error) {
      throw classifyFetchError(error, request, timeoutMs)
    }
    if (!download.ok) {
      let body = ''
      try {
        body = await download.text()
      } catch {
        body = ''
      }
      throw classifyStatus(download.status, body)
    }

    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await download.arrayBuffer())
    } catch (error) {
      throw classifyFetchError(error, request, timeoutMs)
    }
    const validated = validateAudio(bytes, 'wav', PROVIDER)
    const meta =
      document !== null && typeof document === 'object'
        ? (document as Record<string, unknown>).request_id
        : undefined
    return {
      data: bytes,
      format: validated,
      voice,
      meta: {
        model,
        status: response.status,
        bytes: bytes.byteLength,
        ...(typeof meta === 'string' ? { requestId: meta } : {}),
      },
    }
  },
}
