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
  DEFAULT_VIDEO_MODEL,
  getVideoCapabilitiesForModel,
  getVideoModelDefaults,
  getVideoModelSpec,
  getVideoParameterStateForModel,
  getVideoRequestSpecForModel,
  getVideoSizeForModel,
  isSupportedVideoModel,
} from './videoModelRegistry.js';

const optionValues = (options = []) =>
  new Set((Array.isArray(options) ? options : []).map((option) => option.value));

const normalizeOptionValue = (value, options, fallback) => {
  const normalized = String(value ?? '').trim();
  const values = optionValues(options);
  if (!values.size) return normalized || fallback;
  return values.has(normalized) ? normalized : fallback;
};

export const getVideoSeconds = (durationOrSeconds) => {
  const seconds = Number(String(durationOrSeconds ?? '').replace(/s$/i, ''));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

const normalizeDurationValue = (value, options, fallback) => {
  const raw = String(value ?? '').trim();
  const values = optionValues(options);
  if (values.has(raw)) return raw;
  const seconds = getVideoSeconds(raw);
  if (seconds) {
    const candidate = `${seconds}s`;
    if (values.has(candidate)) return candidate;
  }
  return fallback;
};

const normalizePresetValue = (value, supportedPresets = [], fallback) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return fallback;
  return supportedPresets.includes(normalized) ? normalized : fallback;
};

const normalizeVideoCount = (count, fallback = 1) => {
  const number = Number(count);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.max(1, Math.floor(number));
};

export const getVideoParameterState = (modelCode) =>
  getVideoParameterStateForModel(modelCode);

export const getVideoReferenceImages = (params = {}, capabilities = {}) => {
  const cleanReferenceImages = Array.isArray(params.referenceImages)
    ? params.referenceImages.filter(Boolean)
    : [];
  // Boundary-only compatibility: accept legacy playground field names here and
  // immediately convert them to the canonical referenceImages array.
  const legacyInputReference =
    params.input_reference || params['input_reference[]'];
  const rawReferences = cleanReferenceImages.length
    ? cleanReferenceImages
    : params.referenceImage
      ? [params.referenceImage]
      : Array.isArray(legacyInputReference)
        ? legacyInputReference.filter(Boolean)
        : legacyInputReference
          ? [legacyInputReference]
          : [];
  const maxReferenceImages = Number(capabilities.maxReferenceImages) || 0;
  if (!capabilities.supportsReferenceImages || maxReferenceImages <= 0) {
    return [];
  }
  return rawReferences.slice(0, maxReferenceImages);
};

export const normalizeVideoGenerationParams = (params = {}) => {
  const rawModel = String(params.model || DEFAULT_VIDEO_MODEL).trim();
  const model = isSupportedVideoModel(rawModel) ? rawModel : DEFAULT_VIDEO_MODEL;
  const spec = getVideoModelSpec(model);
  const defaults = getVideoModelDefaults(model);
  const capabilities = getVideoCapabilitiesForModel(model);
  const request = getVideoRequestSpecForModel(model);
  const ratio = normalizeOptionValue(
    params.ratio,
    capabilities.ratioOptions,
    defaults.ratio,
  );
  const duration = normalizeDurationValue(
    params.duration ?? params.seconds,
    capabilities.durationOptions,
    defaults.duration,
  );
  const seconds = getVideoSeconds(params.seconds ?? duration);
  const resolution = normalizeOptionValue(
    params.resolution_name ?? params.resolution,
    capabilities.resolutionOptions,
    defaults.resolution,
  );
  const preset = normalizePresetValue(
    params.preset,
    capabilities.supportedPresets,
    defaults.preset,
  );
  const referenceImages = getVideoReferenceImages(params, capabilities);
  const size = getVideoSizeForModel(model, {
    ratio,
    resolution,
    size: params.size,
  });

  return {
    model,
    provider: spec.provider,
    adapter: spec.adapter,
    group: String(params.group || '').trim(),
    prompt: String(params.prompt || ''),
    ratio,
    duration,
    seconds,
    resolution,
    resolution_name: resolution,
    size,
    preset,
    referenceImage: referenceImages[0] || '',
    referenceImages,
    referenceCount: referenceImages.length,
    referenceFieldName: request.referenceFieldName,
    transport: request.transport,
    endpoint: request.endpoint,
    pollEndpoint: request.pollEndpoint || request.endpoint,
  };
};

export const createSingleVideoParams = ({
  prompt,
  ratio,
  duration,
  resolution,
  preset,
  model,
  group,
  referenceImages = [],
} = {}) => ({
  ...normalizeVideoGenerationParams({
    prompt: String(prompt || '').trim(),
    ratio,
    duration,
    resolution,
    preset,
    model,
    group,
    referenceImages,
  }),
  count: 1,
});

export const createBatchRowVideoParams = (
  row,
  { model, group, source, batchRowIndex } = {},
) => {
  const normalized = normalizeVideoGenerationParams({
    prompt: String(row?.prompt || '').trim(),
    ratio: row?.ratio,
    duration: row?.duration,
    resolution: row?.resolution,
    preset: row?.preset,
    size: row?.size,
    model,
    group,
    referenceImages: row?.images || row?.referenceImages || [],
  });

  return {
    ...normalized,
    count: normalizeVideoCount(row?.count, 1),
    ...(source ? { source } : {}),
    ...(row?.id ? { batchRowId: row.id } : {}),
    ...(batchRowIndex !== undefined && batchRowIndex !== null
      ? { batchRowIndex }
      : {}),
  };
};
