压缩2.2m视频 成功
但是  原始 2.2 MB → 压缩后 3.4 MB 节省 -55%  速率 1-2m/s
日志如下
processor.ts:20 📁 [Processor] Init
logger.ts:50 ✅ [Storage] OPFS Access Granted.
logger.ts:50 ✅ OPFS Ready
logger.ts:50 ✅ [Processor] Worker Handshake OK
media-worker.ts:45 🚀 [Worker] Pipeline Start
media-worker.ts:89 📖 [Worker] Phase 1: Feeding until onReady...
media-worker.ts:67 ✅ [Worker] onReady fired
media-worker.ts:76 📹 [Worker] Video track: id=1, codec=avc1.4d001f, 1176x696
media-worker.ts:80 ✅ [Worker] Extraction started
media-worker.ts:106 ✅ [Worker] Phase 1 complete
media-worker.ts:109 🔧 [Worker] Extracting avcC from mp4box.boxes...
media-worker.ts:265 🔍 [Worker] Found mp4box.boxes array, length: 4
media-worker.ts:333 🔍 [Worker] Found matching trak, id= 1
media-worker.ts:370 🔍 [Worker] Found stsd, entries: 1
media-worker.ts:378 🔍 [Worker] Entry type: avc1
media-worker.ts:382 🔍 [Worker] Found video sample entry, checking its boxes...
media-worker.ts:385 🔍 [Worker] Entry has 1 sub-boxes
media-worker.ts:388 🔍 [Worker] Sub-box type: avcC
media-worker.ts:391 ✅ [Worker] Found avcC/hvcC in entry.boxes!
media-worker.ts:418 🔍 [Worker] extractAVCCData, box has start: 2321974 size: 60
media-worker.ts:434 🔍 [Worker] Using DataStream.write() to serialize avcC box
media-worker.ts:441 ✅ [Worker] avcC serialized, length: 52
media-worker.ts:268 ✅ [Worker] Found avcC in mp4box.boxes
media-worker.ts:111 🔧 [Worker] Description: present (52 bytes)
media-worker.ts:114 📖 [Worker] Phase 2: Re-feeding all data...
media-worker.ts:129 ✅ [Worker] Phase 2 complete: 182 samples extracted
media-worker.ts:164 🔧 [Worker] Checking hardware encoder support...
media-worker.ts:169 ✅ [Worker] Hardware encoder supported
media-worker.ts:200 ✅ [Worker] Encoder configured
media-worker.ts:220 ✅ [Worker] Decoder configured
media-worker.ts:222 🎬 [Worker] Processing 182 frames...
media-worker.ts:239 ✅ [Worker] Encode complete: 182/182 frames
media-worker.ts:251 🎉 [Worker] Pipeline Complete
logger.ts:50 🎉 [Processor] Complete

压缩26m视频 成功 速率2-3 m/s

原始 27.0 MB → 压缩后 16.4 MB 节省 39%

 [Processor] Init
logger.ts:50 ✅ [Storage] OPFS Access Granted.
logger.ts:50 ✅ OPFS Ready
logger.ts:50 ✅ [Processor] Worker Handshake OK
media-worker.ts:45 🚀 [Worker] Pipeline Start
media-worker.ts:89 📖 [Worker] Phase 1: Feeding until onReady...
media-worker.ts:67 ✅ [Worker] onReady fired
media-worker.ts:76 📹 [Worker] Video track: id=1, codec=avc1.4d0020, 1002x962
media-worker.ts:80 ✅ [Worker] Extraction started
media-worker.ts:106 ✅ [Worker] Phase 1 complete
media-worker.ts:109 🔧 [Worker] Extracting avcC from mp4box.boxes...
media-worker.ts:265 🔍 [Worker] Found mp4box.boxes array, length: 4
media-worker.ts:333 🔍 [Worker] Found matching trak, id= 1
media-worker.ts:370 🔍 [Worker] Found stsd, entries: 1
media-worker.ts:378 🔍 [Worker] Entry type: avc1
media-worker.ts:382 🔍 [Worker] Found video sample entry, checking its boxes...
media-worker.ts:385 🔍 [Worker] Entry has 1 sub-boxes
media-worker.ts:388 🔍 [Worker] Sub-box type: avcC
media-worker.ts:391 ✅ [Worker] Found avcC/hvcC in entry.boxes!
media-worker.ts:418 🔍 [Worker] extractAVCCData, box has start: 28267585 size: 60
media-worker.ts:434 🔍 [Worker] Using DataStream.write() to serialize avcC box
media-worker.ts:441 ✅ [Worker] avcC serialized, length: 52
media-worker.ts:268 ✅ [Worker] Found avcC in mp4box.boxes
media-worker.ts:111 🔧 [Worker] Description: present (52 bytes)
media-worker.ts:114 📖 [Worker] Phase 2: Re-feeding all data...
media-worker.ts:129 ✅ [Worker] Phase 2 complete: 1629 samples extracted
media-worker.ts:164 🔧 [Worker] Checking hardware encoder support...
media-worker.ts:169 ✅ [Worker] Hardware encoder supported
media-worker.ts:200 ✅ [Worker] Encoder configured
media-worker.ts:220 ✅ [Worker] Decoder configured
media-worker.ts:222 🎬 [Worker] Processing 1629 frames...
media-worker.ts:239 ✅ [Worker] Encode complete: 1629/1629 frames
media-worker.ts:251 🎉 [Worker] Pipeline Complete
logger.ts:50 🎉 [Processor] Complete

---

## 2026-04-17 mediabunny 迁移（方案A落地）

### 背景
旧 media-worker.ts（534行）手写 WebCodecs 全链路（MP4Box 两阶段 demux、avcC 提取、VideoEncoder/Decoder、mp4-muxer），累计修 10+ bug 但结构性问题仍在：
- H.264 Level 硬编码 `avc1.4D002A`（L4.2），2316×1214 等大分辨率被硬件编码器拒绝
- 进度条 Phase1/Phase2 两段跳变（60MB/s → 0）
- 500+ 行 MP4 边界代码（moov-at-end、avcC box 遍历）
- 硬件编码失败无自动回退

### 变更
用 mediabunny `Conversion` API 替换 worker 内部管线，**processor.ts 消息协议完全不变**（零侵入）。

**文件变更**：
- `src/engine/workers/media-worker.ts` — 全量重写（534行 → ~180行）
- `src/engine/workers/media-worker.legacy.ts` — 旧代码备份，验证无回归后删除

**丢弃的代码**：
- `extractAVCCFromMp4boxBoxes` 及全部 MP4Box 调用
- 两阶段 reader1/reader2 流式喂数据
- 手工 VideoEncoder/VideoDecoder 管理
- mp4-muxer 的 Muxer + StreamTarget
- 编码队列背压循环、手写 keyframe 计数
- 硬编码 codec string（`avc1.4D002A` 等）

**保留**：
- `calculateSmartBitrate` — 业务规则（防止低码率视频被放大）
- 消息协议（PING/PONG, START_PROCESS, PROGRESS, DONE, ERROR, STOP）

**mediabunny 解决的痛点**：
| 痛点 | 解决方式 |
|---|---|
| Level 硬编码 | 传 `codec: 'avc'`，库按分辨率自动选 Level |
| avcC 提取 | 库内部自动处理 |
| moov-at-end | `Input({ source: new BlobSource(file) })` 自动处理 |
| 进度跳变 | `conversion.onProgress` 单一 0→1 连续进度 |
| 硬件失败无回退 | `hardwareAcceleration: 'no-preference'` 自动降级 |
| 取消处理 | `conversion.cancel()` + `ConversionCanceledError` |

### 依赖
mediabunny 1.40.1 和 @ffmpeg/ffmpeg 0.12.15 已在 `package.json` 中，无需新增。
验证无回归后可移除 `mp4-muxer` 和 `mp4box` 依赖。

### 验证状态
- [x] vue-tsc 类型检查通过（media-worker.ts 零报错）
- [ ] 浏览器实测：2.2MB 视频 → ≤ 2MB，进度连续
- [ ] 浏览器实测：2316×1214 大分辨率 → 不报 codec 不支持
- [ ] 浏览器实测：160MB 大视频 → 进度不跳变，硬件失败自动回退