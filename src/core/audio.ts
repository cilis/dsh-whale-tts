/**
 * Audio validation, naming and atomic output.
 */
import { randomBytes } from 'node:crypto'
import { access, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, extname, join, sep } from 'node:path'
import { TtsError, type AudioFormat } from '../types.js'

/**
 * Detect the container from its magic bytes.
 *
 * @param data - audio payload.
 * @returns `wav` for RIFF/WAVE, `mp3` for ID3 or a raw MPEG frame header,
 *          or `undefined` when the payload is not recognisable audio.
 */
export function detectAudioFormat(data: Uint8Array): AudioFormat | undefined {
  if (data.length < 4) return undefined
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data.length >= 12 &&
    data[8] === 0x57 &&
    data[9] === 0x41 &&
    data[10] === 0x56 &&
    data[11] === 0x45
  ) {
    return 'wav'
  }
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return 'mp3'
  // Raw MPEG audio frame sync: 11 set bits.
  if (data[0] === 0xff && (data[1] ?? 0) >= 0xe0) return 'mp3'
  return undefined
}

/**
 * Validate that the payload looks like the requested format.
 *
 * @param data - audio payload.
 * @param expected - format the provider was asked for.
 * @param provider - provider id, for the error message.
 * @returns the validated format.
 */
export function validateAudio(
  data: Uint8Array,
  expected: AudioFormat,
  provider?: string,
): AudioFormat {
  if (!(data instanceof Uint8Array) || data.length === 0) {
    throw new TtsError('provider', 'provider returned an empty audio payload', { provider })
  }
  const detected = detectAudioFormat(data)
  if (detected === undefined) {
    throw new TtsError(
      'provider',
      `provider returned data that is neither wav nor mp3 (${data.length} bytes)`,
      { provider, detail: { bytes: data.length } },
    )
  }
  if (detected !== expected) {
    throw new TtsError(
      'provider',
      `provider returned ${detected} audio but ${expected} was requested`,
      { provider, detail: { detected, expected } },
    )
  }
  return detected
}

/** Options for {@link buildFilename}. */
export interface FilenameOptions {
  /** Template from Config; supports `{timestamp}` and `{rand}`. */
  readonly template: string
  /** Output format, appended as the extension. */
  readonly format: AudioFormat
  /** Clock override for tests. */
  readonly now?: Date
  /** Random-token override for tests. */
  readonly random?: string
}

/** Format a date as `YYYYMMDD-HHmmss` in local time. */
export function timestampToken(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * Build a safe ASCII file name (no path separators) from the template.
 *
 * Empty or fully-sanitised-away templates fall back to `tts-{timestamp}-{rand}`.
 */
export function buildFilename(options: FilenameOptions): string {
  const now = options.now ?? new Date()
  const random = options.random ?? randomBytes(3).toString('hex')
  let name = (options.template ?? '').trim()
  if (name === '') name = 'tts-{timestamp}-{rand}'
  name = name
    .replace(/\{timestamp\}/g, timestampToken(now))
    .replace(/\{rand\}/g, random)
    .replace(/\{date\}/g, timestampToken(now).slice(0, 8))
  const extension = extname(name).toLowerCase()
  if (extension === '.wav' || extension === '.mp3') {
    name = name.slice(0, -extension.length)
  }
  const safe = name
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 120)
  const base = safe === '' ? `tts-${timestampToken(now)}-${random}` : safe
  return `${base}.${options.format}`
}

/** Absolute path of a file inside a directory, rejecting directory escapes. */
export function joinInside(directory: string, fileName: string): string {
  const safeName = basename(fileName)
  if (safeName !== fileName || safeName.includes('..')) {
    throw new TtsError('validation', `invalid file name "${fileName}"`)
  }
  return join(directory, safeName)
}

/** Whether a path exists. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Write audio bytes atomically: write a `.tmp` sibling, then rename.
 *
 * @param directory - output directory (created when missing).
 * @param fileName - target file name.
 * @param data - bytes to write.
 * @param overwrite - whether an existing file may be replaced.
 * @returns absolute path of the written file.
 */
export async function writeAudioFile(
  directory: string,
  fileName: string,
  data: Uint8Array,
  overwrite = false,
): Promise<string> {
  await mkdir(directory, { recursive: true })
  const target = joinInside(directory, fileName)
  if (!overwrite && (await pathExists(target))) {
    throw new TtsError('config', `output file already exists: ${fileName}`, {
      detail: { file: fileName },
    })
  }
  const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, data)
    await rename(temporary, target)
    return target
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** File size in bytes, or 0 when missing. */
export async function fileBytes(target: string): Promise<number> {
  try {
    const info = await stat(target)
    return info.size
  } catch {
    return 0
  }
}

/** Split an absolute path into `{ dir, file }` (helper for tool results). */
export function splitPath(absolute: string): { dir: string; file: string } {
  const index = absolute.lastIndexOf(sep)
  return index === -1
    ? { dir: '', file: absolute }
    : { dir: absolute.slice(0, index), file: absolute.slice(index + 1) }
}

/** Open a file handle for streaming (used by the preview route). */
export async function readFileBytes(target: string): Promise<Uint8Array> {
  const handle = await open(target, 'r')
  try {
    const info = await handle.stat()
    const buffer = Buffer.alloc(info.size)
    await handle.read(buffer, 0, info.size, 0)
    return buffer
  } finally {
    await handle.close()
  }
}
