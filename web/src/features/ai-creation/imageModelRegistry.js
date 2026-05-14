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

export const GPT_IMAGE_MODEL = 'gpt-image-2';
export const GPT_IMAGE_LEGACY_MODEL = 'gpt-image-1';
export const GROK_IMAGE_MODEL = 'grok-imagine-image';
export const GROK_IMAGE_PRO_MODEL = 'grok-imagine-image-pro';
export const GROK_IMAGE_EDIT_MODEL = 'grok-imagine-image-edit';

export const IMAGE_PROVIDERS = Object.freeze({
  OPENAI: 'openai',
  GROK: 'grok',
});

export const IMAGE_ADAPTERS = Object.freeze({
  OPENAI: 'openai',
  GROK: 'grok',
});

export const IMAGE_REQUEST_MODES = Object.freeze({
  GENERATION: 'generation',
  EDIT: 'edit',
});

export const IMAGE_RATIO_OPTIONS = Object.freeze([
  Object.freeze({ label: '1:1', value: '1:1', width: 1024, height: 1024 }),
  Object.freeze({ label: '3:2', value: '3:2', width: 1216, height: 832 }),
  Object.freeze({ label: '2:3', value: '2:3', width: 832, height: 1216 }),
  Object.freeze({ label: '4:3', value: '4:3', width: 1152, height: 864 }),
  Object.freeze({ label: '3:4', value: '3:4', width: 864, height: 1152 }),
  Object.freeze({ label: '5:4', value: '5:4', width: 1152, height: 896 }),
  Object.freeze({ label: '4:5', value: '4:5', width: 896, height: 1152 }),
  Object.freeze({ label: '16:9', value: '16:9', width: 1344, height: 768 }),
  Object.freeze({ label: '9:16', value: '9:16', width: 768, height: 1344 }),
  Object.freeze({ label: '21:9', value: '21:9', width: 1536, height: 640 }),
]);

export const GROK_IMAGE_RATIO_OPTIONS = Object.freeze([
  // Keep 1:1 size empty: Grok's default square is 960x960 and the gateway
  // should not receive an incompatible OpenAI size for this ratio.
  Object.freeze({ label: '1:1', value: '1:1' }),
  Object.freeze({ label: '16:9', value: '16:9', width: 1280, height: 720 }),
  Object.freeze({ label: '9:16', value: '9:16', width: 720, height: 1280 }),
  Object.freeze({ label: '2:3', value: '2:3', width: 784, height: 1168 }),
]);

export const IMAGE_QUALITY_OPTIONS = Object.freeze([
  Object.freeze({ label: '1K', value: '1K' }),
  Object.freeze({ label: '2K', value: '2K' }),
  Object.freeze({ label: '4K', value: '4K' }),
]);

const IMAGE_QUALITY_MAP = Object.freeze({
  '1K': 'standard',
  '2K': 'hd',
  '4K': 'hd',
});

const DEFAULT_IMAGE_DEFAULTS = Object.freeze({
  ratio: '1:1',
  quality: '1K',
  count: '1',
});

const DEFAULT_IMAGE_PARAM_SCHEMA = Object.freeze({
  prompt: Object.freeze({ required: true }),
  ratio: Object.freeze({ source: 'ratioOptions' }),
  size: Object.freeze({ derivedFrom: 'ratio' }),
  width: Object.freeze({ derivedFrom: 'ratio' }),
  height: Object.freeze({ derivedFrom: 'ratio' }),
  quality: Object.freeze({ source: 'qualityOptions', optional: true }),
  count: Object.freeze({ min: 1 }),
  referenceImages: Object.freeze({ source: 'capabilities.maxReferenceImages' }),
});

const buildSizeMap = (ratioOptions) =>
  Object.freeze(
    ratioOptions.reduce((acc, option) => {
      if (option.width && option.height) {
        acc[option.value] = `${option.width}x${option.height}`;
      }
      return acc;
    }, {}),
  );

const GPT_SIZE_MAP = buildSizeMap(IMAGE_RATIO_OPTIONS);
const GROK_SIZE_MAP = buildSizeMap(GROK_IMAGE_RATIO_OPTIONS);

const jsonGenerationRequest = Object.freeze({
  endpoint: '/pg/images/generations',
  transport: 'json',
  responseFormat: 'url',
});

const openAiEditRequest = Object.freeze({
  endpoint: '/pg/images/edits',
  transport: 'multipart',
  referenceFieldName: 'image',
  repeatReferenceField: true,
  includeResponseFormat: false,
});

const grokEditRequest = Object.freeze({
  endpoint: '/pg/images/edits',
  transport: 'multipart',
  editModel: GROK_IMAGE_EDIT_MODEL,
  referenceFieldName: 'image[]',
  repeatReferenceField: true,
  includeResponseFormat: true,
  responseFormat: 'url',
});

const imageResponseSpec = Object.freeze({
  dataField: 'data',
  urlField: 'url',
  base64Field: 'b64_json',
  revisedPromptField: 'revised_prompt',
});

const defineImageModelSpec = ({
  modelCode,
  provider,
  adapter = provider,
  label,
  defaults = DEFAULT_IMAGE_DEFAULTS,
  capabilities,
  request,
  response = imageResponseSpec,
  paramSchema = DEFAULT_IMAGE_PARAM_SCHEMA,
  qualityMap = Object.freeze({}),
  sizeMap = Object.freeze({}),
}) =>
  Object.freeze({
    modelCode,
    provider,
    adapter,
    label,
    defaults,
    capabilities: Object.freeze(capabilities),
    request: Object.freeze(request),
    response,
    paramSchema,
    qualityMap,
    sizeMap,
  });

const openAiImageCapabilities = Object.freeze({
  ratioOptions: IMAGE_RATIO_OPTIONS,
  qualityOptions: IMAGE_QUALITY_OPTIONS,
  supportsQuality: true,
  supportsReferenceImages: true,
  maxReferenceImages: 5,
  supportsEdit: true,
});

const grokImageCapabilities = Object.freeze({
  ratioOptions: GROK_IMAGE_RATIO_OPTIONS,
  qualityOptions: Object.freeze([]),
  supportsQuality: false,
  supportsReferenceImages: true,
  maxReferenceImages: 5,
  supportsEdit: true,
});

const openAiImageRequest = Object.freeze({
  generation: jsonGenerationRequest,
  edit: openAiEditRequest,
});

const grokImageRequest = Object.freeze({
  generation: jsonGenerationRequest,
  edit: grokEditRequest,
});

export const IMAGE_MODEL_SPECS = Object.freeze({
  [GPT_IMAGE_MODEL]: defineImageModelSpec({
    modelCode: GPT_IMAGE_MODEL,
    provider: IMAGE_PROVIDERS.OPENAI,
    adapter: IMAGE_ADAPTERS.OPENAI,
    label: 'GPT Image 2',
    defaults: DEFAULT_IMAGE_DEFAULTS,
    capabilities: openAiImageCapabilities,
    request: openAiImageRequest,
    qualityMap: IMAGE_QUALITY_MAP,
    sizeMap: GPT_SIZE_MAP,
  }),
  [GPT_IMAGE_LEGACY_MODEL]: defineImageModelSpec({
    modelCode: GPT_IMAGE_LEGACY_MODEL,
    provider: IMAGE_PROVIDERS.OPENAI,
    adapter: IMAGE_ADAPTERS.OPENAI,
    label: 'GPT Image 1',
    defaults: DEFAULT_IMAGE_DEFAULTS,
    capabilities: openAiImageCapabilities,
    request: openAiImageRequest,
    qualityMap: IMAGE_QUALITY_MAP,
    sizeMap: GPT_SIZE_MAP,
  }),
  [GROK_IMAGE_MODEL]: defineImageModelSpec({
    modelCode: GROK_IMAGE_MODEL,
    provider: IMAGE_PROVIDERS.GROK,
    adapter: IMAGE_ADAPTERS.GROK,
    label: 'Grok Imagine Image',
    defaults: DEFAULT_IMAGE_DEFAULTS,
    capabilities: grokImageCapabilities,
    request: grokImageRequest,
    sizeMap: GROK_SIZE_MAP,
  }),
  [GROK_IMAGE_PRO_MODEL]: defineImageModelSpec({
    modelCode: GROK_IMAGE_PRO_MODEL,
    provider: IMAGE_PROVIDERS.GROK,
    adapter: IMAGE_ADAPTERS.GROK,
    label: 'Grok Imagine Image Pro',
    defaults: DEFAULT_IMAGE_DEFAULTS,
    capabilities: grokImageCapabilities,
    request: grokImageRequest,
    sizeMap: GROK_SIZE_MAP,
  }),
  [GROK_IMAGE_EDIT_MODEL]: defineImageModelSpec({
    modelCode: GROK_IMAGE_EDIT_MODEL,
    provider: IMAGE_PROVIDERS.GROK,
    adapter: IMAGE_ADAPTERS.GROK,
    label: 'Grok Imagine Image Edit',
    defaults: DEFAULT_IMAGE_DEFAULTS,
    capabilities: grokImageCapabilities,
    request: grokImageRequest,
    sizeMap: GROK_SIZE_MAP,
  }),
});

export const DEFAULT_IMAGE_MODEL = GPT_IMAGE_MODEL;
export const DEFAULT_IMAGE_MODEL_SPEC = IMAGE_MODEL_SPECS[DEFAULT_IMAGE_MODEL];

const EMPTY_IMAGE_CAPABILITIES = Object.freeze({
  ratioOptions: Object.freeze([]),
  qualityOptions: Object.freeze([]),
  supportsQuality: false,
  supportsReferenceImages: false,
  maxReferenceImages: 0,
  supportsEdit: false,
});

const trim = (value) => String(value || '').trim();

export const getDefaultImageModelCode = () => DEFAULT_IMAGE_MODEL;

export const listImageModelCodes = () =>
  Object.keys(IMAGE_MODEL_SPECS).filter(
    (model) => model !== GPT_IMAGE_LEGACY_MODEL && model !== GROK_IMAGE_EDIT_MODEL,
  );

export const isSupportedImageModel = (modelCode) =>
  Object.prototype.hasOwnProperty.call(IMAGE_MODEL_SPECS, trim(modelCode));

export const getImageModelSpec = (modelCode) => {
  const key = trim(modelCode);
  return IMAGE_MODEL_SPECS[key] || DEFAULT_IMAGE_MODEL_SPEC;
};

export const getImageCapabilitiesForModel = (modelCode) =>
  getImageModelSpec(modelCode).capabilities || EMPTY_IMAGE_CAPABILITIES;

export const getImageRequestSpecForModel = (modelCode, mode = 'generation') => {
  const request = getImageModelSpec(modelCode).request || {};
  return request[mode] || request.generation || jsonGenerationRequest;
};

export const getImageResponseSpecForModel = (modelCode) =>
  getImageModelSpec(modelCode).response || imageResponseSpec;

export const getImageAdapterKeyForModel = (modelCode) => {
  const spec = getImageModelSpec(modelCode);
  return spec.adapter || spec.provider || IMAGE_ADAPTERS.OPENAI;
};

export const getImageParamSchemaForModel = (modelCode) =>
  getImageModelSpec(modelCode).paramSchema || DEFAULT_IMAGE_PARAM_SCHEMA;

export const getImageRatioOptionsForModel = (modelCode) =>
  getImageCapabilitiesForModel(modelCode).ratioOptions || [];

export const getImageQualityOptionsForModel = (modelCode) =>
  getImageCapabilitiesForModel(modelCode).qualityOptions || [];

export const supportsImageQuality = (modelCode) =>
  Boolean(getImageCapabilitiesForModel(modelCode).supportsQuality);

export const getImageModelDefaults = (modelCode) => {
  const spec = getImageModelSpec(modelCode);
  const defaults = spec.defaults || DEFAULT_IMAGE_DEFAULTS;
  const capabilities = spec.capabilities || EMPTY_IMAGE_CAPABILITIES;
  return {
    ratio: defaults.ratio || DEFAULT_IMAGE_DEFAULTS.ratio,
    quality: defaults.quality || DEFAULT_IMAGE_DEFAULTS.quality,
    count: defaults.count || DEFAULT_IMAGE_DEFAULTS.count,
    maxReferenceImages: capabilities.maxReferenceImages || 0,
  };
};

export const isImageProviderModel = (modelCode, provider) =>
  getImageModelSpec(modelCode).provider === provider;

export const isGrokImageModel = (modelCode) =>
  isImageProviderModel(modelCode, 'grok');

export const isGptImageModel = (modelCode) =>
  isImageProviderModel(modelCode, 'openai');

export const normalizeImageReferenceImages = ({
  referenceImage,
  referenceImages,
} = {}) => {
  const cleanReferenceImages = (referenceImages || []).filter(Boolean);
  return cleanReferenceImages.length
    ? cleanReferenceImages
    : referenceImage
      ? [referenceImage]
      : [];
};

export const normalizeImageCount = (count, fallback = 1) => {
  const number = Number(count);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.max(1, Math.floor(number));
};

export const getImageRatioOptionForModel = (modelCode, ratio) => {
  const options = getImageRatioOptionsForModel(modelCode);
  const defaults = getImageModelDefaults(modelCode);
  return (
    options.find((option) => option.value === ratio) ||
    options.find((option) => option.value === defaults.ratio) ||
    options[0] ||
    null
  );
};

export const getImageDimensionsForModel = (
  modelCode,
  { ratio, width, height } = {},
) => {
  const explicitWidth = Number(width);
  const explicitHeight = Number(height);
  if (explicitWidth > 0 && explicitHeight > 0) {
    return { width: explicitWidth, height: explicitHeight };
  }
  const ratioOption = getImageRatioOptionForModel(modelCode, ratio);
  return {
    width: ratioOption?.width || null,
    height: ratioOption?.height || null,
  };
};

export const getImageSizeForModel = (
  modelCode,
  { ratio, width, height, size } = {},
) => {
  const explicitSize = trim(size);
  if (/^\d+\s*x\s*\d+$/i.test(explicitSize)) {
    return explicitSize.replace(/\s+/g, '');
  }
  const dimensions = getImageDimensionsForModel(modelCode, {
    ratio,
    width,
    height,
  });
  if (dimensions.width && dimensions.height) {
    return `${dimensions.width}x${dimensions.height}`;
  }
  const spec = getImageModelSpec(modelCode);
  const defaults = getImageModelDefaults(modelCode);
  return spec.sizeMap?.[ratio] || spec.sizeMap?.[defaults.ratio] || '';
};

export const mapImageQualityForModel = (modelCode, quality) => {
  if (!supportsImageQuality(modelCode)) return '';
  const spec = getImageModelSpec(modelCode);
  const normalized = trim(quality || getImageModelDefaults(modelCode).quality);
  return spec.qualityMap?.[normalized] || normalized;
};

export const createImageGenerationParams = (params = {}) => {
  const model = trim(params.model) || DEFAULT_IMAGE_MODEL;
  const defaults = getImageModelDefaults(model);
  const ratioOption = getImageRatioOptionForModel(
    model,
    params.ratio || params.size || defaults.ratio,
  );
  const ratio = ratioOption?.value || defaults.ratio;
  const dimensions = getImageDimensionsForModel(model, {
    ratio,
    width: params.width,
    height: params.height,
  });
  const referenceImages = normalizeImageReferenceImages(params);
  const maxReferenceImages =
    getImageCapabilitiesForModel(model).maxReferenceImages ||
    referenceImages.length;
  const boundedReferenceImages = referenceImages.slice(0, maxReferenceImages);
  const quality = params.quality || params.resolution || defaults.quality;

  return {
    ...params,
    model,
    prompt: String(params.prompt || ''),
    negativePrompt: params.negativePrompt || '',
    ratio,
    size: getImageSizeForModel(model, {
      ratio,
      width: dimensions.width,
      height: dimensions.height,
      size: params.size,
    }),
    width: dimensions.width,
    height: dimensions.height,
    quality,
    count: normalizeImageCount(params.count, Number(defaults.count) || 1),
    group: params.group || '',
    referenceImage: boundedReferenceImages[0] || '',
    referenceImages: boundedReferenceImages,
  };
};

export const getImageParameterStateForModel = (modelCode) => {
  const model = trim(modelCode) || DEFAULT_IMAGE_MODEL;
  const defaults = getImageModelDefaults(model);
  const capabilities = getImageCapabilitiesForModel(model);
  return {
    model,
    defaults,
    capabilities,
    schema: getImageParamSchemaForModel(model),
    ratioOptions: getImageRatioOptionsForModel(model),
    qualityOptions: getImageQualityOptionsForModel(model),
    supportsQuality: Boolean(capabilities.supportsQuality),
    supportsReferenceImages: Boolean(capabilities.supportsReferenceImages),
    maxReferenceImages: capabilities.maxReferenceImages || 0,
  };
};
