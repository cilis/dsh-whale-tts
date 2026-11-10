/**
 * Credential resolution and key typing.
 *
 * The plugin never stores secret values in its Config, never logs them, and
 * never sends them to the browser. It stores a *reference name* and resolves
 * the value through `ctx.credentials` (falling back to `process.env` when the
 * service is absent).
 *
 * Xiaomi MiMo keys carry a billing family in their prefix; the family selects
 * the default BaseURL (`sk-` pay-as-you-go vs `tp-` / `ttp-` Token Plan).
 */
import {
  TtsError,
  type KeyInfo,
  type KeySource,
  type KeyType,
} from './types.js'

/** Subset of `ctx.credentials` the plugin relies on. */
export interface CredentialBridge {
  resolve(ref: string): Promise<{ value: string; source?: string } | undefined>
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** Resolution result carrying the secret (host-internal only). */
export interface KeyResolution {
  readonly value: string
  readonly keyType: KeyType
  readonly source: KeySource
}

/** Xiaomi MiMo BaseURLs selected by key family. */
export const MIMO_BASE_URLS = {
  'pay-as-you-go': 'https://api.xiaomimimo.com/v1',
  'token-plan': 'https://token-plan-cn.xiaomimimo.com/v1',
  'token-plan-team': 'https://token-plan-cn.xiaomimimo.com/v1',
} as const

/** Credential references the settings card offers for reuse, by provider. */
export const PROVIDER_CREDENTIAL_REFS: Readonly<Record<string, readonly string[]>> = {
  mimo: ['MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY', 'XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  siliconflow: ['SILICONFLOW_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'openai-compatible': ['OPENAI_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY'],
  doubao: ['DOUBAO_API_KEY'],
  'qwen-local': [],
  sapi: [],
}

/**
 * Refs to offer for one provider. A configured custom ref is appended so a
 * user who set `apiKeyEnv` manually can always select it again; empty means
 * the provider's built-in refs only.
 */
export function credentialRefsFor(
  provider: string,
  configuredRef = '',
): readonly string[] {
  // Unknown/custom providers have no built-in table; keep the full list so a
  // gateway that reuses MIMO/OPENAI refs can still select them.
  const refs = [...(PROVIDER_CREDENTIAL_REFS[provider] ?? CANDIDATE_REFS)]
  const custom = configuredRef.trim()
  const belongsToAnotherProvider = Object.entries(PROVIDER_CREDENTIAL_REFS).some(
    ([other, list]) => other !== provider && list.includes(custom),
  )
  if (custom !== '' && !belongsToAnotherProvider && !refs.includes(custom)) {
    refs.push(custom)
  }
  return refs
}

/** All known refs, kept for callers that do not scope by provider. */
export const CANDIDATE_REFS: readonly string[] = [
  ...new Set(Object.values(PROVIDER_CREDENTIAL_REFS).flat()),
]

/**
 * Derive the billing family from a key prefix.
 *
 * @param key - secret value (never leaves the host).
 * @returns the family; `unknown` for an empty value, `custom` for other shapes.
 */
export function detectKeyType(key: string): KeyType {
  if (typeof key !== 'string' || key.trim() === '') return 'unknown'
  const trimmed = key.trim()
  if (trimmed.startsWith('ttp-')) return 'token-plan-team'
  if (trimmed.startsWith('tp-')) return 'token-plan'
  if (trimmed.startsWith('sk-')) return 'pay-as-you-go'
  return 'custom'
}

/**
 * Default BaseURL for a provider/key family pair.
 *
 * @returns the mapped URL, or `undefined` when the provider has no mapping.
 */
export function defaultBaseURLFor(provider: string, keyType: KeyType): string | undefined {
  if (provider !== 'mimo') return undefined
  if (keyType === 'pay-as-you-go' || keyType === 'token-plan' || keyType === 'token-plan-team') {
    return MIMO_BASE_URLS[keyType]
  }
  return undefined
}

/** Options for {@link KeyResolver}. */
export interface KeyResolverOptions {
  /** `ctx.credentials`, when the profile provides it. */
  readonly credentials?: CredentialBridge
  /** Process environment (injectable for tests). */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * Resolves credential references and describes them without leaking values.
 */
export class KeyResolver {
  private readonly credentials?: CredentialBridge
  private readonly env: Readonly<Record<string, string | undefined>>

  constructor(options: KeyResolverOptions) {
    this.credentials = options.credentials
    this.env = options.env
  }

  /** Resolve a ref to its secret plus metadata, or `undefined` when unset. */
  async resolve(ref: string): Promise<KeyResolution | undefined> {
    const name = (ref ?? '').trim()
    if (name === '') return undefined
    let value: string | undefined
    let source: KeySource = 'missing'
    if (this.credentials !== undefined) {
      try {
        const hit = await this.credentials.resolve(name)
        if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') {
          value = hit.value
          source = 'credentials'
        }
      } catch {
        // A broken credential store must not hide the environment fallback.
      }
    }
    if (value === undefined) {
      const fromEnvironment = this.env[name]
      if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
        value = fromEnvironment
        source = 'environment'
      }
    }
    if (value === undefined) return undefined
    return { value, keyType: detectKeyType(value), source }
  }

  /** Non-secret description of a ref. */
  async describe(ref: string): Promise<KeyInfo> {
    const name = (ref ?? '').trim()
    if (name === '') {
      return { ref: name, configured: false, source: 'missing', keyType: 'unknown' }
    }
    let configured = false
    let source: KeySource = 'missing'
    if (this.credentials !== undefined) {
      try {
        const info = await this.credentials.describe(name)
        if (info.configured) {
          configured = true
          source = 'credentials'
        }
      } catch {
        // Fall through to the environment check.
      }
    }
    if (!configured) {
      const fromEnvironment = this.env[name]
      if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
        configured = true
        source = 'environment'
      }
    }
    let keyType: KeyType = 'unknown'
    if (configured) {
      const resolved = await this.resolve(name)
      keyType = resolved?.keyType ?? 'unknown'
    }
    return { ref: name, configured, source, keyType }
  }

  /** Store a secret value for a ref (requires the credentials service). */
  async set(ref: string, value: string): Promise<KeyInfo> {
    const name = (ref ?? '').trim()
    if (name === '') throw new TtsError('validation', 'credential reference name is empty')
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TtsError('validation', 'an API key must not be empty')
    }
    if (this.credentials === undefined) {
      throw new TtsError(
        'config',
        'the DSH credentials service is not available in this profile; set the key in $DSH_HOME/.credentials.yaml or the environment',
      )
    }
    await this.credentials.set(name, value.trim())
    return this.describe(name)
  }

  /** Remove a stored secret (environment fallback may still provide it). */
  async clear(ref: string): Promise<KeyInfo> {
    const name = (ref ?? '').trim()
    if (name === '') return { ref: name, configured: false, source: 'missing', keyType: 'unknown' }
    if (this.credentials !== undefined) {
      try {
        await this.credentials.unset(name)
      } catch {
        // A missing entry is fine; report the resulting state below.
      }
    }
    return this.describe(name)
  }

  /** Status of every candidate reference, without exposing values. */
  async candidates(refs: readonly string[] = CANDIDATE_REFS): Promise<readonly KeyInfo[]> {
    const result: KeyInfo[] = []
    for (const ref of refs) {
      result.push(await this.describe(ref))
    }
    return result
  }
}
