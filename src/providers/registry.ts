/**
 * Provider registry: the built-in adapters, their default configuration and
 * the capability table exposed to `tts_list_voices` / `tts_status`.
 */
import type { ProviderAdapter, ProviderConfig } from '../types.js'
import { openaiAdapter } from './openai.js'
import { mimoAdapter } from './mimo.js'
import { sapiAdapter } from './sapi.js'
import { minimaxAdapter } from './minimax.js'
import { siliconflowAdapter } from './siliconflow.js'
import { qwenLocalAdapter } from './qwen-local.js'
import { qwenAdapter } from './qwen.js'

/**
 * Default provider blocks. Duplicated from `config.ts` defaults on purpose:
 * a user patch that restates the `providers` dict may omit keys, and the
 * adapters must still see their own defaults.
 */
export const BUILTIN_PROVIDER_DEFAULTS: Readonly<Record<string, ProviderConfig>> = {
  'openai-compatible': {
    enabled: true,
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-4o-mini-tts',
    designModel: '',
    cloneModel: '',
    voice: 'alloy',
    format: 'mp3',
  },
  mimo: {
    enabled: true,
    baseURL: 'https://api.xiaomimimo.com/v1',
    apiKeyEnv: 'MIMO_API_KEY',
    model: 'mimo-v2.5-tts',
    designModel: 'mimo-v2.5-tts-voicedesign',
    cloneModel: 'mimo-v2.5-tts-voiceclone',
    voice: '苏打',
    format: 'wav',
    designOptimizeText: true,
  },
  minimax: {
    enabled: true,
    baseURL: 'https://api.minimax.cn/v1',
    apiKeyEnv: 'MINIMAX_API_KEY',
    model: 'speech-2.8-turbo',
    designModel: '',
    cloneModel: '',
    voice: 'male-qn-jingying',
    format: 'mp3',
  },
  siliconflow: {
    enabled: true,
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    designModel: '',
    cloneModel: '',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    format: 'mp3',
  },
  'qwen-local': {
    enabled: true,
    baseURL: 'http://127.0.0.1:8000/v1',
    apiKeyEnv: '',
    model: 'Qwen/Qwen3-TTS-12Hz-0.6B',
    designModel: '',
    cloneModel: '',
    voice: 'Cherry',
    format: 'wav',
    timeoutMs: 120_000,
  },
  qwen: {
    enabled: true,
    baseURL: 'https://dashscope.aliyuncs.com/api/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    model: 'qwen3-tts-flash',
    designModel: '',
    cloneModel: '',
    voice: 'Cherry',
    format: 'wav',
    timeoutMs: 60_000,
  },
  sapi: {
    enabled: true,
    format: 'wav',
  },
}

/**
 * Providers a user may pick as the primary provider.
 *
 * MiMo, SiliconFlow and MiniMax are wired end-to-end. OpenAI-compatible and
 * SAPI stay available internally (SAPI is the offline fallback) but are not
 * offered as primary choices until they are validated against a real key.
 */
export const SELECTABLE_PROVIDERS: ReadonlySet<string> = new Set([
  'mimo',
  'siliconflow',
  'minimax',
  'qwen',
  'qwen-local',
])

/**
 * True when `id` may be chosen as the primary provider.
 *
 * Unknown ids return `true` so tests and third-party adapters keep working;
 * only known built-ins can be switched off.
 */
export function isProviderSelectable(id: string): boolean {
  if (BUILTIN_PROVIDER_DEFAULTS[id] === undefined) return true
  return SELECTABLE_PROVIDERS.has(id)
}

/** Every built-in adapter, keyed by provider id. */
export const BUILTIN_ADAPTERS: ReadonlyMap<string, ProviderAdapter> = new Map<
  string,
  ProviderAdapter
>([
  [openaiAdapter.id, openaiAdapter],
  [mimoAdapter.id, mimoAdapter],
  [minimaxAdapter.id, minimaxAdapter],
  [siliconflowAdapter.id, siliconflowAdapter],
  [qwenLocalAdapter.id, qwenLocalAdapter],
  [qwenAdapter.id, qwenAdapter],
  [sapiAdapter.id, sapiAdapter],
])

/** Look up an adapter (built-in by default; tests may pass their own table). */
export function getAdapter(
  id: string,
  adapters: ReadonlyMap<string, ProviderAdapter> = BUILTIN_ADAPTERS,
): ProviderAdapter | undefined {
  return adapters.get(id)
}

/** All adapters in registration order. */
export function listAdapters(
  adapters: ReadonlyMap<string, ProviderAdapter> = BUILTIN_ADAPTERS,
): ProviderAdapter[] {
  return [...adapters.values()]
}

/**
 * Merge the user's provider block over the adapter defaults.
 *
 * The plugin's Config schema fills every provider field with a default (mostly
 * `''`), so a partial `providers:` block in `cordis.patch.yml` reaches us as
 * "present but empty" values. Those must not shadow a non-empty built-in
 * default (`designModel`, `cloneModel`, `model`, `baseURL`, `voice`, ...):
 * otherwise a patch that only sets `enabled`/`apiKeyEnv` silently disables
 * voice design. An explicit non-empty value always wins.
 *
 * The returned object never contains `undefined` values, so adapters can use it
 * directly.
 */
export function providerConfigFor(
  id: string,
  providers: Readonly<Record<string, ProviderConfig>> = {},
): ProviderConfig {
  const defaults = (BUILTIN_PROVIDER_DEFAULTS[id] ?? {}) as Record<string, unknown>
  const configured = (providers[id] ?? {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...defaults }
  for (const [key, value] of Object.entries(configured)) {
    if (value === undefined) continue
    const fallback = defaults[key]
    if (typeof value === 'string' && value === '' && typeof fallback === 'string' && fallback !== '') {
      continue
    }
    merged[key] = value
  }
  return merged as ProviderConfig
}

/**
 * Whether an adapter is usable on this platform. `sapi` is Windows-only; the
 * others are platform independent.
 */
export function adapterAvailable(
  adapter: ProviderAdapter,
  platform: NodeJS.Platform,
): boolean {
  const platforms = adapter.capabilities.platforms
  return platforms === undefined || platforms.includes(platform)
}
