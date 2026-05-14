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

const DB_NAME = 'ai_creation_image_cache';
const DB_VERSION = 1;
const STORE_NAME = 'images';
export const CACHE_TTL_MS = 15 * 24 * 60 * 60 * 1000; // 15 days
export const CACHE_WARN_MS = 3 * 24 * 60 * 60 * 1000; // warn when < 3 days remain
const pendingCacheRequests = new Map();
const failedCacheRequests = new Set();
const sharedObjectUrls = new Map();

export const isSessionBlobUrl = (url) =>
  typeof url === 'string' && url.startsWith('blob:');

export const isDataImageUrl = (url) =>
  typeof url === 'string' && url.startsWith('data:');

export const isCacheableImageUrl = (url) =>
  typeof url === 'string' &&
  url.length > 0 &&
  !isDataImageUrl(url) &&
  !isSessionBlobUrl(url);

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

// Download a remote URL and store the blob. Returns blob URL on success, null on failure.
// Skips caching if the URL is already a data: or blob: URL.
export async function cacheImageBlob(taskId, remoteUrl) {
  if (!taskId || !remoteUrl) return null;
  if (!isCacheableImageUrl(remoteUrl)) return null;
  try {
    // 尝试直接下载
    let response = null;
    try {
      response = await fetch(remoteUrl, {
        credentials: 'include',
        mode: 'cors',
      });
    } catch (directError) {
      console.warn(`Direct fetch failed, trying proxy for ${remoteUrl}:`, directError?.message);
    }

    // 如果直接下载失败，尝试通过后端代理
    if (!response?.ok) {
      if (response) {
        console.warn(`Direct fetch failed (${response.status}), trying proxy for ${remoteUrl}`);
      }
      try {
        response = await fetch('/api/proxy/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: remoteUrl }),
          credentials: 'include',
        });
      } catch (proxyError) {
        console.warn(`Proxy fetch also failed:`, proxyError?.message);
        return null;
      }
    }

    if (!response.ok) {
      console.warn(`Failed to cache image: HTTP ${response.status} for ${remoteUrl}`);
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
        cachedAt: Date.now(),
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    revokeSharedObjectUrls(taskId);
    return setSharedObjectUrl(taskId, remoteUrl, blob);
  } catch (error) {
    console.warn(`Failed to cache image for task ${taskId}:`, error?.message);
    return null;
  }
}

export async function ensureCachedImageUrl(taskId, remoteUrl) {
  if (!taskId) return null;

  const cachedUrl = await getCachedBlobUrl(taskId, remoteUrl);
  if (cachedUrl) return cachedUrl;
  if (!isCacheableImageUrl(remoteUrl)) return null;

  const cacheKey = `${taskId}:${remoteUrl}`;
  if (failedCacheRequests.has(cacheKey)) return null;
  if (!pendingCacheRequests.has(cacheKey)) {
    pendingCacheRequests.set(
      cacheKey,
      cacheImageBlob(taskId, remoteUrl)
        .then((blobUrl) => {
          if (blobUrl) failedCacheRequests.delete(cacheKey);
          else failedCacheRequests.add(cacheKey);
          return blobUrl;
        })
        .finally(() => {
          pendingCacheRequests.delete(cacheKey);
        }),
    );
  }

  await pendingCacheRequests.get(cacheKey);
  return getCachedBlobUrl(taskId, remoteUrl);
}

export async function warmImageBlobCache(taskId, remoteUrl) {
  const displayUrl = await ensureCachedImageUrl(taskId, remoteUrl);
  return Boolean(displayUrl);
}

export async function resolveCachedImageUrl(taskId, sourceUrl) {
  if (isDataImageUrl(sourceUrl)) {
    return { url: sourceUrl, fromCache: false };
  }

  const cachedUrl = await ensureCachedImageUrl(taskId, sourceUrl);
  if (cachedUrl) {
    return { url: cachedUrl, fromCache: true };
  }

  return {
    url: isSessionBlobUrl(sourceUrl) ? '' : sourceUrl || '',
    fromCache: false,
  };
}

// Read cached blob. Returns a shared blob URL, or null if missing/expired.
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

// Returns remaining milliseconds before expiry, or null if not cached.
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
  } catch {}
  revokeSharedObjectUrls(taskId);
}

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
  } catch {}
  taskIds.forEach((id) => revokeSharedObjectUrls(id));
}

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
  } catch {}
  revokeSharedObjectUrls();
}
