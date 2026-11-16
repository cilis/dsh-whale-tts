/**
 * Cross-profile voice control tests.
 *
 * The shared document is intentionally tiny: provider + voice pointer only.
 * These tests pin the overlay and publish rules so desktop/qqbot cannot drift
 * back to separate provider decisions.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { TtsService } from '../lib/core/service.js'
import { readSharedControl, writeSharedControl } from '../lib/core/shared-control.js'

function logger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  }
}

function config(overrides = {}) {
  return {
    provider: 'fake',
    fallback: [],
    providers: {
      fake: {
        enabled: true,
        baseURL: '',
        apiKeyEnv: 'FAKE_API_KEY',
        model: 'fake-model',
        designModel: '',
        cloneModel: '',
        voice: 'v1',
        format: 'wav',
        timeoutMs: 5_000,
        retry: 0,
        style: '',
        headers: {},
        voiceName: '',
        scriptPath: '',
        rate: 0,
      },
    },
    output: {
      dir: '${TMP}/out',
      filename: 'tts-{rand}',
      format: 'auto',
      overwrite: false,
    },
    cache: { enabled: false, dir: '', maxAgeDays: 30 },
    limits: { maxChars: 100 },
    readAloud: { auto: false, skipCode: true, segmentChars: 600, rate: 1 },
    log: { text: false },
    sharedControl: { enabled: true },
    activeProfileId: '',
    studioMode: 'preset',
    presetVoiceId: '苏打',
    customVoiceId: '',
    designDescription: '',
    designCandidateCount: 2,
    sampleText: '你好。',
    previewText: '你好。',
    apiKeyEnv: '',
    keySource: 'reuse',
    baseURLOverride: '',
    keyType: 'auto',
    ...overrides,
  }
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'whale-shared-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('shared-control writes and reads the provider + voice pointer', async () => {
  await withDir(async (dir) => {
    await writeSharedControl(dir, {
      provider: 'deepseek',
      activeProfileId: 'vp_test',
      presetVoiceId: 'stella',
      customVoiceId: '',
    })
    assert.deepEqual(readSharedControl(dir), {
      provider: 'deepseek',
      activeProfileId: 'vp_test',
      presetVoiceId: 'stella',
      customVoiceId: '',
    })
  })
})

test('snapshot overlays shared provider and voice without changing local output', async () => {
  await withDir(async (dir) => {
    const service = new TtsService({
      config: config(),
      logger: logger(),
      stateDir: dir,
      env: {},
      home: dir,
      tmp: dir,
    })
    await writeSharedControl(dir, {
      provider: 'deepseek',
      activeProfileId: 'vp_test',
      presetVoiceId: 'stella',
      customVoiceId: '',
    })
    const snap = service.snapshot()
    assert.equal(snap.provider, 'deepseek')
    assert.equal(snap.activeProfileId, 'vp_test')
    assert.equal(snap.presetVoiceId, 'stella')
    assert.equal(snap.customVoiceId, '')
    assert.equal(snap.output.dir, '${TMP}/out')
  })
})

test('publishSharedControl writes the local provider and voice pointer', async () => {
  await withDir(async (dir) => {
    const local = config({
      provider: 'mimo',
      activeProfileId: 'vp_local',
      presetVoiceId: '',
      customVoiceId: '',
    })
    const service = new TtsService({
      config: local,
      logger: logger(),
      stateDir: dir,
      env: {},
      home: dir,
      tmp: dir,
    })
    await service.publishSharedControl()
    assert.deepEqual(readSharedControl(dir), {
      provider: 'mimo',
      activeProfileId: 'vp_local',
      presetVoiceId: '',
      customVoiceId: '',
    })
  })
})

test('sharedControl.enabled=false keeps local config and does not publish', async () => {
  await withDir(async (dir) => {
    await writeSharedControl(dir, {
      provider: 'deepseek',
      activeProfileId: 'vp_shared',
      presetVoiceId: 'stella',
      customVoiceId: '',
    })
    const service = new TtsService({
      config: config({
        provider: 'mimo',
        activeProfileId: 'vp_local',
        presetVoiceId: '苏打',
        sharedControl: { enabled: false },
      }),
      logger: logger(),
      stateDir: dir,
      env: {},
      home: dir,
      tmp: dir,
    })
    assert.equal(service.snapshot().provider, 'mimo')
    assert.equal(service.snapshot().activeProfileId, 'vp_local')
    await service.publishSharedControl()
    assert.equal(readSharedControl(dir).provider, 'deepseek')
  })
})
