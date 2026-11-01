/**
 * M9 host↔client RPC handler tests.
 *
 * The handler is exercised with a minimal fake service and fake settings, so
 * these tests never construct a real `TtsService`, never read credentials and
 * never make a network request. Every assertion is about the stable wire
 * contract the browser half branches on.
 *
 * Run after building:
 *   npm run build:host && node --test --test-isolation=none test/remote.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIG_NAMESPACE,
  REMOTE_CODES,
  codeFor,
  createRpcHandler,
  toFailure,
} from '../lib/remote/service.js'
import { TtsError } from '../lib/types.js'

/** Fake secret used to prove credentials never travel back over the wire. */
const TEST_KEY = 'tp-0123456789abcdefSECRET'
/** Fake secret hidden inside a provider error message. */
const LEAKED_KEY = 'sk-abcdef123456'

/** Minimal WAV payload (valid magic bytes). */
const WAV = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
])

/** A signal that never aborts. */
function idleSignal() {
  return new AbortController().signal
}

/** Recording logger; the RPC layer only calls `debug`. */
function makeLogger() {
  const entries = []
  const record = (level) => (message, ...args) => {
    entries.push({ level, message: String(message), args })
  }
  return { entries, info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
}

/** Plain `ConfigSnapshot` shape the fake service returns. */
function configSnapshot(overrides = {}) {
  return {
    provider: 'fake',
    fallback: ['sapi'],
    providers: {},
    output: { dir: 'C:\\out', filename: 'tts-{rand}', format: 'auto', overwrite: false },
    cache: { enabled: true, dir: '', maxAgeDays: 30 },
    limits: { maxChars: 2000 },
    log: { text: false },
    activeProfileId: '',
    studioMode: 'preset',
    presetVoiceId: '苏打',
    customVoiceId: '',
    designDescription: '',
    designCandidateCount: 2,
    sampleText: '',
    previewText: '',
    apiKeyEnv: '',
    keySource: 'reuse',
    baseURLOverride: '',
    keyType: 'auto',
    ...overrides,
  }
}

/**
 * Fake `TtsService`. Every method the RPC layer calls is represented; tests
 * override the one method they need (for example to throw).
 */
function makeService(overrides = {}) {
  const calls = []
  // Refs this fake plugin "wrote"; clearing anything else must be refused.
  const owned = new Set(Array.isArray(overrides.ownedKeys) ? overrides.ownedKeys : [])
  const base = {
    snapshot: () => configSnapshot(),
    status: async () => ({
      provider: 'fake',
      fallback: ['sapi'],
      providers: {},
      activeProfileId: null,
      activeVoice: 'provider default',
      cache: { enabled: true, files: 0, bytes: 0 },
      outputDir: 'C:\\out',
      platform: 'win32',
    }),
    credentialCandidates: async () => {
      const rows = [
        {
          ref: 'MIMO_API_KEY',
          configured: owned.has('MIMO_API_KEY'),
          source: owned.has('MIMO_API_KEY') ? 'credentials' : 'missing',
          keyType: owned.has('MIMO_API_KEY') ? 'pay-as-you-go' : 'unknown',
          owned: owned.has('MIMO_API_KEY'),
        },
      ]
      for (const ref of owned) {
        if (ref === 'MIMO_API_KEY') continue
        rows.push({
          ref,
          configured: true,
          source: 'credentials',
          keyType: 'pay-as-you-go',
          owned: true,
        })
      }
      return rows
    },
    setKey: async (ref, value) => {
      calls.push(['setKey', ref, value])
      owned.add(ref)
      return { ref, configured: true, keyType: 'pay-as-you-go' }
    },
    clearKey: async (ref) => {
      if (!owned.has(ref)) {
        throw new TtsError(
          'validation',
          `凭据「${ref}」不是由本插件写入的 DSH 共享凭据，这里不会删除；请到 DSH 凭据设置中移除`,
        )
      }
      owned.delete(ref)
      calls.push(['clearKey', ref])
      return { ref, configured: false, keyType: 'unknown' }
    },
    exportBackup: async () => ({
      path: 'C:\\state\\backups\\b.json',
      file: 'b.json',
      bytes: 128,
      createdAt: '2026-11-01T00:00:00.000Z',
      profiles: 1,
      candidates: 0,
    }),
    listBackups: async () => [],
    importBackup: async (options) => ({
      mode: options.mode ?? 'merge',
      importedProfiles: options.base64 === undefined && options.path === undefined ? 0 : 1,
      importedCandidates: 0,
      activeProfileId: null,
      safetyBackup: {
        path: 'C:\\state\\backups\\safety.json',
        file: 'safety.json',
        bytes: 64,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
      warnings: [],
    }),
    outputDirectoryForCard: () => ({
      dir: 'C:\\out',
      cacheDir: 'C:\\out\\.cache',
      stateDir: 'C:\\state',
    }),
    providerCapabilities: () =>
      new Map([['fake', { speech: true, singing: false, formats: ['wav'], voices: [{ id: 'v1' }], requiresKey: true }]]),
    listVoices: async () => ({ providers: [], profiles: [], activeProfileId: null }),
    listProfiles: async () => [],
    listCandidates: async () => [],
    activateProfile: async (id) => {
      calls.push(['activateProfile', id])
      return { activeProfileId: id }
    },
    uploadSample: async (data, mime, extension) => {
      calls.push(['uploadSample', { data, mime, extension }])
      return { sampleFile: `sample.${extension}`, sampleBytes: data.length, sampleMime: mime }
    },
    discardCandidates: async (ids) => {
      calls.push(['discardCandidates', ids])
      return ids === undefined ? 0 : ids.length
    },
    keys: {
      set: async (ref, value) => {
        calls.push(['keys.set', ref, value])
        return { ref, configured: true, keyType: 'pay-as-you-go' }
      },
      clear: async (ref) => {
        calls.push(['keys.clear', ref])
        return { ref, configured: false, keyType: 'unknown' }
      },
    },
  }
  return { service: { ...base, ...overrides }, calls }
}

/** Fake `ctx.settings`; records describe/mutate calls. */
function makeSettings(overrides = {}) {
  const calls = []
  const settings = {
    describe: async (options) => {
      calls.push(['describe', options])
      return [{ ns: CONFIG_NAMESPACE, revision: 5, value: { provider: 'fake' }, writable: true }]
    },
    mutate: async (ns, operations, expectedRevision) => {
      calls.push(['mutate', ns, operations, expectedRevision])
    },
    ...overrides,
  }
  return { settings, calls }
}

/** Build a handler around a fresh fake pair. */
function makeHandler(options = {}) {
  const { service, calls } = makeService(options.service)
  const settings = options.settings
  const logger = makeLogger()
  const handler = createRpcHandler({ service, settings, logger, platform: 'win32' })
  return { handler, service, calls, logger, settings }
}

/* -------------------------------------------------------------------------- */
/* Routing and failure codes                                                  */
/* -------------------------------------------------------------------------- */

test('unknown endpoints fail with the stable not-found code and details', async () => {
  const { handler } = makeHandler()
  const result = await handler('does/not-exist', {}, idleSignal())

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: REMOTE_CODES.notFound,
      message: 'unknown endpoint "does/not-exist"',
      details: { endpoint: 'does/not-exist' },
    },
  })
})

test('design/list lists saved candidates without generating or touching the network', async () => {
  const { handler, calls } = makeHandler({
    service: {
      listCandidates: async () => [{ id: 'cand-1', file: 'design/cand-1.wav', createdAt: '2026-11-01' }],
    },
  })

  const result = await handler('design/list', {}, idleSignal())

  assert.equal(result.ok, true)
  assert.equal(result.value.length, 1)
  assert.equal(result.value[0].id, 'cand-1')
  assert.deepEqual(calls, [])
})

test('design/candidates still requires a description when generating', async () => {
  const { handler } = makeHandler({
    service: {
      designCandidates: async ({ description }) => {
        if (String(description ?? '').trim() === '') {
          throw new TtsError('validation', 'design description is empty')
        }
        return [{ id: 'cand-2', file: 'design/cand-2.wav', createdAt: 'x' }]
      },
    },
  })

  const result = await handler('design/candidates', { description: '   ' }, idleSignal())

  assert.equal(result.ok, false)
  assert.equal(result.error.code, REMOTE_CODES.badRequest)
  assert.match(result.error.message, /design description is empty/)
})

test('design/adopt falls back to the configured description as style instruction', async () => {
  const adopted = []
  const { handler } = makeHandler({
    service: {
      snapshot: () => configSnapshot({ designDescription: '温柔低沉的女声，语速偏慢' }),
      adoptCandidate: async (candidateId, name, description) => {
        adopted.push({ candidateId, name, description })
        return { id: 'vp_1', name, kind: 'clone' }
      },
    },
  })

  const result = await handler(
    'design/adopt',
    { candidateId: 'cand-1.wav', name: '设计音色' },
    idleSignal(),
  )

  assert.equal(result.ok, true)
  assert.deepEqual(adopted, [
    {
      candidateId: 'cand-1.wav',
      name: '设计音色',
      description: '温柔低沉的女声，语速偏慢',
    },
  ])
})

test('backup endpoints export, list and import (mode defaults to merge)', async () => {
  const { handler } = makeHandler()

  const exported = await handler('backup/export', {}, idleSignal())
  assert.equal(exported.ok, true)
  assert.equal(exported.value.file, 'b.json')

  const listed = await handler('backup/list', {}, idleSignal())
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.value, [])

  const imported = await handler(
    'backup/import',
    { base64: Buffer.from('{}').toString('base64') },
    idleSignal(),
  )
  assert.equal(imported.ok, true)
  assert.equal(imported.value.mode, 'merge')
  assert.equal(imported.value.importedProfiles, 1)

  const replace = await handler(
    'backup/import',
    { mode: 'replace', path: 'C:\\backup.json' },
    idleSignal(),
  )
  assert.equal(replace.ok, true)
  assert.equal(replace.value.mode, 'replace')
})

test('TtsError kinds map to stable remote codes', async () => {
  const cases = [
    ['validation', REMOTE_CODES.badRequest],
    ['config', REMOTE_CODES.badRequest],
    ['auth', REMOTE_CODES.keyMissing],
    ['provider', REMOTE_CODES.provider],
    ['timeout', REMOTE_CODES.provider],
    ['quota', REMOTE_CODES.provider],
    ['platform', REMOTE_CODES.unsupported],
    ['not-implemented', REMOTE_CODES.unsupported],
    ['aborted', REMOTE_CODES.aborted],
  ]

  for (const [kind, expectedCode] of cases) {
    const { handler } = makeHandler({
      service: {
        listVoices: async () => {
          throw new TtsError(kind, `synthetic ${kind} failure`)
        },
      },
    })
    const result = await handler('providers/list', {}, idleSignal())
    assert.equal(result.ok, false, `expected a failure for ${kind}`)
    assert.equal(result.error.code, expectedCode, `wrong code for ${kind}`)
    assert.ok(result.error.message.includes(`synthetic ${kind} failure`))
    assert.ok(result.error.details !== undefined)
  }
})

test('unexpected Error messages are redacted before crossing the wire', async () => {
  const { handler } = makeHandler({
    service: {
      listVoices: async () => {
        throw new Error(`upstream rejected ${LEAKED_KEY}`)
      },
    },
  })
  const result = await handler('providers/list', {}, idleSignal())

  assert.equal(result.ok, false)
  assert.equal(result.error.code, REMOTE_CODES.internal)
  assert.ok(!result.error.message.includes(LEAKED_KEY))
  assert.ok(result.error.message.includes('sk-***'))

  const bearer = toFailure(new Error('Authorization: Bearer abcdefgh12345678'))
  assert.equal(bearer.error.code, REMOTE_CODES.internal)
  assert.ok(!bearer.error.message.includes('abcdefgh12345678'))
  assert.ok(bearer.error.message.includes('Bearer ***'))
})

test('toFailure keeps TtsError details and codeFor classifies non-TtsErrors', () => {
  const failure = toFailure(
    new TtsError('quota', 'plan exhausted', { status: 402, detail: { status: 402 } }),
  )
  assert.equal(failure.ok, false)
  assert.equal(failure.error.code, REMOTE_CODES.provider)
  assert.deepEqual({ ...failure.error.details }, { status: 402 })

  assert.equal(codeFor(new TtsError('auth', 'nope')), REMOTE_CODES.keyMissing)
  const conflictByName = Object.assign(new Error('stale'), { name: 'SettingsConflictError' })
  assert.equal(codeFor(conflictByName), REMOTE_CODES.conflict)
  assert.equal(codeFor(new Error('revision mismatch')), REMOTE_CODES.conflict)
  assert.equal(codeFor(new Error('unknown profile "x"')), REMOTE_CODES.notFound)
  assert.equal(codeFor(new Error('boom')), REMOTE_CODES.internal)
})

/* -------------------------------------------------------------------------- */
/* Settings bridge                                                            */
/* -------------------------------------------------------------------------- */

test('settings conflicts surface as tts/conflict', async () => {
  const cases = [
    Object.assign(new Error('write rejected'), { name: 'SettingsConflictError' }),
    new Error('stale revision: expected 7, got 6'),
  ]
  for (const error of cases) {
    const { settings } = makeSettings({
      mutate: async () => {
        throw error
      },
    })
    const { handler } = makeHandler({ settings })
    const result = await handler(
      'config/mutate',
      { operations: [{ op: 'set', path: ['provider'], value: 'fake' }] },
      idleSignal(),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error.code, REMOTE_CODES.conflict)
  }
})

test('config/mutate without a settings service is a bad request', async () => {
  const { handler } = makeHandler()
  const result = await handler(
    'config/mutate',
    { operations: [{ op: 'set', path: ['provider'], value: 'fake' }] },
    idleSignal(),
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, REMOTE_CODES.badRequest)
  assert.ok(/settings service/.test(result.error.message))
})

test('config/mutate forwards operations and expectedRevision unchanged', async () => {
  const operations = [
    { op: 'set', path: ['provider'], value: 'fake' },
    { op: 'set', path: ['output', 'format'], value: 'wav' },
  ]
  const { settings, calls } = makeSettings()
  const { handler } = makeHandler({ settings })

  const result = await handler('config/mutate', { operations, expectedRevision: 7 }, idleSignal())

  assert.equal(result.ok, true)
  assert.deepEqual({ ...result.value }, { ok: true })
  const mutation = calls.find((entry) => entry[0] === 'mutate')
  assert.deepEqual(mutation, ['mutate', CONFIG_NAMESPACE, operations, 7])
})

test('config/mutate rejects a missing or empty operations array', async () => {
  const { settings } = makeSettings()
  const { handler } = makeHandler({ settings })

  for (const payload of [undefined, {}, { operations: [] }, { operations: 'nope' }]) {
    const result = await handler('config/mutate', payload, idleSignal())
    assert.equal(result.ok, false)
    assert.equal(result.error.code, REMOTE_CODES.badRequest)
  }
})

/* -------------------------------------------------------------------------- */
/* Profiles, samples and design                                               */
/* -------------------------------------------------------------------------- */

test('profiles/activate treats a missing id as "provider default"', async () => {
  const activated = []
  const { handler } = makeHandler({
    service: {
      activateProfile: async (id) => {
        activated.push(id)
        return { activeProfileId: id }
      },
    },
  })

  const empty = await handler('profiles/activate', {}, idleSignal())
  assert.equal(empty.ok, true)
  assert.deepEqual({ ...empty.value }, { activeProfileId: null })

  const byId = await handler('profiles/activate', { id: 'vp_abc123' }, idleSignal())
  assert.equal(byId.ok, true)
  assert.deepEqual({ ...byId.value }, { activeProfileId: 'vp_abc123' })

  assert.deepEqual(activated, [null, 'vp_abc123'])
})

test('samples/upload decodes base64 and derives the extension and mime type', async () => {
  const { handler, calls } = makeHandler()
  const base64 = Buffer.from(WAV).toString('base64')

  const result = await handler(
    'samples/upload',
    { filename: 'My Reference.MP3', base64 },
    idleSignal(),
  )

  assert.equal(result.ok, true)
  const upload = calls.find((entry) => entry[0] === 'uploadSample')
  assert.ok(upload, 'uploadSample was not called')
  const payload = upload[1]
  assert.equal(payload.extension, 'mp3')
  assert.equal(payload.mime, 'audio/mpeg')
  assert.deepEqual([...payload.data], [...WAV])
  assert.equal(payload.data.length, WAV.length)
})

test('samples/upload falls back to wav and rejects an empty payload', async () => {
  const { handler, calls } = makeHandler()

  const wav = await handler(
    'samples/upload',
    { filename: 'voice.wav', base64: Buffer.from(WAV).toString('base64') },
    idleSignal(),
  )
  assert.equal(wav.ok, true)
  const upload = calls.find((entry) => entry[0] === 'uploadSample')
  assert.equal(upload[1].extension, 'wav')
  assert.equal(upload[1].mime, 'audio/wav')

  const missing = await handler('samples/upload', { filename: 'x.wav' }, idleSignal())
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, REMOTE_CODES.badRequest)
})

test('design/discard passes undefined without ids and filters non-string ids', async () => {
  const { handler, calls } = makeHandler()

  const all = await handler('design/discard', {}, idleSignal())
  assert.equal(all.ok, true)
  assert.deepEqual({ ...all.value }, { removed: 0 })

  const selected = await handler('design/discard', { ids: ['a.wav', 'b.wav', 42] }, idleSignal())
  assert.equal(selected.ok, true)
  assert.deepEqual({ ...selected.value }, { removed: 2 })

  const discards = calls.filter((entry) => entry[0] === 'discardCandidates')
  assert.deepEqual(discards, [
    ['discardCandidates', undefined],
    ['discardCandidates', ['a.wav', 'b.wav']],
  ])
})

/* -------------------------------------------------------------------------- */
/* Status payload                                                             */
/* -------------------------------------------------------------------------- */

test('status aggregates status, output, keys, config and providers', async () => {
  const { handler } = makeHandler()
  const result = await handler('status', undefined, idleSignal())

  assert.equal(result.ok, true)
  const value = result.value
  for (const field of ['status', 'output', 'keys', 'config', 'revision', 'writable', 'providers']) {
    assert.ok(field in value, `status payload is missing "${field}"`)
  }
  assert.equal(value.status.provider, 'fake')
  assert.equal(value.status.outputDir, 'C:\\out')
  assert.deepEqual({ ...value.output }, {
    dir: 'C:\\out',
    cacheDir: 'C:\\out\\.cache',
    stateDir: 'C:\\state',
  })
  assert.equal(value.keys.length, 1)
  assert.equal(value.keys[0].ref, 'MIMO_API_KEY')
  assert.equal(value.config.provider, 'fake')
  assert.equal(value.revision, undefined)
  assert.equal(value.writable, false)
  assert.deepEqual([...value.providers], ['fake'])
})

test('status reads revision and writability from the settings bridge', async () => {
  const { settings } = makeSettings()
  const { handler } = makeHandler({ settings })
  const result = await handler('status', undefined, idleSignal())

  assert.equal(result.ok, true)
  assert.equal(result.value.revision, 5)
  assert.equal(result.value.writable, true)
})

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

test('credentials/clear refuses to delete a credential the plugin never wrote', async () => {
  const { handler, calls } = makeHandler()

  const result = await handler(
    'credentials/clear',
    { ref: 'XIAOMI_TOKEN_PLAN_CN_API_KEY' },
    idleSignal(),
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.code, REMOTE_CODES.badRequest)
  assert.match(result.error.message, /不是由本插件写入/)
  // The shared credential is never unset.
  assert.deepEqual(calls, [])
})

test('credentials/clear deletes a key the plugin wrote after confirmation', async () => {
  const { handler, calls } = makeHandler({ service: { ownedKeys: ['MIMO_API_KEY'] } })

  const result = await handler('credentials/clear', { ref: 'MIMO_API_KEY' }, idleSignal())

  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['clearKey', 'MIMO_API_KEY']])
})

test('credentials/set returns metadata only, never the secret', async () => {
  const { handler, calls } = makeHandler()
  const result = await handler(
    'credentials/set',
    { ref: 'MIMO_API_KEY', value: TEST_KEY },
    idleSignal(),
  )

  assert.equal(result.ok, true)
  assert.deepEqual({ ...result.value }, {
    configured: true,
    keyType: 'pay-as-you-go',
    ref: 'MIMO_API_KEY',
  })
  // The wire response must not carry the secret anywhere (message, details, ...).
  assert.ok(!JSON.stringify(result).includes(TEST_KEY))
  assert.ok(!JSON.stringify(result.value).includes('0123456789abcdef'))

  const stored = calls.find((entry) => entry[0] === 'setKey')
  assert.deepEqual(stored, ['setKey', 'MIMO_API_KEY', TEST_KEY])
})

test('credentials/set rejects a missing ref or value', async () => {
  const { handler } = makeHandler()

  const noRef = await handler('credentials/set', { value: TEST_KEY }, idleSignal())
  assert.equal(noRef.ok, false)
  assert.equal(noRef.error.code, REMOTE_CODES.badRequest)

  const noValue = await handler('credentials/set', { ref: 'MIMO_API_KEY', value: '  ' }, idleSignal())
  assert.equal(noValue.ok, false)
  assert.equal(noValue.error.code, REMOTE_CODES.badRequest)
})
