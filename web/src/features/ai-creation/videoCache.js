/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

const DB_NAME = 'ai_creation_video_cache';
const DB_VERSION = 1;
const STORE_NAME = 'videos';
const CACHE_TTL_MS = 15 * 24 * 60 * 60 * 1000; // 15 days
const CACHE_WARN_MS = 3 * 24 * 60 * 60 * 1000;  // warn when < 3 days remain
const MAX_CACHE_ITEMS = 100;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const pendingCacheRequests = new Map();
const failedCacheRequests = new Set();
const sharedObjectUrls = new Map();

export const isSessionBlobUrl = (url) =>
  typeof url === 'string' && url.startsWith('blob:');

export const isCacheableVideoUrl = (url) =>
  typeof url === 'string' && url.length > 0 && !isSessionBlobUrl(url);

const revokeObjectUrl = (url) => {
  if (!isSessionBlobUrl(url)) return;
  try {
    URL.revokeObjectURL(url);
  } catch {}
};

const getSharedUrlKey = (taskId, remoteUrl = '') =>
  `${taskId}:${remoteUrl || ''}`;

const getSharedObjectUrl = (taskId, remoteUrl = '') => {
  if (!taskId) return null;
  if (remoteUrl) {
    return sharedObjectUrls.get(getSharedUrlKey(taskId, remoteUrl)) || null;
  }
  for (const [key, url] of sharedObjectUrls.entries()) {
    if (key.startsWith(`${taskId}:`)) return url;
  }
  return null;
};

const setSharedObjectUrl = (taskId, remoteUrl, blob) => {
  const key = getSharedUrlKey(taskId, remoteUrl);
  const existing = sharedObjectUrls.get(key);
  if (existing) return existing;
  const blobUrl = URL.createObjectURL(blob);
  sharedObjectUrls.set(key, blobUrl);
  return blobUrl;
};

const revokeSharedObjectUrls = (taskId) => {
  for (const [key, url] of sharedObjectUrls.entries()) {
    if (!taskId || key.startsWith(`${taskId}:`)) {
      revokeObjectUrl(url);
      sharedObjectUrls.delete(key);
    }
  }
};

export const selectVideoCacheTaskIdsToPrune = (
  records = [],
  { maxItems = MAX_CACHE_ITEMS, maxBytes = MAX_CACHE_BYTES } = {},
) => {
  const normalized = (Array.isArray(records) ? records : [])
    .filter((record) => record?.taskId)
    .map((record) => ({
      taskId: String(record.taskId),
      cachedAt: Number(record.cachedAt) || 0,
      size: Number(record.size ?? record.blob?.size ?? 0) || 0,
    }))
    .sort((a, b) => a.cachedAt - b.cachedAt);
  let totalBytes = normalized.reduce((sum, record) => sum + record.size, 0);
  let itemCount = normalized.length;
  const removeIds = [];

  for (const record of normalized) {
    if (itemCount <= maxItems && totalBytes <= maxBytes) break;
    removeIds.push(record.taskId);
    itemCount -= 1;
    totalBytes -= record.size;
  }

  return removeIds;
};

async function pruneVideoCache(db) {
  const records = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error);
  });
  const removeIds = selectVideoCacheTaskIdsToPrune(records);
  if (!removeIds.length) return;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    removeIds.forEach((id) => store.delete(id));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  removeIds.forEach((id) => revokeSharedObjectUrls(id));
}

// Open (or create) the IndexedDB database
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'taskId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Download a remote URL and store the blob in IndexedDB under taskId.
// Returns the blob URL on success, null on failure.
export async function cacheVideoBlob(taskId, remoteUrl) {
  if (!taskId || !remoteUrl) return null;
  if (!isCacheableVideoUrl(remoteUrl)) return null;
  try {
    const response = await fetch(remoteUrl, {
      credentials: 'include',
      mode: 'cors'
    });
    if (!response.ok) {
      console.warn(`Failed to cache video: HTTP ${response.status} for ${remoteUrl}`);
      return null;
    }
    const blob = await response.blob();
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({
        taskId,
        remoteUrl,
        blob,
        size: blob.size || 0,
        cachedAt: Date.now(),
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await pruneVideoCache(db).catch((pruneError) => {
      console.warn('Failed to prune video cache:', pruneError?.message);
    });
    db.close();
    revokeSharedObjectUrls(taskId);
    return setSharedObjectUrl(taskId, remoteUrl, blob);
  } catch (error) {
    console.warn(`Failed to cache video for task ${taskId}:`, error?.message);
    return null;
  }
}

export async function ensureCachedVideoUrl(taskId, remoteUrl) {
  if (!taskId) return null;
  const cachedUrl = await getCachedBlobUrl(taskId, remoteUrl);
  if (cachedUrl) return cachedUrl;
  if (!isCacheableVideoUrl(remoteUrl)) return null;

  const cacheKey = `${taskId}:${remoteUrl}`;
  if (failedCacheRequests.has(cacheKey)) return null;
  if (!pendingCacheRequests.has(cacheKey)) {
    pendingCacheRequests.set(
      cacheKey,
      cacheVideoBlob(taskId, remoteUrl)
        .then((blobUrl) => {
          if (blobUrl) failedCacheRequests.delete(cacheKey);
          else failedCacheRequests.add(cacheKey);
          return blobUrl;
        })
        .finally(() => pendingCacheRequests.delete(cacheKey)),
    );
  }

  await pendingCacheRequests.get(cacheKey);
  return getCachedBlobUrl(taskId, remoteUrl);
}

export async function warmVideoBlobCache(taskId, remoteUrl) {
  const displayUrl = await ensureCachedVideoUrl(taskId, remoteUrl);
  return Boolean(displayUrl);
}

export async function resolveCachedVideoUrl(taskId, sourceUrl) {
  if (isSessionBlobUrl(sourceUrl)) {
    return { url: sourceUrl, fromCache: false };
  }

  const cachedUrl = await ensureCachedVideoUrl(taskId, sourceUrl);
  if (cachedUrl) {
    return { url: cachedUrl, fromCache: true };
  }

  return {
    url: sourceUrl || '',
    fromCache: false,
  };
}

// Read a cached blob from IndexedDB and return a blob URL.
// Returns null if not cached or expired (expired entries are deleted).
export async function getCachedBlobUrl(taskId, expectedUrl = '') {
  if (!taskId) return null;
  const sharedUrl = getSharedObjectUrl(taskId, expectedUrl);
  if (sharedUrl) return sharedUrl;
  try {
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(taskId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!record?.blob) { db.close(); return null; }
    if (
      expectedUrl &&
      record.remoteUrl &&
      record.remoteUrl !== expectedUrl
    ) {
      db.close();
      return null;
    }
    if (Date.now() - record.cachedAt > CACHE_TTL_MS) {
      // Expired — delete and fall back to remote URL
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(taskId);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
      db.close();
      revokeSharedObjectUrls(taskId);
      return null;
    }
    db.close();
    return setSharedObjectUrl(
      taskId,
      record.remoteUrl || expectedUrl || '',
      record.blob,
    );
  } catch {
    return null;
  }
}

// Returns the number of milliseconds remaining before the cache entry expires.
// Returns null if not cached.
export async function getCacheRemainingMs(taskId) {
  if (!taskId) return null;
  try {
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(taskId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!record?.cachedAt) return null;
    const remaining = CACHE_TTL_MS - (Date.now() - record.cachedAt);
    return remaining > 0 ? remaining : 0;
  } catch {
    return null;
  }
}

export { CACHE_TTL_MS, CACHE_WARN_MS };

// Delete cached blob for a single task.
export async function deleteCachedBlob(taskId) {
  if (!taskId) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(taskId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
  revokeSharedObjectUrls(taskId);
}

// Delete cached blobs for multiple tasks.
export async function deleteCachedBlobs(taskIds) {
  if (!taskIds?.length) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      taskIds.forEach((id) => store.delete(id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
  taskIds.forEach((id) => revokeSharedObjectUrls(id));
}

// Clear all cached blobs.
export async function clearAllCachedBlobs() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
  revokeSharedObjectUrls();
}

// Resolve a task's display URL: blob URL from cache if available, else remote URL.
export async function resolveVideoUrl(taskId, remoteUrl) {
  const blobUrl = await getCachedBlobUrl(taskId, remoteUrl);
  return blobUrl || remoteUrl || '';
}
