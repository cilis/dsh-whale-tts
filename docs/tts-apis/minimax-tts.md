# MiniMax TTS API

> 最后核对：2026-11-03
> 官方文档：
> - 国际站同步 TTS：https://platform.minimax.io/docs/api-reference/speech-t2a-http
> - 国内站同步 TTS：https://platform.minimax.cn/docs/api-reference/speech-t2a-http
> - 异步长文本：https://platform.minimax.cn/docs/guides/speech-t2a-async

## 1. 能力概览

- **模型**：`speech-2.8-hd`、`speech-2.8-turbo`、`speech-2.6-hd/turbo`、
  `speech-02-hd/turbo`、`speech-01-hd/turbo`（以控制台当前可用列表为准）。
- **文本长度**：单次最多 10,000 字符；超过 3,000 字符建议 `stream=true`。
- **音色**：控制台提供大量预置 `voice_id`，例如
  `English_expressive_narrator`、`audiobook_male_1`；支持声音克隆。
- **输出**：默认 hex 编码音频（`output_format: "hex"`），可配 mp3/pcm/flac/wav、
  采样率 8k–44.1k、码率 32k–320k、单/双声道。
- **高级**：停顿 `<#x#>`、拼音/IPA 注音、语气词标签、字幕时间戳、
  `voice_modify` 音色调整。

## 2. 端点与认证

```http
POST https://api.minimax.io/v1/t2a_v2      # 国际站
POST https://api.minimax.cn/v1/t2a_v2      # 国内站
Authorization: Bearer <MINIMAX_API_KEY>
Content-Type: application/json
```

## 3. 同步合成请求

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 如 `speech-2.8-hd` |
| `text` | string | 是 | 待合成文本，< 10,000 字符 |
| `stream` | boolean | 否 | 默认 false；长文本建议 true |
| `voice_setting.voice_id` | string | 是 | 音色 ID |
| `voice_setting.speed` | number | 否 | 语速，默认 1 |
| `voice_setting.vol` | number | 否 | 音量，默认 1 |
| `voice_setting.pitch` | number | 否 | 音高，默认 0 |
| `voice_setting.emotion` | string | 否 | 情感（支持范围取决于模型/音色） |
| `audio_setting.sample_rate` | int | 否 | 8000–44100，默认 32000 |
| `audio_setting.bitrate` | int | 否 | 32000–320000，默认 128000 |
| `audio_setting.format` | string | 否 | `mp3` / `pcm` / `flac` / `wav` |
| `audio_setting.channel` | int | 否 | 1 / 2 |
| `language_boost` | string | 否 | 语言增强，如 `auto` / `Chinese` / `English` |
| `output_format` | string | 否 | `hex`（默认）或 `url` |
| `pronunciation_dict.tone` | string[] | 否 | 自定义读音，如 `"Omg/Oh my god"` |
| `voice_modify` | object | 否 | 音高/强度/音色/音效调整 |

```bash
curl --request POST \
  --url https://api.minimax.io/v1/t2a_v2 \
  --header 'Authorization: Bearer <token>' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "speech-2.8-hd",
    "text": "你好，我是育木的小鲸鱼。",
    "stream": false,
    "voice_setting": { "voice_id": "audiobook_male_1", "speed": 1, "vol": 1, "pitch": 0 },
    "audio_setting": { "sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1 },
    "language_boost": "Chinese",
    "output_format": "hex"
  }'
```

## 4. 响应

```json
{
  "data": {
    "audio": "fffb90...（hex 编码音频）",
    "status": 2,
    "subtitle_file": "https://..."
  },
  "extra_info": {
    "audio_length": 11124,
    "audio_sample_rate": 32000,
    "audio_size": 157869,
    "bitrate": 128000,
    "word_count": 13,
    "channel": 1,
    "format": "mp3"
  },
  "trace_id": "301871346491491...",
  "base_resp": { "status_code": 0, "status_msg": "success" }
}
```

- `data.audio` 是 **hex**（不是 base64），需 `bytes.fromhex()`/`Buffer.from(hex,'hex')`。
- `base_resp.status_code=0` 表示成功；非 0 时看 `status_msg`。
- `stream=true` 返回 SSE：每帧一个 JSON（含 hex 音频分片），最后以
  `base_resp` 结束；字幕在 `data.subtitle`。

## 5. 限制

- 单次 10,000 字符；>3,000 建议流式。
- 不同模型支持的音色、情感、字幕能力不同，以文档/控制台为准。
- 音频、字幕文件有时效；需要及时下载。
- 国内站和国际站域名/账号体系不同，Key 不通用。

## 6. 接入 dsh-whale-tts

- **0.5.0 已实现非流式 `minimax` provider**：设置卡里可直接选为 primary，
  Key 引用 `MINIMAX_API_KEY`，默认 `model = speech-2.8-turbo`、
  `voice = male-qn-jingying`。
- `synthesize()`：POST `{baseURL}/t2a_v2` → `data.audio` hex 解码 →
  `{ data, format: audio_setting.format, voice: voice_id }`。
- 文本上限 10,000 字符，但插件现有分段逻辑建议仍按 500–800 字一段，避免
  单次等待过久。
- 流式播放、声音克隆和设计尚未接入；要做流式需要把 SSE 分片边收边喂给播放器。
