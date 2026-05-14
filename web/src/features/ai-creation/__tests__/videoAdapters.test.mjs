import assert from 'node:assert/strict';

import {
  DEFAULT_VIDEO_ENDPOINT,
  GROK_VIDEO_ADAPTER,
  VIDEO_PROVIDER_ADAPTERS,
  buildVideoSubmitRequest,
  buildVideoFormData,
  getVideoProviderAdapter,
  getVideoReferences,
  getVideoSeconds,
  normalizeVideoContentUrl,
  normalizeVideoTaskResponse,
} from '../videoAdapters.js';
import { GROK_VIDEO_MODEL, TASK_STATUS } from '../constants.js';

const main = async () => {
  assert.equal(getVideoSeconds('10s'), 10);
  assert.equal(getVideoSeconds('6'), 6);
  assert.equal(getVideoSeconds('bad'), undefined);

  assert.deepEqual(
    getVideoReferences({
      referenceImage: 'data:image/png;base64,one',
      referenceImages: ['data:image/png;base64,two'],
    }),
    ['data:image/png;base64,two'],
  );
  assert.deepEqual(
    getVideoReferences({ 'input_reference[]': ['legacy-a', '', 'legacy-b'] }),
    ['legacy-a', 'legacy-b'],
  );

  assert.equal(VIDEO_PROVIDER_ADAPTERS.grok.provider, 'grok');
  assert.equal(GROK_VIDEO_ADAPTER.adapter, 'grok');
  assert.equal(getVideoProviderAdapter(GROK_VIDEO_MODEL).provider, 'grok');
  assert.equal(getVideoProviderAdapter('unknown-video-model').provider, 'grok');

  const submitRequest = await buildVideoSubmitRequest({
    model: GROK_VIDEO_MODEL,
    prompt: 'move',
    ratio: '16:9',
    duration: '10s',
    resolution: '720p',
    referenceImages: ['data:image/png;base64,cmVm'],
  });
  assert.equal(submitRequest.endpoint, DEFAULT_VIDEO_ENDPOINT);
  assert.equal(submitRequest.pollEndpoint, DEFAULT_VIDEO_ENDPOINT);
  assert.equal(submitRequest.adapter, 'grok');
  assert.equal(submitRequest.provider, 'grok');
  assert.equal(submitRequest.params.size, '1792x1024');
  assert.equal(submitRequest.params.seconds, 10);
  assert.equal(submitRequest.polling.intervalMs, 2000);
  assert.equal(submitRequest.polling.timeoutMs, 10 * 60 * 1000);
  assert.equal(typeof submitRequest.normalizeTaskResponse, 'function');
  assert.equal(submitRequest.body.get('model'), GROK_VIDEO_MODEL);
  assert.equal(submitRequest.body.get('size'), '1792x1024');
  assert.equal(submitRequest.body.getAll('input_reference[]').length, 1);

  const formData = await buildVideoFormData({
    model: GROK_VIDEO_MODEL,
    prompt: 'move',
    ratio: '16:9',
    duration: '10s',
    resolution: '720p',
    referenceImages: ['data:image/png;base64,cmVm'],
  });
  assert.equal(formData.get('model'), GROK_VIDEO_MODEL);
  assert.equal(formData.get('prompt'), 'move');
  assert.equal(formData.get('seconds'), '10');
  assert.equal(formData.get('size'), '1792x1024');
  assert.equal(formData.get('resolution_name'), '720p');
  assert.equal(formData.get('preset'), 'normal');
  assert.equal(formData.getAll('input_reference[]').length, 1);

  const normalized = normalizeVideoTaskResponse(
    {
      data: {
        id: 'vid-1',
        status: 'completed',
        metadata: { url: 'https://example.test/v.mp4' },
      },
    },
    { prompt: 'move', ratio: '16:9', duration: '10s', resolution: '720p' },
  );
  assert.equal(normalized.status, TASK_STATUS.SUCCESS);
  assert.equal(normalized.progress, 100);
  assert.equal(normalized.url, 'https://example.test/v.mp4');

  const completedWithoutUrl = normalizeVideoTaskResponse(
    {
      data: {
        id: 'vid-2',
        status: 'succeeded',
      },
    },
    { prompt: 'move', model: GROK_VIDEO_MODEL },
  );
  assert.equal(completedWithoutUrl.status, TASK_STATUS.SUCCESS);
  assert.equal(completedWithoutUrl.url, '/v1/videos/vid-2/content');

  const failed = normalizeVideoTaskResponse(
    {
      data: {
        task_id: 'vid-failed',
        status: 'failed',
        data: { error: { message: 'upstream exploded' } },
      },
    },
    { prompt: 'move', model: GROK_VIDEO_MODEL },
  );
  assert.equal(failed.status, TASK_STATUS.ERROR);
  assert.equal(failed.error, 'upstream exploded');

  const fallbackId = normalizeVideoTaskResponse(
    { data: { status: 'queued' } },
    { prompt: 'move', model: GROK_VIDEO_MODEL },
  ).id;
  assert.equal(fallbackId.startsWith('vid-'), true);
  assert.notEqual(fallbackId, 'vid-NaN');

  globalThis.window = {
    location: { origin: 'http://localhost:3000' },
  };
  assert.equal(
    normalizeVideoContentUrl('http://127.0.0.1:3000/v1/videos/abc/content'),
    '/v1/videos/abc/content',
  );

  console.log('video adapter regression checks passed');
};

main();
