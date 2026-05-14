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

const getOptionValue = (option) => option?.value ?? option;

const hasGroupedModelMap = (groupModels) =>
  Object.values(groupModels || {}).some((list) => Array.isArray(list));

export const getWhitelistedModelValues = (models, whitelist) => {
  const whitelistSet = new Set(whitelist || []);
  return (models || [])
    .map(getOptionValue)
    .filter((value) => value && whitelistSet.has(value));
};

export const mergePricingIntoModels = (models, pricingItems) => {
  const pricingMap = new Map();
  (pricingItems || []).forEach((item) => {
    const modelName = item?.model_name ?? item?.modelName ?? item?.name;
    if (modelName) pricingMap.set(modelName, item);
  });

  return (models || []).map((model) => {
    const value = getOptionValue(model);
    const pricing = pricingMap.get(value);
    if (!pricing) return model;

    return {
      ...(typeof model === 'object' ? model : { label: value, value }),
      ...pricing,
      label: model?.label ?? value,
      value,
    };
  });
};

export const getAllowedCreationGroups = ({
  groups,
  models,
  groupModels,
  whitelist,
}) => {
  const set = new Set();
  const whitelistSet = new Set(whitelist || []);

  if (hasGroupedModelMap(groupModels)) {
    Object.entries(groupModels || {}).forEach(([group, list]) => {
      if (Array.isArray(list) && list.some((model) => whitelistSet.has(model))) {
        set.add(group);
      }
    });
    return set;
  }

  if (getWhitelistedModelValues(models, whitelist).length === 0) {
    return set;
  }

  (groups || []).forEach((group) => {
    const value = getOptionValue(group);
    if (value !== undefined && value !== null) set.add(value);
  });

  return set;
};

export const getAllowedCreationModels = ({
  models,
  groupModels,
  whitelist,
  selectedGroup,
  allowedGroupSet,
}) => {
  const set = new Set();
  const whitelistSet = new Set(whitelist || []);

  if (!hasGroupedModelMap(groupModels)) {
    getWhitelistedModelValues(models, whitelist).forEach((model) =>
      set.add(model),
    );
    return set;
  }

  const effectiveGroups = selectedGroup
    ? [selectedGroup]
    : Array.from(allowedGroupSet || []);
  effectiveGroups.forEach((group) => {
    (groupModels?.[group] || []).forEach((model) => {
      if (whitelistSet.has(model)) set.add(model);
    });
  });

  return set;
};
