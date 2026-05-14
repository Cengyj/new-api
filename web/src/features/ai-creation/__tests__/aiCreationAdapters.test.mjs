import assert from 'node:assert/strict';

import {
  buildImageSubmitRequest,
  buildGrokImageEditFormData,
  buildGrokImageGenerationPayload,
  buildGptImageEditFormData,
  buildVideoFormData,
  buildImageGenerationPayload,
  IMAGE_PROVIDER_ADAPTERS,
  normalizeImageGenerationResponse,
  normalizeVideoTaskResponse,
  shouldUseGrokImageEdit,
} from '../adapters.js';
import {
  GROK_IMAGE_EDIT_MODEL,
  GROK_VIDEO_MODEL,
  IMAGE_MODEL_WHITELIST,
  TASK_STATUS,
  VIDEO_MODEL_WHITELIST,
  createImageGenerationParams,
  getImageSizeForModel,
  getImageAdapterKeyForModel,
  getImageParameterStateForModel,
  getRatioOptionsForModel,
  getMaxAttachmentsForModel,
  supportsImageQuality,
} from '../constants.js';
import {
  clampProgress,
  createImagePlaceholders,
  createVideoTask,
  getVideoDurationSeconds,
  getVideoPollTimeout,
  getTimestampId,
  markTasksAsError,
  replaceTasksById,
  resolveCreationTab,
} from '../utils.js';
import {
  createChatSession,
  deriveChatSessionTitle,
  syncChatSessions,
} from '../chatSessions.js';
import {
  createImageBatchQueueItems,
  normalizeImageBatchTask,
  summarizeImageBatchTasks,
} from '../imageBatchQueue.js';
import { createVideoBatchQueueItems } from '../videoBatchQueue.js';
import {
  createCreationResultGroupItems,
  createCreationResultGroupStats,
  normalizeCreationResultGroupStats,
} from '../creationResultGroupAdapters.js';
import {
  getAllowedCreationGroups,
  getAllowedCreationModels,
  mergePricingIntoModels,
} from '../creationModelAccess.js';

const main = async () => {
  assert.equal(resolveCreationTab('image'), 'image');
  assert.equal(resolveCreationTab('unknown'), 'chat');
  assert.equal(resolveCreationTab(undefined), 'chat');

  const mergedModels = mergePricingIntoModels(
    [{ value: 'gpt-image-2' }, { value: 'grok-imagine-video' }],
    [
      {
        model_name: 'gpt-image-2',
        quota_type: 1,
        model_price: 0.42,
      },
    ],
  );
  assert.equal(mergedModels[0].quota_type, 1);
  assert.equal(mergedModels[0].model_price, 0.42);
  assert.equal(mergedModels[1].quota_type, undefined);

  const capturedGroups = [{ value: 'default' }, { value: 'vip' }];
  const capturedModels = [
    { value: 'gpt-5.2' },
    { value: 'gpt-image-2' },
    { value: 'grok-imagine-video' },
  ];
  assert.deepEqual(
    [...getAllowedCreationGroups({
      groups: capturedGroups,
      models: capturedModels,
      groupModels: undefined,
      whitelist: IMAGE_MODEL_WHITELIST,
    })].sort(),
    ['default', 'vip'],
  );
  assert.equal(
    getAllowedCreationModels({
      models: capturedModels,
      groupModels: undefined,
      whitelist: IMAGE_MODEL_WHITELIST,
    }).has('gpt-image-2'),
    true,
  );
  assert.equal(
    getAllowedCreationModels({
      models: capturedModels,
      groupModels: undefined,
      whitelist: VIDEO_MODEL_WHITELIST,
    }).has('grok-imagine-video'),
    true,
  );

  const groupedModels = {
    default: ['gpt-5.2'],
    vip: ['gpt-image-2', 'grok-imagine-video'],
  };
  assert.deepEqual(
    [...getAllowedCreationGroups({
      groups: capturedGroups,
      models: capturedModels,
      groupModels: groupedModels,
      whitelist: IMAGE_MODEL_WHITELIST,
    })],
    ['vip'],
  );
  assert.equal(
    getAllowedCreationModels({
      models: capturedModels,
      groupModels: groupedModels,
      whitelist: IMAGE_MODEL_WHITELIST,
      selectedGroup: 'default',
    }).size,
    0,
  );
  assert.equal(
    getAllowedCreationModels({
      models: capturedModels,
      groupModels: groupedModels,
      whitelist: IMAGE_MODEL_WHITELIST,
      selectedGroup: 'vip',
    }).has('gpt-image-2'),
    true,
  );

  const orphanResultItems = createCreationResultGroupItems({
    completedItems: [{ id: 'result-1', url: 'https://example.com/a.png' }],
  });
  assert.equal(orphanResultItems.length, 1);
  assert.equal(orphanResultItems[0].status, 'success');
  assert.deepEqual(
    normalizeCreationResultGroupStats(
      createCreationResultGroupStats({
        completedItems: orphanResultItems,
      }),
      orphanResultItems,
    ),
    {
      completed: 1,
      failed: 0,
      processing: 0,
      cancelled: 0,
      total: 1,
    },
  );

  assert.equal(
    deriveChatSessionTitle(
      [{ role: 'user', content: '  Explain a ChatGPT-like layout polish  ' }],
      '新的对话',
    ),
    'Explain a ChatGPT-like l…',
  );
  assert.equal(deriveChatSessionTitle([], '新的对话'), '新的对话');

  const chatSession = createChatSession({
    id: 'session-1',
    messages: [{ role: 'user', content: 'hello session' }],
    title: 'hello session',
    inputs: { model: 'gpt-4o', group: 'default' },
  });
  assert.equal(chatSession.id, 'session-1');
  assert.equal(chatSession.title, 'hello session');
  assert.equal(chatSession.inputs.model, 'gpt-4o');
  assert.deepEqual(
    syncChatSessions([
      chatSession,
      null,
      { id: 'broken', messages: 'bad', inputs: 'bad' },
    ]).map((session) => [session.id, session.messages.length]),
    [
      ['session-1', 1],
      ['broken', 0],
    ],
  );

  const imagePayload = buildImageGenerationPayload({
    model: 'gpt-image-1',
    prompt: 'cat',
    negativePrompt: ' blurry ',
    ratio: '1:1',
    quality: '2K',
    count: '2',
    width: 1024,
    height: 1024,
    group: 'default',
    referenceImage: 'data:image/png;base64,ref',
    referenceImages: ['data:image/png;base64,ref'],
  });
  assert.deepEqual(imagePayload, {
    model: 'gpt-image-1',
    prompt: 'cat',
    n: 2,
    size: '1024x1024',
    quality: 'hd',
    response_format: 'url',
    group: 'default',
    image: 'data:image/png;base64,ref',
    extra_fields: {
      ratio: '1:1',
      resolution: '2K',
      negative_prompt: 'blurry',
      reference_images: ['data:image/png;base64,ref'],
    },
  });

  assert.equal(supportsImageQuality('gpt-image-2'), true);
  assert.equal(supportsImageQuality('grok-imagine-image'), false);
  assert.equal(getImageAdapterKeyForModel('gpt-image-2'), 'openai');
  assert.equal(getImageAdapterKeyForModel('grok-imagine-image-pro'), 'grok');
  assert.equal(IMAGE_PROVIDER_ADAPTERS.grok.provider, 'grok');
  assert.equal(
    getImageParameterStateForModel('grok-imagine-image').supportsQuality,
    false,
  );
  assert.equal(getRatioOptionsForModel('grok-imagine-image').length, 4);
  assert.equal(
    getImageSizeForModel('grok-imagine-image', { ratio: '1:1' }),
    '',
  );
  assert.equal(
    getImageSizeForModel('grok-imagine-image', { ratio: '16:9' }),
    '1280x720',
  );
  assert.equal(
    createImageGenerationParams({
      model: 'grok-imagine-image',
      size: '16:9',
      quality: '4K',
      referenceImages: Array.from({ length: 8 }, (_, i) => `ref-${i}`),
    }).referenceImages.length,
    5,
  );

  assert.equal(IMAGE_MODEL_WHITELIST.includes('grok-imagine-image-pro'), true);
  assert.equal(
    shouldUseGrokImageEdit({
      model: 'grok-imagine-image',
      referenceImages: ['data:image/png;base64,cmVm'],
    }),
    true,
  );
  assert.equal(
    shouldUseGrokImageEdit({
      model: 'grok-imagine-image-pro',
      referenceImages: ['data:image/png;base64,cmVm'],
    }),
    true,
  );
  assert.equal(
    shouldUseGrokImageEdit({
      model: 'gpt-image-2',
      referenceImages: ['data:image/png;base64,cmVm'],
    }),
    false,
  );
  assert.equal(
    shouldUseGrokImageEdit({
      model: 'grok-imagine-image',
      referenceImages: [],
    }),
    false,
  );

  const grokEditFormData = await buildGrokImageEditFormData({
    model: 'grok-imagine-image-pro',
    prompt: 'use reference',
    ratio: '1:1',
    quality: '1K',
    count: 1,
    width: 1024,
    height: 1024,
    group: 'default',
    referenceImages: ['data:image/png;base64,cmVm'],
  });
  assert.equal(grokEditFormData.get('model'), GROK_IMAGE_EDIT_MODEL);
  assert.equal(grokEditFormData.get('prompt'), 'use reference');
  assert.equal(grokEditFormData.get('n'), '1');
  assert.equal(grokEditFormData.getAll('image[]').length, 1);
  assert.equal(grokEditFormData.get('image'), null);
  assert.equal(grokEditFormData.get('quality'), null);

  const gptEditFormData = await buildGptImageEditFormData({
    model: 'gpt-image-2',
    prompt: 'use reference',
    ratio: '16:9',
    quality: '2K',
    count: 1,
    referenceImages: ['data:image/png;base64,cmVm'],
  });
  assert.equal(gptEditFormData.get('model'), 'gpt-image-2');
  assert.equal(gptEditFormData.get('size'), '1344x768');
  assert.equal(gptEditFormData.get('quality'), 'hd');
  assert.equal(gptEditFormData.getAll('image').length, 1);

  const grokSubmitRequest = await buildImageSubmitRequest({
    model: 'grok-imagine-image-pro',
    prompt: 'edit with reference',
    referenceImages: ['data:image/png;base64,cmVm'],
  });
  assert.equal(grokSubmitRequest.endpoint, '/pg/images/edits');
  assert.equal(grokSubmitRequest.provider, 'grok');
  assert.equal(grokSubmitRequest.mode, 'edit');
  assert.equal(grokSubmitRequest.body.get('model'), GROK_IMAGE_EDIT_MODEL);

  const gptSubmitRequest = await buildImageSubmitRequest({
    model: 'gpt-image-2',
    prompt: 'new image',
    ratio: '3:4',
    quality: '1K',
  });
  assert.equal(gptSubmitRequest.endpoint, '/pg/images/generations');
  assert.equal(gptSubmitRequest.provider, 'openai');
  assert.equal(gptSubmitRequest.mode, 'generation');
  assert.equal(gptSubmitRequest.body.size, '864x1152');

  const grokGenerationPayload = buildGrokImageGenerationPayload({
    model: 'grok-imagine-image-pro',
    prompt: 'wide grok',
    ratio: '16:9',
    quality: '4K',
    count: 1,
  });
  assert.equal(grokGenerationPayload.model, 'grok-imagine-image-pro');
  assert.equal(grokGenerationPayload.size, '1280x720');
  assert.equal(grokGenerationPayload.quality, undefined);
  assert.equal(grokGenerationPayload.extra_fields.resolution, undefined);

  const imageTasks = normalizeImageGenerationResponse(
    {
      data: {
        data: [
          { url: 'https://example.test/a.png', revised_prompt: 'cat revised' },
        ],
      },
    },
    {
      prompt: 'cat',
      ratio: '1:1',
      quality: '2K',
      referenceImages: ['data:image/png;base64,ref'],
    },
  );
  assert.equal(imageTasks[0].status, TASK_STATUS.SUCCESS);
  assert.equal(imageTasks[0].prompt, 'cat revised');
  assert.equal(imageTasks[0].url, 'https://example.test/a.png');
  assert.equal(imageTasks[0].referenceCount, 1);

  const placeholders = createImagePlaceholders({
    count: 2,
    prompt: 'p',
    ratio: '1:1',
    quality: '1K',
    referenceCount: 1,
  });
  assert.equal(placeholders.length, 2);
  assert.equal(placeholders[0].status, TASK_STATUS.LOADING);
  assert.equal(placeholders[0].referenceCount, 1);
  assert.equal(
    replaceTasksById(placeholders, placeholders, imageTasks)[0].url,
    imageTasks[0].url,
  );
  assert.equal(
    replaceTasksById(placeholders, placeholders, imageTasks)[1].status,
    TASK_STATUS.LOADING,
  );
  assert.equal(
    markTasksAsError(placeholders, [placeholders[1]])[1].status,
    TASK_STATUS.ERROR,
  );

  const batchTasks = createImageBatchQueueItems({
    count: 2,
    prompt: 'batch prompt',
    ratio: '16:9',
    quality: '1K',
    model: 'gpt-image-1',
    group: 'default',
    width: 1344,
    height: 768,
    referenceImages: ['data:image/png;base64,ref'],
  });
  assert.equal(batchTasks.length, 2);
  assert.equal(batchTasks[0].status, TASK_STATUS.LOADING);
  assert.equal(batchTasks[0].params.count, 1);
  assert.equal(batchTasks[0].params.width, 1344);
  assert.equal(batchTasks[0].referenceCount, 1);
  assert.equal(batchTasks[0].batchId, batchTasks[1].batchId);
  assert.deepEqual(
    summarizeImageBatchTasks([
      batchTasks[0],
      {
        ...batchTasks[1],
        status: TASK_STATUS.SUCCESS,
        batchStatus: 'success',
      },
      {
        ...batchTasks[1],
        id: 'failed',
        status: TASK_STATUS.ERROR,
        batchStatus: 'error',
      },
    ]),
    {
      total: 3,
      active: 1,
      running: 1,
      queued: 1,
      processing: 0,
      success: 1,
      error: 1,
      cancelled: 0,
    },
  );
  assert.equal(normalizeImageBatchTask(null), null);
  assert.equal(
    normalizeImageBatchTask({ id: 'x', prompt: 'p', status: 'bad' }).status,
    TASK_STATUS.LOADING,
  );

  const originalDateNow = Date.now;
  Date.now = () => 1234567890;
  try {
    assert.notEqual(
      getTimestampId('rapid'),
      getTimestampId('rapid'),
      'rapid image queue submissions must not collide when Date.now is unchanged',
    );
  } finally {
    Date.now = originalDateNow;
  }

  const grokVideo720FormData = await buildVideoFormData({
    model: GROK_VIDEO_MODEL,
    prompt: 'move',
    ratio: '16:9',
    duration: '10s',
    resolution: '720p',
    referenceImages: ['data:image/png;base64,abc'],
  });
  assert.equal(grokVideo720FormData.get('model'), GROK_VIDEO_MODEL);
  assert.equal(grokVideo720FormData.get('prompt'), 'move');
  assert.equal(grokVideo720FormData.get('seconds'), '10');
  assert.equal(grokVideo720FormData.get('size'), '1792x1024');
  assert.equal(grokVideo720FormData.get('resolution_name'), '720p');
  assert.equal(grokVideo720FormData.get('preset'), 'normal');
  assert.equal(grokVideo720FormData.getAll('input_reference[]').length, 1);
  assert.equal(grokVideo720FormData.get('duration'), null);
  assert.equal(grokVideo720FormData.get('image'), null);
  assert.equal(grokVideo720FormData.get('input_reference'), null);
  assert.equal(grokVideo720FormData.get('aspect_ratio'), null);
  assert.equal(grokVideo720FormData.get('video_length'), null);
  assert.equal(grokVideo720FormData.get('metadata'), null);

  const grokVideo480FormData = await buildVideoFormData({
    model: GROK_VIDEO_MODEL,
    prompt: 'move',
    ratio: '16:9',
    duration: '6s',
    resolution: '480p',
  });
  assert.equal(grokVideo480FormData.get('size'), '1280x720');

  const grokVideoSevenReferenceFormData = await buildVideoFormData({
    model: GROK_VIDEO_MODEL,
    prompt: 'move with references',
    ratio: '16:9',
    duration: '10s',
    resolution: '720p',
    referenceImages: Array.from(
      { length: 8 },
      () => 'data:image/png;base64,cmVm',
    ),
  });
  assert.equal(
    grokVideoSevenReferenceFormData.getAll('input_reference[]').length,
    7,
  );
  assert.equal(
    getMaxAttachmentsForModel(GROK_VIDEO_MODEL, 7),
    7,
    'grok video should allow the documented 7 reference images',
  );

  const batchVideoTask = createVideoBatchQueueItems({
    count: 1,
    prompt: 'batch move',
    ratio: '16:9',
    duration: '6s',
    resolution: '720p',
    model: GROK_VIDEO_MODEL,
    group: 'default',
    referenceImages: ['data:image/png;base64,cmVm'],
  })[0];
  const batchVideoFormData = await buildVideoFormData(batchVideoTask.params);
  assert.equal(batchVideoFormData.get('model'), GROK_VIDEO_MODEL);
  assert.equal(batchVideoFormData.get('prompt'), 'batch move');
  assert.equal(batchVideoFormData.get('seconds'), '6');
  assert.equal(batchVideoFormData.get('size'), '1792x1024');
  assert.equal(batchVideoFormData.get('resolution_name'), '720p');
  assert.equal(batchVideoFormData.getAll('input_reference[]').length, 1);
  assert.equal(batchVideoFormData.get('metadata'), null);

  const videoTask = createVideoTask({
    prompt: 'move',
    ratio: '16:9',
    duration: '5s',
    resolution: '720p',
  });
  assert.equal(videoTask.status, TASK_STATUS.GENERATING);
  assert.equal(clampProgress(90), 92);
  assert.equal(getVideoDurationSeconds({ duration: '20s' }), 20);
  assert.equal(getVideoDurationSeconds({ seconds: '6' }), 6);
  assert.equal(getVideoPollTimeout({ duration: '20s' }), 10 * 60 * 1000);
  assert.equal(getVideoPollTimeout({ seconds: '60' }), 30 * 60 * 1000);
  assert.equal(getVideoPollTimeout({}), 10 * 60 * 1000);

  const normalizedVideo = normalizeVideoTaskResponse(
    {
      data: {
        id: 'vid-1',
        status: 'completed',
        metadata: { url: 'https://example.test/v.mp4' },
      },
    },
    { prompt: 'move', ratio: '16:9', duration: '5s', resolution: '720p' },
  );
  assert.equal(normalizedVideo.status, TASK_STATUS.SUCCESS);
  assert.equal(normalizedVideo.progress, 100);
  assert.equal(normalizedVideo.url, 'https://example.test/v.mp4');

  const normalizedPlaygroundVideo = normalizeVideoTaskResponse(
    {
      data: {
        code: 'success',
        data: {
          task_id: 'task-public',
          status: 'SUCCESS',
          result_url: 'https://example.test/result.mp4',
          progress: '100%',
          data: {
            metadata: { url: 'https://example.test/result.mp4' },
          },
        },
      },
    },
    { prompt: 'move', ratio: '16:9', duration: '5s', resolution: '720p' },
  );
  assert.equal(normalizedPlaygroundVideo.id, 'task-public');
  assert.equal(normalizedPlaygroundVideo.status, TASK_STATUS.SUCCESS);
  assert.equal(
    normalizedPlaygroundVideo.url,
    'https://example.test/result.mp4',
  );

  const originalWindow = globalThis.window;
  globalThis.window = { location: { origin: 'http://127.0.0.1:3000' } };
  try {
    const normalizedLocalVideo = normalizeVideoTaskResponse(
      {
        data: {
          code: 'success',
          data: {
            task_id: 'task-local',
            status: 'SUCCESS',
            result_url: 'http://localhost:3000/v1/videos/task-local/content',
            progress: '100%',
          },
        },
      },
      { prompt: 'move', ratio: '16:9', duration: '5s', resolution: '720p' },
    );
    assert.equal(normalizedLocalVideo.url, '/v1/videos/task-local/content');
  } finally {
    globalThis.window = originalWindow;
  }

  console.log('ai-creation adapter regression checks passed');
};

main();
