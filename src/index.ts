/**
 * dsh-whale-tts — provider-agnostic text-to-speech tools for DeepSeek Harness.
 *
 * The plugin registers three model-facing tools and one connection RPC channel
 * for its settings card. It intentionally owns no UI of its own beyond the
 * client bundle (`./client`), and it never sends, plays or uploads audio:
 * consumers decide what to do with the returned file path.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, snapshot } from './config.js'
import type { Config as ConfigValue } from './config.js'
import { TtsService } from './core/service.js'
import { createSynthesizeTool } from './tools/synthesize.js'
import { createListVoicesTool } from './tools/list-voices.js'
import { createStatusTool } from './tools/status.js'
import {
  REMOTE_CHANNEL,
  createRpcHandler,
  type ReadAloudSessions,
  type SettingsBridge,
} from './remote/service.js'
import type { CredentialBridge } from './credentials.js'
import type { LoggerLike } from './types.js'

/** Cordis plugin name (settings namespace is the loader entry id, `whale-tts`). */
export const name = 'whale-tts'

/**
 * Hard dependency: without `ctx.tools` the plugin has nothing to contribute.
 * `credentials`, `settings` and `connection` are optional and resolved lazily,
 * so the plugin still loads in a headless profile that has no Web connection.
 */
export const inject = ['tools']

/** Re-exported so the profile patch and the settings form share one schema. */
export { Config }

/** Minimal structural view of the connection service on the host. */
interface ConnectionService {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
    ): unknown
  }
}

/** Structural view of the settings service used by the card's config endpoints. */
interface SettingsService {
  describe(options?: { redactSecrets?: boolean }): Promise<
    readonly {
      readonly ns: string
      readonly revision?: number
      readonly writable?: boolean
      readonly autoGenerate?: boolean
    }[]
  >
  mutate(
    ns: string,
    operations: readonly (
      | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
      | { readonly op: 'unset'; readonly path: readonly string[] }
    )[],
    expectedRevision?: number,
  ): Promise<void>
}

/** Structural view of the session store used for read-aloud text. */
interface SessionsService {
  get(sessionId: string): { snapshotEvents(): readonly unknown[] } | undefined
}

/**
 * Late-bound session bridge: the web session store may mount after this plugin,
 * and a headless profile may not have it at all.
 */
function sessionsBridge(ctx: Context): ReadAloudSessions {
  const service = (): SessionsService | undefined =>
    ctx.get('sessions') as SessionsService | undefined
  return {
    get(sessionId) {
      const current = service()
      return current === undefined ? undefined : current.get(sessionId)
    },
  }
}

/** Late-bound credential bridge: the service may appear after this plugin. */
function credentialBridge(ctx: Context): CredentialBridge {
  const service = (): CredentialBridge | undefined =>
    ctx.get('credentials') as CredentialBridge | undefined
  return {
    async resolve(ref) {
      const current = service()
      return current === undefined ? undefined : current.resolve(ref)
    },
    async describe(ref) {
      const current = service()
      return current === undefined
        ? { configured: false, writable: false }
        : current.describe(ref)
    },
    async set(ref, value) {
      const current = service()
      if (current === undefined) {
        throw new Error('the credentials service is not available in this profile')
      }
      return current.set(ref, value)
    },
    async unset(ref) {
      const current = service()
      if (current === undefined) return
      return current.unset(ref)
    },
  }
}

/**
 * Late-bound settings bridge for the settings-card config endpoints.
 *
 * The bridge is always returned (instead of checking `ctx.get('settings')` once
 * here): the settings service may mount after this plugin, and the card must
 * start working when it does. When it is still absent, `describe` reports no
 * rows (the card shows a read-only hint) and `mutate` fails with a clear message.
 */
function settingsBridge(ctx: Context): SettingsBridge {
  const read = (): SettingsService | undefined =>
    ctx.get('settings') as SettingsService | undefined
  return {
    async describe(options) {
      const current = read()
      return current === undefined ? [] : current.describe(options)
    },
    async mutate(ns, operations, expectedRevision) {
      const current = read()
      if (current === undefined) {
        throw new Error(
          'the DSH settings service is not available in this profile; edit cordis.patch.yml instead',
        )
      }
      return current.mutate(ns, operations, expectedRevision)
    },
  }
}

/**
 * Seed one already-injected service as a direct property of a child context.
 *
 * Cordis's traceable service proxy evaluates service getters against a *shadow*
 * of the consumer context, so hand-written host code that reads
 * `owner.webServer` directly needs `webServer` visible where the service was
 * read. In-tree plugins seed the value the same way before calling
 * `connection.rpc.handle()`.
 *
 * @param child - the child context created by `ctx.inject`.
 * @param name - service name to seed.
 * @returns the child context, extended when the runtime supports it.
 */
function extendWithService(child: Context, name: string): Context {
  const like = child as unknown as {
    get?: (key: string) => unknown
    extend?: (props: Record<string, unknown>) => unknown
  }
  const value = typeof like.get === 'function' ? like.get(name) : undefined
  if (value !== undefined && typeof like.extend === 'function') {
    return like.extend({ [name]: value }) as Context
  }
  return child
}

/**
 * Mount the plugin.
 *
 * @param ctx - plugin context.
 * @param config - validated configuration (volatile fields are live references).
 */
export function apply(ctx: Context, config: ConfigValue): void {
  const logger = ctx.logger('whale-tts') as unknown as LoggerLike
  const service = new TtsService({
    config,
    logger,
    env: process.env,
    credentials: credentialBridge(ctx),
  })

  // Initialise once; tools await this promise so a corrupt state file surfaces
  // as a tool error instead of a silently broken plugin.
  const ready = service.init().catch((error: unknown) => {
    logger.error('[whale-tts] initialisation failed: %s', (error as Error).message)
    throw error
  })

  const tools = (ctx as unknown as { tools: { register(definition: unknown): unknown } }).tools
  tools.register(createSynthesizeTool(service))
  tools.register(createListVoicesTool(service))
  tools.register(createStatusTool(service))

  // Dispose the service with the plugin fiber (works even when the RPC child
  // below never activates, e.g. in a headless profile without a web server).
  ctx.effect(() => () => service.dispose(), 'whale-tts: service lifecycle')

  // The settings card talks to the host over the DSH connection RPC channel.
  // `ctx.inject` creates a child fiber that activates once the services exist.
  //
  // Both `connection` AND `webServer` are required: cordis's traceable service
  // proxy runs `connection.rpc.handle()` against a shadow of this context, and
  // the host implementation registers the HTTP route through
  // `owner.webServer.register(route)`. Without `webServer` in this context the
  // child fiber throws `cannot get property "webServer" without inject` and the
  // channel silently never appears (the card then gets HTTP 405).
  ctx.inject(['connection', 'webServer'], (child) => {
    // Mirror the in-tree registration helper: seed `webServer` as a direct
    // property so the shadow created by the traceable proxy always finds it.
    const scoped = extendWithService(child, 'webServer')
    const connection = (scoped as unknown as { connection: ConnectionService }).connection
    const handler = createRpcHandler({
      service,
      settings: settingsBridge(ctx),
      sessions: sessionsBridge(ctx),
      logger,
    })
    const dispose = connection.rpc.handle(REMOTE_CHANNEL, async (endpoint, payload, signal) => {
      await ready
      return handler(endpoint, payload, signal)
    })
    return () => {
      if (typeof dispose === 'function') (dispose as () => void)()
    }
  })

  logger.info('[whale-tts] mounted; provider=%s', String(snapshot(config).provider))
}
