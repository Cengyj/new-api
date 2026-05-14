import assert from 'node:assert/strict';

import { selectVideoCacheTaskIdsToPrune } from '../videoCache.js';

const now = Date.now();
const records = [
  { taskId: 'old-large', cachedAt: now - 5000, size: 600 },
  { taskId: 'middle', cachedAt: now - 3000, size: 300 },
  { taskId: 'new-small', cachedAt: now - 1000, size: 100 },
];

assert.deepEqual(
  selectVideoCacheTaskIdsToPrune(records, {
    maxItems: 2,
    maxBytes: 2000,
  }),
  ['old-large'],
);

assert.deepEqual(
  selectVideoCacheTaskIdsToPrune(records, {
    maxItems: 10,
    maxBytes: 700,
  }),
  ['old-large'],
);

assert.deepEqual(
  selectVideoCacheTaskIdsToPrune(records, {
    maxItems: 10,
    maxBytes: 1000,
  }),
  [],
);

console.log('video cache pruning regression checks passed');
