# dsh-whale-tts 输出接口 v1

> 文档版本：1.0（2026-11-09）  
> 适用插件：`dsh-whale-tts` 0.5.x  
> 状态：**当前可用契约**。本文描述的是插件已经返回的字段，不把「计划中」的字段写成已实现。

这份文档给两类读者：

- 要在 DSH 里调用 TTS 的 agent / 机器人；
- 要接 QQBot 或自建流程的开发者。

先记住一句话：**插件只生成音频文件并返回路径，不播放、不发送、不上传。**

## 1. 接入方式（当前）

| 接入方 | 当前方式 | 说明 |
| --- | --- | --- |
| DSH agent | 原生工具 `tts_synthesize` / `tts_list_voices` / `tts_status` | 推荐；工具返回规范 JSON |
| QQBot | agent 调 `tts_synthesize`，再把 `relativePath` 交给 `qq_send_voice` | 桥接不直接调 TTS；文本与时机由 agent 决定 |
| 其他机器人 | 通过 DSH agent / 工具调用 | 目前**没有**公开 HTTP 接口；HTTP facade 规划在 P4 |

不要在未确认版本的情况下假设存在 `/tts/v1/*` HTTP 端点。当前版本没有。

## 2. 公共约定

- 文本是 UTF-8；返回值是 JSON 对象。
- `format` 只有 `wav` / `mp3`。
- `path` 是绝对路径；`relativePath` 相对 `output.dir`，使用 `/` 分隔符；`file` 只有文件名。
- 插件不主动删除输出文件；缓存清理只影响 `cache.dir`。
- 错误消息不包含 API key、完整文本或参考音频内容。
- 工具失败时按 DSH 工具协议抛错；RPC 设置卡使用稳定错误码（见 §6）。其他消费者不要把错误当成功结果解析。

## 3. `tts_synthesize`

### 3.1 参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 已清洗的口语文本；长度受 `limits.maxChars` |
| `provider` | string | 否 | 临时覆盖 provider id；缺省用当前配置 |
| `voice` | string | 否 | 临时覆盖音色 id；缺省用当前档案/配置 |
| `format` | `wav` \| `mp3` | 否 | 临时覆盖格式；provider 不支持时回退 |
| `style` | string | 否 | 自然语言风格指令；仅部分 provider 支持 |
| `filename` | string | 否 | 不含扩展名的文件名模板；支持 `{timestamp}` / `{rand}` |

最小调用：只传 `text`。

### 3.2 返回

```json
{
  "ok": true,
  "path": "E:\\DeepSeek Harness\\QQBot\\qq-bridge\\audio\\tts-20261109-001122-a1b2c3.wav",
  "relativePath": "tts-20261109-001122-a1b2c3.wav",
  "file": "tts-20261109-001122-a1b2c3.wav",
  "format": "wav",
  "provider": "mimo",
  "voice": "苏打",
  "cached": false,
  "bytes": 482133,
  "elapsedMs": 1830
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | `true` | 成功标志 |
| `path` | string | 绝对路径 |
| `relativePath` | string | 相对 `output.dir`，POSIX `/` |
| `file` | string | 纯文件名 |
| `format` | `wav`/`mp3` | 实际输出格式 |
| `provider` | string | 实际使用的 provider id |
| `voice` | string | 实际使用的音色/样本标识 |
| `cached` | boolean | 是否命中缓存 |
| `bytes` | integer | 文件字节数 |
| `elapsedMs` | integer | 插件处理耗时（毫秒） |

### 3.3 文件语义

- 调用方拥有返回的文件；可以复制、移动、删除。
- 插件不会因为下一次合成而删除旧文件；只有缓存目录会按策略清理。
- 同名冲突不会覆盖已有文件；插件会生成唯一文件名。
- QQBot 场景下，`relativePath` 必须位于 `qq-bridge/audio/` 内，否则 `qq_send_voice` 会拒绝。最稳的配置是把 `output.dir` 指到该目录。

## 4. `tts_list_voices`

无参数，不联网、不读密钥。返回：

```json
{
  "providers": [
    {
      "id": "mimo",
      "capabilities": {
        "speech": true,
        "singing": false,
        "formats": ["wav", "mp3"],
        "voices": [{ "id": "苏打", "label": "苏打" }],
        "requiresKey": true,
        "voiceDesign": true,
        "voiceClone": true
      },
      "voices": [{ "id": "苏打", "label": "苏打" }]
    }
  ],
  "profiles": [
    {
      "id": "vp_abc123",
      "name": "AI 自设",
      "kind": "clone",
      "provider": "mimo",
      "sampleFile": "…",
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-01T00:00:00.000Z"
    }
  ],
  "activeProfileId": "vp_abc123"
}
```

关键字段：

- `capabilities.formats`：provider 支持格式，首个是默认。
- `capabilities.voices` / `voices`：内置音色；自定义 Voice ID 不在列表里，但 `tts_synthesize.voice` 可以传。
- `capabilities.requiresKey`：是否需要凭据。
- `capabilities.voiceDesign` / `voiceClone`：是否支持声音设计/克隆。
- `profiles[].provider`：档案绑定的 provider；老档案可能没有该字段（未绑定）。
- `activeProfileId`：当前激活档案；`null` 表示使用 provider 默认音色。

## 5. `tts_status`

无参数，不返回密钥和文本。返回：

```json
{
  "provider": "mimo",
  "fallback": ["sapi"],
  "providers": {
    "mimo": {
      "configured": true,
      "enabled": true,
      "keyRequired": true,
      "keyConfigured": true,
      "keyType": "token-plan",
      "keyRef": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
      "available": true,
      "selectable": true,
      "model": "…",
      "voice": "苏打",
      "baseURL": "https://token-plan-cn.xiaomimimo.com/v1"
    }
  },
  "activeProfileId": "vp_abc123",
  "activeVoice": "AI 自设",
  "cache": { "enabled": true, "files": 2, "bytes": 812345 },
  "outputDir": "E:\\DeepSeek Harness\\QQBot\\qq-bridge\\audio",
  "platform": "win32",
  "preflight": {
    "exists": true,
    "writable": true,
    "looksLikeQqbotAudio": true
  }
}
```

`preflight` 是给 QQBot 接入用的轻量自检：

- `exists`：`output.dir` 当前是否为已存在目录；
- `writable`：目录或父目录是否可写；
- `looksLikeQqbotAudio`：路径是否形如 `<qq-bridge>/audio`（仅为提示，不是硬性校验）；
- `warning`：可读的告警；没有问题时省略。

`tts_status` 只做本地检查，不发起网络请求。

## 6. 错误与失败

### 6.1 工具调用

`tts_synthesize` 失败时按 DSH 工具协议返回错误（`isError`），不会返回一个假装成功的 JSON。常见失败：

- 文本为空/超长；
- provider 未配置凭据；
- provider 超时/限流/服务端错误；
- 回退链全部失败（错误消息会包含 provider 尝试摘要）。

### 6.2 设置卡 RPC

设置卡通过 `/dsh-whale-tts` RPC 访问 host，失败返回：

```json
{
  "ok": false,
  "error": {
    "code": "tts/key-missing",
    "message": "credential \"SILICONFLOW_API_KEY\" is not configured",
    "details": {}
  }
}
```

稳定 code：

| code | 含义 |
| --- | --- |
| `tts/bad-request` | 参数/配置非法 |
| `tts/not-found` | 资源不存在 |
| `tts/conflict` | 配置 revision 冲突 |
| `tts/key-missing` | 凭据缺失/认证失败 |
| `tts/provider` | provider 侧失败（限流、超时、服务端） |
| `tts/unsupported` | 平台/能力不支持 |
| `tts/not-implemented` | 未实现 |
| `tts/aborted` | 调用被取消 |
| `tts/internal` | 未知内部错误 |

**不要依赖 `message` 做分支**；它是给人看的，可能变化。分支请用 `code`。

## 7. 接入示例

### 7.1 DSH agent

```text
调用 tts_synthesize(text="你好，我是育木的小鲸鱼。")
→ 读取返回的 relativePath
→ 交给需要的投递工具（例如 QQBot 的 qq_send_voice）
```

不要播放/发送/上传；这些不属于本插件。

### 7.2 QQBot

当前链路：

```text
QQ 消息 → qq-bridge 唤醒 DSH qqbot agent
→ agent 调 tts_synthesize
→ 插件写 <qq-bridge>/audio
→ agent 调 qq_send_voice(file=relativePath)
→ 桥接 → SnowLuma → SILK → QQ 语音条
```

配置要求：

- `whale-tts.output.dir` 指向 `qq-bridge/audio`；
- `limits.maxChars` 建议 ≤ 120；
- 先用 `tts_status` 看 `preflight`，不要等发送时才排查路径。

### 7.3 其他机器人

当前没有独立 HTTP 入口。可选做法：

1. 在 DSH 中安装本插件，通过 agent 工具调用；
2. 等待 P4 的 loopback HTTP facade（会复用同一 service 和本文契约）；
3. 不要把本插件的内部 RPC `/dsh-whale-tts` 当成公开 API——它是设置卡通道，可能随 UI 变化。

## 8. 兼容与版本

- 现有字段视为 v1 稳定字段；新增字段应是 additive。
- 消费者应忽略未知字段，不要用 `additionalProperties: false` 去拒绝未来字段。
- 字段删除/语义变化会走 v2，并至少提前一个 minor 版本说明。
- `tts_list_voices` 的 `capabilities` 可能新增能力字段；不要假设只有当前列出的字段。
- `tts_status.preflight` 是可选增强；不存在时按旧版处理。

**关于 `schemaVersion`**：当前工具结果尚未带版本字段；本文的「v1」是文档契约版本。后续新增 `schemaVersion` 时会保持旧字段不变，消费者应允许它出现。

## 9. 最小接入 checklist

- [ ] 调用 `tts_status`，确认当前 provider 可用、key 已配置。
- [ ] 确认 `output.dir` 可写；QQBot 场景确认它等于/位于 `qq-bridge/audio`。
- [ ] 调用 `tts_list_voices`，确认目标 provider/音色存在。
- [ ] 调用 `tts_synthesize`，只依赖 `path` / `relativePath` / `file` / `format` / `provider` / `voice` / `cached` / `bytes` / `elapsedMs`。
- [ ] 失败时按工具错误处理；设置卡 RPC 按 `code` 处理。
- [ ] 不要在本插件之外假设 HTTP 端点存在。

---

相关文档：

- [产品规划](product-plan.md)
- [本地引擎调研](local-tts-research.md)
- [Provider 说明](providers.md)
