/**
 * `minimax` provider adapter — interface stub.
 *
 * The provider block, capability table and voice list are kept so a deployment
 * can already declare `minimax` in `cordis.patch.yml`, but this release does not
 * talk to the MiniMax API: `synthesize` reports "not implemented" instead of
 * pretending to work. The fallback chain treats that as a non-retryable failure
 * and moves on to the next provider.
 *
 * Future implementation notes (design §七 / integration plan §八.3):
 * - `POST {baseURL}/t2a_v2`, `Authorization: Bearer <key>`;
 * - body `{ model, text, stream:false, voice_setting, audio_setting }`;
 * - `data.audio` is a **hex** string, `base_resp.status_code !== 0` is failure.
 *
 * Defaults (`baseURL`/`apiKeyEnv`/`model`/`voice`) live in
 * `providers/registry.ts`; the provider block in `cordis.patch.yml` overrides
 * them, so this file never repeats them.
 */
import { TtsError, type ProviderAdapter, type ProviderCapabilities, type VoiceDescriptor } from '../types.js'

/** Provider id; also the `provider` field of every error it raises. */
const PROVIDER = 'minimax'

/** Preset voices documented for the MiniMax speech models. */
const VOICES: readonly VoiceDescriptor[] = [
  { id: 'male-qn-jingying', label: '精英男声', description: '沉稳精英男声' },
  { id: 'male-qn-qingse', label: '青涩男声', description: '青涩青年男声' },
  { id: 'female-shaonv', label: '少女音色', description: '甜美少女' },
  { id: 'female-yujie', label: '御姐音色', description: '成熟御姐' },
  { id: 'female-chengshu', label: '成熟女声', description: '成熟稳重女声' },
  { id: 'presenter_male', label: '主持男声', description: '节目主持风格' },
  { id: 'presenter_female', label: '主持女声', description: '节目主持风格' },
]

const CAPABILITIES: ProviderCapabilities = {
  speech: true,
  singing: false,
  // MiniMax only emits MP3 in this release's contract.
  formats: ['mp3'],
  voices: VOICES,
  requiresKey: true,
  voiceDesign: false,
  voiceClone: false,
}

/**
 * MiniMax adapter stub.
 *
 * @throws {TtsError} always, with kind `not-implemented`.
 */
export const minimaxAdapter: ProviderAdapter = {
  id: PROVIDER,

  capabilities: CAPABILITIES,

  async synthesize(): Promise<never> {
    throw new TtsError('not-implemented', 'minimax adapter is not implemented yet', {
      provider: PROVIDER,
      retryable: false,
    })
  },
}
