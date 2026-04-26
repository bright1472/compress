import { ref, computed } from 'vue';

const IDB_DB = 'titan-compress';
const IDB_STORE = 'handles';
const IDB_KEY = 'outputDir';

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openIDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(): Promise<void> {
  const db = await openIDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const isOutputDirSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export const dirHandle = ref<FileSystemDirectoryHandle | null>(null);
export const dirName = computed(() => dirHandle.value?.name ?? '');
export const autoSaveEnabled = computed(() => dirHandle.value !== null);

// Restore persisted handle on init — only if permission is still granted
if (isOutputDirSupported) {
  idbGet().then(async (h) => {
    if (!h) return;
    const perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') dirHandle.value = h;
  }).catch(() => {});
}

export async function pickDir(): Promise<boolean> {
  if (!isOutputDirSupported || !window.showDirectoryPicker) return false;
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' });
    dirHandle.value = h;
    await idbPut(h);
    return true;
  } catch {
    return false; // user cancelled
  }
}

export async function clearDir(): Promise<void> {
  dirHandle.value = null;
  await idbDelete();
}

export async function autoSave(blob: Blob, filename: string): Promise<boolean> {
  if (!dirHandle.value) return false;
  try {
    const perm = await dirHandle.value.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    const fh = await dirHandle.value.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  } catch {
    return false;
  }
}
