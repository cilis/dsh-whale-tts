/**
 * The synthesis service: the single place that turns text into an audio file.
 *
 * Tools, Remote endpoints and previews all go through this class so caching,
 * voice-profile resolution, credential handling, provider fallback and output
 * writing behave identically everywhere.
 */
import { basename, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  TtsError,
  asTtsError,
  type BackupFileInfo,
  type AudioFormat,
  type DesignCandidate,
  type KeyInfo,
  type KeySource,
  type KeyType,
  type LoggerLike,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderRuntime,
  type ProviderStatus,
  type ResolvedVoice,
  type SynthesisOutcome,
  type SynthesisRequest,
  type SynthesisResult,
  type TtsStatus,
  type VoiceCatalog,
  type VoiceProfile,
  type VoiceProfileKind,
  type BackupImportResult,
} from '../types.js'
import { snapshot, type Config, type ConfigSnapshot } from '../config.js'
import { KeyResolver, defaultBaseURLFor, type CredentialBridge } from '../credentials.js'
import { VoiceStore, type VoiceImportProfile, type VoiceProfileInput } from './voices.js'
import { OwnedKeyStore } from './owned-keys.js'
import { SynthesisCache } from './cache.js'
import { assertText, cacheKey, normalizeStyle } from './text.js'
import {
  buildFilename,
  fileBytes,
  joinInside,
  readFileBytes,
  timestampToken,
  writeAudioFile,
} from './audio.js'
import {
  ensureDirectory,
  resolveDirectory,
  stateDirectory,
  toPosixRelative,
  type TemplateEnvironment,
} from './paths.js'
import {
  adapterAvailable,
  getAdapter,
  isProviderSelectable,
  listAdapters,
  providerConfigFor,
} from '../providers/registry.js'
import { runChain } from './chain.js'

/** Construction options. Everything machine-specific is injectable for tests. */
export interface TtsServiceOptions {
  readonly config: Config
  readonly logger: LoggerLike
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly tmp?: string
  readonly platform?: NodeJS.Platform
  readonly fetch?: typeof fetch
  readonly credentials?: CredentialBridge
  readonly adapters?: ReadonlyMap<string, ProviderAdapter>
  /** Override the state directory (`$DSH_HOME/whale-tts`) in tests. */
  readonly stateDir?: string
}

/** One synthesis request from a tool, the card or the Remote API. */
export interface SynthesizeInput {
  readonly text: string
  readonly provider?: string
  readonly voice?: string
  readonly format?: AudioFormat
  readonly style?: string
  readonly filename?: string
}

/** A produced audio file shown as a playable preview. */
export interface PreviewResult {
  readonly path: string
  readonly file: string
  readonly relativePath: string
  readonly format: AudioFormat
  readonly provider: string
  readonly voice: string
  readonly bytes: number
  readonly elapsedMs: number
}

/** Result of the settings card's "test connection" action. */
export interface ConnectionTestResult {
  readonly ok: boolean
  readonly provider: string
  readonly keyConfigured: boolean
  readonly keyType: KeyType
  readonly latencyMs: number
  readonly error?: { readonly kind: string; readonly message: string }
}

/** Everything needed to run one provider request. */
interface PreparedRequest {
  readonly snap: ConfigSnapshot
  readonly providerId: string
  readonly adapter: ProviderAdapter
  readonly providerConfig: ProviderConfig
  readonly request: SynthesisRequest
  readonly providers: Record<string, ProviderConfig>
  readonly keyType: KeyType
  readonly keyConfigured: boolean
  readonly resolvedVoice: ResolvedVoice
}

/** Directory names under the plugin state directory. */
const PREVIEW_DIR = 'preview'
const MAX_PREVIEW_FILES = 20

/** Build a `data:` URL for a cloned voice sample. */
export function sampleDataUrl(sample: { data: Uint8Array; mime: string }): string {
  return `data:${sample.mime};base64,${Buffer.from(sample.data).toString('base64')}`
}

/**
 * Stable token describing the voice for cache keys. Clone samples are keyed by
 * profile id (not by their bytes) so the key stays small.
 */
export function cacheVoiceToken(resolved: ResolvedVoice, voice: string | undefined): string {
  if (resolved.profileId !== undefined) return `profile:${resolved.profileId}`
  return voice ?? ''
}

/** Resolve the format a provider will actually emit. */
export function resolveFormat(
  capabilities: ProviderCapabilities | undefined,
  requested: string | undefined,
): AudioFormat {
  const supported = capabilities?.formats ?? (['wav', 'mp3'] as const)
  const wanted = requested === 'wav' || requested === 'mp3' ? requested : undefined
  if (wanted !== undefined && supported.includes(wanted)) return wanted
  return (supported[0] ?? 'wav') as AudioFormat
}

/** Clamp a candidate count into the supported 2..5 (or 1..5) range. */
export function clampCandidateCount(value: number): number {
  const number = Number.isFinite(value) ? Math.trunc(value) : 3
  return Math.min(5, Math.max(1, number))
}

/* ---- backup document -------------------------------------------------- */

/** Format marker written into every export; imports reject anything else. */
export const BACKUP_FORMAT = 'dsh-whale-tts-backup'
/** Current backup document version. */
const BACKUP_VERSION = 1
/** Sub-directory of the state dir holding exported backups. */
const BACKUP_DIRECTORY = 'backups'
/** How many backup documents to keep (older ones are pruned on export). */
const MAX_BACKUPS = 10
/** Upper bound for one uploaded/read backup document. */
const MAX_BACKUP_BYTES = 256 * 1024 * 1024
/** Base64 text length that corresponds to {@link MAX_BACKUP_BYTES}. */
const MAX_BACKUP_BASE64_CHARS = Math.ceil((MAX_BACKUP_BYTES * 4) / 3) + 1024

/** Non-secret configuration snapshot stored for reference only. */
interface BackupConfig {
  readonly provider: string
  readonly fallback: readonly string[]
  readonly apiKeyEnv: string
  readonly keySource: string
  readonly keyType: string
  readonly baseURLOverride: string
  readonly presetVoiceId: string
  readonly customVoiceId: string
  readonly designDescription: string
  readonly activeProfileId: string
  readonly output: { readonly dir: string; readonly format: string }
  readonly limits: { readonly maxChars: number }
  readonly readAloud?: {
    readonly auto: boolean
    readonly skipCode: boolean
    readonly segmentChars: number
    readonly rate: number
  }
}

/** The on-disk export document. */
interface BackupDocument {
  readonly format: string
  readonly version: number
  readonly createdAt: string
  readonly app: string
  readonly config?: BackupConfig
  readonly keyRefs?: readonly string[]
  readonly activeProfileId?: string | null
  readonly profiles?: readonly unknown[]
  readonly samples?: readonly unknown[]
  readonly candidates?: readonly unknown[]
}

/** True for plain JSON objects (not arrays, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trimmed non-empty string or `undefined`. */
function optionalStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** TTS service. */
export class TtsService {
  readonly voices: VoiceStore
  readonly keys: KeyResolver

  private readonly options: TtsServiceOptions
  private readonly logger: LoggerLike
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly platform: NodeJS.Platform
  private readonly adapters: ReadonlyMap<string, ProviderAdapter>
  private readonly fetchImpl: typeof fetch
  private readonly stateDir: string
  /** Refs this plugin wrote itself; only those may be cleared from the card. */
  private readonly ownedKeys: OwnedKeyStore
  private readonly inflight = new Map<string, Promise<SynthesisOutcome>>()
  private initPromise: Promise<void> | undefined
  private initialized = false

  constructor(options: TtsServiceOptions) {
    this.options = options
    this.logger = options.logger
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.adapters = options.adapters ?? new Map<string, ProviderAdapter>()
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    const environment = this.environment()
    this.stateDir = options.stateDir ?? stateDirectory(environment)
    this.voices = new VoiceStore({ dir: this.stateDir, logger: this.logger })
    this.ownedKeys = new OwnedKeyStore({
      file: join(this.stateDir, 'keys-owned.json'),
      logger: this.logger,
    })
    this.keys = new KeyResolver({
      credentials: options.credentials,
      env: this.env,
    })
  }

  /** Create directories and load the voice store (idempotent, cached promise). */
  async init(): Promise<void> {
    if (this.initPromise === undefined) {
      this.initPromise = this.initInternal().catch((error: unknown) => {
        // Allow a later call to retry after a transient filesystem failure.
        this.initPromise = undefined
        throw error
      })
    }
    return this.initPromise
  }

  private async initInternal(): Promise<void> {
    if (this.initialized) return
    await ensureDirectory(this.stateDir)
    await this.voices.init()
    this.initialized = true
    await this.cleanupPreviews()
    try {
      await new SynthesisCache({ ...this.cacheOptions(this.snapshot()), enabled: true }).cleanup()
    } catch (error) {
      this.logger.warn('[whale-tts] cache cleanup skipped: %s', (error as Error).message)
    }
  }

  /** Snapshot of the live configuration. */
  snapshot(): ConfigSnapshot {
    return snapshot(this.options.config)
  }

  /** Called when the plugin unloads. */
  dispose(): void {
    this.inflight.clear()
  }

  // ---------------------------------------------------------------- helpers

  private environment(): TemplateEnvironment {
    return {
      env: this.env,
      home: this.options.home,
      tmp: this.options.tmp,
    }
  }

  private adapterMap(): ReadonlyMap<string, ProviderAdapter> {
    return this.adapters.size > 0
      ? this.adapters
      : new Map(listAdapters().map((adapter) => [adapter.id, adapter]))
  }

  /** The bundled SAPI script next to the installed package. */
  private sapiScript(): string {
    return fileURLToPath(new URL('../../scripts/sapi.ps1', import.meta.url))
  }

  private runtime(): ProviderRuntime {
    return {
      fetch: this.fetchImpl,
      resolveKey: async (ref: string) => (await this.keys.resolve(ref))?.value,
      logger: this.logger,
      env: this.env,
      platform: this.platform,
      paths: { sapiScript: this.sapiScript(), stateDir: this.stateDir },
    }
  }

  private outputDirectory(snap: ConfigSnapshot): string {
    return resolveDirectory(snap.output.dir, this.environment(), 'output.dir')
  }

  private cacheOptions(snap: ConfigSnapshot): {
    enabled: boolean
    dir: string
    maxAgeDays: number
  } {
    const outputDir = this.outputDirectory(snap)
    const configured = snap.cache.dir.trim()
    const dir =
      configured === ''
        ? join(outputDir, '.cache')
        : resolveDirectory(configured, this.environment(), 'cache.dir')
    return {
      enabled: snap.cache.enabled,
      dir,
      maxAgeDays: snap.cache.maxAgeDays,
    }
  }

  private previewDirectory(): string {
    return join(this.stateDir, PREVIEW_DIR)
  }

  /** Credential ref for a provider: the card override wins for the active provider. */
  private credentialRefFor(
    providerId: string,
    snap: ConfigSnapshot,
    providerConfig: ProviderConfig,
  ): string {
    const override = snap.apiKeyEnv.trim()
    if (override !== '' && providerId === snap.provider) return override
    return providerConfig.apiKeyEnv ?? ''
  }

  /** Build the per-request provider table (key ref + BaseURL overrides). */
  private effectiveProviders(
    providerId: string,
    snap: ConfigSnapshot,
    providerConfig: ProviderConfig,
    keyType: KeyType,
  ): Record<string, ProviderConfig> {
    const baseURL =
      snap.baseURLOverride.trim() !== ''
        ? snap.baseURLOverride.trim()
        : (defaultBaseURLFor(providerId, keyType) ?? providerConfig.baseURL ?? '')
    const override: ProviderConfig = {
      ...providerConfig,
      apiKeyEnv: this.credentialRefFor(providerId, snap, providerConfig),
      baseURL,
    } as ProviderConfig
    return { ...snap.providers, [providerId]: override }
  }

  /** Resolve the voice for a synthesis attempt. */
  private async resolveVoice(
    snap: ConfigSnapshot,
    providerConfig: ProviderConfig,
  ): Promise<ResolvedVoice> {
    return this.voices.resolveVoice({
      activeProfileId: snap.activeProfileId,
      presetVoiceId: snap.presetVoiceId,
      customVoiceId: snap.customVoiceId,
      presetModel: providerConfig.model ?? '',
      cloneModel: providerConfig.cloneModel ?? '',
    })
  }

  /** Prepare a provider request (shared by synthesis, design and connection test). */
  private async prepare(
    input: SynthesizeInput,
    signal: AbortSignal,
    options: {
      readonly model?: string
      readonly style?: string
      readonly ignoreVoice?: boolean
    } = {},
  ): Promise<PreparedRequest> {
    const snap = this.snapshot()
    const text = assertText(input.text, snap.limits.maxChars)
    const providerId = (input.provider ?? snap.provider).trim() || snap.provider
    const adapter = getAdapter(providerId, this.adapterMap())
    if (adapter === undefined) {
      const known = [...this.adapterMap().keys()].join(', ')
      throw new TtsError('config', `unknown provider "${providerId}"; available: ${known}`)
    }
    if (!isProviderSelectable(providerId)) {
      throw new TtsError(
        'config',
        `provider "${providerId}" is not available yet; choose "mimo" (offline SAPI remains available as a fallback)`,
        { detail: { provider: providerId } },
      )
    }
    const providerConfig = providerConfigFor(providerId, snap.providers)
    const ref = this.credentialRefFor(providerId, snap, providerConfig)
    const keyInfo = ref === '' ? undefined : await this.keys.resolve(ref)
    const keyType: KeyType = snap.keyType !== 'auto' ? snap.keyType : (keyInfo?.keyType ?? 'unknown')

    const resolvedVoice = options.ignoreVoice === true
      ? {}
      : await this.resolveVoice(snap, providerConfig)

    if (resolvedVoice.sample !== undefined && adapter.capabilities.voiceClone !== true) {
      throw new TtsError(
        'validation',
        `provider "${providerId}" cannot synthesise with a cloned voice profile`,
      )
    }

    let voice: string | undefined = resolvedVoice.voice
    if (resolvedVoice.sample !== undefined) voice = sampleDataUrl(resolvedVoice.sample)
    if (voice === undefined && input.voice !== undefined && input.voice.trim() !== '') {
      voice = input.voice.trim()
    }

    const format = resolveFormat(
      adapter.capabilities,
      input.format ??
        (snap.output.format !== 'auto' ? snap.output.format : undefined) ??
        providerConfig.format,
    )
    // Style precedence: explicit call options (design generation / tool
    // override) → the active profile's stored style instruction → provider
    // default. Keeping the profile style here is what preserves a designed
    // voice's delivery after it is frozen into a clone profile.
    const style = normalizeStyle(
      options.style ?? input.style ?? resolvedVoice.style ?? providerConfig.style,
    )
    const model = (options.model ?? resolvedVoice.model ?? providerConfig.model ?? '').trim()

    const request: SynthesisRequest = {
      text,
      voice,
      format,
      style,
      model: model === '' ? undefined : model,
      signal,
    }
    const providers = this.effectiveProviders(providerId, snap, providerConfig, keyType)
    return {
      snap,
      providerId,
      adapter,
      providerConfig,
      request,
      providers,
      keyType,
      keyConfigured: keyInfo !== undefined,
      resolvedVoice,
    }
  }

  /** Run the provider chain for a prepared request. */
  private async runPrepared(
    prepared: PreparedRequest,
    options: { readonly fallback?: readonly string[] } = {},
  ): Promise<{
    result: SynthesisResult
    provider: string
  }> {
    const chain = await runChain({
      provider: prepared.providerId,
      fallback: options.fallback ?? prepared.snap.fallback,
      providers: prepared.providers,
      request: prepared.request,
      runtime: this.runtime(),
      adapters: this.adapterMap(),
      logger: this.logger,
    })
    return { result: chain.result, provider: chain.provider }
  }

  // -------------------------------------------------------------- synthesis

  /**
   * Synthesise text into a new audio file under `output.dir`.
   *
   * @param input - text plus optional overrides.
   * @param signal - cancellation from the tool call or the HTTP request.
   */
  async synthesize(input: SynthesizeInput, signal: AbortSignal): Promise<SynthesisOutcome> {
    const snap = this.snapshot()
    const dedupeKey = JSON.stringify([
      input.text,
      input.provider ?? snap.provider,
      input.voice ?? '',
      input.format ?? '',
      input.style ?? '',
      input.filename ?? '',
      snap.activeProfileId,
      snap.presetVoiceId,
      snap.customVoiceId,
      snap.apiKeyEnv,
    ])
    const existing = this.inflight.get(dedupeKey)
    if (existing !== undefined) return existing
    const promise = this.synthesizeInternal(input, signal).finally(() => {
      this.inflight.delete(dedupeKey)
    })
    this.inflight.set(dedupeKey, promise)
    return promise
  }

  private async synthesizeInternal(
    input: SynthesizeInput,
    signal: AbortSignal,
  ): Promise<SynthesisOutcome> {
    const startedAt = Date.now()
    const prepared = await this.prepare(input, signal)
    const { snap, request } = prepared
    const cache = new SynthesisCache(this.cacheOptions(snap))
    const key = cacheKey({
      provider: prepared.providerId,
      model: request.model ?? '',
      voice: cacheVoiceToken(prepared.resolvedVoice, request.voice),
      format: request.format ?? 'wav',
      style: request.style,
      text: request.text,
    })

    const hit = await cache.get(key, request.format ?? 'wav')
    const outputDir = await ensureDirectory(this.outputDirectory(snap))
    if (hit !== undefined) {
      const cacheFile = join(cache.dir, `${key}.${hit.format}`)
      this.logSynthesis(prepared, request.text.length, true)
      return {
        ok: true,
        path: cacheFile,
        relativePath: toPosixRelative(outputDir, cacheFile),
        file: basename(cacheFile),
        format: hit.format,
        provider: prepared.providerId,
        voice: request.voice ?? prepared.providerConfig.voice ?? '',
        cached: true,
        bytes: hit.data.byteLength,
        elapsedMs: Date.now() - startedAt,
      }
    }

    // A cloned voice must be synthesised by the clone-capable provider itself:
    // a fallback would silently speak in a different voice and hide the failure.
    const { result, provider } = await this.runPrepared(prepared, {
      fallback: prepared.resolvedVoice.sample === undefined ? undefined : [],
    })
    const format = result.format
    const template =
      input.filename !== undefined && input.filename.trim() !== ''
        ? input.filename
        : snap.output.filename
    const filename = buildFilename({ template, format })
    const target = await writeAudioFile(outputDir, filename, result.data, snap.output.overwrite)
    await cache.put(key, format, result.data)
    this.logSynthesis(prepared, request.text.length, false)
    return {
      ok: true,
      path: target,
      relativePath: toPosixRelative(outputDir, target),
      file: basename(target),
      format,
      provider,
      voice: result.voice,
      cached: false,
      bytes: result.data.byteLength,
      elapsedMs: Date.now() - startedAt,
    }
  }

  private logSynthesis(prepared: PreparedRequest, chars: number, cached: boolean): void {
    const snap = prepared.snap
    if (snap.log.text) {
      this.logger.info(
        '[whale-tts] synthesised %d chars via %s (cached=%s)',
        chars,
        prepared.providerId,
        String(cached),
      )
    } else {
      this.logger.debug?.(
        '[whale-tts] synthesised %d chars via %s (cached=%s)',
        chars,
        prepared.providerId,
        String(cached),
      )
    }
  }

  /**
   * Synthesise into the preview directory so the card can play it without
   * writing into the consumer's audio library.
   */
  async preview(
    input: { text?: string; signal: AbortSignal },
  ): Promise<PreviewResult> {
    const snap = this.snapshot()
    const text =
      input.text !== undefined && input.text.trim() !== ''
        ? input.text
        : snap.previewText !== ''
          ? snap.previewText
          : '你好，我是这个声音。'
    const startedAt = Date.now()
    const prepared = await this.prepare({ text }, input.signal)
    const { result, provider } = await this.runPrepared(prepared, {
      fallback: prepared.resolvedVoice.sample === undefined ? undefined : [],
    })
    const directory = await ensureDirectory(this.previewDirectory())
    const filename = buildFilename({
      template: 'preview-{timestamp}-{rand}',
      format: result.format,
    })
    const target = await writeAudioFile(directory, filename, result.data, true)
    await this.prunePreviews()
    return {
      path: target,
      file: basename(target),
      relativePath: toPosixRelative(directory, target),
      format: result.format,
      provider,
      voice: result.voice,
      bytes: result.data.byteLength,
      elapsedMs: Date.now() - startedAt,
    }
  }

  /** Synthesise a short sentence and classify the failure for the connection test. */
  async testConnection(
    options: { readonly provider?: string; readonly signal: AbortSignal },
  ): Promise<ConnectionTestResult> {
    const startedAt = Date.now()
    const snap = this.snapshot()
    const providerId = (options.provider ?? snap.provider).trim() || snap.provider
    const text = (snap.previewText || '连接测试呀').slice(0, 5)
    let keyConfigured = false
    let keyType: KeyType = 'unknown'
    try {
      const providerConfig = providerConfigFor(providerId, snap.providers)
      const ref = this.credentialRefFor(providerId, snap, providerConfig)
      const keyInfo = ref === '' ? undefined : await this.keys.resolve(ref)
      keyConfigured = keyInfo !== undefined
      keyType = snap.keyType !== 'auto' ? snap.keyType : (keyInfo?.keyType ?? 'unknown')
      const prepared = await this.prepare({ text, provider: providerId }, options.signal)
      await this.runPrepared(prepared)
      return {
        ok: true,
        provider: providerId,
        keyConfigured,
        keyType,
        latencyMs: Date.now() - startedAt,
      }
    } catch (rawError) {
      const error = asTtsError(rawError, providerId)
      return {
        ok: false,
        provider: providerId,
        keyConfigured,
        keyType,
        latencyMs: Date.now() - startedAt,
        error: { kind: error.kind, message: error.message },
      }
    }
  }

  // ----------------------------------------------------------- voice design

  /**
   * Generate voice-design candidates with the configured design model.
   * Candidates land in `design/` until adopted or cleaned up.
   */
  async designCandidates(
    options: {
      readonly signal: AbortSignal
      /** Override the configured description (settings card draft). */
      readonly description?: string
      /** Override the configured candidate count. */
      readonly count?: number
      /** Override the configured sample sentence. */
      readonly sampleText?: string
    },
  ): Promise<DesignCandidate[]> {
    const snap = this.snapshot()
    const description = (options.description ?? snap.designDescription).trim()
    if (description === '') {
      throw new TtsError('validation', 'design description is empty')
    }
    const providerId = snap.provider
    const adapter = getAdapter(providerId, this.adapterMap())
    if (adapter === undefined) {
      throw new TtsError('config', `unknown provider "${providerId}"`)
    }
    if (adapter.capabilities.voiceDesign !== true) {
      throw new TtsError(
        'validation',
        `provider "${providerId}" does not support voice design`,
      )
    }
    const providerConfig = providerConfigFor(providerId, snap.providers)
    const model = (providerConfig.designModel ?? '').trim()
    if (model === '') {
      throw new TtsError(
        'config',
        `provider "${providerId}" has no designModel configured`,
      )
    }
    const configuredSample = (options.sampleText ?? snap.sampleText).trim()
    const sampleText =
      configuredSample !== '' ? configuredSample : snap.previewText.trim()
    if (sampleText === '') {
      throw new TtsError('validation', 'design sample sentence is empty')
    }
    const count = clampCandidateCount(options.count ?? snap.designCandidateCount)
    const candidates: DesignCandidate[] = []
    for (let index = 0; index < count; index += 1) {
      if (options.signal.aborted) {
        throw new TtsError('aborted', 'voice design aborted')
      }
      const prepared = await this.prepare(
        { text: sampleText, provider: providerId },
        options.signal,
        { model, style: description, ignoreVoice: true },
      )
      // Voice design must come from the design model: falling back to another
      // provider would produce a candidate that silently ignores the
      // description (for example an offline SAPI voice).
      const { result } = await this.runPrepared(prepared, { fallback: [] })
      candidates.push(await this.voices.saveCandidate(result.data, result.format))
    }
    return candidates
  }

  /** Generate design candidates and adopt one in a single call. */
  async adoptCandidate(
    candidateId: string,
    name: string,
    description?: string,
  ): Promise<VoiceProfile> {
    return this.voices.adoptCandidate(candidateId, name, description)
  }

  // ------------------------------------------------------------- inspection

  /** Status for `tts_status` and the settings card. Never contains secrets or text. */
  async status(): Promise<TtsStatus> {
    const snap = this.snapshot()
    const adapters = this.adapterMap()
    const providers: Record<string, ProviderStatus> = {}
    for (const adapter of adapters.values()) {
      const providerConfig = providerConfigFor(adapter.id, snap.providers)
      const enabled = providerConfig.enabled !== false
      const available = enabled && adapterAvailable(adapter, this.platform)
      const ref = this.credentialRefFor(adapter.id, snap, providerConfig)
      let keyConfigured = !adapter.capabilities.requiresKey
      let keyType: KeyType | undefined
      let lastError: string | undefined
      if (adapter.capabilities.requiresKey) {
        if (ref === '') {
          keyConfigured = false
          lastError = 'no credential reference configured'
        } else {
          const info = await this.keys.describe(ref)
          keyConfigured = info.configured
          keyType = info.keyType
          if (!info.configured) lastError = `credential ${ref} is not configured`
        }
      }
      providers[adapter.id] = {
        configured: ref !== '' || !adapter.capabilities.requiresKey,
        enabled,
        keyRequired: adapter.capabilities.requiresKey,
        keyConfigured,
        keyType,
        keyRef: ref === '' ? undefined : ref,
        available,
        selectable: isProviderSelectable(adapter.id),
        model: providerConfig.model ?? '',
        voice: providerConfig.voice ?? '',
        baseURL:
          snap.baseURLOverride.trim() !== ''
            ? snap.baseURLOverride.trim()
            : (defaultBaseURLFor(adapter.id, keyType ?? 'unknown') ?? providerConfig.baseURL ?? ''),
        lastError,
      }
    }
    let outputDir = ''
    try {
      outputDir = this.outputDirectory(snap)
    } catch (error) {
      outputDir = snap.output.dir
      this.logger.warn('[whale-tts] invalid output.dir: %s', (error as Error).message)
    }
    let cacheStats = { files: 0, bytes: 0 }
    try {
      cacheStats = await new SynthesisCache(this.cacheOptions(snap)).stats()
    } catch {
      // Status must never throw because of an unreadable cache directory.
    }
    const active = await this.voices.active()
    return {
      provider: snap.provider,
      fallback: snap.fallback,
      providers,
      activeProfileId: active?.id ?? null,
      activeVoice: active?.name ?? (snap.customVoiceId || snap.presetVoiceId || 'provider default'),
      cache: { enabled: snap.cache.enabled, files: cacheStats.files, bytes: cacheStats.bytes },
      outputDir,
      platform: this.platform,
    }
  }

  /** Capability and voice listing for `tts_list_voices`. */
  async listVoices(): Promise<VoiceCatalog> {
    const snap = this.snapshot()
    const state = await this.voices.state()
    const providers = [...this.adapterMap().values()].map((adapter) => ({
      id: adapter.id,
      capabilities: adapter.capabilities,
      voices: [...adapter.capabilities.voices],
    }))
    return {
      providers,
      profiles: state.profiles,
      activeProfileId: state.activeProfileId,
    }
  }

  /** Effective output directory, exposed for the settings card. */
  outputDirectoryForCard(): { dir: string; cacheDir: string; stateDir: string } {
    const snap = this.snapshot()
    return {
      dir: this.outputDirectory(snap),
      cacheDir: this.cacheOptions(snap).dir,
      stateDir: this.stateDir,
    }
  }

  // -------------------------------------------------------- preview files

  /** List preview files currently on disk (for cleanup / diagnostics). */
  async listPreviews(): Promise<string[]> {
    try {
      const entries = await readdir(this.previewDirectory())
      return entries.filter((entry) => entry.endsWith('.wav') || entry.endsWith('.mp3'))
    } catch {
      return []
    }
  }

  private async cleanupPreviews(): Promise<void> {
    try {
      const entries = await readdir(this.previewDirectory())
      for (const entry of entries) {
        await rm(join(this.previewDirectory(), entry), { force: true })
      }
    } catch {
      // Nothing to clean.
    }
  }

  private async prunePreviews(): Promise<void> {
    try {
      const directory = this.previewDirectory()
      const entries = await readdir(directory)
      if (entries.length <= MAX_PREVIEW_FILES) return
      const stats = await Promise.all(
        entries.map(async (entry) => ({
          entry,
          mtime: (await stat(join(directory, entry))).mtimeMs,
        })),
      )
      stats.sort((a, b) => a.mtime - b.mtime)
      for (const item of stats.slice(0, stats.length - MAX_PREVIEW_FILES)) {
        await rm(join(directory, item.entry), { force: true })
      }
    } catch {
      // Best effort.
    }
  }

  // ----------------------------------------------------------- voice store

  /** List stored voice profiles. */
  async listProfiles(): Promise<readonly VoiceProfile[]> {
    return this.voices.list()
  }

  /** @see VoiceStore.save */
  async saveProfile(input: VoiceProfileInput): Promise<VoiceProfile> {
    return this.voices.save(input)
  }

  /** @see VoiceStore.remove */
  async deleteProfile(
    id: string,
  ): Promise<{ ok: true; activeProfileId: string | null; removedSamples: string[] }> {
    return this.voices.remove(id)
  }

  /** @see VoiceStore.activate */
  async activateProfile(id: string | null): Promise<{ activeProfileId: string | null }> {
    const state = await this.voices.activate(id)
    return { activeProfileId: state.activeProfileId }
  }

  /** @see VoiceStore.duplicate */
  async duplicateProfile(id: string, name?: string): Promise<VoiceProfile> {
    return this.voices.duplicate(id, name)
  }

  /** Store an uploaded reference sample and return its relative file name. */
  async uploadSample(
    data: Uint8Array,
    mime: string,
    extension: 'wav' | 'mp3',
  ): Promise<{ sampleFile: string; sampleBytes: number; sampleMime: string }> {
    return this.voices.saveSample(data, mime, extension)
  }

  /** Candidates currently on disk. */
  async listCandidates(): Promise<readonly DesignCandidate[]> {
    return this.voices.listCandidates()
  }

  /** Discard design candidates (all when `ids` is omitted). */
  async discardCandidates(ids?: readonly string[]): Promise<number> {
    return this.voices.discardCandidates(ids)
  }

  /** Read a sample for playback by the settings card. */
  async readSample(sampleFile: string): Promise<{ data: Uint8Array; mime: string }> {
    return this.voices.readSample(sampleFile)
  }

  /** Bytes of a preview file for the settings card player. */
  async readPreview(file: string): Promise<{ data: Uint8Array; mime: string }> {
    return this.readAudioUnder(this.previewDirectory(), file, 'preview')
  }

  /** Bytes of a design candidate for the settings card player. */
  async readDesign(file: string): Promise<{ data: Uint8Array; mime: string }> {
    return this.readAudioUnder(join(this.stateDir, 'design'), file, 'design candidate')
  }

  private async readAudioUnder(
    directory: string,
    file: string,
    label: string,
  ): Promise<{ data: Uint8Array; mime: string }> {
    const safe = basename(file)
    const target = join(directory, safe)
    const bytes = await fileBytes(target)
    if (bytes <= 0) {
      throw new TtsError('validation', `${label} file not found: ${safe}`)
    }
    const data = await readFileBytes(target)
    return { data, mime: safe.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' }
  }

  /** Voice profile kinds this provider supports (for the card's model selector). */
  providerCapabilities(): ReadonlyMap<string, ProviderCapabilities> {
    return new Map([...this.adapterMap().entries()].map(([id, adapter]) => [id, adapter.capabilities]))
  }

  /** Kind of a resolved profile, for the card. */
  static profileKind(profile: VoiceProfile): VoiceProfileKind {
    return profile.kind
  }

  /** Key metadata for a ref, without the secret. */
  async describeKey(ref: string) {
    return this.keys.describe(ref)
  }

  /** Candidate credential refs and their status. */
  async credentialCandidates() {
    const refs = await this.ownedKeys.list()
    const rows = await this.keys.candidates()
    return rows.map((row) => ({ ...row, owned: refs.includes(row.ref) }))
  }

  /**
   * Store a key entered through the settings card.
   *
   * The ref is recorded as plugin-owned so the card may later clear exactly the
   * keys it wrote, and never a credential that only DSH owns.
   */
  async setKey(ref: string, value: string): Promise<KeyInfo> {
    const info = await this.keys.set(ref, value)
    await this.ownedKeys.add(info.ref)
    return info
  }

  /** Delete a plugin-owned key; shared DSH credentials are refused. */
  async clearKey(ref: string): Promise<KeyInfo> {
    const name = (ref ?? '').trim()
    if (!(await this.ownedKeys.has(name))) {
      throw new TtsError(
        'validation',
        `凭据「${name}」不是由本插件写入的 DSH 共享凭据，这里不会删除；请到 DSH 凭据设置中移除`,
        { detail: { ref: name } },
      )
    }
    const info = await this.keys.clear(name)
    await this.ownedKeys.remove(name)
    return info
  }

  /** Default BaseURLs for the current key families. */
  static readonly defaultBaseURLFor = defaultBaseURLFor

  /* ---- backup / restore ---------------------------------------------- */

  /** Directory holding exported backup documents. */
  private backupDirectory(): string {
    return join(this.stateDir, BACKUP_DIRECTORY)
  }

  /**
   * Export the whole voice library (profiles, samples, candidates) plus a
   * non-secret configuration snapshot into one JSON backup file.
   *
   * Credential *values* are never written; only reference names are recorded.
   */
  async exportBackup(): Promise<BackupFileInfo> {
    await this.init()
    await ensureDirectory(this.backupDirectory())
    const data = await this.voices.exportData()
    const snap = this.snapshot()
    const createdAt = new Date().toISOString()
    const document: BackupDocument = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt,
      app: 'dsh-whale-tts',
      config: {
        provider: snap.provider,
        fallback: [...snap.fallback],
        apiKeyEnv: snap.apiKeyEnv,
        keySource: snap.keySource,
        keyType: snap.keyType,
        baseURLOverride: snap.baseURLOverride,
        presetVoiceId: snap.presetVoiceId,
        customVoiceId: snap.customVoiceId,
        designDescription: snap.designDescription,
        activeProfileId: snap.activeProfileId,
        output: { dir: snap.output.dir, format: snap.output.format },
        limits: { maxChars: snap.limits.maxChars },
        readAloud: {
          auto: snap.readAloud.auto,
          skipCode: snap.readAloud.skipCode,
          segmentChars: snap.readAloud.segmentChars,
          rate: snap.readAloud.rate,
        },
      },
      keyRefs: await this.ownedKeys.list(),
      activeProfileId: data.activeProfileId,
      profiles: data.profiles,
      samples: data.samples,
      candidates: data.candidates,
    }
    const file = `whale-tts-backup-${timestampToken(new Date())}-${randomBytes(3).toString('hex')}.json`
    const target = joinInside(this.backupDirectory(), file)
    const raw = `${JSON.stringify(document, null, 2)}\n`
    const temporary = `${target}.tmp-${randomBytes(4).toString('hex')}`
    try {
      await writeFile(temporary, raw, 'utf8')
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new TtsError('config', `cannot write backup file: ${target}`, { cause: error })
    }
    await this.pruneBackups()
    this.logger.info(
      '[whale-tts] backup exported; file=%s bytes=%d profiles=%d candidates=%d',
      file,
      Buffer.byteLength(raw),
      data.profiles.length,
      data.candidates.length,
    )
    return {
      path: target,
      file,
      bytes: Buffer.byteLength(raw),
      createdAt,
      profiles: data.profiles.length,
      candidates: data.candidates.length,
    }
  }

  /** Backup files on disk, newest first (metadata only). */
  async listBackups(): Promise<readonly BackupFileInfo[]> {
    await this.init()
    const directory = this.backupDirectory()
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return []
    }
    const files: BackupFileInfo[] = []
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.json')) continue
      try {
        const info = await stat(joinInside(directory, entry))
        if (!info.isFile()) continue
        files.push({
          path: joinInside(directory, entry),
          file: entry,
          bytes: info.size,
          createdAt: info.mtime.toISOString(),
        })
      } catch {
        // vanished between readdir and stat
      }
    }
    return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Import a backup document.
   *
   * The current library is exported to a safety backup first, then the document
   * is applied (`merge` appends, `replace` clears first). Configuration in the
   * document is reported but never applied; credentials are never part of a
   * backup.
   */
  async importBackup(options: {
    readonly mode?: 'merge' | 'replace'
    readonly base64?: string
    readonly path?: string
  }): Promise<BackupImportResult> {
    await this.init()
    const mode = options.mode === 'replace' ? 'replace' : 'merge'
    let raw: string
    if (typeof options.base64 === 'string' && options.base64.trim() !== '') {
      const encoded = options.base64.trim()
      if (encoded.length > MAX_BACKUP_BASE64_CHARS) {
        throw new TtsError('validation', 'backup upload is too large', {
          detail: { maxBytes: MAX_BACKUP_BYTES },
        })
      }
      raw = Buffer.from(encoded, 'base64').toString('utf8')
    } else if (typeof options.path === 'string' && options.path.trim() !== '') {
      const target = resolve(options.path.trim())
      const info = await stat(target).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        throw new TtsError('validation', `backup file not found: ${options.path}`)
      }
      if (info.size > MAX_BACKUP_BYTES) {
        throw new TtsError('validation', 'backup file is too large', {
          detail: { bytes: info.size, maxBytes: MAX_BACKUP_BYTES },
        })
      }
      raw = await readFile(target, 'utf8')
    } else {
      throw new TtsError('validation', 'import requires "base64" or "path"')
    }

    let document: BackupDocument
    try {
      document = JSON.parse(raw) as BackupDocument
    } catch {
      throw new TtsError('validation', 'backup file is not valid JSON')
    }
    if (
      !isRecord(document) ||
      document.format !== BACKUP_FORMAT ||
      typeof document.version !== 'number'
    ) {
      throw new TtsError('validation', 'backup format is not recognised')
    }
    if (document.version > BACKUP_VERSION) {
      throw new TtsError(
        'validation',
        `backup version ${String(document.version)} is newer than this plugin supports`,
      )
    }

    const samples = new Map<string, { data: Uint8Array; mime: string }>()
    for (const sample of Array.isArray(document.samples) ? document.samples : []) {
      if (!isRecord(sample) || typeof sample.file !== 'string' || typeof sample.base64 !== 'string') {
        continue
      }
      const data = Buffer.from(sample.base64, 'base64')
      if (data.byteLength === 0) continue
      samples.set(sample.file, {
        data: new Uint8Array(data),
        mime: typeof sample.mime === 'string' && sample.mime !== '' ? sample.mime : 'audio/wav',
      })
    }
    const candidates: { data: Uint8Array; format: AudioFormat }[] = []
    for (const candidate of Array.isArray(document.candidates) ? document.candidates : []) {
      if (!isRecord(candidate) || typeof candidate.base64 !== 'string') continue
      const data = Buffer.from(candidate.base64, 'base64')
      if (data.byteLength === 0) continue
      candidates.push({
        data: new Uint8Array(data),
        format: candidate.format === 'mp3' ? 'mp3' : 'wav',
      })
    }
    const profilesInput: VoiceImportProfile[] = []
    let activeProfileIndex: number | null = null
    for (const profile of Array.isArray(document.profiles) ? document.profiles : []) {
      if (!isRecord(profile)) continue
      const kind = profile.kind
      if (kind !== 'preset' && kind !== 'clone' && kind !== 'design') continue
      const input: VoiceImportProfile = {
        name: typeof profile.name === 'string' ? profile.name : '',
        kind,
        description: optionalStringValue(profile.description),
        tags: Array.isArray(profile.tags)
          ? profile.tags.filter((tag): tag is string => typeof tag === 'string')
          : undefined,
        presetVoiceId: optionalStringValue(profile.presetVoiceId),
        styleInstruction: optionalStringValue(profile.styleInstruction),
        designDescription: optionalStringValue(profile.designDescription),
      }
      if (kind === 'clone') {
        const sampleFile = typeof profile.sampleFile === 'string' ? profile.sampleFile : ''
        const sample = samples.get(sampleFile)
        if (sample === undefined) {
          throw new TtsError(
            'validation',
            `backup is missing the sample for clone profile "${input.name}"`,
          )
        }
        profilesInput.push({ ...input, sample })
      } else {
        profilesInput.push(input)
      }
      if (typeof document.activeProfileId === 'string' && profile.id === document.activeProfileId) {
        activeProfileIndex = profilesInput.length - 1
      }
    }

    // Safety net: snapshot the current state before touching it.
    const safetyBackup = await this.exportBackup()
    const result = await this.voices.importData({
      mode,
      profiles: profilesInput,
      candidates,
      activeProfileIndex,
    })
    this.logger.info(
      '[whale-tts] backup imported; mode=%s profiles=%d candidates=%d safety=%s',
      mode,
      result.importedProfiles,
      result.importedCandidates,
      safetyBackup.file,
    )
    return {
      mode,
      importedProfiles: result.importedProfiles,
      importedCandidates: result.importedCandidates,
      activeProfileId: result.activeProfileId,
      safetyBackup,
      warnings:
        document.config === undefined
          ? []
          : ['backup config is for reference only; the current plugin configuration was not changed'],
    }
  }

  /** Keep only the newest {@link MAX_BACKUPS} backup documents. */
  private async pruneBackups(): Promise<void> {
    const directory = this.backupDirectory()
    const entries = await readdir(directory).catch(() => [] as string[])
    const candidates = entries.filter((entry) => entry.toLowerCase().endsWith('.json'))
    if (candidates.length <= MAX_BACKUPS) return
    const withTime: { file: string; mtime: number }[] = []
    for (const file of candidates) {
      try {
        const info = await stat(joinInside(directory, file))
        withTime.push({ file, mtime: info.mtimeMs })
      } catch {
        // ignore
      }
    }
    withTime.sort((a, b) => b.mtime - a.mtime)
    for (const stale of withTime.slice(MAX_BACKUPS)) {
      await rm(joinInside(directory, stale.file), { force: true }).catch(() => undefined)
    }
  }

  /** Source of the last resolved key, for diagnostics. */
  static keySourceLabel(source: KeySource | undefined): string {
    if (source === 'environment') return 'environment'
    if (source === 'credentials') return 'credentials'
    return 'missing'
  }
}
