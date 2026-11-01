// Host-apply smoke test (no DSH needed): exercises lib/index.js `apply` with a
// fake Cordis context, checking that the three tools and the connection RPC
// channel register without touching the real DSH home.
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'whale-host-smoke-'))
process.env.DSH_HOME = home
process.env.HOME = process.env.HOME ?? home

const { apply, name, inject } = await import('../lib/index.js')

const registeredTools = []
const injectedDeps = []
let channel = null
let channelHandler = null
const infos = []
const logger = (namespace) => ({
  info: (...args) => infos.push(['info', namespace, ...args]),
  warn: (...args) => infos.push(['warn', namespace, ...args]),
  error: (...args) => infos.push(['error', namespace, ...args]),
  debug: () => {},
})

const plain = (value) => (value && typeof value.get === 'function' ? value.get() : value)
const config = {
  provider: plain('mimo'),
  fallback: ['sapi'],
  providers: {
    mimo: { enabled: true, apiKeyEnv: 'MIMO_API_KEY', format: 'wav' },
    sapi: { enabled: true },
  },
  output: { dir: '${DSH_HOME}/out', filename: 'tts-{timestamp}-{rand}', format: 'auto', overwrite: false },
  cache: { enabled: true, dir: '${DSH_HOME}/cache', maxAgeDays: 30 },
  limits: { maxChars: 120 },
  log: { text: false },
  activeProfileId: '',
  studioMode: 'preset',
  presetVoiceId: '\u82cf\u6253',
  customVoiceId: '',
  designDescription: '',
  designCandidateCount: 3,
  sampleText: 'hello',
  previewText: 'hello',
  apiKeyEnv: '',
  keySource: 'reuse',
  baseURLOverride: '',
  keyType: 'auto',
}

const ctx = {
  logger,
  tools: {
    register(definition) {
      registeredTools.push(definition.name)
      return () => {}
    },
  },
  get: () => undefined,
  effect(callback) {
    const dispose = callback()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  inject(deps, callback) {
    injectedDeps.push([...deps])
    // Faithful to the DSH host: `connection.rpc.handle` registers the HTTP route
    // through `owner.webServer.register(...)`, so the child context must expose
    // `webServer` (cordis's traceable shadow reads it from here). Throwing the
    // same message the runtime throws keeps this regression test honest.
    const child = {
      connection: {
        rpc: {
          handle(name, handler) {
            if (typeof child.get('webServer') === 'undefined') {
              throw new Error('cannot get property "webServer" without inject')
            }
            channel = name
            channelHandler = handler
            return () => {
              channel = null
            }
          },
        },
      },
      webServer: { register: () => () => {} },
      get(key) {
        if (key === 'webServer') return child.webServer
        if (key === 'connection') return child.connection
        return undefined
      },
      extend(props) {
        const extended = Object.create(Object.getPrototypeOf(child))
        Object.assign(extended, child, props)
        return extended
      },
    }
    callback(child)
    return {}
  },
}

let ok = true
const check = (label, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition) ok = false
}

try {
  check('exports.name === whale-tts', name === 'whale-tts')
  check('exports.inject includes tools', Array.isArray(inject) && inject.includes('tools'))
  await apply(ctx, config)
  check('three tools registered', registeredTools.length === 3 && registeredTools.includes('tts_synthesize'))
  check(
    'rpc child injects connection + webServer',
    injectedDeps.some((deps) => deps.includes('connection') && deps.includes('webServer')),
  )
  check('rpc channel registered', channel === '/dsh-whale-tts')
  check('rpc handler is a function', typeof channelHandler === 'function')
  const failure = await channelHandler('unknown/endpoint', {}, new AbortController().signal)
  check('unknown endpoint -> tts/not-found', failure?.ok === false && failure.error?.code === 'tts/not-found')
  const statusResult = await channelHandler('status', {}, new AbortController().signal)
  check('status endpoint ok', statusResult?.ok === true && typeof statusResult.value?.status?.provider === 'string')
  const configResult = await channelHandler('config/get', {}, new AbortController().signal)
  check('config/get returns snapshot + writable flag', configResult?.ok === true && typeof configResult.value?.writable === 'boolean')
  const candidateRows = await channelHandler('design/list', {}, new AbortController().signal)
  check('design/list returns an array (no generation)', candidateRows?.ok === true && Array.isArray(candidateRows.value))
  const testResult = await channelHandler('credentials/test', {}, new AbortController().signal)
  check('credentials/test degrades to a classified failure', testResult?.ok === true && testResult.value?.ok === false)
  const profiles = await channelHandler('profiles/list', {}, new AbortController().signal)
  check('profiles/list ok', profiles?.ok === true && Array.isArray(profiles.value))
  const exported = await channelHandler('backup/export', {}, new AbortController().signal)
  check(
    'backup/export writes a file with profile/candidate counts',
    exported?.ok === true && typeof exported.value?.path === 'string' && typeof exported.value?.bytes === 'number',
  )
  const backups = await channelHandler('backup/list', {}, new AbortController().signal)
  check('backup/list returns the export', backups?.ok === true && Array.isArray(backups.value) && backups.value.length >= 1)
} finally {
  await rm(home, { recursive: true, force: true })
}
if (!ok) process.exitCode = 1
