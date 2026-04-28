# EXIF / 视频 Metadata 保留

> 状态：v1（commit `0ad9807`，2026-04-28）
> 目的：让 iPhone / 安卓用户压缩后的照片视频回到相册时，仍按拍摄时间和地点正常归类。

## 1. 问题与目标

iPhone / 安卓相册的"地点"分组、"日期"分组依赖标准的 EXIF / QuickTime metadata 字段：

| 平台 | 图片关键字段 | 视频关键字段 |
|---|---|---|
| iOS 相册 | EXIF `DateTimeOriginal` + `OffsetTimeOriginal` + GPS IFD | mp4 udta `com.apple.quicktime.creationdate` + `com.apple.quicktime.location.ISO6709` |
| Android / Google Photos | EXIF `DateTimeOriginal` + GPS IFD（同 iOS） | mp4 `moov.udta.creation_time` + `©xyz`（ISO6109 经纬度） |

**好消息**：双平台读同一组标准字段，做一次覆盖两端。

## 2. 旧版（commit 之前）的丢失链路

| 链路 | 实现 | 元数据下场 |
|---|---|---|
| 图片 | `<img>` → `canvas.drawImage` → `ctx.getImageData` → mozjpeg/UPNG/webp WASM | EXIF 在 Canvas 解码时**整体丢弃**，编码器只接收像素 |
| 视频（FFmpeg） | `ffmpeg -i in -c:v ... out` 没有 `-map_metadata` | mov→mp4 转换默认不复制 udta box |
| 视频（WebCodecs 极速） | `mp4-muxer` 从零构造容器 | udta/meta box 不写入，**100% 丢失** |

## 3. 当前实现

### 3.1 视频路径（[ffmpeg-engine.ts:102-140](../Z/src/engine/ffmpeg-engine.ts#L102-L140)）

```
-map_metadata 0                              复制源全局 metadata
-movflags use_metadata_tags+faststart        保留 QuickTime 私有 atom（仅 mp4）
```

抽出为纯函数 `buildFfmpegArgs(input, output, opt, isMultiThreaded)`，便于单测。

WebCodecs 极速链路**不做**，按之前产品决策保持，UI 应有提示。

### 3.2 图片路径（[exif-preserve.ts](../Z/src/engine/exif-preserve.ts)）

#### 白名单字段

| IFD | 字段 |
|---|---|
| 0th | `Make` / `Model` / `Orientation`（强制写 1） |
| Exif | `DateTimeOriginal` / `OffsetTimeOriginal` / `SubSecTimeOriginal` |
| GPS | 整个 GPS IFD 全部保留 |

**剥离**：缩略图 / Interop / 1st IFD / MakerNote / UserComment 等。

#### 双路径读取

```
JPEG 输入 → piexif.load (零损失直读) → 白名单过滤
HEIC/其他 → exifr.parse (浮点经纬度) → DMS rational 转换 → 白名单
```

#### Orientation=1 强制重置

Canvas 解码时**已经按 orientation 旋转过像素**。如果原 EXIF Orientation=6 还原样写回，相册会再次旋转 → 图像倒置。所以白名单永远写 `Orientation=1`。

#### 注入到 JPEG

```
mozjpeg 编码 → ArrayBuffer → piexif.dump + insert → 新 ArrayBuffer → Blob
```

PNG / WebP / AVIF 输出**不注入**（手机来源占比低，性价比差）。

## 4. 测试与 CI

| 测试文件 | 覆盖 |
|---|---|
| [exif-preserve.spec.ts](../Z/test/exif-preserve.spec.ts) | 白名单 / Orientation / null 边界 / GPS 精度 < 0.0001° / DateTimeOriginal 一致 |
| [ffmpeg-args.spec.ts](../Z/test/ffmpeg-args.spec.ts) | buildArgs 输出 flag 完整性 + 顺序约束 |
| [ffmpeg-integration.spec.ts](../Z/test/ffmpeg-integration.spec.ts) | 本机 ffmpeg 真转码后 `creation_time` 一致 |

**Ground truth**：`exiftool-vendored.js`（基于 Phil Harvey ExifTool，跨平台）。

**Fixtures**：[ianare/exif-samples](https://github.com/ianare/exif-samples) 公开样本（GPS×2 + Orientation×1）。

**CI**：`.github/workflows/test.yml` 每次 push 触发，`ubuntu-latest` 自带 ffmpeg。

跑：

```bash
cd Z && npm test
```

最后实测：15 通过 / 1 跳过（ffmpeg 占位）/ 0 失败 / 558ms。

## 5. 已知局限

| 缺口 | 影响 | 后续 |
|---|---|---|
| HEIC fixture 缺失 | P3 路径只是冒烟通过，未真实端到端验证 | 加 iPhone 真机 .heic 样本 |
| WebCodecs 极速链路 | 元数据完全丢 | UI 加提示"极速模式不保留拍摄信息" |
| WebP / PNG / AVIF 输出 | 不注入 EXIF | 不计划做（手机来源极少） |
| 真机相册识别验证 | 没确认 iOS/Android 相册"地点"分组真生效 | 真机一次（不可避免） |
| Live Photo 关联 | iPhone .heic + .mov 关联会破坏 | 文档提示，不主动识别 |

## 6. 跨链路调用图

```
File 输入
  │
  ├─ image: ImageEngine.compress(file, options)
  │     ├─ readPreservedExif(file) → 白名单 EXIF
  │     ├─ Canvas → mozjpeg/UPNG/webp 编码
  │     └─ JPEG 输出？ → injectExifToJpeg(buffer, exif)
  │
  └─ video: FfmpegEngine.compress(file, options)
        └─ buildFfmpegArgs() → -map_metadata 0 + use_metadata_tags
              （metadata 由 ffmpeg 自身复制，无需我们注入）
```

## 7. 依赖

```json
{
  "exifr": "^7.1.3",          // EXIF 读取（HEIC/WebP/JPEG 通用）
  "piexifjs": "^1.0.6",       // EXIF 写入到 JPEG（已停更但稳定）
  "exiftool-vendored": "^35", // 测试 ground truth (devDep)
  "vitest": "^4"              // 测试框架 (devDep)
}
```
