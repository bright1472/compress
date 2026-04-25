import { ref, computed } from 'vue';

export const zh = {
  app: {
    title: '泰坦压缩',
    subtitle: 'NATIVE-GRADE MEDIA ENGINE',
    slogan: '免视频上传下载 · 极致隐私 · GPU 加速',
    darkMode: '暗色',
    lightMode: '亮色',
  },
  nav: {
    diagnostic: '诊断日志',
    settings: '压缩设置',
    toggleLight: '切换亮色',
    toggleDark: '切换暗色',
  },
  features: {
    gpu: { title: 'GPU 硬件加速', desc: '原生级转码速度' },
    size: { title: '10GB+ 超大文件', desc: '突破浏览器上限' },
    privacy: { title: '100% 隐私安全', desc: '数据不经过服务器' },
  },
  stats: {
    files: '文件',
    done: '已完成',
    saved: '节省',
  },
  queue: {
    title: '文件队列',
    header: '队列',
    addFiles: '选择视频文件',
    pending: '待处理',
    processing: '处理中...',
    done: '已完成',
    error: '失败',
    saved: '节省',
    unsupportedFormat: '不支持的文件格式',
    dropToAdd: '松开以添加到队列',
    empty: '拖入文件开始',
    clearQueue: '清空队列',
    remove: '移除',
    removeConfirm: '确定要停止并移除当前正在处理的任务吗？',
    dragToSort: '拖动排序',
    download: '下载',
  },
  mode: {
    video: '视频',
    image: '图片',
    switchTo: '切换到{mode}模式',
  },
  config: {
    title: '压缩参数设置',
    codec: '编码格式',
    bestCompatibility: '兼容性最佳',
    highCompression: '高效压缩',
    nextGen: '次世代格式',
    qualityCRF: '质量系数 CRF',
    visuallyLossless: '视觉无损',
    highQuality: '高质量',
    balanced: '均衡',
    highCompressRate: '高压缩',
    fine: '精细',
    compress: '压缩',
    encodeSpeed: '编码速度',
    ultrafast: '极速',
    fast: '快速',
    medium: '标准',
    slow: '精细',
    largerFile: '文件稍大',
    recommended: '均衡推荐',
    moreCompression: '更高压缩',
    bestQuality: '最优质量',

    showLogger: '显示诊断日志按钮',
  },
  image: {
    sectionLabel: '图片压缩设置',
    outputFormat: '输出格式',
    original: '保持原格式',
    quality: '压缩质量',
    qualityHint: 'PNG 使用精度压缩；JPG / WebP / AVIF 使用有损压缩',
    avifNotSupported: '当前浏览器不支持 AVIF，将使用 WebP 代替',
    webpNotSupported: '当前浏览器不支持 WebP 输出',
    addFiles: '选择图片文件',
    dragToArea: '点击或拖拽图片到此开始',
    supportBatch: '支持批量处理 · 浏览器本地处理 · 毫秒级响应',
  },
  process: {
    start: '开始压缩',
    dragToArea: '点击或拖拽视频文件到此开始',
    supportBatch: '支持批量处理 · 最高支持单文件 10GB+ · 100% 本地处理',
    clickToPreview: '点击左侧文件查看预览',
    originalVideo: '原始视频',
    configureAndStart: '配置左侧参数后点击「开始压缩」',
    configAndStart: '点击 ⚙ 配置参数后开始压缩',
    compressing: '编码中',
    loadingEngine: '加载引擎',
    queueRemaining: '队列剩余 {n} 个文件',
    filesInQueue: '{n} 个文件待处理',
    encodingFailed: '编码失败',
    errorHint: '请检查：WebCodecs 浏览器支持 · 视频格式是否有效',
    downloadAll: '全部下载 ({n})',
    remainingTime: '剩余 {t}',
  },
  metrics: {
    codec: '编码器',
    quality: '质量',
    throughput: '速度',
    remaining: '剩余时间',
  },
  slider: {
    original: 'ORIGINAL',
    compressed: 'COMPRESSED',
    dragToCompare: '拖动对比 · 时间轴已同步',
  },
  console: {
    title: '诊断控制台',
    paused: '(已暂停)',
    errorsOnly: '仅显示错误',
    benchmarksOnly: '只看性能',
    refresh: '获取最新日志',
    empty: '暂无日志...',
    copy: '复制',
  }
};

export const en = {
  app: {
    title: 'Titan Compress',
    subtitle: 'NATIVE-GRADE MEDIA ENGINE',
    slogan: 'NO UPLOAD · TOTAL PRIVACY · GPU ACCELERATED',
    darkMode: 'Dark',
    lightMode: 'Light',
  },
  nav: {
    diagnostic: 'Diagnostic Logs',
    settings: 'Compression Settings',
    toggleLight: 'Switch to Light Mode',
    toggleDark: 'Switch to Dark Mode',
  },
  features: {
    gpu: { title: 'GPU Accelerated', desc: 'Native transcoding speed' },
    size: { title: '10GB+ Capability', desc: 'Beyond browser limits' },
    privacy: { title: '100% Private', desc: 'No server side processing' },
  },
  stats: {
    files: 'FILES',
    done: 'DONE',
    saved: 'MB SAVED',
  },
  queue: {
    title: 'File Queue',
    header: 'QUEUE',
    addFiles: 'Select Videos',
    pending: 'Pending',
    processing: 'Processing...',
    done: 'Done',
    error: 'Failed',
    saved: 'Saved',
    unsupportedFormat: 'Unsupported format',
    dropToAdd: 'Release to add to queue',
    empty: 'Drop files to start',
    clearQueue: 'Clear Queue',
    remove: 'Remove',
    removeConfirm: 'Stop and remove the current active task?',
    dragToSort: 'Drag to sort',
    download: 'Download',
  },
  mode: {
    video: 'Video',
    image: 'Image',
    switchTo: 'Switch to {mode} mode',
  },
  config: {
    title: 'COMPRESSION SETTINGS',
    codec: 'Codec',
    bestCompatibility: 'Best Compat.',
    highCompression: 'High Compress',
    nextGen: 'Next Gen',
    qualityCRF: 'Quality (CRF)',
    visuallyLossless: 'Lossless',
    highQuality: 'High Quality',
    balanced: 'Balanced',
    highCompressRate: 'Small Size',
    fine: 'Fine',
    compress: 'Compress',
    encodeSpeed: 'Encode Speed',
    ultrafast: 'Ultrafast',
    fast: 'Fast',
    medium: 'Medium',
    slow: 'Slow',
    largerFile: 'Larger File',
    recommended: 'Recommended',
    moreCompression: 'Smaller File',
    bestQuality: 'Best Quality',

    showLogger: 'Show Diagnostics Button',
  },
  image: {
    sectionLabel: 'Image Compression',
    outputFormat: 'Output Format',
    original: 'Keep Original',
    quality: 'Quality',
    qualityHint: 'PNG uses precision compression; JPG / WebP / AVIF use lossy compression.',
    avifNotSupported: 'AVIF not supported, falling back to WebP',
    webpNotSupported: 'WebP output not supported in this browser',
    addFiles: 'Select Images',
    dragToArea: 'Click or drop images here to start',
    supportBatch: 'Batch · Local-only · Millisecond response',
  },
  process: {
    start: 'Start Compression',
    dragToArea: 'Click or Drop videos here to start',
    supportBatch: 'Supports batch processing · 10GB+ massive files · 100% Local',
    clickToPreview: 'Click a file to preview',
    originalVideo: 'Original Video',
    configureAndStart: 'Configure parameters and click "Start Compression"',
    configAndStart: 'Configure ⚙ then start compression',
    compressing: 'ENCODING',
    loadingEngine: 'LOADING ENGINE',
    queueRemaining: '{n} files remaining in queue',
    filesInQueue: '{n} files in queue',
    encodingFailed: 'ENCODING FAILED',
    errorHint: 'Check: WebCodecs browser support · Valid file format',
    downloadAll: 'Download All ({n})',
    remainingTime: 'Remaining {t}',
  },
  metrics: {
    codec: 'CODEC',
    quality: 'QUALITY',
    throughput: 'SPEED',
    remaining: 'REMAINING',
  },
  slider: {
    original: 'ORIGINAL',
    compressed: 'COMPRESSED',
    dragToCompare: 'Drag to compare · Timeline synced',
  },
  console: {
    title: 'Diagnostic Console',
    paused: '(Paused)',
    errorsOnly: 'Errors Only',
    benchmarksOnly: 'Benchmark Only',
    refresh: 'Fetch latest logs',
    empty: 'No logs yet...',
    copy: 'Copy',
  }
};


export type LocaleInfo = 'en' | 'zh';
type Dict = typeof zh;

const THEME_KEY = 'titan-locale';
const savedLocale = localStorage.getItem(THEME_KEY) as LocaleInfo;
export const currentLocale = ref<LocaleInfo>(savedLocale || 'zh');

export const setLocale = (loc: LocaleInfo) => {
  currentLocale.value = loc;
  localStorage.setItem(THEME_KEY, loc);
};

export const t = computed<(key: string, args?: Record<string, any>) => string>(() => {
  return (key: string, args?: Record<string, any>) => {
    const dict = currentLocale.value === 'zh' ? zh : en;
    const keys = key.split('.');
    let val: any = dict;
    for (const k of keys) {
      if (val === undefined) break;
      val = val[k as keyof typeof val];
    }
    let res = typeof val === 'string' ? val : key;
    if (args) {
      for (const [k, v] of Object.entries(args)) {
        res = res.replace(`{${k}}`, String(v));
      }
    }
    return res;
  };
});
