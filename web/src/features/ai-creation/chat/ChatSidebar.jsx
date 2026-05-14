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

import React, { useEffect, useMemo, useState } from 'react';
import { Button, Dropdown, Input, Typography } from '@douyinfe/semi-ui';
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

const { Text } = Typography;
const CHAT_SESSION_PAGE_SIZE_OPTIONS = [8, 12, 20];

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const getSessionGroupKey = (session) => {
  const updatedAt = new Date(session?.updatedAt || Date.now());
  if (Number.isNaN(updatedAt.getTime())) return 'older';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sessionDay = new Date(
    updatedAt.getFullYear(),
    updatedAt.getMonth(),
    updatedAt.getDate(),
  );
  const diffDays = Math.floor((today - sessionDay) / 86400000);

  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 7) return 'last7';
  return 'older';
};

const ChatSidebar = ({
  activeSessionId,
  filteredSessions = [],
  sidebarCollapsed,
  setSidebarCollapsed,
  isMobile,
  mobileSidebarOpen,
  setMobileSidebarOpen,
  handleCreateNewChat,
  handleSessionActivate,
  handleDeleteSession,
  sessionQuery,
  setSessionQuery,
  isGenerating = false,
}) => {
  const { t } = useTranslation();
  const isCollapsed = sidebarCollapsed && !isMobile;
  const [searchOpen, setSearchOpen] = useState(Boolean(sessionQuery));
  const [openSessionMenuId, setOpenSessionMenuId] = useState(null);
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionPageSize, setSessionPageSize] = useState(12);
  const showSearchInput = !isCollapsed && (searchOpen || Boolean(sessionQuery));
  const generatingActionTitle = isGenerating
    ? t('生成中，请先停止再操作')
    : undefined;
  const sessionTotal = filteredSessions.length;
  const sessionPageCount = Math.max(
    1,
    Math.ceil(sessionTotal / Math.max(1, sessionPageSize)),
  );
  const sessionStart = (sessionPage - 1) * sessionPageSize;
  const sessionEnd = Math.min(sessionStart + sessionPageSize, sessionTotal);
  const pagedSessions = useMemo(
    () => filteredSessions.slice(sessionStart, sessionEnd),
    [filteredSessions, sessionEnd, sessionStart],
  );

  useEffect(() => {
    setSessionPage(1);
  }, [sessionQuery, sessionPageSize]);

  useEffect(() => {
    setSessionPage((page) => clampNumber(page, 1, sessionPageCount));
  }, [sessionPageCount]);

  const sessionGroups = useMemo(() => {
    const labels = [
      { key: 'today', label: t('今天') },
      { key: 'yesterday', label: t('昨天') },
      { key: 'last7', label: t('前 7 天') },
      { key: 'older', label: t('更早') },
    ];
    const buckets = labels.map((item) => ({ ...item, sessions: [] }));
    const bucketMap = new Map(buckets.map((item) => [item.key, item]));

    pagedSessions.forEach((session) => {
      bucketMap.get(getSessionGroupKey(session))?.sessions.push(session);
    });

    return buckets.filter((item) => item.sessions.length > 0);
  }, [pagedSessions, t]);

  return (
    <>
      {isMobile && (
        <div
          className={clsx(
            'ai-chat-sidebar-overlay',
            mobileSidebarOpen && 'open',
          )}
          aria-hidden={!mobileSidebarOpen}
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <aside
        className={clsx(
          'ai-chat-sidebar',
          isCollapsed && 'is-collapsed',
          isMobile && mobileSidebarOpen && 'open',
        )}
        aria-label={t('对话列表')}
      >
        <div className='ai-chat-sidebar-head'>
          {!isCollapsed && <div className='ai-chat-sidebar-head-spacer' />}

          {isMobile ? (
            <Button
              icon={<PanelLeftClose size={18} />}
              theme='borderless'
              type='tertiary'
              size='small'
              onClick={() => setMobileSidebarOpen(false)}
              aria-label={t('关闭对话列表')}
            />
          ) : (
            <Button
              icon={isCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              theme='borderless'
              type='tertiary'
              size='small'
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              aria-label={isCollapsed ? t('展开侧栏') : t('收起侧栏')}
            />
          )}
        </div>

        <div className='ai-chat-new-wrap'>
          <Button
            block
            theme='light'
            type='tertiary'
            icon={<Plus size={16} />}
            className='ai-chat-new-button'
            onClick={handleCreateNewChat}
            aria-label={t('新建对话')}
            disabled={isGenerating}
            title={generatingActionTitle}
          >
            {!isCollapsed && <span>{t('新建对话')}</span>}
          </Button>
        </div>

        {!isCollapsed && !showSearchInput && (
          <div className='ai-chat-sidebar-action-wrap'>
            <button
              type='button'
              className='ai-chat-sidebar-action-row'
              onClick={() => setSearchOpen(true)}
              aria-label={t('打开搜索')}
            >
              <Search size={15} />
              <span>{t('搜索会话')}</span>
            </button>
          </div>
        )}

        {showSearchInput && (
          <div className='ai-chat-search-wrap'>
            <Input
              prefix={<Search size={14} />}
              placeholder={t('搜索会话...')}
              value={sessionQuery}
              onChange={setSessionQuery}
              showClear
              className='ai-chat-search'
              aria-label={t('搜索会话...')}
              autoFocus
              suffix={
                !sessionQuery ? (
                  <button
                    type='button'
                    className='ai-chat-search-close'
                    aria-label={t('关闭搜索')}
                    onClick={() => setSearchOpen(false)}
                  >
                    <X size={13} />
                  </button>
                ) : null
              }
            />
          </div>
        )}

        <div className='ai-chat-session-list' role='navigation' aria-label={t('历史记录')}>
          {sessionGroups.map((group) => (
            <section className='ai-chat-session-group' key={group.key}>
              {!isCollapsed && (
                <div className='ai-chat-session-section-title'>
                  {group.label}
                </div>
              )}

              {group.sessions.map((session) => {
                const isActive = session.id === activeSessionId;
                const title = session.title || t('新对话');

                return (
                  <div
                    key={session.id}
                    className={clsx('ai-chat-session-row', isActive && 'is-active')}
                  >
                    <button
                      type='button'
                      className='ai-chat-session-button'
                      onClick={() => handleSessionActivate(session)}
                      disabled={isGenerating && !isActive}
                      aria-disabled={isGenerating && !isActive}
                      aria-current={isActive ? 'page' : undefined}
                      title={generatingActionTitle || title}
                    >
                      <span>{isCollapsed ? title.slice(0, 1) : title}</span>
                    </button>

                    {!isCollapsed && (
                      <Dropdown
                        trigger='click'
                        position='bottomRight'
                        visible={openSessionMenuId === session.id}
                        onVisibleChange={(visible) => {
                          setOpenSessionMenuId(visible ? session.id : null);
                        }}
                        render={
                          <div
                            className='ai-chat-menu ai-chat-session-menu'
                            role='menu'
                            aria-label={t('会话操作')}
                          >
                            <button
                              type='button'
                              role='menuitem'
                              className='ai-chat-menu-item is-danger'
                              disabled={isGenerating}
                              onClick={() => {
                                if (isGenerating) return;
                                setOpenSessionMenuId(null);
                                handleDeleteSession(session.id);
                              }}
                            >
                              <Trash2 size={14} />
                              <span>
                              {t('删除')}
                              </span>
                            </button>
                          </div>
                        }
                      >
                        <button
                          type='button'
                          className='ai-chat-session-more'
                          aria-label={t('会话操作')}
                          aria-haspopup='menu'
                          aria-expanded={openSessionMenuId === session.id}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </Dropdown>
                    )}
                  </div>
                );
              })}
            </section>
          ))}

          {filteredSessions.length === 0 && !isCollapsed && (
            <div className='ai-chat-session-empty'>
              <Text type='tertiary' size='small'>{t('暂无会话')}</Text>
            </div>
          )}
        </div>

        {!isCollapsed && sessionTotal > 0 && (
          <div className='ai-chat-session-pagination ai-creation-klein-pagination'>
            <select
              className='ai-chat-session-page-size'
              value={sessionPageSize}
              onChange={(event) =>
                setSessionPageSize(Number(event.target.value) || 12)
              }
              aria-label='page size'
            >
              {CHAT_SESSION_PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <span className='ai-chat-session-page-range tabular-nums'>
              {sessionTotal === 0 ? '0' : `${sessionStart + 1}-${sessionEnd}`} / {sessionTotal}
            </span>
            <div className='ai-creation-klein-pagination__nav'>
              <button
                type='button'
                className='ai-creation-klein-pagination__btn'
                disabled={sessionPage <= 1}
                aria-label='previous page'
                onClick={() => setSessionPage((page) => Math.max(1, page - 1))}
              >
                <ChevronLeft size={14} />
              </button>
              <span className='ai-creation-klein-pagination__pages tabular-nums'>
                <strong>{sessionPage}</strong>
                <span> / {sessionPageCount}</span>
              </span>
              <button
                type='button'
                className='ai-creation-klein-pagination__btn'
                disabled={sessionPage >= sessionPageCount}
                aria-label='next page'
                onClick={() =>
                  setSessionPage((page) => Math.min(sessionPageCount, page + 1))
                }
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </aside>
    </>
  );
};

export default ChatSidebar;
