declare module 'piexifjs' {
  type IfdRecord = Record<number, unknown>;

  export interface ExifObject {
    '0th': IfdRecord;
    'Exif': IfdRecord;
    'GPS': IfdRecord;
    'Interop'?: IfdRecord;
    '1st'?: IfdRecord;
    thumbnail?: string | null;
  }

  const piexif: {
    load(jpegBinary: string): ExifObject;
    dump(exif: ExifObject): string;
    insert(exifBytes: string, jpegBinary: string): string;
    remove(jpegBinary: string): string;

    ImageIFD: { Make: number; Model: number; Orientation: number; [k: string]: number };
    ExifIFD: {
      DateTimeOriginal: number;
      OffsetTimeOriginal: number;
      SubSecTimeOriginal: number;
      [k: string]: number;
    };
    GPSIFD: {
      GPSLatitudeRef: number;
      GPSLatitude: number;
      GPSLongitudeRef: number;
      GPSLongitude: number;
      GPSAltitudeRef: number;
      GPSAltitude: number;
      GPSDateStamp: number;
      GPSTimeStamp: number;
      [k: string]: number;
    };
  };

  export default piexif;
}
