/**
 * Read-aloud action for finalized assistant messages.
 *
 * The button lives in `conversation.chat.assistant-actions`; playback is a
 * module-level singleton so two messages never talk over each other. Synthesis
 * reuses the settings-card RPC (`preview` + `audio/read`), which in turn uses
 * the active voice profile.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from './rpc.js'
import type {
  AudioPayload,
  PreviewPayload,
  ReadAloudConfigPayload,
  ReadAloudPreparePayload,
} from './wire.js'

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
      <PauseIcon />
    ) : phase === 'error' ? (
      <ErrorIcon />
    ) : (
      <SpeakerIcon paused={phase === 'paused'} />
    )

  return (
    <button
      type="button"
      className="wtts-read"
      data-state={phase}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

function SpeakerIcon({ paused }: { readonly paused: boolean }): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9.5h3.2L12 5.5v13l-4.8-4H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {paused ? (
        <path d="M15.5 9.5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        <>
          <path d="M15.5 9c.9.8 1.4 1.8 1.4 3s-.5 2.2-1.4 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M18 7c1.5 1.3 2.3 3 2.3 5s-.8 3.7-2.3 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}

function PauseIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="7" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" />
    </svg>
  )
}

function ErrorIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4.8 21 19.5H3L12 4.8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 9.5v4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="16.6" r="0.9" fill="currentColor" />
    </svg>
  )
}
