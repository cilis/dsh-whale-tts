/**
 * Browser-side RPC client for the host half.
 *
 * Calls travel over the DSH connection RPC channel the host registers
 * (`/dsh-whale-tts`); the connection service owns authentication and the
 * Host/Origin fence, so this module never touches credentials.
 */

/** Stable failure codes the host returns. */
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

/** Connection RPC surface used by the card. */
export interface ConnectionRpc {
  call(
    channel: string,
    endpoint: string,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/** The subset of `ctx.connection` the card needs. */
export interface ConnectionLike {
  readonly rpc: ConnectionRpc
}

/** Error raised for a failed RPC call, carrying the stable code. */
export class RpcError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.details = details
  }
}

/** Channel registered by the host half. */
export const CHANNEL = '/dsh-whale-tts'

/** Typed RPC helper. */
export class RpcClient {
  private readonly connection: ConnectionLike

  constructor(connection: ConnectionLike) {
    this.connection = connection
  }

  /** Call one endpoint; failures throw {@link RpcError}. */
  async call<T>(endpoint: string, payload: Record<string, unknown> = {}): Promise<T> {
    const raw = await this.connection.rpc.call(CHANNEL, endpoint, payload)
    if (raw === undefined || raw === null || typeof raw !== 'object') {
      throw new RpcError(REMOTE_CODES.internal, 'invalid response from the TTS host half')
    }
    const record = raw as {
      ok?: unknown
      value?: unknown
      error?: { code?: unknown; message?: unknown; details?: unknown }
    }
    if (record.ok === true) return record.value as T
    const code = typeof record.error?.code === 'string' ? record.error.code : REMOTE_CODES.internal
    const message =
      typeof record.error?.message === 'string' && record.error.message !== ''
        ? record.error.message
        : 'TTS request failed'
    const details =
      record.error?.details !== null && typeof record.error?.details === 'object'
        ? (record.error.details as Record<string, unknown>)
        : {}
    throw new RpcError(code, message, details)
  }
}
