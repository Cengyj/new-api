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

import {
  GROK_IMAGE_EDIT_MODEL as REGISTRY_GROK_IMAGE_EDIT_MODEL,
  GROK_IMAGE_MODEL,
  GROK_IMAGE_PRO_MODEL,
  GROK_IMAGE_RATIO_OPTIONS as REGISTRY_GROK_IMAGE_RATIO_OPTIONS,
  IMAGE_MODEL_SPECS,
  IMAGE_QUALITY_OPTIONS as REGISTRY_IMAGE_QUALITY_OPTIONS,
  IMAGE_RATIO_OPTIONS as REGISTRY_IMAGE_RATIO_OPTIONS,
  getImageCapabilitiesForModel as getRegistryImageCapabilitiesForModel,
  getImageModelDefaults as getRegistryImageModelDefaults,
  isGrokImageModel,
  listImageModelCodes,
  supportsImageQuality as registrySupportsImageQuality,
} from './imageModelRegistry.js';
import {
  GROK_VIDEO_MODEL as REGISTRY_GROK_VIDEO_MODEL,
  VIDEO_MODEL_SPECS,
  getVideoCapabilitiesForModel as getRegistryVideoCapabilitiesForModel,
  getVideoModelDefaults as getRegistryVideoModelDefaults,
  listVideoModelCodes,
  VIDEO_RATIO_OPTIONS as REGISTRY_VIDEO_RATIO_OPTIONS,
  VIDEO_RESOLUTION_OPTIONS as REGISTRY_VIDEO_RESOLUTION_OPTIONS,
} from './videoModelRegistry.js';

export const CREATION_TABS = ['chat', 'image', 'video'];

export const TASK_STATUS = {
  LOADING: 'loading',
  GENERATING: 'generating',
  SUCCESS: 'success',
  ERROR: 'error',
};

export const IMAGE_RATIO_OPTIONS = REGISTRY_IMAGE_RATIO_OPTIONS;
export const VIDEO_RATIO_OPTIONS = REGISTRY_VIDEO_RATIO_OPTIONS;
export const IMAGE_QUALITY_OPTIONS = REGISTRY_IMAGE_QUALITY_OPTIONS;
export const VIDEO_RESOLUTION_OPTIONS = REGISTRY_VIDEO_RESOLUTION_OPTIONS;

export const DEFAULT_IMAGE_CONFIG = getRegistryImageModelDefaults();

export const GROK_IMAGE_EDIT_MODEL = REGISTRY_GROK_IMAGE_EDIT_MODEL;
export const GROK_VIDEO_MODEL = REGISTRY_GROK_VIDEO_MODEL;
export const GROK_REFERENCE_IMAGE_MODELS = [
  GROK_IMAGE_MODEL,
  GROK_IMAGE_PRO_MODEL,
];

// 模型白名单配置
export const IMAGE_MODEL_WHITELIST = listImageModelCodes();

export const IMAGE_MODEL_CONFIGS = IMAGE_MODEL_SPECS;
export const VIDEO_MODEL_CONFIGS = VIDEO_MODEL_SPECS;

export const DEFAULT_VIDEO_CONFIG = getRegistryVideoModelDefaults(
  REGISTRY_GROK_VIDEO_MODEL,
);

// 模型白名单配置
export const VIDEO_MODEL_WHITELIST = listVideoModelCodes();

export const GROK_VIDEO_MAX_REFERENCE_IMAGES =
  getRegistryVideoCapabilitiesForModel(
    REGISTRY_GROK_VIDEO_MODEL,
  ).maxReferenceImages;

export { getImageModelSpec as getImageModelConfig } from './imageModelRegistry.js';
export { getDefaultImageModelCode } from './imageModelRegistry.js';
export { getImageCapabilitiesForModel } from './imageModelRegistry.js';
export { getImageModelDefaults } from './imageModelRegistry.js';
export { getImageRequestSpecForModel } from './imageModelRegistry.js';
export { getImageResponseSpecForModel } from './imageModelRegistry.js';
export { getImageAdapterKeyForModel } from './imageModelRegistry.js';
export { getImageParamSchemaForModel } from './imageModelRegistry.js';
export { getImageParameterStateForModel } from './imageModelRegistry.js';
export { getImageRatioOptionsForModel } from './imageModelRegistry.js';
export { getImageQualityOptionsForModel } from './imageModelRegistry.js';
export { getImageSizeForModel } from './imageModelRegistry.js';
export { getImageDimensionsForModel } from './imageModelRegistry.js';
export { isSupportedImageModel } from './imageModelRegistry.js';
export { createImageGenerationParams } from './imageModelRegistry.js';

export { getVideoModelSpec as getVideoModelConfig } from './videoModelRegistry.js';
export { getDefaultVideoModelCode } from './videoModelRegistry.js';
export { getVideoCapabilitiesForModel } from './videoModelRegistry.js';
export { getVideoModelDefaults } from './videoModelRegistry.js';
export { getVideoRequestSpecForModel } from './videoModelRegistry.js';
export { getVideoResponseSpecForModel } from './videoModelRegistry.js';
export { getVideoAdapterKeyForModel } from './videoModelRegistry.js';
export { getVideoParamSchemaForModel } from './videoModelRegistry.js';
export { getVideoParameterStateForModel } from './videoModelRegistry.js';
export { getVideoPollingSpecForModel } from './videoModelRegistry.js';
export { getVideoPollingTimeoutForModel } from './videoModelRegistry.js';
export { getVideoRatioOptionsForModel } from './videoModelRegistry.js';
export { getVideoDurationOptionsForModel } from './videoModelRegistry.js';
export { getVideoResolutionOptionsForModel } from './videoModelRegistry.js';
export { getVideoResolutionNameForModel } from './videoModelRegistry.js';
export { getVideoSizeForModel } from './videoModelRegistry.js';
export { getVideoReferenceFieldNameForModel } from './videoModelRegistry.js';
export { isSupportedVideoModel } from './videoModelRegistry.js';

// 根据 ID 获取 UI 显示名称
export const MODEL_DISPLAY_NAMES = {
  'gpt-image-2': 'GPT Image 2',
  'gpt-image-1': 'GPT Image 1',
  'grok-imagine-image': 'Grok Imagine Image',
  'grok-imagine-image-pro': 'Grok Imagine Image Pro',
  'grok-imagine-image-edit': 'Grok Imagine Image Edit',
  'grok-imagine-video': 'Grok Imagine Video',
};

export const getModelDisplayName = (modelCode) =>
  MODEL_DISPLAY_NAMES[modelCode] || modelCode;

export const GROK_IMAGE_RATIO_OPTIONS = REGISTRY_GROK_IMAGE_RATIO_OPTIONS;

export const isGrokModel = (modelCode) => isGrokImageModel(modelCode);

// 根据模型获取比例选项
export const getRatioOptionsForModel = (modelCode) => {
  const options = getRegistryImageCapabilitiesForModel(modelCode).ratioOptions;
  return options?.length ? options : IMAGE_RATIO_OPTIONS;
};

// 是否支持图片质量选项（1K/2K/4K）
export const supportsImageQuality = (modelCode) =>
  registrySupportsImageQuality(modelCode);

// 获取模型最大附件数量
export const getMaxAttachmentsForModel = (modelCode, fallback) => {
  if (modelCode === GROK_VIDEO_MODEL) {
    return Math.min(
      GROK_VIDEO_MAX_REFERENCE_IMAGES,
      fallback ?? GROK_VIDEO_MAX_REFERENCE_IMAGES,
    );
  }
  const maxReferenceImages =
    getRegistryImageCapabilitiesForModel(modelCode).maxReferenceImages;
  if (maxReferenceImages) {
    return Math.min(maxReferenceImages, fallback ?? maxReferenceImages);
  }
  return fallback;
};

export const VIDEO_MOTION_IDEAS = [
  {
    title: '产品短片',
    prompt:
      '产品在白色摄影棚中缓慢旋转，镜头轻微推进，柔和高光扫过表面，干净高级，商业广告质感。',
  },
  {
    title: '首帧动效',
    prompt:
      '保持参考图主体一致，让背景光影轻微流动，镜头缓慢平移，整体稳定自然，不改变人物身份。',
  },
  {
    title: '电影运镜',
    prompt:
      '雨夜街道中人物向前走，低角度跟拍，霓虹反射、浅景深、轻微手持感，电影级色彩。',
  },
  {
    title: '社媒竖屏',
    prompt:
      '9:16 竖屏短视频，主体居中，前 2 秒吸引注意，镜头从近景拉到中景，节奏清晰。',
  },
];
