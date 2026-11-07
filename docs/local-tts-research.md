# 本地 TTS 引擎调研（2026-11 复核版）

> 信息时点：2026-11-07。以下版本、许可和能力已按官方仓库/模型卡复核；真正接入前仍需按你锁定的版本再核一次。
> 评分为工程主观判断（5 分制），用于排序，不替代同一批文本的盲测。

## 0. 本次复核改变了的结论

1. **Piper 不能直接打包了**：原 `rhasspy/piper` 已归档；当前维护库是
   [`OHF-Voice/piper1-gpl`](https://github.com/OHF-Voice/piper1-gpl)，许可证是
   **GPL-3.0**。如果本插件继续保持 MIT/Apache 分发，不应把 `piper1-gpl` 的二进制或代码
   直接 bundle 进来。更稳的做法是用 **sherpa-onnx（Apache-2.0）** 运行 Piper 格式模型，
   或把 Piper 作为用户自行安装的外部可选依赖。
2. **CPU 本地克隆不再是空白**：[ZipVoice](https://github.com/k2-fsa/ZipVoice) 只有 123M，
   Apache-2.0，中英文 zero-shot 克隆，支持 ONNX CPU；sherpa-onnx 已集成它的 CPU 部署。
   这比“CPU 只能跑非克隆模型，克隆必须 GPU”更乐观。
3. **Qwen3-TTS 已开源**（2026-01）：0.6B/1.7B，Apache-2.0，10 种语言，支持 3 秒克隆、
   voice design 和流式；是本地高质量/克隆的重要候选，但需要 GPU。
4. **IndexTTS 不是 Apache**：IndexTTS-2.5 使用 **bilibili Model Use License**，有商用门槛
   （如月活 >1 亿或年收入 >10 亿元需单独授权），不能按 Apache 处理。
5. **Chatterbox、Supertonic 已归档**：可以研究/复用，但不适合作为新接入的长期依赖。
6. **Fish Speech 的许可也变了**：当前是 **Fish Audio Community License**，S2-Pro 权重是
   research license，不是简单的 Apache/CC 许可；首期不要默认接。

## 1. 评估维度

| 维度 | 说明 |
| --- | --- |
| 中文质量 | 普通话自然度、多音字、数字/英文混读、长句稳定性 |
| 克隆/设计 | zero-shot / few-shot 克隆、声音设计、情感/语速控制 |
| CPU 实时性 | 无 GPU 的 Windows 机器能否接近实时 |
| GPU 门槛 | 显存、CUDA、Python 依赖、启动时间 |
| Windows 部署 | 预编译二进制、Python/CUDA 依赖、路径与进程管理 |
| 许可证 | 代码许可证与模型权重许可证分开看；商用/再分发限制 |
| 集成成本 | 是否需要 Python、ONNX runtime、模型转换、G2P |
| 维护状态 | 是否活跃、是否归档、是否有长期支持 |

## 2. 对比矩阵

评分：5 = 最好，1 = 最差；「CPU」指普通 4–8 核桌面 CPU 的短句体验。

| 引擎 | 规模 | 中文 | 克隆/设计 | CPU | GPU 门槛 | 许可证（代码/权重） | 集成成本 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **sherpa-onnx** | runtime | 4 | 取决于模型 | 5 | 无 | Apache-2.0 | 中 | P2 首选 runtime |
| **ZipVoice** | 123M | 4 | zero-shot 克隆 | 4 | 可选 | Apache-2.0 | 中 | P2 CPU 克隆首选 |
| **Kokoro-82M** | 82M | 4 | 无 | 4.5 | 无 | Apache-2.0 | 中 | P2 CPU 质量项 |
| **MeloTTS** | ~? | 4 | 无 | 4 | 无 | MIT | 中 | P2 备选 |
| **GPT-SoVITS** | 1B 级 | 4.5 | few-shot 克隆 | 2.5 | 4–8GB | MIT | 中高 | P3 实用克隆 |
| **CosyVoice3** | 0.5B | 4.5 | zero-shot/流式 | 1.5 | 6–8GB | Apache-2.0 | 高 | P3 中文/方言 |
| **Qwen3-TTS** | 0.6B/1.7B | 4.7 | 克隆/设计/流式 | 1 | 6–12GB | Apache-2.0 | 高 | P3 质量首选 |
| **VoxCPM2** | 2B | 4.5 | 克隆/设计 | 2（GGUF） | ~8GB | Apache-2.0 | 高 | P3 多语种 |
| **IndexTTS2.5** | 0.8B | 4.5 | 克隆/情感 | 1 | 6–8GB | bilibili 自定义 | 高 | 仅许可可接受时 |
| **Chatterbox** | 0.5B / 110M Nano | 3.5 | 克隆 | 4（Nano） | 可选 | MIT（已归档） | 中 | 不推荐新接入 |
| **Fish Speech** | 4B/35B | 4.5 | 克隆/多角色 | 1 | 高 | Fish Audio 社区/研究许可 | 很高 | 不默认接 |
| **F5-TTS** | 0.3B | 4 | 克隆 | 1 | 4–6GB | MIT / CC-BY-NC | 高 | 仅非商用 |
| **XTTS-v2** | 0.5B | 3.5 | 克隆 | 1 | 4–6GB | CPML 非商用 | 高 | 不推荐默认 |
| **Supertonic** | 99M | 3.5 | 无官方克隆 | 5 | 无 | MIT / OpenRAIL-M（已归档） | 中 | 不推荐新接入 |
| **Windows SAPI** | 系统 | 2.5 | 无 | 5 | 无 | Windows 组件 | 极低 | 最终回退 |

> 「中文」是综合自然度/可用性判断，不是 MOS 测试；最终必须用同一批中文文本盲测。

## 3. 逐个引擎说明

### 3.1 sherpa-onnx（推荐作为 CPU runtime）

- 官方：[k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- 版本：v2.0.1（2026-10-26），Windows / Node.js / Python / C++ 等 12 种语言接口。
- 优点：Apache-2.0；预编译 CLI；一个 runtime 支持 VITS、Piper、Kokoro、Matcha、ZipVoice 等；
  CPU 友好；不要求 Python。
- 缺点：模型配置参数多；不同模型质量差异大；需要自己管理模型包。
- 建议：**P2 的底座**。用 `sherpa-onnx-offline-tts` 做 sidecar/CLI，避免把 ONNX runtime
  以 native addon 形式嵌进 DSH 进程。

### 3.2 ZipVoice（CPU 克隆的关键候选）

- 官方：[k2-fsa/ZipVoice](https://github.com/k2-fsa/ZipVoice)
- 规模：123M；Apache-2.0；中英文 zero-shot；支持 ONNX CPU（INT8 可选）和 TensorRT。
- 优点：小、快、许可证宽松；参考音频短（建议 <3 秒）；sherpa-onnx 有 CPU 部署示例。
- 缺点：只支持中英文；对话/多说话人不是首期目标；质量/相似度不如 1.7B 级模型。
- 建议：**P2 先做 ZipVoice 的中文短句克隆**，验证「CPU 也能克隆」；如果质量不够，
  P3 再上 Qwen3-TTS/GPT-SoVITS。

### 3.3 Kokoro-82M

- 官方：[hexgrad/kokoro](https://github.com/hexgrad/kokoro)
- 规模：82M；Apache-2.0 权重；中文 `lang_code='z'`，需要 `misaki[zh]`；Windows 需 espeak-ng。
- 优点：质量/体积/速度平衡好；CPU 可用；许可证宽松。
- 缺点：不支持克隆/设计；中文 G2P 依赖比 Piper 重；长句需要分段。
- 建议：P2 的「CPU 质量升级」；先 Python sidecar，不强行嵌进程。

### 3.4 MeloTTS

- 官方：[myshell-ai/MeloTTS](https://github.com/myshell-ai/MeloTTS)
- 许可证：MIT；支持中英混读；官方称 CPU real-time。
- 优点：许可证最宽松；中文/中英混读自然；CPU 可跑。
- 缺点：Python/PyTorch 依赖；不支持克隆；项目更新较慢。
- 建议：P2 备选/对照；如果 Kokoro 中文 G2P 安装麻烦，MeloTTS 是低成本替代。

### 3.5 GPT-SoVITS

- 官方：[RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)
- 许可证：MIT；当前主线已到 **v5**（2026-10）；支持中/英/日/韩/粤；Windows 有整合包。
- 性能：官方给出 v2 ProPlus RTF 0.028（4060Ti）、0.014（4090）、**0.526（M4 CPU）**；
  CPU 可跑但慢。
- 优点：中文 few-shot 克隆成熟、社区大、Windows 资料多；MIT。
- 缺点：Python/CUDA 依赖；启动/模型管理重；CPU 体验一般；参考音频/权重来源要合规。
- 建议：P3 的「中文克隆实用派」；如果用户已经有 Windows + NVIDIA，这是最稳的落地方案之一。

### 3.6 CosyVoice3

- 官方：[QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice)（原 FunAudioLLM）
- 许可证：Apache-2.0；CosyVoice3-0.5B（2025-12）；9 种语言、18+ 中文方言/口音；
  zero-shot 克隆、流式（官方称低至 150ms）。
- 优点：中文/方言强；流式；Apache；工程完整度高。
- 缺点：GPU 依赖；安装/模型下载复杂；CPU 不实用。
- 建议：P3 的「中文方言/流式」候选；如果 Qwen3-TTS 的安装太重，CosyVoice3 是替代。

### 3.7 Qwen3-TTS

- 官方：[QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)
- 许可证：Apache-2.0；0.6B/1.7B；10 种语言；3 秒克隆、voice design、流式（官方称 97ms）。
- 优点：中文/多语种质量强；能力最全（克隆/设计/流式）；Apache；vLLM-Omni 支持。
- 缺点：GPU（CUDA/FlashAttention）门槛；1.7B 显存更高；安装依赖重；不是 CPU 方案。
- 建议：**P3 质量首选**；先做 0.6B sidecar，1.7B 作为高质量档位。

### 3.8 VoxCPM2

- 官方：[OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM)
- 许可证：Apache-2.0；2B；30 种语言；voice design/克隆；48kHz；~8GB VRAM；
  RTF ~0.3（4090）；也提供 GGUF/llama.cpp CPU 路径，但 CPU 更慢。
- 优点：多语种、音质高、设计/克隆都有；Apache。
- 缺点：2B 较重；CPU 体验一般；生态较新。
- 建议：P3 多语种候选；中文优先时排在 Qwen3-TTS/CosyVoice3 之后。

### 3.9 IndexTTS2.5

- 官方：[index-tts/index-tts](https://github.com/index-tts/index-tts)
- 许可证：**bilibili Model Use License**（自定义，非 Apache）。有商用门槛/高风险用途限制；
  商用合作需联系官方。
- 规模：0.8B；中/英/日/西/阿；克隆 + 情感/时长控制；GPU。
- 建议：只有用户明确接受该许可证时才接；不作为默认 provider。

### 3.10 已归档/不推荐新接入

- **Chatterbox**：MIT，但官方 2026-08 宣布停止维护；V3 支持 23+ 语言（含中文），
  Nano 110M 可 CPU 3x realtime。适合研究/备选，不适合长期依赖。
- **Supertonic 3**：99M、ONNX CPU、31 语言，但仓库已归档；权重 OpenRAIL-M；
  无官方克隆管线。许可证/维护状态都不适合默认接。
- **Fish Speech**：当前是 Fish Audio Community License，S2-Pro 权重是 research license；
  Drama 3 35B-A3B 很重。除非用户明确需要，否则不首期接。
- **F5-TTS**：代码 MIT，权重 CC-BY-NC（非商用）。
- **XTTS-v2**：Coqui Public Model License，非商用；项目维护弱。
- **Windows SAPI**：保留最终回退，不参与质量竞争。

## 4. 推荐落地顺序（修订版）

```text
P2A  sherpa-onnx（Apache runtime，Windows CLI）
      ├─ Kokoro（CPU 质量）
      ├─ MeloTTS（备选/中英混读）
      └─ ZipVoice（CPU 中英文克隆）
      ↓
P3A  Qwen3-TTS 0.6B（Apache，质量/克隆/设计/流式）
      ↓
P3B  CosyVoice3 / VoxCPM2 / GPT-SoVITS（按用户硬件和语言选）
      ↓
P3C  IndexTTS2.5（仅许可证可接受时）/ 其他非商用引擎（默认关闭）
```

### 4.1 为什么 CPU 先做 sherpa，而不是先打包 Piper

- `piper1-gpl` 是 GPL-3.0，直接 bundle 会让本插件的分发许可复杂化；
- 原 MIT 的 `rhasspy/piper` 已归档，继续用旧代码有维护/安全问题；
- sherpa-onnx 是 Apache-2.0，能跑 Piper 格式模型，也能跑 Kokoro/ZipVoice，等于
  「一个 runtime 覆盖多种模型」，比为 Piper 单独写一套更划算。

### 4.2 为什么 CPU 克隆先做 ZipVoice，而不是 GPT-SoVITS

- ZipVoice 123M、Apache、ONNX CPU、中英文；GPT-SoVITS CPU 虽能跑，但依赖重、速度慢；
- 先用 ZipVoice 验证「CPU 克隆」的产品价值，再决定是否投入 GPU 克隆；
- 如果 ZipVoice 质量不够，P3 再上 Qwen3-TTS 0.6B/GPT-SoVITS。

### 4.3 为什么 P3 质量首选 Qwen3-TTS

- Apache-2.0，商用友好；
- 0.6B/1.7B 两档，可按显存选；
- 中文 + 9 门外语、克隆、设计、流式都有；
- 缺点是需要 GPU/Python，适合作为「高质量本地档位」，不是默认档位。

## 5. 硬件与部署建议

| 场景 | 建议 |
| --- | --- |
| 无 GPU、只求离线 | sherpa-onnx + Kokoro/MeloTTS；短句可实时 |
| 无 GPU、要克隆 | ZipVoice（123M，ONNX CPU）；质量预期低于 GPU 大模型 |
| GPU 6–8GB | Qwen3-TTS 0.6B、CosyVoice3、GPT-SoVITS、IndexTTS2.5 |
| GPU 8–12GB | Qwen3-TTS 1.7B、VoxCPM2；更稳 |
| 多语种 | VoxCPM2 / Qwen3-TTS；中文优先仍选 Qwen3-TTS/CosyVoice3 |
| 不想装 Python | sherpa-onnx CLI + ZipVoice/Kokoro ONNX；GPU 引擎都需要 Python/CUDA |

## 6. 对架构的影响

### 6.1 本地 runtime 分两类

| 类型 | 引擎 | 接入方式 |
| --- | --- | --- |
| ONNX/CLI | sherpa-onnx、ZipVoice、Kokoro（ONNX） | 白名单二进制/CLI，临时文件输入输出 |
| Python/GPU sidecar | GPT-SoVITS、CosyVoice3、Qwen3-TTS、VoxCPM2、IndexTTS2.5 | 进程监督 + 端口 + 健康检查，模型常驻 |

### 6.2 能力表新增字段

```ts
interface LocalCapabilities {
  kind: 'local'
  license: 'apache-2.0' | 'mit' | 'gpl-3.0' | 'non-commercial' | 'custom' | 'unknown'
  licenseNote?: string
  paramsMillions?: number
  requiresGpu: boolean
  minVramGb?: number
  streaming: boolean
  clone: boolean
  design: boolean
  modelPackId?: string
}
```

- `license` 必须参与 UI/路由：非商用/自定义许可默认不自动启用。
- GPL 组件单独标记为 `external`，不进入插件 bundle；由用户显式安装。
- 模型包 manifest 记录来源、sha256、许可证、参数、显存、语言。

### 6.3 不建议首期做

- 不把 ONNX runtime 以 native addon 嵌入 DSH 进程；
- 不把 `piper1-gpl` 二进制打进 npm 包；
- 不默认下载模型/权重；
- 不在同一版同时接多个 GPU 引擎；先做一个端到端。

## 7. 许可证风险清单（复核后）

| 引擎 | 风险 | 处理 |
| --- | --- | --- |
| Piper (`piper1-gpl`) | GPL-3.0；原 MIT 仓库已归档 | 不 bundle；外部可选安装，或改用 sherpa 跑 Piper 模型 |
| Piper voices | 每个 voice 许可不同 | 逐声音记录，安装时展示 |
| ZipVoice | Apache-2.0 | 可用；保留版权/NOTICE |
| Kokoro | Apache-2.0 权重 | 可用；核依赖 G2P 许可 |
| MeloTTS | MIT | 可用 |
| GPT-SoVITS | 代码 MIT；权重/参考音频来源 | 只用官方权重；用户对参考音频负责 |
| CosyVoice3 | Apache-2.0 | 可用；核模型卡 |
| Qwen3-TTS | Apache-2.0 | 可用；核模型卡 |
| VoxCPM2 | Apache-2.0 | 可用；核模型卡 |
| IndexTTS2.5 | bilibili 自定义许可；商用门槛 | 默认关闭；用户确认后启用 |
| Chatterbox | MIT，但已归档 | 不推荐新接入；如用需自担维护 |
| Supertonic | OpenRAIL-M，已归档 | 默认不接 |
| Fish Speech | 社区/研究许可 | 默认不接；需单独评估 |
| F5-TTS | 权重 CC-BY-NC | 仅非商用；默认关闭 |
| XTTS-v2 | CPML 非商用 | 默认关闭 |

## 8. 待验证问题

1. ZipVoice 在目标 Windows CPU 上的中文自然度/RTF，是否达到 QQBot 短句可接受水平。
2. Kokoro 中文 G2P 在 Windows 的安装复杂度；是否值得作为默认 CPU 音质档。
3. Qwen3-TTS 0.6B 在 6–8GB 显存上的首句延迟、显存峰值、流式可用性。
4. GPT-SoVITS v5 的 Windows 整合包/API 是否能在 DSH 子进程模型下稳定运行。
5. CosyVoice3 的方言/流式是否比 Qwen3-TTS 更适合中文 QQBot。
6. 商用分发是否必须；若是，IndexTTS/Fish/F5/XTTS 直接排除默认安装。
7. 用户是否接受 Python/CUDA；若不接受，P3 只能停留在 ZipVoice/Kokoro 级别。

## 9. 需要确认的决策

1. **商用/再分发**：是否要求插件及其默认模型全部允许商用？如果是，排除 IndexTTS、Fish、F5、XTTS，并避免 bundle GPL Piper。
2. **硬件范围**：只支持 CPU，还是允许 GPU/Python？只 CPU 的话，P3 的高质量克隆不做，主打 ZipVoice/Kokoro。
3. **克隆质量优先级**：ZipVoice（CPU、轻）够用，还是必须 Qwen3-TTS/GPT-SoVITS 级别？
4. **Piper 处理**：接受“sherpa 跑 Piper 模型”，还是坚持用 Piper 官方二进制（需接受 GPL/外部依赖）？
5. **P2 首个引擎**：sherpa + Kokoro，还是 sherpa + ZipVoice 先验证克隆？

确认后我再更新路线图（P2/P3）和具体任务；在确认前不改实现代码。
