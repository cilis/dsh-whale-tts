# ElevenLabs TTS API

> 最后核对：2026-11-03
> 官方文档：
> - Create speech：https://elevenlabs.io/docs/api-reference/text-to-speech/convert
> - 音色列表：https://elevenlabs.io/docs/api-reference/voices
> - 声音克隆：https://elevenlabs.io/docs/product-guides/voices/voice-cloning

## 1. 能力概览

- 高质量多语种 TTS，英文尤其自然；支持情绪/风格参数、语音克隆
  （Instant Voice Cloning / Professional Voice Cloning）。
- **模型**：`eleven_multilingual_v2`、`eleven_turbo_v2_5`、
  `eleven_flash_v2_5` 等（以 `GET /v1/models` 返回为准）。
- **音色**：预置 voice + 账号克隆的 voice，使用 `voice_id` 选择。
- **输出**：默认 mp3；`output_format` 可指定
  `mp3_44100_128`、`pcm_44100`、`ulaw_8000` 等（采样率/码率受套餐限制）。
- **限制**：单次文本长度随套餐变化（常见 5,000 字符；以控制台为准）。

## 2. 端点与认证

```http
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
xi-api-key: $ELEVENLABS_API_KEY
Content-Type: application/json
```

流式：

```http
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream
```

## 3. 请求

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 待合成文本 |
| `model_id` | string | 是 | 如 `eleven_multilingual_v2` |
| `language_code` | string | 否 | ISO 639-1；部分模型不支持 |
| `voice_settings.stability` | number | 否 | 0–1，稳定性 |
| `voice_settings.similarity_boost` | number | 否 | 0–1，音色相似度 |
| `voice_settings.style` | number | 否 | 0–1，风格夸张度 |
| `voice_settings.use_speaker_boost` | boolean | 否 | 音色增强 |
| `voice_settings.speed` | number | 否 | 语速 |
| `seed` | int | 否 | 0–4294967295，尽量可复现 |
| `previous_text` / `next_text` | string | 否 | 分段合成时的上下文衔接 |
| `output_format` | query | 否 | 如 `mp3_44100_128` |

```bash
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/$VOICE_ID" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "你好，我是育木的小鲸鱼。",
    "model_id": "eleven_multilingual_v2",
    "voice_settings": { "stability": 0.5, "similarity_boost": 0.75, "speed": 1.0 },
    "output_format": "mp3_44100_128"
  }' --output speech.mp3
```

## 4. 响应

- `200`：响应体为音频二进制（`Content-Type` 通常是 `audio/mpeg`）。
- 错误：`401` Key 无效、`422` 参数/文本校验失败、`429` 限流；
  错误体是 JSON `{"detail": {...}}`。
- 流式端点返回分块音频，可直接边收边播。

## 5. 声音克隆

- Instant Voice Cloning：`POST /v1/voices/add`（multipart 上传样本），得到
  `voice_id` 后即可用于 TTS。
- Professional Voice Cloning：需要更长样本和审核，质量更高。
- 克隆音色的使用受套餐/授权限制。

## 6. 接入 dsh-whale-tts 的建议

- 新 provider id：`elevenlabs`；Key 引用 `ELEVENLABS_API_KEY`。
- `synthesize()`：POST → 返回音频二进制；简单，不需要解码 base64/hex。
- `voice` 对应 `voice_id`；`model` 对应 `model_id`；插件的 `style`/语速可映射到
  `voice_settings`。
- 中文效果不如 Qwen/豆包，但英文和多语种质量好；适合作为可选 provider。
- 语音克隆可作为后续能力：插件已有样本上传，可对接 `/v1/voices/add`。
