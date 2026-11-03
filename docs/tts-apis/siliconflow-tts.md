# SiliconFlow TTS API（OpenAI 兼容）

> 最后核对：2026-11-03
> 官方文档：
> - 文本转语音指南：https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech
> - API 参考：https://docs.siliconflow.cn/cn/api-reference/audio/create-speech

## 1. 能力概览

- 硅基流动把多个开源 TTS 模型统一成 **OpenAI `/audio/speech` 形状**：
  `FunAudioLLM/CosyVoice2-0.5B`、`fishaudio/fish-speech-1.5` 等（以控制台为准）。
- **音色**：`模型名:音色名`，例如
  `FunAudioLLM/CosyVoice2-0.5B:alex`、`FunAudioLLM/CosyVoice2-0.5B:anna`。
- **输出**：二进制音频，`response_format` 支持 `mp3` / `wav` / `opus` / `pcm`。
- **优势**：国内直连、OpenAI 兼容、接入成本最低；CosyVoice2 支持中文、情感和
  零样本音色克隆（取决于模型能力）。

## 2. 端点与认证

```http
POST https://api.siliconflow.cn/v1/audio/speech
Authorization: Bearer $SILICONFLOW_API_KEY
Content-Type: application/json
```

## 3. 请求

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 如 `FunAudioLLM/CosyVoice2-0.5B` |
| `input` | string | 是 | 待合成文本 |
| `voice` | string | 是 | `模型名:音色名`，如 `FunAudioLLM/CosyVoice2-0.5B:alex` |
| `response_format` | string | 否 | `mp3`（默认）/`wav`/`opus`/`pcm` |
| `speed` | number | 否 | 语速（部分模型支持） |
| `sample_rate` | int | 否 | 采样率（部分模型支持） |

```bash
curl https://api.siliconflow.cn/v1/audio/speech \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "FunAudioLLM/CosyVoice2-0.5B",
    "input": "你好，我是育木的小鲸鱼。",
    "voice": "FunAudioLLM/CosyVoice2-0.5B:alex",
    "response_format": "mp3"
  }' --output speech.mp3
```

## 4. 响应

- `200`：音频二进制，`Content-Type` 与 `response_format` 对应。
- 错误：`400` 参数/文本非法、`401` Key、`429` 限流、`5xx` 服务端。
- 文本长度和并发按模型/账号套餐限制，控制台可见。

## 5. 接入 dsh-whale-tts 的建议

- **成本最低**：现有 `openai-compatible` adapter 直接可用，只需要：
  - `baseURL = https://api.siliconflow.cn/v1`
  - `model = FunAudioLLM/CosyVoice2-0.5B`
  - `voice = FunAudioLLM/CosyVoice2-0.5B:alex`
- 如果只想增加一个「国内可直连的 OpenAI 兼容 provider」，不需要新代码，改
  patch 配置即可。
- 声音克隆能力取决于具体托管模型（CosyVoice2 支持零样本克隆，但需要通过
  参考音频/接口传参）；首版建议先做普通合成。
