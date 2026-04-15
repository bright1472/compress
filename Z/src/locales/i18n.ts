import { ref, computed } from 'vue';

export const zh = {
  app: {
    title: 'Titan Compress',
    subtitle: 'PROFESSIONAL MEDIA ENGINE',
    darkMode: '暗色',
    lightMode: '亮色',
  },
  queue: {
    title: '文件队列',
    addFiles: '+ 选择视频文件',
    pending: '待处理',
    processing: '处理中...',
    done: '已完成',
    error: '失败',
    saved: '节省',
    unsupportedFormat: '不支持的文件格式',
  },
  config: {
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
  },
  process: {
    start: '开始压缩',
    dragToArea: '拖拽视频文件至此区域',
    supportBatch: '支持批量拖入多个文件 · 最高支持单文件 10GB+ · 文件不会上传至任何服务器',
    orClick: '或点击选择文件',
    clickToPreview: '点击左侧队列中的文件以预览',
    originalVideo: '原始视频',
    configureAndStart: '配置左侧参数后点击「开始压缩」',
    compressing: '正在压缩',
    loadingEngine: '加载引擎中...',
    queueRemaining: '队列剩余 {n} 个文件',
  },
  slider: {
    original: 'ORIGINAL',
    compressed: 'COMPRESSED',
    dragToCompare: '拖动对比 · 时间轴已同步',
  }
};

export const en = {
  app: {
    title: 'Titan Compress',
    subtitle: 'PROFESSIONAL MEDIA ENGINE',
    darkMode: 'Dark',
    lightMode: 'Light',
  },
  queue: {
    title: 'File Queue',
    addFiles: '+ Select Videos',
    pending: 'Pending',
    processing: 'Processing...',
    done: 'Done',
    error: 'Failed',
    saved: 'Saved',
    unsupportedFormat: 'Unsupported format',
  },
  config: {
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
  },
  process: {
    start: 'Start Compression',
    dragToArea: 'Drag and drop videos here',
    supportBatch: 'Supports batch processing · Fast 10GB+ file compression · 100% Local, no server uploads',
    orClick: 'Or click to select files',
    clickToPreview: 'Click a file in the queue to preview',
    originalVideo: 'Original Video',
    configureAndStart: 'Configure parameters and click "Start Compression"',
    compressing: 'Compressing',
    loadingEngine: 'Loading Engine...',
    queueRemaining: '{n} files remaining in queue',
  },
  slider: {
    original: 'ORIGINAL',
    compressed: 'COMPRESSED',
    dragToCompare: 'Drag to compare · Timeline synced',
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
