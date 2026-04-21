import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), basicSsl()],
  server: {
    https: true,
    host: true, // 监听所有地址，兼容代理 TUN 模式
    headers: {
      // 开启跨域隔离，解锁 SharedArrayBuffer 和 FFmpeg 多线程
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    // 排除 FFmpeg.wasm，让 Vite 不对其做打包优化（它需要加载外部资源）
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@ffmpeg/core-mt'],
  },
  worker: {
    format: 'es',
  },
})
