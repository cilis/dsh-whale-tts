/**
 * M9 credential resolution tests.
 *
 * Everything runs against the compiled output in `lib/` with an injected fake
 * credential bridge and an injected environment, so these tests never touch the
 * network, the real credential store or `process.env`.
 *
 * Run after building:
 *   npm run build:host && node --test --test-isolation=none test/credentials.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CANDIDATE_REFS,
  KeyResolver,
  defaultBaseURLFor,
  detectKeyType,
} from '../lib/credentials.js'
import { TtsError } from '../lib/types.js'

/** Fake pay-as-you-go key. Never allowed to appear in a resolved description. */
const SECRET = 'sk-test-0123456789abcdefSECRET'
/** Fake Token Plan team key (`ttp-` must win over the `tp-` prefix). */
const TP_SECRET = 'ttp-team-0123456789abcdefSECRET'
/** Fake environment fallback key. */
const ENV_SECRET = 'sk-env-0123456789abcdefSECRET'

/** Predicate for `assert.rejects`: a TtsError of the given kind. */
function isTtsErrorKind(kind) {
  return (error) => {
    assert.ok(error instanceof TtsError, `expected TtsError, got ${String(error)}`)
    assert.equal(error.kind, kind)
    return true
  }
}

/**
 * In-memory credential bridge.
 *
 * `resolve`/`describe`/`set`/`unset` record their calls so tests can assert the
 * resolver's contract without a real DSH profile.
 */
function makeBridge(initial = {}) {
  const store = new Map(Object.entries(initial))
  const calls = { resolve: [], describe: [], set: [], unset: [] }
  const bridge = {
    async resolve(ref) {
      calls.resolve.push(ref)
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'credentials' }
    },
    async describe(ref) {
      calls.describe.push(ref)
      return store.has(ref)
        ? { configured: true, source: 'credentials', writable: true }
        : { configured: false, writable: true }
    },
    async set(ref, value) {
      calls.set.push({ ref, value })
      store.set(ref, value)
    },
    async unset(ref) {
      calls.unset.push(ref)
      store.delete(ref)
    },
  }
  return { bridge, calls, store }
}

/** A bridge whose whole surface throws, to prove failures do not hide env values. */
function makeThrowingBridge() {
  const expected = new Error('credential store unavailable')
  return {
    resolve: async () => {
      throw expected
    },
    describe: async () => {
      throw expected
    },
    set: async () => {
      throw expected
    },
    unset: async () => {
      throw expected
    },
  }
}

/* -------------------------------------------------------------------------- */
/* detectKeyType                                                              */
/* -------------------------------------------------------------------------- */

test('detectKeyType maps the MiMo billing families and leaves the rest custom', () => {
  assert.equal(detectKeyType('sk-0123456789abcdef'), 'pay-as-you-go')
  assert.equal(detectKeyType('tp-0123456789abcdef'), 'token-plan')
  assert.equal(detectKeyType('ttp-0123456789abcdef'), 'token-plan-team')

  // `ttp-` must win over `tp-`: it is not a personal Token Plan key.
  assert.notEqual(detectKeyType('ttp-0123456789abcdef'), 'token-plan')
  assert.notEqual(detectKeyType('tp-0123456789abcdef'), 'token-plan-team')

  // Surrounding whitespace is ignored, prefixes are case-sensitive.
  assert.equal(detectKeyType('  sk-0123456789abcdef  '), 'pay-as-you-go')
  assert.equal(detectKeyType('  ttp-0123456789abcdef  '), 'token-plan-team')

  assert.equal(detectKeyType('my-gateway-key'), 'custom')
  assert.equal(detectKeyType('SK-0123456789abcdef'), 'custom')

  assert.equal(detectKeyType(''), 'unknown')
  assert.equal(detectKeyType('   '), 'unknown')
  assert.equal(detectKeyType(undefined), 'unknown')
  assert.equal(detectKeyType(null), 'unknown')
})

/* -------------------------------------------------------------------------- */
/* defaultBaseURLFor                                                          */
/* -------------------------------------------------------------------------- */

test('defaultBaseURLFor maps MiMo key families to their BaseURLs', () => {
  assert.equal(
    defaultBaseURLFor('mimo', 'pay-as-you-go'),
    'https://api.xiaomimimo.com/v1',
  )
  assert.equal(
    defaultBaseURLFor('mimo', 'token-plan'),
    'https://token-plan-cn.xiaomimimo.com/v1',
  )
  assert.equal(
    defaultBaseURLFor('mimo', 'token-plan-team'),
    'https://token-plan-cn.xiaomimimo.com/v1',
  )

  // Families without a mapping keep the configured/ adaptor default.
  assert.equal(defaultBaseURLFor('mimo', 'custom'), undefined)
  assert.equal(defaultBaseURLFor('mimo', 'unknown'), undefined)

  // Only MiMo has key-family-specific BaseURLs.
  assert.equal(defaultBaseURLFor('openai-compatible', 'pay-as-you-go'), undefined)
  assert.equal(defaultBaseURLFor('minimax', 'token-plan'), undefined)
  assert.equal(defaultBaseURLFor('sapi', 'unknown'), undefined)
})

/* -------------------------------------------------------------------------- */
/* KeyResolver.resolve                                                        */
/* -------------------------------------------------------------------------- */

test('resolve prefers a credential-store hit over the environment', async () => {
  const { bridge } = makeBridge({ MIMO_API_KEY: SECRET })
  const resolver = new KeyResolver({
    credentials: bridge,
    env: { MIMO_API_KEY: ENV_SECRET },
  })

  const resolution = await resolver.resolve('MIMO_API_KEY')
  assert.ok(resolution)
  assert.equal(resolution.value, SECRET)
  assert.equal(resolution.source, 'credentials')
  assert.equal(resolution.keyType, 'pay-as-you-go')
})

test('resolve falls back to the environment when the store misses or throws', async () => {
  // Empty value in the store counts as "not configured" and defers to env.
  const emptyBridge = {
    resolve: async () => ({ value: '' }),
    describe: async () => ({ configured: true }),
    set: async () => undefined,
    unset: async () => undefined,
  }
  const missResolver = new KeyResolver({
    credentials: emptyBridge,
    env: { MIMO_API_KEY: ENV_SECRET },
  })
  const fromEnv = await missResolver.resolve('MIMO_API_KEY')
  assert.equal(fromEnv.value, ENV_SECRET)
  assert.equal(fromEnv.source, 'environment')

  // A broken credential service must not hide the environment.
  const throwingResolver = new KeyResolver({
    credentials: makeThrowingBridge(),
    env: { MIMO_API_KEY: TP_SECRET },
  })
  const fromBrokenStore = await throwingResolver.resolve('MIMO_API_KEY')
  assert.equal(fromBrokenStore.value, TP_SECRET)
  assert.equal(fromBrokenStore.source, 'environment')
  assert.equal(fromBrokenStore.keyType, 'token-plan-team')
})

test('resolve reports undefined for missing, empty and blank references', async () => {
  const { bridge } = makeBridge()
  const resolver = new KeyResolver({ credentials: bridge, env: {} })

  assert.equal(await resolver.resolve('MIMO_API_KEY'), undefined)
  assert.equal(await resolver.resolve(''), undefined)
  assert.equal(await resolver.resolve('   '), undefined)

  // Blank environment values are not configuration either.
  const blankEnv = new KeyResolver({ credentials: bridge, env: { MIMO_API_KEY: '   ' } })
  assert.equal(await blankEnv.resolve('MIMO_API_KEY'), undefined)
})

/* -------------------------------------------------------------------------- */
/* KeyResolver.describe                                                       */
/* -------------------------------------------------------------------------- */

test('describe never exposes the secret value', async () => {
  const { bridge } = makeBridge({ MIMO_API_KEY: SECRET })
  const resolver = new KeyResolver({
    credentials: bridge,
    env: { OPENAI_API_KEY: ENV_SECRET },
  })

  const fromStore = await resolver.describe('MIMO_API_KEY')
  assert.deepEqual({ ...fromStore }, {
    ref: 'MIMO_API_KEY',
    configured: true,
    source: 'credentials',
    keyType: 'pay-as-you-go',
  })
  assert.equal(fromStore.value, undefined)
  assert.ok(!JSON.stringify(fromStore).includes(SECRET))
  assert.ok(!JSON.stringify(fromStore).includes('sk-'))

  const fromEnv = await resolver.describe('OPENAI_API_KEY')
  assert.equal(fromEnv.configured, true)
  assert.equal(fromEnv.source, 'environment')
  assert.equal(fromEnv.keyType, 'pay-as-you-go')
  assert.ok(!JSON.stringify(fromEnv).includes(ENV_SECRET))

  const missing = await resolver.describe('MINIMAX_API_KEY')
  assert.deepEqual({ ...missing }, {
    ref: 'MINIMAX_API_KEY',
    configured: false,
    source: 'missing',
    keyType: 'unknown',
  })

  const empty = await resolver.describe('   ')
  assert.deepEqual({ ...empty }, {
    ref: '',
    configured: false,
    source: 'missing',
    keyType: 'unknown',
  })
})

test('describe survives a throwing credential store and still reports env state', async () => {
  const resolver = new KeyResolver({
    credentials: makeThrowingBridge(),
    env: { MIMO_API_KEY: SECRET },
  })
  const info = await resolver.describe('MIMO_API_KEY')
  assert.equal(info.configured, true)
  assert.equal(info.source, 'environment')
  assert.equal(info.keyType, 'pay-as-you-go')
  assert.ok(!JSON.stringify(info).includes(SECRET))
})

/* -------------------------------------------------------------------------- */
/* KeyResolver.set                                                            */
/* -------------------------------------------------------------------------- */

test('set rejects an empty reference or value before touching the store', async () => {
  const { bridge, calls } = makeBridge()
  const resolver = new KeyResolver({ credentials: bridge, env: {} })

  await assert.rejects(resolver.set('', SECRET), isTtsErrorKind('validation'))
  await assert.rejects(resolver.set('   ', SECRET), isTtsErrorKind('validation'))
  await assert.rejects(resolver.set('MIMO_API_KEY', ''), isTtsErrorKind('validation'))
  await assert.rejects(resolver.set('MIMO_API_KEY', '   '), isTtsErrorKind('validation'))

  assert.deepEqual(calls.set, [])
})

test('set requires the credentials service and explains the environment fallback', async () => {
  const resolver = new KeyResolver({ env: {} })
  await assert.rejects(
    resolver.set('MIMO_API_KEY', SECRET),
    (error) =>
      error instanceof TtsError &&
      error.kind === 'config' &&
      /credentials service is not available/.test(error.message),
  )
})

test('set stores the trimmed value and returns only a non-secret description', async () => {
  const { bridge, calls, store } = makeBridge()
  const resolver = new KeyResolver({ credentials: bridge, env: {} })

  const info = await resolver.set('MIMO_API_KEY', `  ${SECRET}  `)

  assert.deepEqual(calls.set, [{ ref: 'MIMO_API_KEY', value: SECRET }])
  assert.equal(store.get('MIMO_API_KEY'), SECRET)
  assert.deepEqual({ ...info }, {
    ref: 'MIMO_API_KEY',
    configured: true,
    source: 'credentials',
    keyType: 'pay-as-you-go',
  })
  // The returned description must not echo the value back.
  assert.equal(info.value, undefined)
  assert.ok(!JSON.stringify(info).includes(SECRET))
  assert.ok(!JSON.stringify(info).includes('abcdef'))
  // describe reads from the bridge afterwards.
  assert.equal((await resolver.describe('MIMO_API_KEY')).configured, true)
})

/* -------------------------------------------------------------------------- */
/* KeyResolver.clear                                                          */
/* -------------------------------------------------------------------------- */

test('clear unsets the stored entry and falls back to the environment', async () => {
  const { bridge, calls, store } = makeBridge({ MIMO_API_KEY: SECRET })
  const resolver = new KeyResolver({
    credentials: bridge,
    env: { MIMO_API_KEY: ENV_SECRET },
  })

  assert.equal((await resolver.describe('MIMO_API_KEY')).source, 'credentials')

  const info = await resolver.clear('MIMO_API_KEY')

  assert.deepEqual(calls.unset, ['MIMO_API_KEY'])
  assert.equal(store.has('MIMO_API_KEY'), false)
  assert.equal(info.configured, true)
  assert.equal(info.source, 'environment')
  assert.equal(info.keyType, 'pay-as-you-go')
  assert.ok(!JSON.stringify(info).includes(ENV_SECRET))
})

test('clear is a no-op for empty refs and for a missing credential service', async () => {
  const { bridge, calls } = makeBridge()
  const resolver = new KeyResolver({ credentials: bridge, env: {} })
  const empty = await resolver.clear('   ')
  assert.deepEqual({ ...empty }, {
    ref: '',
    configured: false,
    source: 'missing',
    keyType: 'unknown',
  })
  assert.deepEqual(calls.unset, [])

  const withoutCredentials = new KeyResolver({ env: {} })
  const missing = await withoutCredentials.clear('MIMO_API_KEY')
  assert.equal(missing.configured, false)
  assert.equal(missing.source, 'missing')
})

test('clear tolerates a throwing credential store', async () => {
  const resolver = new KeyResolver({
    credentials: makeThrowingBridge(),
    env: { MIMO_API_KEY: SECRET },
  })
  const info = await resolver.clear('MIMO_API_KEY')
  assert.equal(info.configured, true)
  assert.equal(info.source, 'environment')
})

/* -------------------------------------------------------------------------- */
/* KeyResolver.candidates                                                     */
/* -------------------------------------------------------------------------- */

test('candidates returns every candidate ref with its configuration state', async () => {
  const { bridge } = makeBridge({ OPENAI_API_KEY: SECRET })
  const resolver = new KeyResolver({
    credentials: bridge,
    env: { MIMO_API_KEY: ENV_SECRET },
  })

  const candidates = await resolver.candidates()

  assert.equal(candidates.length, CANDIDATE_REFS.length)
  assert.deepEqual(
    candidates.map((candidate) => candidate.ref),
    [...CANDIDATE_REFS],
  )
  assert.equal(new Set(candidates.map((candidate) => candidate.ref)).size, CANDIDATE_REFS.length)

  const byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]))
  const mimo = byRef.get('MIMO_API_KEY')
  assert.equal(mimo.configured, true)
  assert.equal(mimo.source, 'environment')
  assert.equal(mimo.keyType, 'pay-as-you-go')

  const openai = byRef.get('OPENAI_API_KEY')
  assert.equal(openai.configured, true)
  assert.equal(openai.source, 'credentials')

  const minimax = byRef.get('MINIMAX_API_KEY')
  assert.equal(minimax.configured, false)
  assert.equal(minimax.source, 'missing')
  assert.equal(minimax.keyType, 'unknown')

  for (const candidate of candidates) {
    assert.equal(typeof candidate.ref, 'string')
    assert.equal(typeof candidate.configured, 'boolean')
    assert.ok(['environment', 'credentials', 'missing'].includes(candidate.source))
    assert.ok(
      ['pay-as-you-go', 'token-plan', 'token-plan-team', 'custom', 'unknown'].includes(
        candidate.keyType,
      ),
    )
    // No candidate entry may carry the secret itself.
    assert.equal(candidate.value, undefined)
    assert.ok(!JSON.stringify(candidate).includes(ENV_SECRET))
    assert.ok(!JSON.stringify(candidate).includes(SECRET))
  }
})
