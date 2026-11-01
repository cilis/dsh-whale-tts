# Self-hosting and deployment recipes

The plugin is deliberately deployment-neutral: it writes audio files to a
configured directory and returns paths. This page collects the deployment shapes
we know work.

## Output and cache placement

- `output.dir` is where finished audio files land. It can be any absolute path or
  a template (`${DSH_HOME}`, `${HOME}`, `${USERPROFILE}`, `${TMP}`, `${TEMP}`).
- `cache.dir` defaults to `${DSH_HOME}/whale-tts/.cache`. If a consumer only
  accepts files inside `output.dir` (for example a chat bridge that validates
  the library path), point the cache **inside** that directory:

  ```yaml
  output:
    dir: 'E:\bridge\audio'
  cache:
    enabled: true
    dir: 'E:\bridge\audio\.cache'
  ```

  or disable the cache (`cache.enabled: false`) when relative paths must stay
  flat.
- `tts_synthesize` always returns three path shapes (`path`, `relativePath`,
  `file`); pick the one the consumer validates.

## Using a self-hosted / third-party OpenAI-compatible gateway

Any server that implements `POST /v1/audio/speech` with a bearer token works:

```yaml
- id: whale-tts
  name: dsh-whale-tts
  config:
    provider: openai-compatible
    providers:
      openai-compatible:
        enabled: true
        baseURL: 'http://127.0.0.1:8080/v1'
        apiKeyEnv: LOCAL_TTS_KEY      # leave empty for keyless local servers
        model: kokoro
        voice: af_heart
        format: wav
        timeoutMs: 60000
        headers:
          X-Proxy-Mode: local
```

Put the key in the environment or `$DSH_HOME/.credentials.yaml`; never in the
patch. Keyless local servers: set `apiKeyEnv` to an empty string — but note the
adapter still declares `requiresKey: true` for the OpenAI-compatible family, so
keep a dummy ref (`LOCAL_TTS_KEY=dummy`) if your server ignores it, or use the
`sapi` provider for a truly keyless path.

## Reusing DSH's existing MiMo credential

The DSH LLM provider for Xiaomi MiMo already stores a Token Plan key. Point the
TTS provider at the same reference instead of copying the secret:

```yaml
    apiKeyEnv: XIAOMI_TOKEN_PLAN_CN_API_KEY
    providers:
      mimo:
        apiKeyEnv: XIAOMI_TOKEN_PLAN_CN_API_KEY
```

The card shows the same reference as *configured ✓*. Token Plan keys are subject
to the provider's terms (personal local use, no public relay); for a public
service use a pay-as-you-go `sk-` key.

## Multiple profiles, one machine

A bundle is installed per profile and each profile has its own config row:
install into `qqbot` (audio library output, `maxChars: 120`) and `desktop`
(personal output, `maxChars: 2000`) independently. Credentials live in the DSH
home and are shared — the card in one profile sees the same configured
references as the other.

## Offline-only deployment (Windows)

Use `sapi` as the only provider:

```yaml
provider: sapi
fallback: []
providers:
  sapi:
    enabled: true
    voiceName: 'Microsoft Huihui Desktop'   # optional, system default otherwise
    rate: 0
output:
  dir: '${DSH_HOME}/whale-tts/out'
```

No key, no network. Speech quality is the Windows SAPI voice; it is the intended
fallback when the network or a key fails.

## Headless profiles

Headless profiles do not render the settings card. Everything else works: the
tools are registered, the YAML config is read, and `tts_status` reports the
effective state. Configure with patch rows and test with
`tts_synthesize({ text: "…" })` in a session.

## Privacy notes

- `log.text` is `false` by default: the text being synthesised is never logged.
- The text **is** sent to the configured provider (that is what synthesis means);
  for sensitive text use `sapi` or a self-hosted gateway.
- `tts_status` and the card never expose keys or text; error messages are
  redacted before they leave the host.
- The base64 preview channel is local (DSH connection RPC); audio files are not
  uploaded anywhere by the plugin.

## Troubleshooting

1. Run `tts_status` and read `providers.<id>`: `keyConfigured`, `keyType`,
   `baseURL`, `lastError`, `available`.
2. `keyType` mismatch (`sk-` vs `tp-`) usually means a wrong BaseURL — leave
   `baseURL`/`baseURLOverride` empty so the prefix mapping applies.
3. `all TTS providers failed: …` lists each provider's reason; the first one is
   usually the real cause.
4. `output.dir must expand to an absolute path` means a relative template; use
   `${DSH_HOME}` or a drive-letter path.
5. `output file already exists` means `output.filename` has no `{rand}`/`{timestamp}`
   and `output.overwrite` is false.
6. SAPI: `platform` error on non-Windows is expected; on Windows check that the
   chosen `voiceName` exists:

   ```powershell
   Add-Type -AssemblyName System.Speech
   (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |
     ForEach-Object { $_.VoiceInfo.Name }
   ```
