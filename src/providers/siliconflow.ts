/**
 * `siliconflow` provider adapter — SiliconFlow's OpenAI-compatible speech API.
 *
 * SiliconFlow exposes `POST {baseURL}/audio/speech` with the same request and
 * raw-audio response shape as OpenAI, so the OpenAI adapter does the protocol
 * work and this adapter only supplies its own defaults, voice catalogue and
 * error label. Keeping it a separate provider id means the settings card can
 * offer it next to MiMo without overloading `openai-compatible`.
 */
import { openaiAdapter } from './openai.js'
import {
  TtsError,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderRuntime,
  type SynthesisRequest,
  type SynthesisResult,
  type VoiceDescriptor,
} from '../types.js'

const PROVIDER = 'siliconflow'

const DEFAULTS = {
  baseURL: 'https://api.siliconflow.cn/v1',
  apiKeyEnv: 'SILICONFLOW_API_KEY',
  model: 'FunAudioLLM/CosyVoice2-0.5B',
  voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
  format: 'mp3' as const,
} as const

/** CosyVoice2 voices exposed by SiliconFlow's hosted model. */
const VOICES: readonly VoiceDescriptor[] = [
  {
    id: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    label: 'Alex',
    description: '自然男声（CosyVoice2）',
  },
  {
    id: 'FunAudioLLM/CosyVoice2-0.5B:anna',
    label: 'Anna',
    description: '自然女声（CosyVoice2）',
  },
  {
    id: 'FunAudioLLM/CosyVoice2-0.5B:bella',
    label: 'Bella',
    description: '温柔女声（CosyVoice2）',
  },
  {
    id: 'FunAudioLLM/CosyVoice2-0.5B:benjamin',
    label: 'Benjamin',
    description: '沉稳男声（CosyVoice2）',
  },
  {
    id: 'FunAudioLLM/CosyVoice2-0.5B:charles',
    label: 'Charles',
    description: '磁性男声（CosyVoice2）',
  },
  {
    id: 'FunAudioLLM/CosyVoice2-0.5B:claire',
    label: 'Claire',
    description: '清晰女声（CosyVoice2）',
  },
  {
    id: 'FunAudioLLM/CosyVoice2-0.5B:david',
    label: 'David',
    description: '成熟男声（CosyVoice2）',
  },
  {
    id: 'FunAudioLLM/CosyVoice2-0.5B:diana',
    label: 'Diana',
    description: '明亮女声（CosyVoice2）',
  },
]

const CAPABILITIES: ProviderCapabilities = {
  speech: true,
  singing: false,
  formats: ['mp3', 'wav'],
  voices: VOICES,
  requiresKey: true,
  voiceDesign: false,
  voiceClone: false,
}

/** Merge SiliconFlow defaults into a provider block without shadowing a non-empty override. */
function effectiveConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    baseURL: config.baseURL?.trim() || DEFAULTS.baseURL,
    apiKeyEnv: config.apiKeyEnv?.trim() || DEFAULTS.apiKeyEnv,
    model: config.model?.trim() || DEFAULTS.model,
    voice: config.voice?.trim() || DEFAULTS.voice,
    format: config.format ?? DEFAULTS.format,
    // SiliconFlow's /audio/speech does not document OpenAI's `instructions`
    // field; omitting it keeps compatible gateways from rejecting the request.
    style: '',
  }
}

export const siliconflowAdapter: ProviderAdapter = {
  id: PROVIDER,

  capabilities: CAPABILITIES,

  async synthesize(
    request: SynthesisRequest,
    config: ProviderConfig,
    runtime: ProviderRuntime,
  ): Promise<SynthesisResult> {
    try {
      const sanitized: SynthesisRequest =
        request.style === undefined ? request : { ...request, style: undefined }
      return await openaiAdapter.synthesize(sanitized, effectiveConfig(config), runtime)
    } catch (error) {
      if (!(error instanceof TtsError)) throw error
      // The OpenAI adapter labels its errors `openai-compatible`; surface the
      // provider the user actually selected.
      throw new TtsError(error.kind, error.message.split('openai-compatible').join(PROVIDER), {
        provider: PROVIDER,
        status: error.status,
        retryable: error.retryable,
        detail: error.detail,
        cause: error,
      })
    }
  },
}
