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
  createImageGenerationParams,
  getImageParameterStateForModel,
  normalizeImageCount,
} from './imageModelRegistry.js';

export const IMAGE_COUNT_VALUES = Object.freeze([1, 2, 4]);

export const getImageParameterState = (modelCode) =>
  getImageParameterStateForModel(modelCode);

export const createSingleImageParams = ({
  prompt,
  count,
  ratio,
  quality,
  model,
  group,
  referenceImages = [],
} = {}) =>
  createImageGenerationParams({
    prompt,
    count,
    ratio,
    quality,
    model,
    group,
    referenceImages,
  });

export const createBatchRowImageParams = (
  row,
  { model, group, quality, source, batchRowIndex } = {},
) => {
  const prompt = String(row?.prompt || '').trim();
  const normalized = createImageGenerationParams({
    prompt,
    ratio: row?.ratio,
    size: row?.size,
    quality,
    model,
    group,
    referenceImages: row?.images || [],
  });

  return {
    ...normalized,
    count: normalizeImageCount(row?.count, 1),
    ...(source ? { source } : {}),
    ...(row?.id ? { batchRowId: row.id } : {}),
    ...(batchRowIndex !== undefined && batchRowIndex !== null
      ? { batchRowIndex }
      : {}),
  };
};
