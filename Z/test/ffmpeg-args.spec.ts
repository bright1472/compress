/**
 * test/ffmpeg-args.spec.ts
 * Phase B 单元测试：FFmpeg 命令行参数包含 metadata 保留 flags
 *
 * 不跑实际转码，只验证 buildFfmpegArgs 输出的命令行包含：
 *   -map_metadata 0                                  → 复制全局 metadata
 *   -movflags use_metadata_tags+faststart            → mp4 容器保留 QuickTime 私有 atom
 */

import { describe, it, expect } from 'vitest';
import { buildFfmpegArgs } from '../src/engine/ffmpeg-engine';
import type { CompressionOptions } from '../src/engine/ffmpeg-engine';

const baseOpt: CompressionOptions = {
  codec: 'libx264',
  crf: 23,
  preset: 'medium',
  outputFormat: 'mp4',
};

const args = (opt: Partial<CompressionOptions> = {}): string[] =>
  buildFfmpegArgs('in.mp4', 'out.mp4', { ...baseOpt, ...opt }, false);

describe('buildFfmpegArgs metadata flags', () => {
  it.each([
    ['libx264' as const],
    ['libx265' as const],
    ['libaom-av1' as const],
  ])('codec=%s output=mp4 包含 -map_metadata 0 + use_metadata_tags+faststart', (codec) => {
    const a = args({ codec, outputFormat: 'mp4' });

    const mapIdx = a.findIndex(s => s === '-map_metadata');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(a[mapIdx + 1]).toBe('0');

    const movIdx = a.findIndex(s => s === '-movflags');
    expect(movIdx).toBeGreaterThan(-1);
    expect(a[movIdx + 1]).toBe('use_metadata_tags+faststart');
  });

  it.each([
    ['libx264' as const],
    ['libx265' as const],
    ['libaom-av1' as const],
  ])('codec=%s output=webm 不包含 -movflags（matroska 容器不支持）', (codec) => {
    const a = args({ codec, outputFormat: 'webm' });
    expect(a).not.toContain('-movflags');
    expect(a).toContain('-map_metadata');
  });

  it('-map_metadata 必须在 -i 之后、output 之前（FFmpeg 参数顺序约束）', () => {
    const a = args();
    const inputIdx = a.findIndex(s => s === '-i');
    const mapIdx = a.findIndex(s => s === '-map_metadata');
    const outputIdx = a.length - 1;

    expect(mapIdx).toBeGreaterThan(inputIdx);
    expect(mapIdx).toBeLessThan(outputIdx);
  });
});
