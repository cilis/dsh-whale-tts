/**
 * Shared types for dsh-whale-tts.
 *
 * This module is deliberately free of DSH runtime imports so that the unit
 * tests, the provider adapters, the voice-profile store and the browser half
 * (type-only imports) can all share one vocabulary.
 */

/** Audio container formats the plugin can produce. */
export type AudioFormat = 'wav' | 'mp3'

/** How the plugin should read a credential ref for a provider. */
export type KeySource = 'environment' | 'credentials' | 'missing'

/**
 * Billing family of a Xiaomi MiMo API key, derived from its prefix.
 *
 * - `pay-as-you-go`: `sk-` platform key, base URL `https://api.xiaomimimo.com/v1`.
 * - `token-plan`: `tp-` personal Token Plan key.
 * - `token-plan-team`: `ttp-` team Token Plan key.
 * - `custom`: any other prefix (self-hosted gateway, third-party proxy, ...).
 */
export type KeyType = 'pay-as-you-go' | 'token-plan' | 'token-plan-team' | 'custom' | 'unknown'

/** Non-secret description of a provider credential. Never carries the value. */
export interface KeyInfo {
  /** Credential reference name, e.g. `MIMO_API_KEY`. */
  readonly ref: string
  readonly configured: boolean
  readonly source: KeySource
  readonly keyType: KeyType
  /**
   * Whether this plugin wrote the credential itself. Only owned refs may be
   * cleared from the card; a shared DSH credential is read-only there.
   */
  readonly owned?: boolean
}

/** A voice a provider can synthesise with. */
export interface VoiceDescriptor {
  readonly id: string
  readonly label?: string
  readonly description?: string
}

/** Static capability declaration of a provider adapter. */
export interface ProviderCapabilities {
  /** Speech synthesis support. */
  readonly speech: boolean
  /**
   * Singing support. Kept for a future release: no tool or UI exposes it yet.
   * The current release never synthesises singing.
   */
  readonly singing: boolean
  /** Formats the provider can emit. The first entry is its default. */
  readonly formats: readonly AudioFormat[]
  /** Built-in voices known without a network round trip. */
  readonly voices: readonly VoiceDescriptor[]
  /** Whether a credential is required before calling the provider. */
  readonly requiresKey: boolean
  /** Whether the provider can generate a voice from a text description (voice design). */
  readonly voiceDesign?: boolean
  /** Whether the provider can clone a voice from reference audio. */
  readonly voiceClone?: boolean
  /** Platform restriction; omitted means every platform. */
  readonly platforms?: readonly NodeJS.Platform[]
}

/** One provider block inside the plugin Config. Every key is optional so that
 * a user patch can restate only the keys it changes; defaults come from the
 * built-in provider defaults and the schema. */
export interface ProviderConfig {
  /** Master switch for the provider. */
  readonly enabled?: boolean
  /** Provider API root. Empty means "use the adapter default". */
  readonly baseURL?: string
  /** Credential reference name. Empty means "the adapter default ref". */
  readonly apiKeyEnv?: string
  /** Provider model id. Empty means "the adapter default". */
  readonly model?: string
  /** Model id used for voice design (empty means the adapter has no design model). */
  readonly designModel?: string
  /** Model id used for voice cloning (empty means the adapter has no clone model). */
  readonly cloneModel?: string
  /** Provider voice id. Empty means "the adapter default". */
  readonly voice?: string
  /** Requested output format. Adapter falls back to its first supported format. */
  readonly format?: AudioFormat
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Retries for retryable failures (timeout/network/429/5xx). */
  readonly retry?: number
  /** Default style instruction (providers that accept one). */
  readonly style?: string
  /**
   * Ask a voice-design model to polish the demo text so it fits the designed
   * voice (`audio.optimize_text_preview` on MiMo). Only used by design calls;
   * defaults to true in the adapter.
   */
  readonly designOptimizeText?: boolean
  /** Extra HTTP headers, e.g. for a self-hosted gateway. */
  readonly headers?: Readonly<Record<string, string>>
  /** SAPI voice name (empty = the system default voice). */
  readonly voiceName?: string
  /** SAPI PowerShell script path (empty = the bundled script). */
  readonly scriptPath?: string
  /** SAPI speaking rate in words per minute (empty = script default). */
  readonly rate?: number
}

/** Request handed to a provider adapter. `signal` must abort the work. */
export interface SynthesisRequest {
  readonly text: string
  /** Voice id (preset id, or a `data:` URL for clone providers). */
  readonly voice?: string
  readonly format?: AudioFormat
  /** Natural-language style instruction; ignored by providers that do not support it. */
  readonly style?: string
  /** Model id override for providers whose model varies per voice profile. */
  readonly model?: string
  readonly signal: AbortSignal
}

/** Provider output. */
export interface SynthesisResult {
  readonly data: Uint8Array
  readonly format: AudioFormat
  readonly voice: string
  readonly meta?: Readonly<Record<string, unknown>>
}

/** Ambient services a provider adapter needs; all injectable for tests. */
export interface ProviderRuntime {
  /** `fetch` implementation. Adapters never call the global one directly. */
  readonly fetch: typeof fetch
  /** Resolve a credential ref to its secret value, or `undefined`. */
  readonly resolveKey: (ref: string) => Promise<string | undefined>
  readonly logger: LoggerLike
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: NodeJS.Platform
  /** Working paths the adapter may need (bundled script, temp directory). */
  readonly paths: ProviderPaths
}

/** Paths an adapter may use. */
export interface ProviderPaths {
  /** Absolute path of the bundled SAPI script. */
  readonly sapiScript: string
  /** Absolute path of the plugin state directory (used for temp files). */
  readonly stateDir: string
}

/** Minimal logging surface; matches the subset of `ctx.logger` we rely on. */
export interface LoggerLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** A provider adapter. */
export interface ProviderAdapter {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  synthesize(
    request: SynthesisRequest,
    config: ProviderConfig,
    runtime: ProviderRuntime,
  ): Promise<SynthesisResult>
  /** Optional network voice listing; not used by this release. */
  listVoices?(
    config: ProviderConfig,
    runtime: ProviderRuntime,
  ): Promise<readonly VoiceDescriptor[]>
}

/** Failure families. The family decides retry and fallback behaviour. */
export type TtsErrorKind =
  | 'validation' // bad input; never retried, never falls back
  | 'auth' // 401/403: key missing or invalid
  | 'quota' // 402: balance or plan exhausted
  | 'rate-limit' // 429
  | 'content-filter' // provider refused the text
  | 'timeout'
  | 'network'
  | 'server' // 5xx
  | 'provider' // other provider error
  | 'config' // misconfiguration (missing provider block, unsupported format)
  | 'platform' // provider not available on this platform
  | 'not-implemented'
  | 'aborted'

/**
 * Error raised by providers and the synthesis pipeline.
 *
 * Messages never contain secrets or the text being synthesised: callers build
 * user-facing summaries from `message` (already redacted) and `provider`.
 */
export class TtsError extends Error {
  readonly kind: TtsErrorKind
  readonly provider?: string
  readonly status?: number
  readonly retryable: boolean
  readonly detail?: Readonly<Record<string, unknown>>

  constructor(
    kind: TtsErrorKind,
    message: string,
    options: {
      provider?: string
      status?: number
      retryable?: boolean
      detail?: Readonly<Record<string, unknown>>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TtsError'
    this.kind = kind
    this.provider = options.provider
    this.status = options.status
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(kind)
    this.detail = options.detail
  }
}

const DEFAULT_RETRYABLE: ReadonlySet<TtsErrorKind> = new Set<TtsErrorKind>([
  'timeout',
  'network',
  'rate-limit',
  'server',
])

/** True when a thrown value is a TtsError. */
export function isTtsError(value: unknown): value is TtsError {
  return value instanceof TtsError
}

/** Coerce any thrown value into a TtsError without leaking internals. */
export function asTtsError(value: unknown, fallbackProvider?: string): TtsError {
  if (isTtsError(value)) return value
  const message = value instanceof Error ? value.message : String(value)
  return new TtsError('provider', redact(message), {
    provider: fallbackProvider,
    cause: value,
  })
}

/**
 * Strip obvious secret material from a message before it reaches logs, the
 * model, or the browser. Keys never appear in our own messages; this is a
 * defensive net for provider payloads echoed back to us.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|tp|ttp)-[A-Za-z0-9_-]{6,}/g, '$1-***')
    .replace(/("?(?:api[-_]?key|authorization|token|secret)"?\s*[:=]\s*"?)([^\s",}]{4,})/gi, '$1***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
}

/** Voice profile kinds. */
export type VoiceProfileKind = 'preset' | 'clone' | 'design'

/**
 * Provider settings captured when a voice profile is saved. Only references
 * and routing choices are stored; secret values never enter a profile.
 */
export interface VoiceProfileProviderSettings {
  /** Credential reference name (not the key value). */
  readonly apiKeyEnv?: string
  /** Per-profile Base URL override. */
  readonly baseURLOverride?: string
  /** Billing family selector; `auto` keeps the inferred family. */
  readonly keyType?: KeyType | 'auto'
}

/**
 * One stored voice profile.
 *
 * - `preset` synthesises with a provider preset voice id.
 * - `clone` synthesises with a reference-audio sample (voice cloning).
 * - `design` is a workshop record: it stores the description and candidate
 *   history, and cannot be activated for synthesis directly.
 */
export interface VoiceProfile {
  readonly id: string
  readonly name: string
  readonly kind: VoiceProfileKind
  /** Provider this profile was saved for; absent on older/unbound profiles. */
  readonly provider?: string
  /** Provider settings to restore when the profile is activated. */
  readonly providerSettings?: VoiceProfileProviderSettings
  /** Optional free-form note or design description. */
  readonly description?: string
  readonly tags?: readonly string[]
  /** For `preset`: provider voice id. */
  readonly presetVoiceId?: string
  /** For `clone`: sample file name relative to `<state>/voices/`. */
  readonly sampleFile?: string
  readonly sampleBytes?: number
  readonly sampleMime?: string
  /** For `design`: the description used to generate candidates. */
  readonly designDescription?: string
  /**
   * Default style instruction sent as the provider's `user` message whenever
   * this profile is active. Voice design puts the tone/emotion in the design
   * prompt, so a profile adopted from a candidate keeps that prompt here; without
   * it the cloned voice would only carry timbre, not the intended delivery.
   */
  readonly styleInstruction?: string
  /** For `design`: candidate ids kept as history. */
  readonly designCandidates?: readonly string[]
  /** ISO-8601 timestamps. */
  readonly createdAt: string
  readonly updatedAt: string
}

/** Persisted voice-profile state (`voices.json`). */
export interface VoiceState {
  readonly version: 1
  /** Single activation pointer; `null` means "provider default voice". */
  readonly activeProfileId: string | null
  readonly profiles: readonly VoiceProfile[]
}

/** One temporary design candidate on disk. */
export interface DesignCandidate {
  readonly id: string
  readonly file: string
  readonly bytes: number
  readonly format: AudioFormat
  readonly createdAt: string
}

/** Result of resolving "what should this synthesis use". */
export interface ResolvedVoice {
  /** Model id override, when the voice kind dictates a specific model. */
  readonly model?: string
  /** Provider voice id, or a `data:` URL for clone samples. */
  readonly voice?: string
  /** Reference-audio payload for clone profiles (host-internal only). */
  readonly sample?: { readonly data: Uint8Array; readonly mime: string }
  /** Style instruction stored on the active profile (see `styleInstruction`). */
  readonly style?: string
  readonly profileId?: string
  readonly profileName?: string
}

/** Synthesis result returned by the service (and therefore by the tool). */
export interface SynthesisOutcome {
  readonly ok: true
  readonly path: string
  readonly relativePath: string
  readonly file: string
  readonly format: AudioFormat
  readonly provider: string
  readonly voice: string
  readonly cached: boolean
  readonly bytes: number
  readonly elapsedMs: number
}

/** Per-provider status row. Never contains secrets or text. */
export interface ProviderStatus {
  readonly configured: boolean
  readonly enabled: boolean
  readonly keyRequired: boolean
  readonly keyConfigured: boolean
  readonly keyType?: KeyType
  readonly keyRef?: string
  readonly available: boolean
  /** Whether the settings card may offer this provider as the primary one. */
  readonly selectable: boolean
  readonly model?: string
  readonly voice?: string
  readonly baseURL?: string
  readonly lastError?: string
}

/** One backup file on disk. */
export interface BackupFileInfo {
  /** Absolute path of the backup file. */
  readonly path: string
  /** File name only. */
  readonly file: string
  readonly bytes: number
  /** ISO-8601 creation time (file mtime for listings). */
  readonly createdAt: string
  /** Profile count, when known (export result / import document). */
  readonly profiles?: number
  /** Design-candidate count, when known. */
  readonly candidates?: number
}

/** Result of importing a backup. */
export interface BackupImportResult {
  readonly mode: 'merge' | 'replace'
  readonly importedProfiles: number
  readonly importedCandidates: number
  readonly activeProfileId: string | null
  /** Backup written automatically before the import touched anything. */
  readonly safetyBackup: BackupFileInfo
  readonly warnings: readonly string[]
}

/** Whole-plugin status. */
export interface TtsStatus {
  readonly provider: string
  readonly fallback: readonly string[]
  readonly providers: Readonly<Record<string, ProviderStatus>>
  readonly activeProfileId: string | null
  readonly activeVoice: string
  readonly cache: { readonly enabled: boolean; readonly files: number; readonly bytes: number }
  readonly outputDir: string
  readonly platform: NodeJS.Platform
  /** Output-directory diagnostics for QQBot-style voice-library handoff. */
  readonly preflight?: {
    readonly exists: boolean
    readonly writable: boolean
    readonly looksLikeQqbotAudio: boolean
    readonly warning?: string
  }
}

/** Capability matrix row returned by `tts_list_voices`. */
export interface ProviderVoiceList {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  readonly voices: readonly VoiceDescriptor[]
}

/** Payload `tts_list_voices` returns. */
export interface VoiceCatalog {
  readonly providers: readonly ProviderVoiceList[]
  readonly profiles: readonly VoiceProfile[]
  readonly activeProfileId: string | null
}
