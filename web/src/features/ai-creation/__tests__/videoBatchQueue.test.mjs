import assert from 'node:assert/strict';

import { TASK_STATUS } from '../constants.js';
import {
  VIDEO_BATCH_STATUS,
  VIDEO_TASK_SOURCE,
  cancelVideoBatchTasks,
  clearSettledVideoBatchTasks,
  createVideoBatchTasks,
  isVideoBatchGeneratedTask,
  loadVideoBatchTasks,
  normalizeVideoBatchTask,
  retryVideoBatchTask,
  saveVideoBatchTasks,
  summarizeVideoBatchTasks,
} from '../videoBatchQueue.js';

const tasks = createVideoBatchTasks({
  count: 2,
  prompts: [' first video ', 'second video'],
  ratio: '9:16',
  duration: 10,
  resolution: '480p',
  model: 'grok-imagine-video',
  group: 'default',
  referenceImages: ['ref-a', 'ref-b'],
  source: VIDEO_TASK_SOURCE.BATCH,
  batchRowId: 'row-a',
  batchRowIndex: 3,
});

assert.equal(tasks.length, 4);
assert.equal(new Set(tasks.map((task) => task.id)).size, 4);
assert.equal(tasks[0].status, TASK_STATUS.GENERATING);
assert.equal(tasks[0].batchStatus, VIDEO_BATCH_STATUS.QUEUED);
assert.equal(tasks[0].prompt, 'first video');
assert.equal(tasks[0].ratio, '9:16');
assert.equal(tasks[0].duration, '10s');
assert.equal(tasks[0].resolution, '480p');
assert.equal(tasks[0].size, '720x1280');
assert.equal(tasks[0].preset, 'normal');
assert.equal(tasks[0].source, VIDEO_TASK_SOURCE.BATCH);
assert.equal(tasks[0].batchRowId, 'row-a');
assert.equal(tasks[0].batchRowIndex, 3);
assert.equal(tasks[0].referenceCount, 2);
assert.equal(tasks[0].params.seconds, 10);
assert.equal(tasks[0].params.size, '720x1280');
assert.equal(tasks[0].params.preset, 'normal');
assert.equal(tasks[0].params.count, 1);
assert.equal(tasks[0].params.source, VIDEO_TASK_SOURCE.BATCH);
assert.equal(tasks[0].params.batchRowId, 'row-a');
assert.equal(tasks[0].params.batchRowIndex, 3);
assert.deepEqual(tasks[0].params.referenceImages, ['ref-a', 'ref-b']);
assert.equal(tasks[2].params.promptIndex, 1);
assert.equal(tasks[2].params.copyIndex, 0);
assert.equal(isVideoBatchGeneratedTask(tasks[0]), true);

const migrated = normalizeVideoBatchTask({
  id: 'old-task',
  status: 'unknown',
  params: {
    prompt: 'legacy',
    ratio: 'bad',
    duration: '12',
    resolution: 'bad',
    batchRowId: 'legacy-row',
    referenceImages: Array.from({ length: 10 }, (_, index) => `ref-${index}`),
  },
});
assert.equal(migrated.status, TASK_STATUS.GENERATING);
assert.equal(migrated.source, VIDEO_TASK_SOURCE.BATCH);
assert.equal(migrated.batchRowId, 'legacy-row');
assert.equal(migrated.ratio, '16:9');
assert.equal(migrated.duration, '12s');
assert.equal(migrated.resolution, '720p');
assert.equal(migrated.referenceCount, 7);
assert.equal(migrated.params.referenceImages.length, 7);

const summary = summarizeVideoBatchTasks(tasks);
assert.equal(summary.total, 4);
assert.equal(summary.queued, 4);
assert.equal(summary.active, 4);

const cancelledQueue = cancelVideoBatchTasks(tasks, [tasks[0].id, tasks[1].id]);
assert.equal(cancelledQueue[0].batchStatus, VIDEO_BATCH_STATUS.CANCELLED);
assert.equal(cancelledQueue[1].batchStatus, VIDEO_BATCH_STATUS.CANCELLED);
assert.equal(cancelledQueue[2].batchStatus, VIDEO_BATCH_STATUS.QUEUED);
const cancelledSummary = summarizeVideoBatchTasks(cancelledQueue);
assert.equal(cancelledSummary.cancelled, 2);
assert.equal(cancelledSummary.queued, 2);
assert.equal(cancelledSummary.active, 2);
assert.equal(clearSettledVideoBatchTasks(cancelledQueue).length, 2);

const retried = retryVideoBatchTask({
  ...tasks[0],
  status: TASK_STATUS.ERROR,
  batchStatus: VIDEO_BATCH_STATUS.ERROR,
  error: 'boom',
});
assert.equal(retried.status, TASK_STATUS.GENERATING);
assert.equal(retried.batchStatus, VIDEO_BATCH_STATUS.QUEUED);
assert.equal(retried.error, '');
assert.equal(retried.retryCount, 1);
assert.equal(retried.params.size, '720x1280');

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
};

const heavyReferenceTask = normalizeVideoBatchTask({
  ...tasks[0],
  params: {
    ...tasks[0].params,
    referenceImage: 'data:image/png;base64,large-primary',
    referenceImages: [
      'data:image/png;base64,large-a',
      'blob:http://localhost/session-only',
      'https://example.test/reference.png',
    ],
  },
  referenceImage: 'data:image/png;base64,large-top-level',
  referenceImages: ['data:image/png;base64,large-top-level-list'],
  referenceCount: 3,
});
saveVideoBatchTasks([heavyReferenceTask]);

const persistedRaw = storage.get('ai_creation_video_batch_tasks');
assert.ok(persistedRaw);
assert.equal(persistedRaw.includes('data:image'), false);
assert.equal(persistedRaw.includes('blob:http'), false);
assert.equal(persistedRaw.includes('https://example.test/reference.png'), true);

const [loadedHeavyTask] = loadVideoBatchTasks();
assert.equal(loadedHeavyTask.referenceCount, 3);
assert.deepEqual(loadedHeavyTask.params.referenceImages, [
  'https://example.test/reference.png',
]);

console.log('video batch queue regression checks passed');
