// native-bridge/background.js
// Service Worker: 管理 Native Messaging 连接，透传消息给扩展页

const HOST_NAME = 'com.titan.video.host';

let nativePort = null;
let messageHandlers = new Map(); // requestId -> callback
let nextRequestId = 1;

// 接收来自 extension-page 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DETECT_NATIVE') {
    detectNative(sendResponse);
    return true;
  }
  if (msg.type === 'PICK_DIR') {
    handlePickDir(sendResponse);
    return true;
  }
  if (msg.type === 'COMPRESS_REQUEST') {
    handleCompress(msg.payload, sendResponse);
    return true;
  }
  if (msg.type === 'LIST_FILES') {
    handleListFiles(msg.payload, sendResponse);
    return true;
  }
  if (msg.type === 'OPEN_OUTPUT_DIR') {
    openOutputDir(msg.payload);
    return true;
  }
});

function detectNative(callback) {
  try {
    const port = chrome.runtime.connectNative(HOST_NAME);
    const timeout = setTimeout(() => {
      port.disconnect();
      callback({ available: false });
    }, 2000);

    port.onMessage.addListener((response) => {
      if (response.type === 'pong') {
        clearTimeout(timeout);
        nativePort = port;
        callback({ available: true, encoders: response.encoders || [] });
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
      nativePort = null;
    });

    port.postMessage({ type: 'ping' });
  } catch {
    callback({ available: false });
  }
}

function handleCompress(payload, callback) {
  if (!nativePort) {
    callback({ type: 'error', message: 'Native host not connected' });
    return;
  }

  const requestId = nextRequestId++;

  const onMsg = (response) => {
    if (response._requestId !== requestId) return;

    switch (response.type) {
      case 'progress':
        callback({
          type: 'progress',
          file: response.file,
          percent: response.percent,
          fps: response.fps,
          eta: response.eta,
          _requestId: requestId,
        });
        break;
      case 'complete':
        nativePort.onMessage.removeListener(onMsg);
        callback({
          type: 'complete',
          total: response.total,
          durationSec: response.durationSec,
          _requestId: requestId,
        });
        break;
      case 'error':
        nativePort.onMessage.removeListener(onMsg);
        callback({
          type: 'error',
          message: response.message,
          _requestId: requestId,
        });
        break;
    }
  };

  nativePort.onMessage.addListener(onMsg);
  nativePort.postMessage({
    type: 'compress',
    _requestId: requestId,
    inputDir: payload.inputDir,
    outputDir: payload.outputDir,
    codec: payload.codec,
    crf: payload.crf,
    preset: payload.preset,
  });
}

function handlePickDir(callback) {
  if (!nativePort) {
    callback({ path: null });
    return;
  }
  nativePort.postMessage({ type: 'pick_dir' });
  const onMsg = (response) => {
    if (response.type === 'picked_dir') {
      nativePort.onMessage.removeListener(onMsg);
      callback({ path: response.path });
    }
  };
  nativePort.onMessage.addListener(onMsg);
}

function handleListFiles(payload, callback) {
  if (!nativePort) {
    callback({ type: 'error', message: 'Native host not connected' });
    return;
  }

  nativePort.postMessage({ type: 'list_files', dir: payload.dir });

  // 一次性监听响应
  const onMsg = (response) => {
    if (response.type === 'files') {
      nativePort.onMessage.removeListener(onMsg);
      callback({ type: 'files', files: response.files });
    }
  };
  nativePort.onMessage.addListener(onMsg);
}

function openOutputDir(payload) {
  if (!nativePort) return;
  nativePort.postMessage({ type: 'open_dir', path: payload.path });
}

// ── 外部网站连接（externally_connectable）────────────────────────────
// 网站用 chrome.runtime.connect() 建立长连接，支持流式 progress 回调。
// sendMessage 只能单次回调，compress 的多次 progress 必须走 Port。
chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'DETECT_NATIVE':
        detectNative((res) => { try { port.postMessage(res); } catch {} });
        break;
      case 'PICK_DIR':
        handlePickDir((res) => { try { port.postMessage(res); } catch {} });
        break;
      case 'LIST_FILES':
        handleListFiles(msg, (res) => { try { port.postMessage(res); } catch {} });
        break;
      case 'COMPRESS_REQUEST':
        handleCompressPort(msg, port);
        break;
      case 'OPEN_OUTPUT_DIR':
        openOutputDir(msg);
        break;
    }
  });
});

function handleCompressPort(msg, port) {
  if (!nativePort) {
    try { port.postMessage({ type: 'error', message: 'Native host not connected' }); } catch {}
    return;
  }

  const requestId = nextRequestId++;

  const onNativeMsg = (response) => {
    if (response._requestId !== requestId) return;
    try {
      switch (response.type) {
        case 'progress':
          port.postMessage({ type: 'progress', file: response.file, percent: response.percent, fps: response.fps, eta: response.eta });
          break;
        case 'complete':
          nativePort.onMessage.removeListener(onNativeMsg);
          port.postMessage({ type: 'complete', total: response.total, durationSec: response.durationSec });
          break;
        case 'error':
          nativePort.onMessage.removeListener(onNativeMsg);
          port.postMessage({ type: 'error', message: response.message });
          break;
      }
    } catch {
      // port disconnected — clean up listener
      nativePort.onMessage.removeListener(onNativeMsg);
    }
  };

  port.onDisconnect.addListener(() => nativePort?.onMessage.removeListener(onNativeMsg));

  nativePort.onMessage.addListener(onNativeMsg);
  nativePort.postMessage({
    type: 'compress',
    _requestId: requestId,
    inputDir: msg.inputDir,
    outputDir: msg.outputDir,
    codec: msg.codec,
    crf: msg.crf,
    preset: msg.preset,
  });
}
