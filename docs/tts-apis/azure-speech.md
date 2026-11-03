# Azure AI Speech TTS REST API

> 最后核对：2026-11-03
> 官方文档：
> - REST TTS：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
> - 语言/音色支持：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support
> - 语音列表 API：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech#get-a-list-of-voices

## 1. 能力概览

- 微软神经语音（Neural Voices），覆盖大量语言/方言；支持 SSML 控制语速、
  音高、音量、风格、角色、多音字、停顿等。
- **输入是 SSML**，不是纯 `text` 字段；这是它和其他 API 最大的区别。
- 输出格式通过 `X-Microsoft-OutputFormat` 选择，例如
  `audio-24khz-48kbitrate-mono-mp3`、`riff-24khz-16bit-mono-pcm`。
- 自定义神经语音（Custom Neural Voice）是单独的建模/部署流程。

## 2. 端点与认证

区域端点（常见）：

```http
POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
```

自定义子域端点（控制台里显示为准）：

```http
POST https://{resource-name}.cognitiveservices.azure.com/tts/cognitiveservices/v1
```

认证二选一：

```http
Ocp-Apim-Subscription-Key: <Speech resource key>
```

或先换 10 分钟有效的 token：

```http
POST https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken
Ocp-Apim-Subscription-Key: <key>
```

然后：

```http
Authorization: Bearer <token>
```

## 3. 请求

```http
POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
Ocp-Apim-Subscription-Key: <key>
Content-Type: application/ssml+xml
X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3
User-Agent: dsh-whale-tts
```

Body（SSML）：

```xml
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
       xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">
  <voice name="zh-CN-XiaoxiaoNeural">
    <mstts:express-as style="cheerful">
      你好，我是育木的小鲸鱼。
    </mstts:express-as>
  </voice>
</speak>
```

常用 SSML 能力：

- `<prosody rate="-10%" pitch="+2st" volume="+0%">` 语速/音高/音量
- `<break time="500ms"/>` 停顿
- `<mstts:express-as style="...">` 风格（取决于音色）
- `<mstts:silence type="Leading" value="100ms"/>` 前后静音

## 4. 响应

- `200`：响应体是音频二进制，`Content-Type` 对应请求的输出格式。
- `400`：SSML 非法/音色不支持；`401` Key/token 错误；`429` 限流。
- 单次 SSML 有大小限制（约 64 KB）；长文本应分段请求。

## 5. 音色列表

```http
GET https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list
Ocp-Apim-Subscription-Key: <key>
```

返回 JSON 数组（`ShortName`、`Locale`、`Gender`、`StyleList` 等）。插件的
统一下拉可从中生成 `voices`。

## 6. 接入 dsh-whale-tts 的建议

- 需要新的 `azure` adapter：JSON → 拼 SSML；不能复用 OpenAI 适配器。
- Key 引用：`AZURE_SPEECH_KEY`；另外需要 `region`（或 custom endpoint）。
- 输出格式建议 `audio-24khz-48kbitrate-mono-mp3`，与现有 mp3 播放链路兼容。
- 文本要 XML 转义，且插件侧清洗 Markdown 后应再转义 `<>&"`。
- 语音克隆（Custom Neural Voice）需要 Azure 审批和单独建模，不建议首版做。
