#!/usr/bin/env node
/**
 * Write a plugin-format backup of the voice store (same document the settings
 * card produces) without needing the DSH host to be running.
 *
 * Usage:
 *   node scripts/backup-state.mjs [--dir <state-dir>] [--out-dir <dir>] [--out <file>]
 *
 * Defaults: state dir from DSH_HOME (or ~/.dsh)/whale-tts, output next to it in
 * `backups/`. The document contains profile metadata, samples and design
 * candidates (base64) but never credential values.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { VoiceStore } from '../lib/core/voices.js'

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1]
  return fallback
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const stateDir = resolve(argument('dir', join(dshHome, 'whale-tts')))
const store = new VoiceStore({ dir: stateDir })
await store.init()

const data = await store.exportData()
const createdAt = new Date().toISOString()
const stamp = createdAt
  .slice(0, 19)
  .replace(/[-:T]/g, '')
  .replace(/(\d{8})(\d{6})/, '$1-$2')
const document = {
  format: 'dsh-whale-tts-backup',
  version: 1,
  createdAt,
  app: 'dsh-whale-tts',
  activeProfileId: data.activeProfileId,
  profiles: data.profiles,
  samples: data.samples,
  candidates: data.candidates,
}

const explicitOut = argument('out', '')
const outDir = resolve(argument('out-dir', join(stateDir, 'backups')))
const target = explicitOut !== '' ? resolve(explicitOut) : join(outDir, `whale-tts-backup-${stamp}.json`)
await mkdir(join(target, '..'), { recursive: true }).catch(() => undefined)
const raw = `${JSON.stringify(document, null, 2)}\n`
await writeFile(target, raw, 'utf8')

const sampleBytes = data.samples.reduce((sum, sample) => sum + Buffer.byteLength(sample.base64, 'base64'), 0)
const candidateBytes = data.candidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.base64, 'base64'), 0)
console.log(
  JSON.stringify(
    {
      path: target,
      bytes: Buffer.byteLength(raw),
      profiles: data.profiles.length,
      samples: data.samples.length,
      sampleBytes,
      candidates: data.candidates.length,
      candidateBytes,
      activeProfileId: data.activeProfileId,
    },
    null,
    2,
  ),
)
