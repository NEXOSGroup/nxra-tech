// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-local-filesystem.ts — Local Working Folder for realvirtual WEB.
 *
 * A single "working folder" is configured once in settings. All features
 * (models, planner library, splats) read from defined subfolders:
 *
 *   <working-folder>/
 *   ├── models/          → .glb files for main viewer model selector
 *   ├── library/         → .glb files for layout planner library
 *   │   ├── conveyor/    → category subfolder (optional)
 *   │   ├── robot/
 *   │   └── ...
 *   ├── splats/          → .splat, .ksplat, .ply, .pcd files
 *   └── settings.json    → optional local overrides (future)
 *
 * The directory handle is persisted in IndexedDB so it survives page reloads.
 * On reload, the browser may prompt the user to re-grant read permission.
 *
 * Chrome/Edge 86+ only. Use `isSupported()` to feature-detect.
 */

// ─── Constants ──────────────────────────────────────────────────────────

const DB_NAME = 'rv-filesystem';
const DB_VERSION = 1;
const STORE_HANDLES = 'handles';
const HANDLE_KEY = 'workfolder';
const LS_KEY = 'rv-local-folders';

/** Well-known subfolder names inside the working folder. */
export const SUBFOLDER = {
  models: 'models',
  library: 'library',
  splats: 'splats',
} as const;

export type SubfolderName = keyof typeof SUBFOLDER;

// ─── Types ──────────────────────────────────────────────────────────────

export interface LocalFileEntry {
  name: string;
  path: string;           // relative path from subfolder root (e.g. "conveyor/belt.glb")
  handle: FileSystemFileHandle;
}

export interface WorkFolderMeta {
  displayName: string;
  lastAccessed: string;   // ISO date
}

// ─── Feature detection ──────────────────────────────────────────────────

export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// ─── IndexedDB helpers ──────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).put(handle, HANDLE_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function getHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readonly');
    const req = tx.objectStore(STORE_HANDLES).get(HANDLE_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function deleteStoredHandle(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).delete(HANDLE_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ─── localStorage metadata ──────────────────────────────────────────────

function getMeta(): WorkFolderMeta | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setMeta(meta: WorkFolderMeta): void {
  localStorage.setItem(LS_KEY, JSON.stringify(meta));
}

function clearMeta(): void {
  localStorage.removeItem(LS_KEY);
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Show the native directory picker dialog and set it as the working folder.
 * Returns the directory handle on success, null if user cancels.
 */
export async function selectWorkFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isSupported()) return null;
  try {
    const handle = await window.showDirectoryPicker!({ id: 'rv-workfolder', mode: 'read' });
    await putHandle(handle);
    setMeta({ displayName: handle.name, lastAccessed: new Date().toISOString() });
    return handle;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/**
 * Retrieve the previously configured working folder and verify permission.
 * Returns null if no folder stored or permission denied.
 * @param prompt If true (default), will ask user to re-grant if needed.
 */
export async function getWorkFolder(prompt = true): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getHandle();
  if (!handle) return null;

  const perm = await handle.queryPermission({ mode: 'read' });
  if (perm === 'granted') {
    setMeta({ displayName: handle.name, lastAccessed: new Date().toISOString() });
    return handle;
  }
  if (prompt) {
    const result = await handle.requestPermission({ mode: 'read' });
    if (result === 'granted') {
      setMeta({ displayName: handle.name, lastAccessed: new Date().toISOString() });
      return handle;
    }
  }
  return null;
}

/**
 * Remove the stored working folder.
 */
export async function removeWorkFolder(): Promise<void> {
  await deleteStoredHandle();
  clearMeta();
}

/**
 * Get metadata about the configured working folder (without requiring permission).
 */
export function getWorkFolderMeta(): WorkFolderMeta | null {
  return getMeta();
}

/**
 * Get a subfolder handle from the working folder.
 * Returns null if the subfolder doesn't exist (won't create it).
 */
export async function getSubfolder(
  workFolder: FileSystemDirectoryHandle,
  subfolder: SubfolderName,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await workFolder.getDirectoryHandle(SUBFOLDER[subfolder]);
  } catch {
    return null; // subfolder doesn't exist
  }
}

/**
 * Recursively enumerate files in a directory handle filtered by extensions.
 * @param handle Directory handle to scan
 * @param extensions Array of extensions WITH dot (e.g. ['.glb', '.splat'])
 * @param maxDepth Maximum recursion depth (default 5)
 */
export async function listFiles(
  handle: FileSystemDirectoryHandle,
  extensions: string[],
  maxDepth = 5,
): Promise<LocalFileEntry[]> {
  const results: LocalFileEntry[] = [];
  const lowerExts = extensions.map(e => e.toLowerCase());

  async function walk(dir: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'file') {
        const lower = name.toLowerCase();
        if (lowerExts.some(ext => lower.endsWith(ext))) {
          results.push({
            name,
            path: prefix ? `${prefix}/${name}` : name,
            handle: entry as FileSystemFileHandle,
          });
        }
      } else if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, prefix ? `${prefix}/${name}` : name, depth + 1);
      }
    }
  }

  await walk(handle, '', 0);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Read a file from a handle and return a blob URL.
 * Caller is responsible for revoking the URL when done.
 */
export async function readFileAsUrl(fileHandle: FileSystemFileHandle): Promise<string> {
  const file = await fileHandle.getFile();
  return URL.createObjectURL(file);
}

/**
 * Request readwrite permission on an already-acquired folder handle.
 * The original picker uses `mode: 'read'`; this upgrades the existing
 * handle in place (no re-pick) so users keep their granted folder.
 * Returns true if granted.
 */
export async function requestWriteAccess(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const current = await handle.queryPermission({ mode: 'readwrite' });
  if (current === 'granted') return true;
  const result = await handle.requestPermission({ mode: 'readwrite' });
  return result === 'granted';
}

/**
 * Get a subfolder handle, creating it if it doesn't exist. Requires
 * readwrite permission on the parent.
 */
export async function getOrCreateSubfolder(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

/**
 * Write a Blob into a directory as `filename`, overwriting if it exists.
 * Caller must hold readwrite permission on `dir`.
 */
export async function writeBlobFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Convenience: get files from a specific subfolder of the working folder.
 * Returns empty array if working folder not set or subfolder doesn't exist.
 */
export async function listSubfolderFiles(
  subfolder: SubfolderName,
  extensions: string[],
  promptPermission = false,
): Promise<LocalFileEntry[]> {
  const root = await getWorkFolder(promptPermission);
  if (!root) return [];
  const sub = await getSubfolder(root, subfolder);
  if (!sub) return [];
  return listFiles(sub, extensions);
}
