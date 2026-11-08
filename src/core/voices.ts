/**
 * Voice profile library (M4).
 *
 * Storage layout (fixed, see design §7.2):
 *
 * ```
 * <dir>/voices.json          { version: 1, activeProfileId, profiles }
 * <dir>/voices/<file>        clone samples (wav / mp3)
 * <dir>/design/<file>        design candidates (temporary, wav / mp3)
 * ```
 *
 * Invariants:
 * - exactly one activation pointer (`activeProfileId`), `null` = "provider default";
 * - every state write re-reads the file inside one process-wide mutex, then writes
 *   atomically (`<file>.tmp-<rand>` + rename), so concurrent callers never lose an
 *   update and a crash never leaves half a `voices.json`;
 * - file-name inputs are basenames only (directory-traversal guard);
 * - logs carry profile ids and counts, never sample data, text or secrets.
 *
 * The store never reads the environment: the caller passes `dir` (tests pass a
 * temporary directory).
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import {
  TtsError,
  type AudioFormat,
  type DesignCandidate,
  type KeyType,
  type LoggerLike,
  type ResolvedVoice,
  type VoiceProfile,
  type VoiceProfileKind,
  type VoiceProfileProviderSettings,
  type VoiceState,
} from '../types.js'
import {
  detectAudioFormat,
  joinInside,
  pathExists,
  readFileBytes,
  timestampToken,
  writeAudioFile,
} from './audio.js'
import { slugify } from './text.js'

/** File holding the profile metadata. */
const STATE_FILE = 'voices.json'
/** Directory holding clone samples. */
const VOICES_DIRECTORY = 'voices'
/** Directory holding temporary design candidates. */
const DESIGN_DIRECTORY = 'design'
/** Persisted schema version. */
const STATE_VERSION = 1
/** Default profile cap (overridable through {@link VoiceStoreOptions.maxProfiles}). */
const DEFAULT_MAX_PROFILES = 50
/** Default per-sample cap (overridable through {@link VoiceStoreOptions.maxSampleBytes}). */
const DEFAULT_MAX_SAMPLE_BYTES = 10 * 1024 * 1024
/** Canonical MIME type per container. */
const AUDIO_MIME: Readonly<Record<AudioFormat, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
}
/** Generated (and accepted) profile ids: safe in settings, URLs and logs. */
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Construction options. `dir` is `<store.dir>` (e.g. `$DSH_HOME/whale-tts`). */
export interface VoiceStoreOptions {
  dir: string
  /** Maximum number of stored profiles; defaults to 50. */
  maxProfiles?: number
  /** Maximum size of one sample or candidate in bytes; defaults to 10 MiB. */
  maxSampleBytes?: number
  logger?: LoggerLike
}

/** Create or update one profile. Omit `id` to create; pass an existing id to update. */
export interface VoiceProfileInput {
  id?: string
  name: string
  kind: VoiceProfileKind
  /** Provider this profile belongs to; omitted for old/unbound profiles. */
  provider?: string
  /** Non-secret provider settings captured at save time. */
  providerSettings?: VoiceProfileProviderSettings
  description?: string
  tags?: string[]
  /** `preset`: provider voice id. */
  presetVoiceId?: string
  /** `clone`: sample file name relative to `voices/`. */
  sampleFile?: string
  sampleBytes?: number
  sampleMime?: string
  /** `design`: the description the candidates were generated from. */
  designDescription?: string
  /** `design`: candidate ids kept as history. */
  designCandidates?: string[]
  /** Default style instruction applied whenever this profile is active. */
  styleInstruction?: string
}

/**
 * Inputs for {@link VoiceStore.resolveVoice}.
 *
 * `activeProfileId` is the activation pointer supplied by the caller (the
 * service passes the config value). A non-empty value wins; when it is empty the
 * store's own `voices.json` pointer is used, so an activation done through the
 * store still takes effect. An empty string means "nothing active".
 */
export interface VoiceResolutionInput {
  activeProfileId: string
  presetVoiceId: string
  customVoiceId: string
  /** Model id used for preset/custom voices. */
  presetModel?: string
  /** Model id used for clone samples. */
  cloneModel?: string
}

/** Mutable view of a profile used while building one. */
type MutableVoiceProfile = { -readonly [K in keyof VoiceProfile]: VoiceProfile[K] }

/* ---- backup / restore types ------------------------------------------ */

/** One sample file carried inside an export bundle (base64 to stay JSON-safe). */
export interface VoiceSampleBlob {
  /** File name relative to `<store>/voices/`. */
  readonly file: string
  readonly mime: string
  readonly base64: string
}

/** One design candidate carried inside an export bundle. */
export interface VoiceCandidateBlob {
  /** File name relative to `<store>/design/`. */
  readonly file: string
  readonly format: AudioFormat
  readonly base64: string
}

/** Whole-store export payload. */
export interface VoiceExportData {
  readonly profiles: readonly VoiceProfile[]
  readonly samples: readonly VoiceSampleBlob[]
  readonly candidates: readonly VoiceCandidateBlob[]
  readonly activeProfileId: string | null
}

/** One profile to import (its sample bytes already decoded). */
export interface VoiceImportProfile {
  readonly name: string
  readonly kind: VoiceProfileKind
  readonly provider?: string
  readonly providerSettings?: VoiceProfileProviderSettings
  readonly description?: string
  readonly tags?: readonly string[]
  readonly presetVoiceId?: string
  readonly styleInstruction?: string
  readonly designDescription?: string
  /** Required for `clone` profiles. */
  readonly sample?: { readonly data: Uint8Array; readonly mime: string }
}

/** Import request assembled by the service from a backup document. */
export interface VoiceImportRequest {
  readonly mode: 'merge' | 'replace'
  readonly profiles: readonly VoiceImportProfile[]
  readonly candidates: readonly { readonly data: Uint8Array; readonly format: AudioFormat }[]
  /** Index into `profiles` to activate; `null`/omitted keeps the current pointer. */
  readonly activeProfileIndex?: number | null
}

/** Result of one import. */
export interface VoiceImportResult {
  readonly importedProfiles: number
  readonly importedCandidates: number
  readonly activeProfileId: string | null
}

/** Fields accepted by {@link createProfile}; kind-irrelevant fields are dropped. */
interface ProfileFields {
  readonly id: string
  readonly name: string
  readonly kind: VoiceProfileKind
  readonly createdAt: string
  readonly updatedAt: string
  readonly provider?: string
  readonly providerSettings?: VoiceProfileProviderSettings
  readonly description?: string
  readonly tags?: readonly string[]
  readonly presetVoiceId?: string
  readonly sampleFile?: string
  readonly sampleBytes?: number
  readonly sampleMime?: string
  readonly designDescription?: string
  readonly designCandidates?: readonly string[]
  readonly styleInstruction?: string
}

/** Result of loading (and possibly repairing) the state file. */
interface LoadedState {
  readonly state: VoiceState
  readonly repaired: boolean
  readonly missing: boolean
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** True for plain JSON objects (not arrays, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trim a string, or `undefined` when it is not a non-empty string. */
function trimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  return result === '' ? undefined : result
}

/** Recursively freeze a JSON-shaped value. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/** Fresh empty state (frozen). */
function emptyState(): VoiceState {
  return deepFreeze({ version: STATE_VERSION, activeProfileId: null, profiles: [] })
}

/** Random, URL-safe profile id. */
function newProfileId(): string {
  return `vp_${randomBytes(8).toString('hex')}`
}

/** A file name that cannot escape its directory. */
function isSafeFileName(name: string): boolean {
  return (
    name !== '' &&
    name === basename(name) &&
    !name.includes('..') &&
    !/[\\/]/.test(name)
  )
}

/** Normalise an ISO-8601-ish timestamp; invalid values fall back. */
function isoOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const time = Date.parse(value)
  return Number.isNaN(time) ? fallback : new Date(time).toISOString()
}

/** Audio format implied by a file extension, or `undefined`. */
function extensionFormat(fileName: string): AudioFormat | undefined {
  const extension = extname(fileName).toLowerCase()
  if (extension === '.wav') return 'wav'
  if (extension === '.mp3') return 'mp3'
  return undefined
}

/** Audio format implied by a file extension; throws for anything else. */
function audioFormatOf(fileName: string): AudioFormat {
  const format = extensionFormat(fileName)
  if (format === undefined) {
    throw new TtsError('validation', `unsupported audio file type: "${fileName}"`)
  }
  return format
}

/** Canonical MIME type: trust an `audio/*` hint, otherwise derive from the format. */
function normalizeMime(mime: unknown, format: AudioFormat): string {
  const candidate = typeof mime === 'string' ? mime.trim().toLowerCase() : ''
  return candidate.startsWith('audio/') ? candidate : AUDIO_MIME[format]
}

/** Positive integer option with a default. */
function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new TtsError('config', `${field} must be a positive number`)
  }
  return Math.floor(value)
}

/* -------------------------------------------------------------------------- */
/* Loud input validation (writes)                                             */
/* -------------------------------------------------------------------------- */

/** Require a non-empty trimmed string. */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TtsError('validation', `${field} must be a string`)
  }
  const result = value.trim()
  if (result === '') {
    throw new TtsError('validation', `${field} must not be empty`)
  }
  return result
}

/** Optional trimmed string; empty values become `undefined`. */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new TtsError('validation', `${field} must be a string`)
  }
  const result = value.trim()
  return result === '' ? undefined : result
}

/** Require a known profile kind. */
function requireKind(value: unknown): VoiceProfileKind {
  if (value === 'preset' || value === 'clone' || value === 'design') return value
  throw new TtsError('validation', `unknown voice profile kind: ${String(value)}`)
}

/** Optional tag list: trimmed, de-duplicated, empties removed. */
function optionalTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new TtsError('validation', 'voice profile tags must be an array of strings')
  }
  const tags: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new TtsError('validation', 'voice profile tags must be an array of strings')
    }
    const tag = entry.trim()
    if (tag !== '' && !tags.includes(tag)) tags.push(tag)
  }
  return tags.length === 0 ? undefined : tags
}

/** Optional basename-only file name (directory-traversal guard). */
function optionalFileName(value: unknown, field: string): string | undefined {
  const name = optionalText(value, field)
  if (name === undefined) return undefined
  if (!isSafeFileName(name)) {
    throw new TtsError('validation', `invalid ${field}: "${name}"`)
  }
  return name
}

/** Optional non-negative byte count. */
function optionalBytes(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TtsError('validation', `${field} must be a non-negative number`)
  }
  return Math.floor(value)
}

/** Optional MIME type (must look like `type/subtype`). */
function optionalMime(value: unknown): string | undefined {
  const mime = optionalText(value, 'voice sample mime type')
  if (mime === undefined) return undefined
  if (!mime.includes('/')) {
    throw new TtsError('validation', `voice sample mime type is invalid: "${mime}"`)
  }
  return mime.toLowerCase()
}

/** Optional candidate id list: basenames only, de-duplicated. */
function optionalCandidateIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new TtsError('validation', 'voice profile design candidates must be an array of file names')
  }
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new TtsError('validation', 'voice profile design candidates must be an array of file names')
    }
    const id = entry.trim()
    if (id === '') continue
    if (!isSafeFileName(id)) {
      throw new TtsError('validation', `invalid design candidate name: "${id}"`)
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.length === 0 ? undefined : ids
}

/** Require a plausible audio payload within the size cap. */
function requireAudioBytes(data: unknown, maxBytes: number, label: string): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw new TtsError('validation', `${label} data must be a Uint8Array`)
  }
  if (data.length === 0) {
    throw new TtsError('validation', `${label} is empty`)
  }
  if (data.length > maxBytes) {
    throw new TtsError('validation', `${label} is too large: ${data.length} bytes, limit is ${maxBytes}`, {
      detail: { bytes: data.length, maxBytes },
    })
  }
  return data
}

/* -------------------------------------------------------------------------- */
/* Profile construction and state normalisation                               */
/* -------------------------------------------------------------------------- */

/** Build a profile carrying only the fields relevant to its kind. */
function createProfile(fields: ProfileFields): VoiceProfile {
  const profile: MutableVoiceProfile = {
    id: fields.id,
    name: fields.name,
    kind: fields.kind,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
  }
  if (fields.description !== undefined) profile.description = fields.description
  if (fields.provider !== undefined) profile.provider = fields.provider
  if (fields.providerSettings !== undefined) {
    profile.providerSettings = { ...fields.providerSettings }
  }
  if (fields.tags !== undefined) profile.tags = [...fields.tags]
  if (fields.styleInstruction !== undefined) {
    profile.styleInstruction = fields.styleInstruction
  }
  switch (fields.kind) {
    case 'preset':
      if (fields.presetVoiceId !== undefined) profile.presetVoiceId = fields.presetVoiceId
      break
    case 'clone':
      if (fields.sampleFile !== undefined) profile.sampleFile = fields.sampleFile
      if (fields.sampleBytes !== undefined) profile.sampleBytes = fields.sampleBytes
      if (fields.sampleMime !== undefined) profile.sampleMime = fields.sampleMime
      break
    case 'design':
      if (fields.designDescription !== undefined) {
        profile.designDescription = fields.designDescription
      }
      if (fields.designCandidates !== undefined) {
        profile.designCandidates = [...fields.designCandidates]
      }
      break
  }
  return profile
}

/** Permissively read a tag list out of a hand-edited state file. */
function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags: string[] = []
  for (const entry of value) {
    const tag = trimmed(entry)
    if (tag !== undefined && !tags.includes(tag)) tags.push(tag)
  }
  return tags.length === 0 ? undefined : tags
}

/** Permissively read candidate ids out of a hand-edited state file. */
function normalizeCandidateIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  for (const entry of value) {
    const id = trimmed(entry)
    if (id === undefined || !isSafeFileName(id)) continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.length === 0 ? undefined : ids
}

const KEY_TYPE_VALUES: ReadonlySet<string> = new Set<KeyType | 'auto'>([
  'auto',
  'pay-as-you-go',
  'token-plan',
  'token-plan-team',
  'custom',
  'unknown',
])

/** Read the non-secret provider settings stored on a profile. */
function normalizeProviderSettings(value: unknown): VoiceProfileProviderSettings | undefined {
  if (!isRecord(value)) return undefined
  const apiKeyEnv = trimmed(value.apiKeyEnv)
  const baseURLOverride = trimmed(value.baseURLOverride)
  const keyType =
    typeof value.keyType === 'string' && KEY_TYPE_VALUES.has(value.keyType)
      ? (value.keyType as KeyType | 'auto')
      : undefined
  if (apiKeyEnv === undefined && baseURLOverride === undefined && keyType === undefined) {
    return undefined
  }
  return {
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(baseURLOverride === undefined ? {} : { baseURLOverride }),
    ...(keyType === undefined ? {} : { keyType }),
  }
}

/**
 * Validate one profile loaded from disk.
 *
 * Structurally invalid entries are dropped (the caller records a repair);
 * out-of-range optional fields are discarded instead of failing the load so a
 * single bad record cannot make the whole library unreadable.
 */
function normalizeProfile(entry: unknown): VoiceProfile | undefined {
  if (!isRecord(entry)) return undefined
  const id = trimmed(entry.id)
  if (id === undefined || !PROFILE_ID_PATTERN.test(id)) return undefined
  const name = trimmed(entry.name)
  if (name === undefined) return undefined
  const kind = entry.kind
  if (kind !== 'preset' && kind !== 'clone' && kind !== 'design') return undefined
  const fallback = new Date().toISOString()
  const createdAt = isoOr(entry.createdAt, fallback)
  const updatedAt = isoOr(entry.updatedAt, createdAt)
  const sampleFile = trimmed(entry.sampleFile)
  return createProfile({
    id,
    name,
    kind,
    createdAt,
    updatedAt,
    provider: trimmed(entry.provider),
    providerSettings: normalizeProviderSettings(entry.providerSettings),
    description: trimmed(entry.description),
    tags: normalizeTags(entry.tags),
    presetVoiceId: trimmed(entry.presetVoiceId),
    sampleFile:
      sampleFile !== undefined && isSafeFileName(sampleFile) ? sampleFile : undefined,
    sampleBytes:
      typeof entry.sampleBytes === 'number' &&
      Number.isFinite(entry.sampleBytes) &&
      entry.sampleBytes >= 0
        ? Math.floor(entry.sampleBytes)
        : undefined,
    sampleMime: trimmed(entry.sampleMime),
    designDescription: trimmed(entry.designDescription),
    designCandidates: normalizeCandidateIds(entry.designCandidates),
    styleInstruction: trimmed(entry.styleInstruction),
  })
}

/**
 * Validate and repair a parsed `voices.json` payload.
 *
 * Throws `TtsError('config')` only when the document cannot be understood at all
 * (not an object, unsupported version); everything repairable is repaired and
 * reported through `repaired` so `init()` can persist the cleaned state.
 */
function normalizeState(
  raw: unknown,
  file: string,
  logger?: LoggerLike,
): { state: VoiceState; repaired: boolean } {
  if (!isRecord(raw)) {
    throw new TtsError('config', `voice profile state must be a JSON object: ${file}`)
  }
  if (raw.version !== undefined && raw.version !== STATE_VERSION) {
    throw new TtsError(
      'config',
      `unsupported voice profile state version ${String(raw.version)}: ${file}`,
    )
  }
  let repaired = raw.version === undefined

  const profiles: VoiceProfile[] = []
  const seen = new Set<string>()
  if (!Array.isArray(raw.profiles)) {
    repaired = true
  } else {
    for (const entry of raw.profiles) {
      const profile = normalizeProfile(entry)
      if (profile === undefined) {
        repaired = true
        continue
      }
      if (seen.has(profile.id)) {
        repaired = true
        continue
      }
      seen.add(profile.id)
      profiles.push(profile)
    }
  }

  let activeProfileId: string | null = null
  const rawActive = raw.activeProfileId
  if (rawActive === undefined || rawActive === null) {
    repaired = rawActive === undefined
  } else if (typeof rawActive === 'string') {
    const active = rawActive.trim()
    if (active === '') {
      repaired = rawActive !== ''
    } else if (seen.has(active)) {
      activeProfileId = active
    } else {
      repaired = true
      logger?.warn('[whale-tts] active voice profile %s no longer exists; clearing', active)
    }
  } else {
    repaired = true
  }

  return {
    state: deepFreeze({ version: STATE_VERSION, activeProfileId, profiles }),
    repaired,
  }
}

/** Build the resolved-voice result without `undefined` keys. */
function finalizeResolved(value: {
  model?: string
  voice?: string
  sample?: { readonly data: Uint8Array; readonly mime: string }
  profileId?: string
  profileName?: string
  style?: string
}): ResolvedVoice {
  const resolved: {
    model?: string
    voice?: string
    sample?: { readonly data: Uint8Array; readonly mime: string }
    profileId?: string
    profileName?: string
    style?: string
  } = {}
  if (value.model !== undefined) resolved.model = value.model
  if (value.voice !== undefined) resolved.voice = value.voice
  if (value.sample !== undefined) resolved.sample = value.sample
  if (value.profileId !== undefined) resolved.profileId = value.profileId
  if (value.profileName !== undefined) resolved.profileName = value.profileName
  if (value.style !== undefined) resolved.style = value.style
  return resolved
}

/* -------------------------------------------------------------------------- */
/* VoiceStore                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Persistent voice-profile library.
 *
 * Reads always come from disk (so another process or another instance cannot be
 * overwritten by a stale in-memory copy); writes run inside one mutex and end
 * with an atomic `voices.json` replace.
 */
export class VoiceStore {
  /** Absolute store directory (`<store.dir>`). */
  readonly dir: string

  private readonly maxProfiles: number
  private readonly maxSampleBytes: number
  private readonly logger: LoggerLike | undefined
  private initialized = false
  private pending: Promise<void> | undefined
  /** Tail of the process-wide write chain. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: VoiceStoreOptions) {
    const dir = trimmed(options?.dir)
    if (dir === undefined) {
      throw new TtsError('config', 'voice store directory must not be empty')
    }
    this.dir = resolve(dir)
    this.maxProfiles = positiveInteger(options.maxProfiles, DEFAULT_MAX_PROFILES, 'maxProfiles')
    this.maxSampleBytes = positiveInteger(
      options.maxSampleBytes,
      DEFAULT_MAX_SAMPLE_BYTES,
      'maxSampleBytes',
    )
    this.logger = options.logger
  }

  /* ---- paths ---------------------------------------------------------- */

  private get stateFile(): string {
    return join(this.dir, STATE_FILE)
  }

  private get voicesDir(): string {
    return join(this.dir, VOICES_DIRECTORY)
  }

  private get designDir(): string {
    return join(this.dir, DESIGN_DIRECTORY)
  }

  /* ---- lifecycle ------------------------------------------------------ */

  /**
   * Create the storage directories and load (repairing when needed)
   * `voices.json`. A missing file is replaced with the empty state; a corrupt
   * JSON document raises `TtsError('config')` naming the file.
   */
  async init(): Promise<void> {
    if (this.initialized) return
    if (this.pending !== undefined) {
      await this.pending
      return
    }
    const pending = this.loadAndRepair().then(
      () => {
        this.initialized = true
        this.pending = undefined
      },
      (error: unknown) => {
        this.pending = undefined
        throw error
      },
    )
    this.pending = pending
    await pending
  }

  private async loadAndRepair(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await mkdir(this.voicesDir, { recursive: true })
    await mkdir(this.designDir, { recursive: true })
    const loaded = await this.readState()
    if (loaded.missing) {
      await this.writeState(loaded.state)
      this.logger?.info('[whale-tts] initialised voice profile store at %s', this.stateFile)
      return
    }
    if (loaded.repaired) {
      await this.writeState(loaded.state)
      this.logger?.warn('[whale-tts] repaired voice profile state at %s', this.stateFile)
    }
  }

  /* ---- state I/O ------------------------------------------------------ */

  private async readState(): Promise<LoadedState> {
    let raw: string
    try {
      raw = await readFile(this.stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: emptyState(), repaired: false, missing: true }
      }
      throw new TtsError('config', `cannot read voice profile state: ${this.stateFile}`, {
        cause: error,
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.logger?.error('[whale-tts] voice profile state is not valid JSON: %s', this.stateFile)
      throw new TtsError('config', `voice profile state is not valid JSON: ${this.stateFile}`, {
        cause: error,
      })
    }
    const normalized = normalizeState(parsed, this.stateFile, this.logger)
    return { ...normalized, missing: false }
  }

  /** Atomic replace of `voices.json` (temp sibling + rename). */
  private async writeState(state: VoiceState): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const payload = `${JSON.stringify(
      {
        version: STATE_VERSION,
        activeProfileId: state.activeProfileId,
        profiles: state.profiles,
      },
      null,
      2,
    )}\n`
    const target = this.stateFile
    const temporary = `${target}.tmp-${randomBytes(4).toString('hex')}`
    try {
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new TtsError('config', `cannot write voice profile state: ${target}`, {
        cause: error,
      })
    }
  }

  /** Latest state from disk (initialising first when needed). */
  private async loadState(): Promise<VoiceState> {
    await this.init()
    return (await this.readState()).state
  }

  /* ---- write serialisation -------------------------------------------- */

  /** Run `work` after every previously queued write has settled. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: () => void = () => undefined
    this.tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    await previous.catch(() => undefined)
    try {
      return await work()
    } finally {
      release()
    }
  }

  /* ---- read API ------------------------------------------------------- */

  /** Frozen snapshot of the whole state. */
  async state(): Promise<VoiceState> {
    await this.init()
    return (await this.readState()).state
  }

  /** Every stored profile, in insertion order. */
  async list(): Promise<readonly VoiceProfile[]> {
    return (await this.state()).profiles
  }

  /** One profile by id. */
  async get(id: string): Promise<VoiceProfile | undefined> {
    const state = await this.state()
    return state.profiles.find((profile) => profile.id === id)
  }

  /** The activated profile, or `undefined` when the pointer is `null`/dangling. */
  async active(): Promise<VoiceProfile | undefined> {
    const state = await this.state()
    if (state.activeProfileId === null) return undefined
    return state.profiles.find((profile) => profile.id === state.activeProfileId)
  }

  /* ---- activation ----------------------------------------------------- */

  /**
   * Move the single activation pointer. `null` clears it (provider default).
   *
   * @throws TtsError('validation') when `id` names no stored profile.
   */
  async activate(id: string | null): Promise<VoiceState> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      let activeProfileId: string | null = null
      if (id !== null) {
        if (typeof id !== 'string') {
          throw new TtsError('validation', 'voice profile id must be a string or null')
        }
        const profile = state.profiles.find((entry) => entry.id === id)
        if (profile === undefined) {
          throw new TtsError('validation', `voice profile not found: ${id}`)
        }
        activeProfileId = profile.id
      }
      const next: VoiceState = {
        version: STATE_VERSION,
        activeProfileId,
        profiles: state.profiles,
      }
      await this.writeState(next)
      this.logger?.info('[whale-tts] active voice profile set to %s', activeProfileId ?? '(none)')
      return deepFreeze(next)
    })
  }

  /* ---- profiles ------------------------------------------------------- */

  /**
   * Create a profile (no `id`) or update one (existing `id`).
   *
   * `createdAt` is preserved on update; `updatedAt` always moves to now. The
   * profile cap is enforced on creation only. Names may repeat — ids are unique.
   */
  async save(input: VoiceProfileInput): Promise<VoiceProfile> {
    return this.exclusive(async () => {
      if (!isRecord(input)) {
        throw new TtsError('validation', 'voice profile input must be an object')
      }
      const state = await this.loadState()
      const name = requireText(input.name, 'voice profile name')
      const kind = requireKind(input.kind)
      const requestedId = this.requestedProfileId(input.id)
      const existing =
        requestedId === undefined
          ? undefined
          : state.profiles.find((entry) => entry.id === requestedId)
      if (requestedId !== undefined && existing === undefined) {
        throw new TtsError('validation', `voice profile not found: ${requestedId}`)
      }
      if (existing === undefined && state.profiles.length >= this.maxProfiles) {
        throw new TtsError(
          'validation',
          `too many voice profiles: ${state.profiles.length} of ${this.maxProfiles} allowed; delete one first`,
          { detail: { count: state.profiles.length, maxProfiles: this.maxProfiles } },
        )
      }
      const now = new Date().toISOString()
      const profile = createProfile({
        id: existing?.id ?? newProfileId(),
        name,
        kind,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        provider:
          optionalText(input.provider, 'voice profile provider') ?? existing?.provider,
        providerSettings:
          normalizeProviderSettings(input.providerSettings) ?? existing?.providerSettings,
        description: optionalText(input.description, 'voice profile description'),
        tags: optionalTags(input.tags),
        presetVoiceId: optionalText(input.presetVoiceId, 'voice profile preset voice id'),
        sampleFile: optionalFileName(input.sampleFile, 'voice sample file'),
        sampleBytes: optionalBytes(input.sampleBytes, 'voice sample size'),
        sampleMime: optionalMime(input.sampleMime),
        designDescription: optionalText(input.designDescription, 'voice design description'),
        designCandidates: optionalCandidateIds(input.designCandidates),
        styleInstruction: optionalText(input.styleInstruction, 'voice style instruction'),
      })
      const profiles =
        existing === undefined
          ? [...state.profiles, profile]
          : state.profiles.map((entry) => (entry.id === profile.id ? profile : entry))
      await this.writeState({
        version: STATE_VERSION,
        activeProfileId: state.activeProfileId,
        profiles,
      })
      // A profile owns its sample: an update that drops or replaces it leaves the
      // old file unreachable, so remove it once the new state is on disk.
      if (
        existing !== undefined &&
        existing.sampleFile !== undefined &&
        existing.sampleFile !== profile.sampleFile
      ) {
        const stillReferenced = profiles.some(
          (entry) => entry.id !== profile.id && entry.sampleFile === existing.sampleFile,
        )
        if (!stillReferenced) {
          const stale = joinInside(this.voicesDir, existing.sampleFile)
          await rm(stale, { force: true }).catch(() => undefined)
        }
      }
      this.logger?.info(
        '[whale-tts] voice profile %s; id=%s kind=%s',
        existing === undefined ? 'created' : 'updated',
        profile.id,
        profile.kind,
      )
      return deepFreeze(profile)
    })
  }

  /**
   * Delete a profile and the sample file it owns.
   *
   * When the removed profile was active the pointer falls back to `null`.
   *
   * @returns `removedSamples` — relative names of sample files actually deleted.
   */
  async remove(
    id: string,
  ): Promise<{ ok: true; activeProfileId: string | null; removedSamples: string[] }> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const removed = state.profiles.find((entry) => entry.id === id)
      if (removed === undefined) {
        throw new TtsError('validation', `voice profile not found: ${id}`)
      }
      const profiles = state.profiles.filter((entry) => entry.id !== id)
      const activeProfileId = state.activeProfileId === id ? null : state.activeProfileId
      const removedSamples: string[] = []
      if (removed.sampleFile !== undefined) {
        const target = joinInside(this.voicesDir, removed.sampleFile)
        if (await pathExists(target)) {
          await rm(target, { force: true })
          removedSamples.push(removed.sampleFile)
        }
      }
      await this.writeState({ version: STATE_VERSION, activeProfileId, profiles })
      this.logger?.info(
        '[whale-tts] voice profile removed; id=%s samples=%d',
        id,
        removedSamples.length,
      )
      return { ok: true, activeProfileId, removedSamples }
    })
  }

  /**
   * Derive a copy of a profile (fresh id, own sample file, `name` defaulting to
   * `"<source name> 副本"`). The copy is not activated.
   */
  async duplicate(id: string, name?: string): Promise<VoiceProfile> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const source = state.profiles.find((entry) => entry.id === id)
      if (source === undefined) {
        throw new TtsError('validation', `voice profile not found: ${id}`)
      }
      if (state.profiles.length >= this.maxProfiles) {
        throw new TtsError(
          'validation',
          `too many voice profiles: ${state.profiles.length} of ${this.maxProfiles} allowed; delete one first`,
          { detail: { count: state.profiles.length, maxProfiles: this.maxProfiles } },
        )
      }
      const copyName =
        name === undefined || name === null
          ? `${source.name} 副本`
          : requireText(name, 'voice profile name')
      let sampleFile: string | undefined
      let sampleBytes: number | undefined
      let sampleMime: string | undefined
      if (source.kind === 'clone' && source.sampleFile !== undefined) {
        const format = audioFormatOf(source.sampleFile)
        const sample = await this.readSampleFile(source.sampleFile)
        sampleFile = await this.writeSampleFile(sample.data, format, slugify(copyName))
        sampleBytes = sample.data.length
        sampleMime = sample.mime
      }
      const now = new Date().toISOString()
      const profile = createProfile({
        id: newProfileId(),
        name: copyName,
        kind: source.kind,
        createdAt: now,
        updatedAt: now,
        provider: source.provider,
        providerSettings: source.providerSettings,
        description: source.description,
        tags: source.tags,
        presetVoiceId: source.presetVoiceId,
        sampleFile,
        sampleBytes,
        sampleMime,
        designDescription: source.designDescription,
        designCandidates: source.designCandidates,
        styleInstruction: source.styleInstruction,
      })
      await this.writeState({
        version: STATE_VERSION,
        activeProfileId: state.activeProfileId,
        profiles: [...state.profiles, profile],
      })
      this.logger?.info(
        '[whale-tts] voice profile duplicated; source=%s copy=%s',
        source.id,
        profile.id,
      )
      return deepFreeze(profile)
    })
  }

  /* ---- samples -------------------------------------------------------- */

  /**
   * Store a clone sample under `voices/<slug>-<rand>.<ext>`.
   *
   * The payload must match `extension` by magic bytes and stay within
   * `maxSampleBytes`.
   */
  async saveSample(
    data: Uint8Array,
    mime: string,
    extension: 'wav' | 'mp3',
  ): Promise<{ sampleFile: string; sampleBytes: number; sampleMime: string }> {
    if (extension !== 'wav' && extension !== 'mp3') {
      throw new TtsError('validation', `unsupported voice sample format: ${String(extension)}`)
    }
    const bytes = requireAudioBytes(data, this.maxSampleBytes, 'voice sample')
    const detected = detectAudioFormat(bytes)
    if (detected === undefined) {
      throw new TtsError('validation', 'voice sample is neither wav nor mp3 audio')
    }
    if (detected !== extension) {
      throw new TtsError(
        'validation',
        `voice sample is ${detected} audio but ${extension} was requested`,
      )
    }
    const sampleMime = normalizeMime(mime, detected)
    return this.exclusive(async () => {
      const sampleFile = await this.writeSampleFile(bytes, extension, 'sample')
      this.logger?.info(
        '[whale-tts] voice sample saved; file=%s bytes=%d',
        sampleFile,
        bytes.length,
      )
      return { sampleFile, sampleBytes: bytes.length, sampleMime }
    })
  }

  /**
   * Read a sample by its relative file name (basename only).
   *
   * @throws TtsError('validation') for unsafe names or missing files.
   */
  async readSample(sampleFile: string): Promise<{ data: Uint8Array; mime: string }> {
    if (typeof sampleFile !== 'string' || !isSafeFileName(sampleFile)) {
      throw new TtsError('validation', `invalid voice sample file name: "${String(sampleFile)}"`)
    }
    await this.init()
    return this.readSampleFile(sampleFile)
  }

  private async readSampleFile(sampleFile: string): Promise<{ data: Uint8Array; mime: string }> {
    const format = audioFormatOf(sampleFile)
    const target = joinInside(this.voicesDir, sampleFile)
    try {
      const data = await readFileBytes(target)
      return { data, mime: AUDIO_MIME[format] }
    } catch (error) {
      if (error instanceof TtsError) throw error
      throw new TtsError('validation', `voice sample not found: ${sampleFile}`, { cause: error })
    }
  }

  /** Write one sample file and return its relative name. */
  private async writeSampleFile(
    data: Uint8Array,
    format: AudioFormat,
    slug: string,
  ): Promise<string> {
    const fileName = `${slug}-${randomBytes(4).toString('hex')}.${format}`
    await writeAudioFile(this.voicesDir, fileName, data, false)
    return fileName
  }

  /* ---- design candidates ---------------------------------------------- */

  /** Store one temporary design candidate under `design/<timestamp>-<rand>.<ext>`. */
  async saveCandidate(data: Uint8Array, format: AudioFormat): Promise<DesignCandidate> {
    if (format !== 'wav' && format !== 'mp3') {
      throw new TtsError('validation', `unsupported design candidate format: ${String(format)}`)
    }
    const bytes = requireAudioBytes(data, this.maxSampleBytes, 'design candidate')
    const detected = detectAudioFormat(bytes)
    if (detected === undefined) {
      throw new TtsError('validation', 'design candidate is neither wav nor mp3 audio')
    }
    if (detected !== format) {
      throw new TtsError(
        'validation',
        `design candidate is ${detected} audio but ${format} was requested`,
      )
    }
    return this.exclusive(async () => {
      const now = new Date()
      const id = `${timestampToken(now)}-${randomBytes(3).toString('hex')}.${format}`
      await writeAudioFile(this.designDir, id, bytes, false)
      const candidate: DesignCandidate = {
        id,
        file: id,
        bytes: bytes.length,
        format,
        createdAt: now.toISOString(),
      }
      this.logger?.info(
        '[whale-tts] design candidate saved; file=%s bytes=%d',
        id,
        bytes.length,
      )
      return deepFreeze(candidate)
    })
  }

  /** Candidates that still exist on disk, newest first. */
  async listCandidates(): Promise<readonly DesignCandidate[]> {
    await this.init()
    let entries: string[]
    try {
      entries = await readdir(this.designDir)
    } catch {
      return []
    }
    const candidates: DesignCandidate[] = []
    for (const entry of entries) {
      const format = extensionFormat(entry)
      if (format === undefined) continue
      try {
        const info = await stat(join(this.designDir, entry))
        if (!info.isFile()) continue
        candidates.push({
          id: entry,
          file: entry,
          bytes: info.size,
          format,
          createdAt: info.mtime.toISOString(),
        })
      } catch {
        // Vanished between readdir and stat: not a candidate any more.
      }
    }
    candidates.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )
    return deepFreeze(candidates)
  }

  /**
   * Promote a design candidate into a `clone` profile: the file moves from
   * `design/` to `voices/`, a profile is created and the new profile becomes
   * active.
   *
   * @throws TtsError('validation') when the candidate is gone or the name is bad.
   */
  async adoptCandidate(
    candidateId: string,
    name: string,
    description?: string,
    binding?: {
      readonly provider?: string
      readonly providerSettings?: VoiceProfileProviderSettings
    },
  ): Promise<VoiceProfile> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      if (typeof candidateId !== 'string' || !isSafeFileName(candidateId)) {
        throw new TtsError('validation', `invalid design candidate id: "${String(candidateId)}"`)
      }
      const format = audioFormatOf(candidateId)
      const source = joinInside(this.designDir, candidateId)
      let info
      try {
        info = await stat(source)
      } catch {
        throw new TtsError('validation', `design candidate not found: ${candidateId}`)
      }
      const cleanName = requireText(name, 'voice profile name')
      if (state.profiles.length >= this.maxProfiles) {
        throw new TtsError(
          'validation',
          `too many voice profiles: ${state.profiles.length} of ${this.maxProfiles} allowed; delete one first`,
          { detail: { count: state.profiles.length, maxProfiles: this.maxProfiles } },
        )
      }
      const sampleFile = `${slugify(cleanName)}-${randomBytes(4).toString('hex')}.${format}`
      await mkdir(this.voicesDir, { recursive: true })
      try {
        await rename(source, joinInside(this.voicesDir, sampleFile))
      } catch (error) {
        throw new TtsError('config', `cannot adopt design candidate: ${candidateId}`, {
          cause: error,
        })
      }
      try {
        const now = new Date().toISOString()
        const profile = createProfile({
          id: newProfileId(),
          name: cleanName,
          kind: 'clone',
          createdAt: now,
          updatedAt: now,
          provider: optionalText(binding?.provider, 'voice profile provider'),
          providerSettings: normalizeProviderSettings(binding?.providerSettings),
          designDescription: optionalText(description, 'voice design description'),
          // The design prompt defines the delivery (tone, emotion, pace), not
          // just the timbre: keep it as the profile's default style instruction
          // so later synthesis keeps the designed feeling.
          styleInstruction: optionalText(description, 'voice style instruction'),
          sampleFile,
          sampleBytes: info.size,
          sampleMime: AUDIO_MIME[format],
        })
        await this.writeState({
          version: STATE_VERSION,
          activeProfileId: profile.id,
          profiles: [...state.profiles, profile],
        })
        this.logger?.info(
          '[whale-tts] design candidate adopted; profile=%s candidate=%s',
          profile.id,
          candidateId,
        )
        return deepFreeze(profile)
      } catch (error) {
        // Keep the candidate: put the file back so a failed write loses nothing.
        await rename(joinInside(this.voicesDir, sampleFile), source).catch(() => undefined)
        throw error
      }
    })
  }

  /**
   * Delete design candidates. With `ids` omitted every candidate is removed.
   *
   * @returns the number of files actually deleted.
   */
  async discardCandidates(ids?: readonly string[]): Promise<number> {
    return this.exclusive(async () => {
      const targets: string[] = []
      if (ids === undefined) {
        let entries: string[]
        try {
          entries = await readdir(this.designDir)
        } catch {
          return 0
        }
        for (const entry of entries) {
          if (extensionFormat(entry) !== undefined) targets.push(entry)
        }
      } else {
        if (!Array.isArray(ids)) {
          throw new TtsError('validation', 'design candidate ids must be an array')
        }
        for (const id of ids) {
          if (typeof id !== 'string' || !isSafeFileName(id)) {
            throw new TtsError('validation', `invalid design candidate id: "${String(id)}"`)
          }
          targets.push(id)
        }
      }
      let removed = 0
      for (const id of targets) {
        const target = joinInside(this.designDir, id)
        if (await pathExists(target)) {
          await rm(target, { force: true })
          removed += 1
        }
      }
      if (removed > 0) {
        this.logger?.info('[whale-tts] design candidates discarded; count=%d', removed)
      }
      return removed
    })
  }

  /** Delete candidates whose mtime is older than `maxAgeDays`. */
  async cleanupCandidates(maxAgeDays: number): Promise<number> {
    if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
      throw new TtsError('validation', 'maxAgeDays must be a non-negative number')
    }
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    return this.exclusive(async () => {
      let entries: string[]
      try {
        entries = await readdir(this.designDir)
      } catch {
        return 0
      }
      let removed = 0
      for (const entry of entries) {
        if (extensionFormat(entry) === undefined) continue
        const target = join(this.designDir, entry)
        try {
          const info = await stat(target)
          if (info.mtimeMs < cutoff) {
            await rm(target, { force: true })
            removed += 1
          }
        } catch {
          // Vanished between readdir and stat.
        }
      }
      if (removed > 0) {
        this.logger?.info('[whale-tts] expired design candidates removed; count=%d', removed)
      }
      return removed
    })
  }

  /* ---- statistics ----------------------------------------------------- */

  /** Counts for the settings card (`samples` is the on-disk truth). */
  async stats(): Promise<{
    profiles: number
    samples: number
    sampleBytes: number
    candidates: number
  }> {
    const state = await this.state()
    let entries: string[] = []
    try {
      entries = await readdir(this.voicesDir)
    } catch {
      entries = []
    }
    let samples = 0
    let sampleBytes = 0
    for (const entry of entries) {
      if (extensionFormat(entry) === undefined) continue
      try {
        const info = await stat(join(this.voicesDir, entry))
        if (!info.isFile()) continue
        samples += 1
        sampleBytes += info.size
      } catch {
        // Ignore files that vanish concurrently.
      }
    }
    const candidates = (await this.listCandidates()).length
    return { profiles: state.profiles.length, samples, sampleBytes, candidates }
  }

  /* ---- resolution ----------------------------------------------------- */

  /**
   * Decide what the next synthesis should use.
   *
   * Order: the active profile (when it still exists) → `customVoiceId` →
   * `presetVoiceId` → `{}` (provider default). The activation pointer comes from
   * `input.activeProfileId` when non-empty and from the store's own pointer
   * otherwise. A dangling id is treated as "nothing active" and logged.
   *
   * @throws TtsError('validation') for `design` profiles (they cannot synthesise
   *         until a candidate is adopted) and for broken clone profiles.
   */
  async resolveVoice(input: VoiceResolutionInput): Promise<ResolvedVoice> {
    if (!isRecord(input)) {
      throw new TtsError('validation', 'voice resolution input must be an object')
    }
    const presetModel = optionalText(input.presetModel, 'presetModel')
    const cloneModel = optionalText(input.cloneModel, 'cloneModel')
    const state = await this.state()
    const activeId = optionalText(input.activeProfileId, 'activeProfileId') ?? state.activeProfileId

    if (activeId !== null) {
      const profile = state.profiles.find((entry) => entry.id === activeId)
      if (profile !== undefined) {
        if (profile.kind === 'design') {
          throw new TtsError('validation', 'design profile cannot synthesise; adopt a candidate first')
        }
        if (profile.kind === 'clone') {
          if (profile.sampleFile === undefined) {
            throw new TtsError('validation', `clone profile has no sample: ${profile.id}`)
          }
          const sample = await this.readSampleFile(profile.sampleFile)
          return finalizeResolved({
            model: cloneModel,
            sample: { data: sample.data, mime: sample.mime },
            profileId: profile.id,
            profileName: profile.name,
            style: profile.styleInstruction,
          })
        }
        return finalizeResolved({
          model: presetModel,
          voice: profile.presetVoiceId ?? profile.name,
          profileId: profile.id,
          profileName: profile.name,
          style: profile.styleInstruction,
        })
      }
      this.logger?.warn(
        '[whale-tts] active voice profile %s no longer exists; falling back',
        activeId,
      )
    }

    const customVoiceId = optionalText(input.customVoiceId, 'customVoiceId')
    if (customVoiceId !== undefined) {
      return finalizeResolved({ model: presetModel, voice: customVoiceId })
    }
    const presetVoiceId = optionalText(input.presetVoiceId, 'presetVoiceId')
    if (presetVoiceId !== undefined) {
      return finalizeResolved({ model: presetModel, voice: presetVoiceId })
    }
    return {}
  }

  /* ---- backup / restore ---------------------------------------------- */

  /**
   * Read the whole store into one JSON-safe export payload.
   *
   * Samples and candidates are base64 so the result can be written as a single
   * `.json` backup file; profile ids and file names are kept as references so a
   * restore can remap them safely.
   */
  async exportData(): Promise<VoiceExportData> {
    await this.init()
    const state = await this.state()
    const samples: VoiceSampleBlob[] = []
    for (const profile of state.profiles) {
      if (profile.kind !== 'clone' || profile.sampleFile === undefined) continue
      const sample = await this.readSampleFile(profile.sampleFile)
      samples.push({
        file: profile.sampleFile,
        mime: sample.mime,
        base64: Buffer.from(sample.data).toString('base64'),
      })
    }
    const candidates: VoiceCandidateBlob[] = []
    for (const candidate of await this.listCandidates()) {
      const data = await readFileBytes(joinInside(this.designDir, candidate.file))
      candidates.push({
        file: candidate.file,
        format: candidate.format,
        base64: Buffer.from(data).toString('base64'),
      })
    }
    return deepFreeze({
      profiles: state.profiles,
      samples,
      candidates,
      activeProfileId: state.activeProfileId,
    }) as VoiceExportData
  }

  /**
   * Import profiles/candidates from a backup.
   *
   * `merge` appends to the current library; `replace` clears it first. Imported
   * profiles always get fresh ids and sample file names, so ids from another
   * machine never collide. The state file is written before stale files of a
   * replace are removed, so a failure leaves the old store intact.
   */
  async importData(request: VoiceImportRequest): Promise<VoiceImportResult> {
    if (!isRecord(request)) {
      throw new TtsError('validation', 'voice import request must be an object')
    }
    const mode = request.mode === 'replace' ? 'replace' : 'merge'
    const incoming = Array.isArray(request.profiles) ? request.profiles : []
    const candidates = Array.isArray(request.candidates) ? request.candidates : []

    return this.exclusive(async () => {
      const state = await this.loadState()
      const previousCandidates =
        mode === 'replace'
          ? await readdir(this.designDir).catch(() => [] as string[])
          : []
      const profiles: VoiceProfile[] = mode === 'replace' ? [] : [...state.profiles]
      if (profiles.length + incoming.length > this.maxProfiles) {
        throw new TtsError(
          'validation',
          `too many voice profiles: ${profiles.length + incoming.length} of ${this.maxProfiles} allowed`,
          { detail: { count: profiles.length + incoming.length, maxProfiles: this.maxProfiles } },
        )
      }

      const now = new Date().toISOString()
      const imported: VoiceProfile[] = []
      for (const input of incoming) {
        if (!isRecord(input)) {
          throw new TtsError('validation', 'backup contains an invalid voice profile')
        }
        const name = requireText(input.name, 'voice profile name')
        const kind = requireKind(input.kind)
        let sampleFile: string | undefined
        let sampleBytes: number | undefined
        let sampleMime: string | undefined
        if (kind === 'clone') {
          const sample = input.sample
          if (!isRecord(sample) || !(sample.data instanceof Uint8Array)) {
            throw new TtsError('validation', `clone profile "${name}" has no sample in the backup`)
          }
          const detected = detectAudioFormat(sample.data)
          if (detected === undefined) {
            throw new TtsError('validation', `clone sample for "${name}" is neither wav nor mp3`)
          }
          if (sample.data.byteLength > this.maxSampleBytes) {
            throw new TtsError(
              'validation',
              `clone sample for "${name}" is too large (${sample.data.byteLength} bytes)`,
            )
          }
          sampleFile = await this.writeSampleFile(sample.data, detected, slugify(name))
          sampleBytes = sample.data.byteLength
          sampleMime = AUDIO_MIME[detected]
        }
        imported.push(
          createProfile({
            id: newProfileId(),
            name,
            kind,
            createdAt: now,
            updatedAt: now,
            provider: optionalText(input.provider, 'voice profile provider'),
            providerSettings: normalizeProviderSettings(input.providerSettings),
            description: optionalText(input.description, 'voice profile description'),
            tags: normalizeTags(input.tags),
            presetVoiceId: optionalText(input.presetVoiceId, 'voice profile preset voice id'),
            styleInstruction: optionalText(input.styleInstruction, 'voice style instruction'),
            designDescription: optionalText(input.designDescription, 'voice design description'),
            sampleFile,
            sampleBytes,
            sampleMime,
          }),
        )
      }

      let importedCandidates = 0
      await mkdir(this.designDir, { recursive: true })
      for (const candidate of candidates) {
        if (!isRecord(candidate) || !(candidate.data instanceof Uint8Array)) continue
        const format: AudioFormat = candidate.format === 'mp3' ? 'mp3' : 'wav'
        const detected = detectAudioFormat(candidate.data)
        if (detected === undefined) {
          throw new TtsError('validation', 'a design candidate in the backup is neither wav nor mp3')
        }
        const id = `${timestampToken(new Date())}-${randomBytes(4).toString('hex')}.${detected}`
        await writeAudioFile(this.designDir, id, candidate.data, false)
        importedCandidates += 1
      }

      const nextProfiles = [...profiles, ...imported]
      let nextActive = mode === 'replace' ? null : state.activeProfileId
      const activeIndex = request.activeProfileIndex
      if (
        typeof activeIndex === 'number' &&
        Number.isInteger(activeIndex) &&
        activeIndex >= 0 &&
        activeIndex < imported.length
      ) {
        const active = imported[activeIndex]
        if (active !== undefined) nextActive = active.id
      }
      await this.writeState({
        version: STATE_VERSION,
        activeProfileId: nextActive,
        profiles: nextProfiles,
      })

      if (mode === 'replace') {
        const keepSamples = new Set(
          nextProfiles.map((entry) => entry.sampleFile).filter((value): value is string => value !== undefined),
        )
        for (const previous of state.profiles) {
          if (previous.sampleFile === undefined || keepSamples.has(previous.sampleFile)) continue
          await rm(joinInside(this.voicesDir, previous.sampleFile), { force: true }).catch(
            () => undefined,
          )
        }
        for (const file of previousCandidates) {
          if (extensionFormat(file) === undefined) continue
          await rm(joinInside(this.designDir, file), { force: true }).catch(() => undefined)
        }
      }

      this.logger?.info(
        '[whale-tts] backup imported; mode=%s profiles=%d candidates=%d',
        mode,
        imported.length,
        importedCandidates,
      )
      return {
        importedProfiles: imported.length,
        importedCandidates,
        activeProfileId: nextActive,
      }
    })
  }

  /* ---- internals ------------------------------------------------------ */

  /** Validate an optional caller-supplied profile id. */
  private requestedProfileId(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') {
      throw new TtsError('validation', 'voice profile id must be a string')
    }
    const id = value.trim()
    if (id === '') return undefined
    if (!PROFILE_ID_PATTERN.test(id)) {
      throw new TtsError('validation', `invalid voice profile id: "${id}"`)
    }
    return id
  }
}
