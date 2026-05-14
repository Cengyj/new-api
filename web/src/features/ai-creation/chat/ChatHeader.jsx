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

import React from 'react';
import { Button, Tooltip } from '@douyinfe/semi-ui';
import { Menu, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ChatModelMenu, { ChatGroupMenu } from './ChatModelMenu.jsx';

const ChatHeader = ({
  isMobile,
  sidebarCollapsed,
  setSidebarCollapsed,
  setMobileSidebarOpen,
  models,
  groups,
  inputs,
  handleInputChange,
  activeTitle,
  updatedAtLabel,
  isGenerating = false,
  runtimeStatusText = '',
}) => {
  const { t } = useTranslation();
  const metaLabel = isGenerating ? t('正在生成') : runtimeStatusText || updatedAtLabel;

  return (
    <header className='ai-chat-header'>
      <div className='flex items-center gap-4 min-w-0 flex-1'>
        {isMobile && (
          <Button
            icon={<Menu size={20} />}
            theme='borderless'
            type='tertiary'
            onClick={() => setMobileSidebarOpen(true)}
            aria-label={t('打开对话列表')}
          />
        )}

        {!isMobile && sidebarCollapsed && (
          <Tooltip content={t('展开侧栏')}>
            <Button
              icon={<PanelLeftOpen size={18} />}
              theme='borderless'
              type='tertiary'
              onClick={() => setSidebarCollapsed(false)}
              aria-label={t('展开侧栏')}
            />
          </Tooltip>
        )}

        <div className='ai-chat-header-title'>
          <div>
            <h2>{activeTitle || t('新对话')}</h2>
            <div className='ai-chat-header-meta'>
              <span>{metaLabel}</span>
            </div>
          </div>
        </div>
      </div>

      <div className='ai-chat-header-pickers'>
        <ChatGroupMenu
          groups={groups}
          inputs={inputs}
          onInputChange={handleInputChange}
          disabled={isGenerating}
        />
        <ChatModelMenu
          models={models}
          inputs={inputs}
          onInputChange={handleInputChange}
          disabled={isGenerating}
        />
      </div>
    </header>
  );
};

export default ChatHeader;
