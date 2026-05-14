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

import { useEffect, useState } from 'react';
import {
  loadScenePreference,
  saveScenePreference,
} from '../components/playground/configStorage';

/**
 * 为不同创作场景(chat/image/video)持久化 model + group 选择。
 *
 * 行为：
 * - 挂载后若 localStorage 有当前场景的记忆值，优先写回 inputs（不污染其它场景）。
 * - 用户切换 model/group 时，把值写回 localStorage 作为下次默认值。
 * - allowedModelSet/allowedGroupSet 非空时仅保存合法值，避免把白名单外的残值回写。
 *
 * @returns {{hydrated: boolean}}
 */
export function useScenePreference({
  scene,
  inputs,
  handleInputChange,
  allowedModelSet,
  allowedGroupSet,
  groupModels,
  ready,
}) {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    if (!ready) return;
    const pref = loadScenePreference(scene);
    const nextGroup =
      pref.group && (!allowedGroupSet || allowedGroupSet.has(pref.group))
        ? pref.group
        : null;
    if (nextGroup && nextGroup !== inputs.group) {
      handleInputChange('group', nextGroup);
    }
    const modelAllowedInGroup = (() => {
      if (!pref.model) return false;
      if (allowedModelSet && !allowedModelSet.has(pref.model)) return false;
      if (nextGroup && groupModels?.[nextGroup]) {
        return groupModels[nextGroup].includes(pref.model);
      }
      return true;
    })();
    if (modelAllowedInGroup && pref.model !== inputs.model) {
      handleInputChange('model', pref.model);
    }
    setHydrated(true);
  }, [
    scene,
    ready,
    hydrated,
    allowedGroupSet,
    allowedModelSet,
    groupModels,
    inputs.group,
    inputs.model,
    handleInputChange,
  ]);

  useEffect(() => {
    if (!hydrated) return;
    if (!inputs.model) return;
    if (allowedModelSet && !allowedModelSet.has(inputs.model)) return;
    saveScenePreference(scene, { model: inputs.model });
  }, [scene, inputs.model, allowedModelSet, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    if (!inputs.group) return;
    if (allowedGroupSet && !allowedGroupSet.has(inputs.group)) return;
    saveScenePreference(scene, { group: inputs.group });
  }, [scene, inputs.group, allowedGroupSet, hydrated]);

  return { hydrated };
}
