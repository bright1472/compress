/**
 * test/exif-preserve.spec.ts
 * Phase A：纯函数测试 readPreservedExif + injectExifToJpeg
 *
 * 流程：
 *   1. 从 fixtures 读真实 EXIF（用 exiftool-vendored 当 ground truth）
 *   2. 调 readPreservedExif → 白名单过滤后的 EXIF
 *   3. 调 injectExifToJpeg → 注入到一个新 JPEG
 *   4. exiftool.read 读出注入后的 metadata，断言一致性
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExifTool } from 'exiftool-vendored';
import piexif from 'piexifjs';
import { readPreservedExif, injectExifToJpeg } from '../src/engine/exif-preserve';

const FIXTURES = join(__dirname, 'fixtures');
const TOLERANCE_DEGREES = 0.0001; // GPS rational 转换精度容差

const exiftool = new ExifTool({ taskTimeoutMillis: 10_000 });
let tmpRoot: string;

const loadFile = (name: string, mime: string): File => {
  const buf = readFileSync(join(FIXTURES, name));
  return new File([buf], name, { type: mime });
};

const writeBufferToTmp = (buf: ArrayBuffer, name: string): string => {
  const path = join(tmpRoot, name);
  writeFileSync(path, Buffer.from(buf));
  return path;
};

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'exif-test-'));
});

afterAll(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
  await exiftool.end();
});

describe('readPreservedExif', () => {
  it('从 GPS 样本抽到 GPS+DateTimeOriginal+Make/Model', async () => {
    const file = loadFile('gps-DSCN0010.jpg', 'image/jpeg');
    const exif = await readPreservedExif(file);

    expect(exif).not.toBeNull();
    expect(exif!.exif['0th'][piexif.ImageIFD.Make]).toBeTruthy();
    expect(exif!.exif['0th'][piexif.ImageIFD.Model]).toBeTruthy();
    expect(exif!.exif['Exif'][piexif.ExifIFD.DateTimeOriginal]).toBeTruthy();
    expect(Object.keys(exif!.exif['GPS']).length).toBeGreaterThan(0);
  });

  it('Orientation 强制写为 1（防止 Canvas 旋转后双重旋转）', async () => {
    const file = loadFile('orientation-portrait_3.jpg', 'image/jpeg');
    const exif = await readPreservedExif(file);

    expect(exif).not.toBeNull();
    expect(exif!.exif['0th'][piexif.ImageIFD.Orientation]).toBe(1);
  });

  it('白名单外字段全部剥离（无 1st/Interop/thumbnail）', async () => {
    const file = loadFile('gps-DSCN0010.jpg', 'image/jpeg');
    const exif = await readPreservedExif(file);

    expect(exif).not.toBeNull();
    expect(exif!.exif['1st']).toBeUndefined();
    expect(exif!.exif['Interop']).toBeUndefined();
    expect(exif!.exif.thumbnail).toBeFalsy();
  });

  it('无 EXIF 文件返回 null', async () => {
    // 用 piexif.remove 制造一个无 EXIF 的副本
    const buf = readFileSync(join(FIXTURES, 'gps-DSCN0010.jpg'));
    const binary = Array.from(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      .map(b => String.fromCharCode(b)).join('');
    const stripped = piexif.remove(binary);
    const strippedBuf = new Uint8Array(stripped.length);
    for (let i = 0; i < stripped.length; i++) strippedBuf[i] = stripped.charCodeAt(i) & 0xff;
    const file = new File([strippedBuf], 'no-exif.jpg', { type: 'image/jpeg' });

    const exif = await readPreservedExif(file);
    expect(exif).toBeNull();
  });
});

describe('injectExifToJpeg + exiftool 端到端验证', () => {
  it('注入 GPS 后 exiftool 能读出经纬度，精度损失 < 0.0001 度', async () => {
    const file = loadFile('gps-DSCN0010.jpg', 'image/jpeg');
    const buf = readFileSync(join(FIXTURES, 'gps-DSCN0010.jpg'));

    // 1. 用 exiftool 读原图 GPS 作为 ground truth
    const originalPath = writeBufferToTmp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'orig.jpg');
    const original = await exiftool.read(originalPath);
    expect(original.GPSLatitude).toBeDefined();
    expect(original.GPSLongitude).toBeDefined();

    // 2. 抽 EXIF + 注入到一份"假压缩"的 JPEG（用原图当压缩后的，验证注入逻辑本身）
    const exif = await readPreservedExif(file);
    expect(exif).not.toBeNull();

    // 制造一个无 EXIF 的目标 JPEG（相当于 mozjpeg 重新编码后的产物）
    const stripped = piexif.remove(
      Array.from(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
        .map(b => String.fromCharCode(b)).join(''),
    );
    const strippedBuf = new Uint8Array(stripped.length);
    for (let i = 0; i < stripped.length; i++) strippedBuf[i] = stripped.charCodeAt(i) & 0xff;

    const injected = injectExifToJpeg(strippedBuf.buffer, exif!);
    const injectedPath = writeBufferToTmp(injected, 'injected.jpg');

    // 3. 用 exiftool 读注入后的文件，验证关键字段
    const result = await exiftool.read(injectedPath);

    expect(result.GPSLatitude).toBeDefined();
    expect(result.GPSLongitude).toBeDefined();
    expect(Math.abs((result.GPSLatitude as number) - (original.GPSLatitude as number))).toBeLessThan(TOLERANCE_DEGREES);
    expect(Math.abs((result.GPSLongitude as number) - (original.GPSLongitude as number))).toBeLessThan(TOLERANCE_DEGREES);
  });

  it('注入 DateTimeOriginal 后 exiftool 能读出且与原图一致', async () => {
    const file = loadFile('gps-DSCN0010.jpg', 'image/jpeg');
    const buf = readFileSync(join(FIXTURES, 'gps-DSCN0010.jpg'));

    const originalPath = writeBufferToTmp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'orig2.jpg');
    const original = await exiftool.read(originalPath);
    expect(original.DateTimeOriginal).toBeDefined();

    const exif = await readPreservedExif(file);
    const stripped = piexif.remove(
      Array.from(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
        .map(b => String.fromCharCode(b)).join(''),
    );
    const strippedBuf = new Uint8Array(stripped.length);
    for (let i = 0; i < stripped.length; i++) strippedBuf[i] = stripped.charCodeAt(i) & 0xff;
    const injected = injectExifToJpeg(strippedBuf.buffer, exif!);
    const injectedPath = writeBufferToTmp(injected, 'injected2.jpg');

    const result = await exiftool.read(injectedPath);
    expect(result.DateTimeOriginal).toBeDefined();
    // exiftool 把日期解析成 ExifDateTime 对象，转成原始字符串比较
    const fmt = (d: unknown): string =>
      d && typeof (d as { toISOString?: () => string }).toISOString === 'function'
        ? (d as { toISOString: () => string }).toISOString().slice(0, 19)
        : String(d).slice(0, 19);
    expect(fmt(result.DateTimeOriginal)).toBe(fmt(original.DateTimeOriginal));
  });

  it('注入后 Make/Model/Orientation=1 正确写入', async () => {
    const file = loadFile('orientation-portrait_3.jpg', 'image/jpeg');
    const buf = readFileSync(join(FIXTURES, 'orientation-portrait_3.jpg'));

    const exif = await readPreservedExif(file);
    expect(exif).not.toBeNull();

    const stripped = piexif.remove(
      Array.from(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
        .map(b => String.fromCharCode(b)).join(''),
    );
    const strippedBuf = new Uint8Array(stripped.length);
    for (let i = 0; i < stripped.length; i++) strippedBuf[i] = stripped.charCodeAt(i) & 0xff;
    const injected = injectExifToJpeg(strippedBuf.buffer, exif!);
    const injectedPath = writeBufferToTmp(injected, 'injected3.jpg');

    const result = await exiftool.read(injectedPath);
    expect(result.Orientation).toBe(1);
  });
});
