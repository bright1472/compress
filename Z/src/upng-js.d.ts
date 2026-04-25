declare module 'upng-js' {
  const UPNG: {
    encode(imgs: ArrayBuffer[], w: number, h: number, cnum?: number, dels?: number[]): ArrayBuffer;
    decode(buffer: ArrayBuffer): { width: number; height: number; depth: number; ctype: number; frames: any[]; tabs: any; data: Uint8Array };
    toRGBA8(out: ReturnType<typeof UPNG.decode>): ArrayBuffer[];
  };
  export default UPNG;
}
