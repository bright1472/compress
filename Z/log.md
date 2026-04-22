# 实现web加速压缩

## 1、hardwareAcceleration 设置为 'no-preference'
windows
```
[03:36:24.670] [INFO] [system] [Benchmark] 屏幕录制 2024-09-09 135431.mp4 | 2.21mb | 2.8s | 0.79 MB/s | Ratio: 55.0% | Engine: WebCodecs
[03:32:07.559] [INFO] [system] [Benchmark] 屏幕录制 2025-03-28 110700.mp4 | 14.9mb | 11.5s | 1.31 MB/s | Ratio: 9.0% | Engine: WebCodecs
[03:40:02.877] [INFO] [system] [Benchmark] 屏幕录制 2025-04-22 175958.mp4 | 168mb | 95.5s | 1.77 MB/s | Ratio: 12.0% | Engine: WebCodecs
[08:51:39.787] [INFO] [system] [Benchmark] 1.14G.mp4 | 1169.55MB -> 277.41MB | 630.3s | 1.86 MB/s | Ratio: 23.7% | Engine: WebCodecs
```
## 2、hardwareAcceleration 设置为 'prefer-hardware'
windows
```
[03:31:19.243] [INFO] [system] [Benchmark] 屏幕录制 2024-09-09 135431.mp4 | 2.21mb | 3.3s | 0.68 MB/s | Ratio: 55.0% | Engine: WebCodecs
[03:32:07.559] [INFO] [system] [Benchmark] 屏幕录制 2025-03-28 110700.mp4 | 14.9mb | 9.9s | 1.51 MB/s | Ratio: 9.0% | Engine: WebCodecs
[03:34:15.716] [INFO] [system] [Benchmark] 屏幕录制 2025-04-22 175958.mp4 | 168mb | 97.0s | 1.74 MB/s | Ratio: 12.0% | Engine: WebCodecs
[09:05:57.176] [INFO] [system] [Benchmark] 1.14G.mp4 | 1169.55MB -> 277.41MB | 506.7s | 2.31 MB/s | Ratio: 23.7% | Engine: WebCodecs
```
Mac 
```
14:55:00.503 [system][Benchmark] 1650721835557188.mp4 | 1.98MB -> 1.61MB | 2.4s | 0.83 MB/s | Ratio: 81.5% | Engine: WebCodecs
14:56:01.813 [system][Benchmark] 录屏2026-04-02 00.24.18.mov | 240.34MB -> 38.13MB | 61.3s | 3.92 MB/s | Ratio: 15.9% | Engine: WebCodecs
14:58:07.756 [system][Benchmark] 录屏2026-04-01 23.59.06.mov | 80.00MB -> 30.10MB | 125.9s | 0.64 MB/s | Ratio: 37.6% | Engine: WebCodecs
15:02:58.241 [system][Benchmark] 录屏2026-04-21 22.53.53.mov | 1086.64MB -> 203.96MB | 175.4s | 6.20 MB/s | Ratio: 18.8% | Engine: WebCodecs
```

##  3、FFmpeg WASM Worker 池化 — 预加载 WASM 实例 和 首帧预热 + 减少初始化链路

windows
```
[Benchmark] 屏幕录制 2024-09-09 135431.mp4 | 2.22MB -> 1.22MB | 2.3s | 0.98 MB/s | Ratio: 55.0% | Engine: WebCodecs
[Benchmark] 屏幕录制 2025-03-28 110700.mp4 | 14.96MB -> 1.34MB | 8.7s | 1.73 MB/s | Ratio: 9.0% | Engine: WebCodecs
[Benchmark] 屏幕录制 2025-04-22 175958.mp4 | 168.94MB -> 20.21MB | 79.5s | 2.13 MB/s | Ratio: 12.0% | Engine: WebCodecs
[Benchmark] 1.14G.mp4 | 1169.55MB -> 277.41MB | 533.7s | 2.19 MB/s | Ratio: 23.7% | Engine: WebCodecs
```