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
import { Button, Dropdown, Tooltip } from '@douyinfe/semi-ui';
import {
  Copy,
  Edit,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

const ChatMessageActions = ({
  message,
  styleState,
  onMessageReset,
  onMessageCopy,
  onMessageDelete,
  onRoleToggle,
  onMessageEdit,
  isAnyMessageGenerating = false,
  isEditing = false,
}) => {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const isLoading =
    message.status === 'loading' || message.status === 'incomplete';
  const shouldDisableActions = isAnyMessageGenerating || isEditing;
  const canToggleRole =
    message.role === 'assistant' || message.role === 'system';
  const canEdit =
    !isLoading &&
    message.content &&
    typeof onMessageEdit === 'function' &&
    !isEditing;
  const iconSize = styleState.isMobile ? 13 : 14;

  const menuItems = useMemo(
    () => [
      canEdit && {
        key: 'edit',
        icon: <Edit size={14} />,
        label: t('编辑'),
        disabled: shouldDisableActions,
        onClick: () => onMessageEdit?.(message),
      },
      canToggleRole && {
        key: 'role',
        icon: <UserCheck size={14} />,
        label:
          message.role === 'assistant'
            ? t('切换为System角色')
            : t('切换为Assistant角色'),
        disabled: shouldDisableActions,
        onClick: () => onRoleToggle?.(message),
      },
      {
        key: 'delete',
        icon: <Trash2 size={14} />,
        label: t('删除'),
        danger: true,
        disabled: shouldDisableActions || !onMessageDelete,
        onClick: () => onMessageDelete?.(message),
      },
    ].filter(Boolean),
    [
      canEdit,
      canToggleRole,
      message,
      onMessageDelete,
      onMessageEdit,
      onRoleToggle,
      shouldDisableActions,
      t,
    ],
  );

  const renderActionButton = ({ label, icon, onClick, disabled }) => (
    <Tooltip content={disabled ? t('操作暂时被禁用') : label} position='top'>
      <Button
        theme='borderless'
        type='tertiary'
        size='small'
        icon={icon}
        onClick={() => !disabled && onClick?.(message)}
        disabled={disabled}
        className='ai-chat-message-action-button'
        aria-label={label}
      />
    </Tooltip>
  );

  return (
    <div className='ai-chat-message-actions' aria-label={t('消息操作')}>
      {!isLoading &&
        renderActionButton({
          label: t('重试'),
          icon: <RefreshCw size={iconSize} />,
          onClick: onMessageReset,
          disabled: shouldDisableActions,
        })}

      {message.content &&
        renderActionButton({
          label: t('复制'),
          icon: <Copy size={iconSize} />,
          onClick: onMessageCopy,
          disabled: false,
        })}

      {menuItems.length > 0 && (
        <Dropdown
          trigger='click'
          position='bottomRight'
          visible={menuOpen}
          onVisibleChange={setMenuOpen}
          render={
            <div
              className='ai-chat-menu ai-chat-message-menu'
              role='menu'
              aria-label={t('更多消息操作')}
            >
              {menuItems.map((item) => (
                <button
                  key={item.key}
                  type='button'
                  role='menuitem'
                  className={item.danger ? 'ai-chat-menu-item is-danger' : 'ai-chat-menu-item'}
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) return;
                    setMenuOpen(false);
                    item.onClick();
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          }
        >
          <Button
            theme='borderless'
            type='tertiary'
            size='small'
            icon={<MoreHorizontal size={iconSize} />}
            className='ai-chat-message-action-button'
            aria-label={t('更多消息操作')}
            aria-haspopup='menu'
            aria-expanded={menuOpen}
          />
        </Dropdown>
      )}
    </div>
  );
};

export default React.memo(ChatMessageActions);
