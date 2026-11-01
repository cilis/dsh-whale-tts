// Client-bundle smoke test (no DSH, no browser): loads `lib/client.js` the way
// the web module loader does, then asserts the plugin contract and a few
// Electron-safety properties.
//
// Run: node scripts/client-bundle-smoke.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const requireCjs = createRequire(import.meta.url)
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const React = {
  createElement: () => null,
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
}
const requireStub = (id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') {
    return { jsx: React.createElement, jsxs: React.createElement, Fragment: 'Fragment' }
  }
  return requireCjs(id)
}

let row = null
const context = {
  window: { __ModuleLoader__: { load: (value) => { row = value } } },
}
context.globalThis = context
vm.createContext(context)
vm.runInContext(source, context, { filename: 'lib/client.js' })

const failures = []
const check = (label, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition) failures.push(label)
}

check('module loader row captured', row !== null)
check('id is dsh-whale-tts', row?.id === 'dsh-whale-tts')

const mod = row.factory(requireStub)
check('exports apply + inject', typeof mod.apply === 'function' && Array.isArray(mod.inject))
check(
  'inject declares slots/locale/connection',
  ['slots', 'locale', 'connection'].every((name) => mod.inject.includes(name)),
)

// No blocking browser dialogs: Electron implements neither prompt() nor confirm().
check('bundle never calls window.prompt', !/window\s*\.\s*prompt\s*\(/.test(source))
check('bundle never calls window.confirm', !/window\s*\.\s*confirm\s*\(/.test(source))

const calls = []
let slotEntry = null
const ctx = {
  slots: {
    inject: (_name, callback) => {
      callback()
      return () => {}
    },
    register: (options) => {
      slotEntry = options
      return () => {}
    },
  },
  locale: { register: () => {}, bind: () => (key) => key },
  connection: {
    rpc: {
      call: async (channel, endpoint, payload) => {
        calls.push({ channel, endpoint, payload })
        return { ok: true, value: [] }
      },
    },
  },
  effect: (callback) => {
    callback()
    return () => {}
  },
}

mod.apply(ctx)
check('slot registered under key dsh-whale-tts', slotEntry?.key === 'dsh-whale-tts')
const face = slotEntry?.inject?.()
check('slot inject exposes rpc.call', typeof face?.rpc?.call === 'function')

if (typeof face?.rpc?.call === 'function') {
  await face.rpc.call('profiles/duplicate', { id: 'p1' })
  check(
    'rpc reaches the plugin channel',
    calls.length === 1 && calls[0].channel === '/dsh-whale-tts' && calls[0].endpoint === 'profiles/duplicate',
  )
}

if (failures.length > 0) {
  console.error(`\n${failures.length} client smoke assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nclient bundle smoke: all assertions passed')
}
