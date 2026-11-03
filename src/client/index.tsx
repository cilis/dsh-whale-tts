/**
 * Browser half entry point.
 *
 * Registers the card on the DSH Plugins page (`plugins.bundle.config`, keyed by
 * the npm package name) while the host serves the `whale-tts` settings
 * namespace. The card is a plain React component; all data comes from the
 * connection RPC channel.
 */
import { RpcClient, type ConnectionLike } from './rpc.js'
import { TtsCard } from './card.js'
import { ReadAloudAction } from './read-aloud.js'
import { NS, dictionaries } from './i18n.js'
import { installStyles } from './styles.js'

/** Cordis client plugin name. */
export const name = 'whale-tts'

/** Client services required before this half activates. */
export const inject = ['slots', 'locale', 'connection']

/** Minimal client context surface used here. */
interface ClientContext {
  readonly slots: {
    inject(name: string, callback: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  readonly locale: {
    register(namespace: string, bundles: Record<string, Record<string, string>>): unknown
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
  }
  /**
   * The connection service. `ctx` itself is a Cordis proxy that only exposes
   * declared services, so the RPC client must be handed the *service object*
   * (`ctx.connection`), never the context: reading `ctx.rpc` would be rejected
   * with "cannot get property \"rpc\" without inject".
   */
  readonly connection: ConnectionLike
  effect(callback: () => unknown): unknown
}

/** Mount the settings card. */
export function apply(ctx: ClientContext): void {
  ctx.locale.register(NS, dictionaries)
  const t = ctx.locale.bind(NS)
  // Hand the client the connection service instance, not the context proxy.
  const rpc = new RpcClient(ctx.connection)

  // The stylesheet lives for the life of this plugin's fiber; the installer is
  // idempotent and a no-op when there is no DOM (unit tests).
  ctx.effect(() => installStyles())

  // `ctx.effect` is provided by the browser runtime and scopes the registration
  // to this plugin's fiber.
  ctx.effect(() =>
    ctx.slots.inject('plugins.bundle.config', () =>
      ctx.slots.register(
        {
          name: 'plugins.bundle.config',
          key: 'dsh-whale-tts',
          locale: NS,
          inject: () => ({ t, rpc }),
        },
        TtsCard,
      ),
    ),
  )

  // Assistant-message action: one speaker button per finalized reply. The
  // session-scoped slot passes `messageId` as owner props; `inject` adds the
  // session id plus the shared RPC client/translate function.
  ctx.effect(() =>
    ctx.slots.inject('conversation.chat.assistant-actions', () =>
      ctx.slots.register(
        {
          name: 'conversation.chat.assistant-actions',
          id: 'whale-tts-speak',
          order: 20,
          locale: NS,
          inject: (sessionId: string) => ({ sessionId, t, rpc }),
        },
        ReadAloudAction,
      ),
    ),
  )
}
