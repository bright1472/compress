# WebCodecs 极速引擎：硬件加速管线修复方案

## 目标
实现 2MB 级视频“秒压”、100MB+ 视频“极速压”，通过“WebCodecs 硬件加速”+“WASM-SIMD 多线程补丁”的双维方案，冲击网页端压缩性能天花板。

## 侧端模型与多维度方案建议 (Elite Architect Perspective)
针对您提到的侧端模型（Sidecar），从第一性原理出发，我们可建立如下“降维打击”梯队：
1. **L1 (Web Native)**: 修复 WebCodecs 硬件管线（当前重点）。这是网页端最快方案（10x 提升）。
2. **L2 (WASM SIMD)**: 将 FFmpeg 引擎升级为支持 SIMD 指令集与多线程的底层构建，使“备用引擎”速度翻倍。
3. **L3 (Desktop Sidecar)**: 引入 Tauri 包装器（参考 Slim-Video）。这是终极方案，可直接调用显卡原厂驱动（NVENC），彻底无视浏览器沙盒限制。

## 当前核心痛点分析
1. **解析器时序错误 (Race Condition)**：对于小文件，数据读取极快，导致 `mp4box` 在 `onReady` 尚未触发前就已经接收了全部数据并执行了 `flush`，造成样本丢失。
2. **解码器初始化失效**：如果无法正确提取 H.264/H.265 的 `avcC/hvcC` 描述符（SPS/PPS），`VideoDecoder` 将无法启动。
3. **进度显示误导**：当前的“读取 50% / 编码 50%”模型会将读取速度误导为压缩速度。

## 方案设计

### 1. [Worker] 严格流式驱动重构
重构 `media-worker.ts` 的 `runPipeline` 逻辑，采用“生产-消费”同步模型：
- **第一阶段**：流式推送数据至 `mp4box` 直到 `onReady` 触发。此时**暂停**读取流。
- **第二阶段**：获取轨道信息后，立刻调用 `setExtractionOptions` 和 `start()`。
- **第三阶段**：恢复读取流，将剩余数据推入。此时 `onSamples` 会随着数据的推入实时触发。

### 2. [Worker] 编解码器健壮性
- **AVCC/HVCC 提取优化**：改进 `extractDescription` 函数，利用 `mp4box` 内部的 `BoxParser` 或 `DataStream` 确保 100% 提取出解码器所需的硬核配置信息。
- **硬件 Profile 强制对齐**：使用 `avc1.4D002A` (H.264 Main) 和更安全的视频配置，避免因分辨率或规格不支持导致的显卡瞬间崩溃。

### 3. [Architecture] WASM-SIMD 加速补丁 (New)
- 调研并预留支持 `SIMD` 和 `SharedArrayBuffer` 多线程的高性能 FFmpeg 构建接口，减少降级后的性能损耗。

### 4. [UI/UX] 真实极速反馈
- **帧进度模型**：从 `track.nb_samples` 获取总帧数。
- **进度公式**：`progress = (已编码帧数 / 总帧数) * 100`。
- **速度显示**：吞吐量计算改为基于“已压缩的数据量”，真实反馈显卡算力。

---

## 拟修改文件

#### [MODIFY] [media-worker.ts](file:///e:/resource/wx-proj/compress/Z/src/engine/workers/media-worker.ts)
- 重构 `runPipeline` 时序逻辑。
- 升级 `extractDescription` 稳定性。
- 引入帧基准进度推送。

#### [MODIFY] [Dashboard.vue](file:///e:/resource/wx-proj/compress/Z/src/components/Dashboard.vue)
- 优化进度显示逻辑，对接新的帧进度模型。

---

## 验证计划
1. **2MB 小文件验证**：目标 1 秒内完成压缩，不触发降级。
2. **100MB+ 大文件验证**：目标维持 10MB/s+ 左右的压缩速率，观察显卡占用。
3. **日志验证**：通过 [Log] 控制台确认 `WebCodecs` 持续运行，无 `Auto-falling back` 警告。

---

> [!IMPORTANT]
> 此项重构直接决定了 Project Titan 是否具备“商业级极速”的竞争力。我们将不再依赖 WASM 的软解，而是真正唤醒用户显卡的潜能。
