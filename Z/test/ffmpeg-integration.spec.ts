/**
 * test/ffmpeg-integration.spec.ts
 * Phase B 集成测试：用本机 ffmpeg 跑实际转码，验证 metadata 真的被保留
 *
 * 注：WASM 版 @ffmpeg/ffmpeg 与原生 ffmpeg 是同一 codebase 编译的，
 *     命令行参数行为一致。此测试用本机 ffmpeg 验证我们的参数有效，
 *     等同于验证 FfmpegEngine 的实际行为。
 *
 * 跳过条件：本机未装 ffmpeg（CI 上 ubuntu-latest 自带）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExifTool } from 'exiftool-vendored';
import { buildFfmpegArgs } from '../src/engine/ffmpeg-engine';
import type { CompressionOptions } from '../src/engine/ffmpeg-engine';

const hasFfmpeg = (() => {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const exiftool = new ExifTool({ taskTimeoutMillis: 10_000 });
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ffmpeg-test-'));
});

afterAll(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
  await exiftool.end();
});

const synthesizeSourceMp4 = (path: string): void => {
  // 1 秒红色测试视频 + 写入 creation_time（QuickTime 私有 atom 用 ffmpeg 直接写最简单的标准 metadata）
  const args = [
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1',
    '-metadata', 'creation_time=2024-01-15T10:30:00Z',
    '-metadata', 'comment=test-fixture',
    '-y', path,
  ];
  const r = spawnSync('ffmpeg', args, { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(`ffmpeg synth failed: ${r.stderr.toString()}`);
  }
};

describe.skipIf(!hasFfmpeg)('FfmpegEngine 实际转码后 metadata 保留', () => {
  it('使用 buildArgs 输出的参数转码，creation_time 被保留', async () => {
    const inputPath = join(tmpRoot, 'src.mp4');
    const outputPath = join(tmpRoot, 'out.mp4');

    synthesizeSourceMp4(inputPath);
    expect(existsSync(inputPath)).toBe(true);

    const original = await exiftool.read(inputPath);
    expect(original.CreateDate).toBeDefined();

    const opt: CompressionOptions = {
      codec: 'libx264', crf: 28, preset: 'ultrafast', outputFormat: 'mp4',
    };
    const args = buildFfmpegArgs(inputPath, outputPath, opt, false);

    const r = spawnSync('ffmpeg', args, { stdio: 'pipe' });
    expect(r.status, `ffmpeg failed: ${r.stderr.toString()}`).toBe(0);
    expect(existsSync(outputPath)).toBe(true);

    const result = await exiftool.read(outputPath);

    expect(result.CreateDate).toBeDefined();
    const fmt = (d: unknown): string =>
      d && typeof (d as { toISOString?: () => string }).toISOString === 'function'
        ? (d as { toISOString: () => string }).toISOString().slice(0, 19)
        : String(d).slice(0, 19);
    expect(fmt(result.CreateDate)).toBe(fmt(original.CreateDate));
  });
});

describe.skipIf(hasFfmpeg)('ffmpeg 集成测试（已跳过：本机未装 ffmpeg）', () => {
  it.skip('placeholder', () => { /* skipped */ });
});
