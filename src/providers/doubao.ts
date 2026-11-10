/**
 * Doubao (Volcengine) V3 speech adapter.
 *
 * Uses the SSE unidirectional endpoint:
 *   POST {baseURL}/tts/unidirectional/sse
 *
 * Request auth is the new-console `X-Api-Key` + `X-Api-Resource-Id` pair. The
 * response is an event stream; `event: 352` frames carry base64 MP3 chunks and
 * `event: 152` is the successful finish. V1 (`/api/v1/tts`) is deliberately not
 * used: it cannot call 2.0 voices.
 */
import { randomUUID } from 'node:crypto'
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

const PROVIDER = 'doubao'

const DEFAULTS = {
  baseURL: 'https://openspeech.bytedance.com/api/v3',
  resourceId: 'seed-tts-2.0',
  apiKeyEnv: 'DOUBAO_API_KEY',
  voice: 'zh_female_vv_uranus_bigtts',
  timeoutMs: 120_000,
} as const

const FORMATS: readonly AudioFormat[] = ['mp3']

const VOICES: readonly VoiceDescriptor[] = [
  {
    id: 'zh_female_vv_uranus_bigtts',
    label: 'Vivi 2.0',
    description: '豆包语音合成 2.0 女声',
  },
  {
    id: 'zh_female_xiaohe_uranus_bigtts',
    label: '小何 2.0',
    description: '豆包语音合成 2.0 女声',
  },
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
  if (/\/tts\/unidirectional\/sse$/.test(base)) return base
  return `${base}/tts/unidirectional/sse`
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

function errorForCode(code: number, message: string): TtsError {
  const text = redact(message.trim().slice(0, MAX_ERROR_SNIPPET))
  const suffix = text === '' ? '' : `: ${text}`
  if (code === 45000000) {
    return new TtsError('auth', `${PROVIDER} speaker/resource is not authorized (${code})${suffix}`, {
      provider: PROVIDER,
      retryable: false,
    })
  }
  if (code === 40402003) {
    return new TtsError('validation', `${PROVIDER} text exceeds the provider limit (${code})${suffix}`, {
      provider: PROVIDER,
      retryable: false,
    })
  }
  if (/quota exceeded|concurrency/i.test(message)) {
    return new TtsError('rate-limit', `${PROVIDER} concurrency/quota limit (${code})${suffix}`, {
      provider: PROVIDER,
      retryable: true,
    })
  }
  if (code === 55000000 || code >= 55000000) {
    return new TtsError('server', `${PROVIDER} server error (${code})${suffix}`, {
      provider: PROVIDER,
      retryable: true,
    })
  }
  return new TtsError('provider', `${PROVIDER} API error (${code})${suffix}`, {
    provider: PROVIDER,
    retryable: false,
  })
}

interface SseFrame {
  readonly event: string
  readonly payload: Record<string, unknown>
}

function parseFrame(block: string): SseFrame | undefined {
  let event = ''
  const data: string[] = []
  for (const rawLine of block.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart())
    }
  }
  if (data.length === 0) return undefined
  const text = data.join('\n')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new TtsError('provider', `${PROVIDER} returned an invalid SSE JSON frame`, {
      provider: PROVIDER,
      retryable: true,
    })
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new TtsError('provider', `${PROVIDER} returned a non-object SSE frame`, {
      provider: PROVIDER,
      retryable: true,
    })
  }
  return { event, payload: parsed as Record<string, unknown> }
}

async function decodeSse(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    throw new TtsError('provider', `${PROVIDER} SSE response has no body`, {
      provider: PROVIDER,
      retryable: true,
    })
  }
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let buffer = ''
  let finished = false

  const handleFrame = (frame: SseFrame): void => {
    const payload = frame.payload
    const code = typeof payload.code === 'number' ? payload.code : 0
    const message = typeof payload.message === 'string' ? payload.message : ''
    if (code !== 0 && code !== 20000000) {
      throw errorForCode(code, message)
    }
    if (frame.event === '153') {
      throw errorForCode(code === 0 ? 55000000 : code, message)
    }
    const data = payload.data
    if (typeof data === 'string' && data !== '') {
      const bytes = Buffer.from(data, 'base64')
      if (bytes.byteLength > 0) chunks.push(new Uint8Array(bytes))
    }
    if (frame.event === '152' || code === 20000000) {
      finished = true
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const frame = parseFrame(block)
        if (frame !== undefined) handleFrame(frame)
        index = buffer.indexOf('\n\n')
      }
    }
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n')
    if (buffer.trim() !== '') {
      const frame = parseFrame(buffer)
      if (frame !== undefined) handleFrame(frame)
    }
  } catch (error) {
    if (signal.aborted) throw classifyFetchError(error, { text: '', signal }, timeoutMs)
    if (error instanceof TtsError) throw error
    throw new TtsError('network', `${PROVIDER} SSE stream failed`, {
      provider: PROVIDER,
      retryable: true,
      cause: error,
    })
  } finally {
    reader.releaseLock()
  }

  if (!finished) {
    throw new TtsError('provider', `${PROVIDER} SSE stream ended without a finish event`, {
      provider: PROVIDER,
      retryable: true,
    })
  }
  if (chunks.length === 0) {
    throw new TtsError('provider', `${PROVIDER} SSE stream contained no audio`, {
      provider: PROVIDER,
      retryable: true,
    })
  }
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
  const audio = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    audio.set(chunk, offset)
    offset += chunk.byteLength
  }
  return audio
}

export const doubaoAdapter: ProviderAdapter = {
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

    const voice =
      firstNonEmpty(request.voice, config.voice, DEFAULTS.voice) ?? DEFAULTS.voice
    const baseURL = firstNonEmpty(config.baseURL, DEFAULTS.baseURL) ?? DEFAULTS.baseURL
    const resourceId =
      firstNonEmpty(config.resourceId, DEFAULTS.resourceId) ?? DEFAULTS.resourceId
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
      'X-Api-Key': key.trim(),
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }

    const reqParams: Record<string, unknown> = {
      text: request.text,
      speaker: voice,
      audio_params: { format: 'mp3', sample_rate: 24000 },
    }
    const model = firstNonEmpty(request.model, config.model)
    if (model !== undefined) reqParams.model = model

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
    let response: Response
    try {
      response = await runtime.fetch(endpointFor(baseURL), {
        method: 'POST',
        headers,
        body: JSON.stringify({ user: { uid: 'dsh-whale-tts' }, req_params: reqParams }),
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

    let audio: Uint8Array
    try {
      audio = await decodeSse(response, signal, timeoutMs)
    } catch (error) {
      throw classifyFetchError(error, request, timeoutMs)
    }
    const validated = validateAudio(audio, 'mp3', PROVIDER)
    return {
      data: audio,
      format: validated,
      voice,
      meta: {
        status: response.status,
        bytes: audio.byteLength,
        resourceId,
      },
    }
  },
}
