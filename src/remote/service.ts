/**
 * Host ↔ client transport.
 *
 * The browser half talks to the host over the DSH connection RPC channel
 * (`ctx.connection.rpc.handle` on the host, `ctx.connection.rpc.call` in the
 * browser). That channel is what the DSH Connection service registers as an
 * authenticated `/api`-style route, so the plugin never implements its own
 * authentication.
 *
 * Every failure is reported with a stable `tts/...` code; the browser half
 * branches on `code` instead of on error classes.
 */
import { TtsError, isTtsError, type KeyInfo } from '../types.js'
import type { ConfigSnapshot } from '../config.js'
import type { ConnectionTestResult, TtsService } from '../core/service.js'
import type { LoggerLike } from '../types.js'
import { prepareSpeechSegments, readAssistantMessage } from '../core/read-aloud.js'

/** Wire namespace of the plugin's RPC channel. */
export const REMOTE_CHANNEL = '/dsh-whale-tts'

/** Config namespace (equals the loader entry id). */
export const CONFIG_NAMESPACE = 'whale-tts'

/** Stable failure codes returned to the browser half. */
export const REMOTE_CODES = {
  badRequest: 'tts/bad-request',
  notFound: 'tts/not-found',
  conflict: 'tts/conflict',
  keyMissing: 'tts/key-missing',
  provider: 'tts/provider',
  unsupported: 'tts/unsupported',
  notImplemented: 'tts/not-implemented',
  aborted: 'tts/aborted',
  internal: 'tts/internal',
} as const

/** Failure code type. */
export type RemoteCode = (typeof REMOTE_CODES)[keyof typeof REMOTE_CODES]

/** Successful wire result. */
export interface RpcSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Failed wire result. */
export interface RpcFailure {
  readonly ok: false
  readonly error: {
    readonly code: RemoteCode
    readonly message: string
    readonly details: Readonly<Record<string, unknown>>
  }
}

/** Raw RPC result as the connection service transports it. */
export type RpcResult<T = unknown> = RpcSuccess<T> | RpcFailure

/** One settings path operation (mirrors `ctx.settings.SettingsPathOp`). */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** Subset of `ctx.settings` the plugin uses. */
export interface SettingsBridge {
  describe(options?: { redactSecrets?: boolean }): Promise<
    readonly {
      readonly ns: string
      readonly revision?: number
      readonly value?: unknown
      readonly writable?: boolean
      readonly autoGenerate?: boolean
    }[]
  >
  mutate(ns: string, operations: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** Late-bound session store used only to resolve read-aloud message text. */
export interface ReadAloudSessions {
  get(sessionId: string): { snapshotEvents(): readonly unknown[] } | undefined
}

/** Dependencies of the RPC handler. */
export interface RpcHandlerOptions {
  readonly service: TtsService
  readonly settings?: SettingsBridge
  readonly sessions?: ReadAloudSessions
  readonly logger?: LoggerLike
  /** Inject a fresh-abort signal factory for tests. */
  readonly platform?: NodeJS.Platform
}

/** Map a thrown value to a stable wire failure. */
export function toFailure(error: unknown): RpcFailure {
  const code = codeFor(error)
  const message = error instanceof Error ? redactMessage(error.message) : redactMessage(String(error))
  const details =
    isTtsError(error) && error.detail !== undefined ? { ...error.detail } : {}
  return { ok: false, error: { code, message, details } }
}

/** Map an error to its wire code. */
export function codeFor(error: unknown): RemoteCode {
  if (isTtsError(error)) {
    switch (error.kind) {
      case 'validation':
        return REMOTE_CODES.badRequest
      case 'config':
        return REMOTE_CODES.badRequest
      case 'auth':
        return REMOTE_CODES.keyMissing
      case 'quota':
      case 'rate-limit':
      case 'content-filter':
      case 'timeout':
      case 'network':
      case 'server':
      case 'provider':
        return REMOTE_CODES.provider
      case 'platform':
      case 'not-implemented':
        return REMOTE_CODES.unsupported
      case 'aborted':
        return REMOTE_CODES.aborted
      default:
        return REMOTE_CODES.internal
    }
  }
  const name = error instanceof Error ? error.name : ''
  const text = error instanceof Error ? error.message : String(error)
  if (name === 'SettingsConflictError' || /revision/i.test(text)) return REMOTE_CODES.conflict
  if (/not found|no such|unknown .*profile|unknown profile/i.test(text)) {
    return REMOTE_CODES.notFound
  }
  return REMOTE_CODES.internal
}

/** Strip obvious secret material from a wire message. */
function redactMessage(message: string): string {
  return message
    .replace(/\b(sk|tp|ttp)-[A-Za-z0-9_-]{6,}/g, '$1-***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
}

/** Payload helpers: read a required string field. */
export function requireString(payload: unknown, field: string): string {
  const record = payload as Record<string, unknown> | undefined
  const value = record?.[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TtsError('validation', `missing required field "${field}"`)
  }
  return value
}

/** Read an optional string field. */
export function optionalString(payload: unknown, field: string): string | undefined {
  const record = payload as Record<string, unknown> | undefined
  const value = record?.[field]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read an optional finite number field. */
export function optionalNumber(payload: unknown, field: string): number | undefined {
  const record = payload as Record<string, unknown> | undefined
  const value = record?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Status payload the settings card reads on open. */
export interface StatusPayload {
  readonly status: Awaited<ReturnType<TtsService['status']>>
  readonly output: ReturnType<TtsService['outputDirectoryForCard']>
  readonly keys: readonly KeyInfo[]
  readonly config: ConfigSnapshot
  readonly revision?: number
  readonly writable: boolean
  readonly providers: readonly string[]
}

/** Endpoint handler map. */
type EndpointHandler = (payload: unknown, signal: AbortSignal) => Promise<unknown>

/**
 * Build the RPC handler the host registers on {@link REMOTE_CHANNEL}.
 *
 * The handler never throws: every failure becomes an `RpcFailure` so the
 * browser half can branch on stable codes.
 */
export function createRpcHandler(
  options: RpcHandlerOptions,
): (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>> {
  const service = options.service
  const settings = options.settings

  const configState = async (): Promise<{
    config: ConfigSnapshot
    revision?: number
    writable: boolean
    autoGenerate?: boolean
  }> => {
    const config = service.snapshot()
    if (settings === undefined) return { config, writable: false }
    try {
      const rows = await settings.describe({ redactSecrets: true })
      const row = rows.find((entry) => entry.ns === CONFIG_NAMESPACE)
      if (row === undefined) return { config, writable: false }
      return {
        config,
        revision: row.revision,
        writable: row.writable !== false,
        autoGenerate: row.autoGenerate,
      }
    } catch {
      return { config, writable: false }
    }
  }

  const handlers: Record<string, EndpointHandler> = {
    // ------------------------------------------------------------- status
    status: async (): Promise<StatusPayload> => {
      const [status, keys, state] = await Promise.all([
        service.status(),
        service.credentialCandidates(),
        configState(),
      ])
      return {
        status,
        output: service.outputDirectoryForCard(),
        keys,
        config: state.config,
        revision: state.revision,
        writable: state.writable,
        providers: [...service.providerCapabilities().keys()],
      }
    },

    'config/get': async () => configState(),

    'config/mutate': async (payload): Promise<{ ok: true }> => {
      if (settings === undefined) {
        throw new TtsError(
          'config',
          'this deployment does not expose the settings service; edit cordis.patch.yml instead',
        )
      }
      const record = payload as
        | { operations?: readonly SettingsPathOp[]; expectedRevision?: number }
        | undefined
      const operations = record?.operations
      if (!Array.isArray(operations) || operations.length === 0) {
        throw new TtsError('validation', 'config/mutate requires a non-empty "operations" array')
      }
      await settings.mutate(CONFIG_NAMESPACE, operations, record?.expectedRevision)
      return { ok: true }
    },

    // ------------------------------------------------------------ profiles
    'profiles/list': async () => service.listProfiles(),

    'profiles/save': async (payload) => {
      const record = payload as { profile?: unknown } | undefined
      const profile = record?.profile as Record<string, unknown> | undefined
      if (profile === undefined || typeof profile !== 'object') {
        throw new TtsError('validation', 'profiles/save requires a "profile" object')
      }
      return service.saveProfile(profile as unknown as import('../core/voices.js').VoiceProfileInput)
    },

    'profiles/delete': async (payload) => service.deleteProfile(requireString(payload, 'id')),

    'profiles/activate': async (payload) =>
      service.activateProfile(optionalString(payload, 'id') ?? null),

    'profiles/duplicate': async (payload) =>
      service.duplicateProfile(
        requireString(payload, 'id'),
        optionalString(payload, 'name'),
      ),

    // ------------------------------------------------------------- samples
    'samples/upload': async (payload) => {
      const record = payload as
        | { filename?: string; mime?: string; base64?: string }
        | undefined
      const base64 = typeof record?.base64 === 'string' ? record.base64 : ''
      if (base64 === '') throw new TtsError('validation', 'samples/upload requires "base64"')
      const filename = typeof record?.filename === 'string' ? record.filename : ''
      const extension = filename.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav'
      const mime =
        typeof record?.mime === 'string' && record.mime !== ''
          ? record.mime
          : extension === 'mp3'
            ? 'audio/mpeg'
            : 'audio/wav'
      const data = Buffer.from(base64, 'base64')
      return service.uploadSample(data, mime, extension)
    },

    // -------------------------------------------------------------- design
    // Listing saved candidates is a distinct operation from generating new
    // ones: generation needs a description (and may hit the network), while the
    // card's initial refresh only wants the candidates already on disk.
    'design/list': async () => service.listCandidates(),

    'design/candidates': async (payload, signal) => {
      const record = payload as
        | { description?: string; count?: number; sampleText?: string }
        | undefined
      return service.designCandidates({
        signal,
        description: record?.description,
        count: record?.count,
        sampleText: record?.sampleText,
      })
    },

    'design/adopt': async (payload) =>
      service.adoptCandidate(
        requireString(payload, 'candidateId'),
        requireString(payload, 'name'),
        // Fall back to the configured design description: an older client (or a
        // card whose draft was reset) may not resend it, but the adopted profile
        // must still keep the design prompt as its style instruction.
        optionalString(payload, 'description') ?? service.snapshot().designDescription,
      ),

    'design/discard': async (payload) => {
      const record = payload as { ids?: unknown } | undefined
      const ids = Array.isArray(record?.ids)
        ? record.ids.filter((id): id is string => typeof id === 'string')
        : undefined
      const removed = await service.discardCandidates(ids)
      return { removed }
    },

    // ------------------------------------------------------------- preview
    preview: async (payload, signal) => {
      const text = optionalString(payload, 'text')
      return service.preview({ text, signal })
    },

    'audio/read': async (payload) => {
      const kind = requireString(payload, 'kind')
      const file = requireString(payload, 'file')
      if (kind === 'preview') {
        const { data, mime } = await service.readPreview(file)
        return { mime, bytes: data.byteLength, base64: Buffer.from(data).toString('base64') }
      }
      if (kind === 'sample') {
        const { data, mime } = await service.readSample(file)
        return { mime, bytes: data.byteLength, base64: Buffer.from(data).toString('base64') }
      }
      if (kind === 'design') {
        const { data, mime } = await service.readDesign(file)
        return { mime, bytes: data.byteLength, base64: Buffer.from(data).toString('base64') }
      }
      throw new TtsError('validation', `unknown audio kind "${kind}"`)
    },

    // --------------------------------------------------------- credentials
    'credentials/candidates': async () => service.credentialCandidates(),

    'credentials/set': async (payload) => {
      const ref = requireString(payload, 'ref')
      const record = payload as { value?: unknown } | undefined
      const value = typeof record?.value === 'string' ? record.value : ''
      if (value.trim() === '') throw new TtsError('validation', 'credentials/set requires "value"')
      const info = await service.setKey(ref, value)
      return { configured: info.configured, keyType: info.keyType, ref: info.ref }
    },

    // Ownership decides, not the client's mode: a credential this plugin wrote
    // may be cleared; a shared DSH credential never is (the service refuses).
    'credentials/clear': async (payload) => {
      const ref = requireString(payload, 'ref')
      const info = await service.clearKey(ref)
      return { configured: info.configured, ref: info.ref, keyType: info.keyType }
    },

    'credentials/test': async (payload, signal): Promise<ConnectionTestResult> =>
      service.testConnection({
        provider: optionalString(payload, 'provider'),
        signal,
      }),

    // ------------------------------------------------------------- backup
    'backup/export': async () => service.exportBackup(),
    'backup/list': async () => service.listBackups(),
    'backup/import': async (payload) => {
      const record = payload as { mode?: unknown; base64?: unknown; path?: unknown } | undefined
      return service.importBackup({
        mode: record?.mode === 'replace' ? 'replace' : 'merge',
        base64: typeof record?.base64 === 'string' ? record.base64 : undefined,
        path: typeof record?.path === 'string' ? record.path : undefined,
      })
    },

    // ---------------------------------------------------------- read aloud
    'read-aloud/config': async () => {
      const snap = service.snapshot()
      return {
        auto: snap.readAloud.auto,
        skipCode: snap.readAloud.skipCode,
        segmentChars: snap.readAloud.segmentChars,
        rate: snap.readAloud.rate,
      }
    },

    'read-aloud/prepare': async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const messageId = requireString(payload, 'messageId')
      const session = options.sessions?.get(sessionId)
      if (session === undefined) return null
      const message = readAssistantMessage(session.snapshotEvents(), messageId)
      if (message === null) return null
      const snap = service.snapshot()
      const segments = prepareSpeechSegments(message.text, {
        skipCode: snap.readAloud.skipCode,
        maxChars: Math.min(snap.readAloud.segmentChars, snap.limits.maxChars),
      })
      if (segments.length === 0) return null
      return {
        messageId,
        segments,
        time: message.time,
        seq: message.seq,
        final: message.final,
        rate: snap.readAloud.rate,
      }
    },

    // ------------------------------------------------------------- misc
    'providers/list': async () => {
      const catalog = await service.listVoices()
      return catalog.providers
    },
  }

  const logger = options.logger

  return async (endpoint, payload, signal) => {
    const handler = handlers[endpoint]
    if (handler === undefined) {
      return {
        ok: false,
        error: {
          code: REMOTE_CODES.notFound,
          message: `unknown endpoint "${endpoint}"`,
          details: { endpoint },
        },
      }
    }
    try {
      const value = await handler(payload, signal)
      return { ok: true, value }
    } catch (error) {
      const failure = toFailure(error)
      logger?.debug?.(
        '[whale-tts] rpc %s failed: %s',
        endpoint,
        failure.error.code,
      )
      return failure
    }
  }
}
