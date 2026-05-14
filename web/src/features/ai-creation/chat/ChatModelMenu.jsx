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

import React, { useMemo, useState } from 'react';
import { Button, Dropdown } from '@douyinfe/semi-ui';
import { Check, ChevronDown, SlidersHorizontal, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getModelDisplayName } from '../constants.js';
import { normalizeChatOption } from './chatModelRegistry.js';

const OptionButton = ({ option, selected, onSelect, disabled = false }) => (
  <button
    type='button'
    role='menuitemradio'
    aria-checked={selected}
    className='ai-chat-menu-item'
    disabled={disabled}
    onClick={() => onSelect(option.value)}
    title={option.label}
  >
    <span>{option.label}</span>
    {selected && <Check size={14} />}
  </button>
);

const renderOptions = (
  options,
  value,
  field,
  onInputChange,
  setOpen,
  emptyLabel,
  disabled,
) =>
  options.length > 0 ? (
    options.map((option) => (
      <OptionButton
        key={`${field}-${option.value}`}
        option={option}
        selected={option.value === String(value || '')}
        onSelect={(nextValue) => {
          if (disabled) return;
          onInputChange(field, nextValue);
          setOpen(false);
        }}
        disabled={disabled}
      />
    ))
  ) : (
    <div className='ai-chat-menu-empty'>{emptyLabel}</div>
  );

export const ChatGroupMenu = ({
  groups = [],
  inputs = {},
  onInputChange,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const groupOptions = useMemo(() => groups.map(normalizeChatOption), [groups]);
  const currentGroup = useMemo(
    () =>
      groupOptions.find((item) => item.value === String(inputs.group || '')) ||
      null,
    [inputs.group, groupOptions],
  );

  return (
    <Dropdown
      trigger='click'
      position='bottomRight'
      visible={open}
      onVisibleChange={(visible) => setOpen(disabled ? false : visible)}
      render={
        <div
          className='ai-chat-menu ai-chat-model-menu ai-chat-group-menu'
          role='menu'
          aria-label={t('选择分组')}
        >
          {renderOptions(
            groupOptions,
            inputs.group,
            'group',
            onInputChange,
            setOpen,
            t('暂无可选项'),
            disabled,
          )}
        </div>
      }
    >
      <Button
        className='ai-chat-model-trigger ai-chat-group-trigger'
        theme='borderless'
        type='tertiary'
        icon={<Users size={15} />}
        aria-label={t('选择分组')}
        aria-haspopup='menu'
        aria-expanded={open}
        disabled={disabled}
      >
        <span className='ai-chat-model-trigger-text'>
          {currentGroup?.label || inputs.group || t('默认分组')}
        </span>
        <ChevronDown
          size={14}
          className={open ? 'ai-chat-model-chevron is-open' : 'ai-chat-model-chevron'}
        />
      </Button>
    </Dropdown>
  );
};

const ChatModelMenu = ({
  models = [],
  inputs = {},
  onInputChange,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const modelOptions = useMemo(
    () =>
      models.map(normalizeChatOption).map((opt) => ({
        ...opt,
        label: getModelDisplayName(opt.value) || opt.label,
      })),
    [models],
  );
  const currentModel = useMemo(
    () =>
      modelOptions.find((item) => item.value === String(inputs.model || '')) ||
      null,
    [inputs.model, modelOptions],
  );

  return (
    <Dropdown
      trigger='click'
      position='bottomRight'
      visible={open}
      onVisibleChange={(visible) => setOpen(disabled ? false : visible)}
      render={
        <div
          className='ai-chat-menu ai-chat-model-menu'
          role='menu'
          aria-label={t('模型菜单')}
        >
          {renderOptions(
            modelOptions,
            inputs.model,
            'model',
            onInputChange,
            setOpen,
            t('暂无可选项'),
            disabled,
          )}
        </div>
      }
    >
      <Button
        className='ai-chat-model-trigger'
        theme='borderless'
        type='tertiary'
        icon={<SlidersHorizontal size={15} />}
        aria-label={t('选择模型')}
        aria-haspopup='menu'
        aria-expanded={open}
        disabled={disabled}
      >
        <span className='ai-chat-model-trigger-text'>
          {currentModel?.label || inputs.model || t('选择模型')}
        </span>
        <ChevronDown
          size={14}
          className={open ? 'ai-chat-model-chevron is-open' : 'ai-chat-model-chevron'}
        />
      </Button>
    </Dropdown>
  );
};

export default ChatModelMenu;
