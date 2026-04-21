// native-bridge/extension-page.js
// 极速模式独立 UI：目录选择、文件列表、进度展示

const encoderBadge = document.getElementById('encoderBadge');
const inputDirInput = document.getElementById('inputDir');
const outputDirInput = document.getElementById('outputDir');
const pickInputBtn = document.getElementById('pickInputDir');
const pickOutputBtn = document.getElementById('pickOutputDir');
const codecSelect = document.getElementById('codec');
const crfInput = document.getElementById('crf');
const presetSelect = document.getElementById('preset');
const fileQueue = document.getElementById('fileQueue');
const fileCount = document.getElementById('fileCount');
const startBtn = document.getElementById('startBtn');
const openDirBtn = document.getElementById('openDirBtn');
const statusBar = document.getElementById('statusBar');

let queue = []; // { path, name, size, status, progress, fps, eta }
let isRunning = false;
let outputDirPath = '';

// ── Native Host 检测 ──
async function init() {
  chrome.runtime.sendMessage({ type: 'DETECT_NATIVE' }, (result) => {
    if (chrome.runtime.lastError || !result.available) {
      encoderBadge.textContent = '未检测到 Native Host';
      encoderBadge.classList.remove('available');
      statusBar.textContent = '请先安装 Titan Native Host';
      statusBar.classList.add('error');
      return;
    }
    const enc = result.encoders.join(', ') || 'libx264';
    encoderBadge.textContent = enc;
    encoderBadge.classList.add('available');
    statusBar.textContent = `GPU 引擎就绪: ${enc}`;
    statusBar.classList.add('success');

    // 加载上次使用的设置
    chrome.storage.local.get(['titanInputDir', 'titanOutputDir', 'titanSettings'], (data) => {
      if (data.titanInputDir) {
        inputDirInput.value = data.titanInputDir;
        scanDirectory(data.titanInputDir);
      }
      if (data.titanOutputDir) outputDirInput.value = data.titanOutputDir;
      if (data.titanSettings) {
        if (data.titanSettings.codec) codecSelect.value = data.titanSettings.codec;
        if (data.titanSettings.crf) crfInput.value = data.titanSettings.crf;
        if (data.titanSettings.preset) presetSelect.value = data.titanSettings.preset;
      }
    });
  });
}

// ── 目录选择 (使用 showDirectoryPicker) ──
pickInputBtn.addEventListener('click', async () => {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    // showDirectoryPicker 返回 FileSystemDirectoryHandle，但无法直接获取真实路径
    // 方案：让用户手动粘贴路径，或者我们通过 Native Host 来扫描目录
    // 这里先存 handle，通过 Native Host 扫描
    inputDirInput.value = dirHandle.name; // 只能拿到目录名
    // 实际路径需要通过 Native Host 的文件选择器获取
    // MVP 阶段：让用户在输入框中直接粘贴完整路径
    inputDirInput.value = '';
    inputDirInput.placeholder = '请粘贴完整输入目录路径 (如 C:\\Videos\\input)';
    inputDirInput.removeAttribute('readonly');
    inputDirInput.focus();
  } catch {
    // 用户取消
  }
});

pickOutputBtn.addEventListener('click', async () => {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    outputDirInput.value = '';
    outputDirInput.placeholder = '请粘贴完整输出目录路径';
    outputDirInput.removeAttribute('readonly');
    outputDirInput.focus();
  } catch {
    // 用户取消
  }
});

// ── 扫描目录 (通过 Native Host) ──
function scanDirectory(dir) {
  if (!dir) return;
  chrome.runtime.sendMessage({ type: 'LIST_FILES', payload: { dir } }, (response) => {
    if (response.type === 'files') {
      queue = response.files.map(f => ({
        path: f,
        name: f.split(/[\\/]/).pop(),
        size: 0, // 暂不显示大小
        status: 'pending',
        progress: 0, fps: 0, eta: '',
      }));
      renderQueue();
    } else {
      statusBar.textContent = `扫描失败: ${response.message || '未知错误'}`;
      statusBar.classList.add('error');
    }
  });
}

// 输入目录手动输入时，回车触发扫描
inputDirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && inputDirInput.value.trim()) {
    const dir = inputDirInput.value.trim();
    chrome.storage.local.set({ titanInputDir: dir });
    scanDirectory(dir);
  }
});
outputDirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    outputDirPath = outputDirInput.value.trim();
    chrome.storage.local.set({ titanOutputDir: outputDirPath });
  }
});

// ── 渲染队列 ──
function renderQueue() {
  if (queue.length === 0) {
    fileQueue.innerHTML = '<div class="empty">该目录中没有视频文件</div>';
    fileCount.textContent = '0 个文件';
    return;
  }

  fileCount.textContent = `${queue.length} 个文件`;
  fileQueue.innerHTML = queue.map((item, i) => {
    const icon = { pending: '○', processing: '◌', done: '✓', error: '✕' }[item.status];
    return `<div class="queue-item ${item.status}">
      <span class="icon">${icon}</span>
      <span class="name" title="${item.path}">${item.name}</span>
      <div class="bar"><div class="bar-fill" style="width:${item.progress}%"></div></div>
      <span class="meta">${item.status === 'processing' ? `${item.fps}x · ${item.eta}` :
                          item.status === 'done' ? '完成' :
                          item.status === 'error' ? '失败' : '等待中'}</span>
    </div>`;
  }).join('');
}

// ── 开始压缩 ──
startBtn.addEventListener('click', () => {
  const inputDir = inputDirInput.value.trim();
  if (!inputDir) {
    statusBar.textContent = '请先输入输入目录路径';
    statusBar.classList.add('error');
    return;
  }

  outputDirPath = outputDirInput.value.trim() || inputDir;

  isRunning = true;
  startBtn.disabled = true;
  openDirBtn.disabled = false;
  statusBar.textContent = '开始编码...';
  statusBar.className = 'status-bar processing';

  chrome.runtime.sendMessage({
    type: 'COMPRESS_REQUEST',
    payload: {
      inputDir,
      outputDir: outputDirPath,
      codec: codecSelect.value,
      crf: parseInt(crfInput.value) || 28,
      preset: presetSelect.value,
    },
  }, (response) => {
    switch (response.type) {
      case 'progress':
        updateProgress(response);
        break;
      case 'complete':
        onComplete(response);
        break;
      case 'error':
        onError(response);
        break;
    }
  });
});

function updateProgress(response) {
  // 找到对应文件并更新进度
  const item = queue.find(f => f.name === response.file && f.status === 'processing');
  if (item) {
    item.progress = response.percent;
    item.fps = response.fps;
    item.eta = response.eta;
    renderQueue();
  }
  statusBar.textContent = `编码中 ${response.file} — ${response.percent.toFixed(0)}% · ${response.fps}x · ETA ${response.eta}`;
}

function onComplete(response) {
  isRunning = false;
  startBtn.disabled = false;
  // 标记所有 processing 为 done
  queue.forEach(f => { if (f.status === 'processing') f.status = 'done'; });
  renderQueue();

  const mins = Math.floor(response.durationSec / 60);
  const secs = Math.floor(response.durationSec % 60);
  statusBar.textContent = `全部完成！共 ${response.total} 个文件，总耗时 ${mins}m${secs}s`;
  statusBar.className = 'status-bar success';
}

function onError(response) {
  isRunning = false;
  startBtn.disabled = false;
  statusBar.textContent = `错误: ${response.message}`;
  statusBar.className = 'status-bar error';
}

// ── 打开输出目录 ──
openDirBtn.addEventListener('click', () => {
  const dir = outputDirPath || inputDirInput.value.trim();
  if (dir) {
    chrome.runtime.sendMessage({ type: 'OPEN_OUTPUT_DIR', payload: { path: dir } });
  }
});

// ── 保存设置 ──
[codecSelect, crfInput, presetSelect].forEach(el => {
  el.addEventListener('change', () => {
    chrome.storage.local.set({
      titanSettings: {
        codec: codecSelect.value,
        crf: parseInt(crfInput.value) || 28,
        preset: presetSelect.value,
      },
    });
  });
});

init();
renderQueue();
