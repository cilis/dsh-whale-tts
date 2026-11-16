/**
 * Cross-profile voice control.
 *
 * Desktop and qqbot are separate DSH profiles: each has its own plugin config
 * (output dir, limits, keys, fallback), but the voice choice should be one
 * decision. This file is the single writer/reader of a tiny JSON document under
 * the shared plugin state directory:
 *
 *   <DSH_HOME>/whale-tts/shared-control.json
 *
 * It contains only the provider + voice pointer. Output paths, credentials and
 * limits stay local to each profile. `TtsService.snapshot()` overlays these
 * fields on every operation, so a switch in one profile takes effect in the
 * other without a restart.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { LoggerLike } from '../types.js'

/** File name under the plugin state directory. */
export const SHARED_CONTROL_FILE = 'shared-control.json'

/** The fields shared by every profile. */
export interface SharedVoiceControl {
  readonly provider?: string
  readonly activeProfileId?: string
  readonly presetVoiceId?: string
  readonly customVoiceId?: string
}

/** On-disk document; `version` allows a future migration. */
export interface SharedControlDocument extends SharedVoiceControl {
  readonly version: 1
  readonly updatedAt: string
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parse(value: unknown): SharedVoiceControl | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const provider = optionalText(record.provider)?.trim()
  if (provider === undefined || provider === '') return undefined
  const activeProfileId = optionalText(record.activeProfileId)
  const presetVoiceId = optionalText(record.presetVoiceId)
  const customVoiceId = optionalText(record.customVoiceId)
  return {
    provider,
    ...(activeProfileId === undefined ? {} : { activeProfileId }),
    ...(presetVoiceId === undefined ? {} : { presetVoiceId }),
    ...(customVoiceId === undefined ? {} : { customVoiceId }),
  }
}

/** Synchronous read used by the hot path (`snapshot()` is synchronous). */
export function readSharedControl(dir: string, logger?: LoggerLike): SharedVoiceControl | undefined {
  const file = join(dir, SHARED_CONTROL_FILE)
  try {
    return parse(JSON.parse(readFileSync(file, 'utf8')) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    logger?.warn('[whale-tts] ignored unreadable %s: %s', SHARED_CONTROL_FILE, (error as Error).message)
    return undefined
  }
}

/** Atomic write of the shared document. */
export async function writeSharedControl(
  dir: string,
  value: SharedVoiceControl,
): Promise<void> {
  const file = join(dir, SHARED_CONTROL_FILE)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const document: SharedControlDocument = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...value,
  }
  try {
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
