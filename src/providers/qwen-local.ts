/**
 * Local Qwen3-TTS adapter.
 *
 * Qwen3-TTS's open weights are served by a local process (official Python
 * demo, vLLM-Omni, or a thin FastAPI wrapper). This adapter talks to that
 * process over an OpenAI-compatible `POST /v1/audio/speech` endpoint, so the
 * DSH plugin never imports PyTorch or owns a GPU.
 *
 * Unlike `openai-compatible`, authentication is optional: a loopback sidecar
 * commonly has no key. Set `providers.qwen-local.apiKeyEnv` only when the local
 * server actually requires a bearer token.
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

const PROVIDER = 'qwen-local'

const DEFAULTS = {
  baseURL: 'http://127.0.0.1:8000/v1',
  model: 'Qwen/Qwen3-TTS-12Hz-0.6B',
  voice: 'Cherry',
  timeoutMs: 120_000,
} as const

const FORMATS: readonly AudioFormat[] = ['wav', 'mp3']

const VOICES: readonly VoiceDescriptor[] = [
  { id: 'Cherry', label: 'Cherry', description: 'Qwen3-TTS 本地默认音色（可按服务配置改）' },
  { id: 'default', label: 'Default', description: '服务端默认音色' },
]

const CAPABILITIES: ProviderCapabilities = {
  speech: true,
  singing: false,
  formats: FORMATS,
  voices: VOICES,
  requiresKey: false,
  voiceDesign: false,
  voiceClone: false,
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function formatFor(request: SynthesisRequest, config: ProviderConfig): AudioFormat {
  const wanted = request.format ?? config.format
  return wanted !== undefined && FORMATS.includes(wanted) ? wanted : 'wav'
}

function timeoutFor(config: ProviderConfig): number {
  const value = config.timeoutMs
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULTS.timeoutMs
  }
  return Math.max(1, Math.min(Math.floor(value), 600_000))
}

function endpointFor(baseURL: string): string {
  return `${baseURL.trim().replace(/\/+$/, '')}/audio/speech`
}

function classifyFetchError(
  error: unknown,
  request: SynthesisRequest,
  timeoutMs: number,
): TtsError {
  if (error instanceof TtsError) return error
  if (request.signal.aborted) {
    return new TtsError('aborted', 'synthesis aborted', { provider: PROVIDER, cause: error })
  }
  const name =
    error !== null && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new TtsError(
      'timeout',
      `${PROVIDER} request timed out after ${timeoutMs}ms; is the local Qwen3-TTS server running?`,
      { provider: PROVIDER, retryable: true, cause: error },
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return new TtsError('network', redact(`${PROVIDER} network error: ${message}`), {
    provider: PROVIDER,
    retryable: true,
    cause: error,
  })
}

function classifyStatus(status: number, body: string): TtsError {
  const snippet = redact(body.trim().slice(0, 200))
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

/**
 * OpenAI-compatible local Qwen3-TTS adapter.
 *
 * The sidecar must expose `POST /v1/audio/speech` and return raw WAV/MP3 bytes.
 * vLLM-Omni and a small FastAPI wrapper both satisfy this; the official Gradio
 * demo does not, so wrap it or use vLLM-Omni for the plugin.
 */
export const qwenLocalAdapter: ProviderAdapter = {
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
    const format = formatFor(request, config)
    const timeoutMs = timeoutFor(config)
    const baseURL = firstNonEmpty(config.baseURL, DEFAULTS.baseURL) ?? DEFAULTS.baseURL

    const headers: Record<string, string> = {
      ...(config.headers ?? {}),
      'Content-Type': 'application/json',
    }
    // Local sidecars often have no auth; only resolve a key when configured.
    const ref = firstNonEmpty(config.apiKeyEnv)
    if (ref !== undefined) {
      const key = await runtime.resolveKey(ref)
      if (typeof key === 'string' && key.trim() !== '') {
        headers.Authorization = `Bearer ${key.trim()}`
      }
    }

    const payload: Record<string, unknown> = {
      model,
      voice,
      input: request.text,
      response_format: format,
    }
    const style = request.style ?? config.style ?? ''
    if (style.trim() !== '') payload.instructions = style

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

    let audio: Uint8Array
    try {
      audio = new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      throw classifyFetchError(error, request, timeoutMs)
    }
    const validated = validateAudio(audio, format, PROVIDER)
    return {
      data: audio,
      format: validated,
      voice,
      meta: { model, status: response.status, bytes: audio.byteLength, local: true },
    }
  },
}
