import assert from 'node:assert/strict';

import { TASK_STATUS } from '../constants.js';
import {
  IMAGE_BATCH_STATUS,
  IMAGE_TASK_SOURCE,
  cancelImageBatchTasks,
  clearSettledImageBatchTasks,
  createImageBatchTasks,
  isImageBatchGeneratedTask,
  normalizeImageBatchTask,
  parseImageBatchPrompts,
  loadImageBatchTasks,
  mergeImageBatchTasks,
  removeImageBatchTask,
  retryImageBatchTask,
  runImageBatchQueue,
  saveImageBatchTasks,
  summarizeImageBatchTasks,
  upsertImageBatchTasks,
} from '../imageBatchQueue.js';

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
};

const run = async () => {
  const tasks = createImageBatchTasks({
    count: 2,
    prompt: 'batch cat',
    ratio: '1:1',
    quality: '1K',
    model: 'gpt-image',
    group: 'default',
    width: 1024,
    height: 1024,
    referenceImages: ['data:image/png;base64,ref'],
  });

  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0].id, tasks[1].id);
  assert.equal(tasks[0].status, TASK_STATUS.LOADING);
  assert.equal(tasks[0].batchStatus, IMAGE_BATCH_STATUS.QUEUED);
  assert.equal(tasks[0].params.count, 1);
  assert.equal(tasks[0].params.referenceImage, 'data:image/png;base64,ref');
  assert.deepEqual(tasks[0].params.referenceImages, [
    'data:image/png;base64,ref',
  ]);
  assert.equal(tasks[0].source, IMAGE_TASK_SOURCE.SINGLE);
  assert.equal(isImageBatchGeneratedTask(tasks[0]), false);

  const uiBatchTasks = createImageBatchTasks({
    count: 1,
    prompt: 'batch row cat',
    ratio: '1:1',
    quality: '1K',
    model: 'gpt-image',
    group: 'default',
    width: 1024,
    height: 1024,
    source: IMAGE_TASK_SOURCE.BATCH,
    batchRowId: 'row-1',
    batchRowIndex: 0,
  });
  assert.equal(uiBatchTasks[0].source, IMAGE_TASK_SOURCE.BATCH);
  assert.equal(uiBatchTasks[0].batchRowId, 'row-1');
  assert.equal(uiBatchTasks[0].params.batchRowId, 'row-1');
  assert.equal(isImageBatchGeneratedTask(uiBatchTasks[0]), true);
  assert.equal(
    isImageBatchGeneratedTask(tasks[0], new Set([tasks[0].id])),
    true,
  );

  assert.deepEqual(
    parseImageBatchPrompts('  cat with a hat  \n\ncity, with comma\n  dog  '),
    ['cat with a hat', 'city, with comma', 'dog'],
  );
  assert.deepEqual(
    parseImageBatchPrompts(
      'prompt,notes\n"red fox, cinematic",keep comma\nblue whale,second row',
      { fileName: 'prompts.csv' },
    ),
    ['red fox, cinematic', 'blue whale'],
  );
  assert.deepEqual(
    parseImageBatchPrompts('\uFEFFfirst prompt\r\n\r\nsecond prompt'),
    ['first prompt', 'second prompt'],
  );

  const multiPromptTasks = createImageBatchTasks({
    count: 2,
    prompts: [' first prompt ', '', 'second prompt'],
    ratio: '4:3',
    quality: '2K',
    model: 'gpt-image',
    group: 'default',
    width: 1024,
    height: 768,
    referenceImages: ['data:image/png;base64,multi-ref'],
  });
  assert.equal(multiPromptTasks.length, 4);
  assert.deepEqual(
    multiPromptTasks.map((task) => task.prompt),
    ['first prompt', 'first prompt', 'second prompt', 'second prompt'],
  );
  assert.equal(new Set(multiPromptTasks.map((task) => task.id)).size, 4);
  assert.equal(multiPromptTasks[0].batchId, multiPromptTasks[3].batchId);
  assert.equal(multiPromptTasks[2].params.prompt, 'second prompt');
  assert.equal(multiPromptTasks[2].params.promptIndex, 1);
  assert.equal(multiPromptTasks[2].params.copyIndex, 0);
  assert.equal(multiPromptTasks[2].params.index, 2);
  assert.equal(multiPromptTasks[2].params.width, 1024);
  assert.equal(multiPromptTasks[2].params.height, 768);
  assert.equal(multiPromptTasks[2].referenceCount, 1);
  assert.deepEqual(multiPromptTasks[2].params.referenceImages, [
    'data:image/png;base64,multi-ref',
  ]);

  const modelAwareTasks = createImageBatchTasks({
    count: 1,
    prompt: 'wide grok',
    size: '16:9',
    quality: '4K',
    model: 'grok-imagine-image',
    referenceImages: Array.from({ length: 8 }, (_, idx) => `ref-${idx}`),
  });
  assert.equal(modelAwareTasks[0].ratio, '16:9');
  assert.equal(modelAwareTasks[0].width, 1280);
  assert.equal(modelAwareTasks[0].height, 720);
  assert.equal(modelAwareTasks[0].params.size, '1280x720');
  assert.equal(modelAwareTasks[0].referenceCount, 5);
  assert.equal(modelAwareTasks[0].params.referenceImages.length, 5);

  saveImageBatchTasks(tasks);
  assert.equal(loadImageBatchTasks().length, 2);

  const recoveredUrlTask = normalizeImageBatchTask({
    ...tasks[0],
    status: TASK_STATUS.SUCCESS,
    batchStatus: IMAGE_BATCH_STATUS.SUCCESS,
    url: 'blob:http://localhost/session-only',
    remoteUrl: 'https://example.test/canonical.png',
  });
  assert.equal(recoveredUrlTask.url, 'https://example.test/canonical.png');
  assert.equal(recoveredUrlTask.remoteUrl, 'https://example.test/canonical.png');
  saveImageBatchTasks([recoveredUrlTask]);
  assert.equal(loadImageBatchTasks()[0].url, 'https://example.test/canonical.png');

  const staleBlobTask = normalizeImageBatchTask({
    ...tasks[0],
    status: TASK_STATUS.SUCCESS,
    batchStatus: IMAGE_BATCH_STATUS.SUCCESS,
    url: 'blob:http://localhost/missing-canonical',
  });
  assert.equal(staleBlobTask.url, '');

  let queueState = [...tasks];
  const updates = [];
  const completed = await runImageBatchQueue({
    tasks,
    generate: async (params) => [
      {
        id: 'upstream-id',
        url: `https://example.test/${params.prompt}.png`,
        prompt: params.prompt,
      },
    ],
    onUpdate: (nextTask) => {
      updates.push(nextTask);
      queueState = upsertImageBatchTasks(queueState, nextTask);
    },
  });

  assert.equal(completed.length, 2);
  assert.equal(updates.length, 4);
  assert.equal(queueState[0].status, TASK_STATUS.SUCCESS);
  assert.equal(queueState[0].batchStatus, IMAGE_BATCH_STATUS.SUCCESS);
  assert.equal(queueState[0].id, tasks[0].id);
  assert.equal(queueState[0].model, 'gpt-image');
  assert.equal(queueState[0].url, 'https://example.test/batch cat.png');

  const summary = summarizeImageBatchTasks(queueState);
  assert.equal(summary.total, 2);
  assert.equal(summary.success, 2);
  assert.equal(summary.active, 0);

  const cancelledQueue = cancelImageBatchTasks(tasks, [tasks[0].id]);
  assert.equal(cancelledQueue[0].batchStatus, IMAGE_BATCH_STATUS.CANCELLED);
  assert.equal(cancelledQueue[1].batchStatus, IMAGE_BATCH_STATUS.QUEUED);
  const cancelledSummary = summarizeImageBatchTasks(cancelledQueue);
  assert.equal(cancelledSummary.cancelled, 1);
  assert.equal(cancelledSummary.queued, 1);
  assert.equal(cancelledSummary.active, 1);
  assert.equal(clearSettledImageBatchTasks(cancelledQueue).length, 1);

  const failed = {
    ...queueState[0],
    status: TASK_STATUS.ERROR,
    batchStatus: IMAGE_BATCH_STATUS.ERROR,
    error: 'boom',
  };
  const retried = retryImageBatchTask(failed);
  assert.equal(retried.status, TASK_STATUS.LOADING);
  assert.equal(retried.batchStatus, IMAGE_BATCH_STATUS.QUEUED);
  assert.equal(retried.retryCount, failed.retryCount + 1);
  assert.equal(retried.error, '');

  const merged = mergeImageBatchTasks(queueState, [retried]);
  assert.equal(merged[0].id, retried.id);
  assert.equal(merged.length, 2);
  assert.equal(removeImageBatchTask(merged, retried.id).length, 1);
  assert.equal(clearSettledImageBatchTasks(queueState).length, 0);

  console.log('image batch queue regression checks passed');
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
