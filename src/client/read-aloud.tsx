/**
 * Read-aloud action for finalized assistant messages.
 *
 * The button lives in `conversation.chat.assistant-actions`; playback is a
 * module-level singleton so two messages never talk over each other. Synthesis
 * reuses the settings-card RPC (`preview` + `audio/read`), which in turn uses
 * the active voice profile.
 */
import React, { useCallback, useEffect, useState } from 'react'
import type { RpcClient } from './rpc.js'
import type {
  AudioPayload,
  PreviewPayload,
  ReadAloudConfigPayload,
  ReadAloudPreparePayload,
} from './wire.js'

// The Module Loader factory provides `require`; DSH exposes its client
// primitives through it. The declaration keeps the client type check happy
// without depending on Node typings.
declare const require: (id: string) => unknown

/** Structural translate function (the card exports the same shape). */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** Visible state of one message button. */
type Phase = 'idle' | 'preparing' | 'playing' | 'paused' | 'error'

interface Snapshot {
  readonly messageId: string | null
  readonly phase: Phase
  readonly index: number
  readonly total: number
  readonly error?: string
}

/** Page open time: auto mode never reads messages that existed before it. */
const PAGE_OPENED_AT = Date.now()

/** Earliest moment auto mode may speak; moved forward when settings change. */
let autoArmedAt = PAGE_OPENED_AT

let state: Snapshot = { messageId: null, phase: 'idle', index: 0, total: 0 }
const listeners = new Set<() => void>()
const spoken = new Set<string>()
const blocked = new Set<string>()

/** Configured preferences are immutable until the settings card saves. */
let configCache: ReadAloudConfigPayload | null = null
let configPromise: Promise<ReadAloudConfigPayload> | null = null

/** Recently synthesized segments keep repeated playback instant. */
const SEGMENT_CACHE_LIMIT = 60
const segmentCache = new Map<string, string>()

/** One shared audio element; the generation counter invalidates stale callbacks. */
let audio: HTMLAudioElement | null = null
let generation = 0
let active: {
  readonly messageId: string
  readonly segments: readonly string[]
  readonly rate: number
  readonly rpc: RpcClient
} | null = null

/** Broadcast the singleton state to every mounted button. */
function emit(next: Snapshot): void {
  state = next
  for (const listener of listeners) listener()
}

/** Subscribe to singleton state changes. */
export function subscribeReadAloud(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Latest singleton state. */
export function readAloudSnapshot(): Snapshot {
  return state
}

/** Settings changed: re-read the config and only auto-read newer messages. */
export function invalidateReadAloudConfig(): void {
  configCache = null
  configPromise = null
  autoArmedAt = Date.now()
}

/** Read the (cached) read-aloud preferences. */
async function readAloudConfig(rpc: RpcClient): Promise<ReadAloudConfigPayload> {
  if (configCache !== null) return configCache
  if (configPromise === null) {
    configPromise = rpc
      .call<ReadAloudConfigPayload>('read-aloud/config')
      .then((value) => {
        configCache = value
        return value
      })
      .finally(() => {
        configPromise = null
      })
  }
  return configPromise
}

/** Shared audio element, created on first use. */
function audioElement(): HTMLAudioElement {
  if (audio === null) {
    audio = new Audio()
    audio.preload = 'auto'
  }
  return audio
}

/** Remember one synthesized segment, dropping the oldest entries. */
function rememberSegment(key: string, url: string): void {
  segmentCache.set(key, url)
  while (segmentCache.size > SEGMENT_CACHE_LIMIT) {
    const oldest = segmentCache.keys().next().value
    if (oldest === undefined) break
    segmentCache.delete(oldest)
  }
}

/** Synthesize one segment or reuse its cached data URL. */
async function segmentUrl(
  rpc: RpcClient,
  messageId: string,
  segments: readonly string[],
  index: number,
): Promise<string> {
  const key = `${messageId}|${String(index)}`
  const cached = segmentCache.get(key)
  if (cached !== undefined) {
    segmentCache.delete(key)
    segmentCache.set(key, cached)
    return cached
  }
  const preview = await rpc.call<PreviewPayload>('preview', { text: segments[index] })
  const audioPayload = await rpc.call<AudioPayload>('audio/read', {
    kind: 'preview',
    file: preview.file,
  })
  const url = `data:${audioPayload.mime};base64,${audioPayload.base64}`
  rememberSegment(key, url)
  return url
}

/** Stop whatever is playing. */
export function stopReadAloud(): void {
  generation += 1
  active = null
  if (audio !== null) {
    audio.onended = null
    audio.onerror = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
  emit({ messageId: null, phase: 'idle', index: 0, total: 0 })
}

/** Surface one failure on the owning button. */
function fail(gen: number, messageId: string, error: unknown): void {
  if (gen !== generation) return
  active = null
  const text = error instanceof Error ? error.message : String(error)
  emit({ messageId, phase: 'error', index: 0, total: 0, error: text })
}

/** Play segment `index` of the active message. */
async function playIndex(index: number, gen: number): Promise<void> {
  const current = active
  if (current === null || gen !== generation) return
  if (index >= current.segments.length) {
    stopReadAloud()
    return
  }
  emit({
    messageId: current.messageId,
    phase: 'playing',
    index,
    total: current.segments.length,
  })
  let url: string
  try {
    url = await segmentUrl(current.rpc, current.messageId, current.segments, index)
  } catch (error) {
    fail(gen, current.messageId, error)
    return
  }
  if (gen !== generation) return
  const element = audioElement()
  element.onended = () => {
    if (gen === generation) void playIndex(index + 1, gen)
  }
  element.onerror = () => fail(gen, current.messageId, new Error('audio playback failed'))
  element.src = url
  element.playbackRate = current.rate
  try {
    await element.play()
  } catch (error) {
    if (gen !== generation) return
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      blocked.add(current.messageId)
      active = null
      emit({ messageId: null, phase: 'idle', index: 0, total: 0 })
      return
    }
    fail(gen, current.messageId, error)
    return
  }
  // Warm the next segment while this one plays.
  if (index + 1 < current.segments.length) {
    void segmentUrl(current.rpc, current.messageId, current.segments, index + 1).catch(() => undefined)
  }
}

/** Fetch, prepare and start reading one message. */
async function startPlayback(
  rpc: RpcClient,
  sessionId: string,
  messageId: string,
  prepared?: ReadAloudPreparePayload | null,
): Promise<void> {
  const gen = generation + 1
  generation = gen
  active = null
  emit({ messageId, phase: 'preparing', index: 0, total: 0 })
  let payload: ReadAloudPreparePayload | null
  try {
    payload =
      prepared === undefined
        ? await rpc.call<ReadAloudPreparePayload | null>('read-aloud/prepare', {
            sessionId,
            messageId,
          })
        : prepared
  } catch (error) {
    fail(gen, messageId, error)
    return
  }
  if (gen !== generation) return
  if (payload === null || payload.segments.length === 0) {
    emit({ messageId, phase: 'error', index: 0, total: 0, error: 'no text to read' })
    return
  }
  active = { messageId, segments: payload.segments, rate: payload.rate, rpc }
  spoken.add(messageId)
  await playIndex(0, gen)
}

/** Toggle playback for one message (start, pause, resume, retry). */
export function toggleReadAloud(rpc: RpcClient, sessionId: string, messageId: string): void {
  if (state.messageId === messageId) {
    const element = audioElement()
    if (state.phase === 'playing') {
      element.pause()
      emit({ ...state, phase: 'paused' })
      return
    }
    if (state.phase === 'paused') {
      element
        .play()
        .then(() => emit({ ...state, phase: 'playing' }))
        .catch((error: unknown) => {
          fail(generation, messageId, error)
        })
      return
    }
    if (state.phase === 'preparing') return
  }
  stopReadAloud()
  void startPlayback(rpc, sessionId, messageId)
}

/** Start playback only when auto mode still considers this message new. */
async function maybeAutoPlay(
  rpc: RpcClient,
  sessionId: string,
  messageId: string,
): Promise<void> {
  // Initial chat render mounts every historical message at once; those must not
  // be read. New messages mount later and pass this gate.
  if (Date.now() - PAGE_OPENED_AT < 1200) return
  if (spoken.has(messageId) || blocked.has(messageId)) return
  let config: ReadAloudConfigPayload
  try {
    config = await readAloudConfig(rpc)
  } catch {
    return
  }
  if (!config.auto) return
  let prepared: ReadAloudPreparePayload | null
  try {
    prepared = await rpc.call<ReadAloudPreparePayload | null>('read-aloud/prepare', {
      sessionId,
      messageId,
    })
  } catch {
    return
  }
  if (prepared === null || !prepared.final || prepared.time <= autoArmedAt) return
  if (spoken.has(messageId)) return
  spoken.add(messageId)
  if (state.messageId !== null) stopReadAloud()
  await startPlayback(rpc, sessionId, messageId, prepared)
}

/** One action-row button. */
export function ReadAloudAction({
  sessionId,
  messageId,
  rpc,
  t,
}: {
  readonly sessionId: string
  readonly messageId: string
  readonly rpc: RpcClient
  readonly t: Translate
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<Snapshot>(state)
  useEffect(() => {
    setSnapshot(state)
    return subscribeReadAloud(() => setSnapshot(state))
  }, [])

  const phase: Phase = snapshot.messageId === messageId ? snapshot.phase : 'idle'
  const label =
    phase === 'playing'
      ? t('speakPause')
      : phase === 'paused'
        ? t('speakResume')
        : phase === 'preparing'
          ? t('speakPreparing')
          : phase === 'error'
            ? (snapshot.error ?? t('speakFailed'))
            : t('speakStart')

  useEffect(() => {
    void maybeAutoPlay(rpc, sessionId, messageId)
  }, [rpc, sessionId, messageId])

  useEffect(
    () => () => {
      if (state.messageId === messageId) stopReadAloud()
    },
    [messageId],
  )

  const onClick = useCallback(() => {
    toggleReadAloud(rpc, sessionId, messageId)
  }, [rpc, sessionId, messageId])

  const icon =
    phase === 'preparing' ? (
      <span className="wtts-read-spin" aria-hidden="true" />
    ) : phase === 'playing' ? (
      <ReadAloudIcon kind="pause" />
    ) : phase === 'error' ? (
      <ReadAloudIcon kind="warning" />
    ) : (
      <ReadAloudIcon kind="play" />
    )

  return (
    <button
      type="button"
      className="wtts-read"
      data-state={phase}
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        padding: 0,
        border: 0,
        borderRadius: 999,
        background: 'transparent',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        cursor: 'pointer',
        color:
          phase === 'playing'
            ? 'var(--dsw-alias-brand-primary, #4f8cff)'
            : phase === 'error'
              ? 'var(--dsw-alias-state-error-primary, #d64545)'
              : 'inherit',
      }}
    >
      {icon}
    </button>
  )
}

/** One DSH built-in icon component (props are a subset of its real contract). */
type BuiltinIcon = React.ComponentType<{ size?: number }>

interface BuiltinIcons {
  readonly play?: BuiltinIcon
  readonly pause?: BuiltinIcon
  readonly warning?: BuiltinIcon
}

let builtinIconsCache: BuiltinIcons | null = null

/**
 * Resolve DSH's own action-row icons through the Module Loader require.
 *
 * A missing or older primitives module must not break the slot, so failures
 * fall back to the inline glyphs below. The lookup is cached for the page.
 */
function builtinIcons(): BuiltinIcons {
  if (builtinIconsCache !== null) return builtinIconsCache
  const result: BuiltinIcons = {}
  try {
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as
      | Record<string, unknown>
      | undefined
    const pick = (name: string): BuiltinIcon | undefined => {
      const candidate = primitives?.[name]
      return typeof candidate === 'function' ||
        (typeof candidate === 'object' && candidate !== null)
        ? (candidate as BuiltinIcon)
        : undefined
    }
    Object.assign(result, {
      play: pick('IconPlayOutlineRegular'),
      pause: pick('IconPauseOutlineRegular'),
      warning: pick('IconWarningOutlineRegular'),
    })
  } catch {
    // Headless smoke or an older DSH: use the fallback glyphs.
  }
  builtinIconsCache = result
  return result
}

/** Action icon: DSH's own play/pause/warning, with an inline fallback. */
function ReadAloudIcon({
  kind,
}: {
  readonly kind: 'play' | 'pause' | 'warning'
}): React.ReactElement {
  const icons = builtinIcons()
  const Builtin = kind === 'play' ? icons.play : kind === 'pause' ? icons.pause : icons.warning
  if (Builtin !== undefined) {
    return React.createElement(Builtin, { size: 16 })
  }
  if (kind === 'play') return <PlayGlyph />
  if (kind === 'pause') return <PauseGlyph />
  return <WarningGlyph />
}

function PlayGlyph(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 5.5 19 12 8.5 18.5V5.5Z" />
    </svg>
  )
}

function PauseGlyph(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="7.5" y="6" width="3" height="12" rx="1.4" />
      <rect x="13.5" y="6" width="3" height="12" rx="1.4" />
    </svg>
  )
}

function WarningGlyph(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5 21 19.5H3L12 5Z" />
      <path d="M12 9.5v4.2" />
      <path d="M12 16.8v.1" />
    </svg>
  )
}
