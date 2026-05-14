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

import { TASK_STATUS } from './constants.js';
import {
  IMAGE_ADAPTERS,
  IMAGE_REQUEST_MODES,
  GROK_IMAGE_EDIT_MODEL,
  createImageGenerationParams,
  getImageAdapterKeyForModel,
  getImageModelSpec,
  getImageRequestSpecForModel,
  getImageResponseSpecForModel,
  mapImageQualityForModel,
  normalizeImageReferenceImages,
  supportsImageQuality,
} from './imageModelRegistry.js';
import { getImageFilename, referenceImageToBlob } from './mediaFiles.js';

export {
  DEFAULT_VIDEO_ENDPOINT,
  VIDEO_PROVIDER_ADAPTERS,
  buildGrokVideoFormData,
  buildVideoFormData,
  buildVideoSubmitRequest,
  getVideoProviderAdapter,
  normalizeVideoContentUrl,
  normalizeVideoTaskResponse,
} from './videoAdapters.js';

export const unwrapResponseData = (response) => {
  const body = response?.data ?? response;
  if (
    body?.success === true &&
    Object.prototype.hasOwnProperty.call(body, 'data')
  ) {
    return body.data;
  }
  return body;
};

const compactObject = (object) =>
  Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) =>
        value !== undefined && value !== '' && value !== null,
    ),
  );

const getReferenceImages = (params = {}) => normalizeImageReferenceImages(params);

const hasReferenceImages = (params = {}) => getReferenceImages(params).length > 0;

const supportsImageEdit = (model) => {
  const spec = getImageModelSpec(model);
  const request = getImageRequestSpecForModel(model, IMAGE_REQUEST_MODES.EDIT);
  return Boolean(
    spec.capabilities?.supportsEdit &&
      request?.endpoint &&
      request.transport === 'multipart',
  );
};

export const isGrokReferenceImageModel = (model) =>
  getImageModelSpec(model).provider === 'grok' &&
  supportsImageEdit(model);

export const shouldUseGrokImageEdit = (params = {}) =>
  isGrokReferenceImageModel(params.model) && hasReferenceImages(params);

export const isGptReferenceImageModel = (model) =>
  getImageModelSpec(model).provider === 'openai' &&
  supportsImageEdit(model);

export const shouldUseGptImageEdit = (params = {}) =>
  isGptReferenceImageModel(params.model) && hasReferenceImages(params);

export const shouldUseImageEdit = (params = {}) =>
  supportsImageEdit(params.model) && hasReferenceImages(params);

const appendReferenceImages = async (formData, params, fieldName) => {
  const referenceImages = getReferenceImages(params);
  for (const [index, image] of referenceImages.entries()) {
    const blob = await referenceImageToBlob(image);
    formData.append(fieldName, blob, getImageFilename(image, index, blob.type));
  }
};

const buildImageEditFormDataForSpec = async (params = {}) => {
  const normalized = createImageGenerationParams(params);
  const spec = getImageModelSpec(normalized.model);
  const request = getImageRequestSpecForModel(normalized.model, 'edit');
  const formData = new FormData();
  const model = request.editModel || normalized.model;

  formData.append('model', model);
  formData.append('prompt', normalized.prompt || '');
  formData.append('n', String(normalized.count || 1));

  if (normalized.size) {
    formData.append('size', normalized.size);
  }

  const mappedQuality = mapImageQualityForModel(normalized.model, normalized.quality);
  if (mappedQuality && mappedQuality !== 'auto') {
    formData.append('quality', mappedQuality);
  }

  if (request.includeResponseFormat) {
    formData.append('response_format', request.responseFormat || 'url');
  }

  if (normalized.group) {
    formData.append('group', normalized.group);
  }

  await appendReferenceImages(
    formData,
    normalized,
    request.referenceFieldName || spec.request?.edit?.referenceFieldName || 'image',
  );

  return formData;
};

export const buildGrokImageEditFormData = async (params = {}) =>
  buildImageEditFormDataForSpec({ ...params, model: params.model || GROK_IMAGE_EDIT_MODEL });

export const buildGptImageEditFormData = async (params = {}) =>
  buildImageEditFormDataForSpec(params);

export const buildImageGenerationPayload = (params = {}) => {
  const normalized = createImageGenerationParams(params);
  const request = getImageRequestSpecForModel(normalized.model, 'generation');
  const mappedQuality = mapImageQualityForModel(
    normalized.model,
    normalized.quality,
  );
  const canUseQuality = supportsImageQuality(normalized.model);

  const extraFields = compactObject({
    ratio: normalized.ratio,
    resolution: canUseQuality ? normalized.quality : undefined,
    negative_prompt: normalized.negativePrompt?.trim(),
    reference_images: normalized.referenceImages.length
      ? normalized.referenceImages
      : undefined,
  });

  return compactObject({
    model: normalized.model,
    prompt: normalized.prompt,
    n: normalized.count,
    size: normalized.size,
    quality: canUseQuality ? mappedQuality : undefined,
    response_format: request.responseFormat || 'url',
    group: normalized.group,
    image: normalized.referenceImage,
    extra_fields: extraFields,
  });
};

export const buildOpenAiImageGenerationPayload = (params = {}) =>
  buildImageGenerationPayload(params);

export const buildGrokImageGenerationPayload = (params = {}) =>
  buildImageGenerationPayload(params);

export const IMAGE_PROVIDER_ADAPTERS = Object.freeze({
  [IMAGE_ADAPTERS.OPENAI]: Object.freeze({
    adapter: IMAGE_ADAPTERS.OPENAI,
    provider: 'openai',
    shouldUseEdit: shouldUseGptImageEdit,
    buildEditBody: buildGptImageEditFormData,
    buildGenerationBody: buildOpenAiImageGenerationPayload,
    editFallback: 'GPT image edit failed',
    generationFallback: 'image generation failed',
  }),
  [IMAGE_ADAPTERS.GROK]: Object.freeze({
    adapter: IMAGE_ADAPTERS.GROK,
    provider: 'grok',
    shouldUseEdit: shouldUseGrokImageEdit,
    buildEditBody: buildGrokImageEditFormData,
    buildGenerationBody: buildGrokImageGenerationPayload,
    editFallback: 'Grok image edit failed',
    generationFallback: 'Grok image generation failed',
  }),
});

export const getImageProviderAdapter = (modelCode) => {
  const adapterKey = getImageAdapterKeyForModel(modelCode);
  return (
    IMAGE_PROVIDER_ADAPTERS[adapterKey] ||
    IMAGE_PROVIDER_ADAPTERS[IMAGE_ADAPTERS.OPENAI]
  );
};

export const buildImageSubmitRequest = async (params = {}) => {
  const normalized = createImageGenerationParams(params);
  const adapter = getImageProviderAdapter(normalized.model);
  const isEdit = adapter.shouldUseEdit(normalized);
  const mode = isEdit ? 'edit' : 'generation';
  const request = getImageRequestSpecForModel(normalized.model, mode);
  const body = isEdit
    ? await adapter.buildEditBody(normalized)
    : adapter.buildGenerationBody(normalized);

  return {
    endpoint: request.endpoint,
    body,
    fallback: isEdit ? adapter.editFallback : adapter.generationFallback,
    mode,
    provider: adapter.provider,
    params: normalized,
  };
};

export const normalizeImageGenerationResponse = (responseData, params = {}) => {
  const normalizedParams = createImageGenerationParams(params);
  const responseSpec = getImageResponseSpecForModel(normalizedParams.model);
  const body = unwrapResponseData(responseData);
  const responseDataField = responseSpec.dataField || 'data';
  const data = Array.isArray(body?.[responseDataField])
    ? body[responseDataField]
    : Array.isArray(body)
      ? body
      : [];

  if (data.length === 0) {
    throw new Error('empty image generation response');
  }

  return data.map((item, index) => {
    const url =
      item[responseSpec.urlField || 'url'] ||
      (item[responseSpec.base64Field || 'b64_json']
        ? `data:image/png;base64,${item[responseSpec.base64Field || 'b64_json']}`
        : '');
    if (!url) {
      throw new Error('image generation response missing url');
    }

    return {
      id: item.id || `img-${Date.now()}-${index}`,
      url,
      status: TASK_STATUS.SUCCESS,
      prompt:
        item[responseSpec.revisedPromptField || 'revised_prompt'] ||
        normalizedParams.prompt,
      ratio: normalizedParams.ratio,
      width: normalizedParams.width,
      height: normalizedParams.height,
      quality: normalizedParams.quality,
      referenceCount: normalizedParams.referenceImages.length,
    };
  });
};
