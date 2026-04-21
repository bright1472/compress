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
