/// <reference types="vite/client" />

// File System Access API
interface FileSystemDirectoryHandle {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  queryPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}
interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}
interface FileSystemWritableFileStream {
  write(data: Blob | string | ArrayBuffer): Promise<void>;
  close(): Promise<void>;
}
interface Window {
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}
