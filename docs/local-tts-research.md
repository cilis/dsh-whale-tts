# 本地 TTS 引擎调研（2026-11 初筛）

> 目的：给 `dsh-whale-tts` 的本地引擎选型提供可落地的对比，而不是做模型 benchmark。  
> 信息时点：2026-11。版本、权重许可证和安装方式在真正接入前必须按官方仓库复核。  
> 评分为工程主观判断（5 分制），用于排序，不替代实测。

## 1. 评估维度

| 维度 | 说明 |
| --- | --- |
| 中文质量 | 普通话自然度、多音字、数字/英文混读、长句稳定性 |
| 克隆/设计 | zero-shot / few-shot 克隆，声音设计，情感控制 |
| CPU 实时性 | 无 GPU 的 Windows 机器能否接近实时 |
| Windows 部署 | 预编译二进制、Python/CUDA 依赖、路径与进程管理 |
| 许可证 | 代码许可证与模型权重许可证分开看；商用/再分发限制 |
| 集成成本 | 是否需要 Python、ONNX runtime、模型转换、G2P |
| 模型体积 | 下载/磁盘占用，是否适合按需安装 |
| 社区活跃度 | 问题可查、文档、更新频率 |

## 2. 结论先行

### 2.1 CPU 本地基线（P2 首选）

**Piper + sherpa-onnx** 作为第一组：

- **Piper**：接入最简单，预编译二进制 + ONNX 声音，CPU 快，适合先跑通「断网也能说话」。
- **sherpa-onnx**：同一个 runtime 能跑 Piper/VITS/Kokoro/Matcha 等多种模型，后续扩展比每家用一套代码更省事。
- **Kokoro**：作为质量升级项；82M 模型，CPU 可跑，中文可用，但 G2P/依赖比 Piper 重。
- **MeloTTS**：MIT、CPU 实时、中文/中英混读不错，作为 Python 侧候选。

建议顺序：**Piper（最快落地）→ sherpa-onnx（统一 runtime）→ Kokoro/Melo（质量升级）**。不要一开始就上 GPU 克隆引擎。

### 2.2 本地克隆（P3 首选）

- **GPT-SoVITS**：中文 few-shot 克隆成熟、社区大、MIT 代码；Windows 部署资料多；GPU 推荐。
- **CosyVoice2**：Apache 许可、zero-shot 克隆、支持流式；质量和工程完整度高，但依赖更重。
- **IndexTTS / IndexTTS2**：情感控制和中英文克隆有特色，作为第三候选。

建议顺序：**GPT-SoVITS → CosyVoice2 → IndexTTS2**。先在 GPU 机器上做 sidecar，不要求所有用户安装。

### 2.3 不建议首期接入

- **Fish Speech / OpenAudio S1-mini**：权重常见 **CC-BY-NC-SA**（非商用），商用分发前必须确认。
- **F5-TTS**：代码 MIT，但常用权重 **CC-BY-NC**，存在同样的商用限制。
- **XTTS-v2**：Coqui Public Model License，非商用；项目维护也已弱化。
- 这些不是「不能用」，而是应作为 **opt-in、带许可证提示** 的 provider，不放进默认安装。

## 3. 对比矩阵

评分：5 = 最好，1 = 最差；「CPU 实时」指普通 4–8 核桌面 CPU 的短句体验。

| 引擎 | 中文 | 克隆/设计 | CPU 实时 | Windows 部署 | 许可证（代码/权重） | 集成成本 | 适合阶段 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Piper** | 3 | 无 | 5 | 5（预编译二进制） | MIT / 声音逐项 | 低 | P2 基线 |
| **sherpa-onnx** | 4 | 部分模型 | 5 | 4（预编译 CLI/库） | Apache-2.0 / 模型逐项 | 中 | P2 runtime |
| **Kokoro-82M** | 4 | 无 | 4 | 3（Python/ONNX + G2P） | Apache-2.0 | 中 | P2 质量项 |
| **MeloTTS** | 4 | 无 | 4 | 3（Python/PyTorch） | MIT | 中 | P2 备选 |
| **GPT-SoVITS** | 4.5 | few-shot 克隆 | 2 | 3（Python/GPU） | MIT / 权重复核 | 高 | P3 克隆 |
| **CosyVoice2** | 4.5 | zero-shot 克隆/流式 | 2 | 2（Python/GPU） | Apache-2.0 / 复核 | 高 | P3 克隆 |
| **IndexTTS2** | 4.5 | 克隆/情感 | 2 | 2（Python/GPU） | Apache-2.0 / 复核 | 高 | P3 备选 |
| **Chatterbox** | 3.5 | 克隆/多语种 | 2 | 3（Python/GPU） | MIT | 高 | P3 备选 |
| **Fish Speech** | 4 | 克隆 | 2 | 3（Python/GPU） | 代码 Apache / 权重 NC | 高 | 观察/非商用 |
| **F5-TTS** | 4 | 克隆 | 2 | 2（Python/GPU） | MIT / 权重 NC | 高 | 观察/非商用 |
| **XTTS-v2** | 3.5 | 克隆 | 2 | 2（Python/GPU） | CPML 非商用 | 高 | 不推荐默认 |
| **Windows SAPI** | 2.5 | 无 | 5 | 5（系统自带） | Windows 组件 | 极低 | 已有回退 |

> 「中文」评分是综合自然度/可用性，不是 MOS 测试；最终必须用同一批中文文本做盲测。

## 4. 分引擎说明

### 4.1 Piper

- **形态**：VITS/ONNX，官方提供 C++ 可执行文件和大量预训练声音。
- **优点**：CPU 快、无 Python、Windows 二进制好部署、模型小；适合「离线保底」。
- **缺点**：中文声音的自然度偏旧，韵律和情感有限；不支持克隆/设计。
- **许可证**：代码 MIT；每个 voice 的许可证不同，必须逐声音记录（有些是 CC-BY，有些限制更多）。
- **接入建议**：先做 `PiperEngine`：`spawn` 白名单二进制，stdin 输入文本，输出 WAV 到临时文件；模型包记录 voice id、语言、许可证、sha256。
- **适合**：P2 的第一个本地引擎，验证模型包/进程/输出契约。

### 4.2 sherpa-onnx

- **形态**：C++/ONNX 运行时 + 预编译 CLI（`sherpa-onnx-offline-tts`），支持 VITS、Piper、Kokoro、Matcha 等模型族。
- **优点**：一个 runtime 覆盖多种模型；CPU 友好；Windows 预编译；生态偏工程化。
- **缺点**：模型配置参数多，声音质量取决于具体模型；不是「一个模型解决所有语言」。
- **许可证**：Apache-2.0；模型逐个核对。
- **接入建议**：把 sherpa 作为 **local runtime 的统一执行器**，Piper/Kokoro 模型都可以通过它跑；adapter 只负责模型配置和参数映射。
- **适合**：P2 的 runtime 层，减少为每个模型写一套推理代码。

### 4.3 Kokoro-82M

- **形态**：82M 参数模型，ONNX/PyTorch，社区有 `kokoro-onnx` 等封装。
- **优点**：体积小、质量/速度平衡好；CPU 可跑；多语言（含中文）；Apache-2.0。
- **缺点**：中文需要 G2P/分词依赖，安装比 Piper 重；不支持克隆；长句/多音字需要额外处理。
- **接入建议**：作为 P2 的「质量升级」引擎，先走 Python/ONNX sidecar，不强行嵌入 DSH 进程。
- **适合**：想要比 Piper 更自然、但不想上 GPU 的用户。

### 4.4 MeloTTS

- **形态**：基于 VITS 的 Python TTS，MIT，支持中/英/日/韩/法/西等。
- **优点**：CPU 实时、中文/中英混读自然、许可证宽松。
- **缺点**：Python/PyTorch 依赖；模型和 G2P 需要一起管理；不支持克隆。
- **接入建议**：和 Kokoro 一样作为 sidecar 候选；如果 Piper 中文质量不够，Melo 是低成本替代。
- **适合**：P2 备选/质量对照。

### 4.5 GPT-SoVITS

- **形态**：Python + PyTorch，few-shot 声音克隆，中文社区非常活跃；有 WebUI/API。
- **优点**：中文克隆质量好、参考音频要求低、MIT 代码、Windows 教程多。
- **缺点**：GPU 推荐；依赖重、启动慢；需要进程/端口/模型管理；合成延迟高于云 API。
- **许可证**：代码 MIT；预训练权重和参考音频的来源/授权要单独确认。
- **接入建议**：P3 第一个克隆 sidecar；统一 `LocalEngine` 接口，模型包记录底模/版本/参考音频。
- **适合**：中文为主的 QQBot/DSH 用户，愿意装 GPU 环境。

### 4.6 CosyVoice2

- **形态**：Python/PyTorch，zero-shot 克隆、跨语种、流式；阿里 FunAudioLLM。
- **优点**：质量和工程完整度高；Apache-2.0；适合做「本地高质量克隆」。
- **缺点**：GPU 依赖明显；安装/模型下载复杂；CPU 不实用。
- **接入建议**：P3 第二候选；如果 GPT-SoVITS 的部署体验太差，CosyVoice2 的 API 化更好管理。
- **适合**：有 GPU、追求克隆质量/流式的用户。

### 4.7 IndexTTS2

- **形态**：Python/PyTorch，zero-shot 克隆 + 情感/时长控制。
- **优点**：中文情感表达和克隆有特色；Apache-2.0（需复核权重）。
- **缺点**：GPU、依赖重、生态比 GPT-SoVITS 小。
- **接入建议**：P3 观察项；等 P2/P3 框架稳定后再评估。
- **适合**：需要情感控制的场景，不是首期必需。

### 4.8 Chatterbox

- **形态**：Resemble AI 的 0.5B 多语种 TTS，MIT，支持克隆。
- **优点**：许可证宽松、多语种、克隆能力。
- **缺点**：中文自然度/社区经验不如中文专用引擎；GPU 更稳；生态较新。
- **接入建议**：如果产品要面向多语种而非中文优先，可列为 P3 备选。
- **适合**：多语种机器人，愿意接受新引擎的试错。

### 4.9 Fish Speech / F5-TTS / XTTS-v2

- **共同点**：克隆质量不错，但权重许可证通常是非商用（CC-BY-NC / CPML）。
- **建议**：不作为默认 provider；如果接入，能力表标注 `license: non-commercial`，设置页显示警告，README 明确「商用需自行取得授权」。
- **优先级**：低于 GPT-SoVITS/CosyVoice2，除非用户明确需要它们的音色/语种。

### 4.10 Windows SAPI

- **形态**：系统自带，PowerShell/COM 调用。
- **优点**：零安装、离线、稳定、极快。
- **缺点**：机械音、中文声音依赖系统安装、无克隆。
- **定位**：保留为最终回退，不参与「质量竞争」。

## 5. 推荐落地顺序

```text
P2A  Piper（最快跑通离线）
      ↓
P2B  sherpa-onnx（统一 runtime，接更多模型）
      ↓
P2C  Kokoro / MeloTTS（质量升级，sidecar）
      ↓
P3A  GPT-SoVITS（中文克隆，GPU sidecar）
      ↓
P3B  CosyVoice2 / IndexTTS2（质量/情感备选）
```

理由：

1. 先用 Piper 验证模型包、进程、输出契约和 Windows 路径，风险最低。
2. 再用 sherpa-onnx 把「多模型」变成 runtime 能力，避免每个模型写一套推理。
3. Kokoro/Melo 是 CPU 质量升级，不阻塞克隆。
4. 克隆引擎统一走 sidecar，不要求所有用户安装 Python/CUDA；只有需要克隆的用户才启用。

## 6. 与现有架构的契合

### 6.1 引擎分类

| 类型 | 引擎 | 接入方式 |
| --- | --- | --- |
| 预编译二进制 | Piper、sherpa-onnx | `spawn` 白名单二进制，临时文件输入输出 |
| Python/ONNX sidecar | Kokoro、MeloTTS | 启动本地 Python 服务或一次性 CLI，127.0.0.1 |
| Python/GPU sidecar | GPT-SoVITS、CosyVoice2、IndexTTS2 | 进程监督 + 端口 + 健康检查，模型常驻 |
| 系统 | SAPI | 现有 PowerShell adapter |

### 6.2 统一接口

所有引擎实现同一个 `TtsProvider`：

```ts
interface TtsProvider {
  id: string
  kind: 'cloud' | 'local' | 'system'
  capabilities: ProviderCapabilities
  synthesize(req, config, runtime): Promise<SynthesisResult>
  listVoices?(): Promise<VoiceDescriptor[]>
  healthCheck?(): Promise<HealthResult>
}
```

本地引擎额外需要：

```ts
interface LocalEngineRuntime {
  engine: EngineDescriptor
  hardware: HardwareProfile
  process: ProcessSupervisor
  models: ModelPackManager
}
```

### 6.3 不建议首期做的事

- 不把 ONNX runtime 直接嵌进 DSH 进程：native addon 的 ABI/打包/Windows 编译风险高。
- 不为每个引擎写一套独立缓存/输出逻辑：复用现有 `TtsService`。
- 不在 npm 包里带模型权重：模型包按需安装，带 sha256/许可证。
- 不默认自动下载模型：首次安装必须用户确认来源和体积。

## 7. 硬件与部署建议

| 场景 | 建议 |
| --- | --- |
| 无 GPU、只求离线 | Piper / sherpa-onnx；4 核 CPU、8GB RAM 足够短句 |
| 无 GPU、追求更好中文 | Kokoro 或 MeloTTS sidecar；仍可实时或接近实时 |
| 有 NVIDIA GPU、要克隆 | GPT-SoVITS / CosyVoice2；建议 ≥8GB VRAM，Windows CUDA |
| 只有 CPU、要克隆 | 不推荐本地克隆；用云端克隆 API，或接受较慢的 GPT-SoVITS CPU |
| 多语种 | Chatterbox/Kokoro 观察；中文优先仍选中文专用引擎 |

## 8. 许可证风险清单

| 引擎 | 风险点 | 处理 |
| --- | --- | --- |
| Piper | 每个 voice 的许可证不同 | 模型包逐项记录 `license`，安装时显示 |
| Kokoro | 模型 Apache-2.0，但依赖/G2P 可能另有许可证 | 记录依赖清单 |
| GPT-SoVITS | 代码 MIT；预训练权重/参考音频来源 | 只使用官方发布权重；参考音频由用户负责 |
| CosyVoice2 | 代码/权重许可证需按版本复核 | 接入前读模型卡 |
| Fish/F5/XTTS | 权重非商用 | 默认不安装；标记 `non-commercial` |
| 本地模型 | 数据集/声音肖像权 | README 明确用户责任；不内置名人声音 |

## 9. 待验证问题

1. Piper 中文声音在目标文本上的自然度是否可接受？需要同一批短句盲测。
2. Kokoro 中文 G2P 在 Windows 上的安装复杂度；是否需要 Python 环境。
3. sherpa-onnx 的模型配置能否覆盖 Piper/Kokoro，减少 runtime 数量。
4. GPT-SoVITS 在目标 GPU 上的启动时间、显存、首句延迟。
5. CosyVoice2 的流式能力是否值得为 QQBot 引入。
6. 商用分发是否必须；若是，Fish/F5/XTTS 直接排除默认安装。
7. 模型下载来源（HuggingFace/GitHub）在目标网络环境是否可用；是否需要镜像/手动放置。

## 10. 对产品规划的影响

- P2 拆成 **P2A Piper**、**P2B sherpa-onnx**、**P2C 质量升级**，每步都可独立验收。
- P3 只承诺 **一个** 克隆引擎（GPT-SoVITS）端到端，CosyVoice2/IndexTTS2 作为后续。
- 能力表新增字段：`kind`、`local`、`license`、`hardware.requiresGpu`、`modelPackId`。
- README 本地章节必须写清：模型来源、许可证、安装体积、CPU/GPU 要求、卸载方式。
- 不把本地模型放进 npm 包或 GitHub Release；只放 manifest 和安装器。
