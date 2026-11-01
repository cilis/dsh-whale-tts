/**
 * Voice-profile store tests.
 *
 * Runs against the compiled output (`npm run build:host` first). Every test uses
 * a throwaway directory under the OS temp dir.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { VoiceStore } from '../lib/core/voices.js'
import { TtsError } from '../lib/types.js'

/** Minimal RIFF/WAVE header (passes the magic-byte check). */
const WAV = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
])
/** Minimal MP3 (ID3 tag header). */
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
/** Bytes that are neither wav nor mp3. */
const NOT_AUDIO = Uint8Array.from([0x00, 0x01, 0x02, 0x03])

/** Recording logger. */
function createLogger() {
  const entries = []
  const record = (level) => (message, ...args) => {
    entries.push({ level, message: String(message), args })
  }
  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  }
}

/** New store in a temp dir. */
async function createStore(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'whale-voices-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const logger = createLogger()
  const store = new VoiceStore({ dir, logger, ...options })
  await store.init()
  return { dir, store, logger }
}

/** Read a file as bytes. */
async function readBytes(target) {
  return new Uint8Array(await readFile(target))
}

/** Read and parse a JSON file. */
async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'))
}

/** Save a clone profile backed by a fresh sample. */
async function saveClone(store, name = '克隆音色', extra = {}) {
  const sample = await store.saveSample(WAV, 'audio/wav', 'wav')
  return store.save({
    name,
    kind: 'clone',
    sampleFile: sample.sampleFile,
    sampleBytes: sample.sampleBytes,
    sampleMime: sample.sampleMime,
    ...extra,
  })
}

/* -------------------------------------------------------------------------- */
/* init and CRUD                                                              */
/* -------------------------------------------------------------------------- */

test('init creates the state layout and an empty store', async (t) => {
  const { dir, store } = await createStore(t)

  assert.ok((await stat(join(dir, 'voices'))).isDirectory())
  assert.ok((await stat(join(dir, 'design'))).isDirectory())
  assert.deepEqual(await readJson(join(dir, 'voices.json')), {
    version: 1,
    activeProfileId: null,
    profiles: [],
  })
  await store.init()
  assert.deepEqual([...(await store.list())], [])
})

test('save/list/update keep ids, timestamps and kind-specific fields', async (t) => {
  const { dir, store } = await createStore(t)

  const preset = await store.save({
    name: '预置音色',
    kind: 'preset',
    presetVoiceId: 'soda',
    tags: ['female'],
    description: 'a preset',
  })
  assert.match(preset.id, /^vp_[0-9a-f]{16}$/)
  assert.equal(preset.kind, 'preset')
  assert.equal(preset.presetVoiceId, 'soda')
  assert.deepEqual(preset.tags, ['female'])
  assert.equal(preset.createdAt, preset.updatedAt)

  const clone = await saveClone(store, '克隆音色', { styleInstruction: '温柔、语速偏慢' })
  assert.equal(clone.kind, 'clone')
  assert.equal(clone.sampleBytes, WAV.length)
  assert.equal(clone.sampleMime, 'audio/wav')
  assert.equal(clone.styleInstruction, '温柔、语速偏慢')
  assert.deepEqual(await readBytes(join(dir, 'voices', clone.sampleFile)), WAV)

  const design = await store.save({
    name: '设计音色',
    kind: 'design',
    designDescription: '低沉男声',
  })
  assert.equal(design.designDescription, '低沉男声')

  const listed = await store.list()
  assert.equal(listed.length, 3)

  // Update preserves id/createdAt and replaces the fields.
  const renamed = await store.save({ id: preset.id, name: '改名', kind: 'preset', presetVoiceId: 'mia' })
  assert.equal(renamed.id, preset.id)
  assert.equal(renamed.createdAt, preset.createdAt)
  assert.equal(renamed.name, '改名')
  assert.equal(renamed.presetVoiceId, 'mia')

  const persisted = await readJson(join(dir, 'voices.json'))
  assert.equal(persisted.profiles.length, 3)
  const leftovers = (await readdir(dir)).filter((entry) => entry.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('invalid samples and profile ids are rejected', async (t) => {
  const { store } = await createStore(t)

  await assert.rejects(
    store.saveSample(NOT_AUDIO, 'audio/wav', 'wav'),
    (error) => error instanceof TtsError && error.kind === 'validation',
  )
  await assert.rejects(
    store.save({ id: 'vp_missing', name: 'x', kind: 'preset' }),
    (error) => error instanceof TtsError && /not found/.test(error.message),
  )
  await assert.rejects(
    store.save({ name: '', kind: 'preset' }),
    (error) => error instanceof TtsError && error.kind === 'validation',
  )
})

test('the profile cap is enforced', async (t) => {
  const { store } = await createStore(t, { maxProfiles: 2 })
  await store.save({ name: 'a', kind: 'preset' })
  await store.save({ name: 'b', kind: 'preset' })
  await assert.rejects(
    store.save({ name: 'c', kind: 'preset' }),
    (error) => error instanceof TtsError && /too many voice profiles/.test(error.message),
  )
})

/* -------------------------------------------------------------------------- */
/* activation and resolution                                                  */
/* -------------------------------------------------------------------------- */

test('activate/resolveVoice: preset, clone, design and fallbacks', async (t) => {
  const { store, logger } = await createStore(t)
  const preset = await store.save({
    name: '苏打',
    kind: 'preset',
    presetVoiceId: '苏打-v1',
    styleInstruction: '轻快一点',
  })
  const clone = await saveClone(store, '克隆', { styleInstruction: '低沉、缓慢' })
  const design = await store.save({ name: '工坊', kind: 'design', designDescription: 'x' })
  const base = {
    presetVoiceId: 'fallback-preset',
    customVoiceId: 'custom-id',
    presetModel: 'preset-model',
    cloneModel: 'clone-model',
  }

  await store.activate(preset.id)
  assert.deepEqual(
    await store.resolveVoice({ ...base, activeProfileId: preset.id }),
    {
      model: 'preset-model',
      voice: '苏打-v1',
      profileId: preset.id,
      profileName: '苏打',
      style: '轻快一点',
    },
  )

  const cloned = await store.resolveVoice({ ...base, activeProfileId: clone.id })
  assert.equal(cloned.model, 'clone-model')
  assert.equal(cloned.style, '低沉、缓慢')
  assert.equal(cloned.sample.mime, 'audio/wav')
  assert.deepEqual(Uint8Array.from(cloned.sample.data), WAV)

  await assert.rejects(
    store.resolveVoice({ ...base, activeProfileId: design.id }),
    (error) => error instanceof TtsError && /cannot synthesise/.test(error.message),
  )

  // dangling pointer falls back and is logged
  const dangling = await store.resolveVoice({ ...base, activeProfileId: 'vp_missing' })
  assert.deepEqual(dangling, { model: 'preset-model', voice: 'custom-id' })
  assert.ok(
    logger.entries.some(
      (entry) => entry.level === 'warn' && /vp_missing/.test(`${entry.message} ${entry.args.join(' ')}`),
    ),
  )
})

/* -------------------------------------------------------------------------- */
/* duplicate / remove                                                         */
/* -------------------------------------------------------------------------- */

test('duplicate derives its own sample; remove deletes only that sample', async (t) => {
  const { dir, store } = await createStore(t)
  const source = await saveClone(store, '源', { styleInstruction: '温柔' })

  const copy = await store.duplicate(source.id)
  assert.notEqual(copy.id, source.id)
  assert.equal(copy.name, '源 副本')
  assert.notEqual(copy.sampleFile, source.sampleFile)
  assert.equal(copy.styleInstruction, '温柔')
  assert.deepEqual(await readBytes(join(dir, 'voices', copy.sampleFile)), WAV)

  await store.remove(copy.id)
  await assert.rejects(stat(join(dir, 'voices', copy.sampleFile)))
  assert.deepEqual(await readBytes(join(dir, 'voices', source.sampleFile)), WAV)
  assert.equal((await store.list()).length, 1)
})

/* -------------------------------------------------------------------------- */
/* design candidates                                                          */
/* -------------------------------------------------------------------------- */

test('candidates: save, list, adopt and discard', async (t) => {
  const { dir, store } = await createStore(t)
  const first = await store.saveCandidate(WAV, 'wav')
  const second = await store.saveCandidate(MP3, 'mp3')
  assert.match(first.id, /^\d{8}-\d{6}-[0-9a-f]+\.wav$/)
  assert.deepEqual(await readBytes(join(dir, 'design', first.id)), WAV)

  const listed = await store.listCandidates()
  assert.equal(listed.length, 2)

  const profile = await store.adoptCandidate(second.id, '候选音色', '设计产物')
  assert.equal(profile.kind, 'clone')
  assert.equal(profile.styleInstruction, '设计产物')
  assert.equal((await store.state()).activeProfileId, profile.id)
  assert.deepEqual(await readBytes(join(dir, 'voices', profile.sampleFile)), MP3)
  assert.deepEqual(
    (await store.listCandidates()).map((candidate) => candidate.id),
    [first.id],
  )

  assert.equal(await store.discardCandidates(), 1)
  assert.deepEqual(await store.listCandidates(), [])

  await assert.rejects(
    store.adoptCandidate('missing.wav', 'x'),
    (error) => error instanceof TtsError && /not found/.test(error.message),
  )
})

/* -------------------------------------------------------------------------- */
/* backup / restore                                                           */
/* -------------------------------------------------------------------------- */

test('exportData/importData round-trips profiles, samples and candidates', async (t) => {
  const source = await createStore(t)
  await source.store.save({ name: '预置音色', kind: 'preset', presetVoiceId: 'soda' })
  const clone = await saveClone(source.store, '克隆音色')
  await source.store.activate(clone.id)
  await source.store.saveCandidate(MP3, 'mp3')

  const exported = await source.store.exportData()
  assert.equal(exported.profiles.length, 2)
  assert.equal(exported.samples.length, 1)
  assert.equal(exported.candidates.length, 1)
  assert.equal(exported.activeProfileId, clone.id)

  const sampleBytes = new Map(
    exported.samples.map((row) => [row.file, new Uint8Array(Buffer.from(row.base64, 'base64'))]),
  )
  const profilesInput = exported.profiles.map((profile) => {
    const bytes = profile.sampleFile === undefined ? undefined : sampleBytes.get(profile.sampleFile)
    return {
      name: profile.name,
      kind: profile.kind,
      presetVoiceId: profile.presetVoiceId,
      styleInstruction: profile.styleInstruction,
      sample: bytes === undefined ? undefined : { data: bytes, mime: profile.sampleMime ?? 'audio/wav' },
    }
  })
  const activeIndex = exported.profiles.findIndex((profile) => profile.id === exported.activeProfileId)

  const target = await createStore(t)
  const result = await target.store.importData({
    mode: 'merge',
    profiles: profilesInput,
    candidates: exported.candidates.map((row) => ({
      data: new Uint8Array(Buffer.from(row.base64, 'base64')),
      format: row.format,
    })),
    activeProfileIndex: activeIndex,
  })
  assert.equal(result.importedProfiles, 2)
  assert.equal(result.importedCandidates, 1)

  const imported = await target.store.state()
  const importedClone = imported.profiles.find((profile) => profile.name === '克隆音色')
  assert.ok(importedClone !== undefined)
  assert.notEqual(importedClone.id, clone.id)
  assert.equal(imported.activeProfileId, importedClone.id)
  assert.deepEqual(await readBytes(join(target.dir, 'voices', importedClone.sampleFile)), WAV)
  assert.equal((await target.store.listCandidates()).length, 1)
})

test('importData replace mode clears the previous library', async (t) => {
  const { dir, store } = await createStore(t)
  await saveClone(store, '旧音色')
  await store.saveCandidate(WAV, 'wav')

  const result = await store.importData({
    mode: 'replace',
    profiles: [{ name: '新音色', kind: 'preset', presetVoiceId: 'soda' }],
    candidates: [],
    activeProfileIndex: 0,
  })

  assert.equal(result.importedProfiles, 1)
  const state = await store.state()
  assert.equal(state.profiles.length, 1)
  assert.equal(state.profiles[0].name, '新音色')
  assert.equal(state.activeProfileId, state.profiles[0].id)
  assert.deepEqual(await readdir(join(dir, 'voices')), [])
  assert.deepEqual(await readdir(join(dir, 'design')), [])
})

/* -------------------------------------------------------------------------- */
/* concurrency                                                                */
/* -------------------------------------------------------------------------- */

test('concurrent saves keep every update', async (t) => {
  const { store } = await createStore(t)
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      store.save({ name: `音色 ${index}`, kind: 'preset', presetVoiceId: `v${index}` }),
    ),
  )
  const profiles = await store.list()
  assert.equal(profiles.length, 5)
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, 5)
})
