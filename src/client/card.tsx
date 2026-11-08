/**
 * The settings card rendered on the plugin's page in the DSH Plugins sidebar.
 *
 * The card talks to the host half exclusively through the connection RPC
 * channel; it never sees a secret value and never resolves credentials itself.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { RpcClient, RpcError, REMOTE_CODES } from './rpc.js'
import { CardHeader, EmptyState, FileDropzone, StatusBar, Tabs, WhaleMark } from './ui.js'
import { invalidateReadAloudConfig } from './read-aloud.js'
import type {
  AudioPayload,
  Candidate,
  ConfigOp,
  ConfigPayload,
  ConfigSnapshot,
  KeyInfo,
  PreviewPayload,
  Profile,
  ProviderVoiceList,
  SamplePayload,
  StatusPayload,
  TestResult,
  BackupFileInfo,
  BackupImportResult,
} from './wire.js'

/** Locale reader injected by the slot. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Props the slot owner plus this plugin's `inject` face provide. */
export interface CardProps {
  readonly view?: 'page' | 'summary'
  readonly t?: Translate
  readonly rpc?: RpcClient
}

/** Editable draft of the config fields the card commits. */
interface Draft {
  presetVoiceId: string
  customVoiceId: string
  designDescription: string
  designCandidateCount: number
  sampleText: string
  previewText: string
  outputDir: string
  maxChars: number
  baseURLOverride: string
  profileName: string
  cloneSampleFile: string
  readAloudAuto: boolean
  readAloudSkipCode: boolean
  readAloudSegmentChars: number
  readAloudRate: number
}

const EMPTY_DRAFT: Draft = {
  presetVoiceId: '',
  customVoiceId: '',
  designDescription: '',
  designCandidateCount: 3,
  sampleText: '',
  previewText: '',
  outputDir: '',
  maxChars: 2000,
  baseURLOverride: '',
  profileName: '',
  cloneSampleFile: '',
  readAloudAuto: false,
  readAloudSkipCode: true,
  readAloudSegmentChars: 600,
  readAloudRate: 1,
}

/** Default credential references per provider. */
const DEFAULT_REFS: Record<string, string> = {
  mimo: 'MIMO_API_KEY',
  siliconflow: 'SILICONFLOW_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
}

const style: Record<string, CSSProperties> = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    fontSize: 13,
    lineHeight: 1.5,
  },
  section: {
    border: '1px solid var(--dsh-border-color, rgba(127,127,127,0.28))',
    borderRadius: 10,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionTitle: { fontWeight: 600, fontSize: 13, marginBottom: 2 },
  // One row = one label/control pair; every control is the same height so rows
  // line up even when they mix inputs, selects and buttons.
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    minHeight: 32,
    marginBottom: 0,
  },
  label: {
    minWidth: 96,
    color: 'var(--dsw-alias-label-secondary, var(--dsh-text-secondary, #6b7280))',
    fontSize: 12,
    lineHeight: '32px',
  },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  radioGroup: { display: 'flex', alignItems: 'center', gap: 18, minHeight: 28 },
  radioLabel: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
  hint: {
    color: 'var(--dsw-alias-label-tertiary, var(--dsh-text-secondary, #6b7280))',
    fontSize: 12,
    lineHeight: '18px',
    marginLeft: 104,
  },
  input: {
    boxSizing: 'border-box',
    height: 32,
    padding: '0 10px',
    borderRadius: 8,
    border: '0.5px solid var(--dsw-alias-border-l2, var(--dsh-border-color, rgba(127,127,127,0.4)))',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 13,
    lineHeight: '32px',
    minWidth: 160,
  },
  textarea: {
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: 8,
    border: '0.5px solid var(--dsw-alias-border-l2, var(--dsh-border-color, rgba(127,127,127,0.4)))',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 13,
    width: '100%',
    minHeight: 60,
    resize: 'vertical',
  },
  button: {
    boxSizing: 'border-box',
    height: 32,
    padding: '0 12px',
    borderRadius: 8,
    border: '0.5px solid var(--dsw-alias-border-l2, var(--dsh-border-color, rgba(127,127,127,0.4)))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 13,
    lineHeight: '30px',
    whiteSpace: 'nowrap',
  },
  primary: {
    boxSizing: 'border-box',
    height: 32,
    padding: '0 12px',
    borderRadius: 8,
    border: '0.5px solid transparent',
    background: 'var(--dsw-alias-button-primary-fill, var(--dsh-accent-color, #4f8cff))',
    color: 'var(--dsw-alias-label-primary-foreground, #fff)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 13,
    lineHeight: '30px',
    whiteSpace: 'nowrap',
  },
  danger: {
    boxSizing: 'border-box',
    height: 32,
    padding: '0 12px',
    borderRadius: 8,
    border: '0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 35%, transparent)',
    background: 'transparent',
    color: 'var(--dsw-alias-state-error-primary, var(--dsh-danger-color, #d64545))',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 13,
    lineHeight: '30px',
    whiteSpace: 'nowrap',
  },
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  listRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    padding: '6px 8px',
    borderRadius: 6,
    background: 'var(--dsh-fill-color, rgba(127,127,127,0.06))',
  },
  muted: { color: 'var(--dsw-alias-label-secondary, var(--dsh-text-secondary, #6b7280))' },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 20,
    fontSize: 11,
    padding: '0 8px',
    borderRadius: 999,
    lineHeight: '18px',
    border: '0.5px solid var(--dsw-alias-border-l1, transparent)',
    background: 'var(--dsw-alias-bg-layer-2, var(--dsh-fill-color, rgba(127,127,127,0.12)))',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    whiteSpace: 'nowrap',
  },
  notice: { borderRadius: 6, padding: '4px 10px', lineHeight: '20px' },
  errorNotice: {
    borderRadius: 6,
    padding: '4px 10px',
    lineHeight: '20px',
    color: 'var(--dsh-danger-color, #d64545)',
    background: 'rgba(214,69,69,0.08)',
  },
  successNotice: {
    borderRadius: 6,
    padding: '4px 10px',
    lineHeight: '20px',
    color: 'var(--dsh-success-color, #2e8b57)',
    background: 'rgba(46,139,87,0.08)',
  },
}

/** Format bytes for display. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** Read a File as base64 (without the data URL prefix). */
function readFileBase64(file: File): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader()
    reader.onerror = () => rejectPromise(reader.error ?? new Error('failed to read file'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolvePromise(comma === -1 ? result : result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

/** Extract the config fields the card keeps as an editable draft. */
function pickDraft(config: ConfigSnapshot): Draft {
  return {
    presetVoiceId: config.presetVoiceId ?? '',
    customVoiceId: config.customVoiceId ?? '',
    designDescription: config.designDescription ?? '',
    designCandidateCount: config.designCandidateCount ?? 3,
    sampleText: config.sampleText ?? '',
    previewText: config.previewText ?? '',
    outputDir: config.output?.dir ?? '',
    maxChars: config.limits?.maxChars ?? 2000,
    baseURLOverride: config.baseURLOverride ?? '',
    profileName: '',
    cloneSampleFile: '',
    readAloudAuto: config.readAloud?.auto ?? false,
    readAloudSkipCode: config.readAloud?.skipCode ?? true,
    readAloudSegmentChars: config.readAloud?.segmentChars ?? 600,
    readAloudRate: config.readAloud?.rate ?? 1,
  }
}

/** Map a thrown error to a user-facing message. */
function errorText(error: unknown, t: Translate): string {
  if (error instanceof RpcError) {
    if (error.code === REMOTE_CODES.conflict) return t('revisionConflict')
    if (error.code === REMOTE_CODES.keyMissing) return error.message
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** Remove a trailing slash so relative paths stay clean. */
function trimTrailingSlash(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

/** Build the card. */
export function TtsCard(props: CardProps): ReactNode {
  const t: Translate = props.t ?? ((key) => key)
  if (props.view === 'summary') return <span style={style.muted}>{t('summary')}</span>
  return <TtsSettings t={t} rpc={props.rpc} />
}

/** The page view with all hooks. */
function TtsSettings({ t, rpc }: { t: Translate; rpc?: RpcClient }): ReactNode {
  const [loading, setLoading] = useState(true)
  const [payload, setPayload] = useState<StatusPayload | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [providers, setProviders] = useState<ProviderVoiceList[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error' | 'success'; text: string } | null>(
    null,
  )
  const [audio, setAudio] = useState<{ url: string; label: string } | null>(null)
  const [test, setTest] = useState<TestResult | null>(null)
  const [keyValue, setKeyValue] = useState('')
  // Clearing a key is destructive, so it needs a second click in manual mode.
  // In reuse mode the button is disabled: the credential belongs to DSH.
  const [confirmClearKey, setConfirmClearKey] = useState(false)
  const [pendingSample, setPendingSample] = useState<SamplePayload | null>(null)
  // Inline rename/deletion editors. Electron implements neither `prompt()` nor
  // `confirm()`, so the card must not rely on browser dialogs.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // Per-profile style instruction editor (tone/emotion/pace carried over from a
  // design prompt; used as the provider `user` message whenever the profile is
  // active).
  const [styling, setStyling] = useState<{ id: string; value: string } | null>(null)
  // Presentational tab; switching never unmounts a form (CSS hides panels).
  const [tab, setTab] = useState<'voices' | 'interface' | 'backup'>('voices')
  // Backup & restore.
  const [backups, setBackups] = useState<BackupFileInfo[]>([])
  const [backupMode, setBackupMode] = useState<'merge' | 'replace'>('merge')
  const [backupPath, setBackupPath] = useState('')
  const [backupSummary, setBackupSummary] = useState<string | null>(null)

  const call = useCallback(
    async <T,>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> => {
      if (rpc === undefined) throw new Error(t('unavailable'))
      return rpc.call<T>(endpoint, body)
    },
    [rpc, t],
  )

  const applyConfig = useCallback((next: ConfigPayload) => {
    setPayload((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            config: next.config,
            revision: next.revision,
            writable: next.writable,
          },
    )
    setDraft((previous) => ({ ...previous, ...pickDraft(next.config) }))
  }, [])

  const refresh = useCallback(async () => {
    if (rpc === undefined) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [statusPayload, profileRows, candidateRows, providerRows, backupRows] =
        await Promise.all([
          call<StatusPayload>('status'),
          call<Profile[]>('profiles/list'),
          call<Candidate[]>('design/list'),
          call<ProviderVoiceList[]>('providers/list'),
          call<BackupFileInfo[]>('backup/list'),
        ])
      setPayload(statusPayload)
      setProfiles(profileRows ?? [])
      setCandidates(candidateRows ?? [])
      setProviders(providerRows ?? [])
      setBackups(backupRows ?? [])
      setDraft((previous) => ({ ...previous, ...pickDraft(statusPayload.config) }))
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error, t) })
    } finally {
      setLoading(false)
    }
  }, [call, rpc, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A green/red connection result belongs to the settings it was produced
  // with. Any provider/key/base-URL/voice change invalidates it.
  useEffect(() => {
    setTest(null)
  }, [
    payload?.config.provider,
    payload?.config.apiKeyEnv,
    payload?.config.keySource,
    payload?.config.baseURLOverride,
    payload?.config.keyType,
    keyValue,
    draft.presetVoiceId,
    draft.customVoiceId,
  ])

  const writable = payload?.writable === true

  const writeConfig = useCallback(
    async (operations: ConfigOp[], successText?: string) => {
      if (payload === null) return
      if (!writable) {
        setNotice({ tone: 'error', text: t('readOnly') })
        return
      }
      setBusy('config')
      try {
        await call('config/mutate', {
          operations,
          expectedRevision: payload.revision,
        })
        const next = await call<ConfigPayload>('config/get')
        applyConfig(next)
        setNotice({ tone: 'success', text: successText ?? t('saved') })
      } catch (error) {
        setNotice({ tone: 'error', text: errorText(error, t) })
        if (error instanceof RpcError && error.code === REMOTE_CODES.conflict) await refresh()
      } finally {
        setBusy(null)
      }
    },
    [applyConfig, call, payload, refresh, t, writable],
  )

  /**
   * Switch the primary provider and move the default voice to that provider's
   * first catalogue entry. Without this a stale MiMo preset id would be sent to
   * SiliconFlow/MiniMax, and a profile created for the previous provider would
   * keep overriding the new provider's voice.
   */
  const changeProvider = useCallback(
    (id: string) => {
      const next = providers.find((provider) => provider.id === id)
      const firstVoice = next?.capabilities.voices[0]?.id
      const operations: ConfigOp[] = [
        { op: 'set', path: ['provider'], value: id },
        { op: 'set', path: ['activeProfileId'], value: '' },
        { op: 'set', path: ['customVoiceId'], value: '' },
        { op: 'set', path: ['apiKeyEnv'], value: '' },
        { op: 'set', path: ['baseURLOverride'], value: '' },
        { op: 'set', path: ['keyType'], value: 'auto' },
      ]
      if (firstVoice !== undefined && firstVoice !== '') {
        operations.push({ op: 'set', path: ['presetVoiceId'], value: firstVoice })
      }
      // Clearing `activeProfileId` only empties the config override; the voice
      // store keeps its own pointer and would otherwise keep using a MiMo clone
      // on SiliconFlow/MiniMax. Deactivate it explicitly as well.
      void (async () => {
        await call('profiles/activate', { id: null }).catch(() => undefined)
        await writeConfig(operations)
        await refresh()
      })()
    },
    [call, providers, refresh, writeConfig],
  )

  /** Persist one read-aloud preference and drop the action cell's config cache. */
  const writeReadAloud = useCallback(
    async (path: readonly string[], value: unknown) => {
      await writeConfig([{ op: 'set', path: ['readAloud', ...path], value } as ConfigOp])
      invalidateReadAloudConfig()
    },
    [writeConfig],
  )

  const run = useCallback(
    async (label: string, action: () => Promise<void>, successText?: string) => {
      setBusy(label)
      try {
        await action()
        if (successText !== undefined) setNotice({ tone: 'success', text: successText })
      } catch (error) {
        setNotice({ tone: 'error', text: errorText(error, t) })
      } finally {
        setBusy(null)
      }
    },
    [t],
  )

  const playAudio = useCallback(
    async (kind: 'preview' | 'sample' | 'design', file: string) => {
      const result = await call<AudioPayload>('audio/read', { kind, file })
      setAudio({ url: `data:${result.mime};base64,${result.base64}`, label: file })
    },
    [call],
  )

  const previewVoice = useCallback(async () => {
    await run(
      'preview',
      async () => {
        const result = await call<PreviewPayload>('preview', { text: draft.previewText })
        await playAudio('preview', result.file)
      },
      t('previewReady'),
    )
  }, [call, draft.previewText, playAudio, run, t])

  /**
   * Audition the voice currently selected in the preset editor, without
   * saving a profile or changing the active voice. The host bypasses the
   * active profile for this request (voice override), so the preview matches
   * the dropdown rather than the previously activated profile.
   */
  const previewSelectedVoice = useCallback(async () => {
    const voice =
      draft.customVoiceId.trim() !== '' ? draft.customVoiceId.trim() : draft.presetVoiceId.trim()
    if (voice === '') return
    await run(
      'preview-selected',
      async () => {
        const result = await call<PreviewPayload>('preview', {
          text: draft.previewText,
          voice,
        })
        await playAudio('preview', result.file)
      },
      t('previewReady'),
    )
  }, [call, draft.customVoiceId, draft.presetVoiceId, draft.previewText, playAudio, run, t])

  const activateProfile = useCallback(
    async (profile: Profile) => {
      await call('profiles/activate', { id: profile.id })
      if (payload?.config.activeProfileId !== profile.id) {
        await call('config/mutate', {
          operations: [{ op: 'set', path: ['activeProfileId'], value: profile.id }],
          expectedRevision: payload?.revision,
        })
      }
      await refresh()
    },
    [call, payload, refresh],
  )

  const savePresetProfile = useCallback(async () => {
    const voiceId = draft.customVoiceId.trim() !== '' ? draft.customVoiceId.trim() : draft.presetVoiceId
    if (voiceId === '') {
      setNotice({ tone: 'error', text: t('presetVoice') })
      return
    }
    const name = draft.profileName.trim() !== '' ? draft.profileName.trim() : voiceId
    await run('save-profile', async () => {
      const profile = await call<Profile>('profiles/save', {
        profile: { name, kind: 'preset', presetVoiceId: voiceId },
      })
      await activateProfile(profile)
      setDraft((previous) => ({ ...previous, profileName: '' }))
    }, t('profileSaved'))
  }, [activateProfile, call, draft, run, t])

  const generateCandidates = useCallback(async () => {
    if (draft.designDescription.trim() === '') {
      setNotice({ tone: 'error', text: t('designDescription') })
      return
    }
    await run('design', async () => {
      const rows = await call<Candidate[]>('design/candidates', {
        description: draft.designDescription,
        count: draft.designCandidateCount,
        sampleText: draft.sampleText,
      })
      setCandidates(rows ?? [])
    })
  }, [call, draft.designCandidateCount, draft.designDescription, draft.sampleText, run, t])

  const adoptCandidate = useCallback(
    async (candidate: Candidate) => {
      await run('adopt', async () => {
        const name =
          draft.profileName.trim() !== ''
            ? draft.profileName.trim()
            : `${t('designVoiceName')} ${new Date().toLocaleDateString()}`
        const profile = await call<Profile>('design/adopt', {
          candidateId: candidate.id,
          name,
          // The design prompt defines the delivery, not just the timbre; the
          // host stores it as the profile's style instruction.
          description: draft.designDescription,
        })
        await activateProfile(profile)
        setDraft((previous) => ({ ...previous, profileName: '' }))
      }, t('designAdopted'))
    },
    [activateProfile, call, draft.profileName, run, t],
  )

  const discardCandidates = useCallback(async () => {
    await run('discard', async () => {
      await call('design/discard', {})
      setCandidates([])
    })
  }, [call, run])

  const uploadSample = useCallback(
    async (file: File) => {
      const lower = file.name.toLowerCase()
      if (!lower.endsWith('.mp3') && !lower.endsWith('.wav')) {
        setNotice({ tone: 'error', text: t('sampleHint') })
        return
      }
      if (file.size > 10 * 1024 * 1024) {
        setNotice({ tone: 'error', text: t('sampleHint') })
        return
      }
      await run('upload', async () => {
        const base64 = await readFileBase64(file)
        const result = await call<SamplePayload>('samples/upload', {
          filename: file.name,
          mime: file.type === '' ? undefined : file.type,
          base64,
        })
        setPendingSample(result)
        setDraft((previous) => ({ ...previous, cloneSampleFile: result.sampleFile }))
      }, t('sampleUploaded'))
    },
    [call, run, t],
  )

  const saveCloneProfile = useCallback(async () => {
    const sampleFile = draft.cloneSampleFile.trim()
    if (sampleFile === '') {
      setNotice({ tone: 'error', text: t('sampleHint') })
      return
    }
    const name =
      draft.profileName.trim() !== ''
        ? draft.profileName.trim()
        : `${t('kindClone')} ${new Date().toLocaleDateString()}`
    await run('save-clone', async () => {
      const profile = await call<Profile>('profiles/save', {
        profile: {
          name,
          kind: 'clone',
          sampleFile,
          sampleBytes: pendingSample?.sampleBytes,
          sampleMime: pendingSample?.sampleMime,
        },
      })
      await activateProfile(profile)
      setDraft((previous) => ({ ...previous, profileName: '', cloneSampleFile: '' }))
      setPendingSample(null)
    }, t('profileSaved'))
  }, [activateProfile, call, draft, pendingSample, run, t])

  const removeProfile = useCallback((profile: Profile) => {
    setDeletingId(profile.id)
  }, [])

  const confirmRemove = useCallback(
    async (profile: Profile) => {
      await run('remove', async () => {
        await call('profiles/delete', { id: profile.id })
        setDeletingId(null)
        await refresh()
      })
    },
    [call, refresh, run],
  )

  // Rename is an inline editor instead of `window.prompt`: Electron does not
  // implement prompt(), so the old handler silently did nothing there.
  const startRename = useCallback((profile: Profile) => {
    setRenaming({ id: profile.id, value: profile.name })
  }, [])

  const cancelRename = useCallback(() => {
    setRenaming(null)
  }, [])

  const commitRename = useCallback(
    async (profile: Profile) => {
      if (renaming === null || renaming.id !== profile.id) return
      const name = renaming.value.trim()
      if (name === '' || name === profile.name) {
        setRenaming(null)
        return
      }
      await run('rename', async () => {
        await call('profiles/save', { profile: { ...profile, name } })
        setRenaming(null)
        await refresh()
      })
    },
    [call, refresh, renaming, run],
  )

  const duplicateProfile = useCallback(
    async (profile: Profile) => {
      // The host derives "<name> 副本" when no name is given.
      await run('duplicate', async () => {
        await call('profiles/duplicate', { id: profile.id })
        await refresh()
      }, t('profileDuplicated'))
    },
    [call, refresh, run, t],
  )

  const startStyle = useCallback((profile: Profile) => {
    setStyling({ id: profile.id, value: profile.styleInstruction ?? '' })
  }, [])

  const cancelStyle = useCallback(() => {
    setStyling(null)
  }, [])

  const commitStyle = useCallback(
    async (profile: Profile) => {
      if (styling === null || styling.id !== profile.id) return
      const styleInstruction = styling.value.trim()
      await run('style', async () => {
        await call('profiles/save', {
          profile: {
            ...profile,
            // An empty value clears the stored instruction.
            styleInstruction: styleInstruction === '' ? undefined : styleInstruction,
          },
        })
        setStyling(null)
        await refresh()
      }, t('profileSaved'))
    },
    [call, refresh, run, styling, t],
  )

  const saveKey = useCallback(async () => {
    if (payload === null) return
    const ref = payload.config.apiKeyEnv.trim() !== ''
      ? payload.config.apiKeyEnv.trim()
      : (DEFAULT_REFS[payload.config.provider] ?? 'MIMO_API_KEY')
    if (keyValue.trim() === '') return
    await run('key', async () => {
      await call('credentials/set', { ref, value: keyValue })
      setKeyValue('')
      await call('config/mutate', {
        operations: [
          { op: 'set', path: ['apiKeyEnv'], value: ref },
          { op: 'set', path: ['keySource'], value: 'manual' },
        ],
        expectedRevision: payload.revision,
      })
      await refresh()
    }, t('keySaved'))
  }, [call, keyValue, payload, refresh, run, t])

  const clearKey = useCallback(async () => {
    if (payload === null) return
    const ref = payload.config.apiKeyEnv.trim() !== ''
      ? payload.config.apiKeyEnv.trim()
      : (DEFAULT_REFS[payload.config.provider] ?? '')
    if (ref === '') return
    await run('key-clear', async () => {
      await call('credentials/clear', { ref })
      setConfirmClearKey(false)
      await refresh()
    }, t('keyCleared'))
  }, [call, payload, refresh, run, t])

  const testConnection = useCallback(async () => {
    if (payload === null) return
    await run('test', async () => {
      const result = await call<TestResult>('credentials/test', {
        provider: payload.config.provider,
      })
      setTest(result)
    })
  }, [call, payload, run])

  const exportBackup = useCallback(async () => {
    await run('backup-export', async () => {
      const result = await call<BackupFileInfo>('backup/export')
      setBackupSummary(
        t('backupExported', {
          file: result.file,
          size: formatBytes(result.bytes),
          profiles: result.profiles ?? 0,
          candidates: result.candidates ?? 0,
        }),
      )
      const rows = await call<BackupFileInfo[]>('backup/list')
      setBackups(rows ?? [])
    }, t('backupExportDone'))
  }, [call, run, t])

  const importBackup = useCallback(
    async (source: { base64?: string; path?: string }) => {
      await run('backup-import', async () => {
        const result = await call<BackupImportResult>('backup/import', {
          mode: backupMode,
          ...source,
        })
        setBackupSummary(
          t('backupImported', {
            mode: backupMode === 'replace' ? t('backupModeReplace') : t('backupModeMerge'),
            profiles: result.importedProfiles,
            candidates: result.importedCandidates,
            file: result.safetyBackup.file,
          }),
        )
        await refresh()
      }, t('backupImportDone'))
    },
    [backupMode, call, refresh, run, t],
  )

  const importBackupFile = useCallback(
    async (file: File) => {
      const base64 = await fileToBase64(file)
      await importBackup({ base64 })
    },
    [importBackup],
  )

  const activeProvider = payload === null ? undefined : payload.status.providers[payload.config.provider]
  const providerMeta = useMemo(
    () => providers.find((provider) => provider.id === payload?.config.provider),
    [payload?.config.provider, providers],
  )
  const activeProfile = profiles.find((profile) => profile.id === payload?.status.activeProfileId)
  const latestBackup = backups[0]
  const keyCandidates: KeyInfo[] = payload?.keys ?? []
  const canDesign = providerMeta?.capabilities.voiceDesign === true
  const canClone = providerMeta?.capabilities.voiceClone === true
  const presetVoices = providerMeta?.capabilities.voices ?? []
  // Only providers the host marks selectable may be chosen as the primary one.
  const allProviderIds = payload?.providers ?? []
  const providerChoices = allProviderIds.filter(
    (id) => payload?.status.providers[id]?.selectable !== false,
  )
  const activeProviderSelectable =
    payload === null || payload.status.providers[payload.config.provider]?.selectable !== false
  const hiddenProviderCount = allProviderIds.length - providerChoices.length
  const cloneProfiles = profiles.filter((profile) => profile.kind === 'clone')
  // Clearing follows *ownership*, not the mode: only refs this plugin wrote may
  // be deleted. A credential that only DSH owns (shared) is read-only here.
  const keySourceIsReuse = payload?.config.keySource !== 'manual'
  const defaultKeyRef = payload === null ? '' : (DEFAULT_REFS[payload.config.provider] ?? '')
  const effectiveKeyRef =
    payload === null
      ? ''
      : payload.config.apiKeyEnv.trim() !== ''
        ? payload.config.apiKeyEnv.trim()
        : defaultKeyRef
  const selectedKeyRow = payload?.keys?.find((candidate) => candidate.ref === effectiveKeyRef)
  const keyClearable = selectedKeyRow?.owned === true

  if (rpc === undefined) {
    return <StatusBar tone="error">{t('unavailable')}</StatusBar>
  }

  if (loading && payload === null) {
    return (
      <div className="wtts">
        {[0, 1].map((card) => (
          <div key={card} className="wtts-card wtts-skeleton">
            <div className="wtts-skel-line" />
            <div className="wtts-skel-line" />
            <div className="wtts-skel-line" />
          </div>
        ))}
        <span className="wtts-empty">{t('loading')}</span>
      </div>
    )
  }

  const noticeBox =
    notice === null ? null : <StatusBar tone={notice.tone}>{notice.text}</StatusBar>

  return (
    <div className="wtts" data-tab={tab}>
      <div className="wtts-hero">
        <div className="wtts-hero-mark">
          <WhaleMark />
        </div>
        <div className="wtts-hero-main">
          <div className="wtts-hero-title">
            {t('title')}
            {activeProfile === undefined ? null : (
              <span className="wtts-tag wtts-tag-brand">{t(`kind${capitalize(activeProfile.kind)}`)}</span>
            )}
          </div>
          <div className="wtts-hero-sub">{t('heroSubtitle')}</div>
        </div>
        <div className="wtts-chips">
          <span className="wtts-chip">{payload?.config.provider ?? '—'}</span>
          <span className={activeProvider?.keyConfigured === true ? 'wtts-chip wtts-chip-ok' : 'wtts-chip wtts-chip-warn'}>
            {activeProvider?.keyConfigured === true ? t('keyConfigured') : t('keyMissing')}
          </span>
          {activeProfile === undefined ? null : <span className="wtts-chip">{activeProfile.name}</span>}
          <button type="button" className="wtts-btn wtts-btn-ghost" onClick={() => void refresh()} disabled={loading || busy !== null}>
            {loading ? t('loading') : t('reload')}
          </button>
        </div>
      </div>
      {noticeBox}
      {payload !== null && !writable ? <StatusBar tone="info">{t('readOnly')}</StatusBar> : null}
      <Tabs
        items={[
          { id: 'voices', label: t('tabVoices') },
          { id: 'interface', label: t('tabInterface') },
          { id: 'backup', label: t('tabBackup') },
        ]}
        value={tab}
        onChange={(id) => setTab(id === 'interface' || id === 'backup' ? id : 'voices')}
        label={t('tabsLabel')}
      />
      {audio === null ? null : (
        <div className="wtts-card wtts-audio">
          <audio controls autoPlay src={audio.url} style={{ width: '100%' }} />
          <div style={style.muted}>{audio.label}</div>
        </div>
      )}

      {/* ---- current voice ---- */}
      <div className="wtts-card" data-tab="voices">
        <CardHeader title={t('sectionCurrent')} description={t('sectionCurrentDesc')} />
        <div style={style.row}>
          <span style={style.label}>{t('currentVoice')}</span>
          <span>{payload?.status.activeVoice ?? t('providerDefaultVoice')}</span>
          <input
            style={{ ...style.input, minWidth: 220 }}
            placeholder={t('previewText')}
            value={draft.previewText}
            onChange={(event) => setDraft((previous) => ({ ...previous, previewText: event.target.value }))}
            onBlur={() => void writeConfig([{ op: 'set', path: ['previewText'], value: draft.previewText }])}
          />
          <button type="button" className="wtts-btn wtts-btn-primary" disabled={busy !== null} onClick={() => void previewVoice()}>
            {busy === 'preview' ? t('previewing') : t('preview')}
          </button>
        </div>
      </div>

      {/* ---- read aloud ---- */}
      <div className="wtts-card" data-tab="voices">
        <CardHeader title={t('readAloudTitle')} description={t('readAloudDesc')} />
        <div style={style.row}>
          <label style={{ ...style.label, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={draft.readAloudAuto}
              disabled={!writable || busy !== null}
              onChange={(event) => {
                const value = event.target.checked
                setDraft((previous) => ({ ...previous, readAloudAuto: value }))
                void writeReadAloud(['auto'], value)
              }}
            />{' '}
            {t('readAloudAuto')}
          </label>
          <span style={style.hint}>{t('readAloudAutoHint')}</span>
        </div>
        <div style={style.row}>
          <label style={{ ...style.label, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={draft.readAloudSkipCode}
              disabled={!writable || busy !== null}
              onChange={(event) => {
                const value = event.target.checked
                setDraft((previous) => ({ ...previous, readAloudSkipCode: value }))
                void writeReadAloud(['skipCode'], value)
              }}
            />{' '}
            {t('readAloudSkipCode')}
          </label>
          <span style={style.hint}>{t('readAloudSkipCodeHint')}</span>
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('readAloudSegment')}</span>
          <select
            style={{ ...style.input, minWidth: 120 }}
            value={draft.readAloudSegmentChars}
            disabled={!writable || busy !== null}
            onChange={(event) => {
              const value = Number(event.target.value)
              setDraft((previous) => ({ ...previous, readAloudSegmentChars: value }))
              void writeReadAloud(['segmentChars'], value)
            }}
          >
            <option value={400}>{t('readAloudSegmentShort')}</option>
            <option value={600}>{t('readAloudSegmentNormal')}</option>
            <option value={800}>{t('readAloudSegmentLong')}</option>
          </select>
          <span style={style.muted}>{t('readAloudSegmentHint')}</span>
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('readAloudRate')}</span>
          <select
            style={{ ...style.input, minWidth: 110 }}
            value={draft.readAloudRate}
            disabled={!writable || busy !== null}
            onChange={(event) => {
              const value = Number(event.target.value)
              setDraft((previous) => ({ ...previous, readAloudRate: value }))
              void writeReadAloud(['rate'], value)
            }}
          >
            <option value={0.8}>0.8×</option>
            <option value={1}>1.0×</option>
            <option value={1.25}>1.25×</option>
            <option value={1.5}>1.5×</option>
          </select>
          <span style={style.muted}>{t('readAloudHint')}</span>
        </div>
      </div>

      {/* ---- synthesis model ---- */}
      <div className="wtts-card" data-tab="voices">
        <CardHeader title={t('sectionModel')} description={t('sectionModelDesc')} />
        <div style={style.radioGroup}>
          {(['preset', 'design', 'clone'] as const).map((mode) => (
            <label key={mode} style={style.radioLabel}>
              <input
                type="radio"
                name="whale-tts-mode"
                checked={payload?.config.studioMode === mode}
                disabled={!writable}
                onChange={() => void writeConfig([{ op: 'set', path: ['studioMode'], value: mode }])}
              />
              {t(`mode${capitalize(mode)}`)}
            </label>
          ))}
        </div>

        {payload?.config.studioMode === 'preset' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={style.row}>
              <span style={style.label}>{t('presetVoice')}</span>
              <select
                style={style.input}
                value={draft.customVoiceId.trim() !== '' ? '__custom__' : draft.presetVoiceId}
                disabled={!writable}
                onChange={(event) => {
                  const value = event.target.value
                  if (value === '__custom__') {
                    setDraft((previous) => ({ ...previous, customVoiceId: ' ' }))
                    return
                  }
                  setDraft((previous) => ({ ...previous, presetVoiceId: value, customVoiceId: '' }))
                  void writeConfig([
                    { op: 'set', path: ['presetVoiceId'], value },
                    { op: 'set', path: ['customVoiceId'], value: '' },
                  ])
                }}
              >
                {presetVoices.length === 0 ? <option value={draft.presetVoiceId}>{draft.presetVoiceId}</option> : null}
                {presetVoices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label ?? voice.id}
                    {voice.description === undefined ? '' : ` · ${voice.description}`}
                  </option>
                ))}
                <option value="__custom__">{t('customVoiceId')}…</option>
              </select>
              <button
                type="button"
                style={style.button}
                disabled={
                  busy !== null ||
                  (draft.customVoiceId.trim() === '' && draft.presetVoiceId.trim() === '')
                }
                onClick={() => void previewSelectedVoice()}
              >
                {busy === 'preview-selected' ? t('previewing') : t('preview')}
              </button>
              <input
                style={{ ...style.input, minWidth: 180 }}
                placeholder={t('customVoiceId')}
                value={draft.customVoiceId}
                disabled={!writable}
                onChange={(event) => setDraft((previous) => ({ ...previous, customVoiceId: event.target.value }))}
                onBlur={() => void writeConfig([{ op: 'set', path: ['customVoiceId'], value: draft.customVoiceId }])}
              />
            </div>
            <div style={style.row}>
              <input
                style={{ ...style.input, minWidth: 180 }}
                placeholder={t('profileName')}
                value={draft.profileName}
                disabled={!writable}
                onChange={(event) => setDraft((previous) => ({ ...previous, profileName: event.target.value }))}
              />
              <button type="button" style={style.button} disabled={busy !== null} onClick={() => void savePresetProfile()}>
                {t('saveProfile')}
              </button>
            </div>
          </div>
        ) : null}

        {payload?.config.studioMode === 'design' ? (
          <div>
            {canDesign ? null : <div style={style.muted}>{t('unsupportedDesign')}</div>}
            <textarea
              style={style.textarea}
              placeholder={t('designDescription')}
              value={draft.designDescription}
              disabled={!writable}
              onChange={(event) => setDraft((previous) => ({ ...previous, designDescription: event.target.value }))}
              onBlur={() =>
                void writeConfig([{ op: 'set', path: ['designDescription'], value: draft.designDescription }])
              }
            />
            <div style={style.muted}>{t('designHint')}</div>
            <div style={style.row}>
              <span style={style.label}>{t('candidateCount')}</span>
              <select
                style={style.input}
                value={String(draft.designCandidateCount)}
                disabled={!writable}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setDraft((previous) => ({ ...previous, designCandidateCount: value }))
                  void writeConfig([{ op: 'set', path: ['designCandidateCount'], value }])
                }}
              >
                {[2, 3, 4, 5].map((count) => (
                  <option key={count} value={String(count)}>{count}</option>
                ))}
              </select>
              <input
                style={{ ...style.input, minWidth: 180 }}
                placeholder={t('sampleText')}
                value={draft.sampleText}
                disabled={!writable}
                onChange={(event) => setDraft((previous) => ({ ...previous, sampleText: event.target.value }))}
                onBlur={() => void writeConfig([{ op: 'set', path: ['sampleText'], value: draft.sampleText }])}
              />
              <button
                type="button"
                className="wtts-btn wtts-btn-primary"
                disabled={busy !== null || !canDesign}
                onClick={() => void generateCandidates()}
              >
                {busy === 'design' ? t('generating') : t('generate')}
              </button>
              {candidates.length === 0 ? null : (
                <button type="button" style={style.button} disabled={busy !== null} onClick={() => void discardCandidates()}>
                  {t('discardCandidates')}
                </button>
              )}
            </div>
            <div style={style.list}>
              {candidates.length === 0 ? (
                <span style={style.muted}>{t('candidatesEmpty')}</span>
              ) : (
                candidates.map((candidate, index) => (
                  <div key={candidate.id} style={style.listRow}>
                    <span>#{index + 1}</span>
                    <span style={style.muted}>{candidate.format} · {formatBytes(candidate.bytes)}</span>
                    <button
                      type="button"
                      style={style.button}
                      disabled={busy !== null}
                      onClick={() => void run('play-design', () => playAudio('design', candidate.file))}
                    >
                      {t('play')}
                    </button>
                    <button type="button" className="wtts-btn wtts-btn-primary" disabled={busy !== null} onClick={() => void adoptCandidate(candidate)}>
                      {busy === 'adopt' ? t('saving') : t('adopt')}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}

        {payload?.config.studioMode === 'clone' ? (
          <div>
            {canClone ? null : <div style={style.muted}>{t('unsupportedClone')}</div>}
            <div style={style.row}>
              <span style={style.label}>{t('cloneSample')}</span>
              <FileDropzone
                accept=".mp3,.wav,audio/mpeg,audio/wav"
                disabled={busy !== null || !writable}
                title={t('cloneChooseSample')}
                hint={t('cloneChooseSampleHint')}
                onFile={(file) => void uploadSample(file)}
              />
              {busy === 'upload' ? <span style={style.muted}>{t('uploading')}</span> : null}
            </div>
            <div style={style.muted}>{t('sampleHint')}</div>
            <div style={style.row}>
              <span style={style.label}>{t('samplePath')}</span>
              <input
                style={{ ...style.input, minWidth: 240 }}
                value={draft.cloneSampleFile}
                disabled={!writable}
                onChange={(event) => setDraft((previous) => ({ ...previous, cloneSampleFile: event.target.value }))}
              />
              {cloneProfiles.length === 0 ? null : (
                <select
                  style={style.input}
                  value=""
                  onChange={(event) => {
                    const file = event.target.value
                    if (file !== '') setDraft((previous) => ({ ...previous, cloneSampleFile: file }))
                  }}
                >
                  <option value="">{t('sectionProfiles')}…</option>
                  {cloneProfiles.map((profile) =>
                    profile.sampleFile === undefined ? null : (
                      <option key={profile.id} value={profile.sampleFile}>{profile.name}</option>
                    ),
                  )}
                </select>
              )}
              <button type="button" style={style.button} disabled={busy !== null} onClick={() => void saveCloneProfile()}>
                {t('saveProfile')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* ---- voice library ---- */}
      <div className="wtts-card" data-tab="voices">
        <CardHeader title={t('sectionProfiles')} description={t('sectionProfilesDesc')} />
        <div style={style.list}>
          {profiles.length === 0 ? <EmptyState title={t('profilesEmpty')} hint={t('profilesEmptyHint')} /> : null}
          {profiles.map((profile) => {
            const active = profile.id === payload?.status.activeProfileId
            return (
              <div key={profile.id} className="wtts-profile" data-active={active ? 'true' : undefined}>
                {renaming !== null && renaming.id === profile.id ? (
                  <>
                    <input
                      style={{ ...style.input, width: 160 }}
                      value={renaming.value}
                      autoFocus
                      onChange={(event) =>
                        setRenaming({ id: profile.id, value: event.target.value })
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void commitRename(profile)
                        if (event.key === 'Escape') cancelRename()
                      }}
                    />
                    <button
                      type="button"
                      className="wtts-btn wtts-btn-primary"
                      disabled={busy !== null || renaming.value.trim() === ''}
                      onClick={() => void commitRename(profile)}
                    >
                      {t('save')}
                    </button>
                    <button type="button" style={style.button} disabled={busy !== null} onClick={cancelRename}>
                      {t('cancel')}
                    </button>
                  </>
                ) : (
                  <span style={{ minWidth: 140 }}>{profile.name}</span>
                )}
                <span style={style.tag}>{t(`kind${capitalize(profile.kind)}`)}</span>
                {active ? <span style={style.tag}>{t('activeLabel')}</span> : null}
                {profile.description === undefined || profile.description === '' ? null : (
                  <span style={style.muted}>{profile.description}</span>
                )}
                {styling !== null && styling.id === profile.id ? (
                  <>
                    <textarea
                      style={{ ...style.textarea, width: 320, minHeight: 54 }}
                      value={styling.value}
                      placeholder={t('stylePlaceholder')}
                      onChange={(event) =>
                        setStyling({ id: profile.id, value: event.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="wtts-btn wtts-btn-primary"
                      disabled={busy !== null}
                      onClick={() => void commitStyle(profile)}
                    >
                      {t('save')}
                    </button>
                    <button type="button" style={style.button} disabled={busy !== null} onClick={cancelStyle}>
                      {t('cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    {profile.styleInstruction === undefined || profile.styleInstruction === '' ? null : (
                      <span style={style.muted} title={profile.styleInstruction}>
                        {t('styleInstructionShort')}：{profile.styleInstruction.length > 16
                          ? `${profile.styleInstruction.slice(0, 16)}…`
                          : profile.styleInstruction}
                      </span>
                    )}
                    {profile.kind === 'design' ? null : (
                      <button
                        type="button"
                        style={style.button}
                        disabled={busy !== null}
                        onClick={() => startStyle(profile)}
                      >
                        {t('styleInstruction')}
                      </button>
                    )}
                    {profile.kind === 'design' ? null : (
                      <button
                        type="button"
                        style={style.button}
                        disabled={busy !== null}
                        onClick={() =>
                          void run('play-profile', async () => {
                            // A clone profile already owns a reference sample.
                            // Play that instead of re-synthesising through the
                            // provider (which can hit a 30s MiMo timeout).
                            if (profile.kind === 'clone' && profile.sampleFile !== undefined) {
                              await playAudio('sample', profile.sampleFile)
                              return
                            }
                            await activateProfile(profile)
                            const result = await call<PreviewPayload>('preview', { text: draft.previewText })
                            await playAudio('preview', result.file)
                          })
                        }
                      >
                        {t('play')}
                      </button>
                    )}
                    {active || profile.kind === 'design' ? null : (
                      <button
                        type="button"
                        style={style.button}
                        disabled={busy !== null}
                        onClick={() => void run('activate', () => activateProfile(profile))}
                      >
                        {t('activate')}
                      </button>
                    )}
                    <button type="button" style={style.button} disabled={busy !== null} onClick={() => startRename(profile)}>
                      {t('rename')}
                    </button>
                    <button type="button" style={style.button} disabled={busy !== null} onClick={() => void duplicateProfile(profile)}>
                      {t('duplicate')}
                    </button>
                    {deletingId === profile.id ? (
                      <>
                        <span style={style.muted}>{t('deleteConfirmShort')}</span>
                        <button
                          type="button"
                          className="wtts-btn wtts-btn-danger"
                          disabled={busy !== null}
                          onClick={() => void confirmRemove(profile)}
                        >
                          {t('delete')}
                        </button>
                        <button
                          type="button"
                          style={style.button}
                          disabled={busy !== null}
                          onClick={() => setDeletingId(null)}
                        >
                          {t('cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="wtts-btn wtts-btn-danger"
                        disabled={busy !== null}
                        onClick={() => removeProfile(profile)}
                      >
                        {t('delete')}
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ---- output ---- */}
      <div className="wtts-card" data-tab="interface">
        <CardHeader title={t('sectionOutput')} description={t('sectionOutputDesc')} />
        <div style={style.row}>
          <span style={style.label}>{t('outputDir')}</span>
          <input
            style={{ ...style.input, flex: 1, minWidth: 320 }}
            value={draft.outputDir}
            disabled={!writable}
            onChange={(event) => setDraft((previous) => ({ ...previous, outputDir: event.target.value }))}
            onBlur={() =>
              void writeConfig([{ op: 'set', path: ['output', 'dir'], value: trimTrailingSlash(draft.outputDir) }])
            }
          />
        </div>
        <div style={style.hint}>{t('outputHint')}</div>
        <div style={style.row}>
          <span style={style.label}>{t('formatLabel')}</span>
          <select
            style={{ ...style.input, minWidth: 140 }}
            value={payload?.config.output?.format ?? 'auto'}
            disabled={!writable}
            onChange={(event) =>
              void writeConfig([{ op: 'set', path: ['output', 'format'], value: event.target.value }])
            }
          >
            <option value="auto">{t('formatAuto')}</option>
            <option value="wav">wav</option>
            <option value="mp3">mp3</option>
          </select>
          <label style={style.radioLabel}>
            <input
              type="checkbox"
              checked={payload?.config.cache?.enabled === true}
              disabled={!writable}
              onChange={(event) =>
                void writeConfig([{ op: 'set', path: ['cache', 'enabled'], value: event.target.checked }])
              }
            />
            {t('cache')}
          </label>
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('maxChars')}</span>
          <input
            style={{ ...style.input, width: 120 }}
            type="number"
            min={1}
            value={draft.maxChars}
            disabled={!writable}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, maxChars: Number(event.target.value) || 1 }))
            }
            onBlur={() =>
              void writeConfig([{ op: 'set', path: ['limits', 'maxChars'], value: draft.maxChars }])
            }
          />
        </div>
        <div style={style.muted}>
          {payload === null ? '' : `${payload.status.cache.files} files · ${formatBytes(payload.status.cache.bytes)}`}
        </div>
      </div>

      {/* ---- interface / credentials ---- */}
      <div className="wtts-card" data-tab="interface">
        <CardHeader title={t('sectionInterface')} description={t('sectionInterfaceDesc')} />
        <div style={style.row}>
          <span style={style.label}>{t('provider')}</span>
          <select
            style={{ ...style.input, minWidth: 180 }}
            value={payload?.config.provider ?? ''}
            disabled={!writable}
            onChange={(event) => changeProvider(event.target.value)}
          >
            {providerChoices.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
            {activeProviderSelectable ? null : (
              <option value={payload?.config.provider ?? ''} disabled>
                {payload?.config.provider ?? ''} · {t('providerUnavailable')}
              </option>
            )}
          </select>
          <span style={style.tag}>
            {activeProvider?.keyConfigured === true ? t('keyConfigured') : t('keyMissing')}
          </span>
          {activeProvider?.keyType === undefined || activeProvider.keyType === 'unknown' ? null : (
            <span style={style.tag}>{activeProvider.keyType}</span>
          )}
        </div>
        {hiddenProviderCount === 0 ? null : (
          <div style={style.hint}>
            {t('providerLimited', { hidden: hiddenProviderCount })}
          </div>
        )}
        <div style={style.row}>
          <span style={style.label}>{t('keySource')}</span>
          <div style={style.radioGroup}>
            <label style={style.radioLabel}>
              <input
                type="radio"
                name="whale-tts-key-source"
                checked={payload?.config.keySource !== 'manual'}
                disabled={!writable}
                onChange={() => void writeConfig([{ op: 'set', path: ['keySource'], value: 'reuse' }])}
              />
              {t('keyReuse')}
            </label>
            <label style={style.radioLabel}>
              <input
                type="radio"
                name="whale-tts-key-source"
                checked={payload?.config.keySource === 'manual'}
                disabled={!writable}
                onChange={() => void writeConfig([{ op: 'set', path: ['keySource'], value: 'manual' }])}
              />
              {t('keyManual')}
            </label>
          </div>
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('keyPick')}</span>
          <select
            style={{ ...style.input, minWidth: 320 }}
            value={payload?.config.apiKeyEnv ?? ''}
            disabled={!writable}
            onChange={(event) =>
              void writeConfig([{ op: 'set', path: ['apiKeyEnv'], value: event.target.value }])
            }
          >
            <option value="">
              {defaultKeyRef === ''
                ? t('keyAuto')
                : t('keyAutoRef', { ref: defaultKeyRef })}
            </option>
            {keyCandidates.map((candidate) => (
              <option key={candidate.ref} value={candidate.ref}>
                {candidate.ref}
                {candidate.configured ? ` · ${t('keyConfigured')}` : ` · ${t('keyMissing')}`}
              </option>
            ))}
          </select>
          <span style={style.tag}>
            {selectedKeyRow?.configured === true ? t('keyConfigured') : t('keyMissing')}
          </span>
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('keyInput')}</span>
          <input
            style={{ ...style.input, flex: 1, minWidth: 240 }}
            type="password"
            autoComplete="new-password"
            placeholder="sk-… / tp-…"
            value={keyValue}
            onChange={(event) => setKeyValue(event.target.value)}
          />
          <div style={style.actions}>
            <button
              type="button"
              className="wtts-btn wtts-btn-primary"
              disabled={busy !== null || keyValue.trim() === ''}
              onClick={() => void saveKey()}
            >
              {t('keySave')}
            </button>
            {keyClearable && confirmClearKey ? (
              <>
                <button type="button" className="wtts-btn wtts-btn-danger" disabled={busy !== null} onClick={() => void clearKey()}>
                  {t('clearKeyConfirm')}
                </button>
                <button type="button" style={style.button} disabled={busy !== null} onClick={() => setConfirmClearKey(false)}>
                  {t('cancel')}
                </button>
              </>
            ) : (
              <button
                type="button"
                style={
                  keyClearable
                    ? style.button
                    : { ...style.button, opacity: 0.55, cursor: 'not-allowed' }
                }
                disabled={busy !== null || !keyClearable}
                title={keyClearable ? undefined : t('keyClearSharedHint')}
                onClick={() => setConfirmClearKey(true)}
              >
                {t('clearKey')}
              </button>
            )}
          </div>
        </div>
        {effectiveKeyRef !== '' && selectedKeyRow?.configured === true && !keyClearable ? (
          <div style={style.hint}>
            {keySourceIsReuse ? t('keyClearReuseHint') : t('keyClearSharedHint')}
          </div>
        ) : null}
        <div style={style.row}>
          <span style={style.label}>{t('keyType')}</span>
          <select
            style={{ ...style.input, minWidth: 180 }}
            value={payload?.config.keyType ?? 'auto'}
            disabled={!writable}
            onChange={(event) =>
              void writeConfig([{ op: 'set', path: ['keyType'], value: event.target.value }])
            }
          >
            <option value="auto">{t('keyTypeAuto')}</option>
            <option value="pay-as-you-go">{t('keyTypePayg')}</option>
            <option value="token-plan">{t('keyTypeTokenPlan')}</option>
            <option value="token-plan-team">{t('keyTypeTokenPlanTeam')}</option>
            <option value="custom">{t('keyTypeCustom')}</option>
          </select>
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('baseURLOverride')}</span>
          <input
            style={{ ...style.input, flex: 1, minWidth: 280 }}
            value={draft.baseURLOverride}
            disabled={!writable}
            placeholder={activeProvider?.baseURL ?? ''}
            onChange={(event) => setDraft((previous) => ({ ...previous, baseURLOverride: event.target.value }))}
            onBlur={() => void writeConfig([{ op: 'set', path: ['baseURLOverride'], value: draft.baseURLOverride }])}
          />
        </div>
        <div style={style.row}>
          <span style={style.label} />
          <button type="button" style={style.button} disabled={busy !== null} onClick={() => void testConnection()}>
            {busy === 'test' ? t('testing') : t('testConnection')}
          </button>
          {test === null ? null : (
            <span style={test.ok ? style.successNotice : style.errorNotice}>
              {test.ok ? t('testOk') : t('testFail')}
              {' · '}
              {t('latency')} {test.latencyMs}ms
              {test.error === undefined ? '' : ` · ${test.error.message}`}
            </span>
          )}
          {activeProvider?.lastError === undefined ? null : (
            <span style={style.muted}>{t('lastError')}: {activeProvider.lastError}</span>
          )}
        </div>
      </div>
      <div className="wtts-card" data-tab="backup">
        <CardHeader title={t('sectionBackup')} description={t('sectionBackupDesc')} />
        <div style={style.hint}>{t('backupHint')}</div>
        {backupSummary === null ? null : <div style={style.hint}>{backupSummary}</div>}
        <div style={style.row}>
          <span style={style.label}>{t('backupExportLabel')}</span>
          <button type="button" style={style.button} disabled={busy !== null} onClick={() => void exportBackup()}>
            {busy === 'backup-export' ? t('busy') : t('backupExportButton')}
          </button>
          <span style={style.muted}>{t('backupExportHint')}</span>
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('backupLatest')}</span>
          {latestBackup === undefined ? (
            <span style={style.muted}>{t('backupEmpty')}</span>
          ) : (
            <>
              <span style={style.muted}>
                {latestBackup.file} · {formatBytes(latestBackup.bytes)}
              </span>
              <button
                type="button"
                style={style.button}
                disabled={busy !== null}
                onClick={() => void importBackup({ path: latestBackup.path })}
              >
                {t('backupRestoreLatest')}
              </button>
            </>
          )}
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('backupMode')}</span>
          <select
            style={{ ...style.input, minWidth: 170 }}
            value={backupMode}
            disabled={busy !== null}
            onChange={(event) => setBackupMode(event.target.value === 'replace' ? 'replace' : 'merge')}
          >
            <option value="merge">{t('backupModeMerge')}</option>
            <option value="replace">{t('backupModeReplace')}</option>
          </select>
          <span style={style.muted}>{t('backupModeHint')}</span>
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('backupImportFile')}</span>
          <FileDropzone
            accept=".json,application/json"
            disabled={busy !== null}
            title={t('backupChooseFile')}
            hint={t('backupChooseFileHint')}
            onFile={(file) => void importBackupFile(file)}
          />
        </div>
        <div style={style.row}>
          <span style={style.label}>{t('backupImportPath')}</span>
          <input
            style={{ ...style.input, flex: 1, minWidth: 280 }}
            value={backupPath}
            placeholder={t('backupPathPlaceholder')}
            disabled={busy !== null}
            onChange={(event) => setBackupPath(event.target.value)}
          />
          <button
            type="button"
            style={style.button}
            disabled={busy !== null || backupPath.trim() === ''}
            onClick={() => void importBackup({ path: backupPath.trim() })}
          >
            {t('backupImportPathButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Uppercase the first letter (kind → Kind for dictionary keys). */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Human-readable byte size for backup files. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}
