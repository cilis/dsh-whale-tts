/**
 * Plugin configuration schema.
 *
 * Every user-adjustable knob lives here (the "no hardcoded tunables" rule:
 * changing only `cordis.patch.yml` must change behaviour). The settings card
 * writes these fields through the DSH settings form, so each field is marked
 * volatile: the Loader updates the live reference in place and emits
 * `loader/volatile-update` instead of remounting the plugin.
 *
 * `.volatile()` only exists in the schemastery build shipped by DSH 0.2.1;
 * the `^3.18.1` range can resolve to a build without it. `volatileSchema()`
 * therefore degrades to the equivalent `.extra('volatile', true)` metadata,
 * which the Loader understands in both builds.
 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { AudioFormat, KeyType, ProviderConfig } from './types.js'

/** Output format choice: `auto` follows the provider's default format. */
export type FormatChoice = AudioFormat | 'auto'

/** Which parameter area the settings card shows. */
export type StudioMode = 'preset' | 'design' | 'clone'

/** How the settings card stores the API key. */
export type KeySourceMode = 'reuse' | 'manual'

/** Key-type choice; `auto` derives it from the key prefix. */
export type KeyTypeChoice = KeyType | 'auto'

/** Mark a schema node editable without remounting the plugin. */
function volatileSchema<S>(schema: S): S {
  const node = schema as unknown as {
    volatile?: () => unknown
    extra?: (key: string, value: unknown) => unknown
  }
  if (typeof node.volatile === 'function') return node.volatile() as S
  if (typeof node.extra === 'function') return node.extra('volatile', true) as S
  return schema
}

/** Shared provider block schema; adapter-specific defaults live in the registry. */
const ProviderSchema = z.object({
  enabled: z.boolean().default(true),
  baseURL: z.string().default(''),
  apiKeyEnv: z.string().role('credential-ref').default(''),
  model: z.string().default(''),
  designModel: z.string().default(''),
  cloneModel: z.string().default(''),
  voice: z.string().default(''),
  format: z.union([z.const('wav'), z.const('mp3')]).default('wav'),
  timeoutMs: z.number().min(1).max(600_000).step(1).default(30_000),
  retry: z.number().min(0).max(5).step(1).default(1),
  style: z.string().default(''),
  designOptimizeText: z.boolean().default(true),
  headers: z.dict(z.string()).default({}),
  voiceName: z.string().default(''),
  scriptPath: z.string().default(''),
  rate: z.number().min(-10).max(10).step(1).default(0),
})

/** Default provider blocks. Users restate the whole `providers` dict to change one. */
export const DEFAULT_PROVIDERS = {
  'openai-compatible': {
    enabled: false,
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-4o-mini-tts',
    designModel: '',
    cloneModel: '',
    voice: 'alloy',
    format: 'mp3' as const,
    timeoutMs: 30_000,
    retry: 1,
    style: '',
    headers: {},
    voiceName: '',
    scriptPath: '',
    rate: 0,
  },
  mimo: {
    enabled: true,
    baseURL: 'https://api.xiaomimimo.com/v1',
    apiKeyEnv: 'MIMO_API_KEY',
    model: 'mimo-v2.5-tts',
    designModel: 'mimo-v2.5-tts-voicedesign',
    cloneModel: 'mimo-v2.5-tts-voiceclone',
    voice: '苏打',
    format: 'wav' as const,
    timeoutMs: 30_000,
    retry: 1,
    style: '',
    designOptimizeText: true,
    headers: {},
    voiceName: '',
    scriptPath: '',
    rate: 0,
  },
  minimax: {
    enabled: true,
    baseURL: 'https://api.minimax.cn/v1',
    apiKeyEnv: 'MINIMAX_API_KEY',
    model: 'speech-2.8-turbo',
    designModel: '',
    cloneModel: '',
    voice: 'male-qn-jingying',
    format: 'mp3' as const,
    timeoutMs: 30_000,
    retry: 1,
    style: '',
    headers: {},
    voiceName: '',
    scriptPath: '',
    rate: 0,
  },
  siliconflow: {
    enabled: true,
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    designModel: '',
    cloneModel: '',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    format: 'mp3' as const,
    timeoutMs: 30_000,
    retry: 1,
    style: '',
    headers: {},
    voiceName: '',
    scriptPath: '',
    rate: 0,
  },
  sapi: {
    enabled: true,
    baseURL: '',
    apiKeyEnv: '',
    model: '',
    voice: '',
    format: 'wav' as const,
    timeoutMs: 60_000,
    retry: 0,
    style: '',
    headers: {},
    voiceName: '',
    scriptPath: '',
    rate: 0,
  },
} satisfies Record<string, ProviderConfig>

/**
 * Plugin configuration.
 *
 * Fields typed `Volatile<T>` must be read with `.get()` at the start of an
 * operation; `snapshot()` below does that for the whole config at once.
 */
export interface Config {
  /** Default provider id. */
  provider: Volatile<string>
  /** Providers tried in order when the primary fails with a retryable error. */
  fallback: Volatile<string[]>
  /** Per-provider blocks (deployment configuration; not edited by the card). */
  providers: Record<string, ProviderConfig>

  output: {
    /** Output directory template, e.g. `${DSH_HOME}/whale-tts`. */
    dir: Volatile<string>
    /** File-name template without extension. */
    filename: Volatile<string>
    /** Requested output format; `auto` follows each provider's default. */
    format: Volatile<FormatChoice>
    /** Overwrite an existing file instead of failing. */
    overwrite: Volatile<boolean>
  }

  cache: {
    enabled: Volatile<boolean>
    /** Cache directory template; empty means `<output.dir>/.cache`. */
    dir: Volatile<string>
    maxAgeDays: Volatile<number>
  }

  limits: {
    /** Hard cap on characters per synthesis request. */
    maxChars: Volatile<number>
  }

  readAloud: {
    /** Read newly finalized assistant replies automatically. */
    auto: Volatile<boolean>
    /** Drop fenced/inline code instead of voicing it. */
    skipCode: Volatile<boolean>
    /** Target characters per speech segment (capped by limits.maxChars). */
    segmentChars: Volatile<number>
    /** Playback rate for read-aloud audio (1 = normal speed). */
    rate: Volatile<number>
  }

  log: {
    /** Log the text being synthesised. Off by default (privacy). */
    text: Volatile<boolean>
  }

  // ---- Settings-card state (all volatile) ----

  /** Active voice profile id; empty means "provider default voice". */
  activeProfileId: Volatile<string>
  /** Which parameter area the card shows. */
  studioMode: Volatile<StudioMode>
  /** Preset voice id used when no profile is active. */
  presetVoiceId: Volatile<string>
  /** Custom voice id (free-form, for private/new preset ids). */
  customVoiceId: Volatile<string>
  /** Voice-design description (workshop input). */
  designDescription: Volatile<string>
  /** Number of candidates to generate (2..5). */
  designCandidateCount: Volatile<number>
  /** Sentence spoken by design candidates and clone previews. */
  sampleText: Volatile<string>
  /** Sentence used by the card's "preview" button and connection test. */
  previewText: Volatile<string>
  /** Credential reference name for the active provider. */
  apiKeyEnv: Volatile<string>
  /** Whether the key is reused from DSH or entered manually. */
  keySource: Volatile<KeySourceMode>
  /** Base URL override for the active provider (empty = provider default). */
  baseURLOverride: Volatile<string>
  /** Key-type override; `auto` derives it from the prefix. */
  keyType: Volatile<KeyTypeChoice>
}

/** Plugin configuration schema. */
export const Config = z.object({
  provider: volatileSchema(z.string().default('mimo')),
  fallback: volatileSchema(z.array(z.string()).default(['sapi'])),
  providers: z.dict(ProviderSchema).default(DEFAULT_PROVIDERS),

  output: z.object({
    dir: volatileSchema(z.string().default('${DSH_HOME}/whale-tts')),
    filename: volatileSchema(z.string().default('tts-{timestamp}-{rand}')),
    format: volatileSchema(
      z.union([z.const('auto'), z.const('wav'), z.const('mp3')]).default('auto'),
    ),
    overwrite: volatileSchema(z.boolean().default(false)),
  }),

  cache: z.object({
    enabled: volatileSchema(z.boolean().default(true)),
    dir: volatileSchema(z.string().default('${DSH_HOME}/whale-tts/.cache')),
    maxAgeDays: volatileSchema(z.number().min(1).max(3650).step(1).default(30)),
  }),

  limits: z.object({
    maxChars: volatileSchema(z.number().min(1).max(100_000).step(1).default(2000)),
  }),

  readAloud: z.object({
    auto: volatileSchema(z.boolean().default(false)),
    skipCode: volatileSchema(z.boolean().default(true)),
    segmentChars: volatileSchema(z.number().min(200).max(1800).step(100).default(600)),
    rate: volatileSchema(z.number().min(0.75).max(1.5).step(0.25).default(1)),
  }),

  log: z.object({
    text: volatileSchema(z.boolean().default(false)),
  }),

  activeProfileId: volatileSchema(z.string().default('')),
  studioMode: volatileSchema(
    z.union([z.const('preset'), z.const('design'), z.const('clone')]).default('preset'),
  ),
  presetVoiceId: volatileSchema(z.string().default('苏打')),
  customVoiceId: volatileSchema(z.string().default('')),
  designDescription: volatileSchema(z.string().default('')),
  designCandidateCount: volatileSchema(z.number().min(2).max(5).step(1).default(3)),
  sampleText: volatileSchema(z.string().default('你好，我是魈。')),
  previewText: volatileSchema(z.string().default('你好，我是魈。')),
  apiKeyEnv: volatileSchema(z.string().default('')),
  keySource: volatileSchema(
    z.union([z.const('reuse'), z.const('manual')]).default('reuse'),
  ),
  baseURLOverride: volatileSchema(z.string().default('')),
  keyType: volatileSchema(
    z
      .union([
        z.const('auto'),
        z.const('pay-as-you-go'),
        z.const('token-plan'),
        z.const('token-plan-team'),
        z.const('custom'),
      ])
      .default('auto'),
  ),
})

/** Plain (unwrapped) view of one config value. */
function plain<T>(value: Volatile<T> | T): T {
  const maybe = value as { get?: () => T }
  return typeof maybe?.get === 'function' ? maybe.get() : (value as T)
}

/** Plain snapshot of the whole configuration, taken once per operation. */
export interface ConfigSnapshot {
  provider: string
  fallback: string[]
  providers: Record<string, ProviderConfig>
  output: { dir: string; filename: string; format: FormatChoice; overwrite: boolean }
  cache: { enabled: boolean; dir: string; maxAgeDays: number }
  limits: { maxChars: number }
  readAloud: { auto: boolean; skipCode: boolean; segmentChars: number; rate: number }
  log: { text: boolean }
  activeProfileId: string
  studioMode: StudioMode
  presetVoiceId: string
  customVoiceId: string
  designDescription: string
  designCandidateCount: number
  sampleText: string
  previewText: string
  apiKeyEnv: string
  keySource: KeySourceMode
  baseURLOverride: string
  keyType: KeyTypeChoice
}

/** Wrap a possibly-volatile config into a plain object. */
export function snapshot(config: Config): ConfigSnapshot {
  return {
    provider: plain(config.provider),
    fallback: plain(config.fallback) ?? [],
    providers: config.providers ?? {},
    output: {
      dir: plain(config.output.dir),
      filename: plain(config.output.filename),
      format: plain(config.output.format),
      overwrite: plain(config.output.overwrite),
    },
    cache: {
      enabled: plain(config.cache.enabled),
      dir: plain(config.cache.dir),
      maxAgeDays: plain(config.cache.maxAgeDays),
    },
    limits: { maxChars: plain(config.limits.maxChars) },
    readAloud: {
      auto: plain(config.readAloud?.auto) ?? false,
      skipCode: plain(config.readAloud?.skipCode) ?? true,
      segmentChars: plain(config.readAloud?.segmentChars) ?? 600,
      rate: plain(config.readAloud?.rate) ?? 1,
    },
    log: { text: plain(config.log.text) },
    activeProfileId: plain(config.activeProfileId),
    studioMode: plain(config.studioMode),
    presetVoiceId: plain(config.presetVoiceId),
    customVoiceId: plain(config.customVoiceId),
    designDescription: plain(config.designDescription),
    designCandidateCount: plain(config.designCandidateCount),
    sampleText: plain(config.sampleText),
    previewText: plain(config.previewText),
    apiKeyEnv: plain(config.apiKeyEnv),
    keySource: plain(config.keySource),
    baseURLOverride: plain(config.baseURLOverride),
    keyType: plain(config.keyType),
  }
}
