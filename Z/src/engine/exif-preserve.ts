/**
 * src/engine/exif-preserve.ts
 * EXIF 保留：只为相册识别（拍摄时间/GPS/机型/方向）保留必要字段
 *
 * 白名单（其他全部剥离，避免 MakerNote 私有 tag 引发兼容问题）：
 *   0th  : Make / Model / Orientation=1（Canvas 已按 orientation 旋转过像素，必须重置）
 *   Exif : DateTimeOriginal / OffsetTimeOriginal / SubSecTimeOriginal
 *   GPS  : 全部保留（仅 GPS IFD，本身就是定位字段）
 *
 * 输入路径：
 *   JPEG → piexif.load 直接抽（最快，零损失）
 *   HEIC/其他 → exifr 读取后映射到 piexif 格式（best-effort）
 *
 * 输出：仅注入到压缩后的 JPEG。WebP/PNG/AVIF 容器的 EXIF 写入是另一套逻辑，本工具不处理。
 */

import piexif from 'piexifjs';
import type { ExifObject } from 'piexifjs';
import exifr from 'exifr';

const { ImageIFD, ExifIFD, GPSIFD } = piexif;

export interface PreservedExif {
  exif: ExifObject;
}

// ── 二进制字符串 / ArrayBuffer 互转 ─────────────────────────────

const arrayBufferToBinaryString = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
};

const binaryStringToArrayBuffer = (s: string): ArrayBuffer => {
  const buf = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff;
  return buf.buffer;
};

const fileToBinaryString = async (file: File): Promise<string> => {
  // 用 arrayBuffer + 字节级转换替代 FileReader.readAsBinaryString
  // 浏览器和 Node 18+ 都原生支持，便于在 Node 单测中复用
  const buf = await file.arrayBuffer();
  return arrayBufferToBinaryString(buf);
};

// ── GPS 浮点转 piexif rational [deg/1, min/1, sec/1000] ──────────

const decimalToDmsRational = (decimal: number): [[number, number], [number, number], [number, number]] => {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60 * 1000);
  return [[deg, 1], [min, 1], [sec, 1000]];
};

const formatExifDate = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// ── 白名单过滤（piexif 原始对象路径，JPEG 直读用）────────────────

const sanitizeFromPiexif = (raw: ExifObject): ExifObject => {
  const out: ExifObject = { '0th': {}, 'Exif': {}, 'GPS': {} };

  const z = raw['0th'] ?? {};
  if (z[ImageIFD.Make] !== undefined) out['0th'][ImageIFD.Make] = z[ImageIFD.Make];
  if (z[ImageIFD.Model] !== undefined) out['0th'][ImageIFD.Model] = z[ImageIFD.Model];
  out['0th'][ImageIFD.Orientation] = 1;

  const e = raw['Exif'] ?? {};
  for (const tag of [ExifIFD.DateTimeOriginal, ExifIFD.OffsetTimeOriginal, ExifIFD.SubSecTimeOriginal]) {
    if (e[tag] !== undefined) out['Exif'][tag] = e[tag];
  }

  out['GPS'] = { ...(raw['GPS'] ?? {}) };
  return out;
};

// ── 从 exifr 解析结果映射到 piexif 格式（HEIC / 非 JPEG 路径）────

interface ExifrResult {
  Make?: string;
  Model?: string;
  DateTimeOriginal?: Date | string;
  OffsetTimeOriginal?: string;
  SubSecTimeOriginal?: string;
  latitude?: number;
  longitude?: number;
  GPSAltitude?: number;
  GPSDateStamp?: string;
}

const buildFromExifr = (data: ExifrResult): ExifObject => {
  const out: ExifObject = { '0th': {}, 'Exif': {}, 'GPS': {} };

  if (data.Make) out['0th'][ImageIFD.Make] = String(data.Make);
  if (data.Model) out['0th'][ImageIFD.Model] = String(data.Model);
  out['0th'][ImageIFD.Orientation] = 1;

  if (data.DateTimeOriginal) {
    const dt = data.DateTimeOriginal instanceof Date
      ? formatExifDate(data.DateTimeOriginal)
      : String(data.DateTimeOriginal);
    out['Exif'][ExifIFD.DateTimeOriginal] = dt;
  }
  if (data.OffsetTimeOriginal) out['Exif'][ExifIFD.OffsetTimeOriginal] = String(data.OffsetTimeOriginal);
  if (data.SubSecTimeOriginal) out['Exif'][ExifIFD.SubSecTimeOriginal] = String(data.SubSecTimeOriginal);

  if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
    out['GPS'][GPSIFD.GPSLatitudeRef] = data.latitude >= 0 ? 'N' : 'S';
    out['GPS'][GPSIFD.GPSLatitude] = decimalToDmsRational(data.latitude);
    out['GPS'][GPSIFD.GPSLongitudeRef] = data.longitude >= 0 ? 'E' : 'W';
    out['GPS'][GPSIFD.GPSLongitude] = decimalToDmsRational(data.longitude);
  }
  if (typeof data.GPSAltitude === 'number') {
    out['GPS'][GPSIFD.GPSAltitudeRef] = data.GPSAltitude >= 0 ? 0 : 1;
    out['GPS'][GPSIFD.GPSAltitude] = [Math.round(Math.abs(data.GPSAltitude) * 100), 100];
  }

  return out;
};

// ── 公共 API ────────────────────────────────────────────────────

const isJpeg = (file: File): boolean => {
  const t = file.type.toLowerCase();
  if (t === 'image/jpeg' || t === 'image/jpg') return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext === 'jpg' || ext === 'jpeg';
};

// piexif.load 返回的 raw 对象任意 IFD 有字段即视为有 EXIF
const hasRawExif = (raw: ExifObject): boolean =>
  Object.keys(raw['0th'] ?? {}).length > 0
  || Object.keys(raw['Exif'] ?? {}).length > 0
  || Object.keys(raw['GPS'] ?? {}).length > 0;

// exifr 返回的对象任意有用字段（不仅 Orientation）才视为有用
const hasUsefulFromExifr = (data: ExifrResult): boolean =>
  !!data.Make || !!data.Model
  || !!data.DateTimeOriginal
  || typeof data.latitude === 'number'
  || typeof data.longitude === 'number';

/**
 * 从原文件读取 EXIF。任何失败都返回 null（不抛异常，避免影响压缩主流程）
 */
export async function readPreservedExif(file: File): Promise<PreservedExif | null> {
  // JPEG：直接 piexif.load，零损失
  if (isJpeg(file)) {
    try {
      const bin = await fileToBinaryString(file);
      const raw = piexif.load(bin);
      if (hasRawExif(raw)) return { exif: sanitizeFromPiexif(raw) };
      // raw 全空 → fallback exifr（极少见情况，但可能 piexif 读不到某些段）
    } catch {
      // 没 EXIF 段会抛错；fallback 到 exifr
    }
  }

  // HEIC / WebP / 其他：exifr（默认就只读 ifd0 + exif + gps，已足够）
  try {
    const data = (await exifr.parse(file)) as ExifrResult | undefined;
    if (!data || !hasUsefulFromExifr(data)) return null;
    return { exif: buildFromExifr(data) };
  } catch {
    return null;
  }
}

/**
 * 把保留的 EXIF 注入到压缩后的 JPEG buffer。失败返回原 buffer
 */
export function injectExifToJpeg(jpegBuffer: ArrayBuffer, preserved: PreservedExif): ArrayBuffer {
  try {
    const exifBytes = piexif.dump(preserved.exif);
    const jpegBinary = arrayBufferToBinaryString(jpegBuffer);
    const newBinary = piexif.insert(exifBytes, jpegBinary);
    return binaryStringToArrayBuffer(newBinary);
  } catch {
    return jpegBuffer;
  }
}
