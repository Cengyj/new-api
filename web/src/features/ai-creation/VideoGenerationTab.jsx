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

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Modal, Toast } from '@douyinfe/semi-ui';
import {
  AlertCircle,
  ChevronDown,
  Copy,
  Loader2,
  RotateCcw,
  Video,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { UserContext } from '../../context/User';
import { useDataLoader } from '../../hooks/playground/useDataLoader';
import { usePlaygroundState } from '../../hooks/playground/usePlaygroundState';
import { useScenePreference } from '../../hooks/useScenePreference';
import { TASK_STATUS, VIDEO_MODEL_WHITELIST } from './constants.js';
import {
  summarizeVideoBatchTasks,
  isVideoBatchGeneratedTask,
} from './videoBatchQueue.js';
import {
  clearSettledVideoTasks,
  cancelActiveVideoTasks,
  cancelVideoTask,
  cancelVideoTasks,
  deleteVideoTask,
  deleteVideoTasks,
  enqueueVideoTasks,
  retryVideoTask,
  subscribeVideoTasks,
} from './videoCreationController.js';
import {
  CreationModeTabs,
  CreationTaskActionButton,
  clampCreationNumber as clampNumber,
  getCreationPageCount as getPageCount,
} from './AiCreationShared.jsx';
import {
  BatchResultsActions,
  useBatchFolderPageSize,
} from './BatchExcelShared.jsx';
import {
  CreationGalleryEmptyState,
  CreationGalleryPanel,
  getCreationGalleryStyle,
} from './CreationGallery.jsx';
import {
  CreationWorkCard,
  downloadCreationWorkAsset,
  getCreationWorkSourceUrl,
  useCachedVideoDisplayUrl,
} from './CreationWorkCard.jsx';
import {
  getCreationTaskStatusLabel,
  isCreationTaskActive,
  isCreationTaskCancelled,
} from './creationTaskUtils.js';
import {
  getAllowedCreationGroups,
  getAllowedCreationModels,
} from './creationModelAccess.js';
import { useCreationPricing } from './useCreationPricing.js';
import VideoSingleTab from './VideoSingleTab.jsx';
import VideoBatchTab from './VideoBatchTab.jsx';
import { loadVideoBatchRows } from './videoBatchTable.js';
import './imageBatchExcel.css';
import './styles.css';

const ACTIVE_TAB_STORAGE_KEY = 'ai_creation_video_active_tab';

const loadActiveTab = () => {
  if (typeof window === 'undefined') return 'single';
  try {
    const value = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    return value === 'batch' ? 'batch' : 'single';
  } catch {
    return 'single';
  }
};

const persistActiveTab = (value) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
};

function VideoModeSwitch({ activeTab, onChange, t }) {
  const items = [
    { key: 'single', label: t('单条生成') },
    { key: 'batch', label: t('批量生成') },
  ];

  return (
    <CreationModeTabs
      items={items}
      activeKey={activeTab}
      onChange={onChange}
      className='ai-creation-video-mode-switch'
      tabClassName='ai-creation-video-mode-tab'
    />
  );
}

export default function VideoGenerationTab() {
  const { t } = useTranslation();
  const [userState] = useContext(UserContext);
  const {
    inputs,
    models,
    groups,
    groupModels,
    handleInputChange,
    setModels,
    setGroups,
    setGroupModels,
  } = usePlaygroundState();
  useDataLoader(
    userState,
    inputs,
    handleInputChange,
    setModels,
    setGroups,
    setGroupModels,
  );
  const pricedModels = useCreationPricing(models);

  const allowedGroupSet = useMemo(
    () =>
      getAllowedCreationGroups({
        groups,
        models: pricedModels,
        groupModels,
        whitelist: VIDEO_MODEL_WHITELIST,
      }),
    [groups, pricedModels, groupModels],
  );

  const allowedVideoModelSet = useMemo(
    () =>
      getAllowedCreationModels({
        models: pricedModels,
        groupModels,
        whitelist: VIDEO_MODEL_WHITELIST,
        selectedGroup: inputs.group,
        allowedGroupSet,
      }),
    [pricedModels, groupModels, inputs.group, allowedGroupSet],
  );

  const filteredGroups = useMemo(
    () => (groups || []).filter((g) => allowedGroupSet.has(g.value)),
    [groups, allowedGroupSet],
  );

  const filteredModels = useMemo(
    () =>
      (pricedModels || []).filter((option) =>
        allowedVideoModelSet.has(option.value),
      ),
    [pricedModels, allowedVideoModelSet],
  );

  const hasAnyVideoModel = allowedGroupSet.size > 0;

  const { hydrated } = useScenePreference({
    scene: 'video',
    inputs,
    handleInputChange,
    allowedModelSet: allowedVideoModelSet,
    allowedGroupSet,
    groupModels,
    ready: hasAnyVideoModel,
  });

  // 若用户当前选中的分组/模型不可用于视频生成，自动切到首个允许项
  useEffect(() => {
    if (!hasAnyVideoModel) return;
    if (!hydrated) return;
    if (!allowedGroupSet.has(inputs.group)) {
      handleInputChange('group', filteredGroups[0]?.value || '');
    }
  }, [
    hasAnyVideoModel,
    hydrated,
    allowedGroupSet,
    inputs.group,
    handleInputChange,
    filteredGroups,
  ]);

  useEffect(() => {
    if (!hasAnyVideoModel) return;
    if (!hydrated) return;
    if (filteredModels.length === 0) return;
    if (!allowedVideoModelSet.has(inputs.model)) {
      handleInputChange('model', filteredModels[0].value);
    }
  }, [
    hasAnyVideoModel,
    hydrated,
    allowedVideoModelSet,
    inputs.model,
    filteredModels,
    handleInputChange,
  ]);

  const [tasks, setTasks] = useState([]);
  const [preview, setPreview] = useState(null);
  const [errorTask, setErrorTask] = useState(null);
  const [queuePanelOpen, setQueuePanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(loadActiveTab);
  const [worksPage, setWorksPage] = useState(1);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const worksGridRef = useRef(null);

  const queueSummary = useMemo(() => summarizeVideoBatchTasks(tasks), [tasks]);

  const batchTaskIdSet = useMemo(() => {
    const ids = new Set();
    loadVideoBatchRows().forEach((row) => {
      (row.taskIds || []).forEach((id) => ids.add(id));
    });
    return ids;
  }, [tasks]);

  useEffect(() => subscribeVideoTasks(setTasks), []);

  useEffect(() => {
    persistActiveTab(activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!selectionMode) setSelectedIds(new Set());
  }, [selectionMode]);

  const handleEnqueue = useCallback((queuedTasks, concurrency) => {
    if (!queuedTasks?.length) return;
    enqueueVideoTasks(queuedTasks, concurrency);
    setQueuePanelOpen(true);
  }, []);

  const retryTask = useCallback((task) => {
    retryVideoTask(task);
    setQueuePanelOpen(true);
  }, []);

  const deleteTask = useCallback((taskId) => {
    deleteVideoTask(taskId);
    setSelectedIds((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const cancelTask = useCallback((taskId) => {
    cancelVideoTask(taskId);
    setQueuePanelOpen(true);
  }, []);

  const confirmCancelActiveTasks = useCallback(() => {
    if (!queueSummary.active) return;
    Modal.confirm({
      title: t('停止全部生成任务？'),
      content: t(
        '\u6392\u961f\u4e2d\u7684\u4efb\u52a1\u5c06\u53d6\u6d88\uff0c\u751f\u6210\u4e2d\u7684\u4efb\u52a1\u4f1a\u5c3d\u5feb\u505c\u6b62\u3002\u5df2\u7ecf\u5b8c\u6210\u7684\u7ed3\u679c\u4e0d\u4f1a\u5220\u9664\u3002',
      ),
      okText: t('停止'),
      cancelText: t('取消'),
      okButtonProps: { type: 'danger' },
      onOk: () => cancelActiveVideoTasks(),
    });
  }, [queueSummary.active, t]);

  const clearFinishedTasks = useCallback(() => {
    clearSettledVideoTasks();
  }, []);

  const toggleSelection = useCallback((taskId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const singleAllResultItems = useMemo(
    () =>
      tasks.filter(
        (item) =>
          (item.status !== TASK_STATUS.ERROR || item.prompt) &&
          !isVideoBatchGeneratedTask(item, batchTaskIdSet),
      ),
    [batchTaskIdSet, tasks],
  );

  const worksPageSize = useBatchFolderPageSize(
    worksGridRef,
    `single-video:${singleAllResultItems.length}`,
    {
      minCardWidth: 230,
      gap: 12,
      desktopRows: 2,
      mobileRows: 2,
    },
  );

  const worksPageCount = getPageCount(
    singleAllResultItems.length,
    worksPageSize,
  );

  useEffect(() => {
    setWorksPage((page) => clampNumber(page, 1, worksPageCount));
  }, [worksPageCount]);

  const singleResultItems = useMemo(
    () =>
      singleAllResultItems.slice(
        (worksPage - 1) * worksPageSize,
        worksPage * worksPageSize,
      ),
    [singleAllResultItems, worksPage, worksPageSize],
  );

  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(singleResultItems.map((item) => item.id)));
  }, [singleResultItems]);

  const singleGalleryStyle = useMemo(
    () => getCreationGalleryStyle('video'),
    [],
  );

  const selectedWorkItems = useMemo(
    () => singleAllResultItems.filter((item) => selectedIds.has(item.id)),
    [selectedIds, singleAllResultItems],
  );

  const isRetryableWork = useCallback(
    (item) =>
      item.status === TASK_STATUS.ERROR || isCreationTaskCancelled(item),
    [],
  );

  const isDownloadableWork = useCallback(
    (item) =>
      item.status === TASK_STATUS.SUCCESS &&
      Boolean(getCreationWorkSourceUrl(item, 'video')),
    [],
  );

  const activeSelectedWorkCount = useMemo(
    () => selectedWorkItems.filter(isCreationTaskActive).length,
    [selectedWorkItems],
  );
  const downloadableSelectedWorkCount = useMemo(
    () => selectedWorkItems.filter(isDownloadableWork).length,
    [isDownloadableWork, selectedWorkItems],
  );
  const retryableSelectedWorkCount = useMemo(
    () => selectedWorkItems.filter(isRetryableWork).length,
    [isRetryableWork, selectedWorkItems],
  );
  const activeWorkCount = useMemo(
    () => singleAllResultItems.filter(isCreationTaskActive).length,
    [singleAllResultItems],
  );
  const retryableWorkCount = useMemo(
    () => singleAllResultItems.filter(isRetryableWork).length,
    [isRetryableWork, singleAllResultItems],
  );
  const failedWorkCount = useMemo(
    () =>
      singleAllResultItems.filter(
        (item) =>
          item.status === TASK_STATUS.ERROR && !isCreationTaskCancelled(item),
      ).length,
    [singleAllResultItems],
  );
  const settledWorkCount = useMemo(
    () =>
      singleAllResultItems.filter(
        (item) =>
          item.status === TASK_STATUS.SUCCESS || isCreationTaskCancelled(item),
      ).length,
    [singleAllResultItems],
  );

  const deleteWorkIds = useCallback((taskIds) => {
    if (!taskIds?.length) return;
    const idSet = new Set(taskIds);
    deleteVideoTasks(taskIds);
    setSelectedIds((prev) => {
      if (![...idSet].some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      idSet.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  const downloadWorkItems = useCallback(
    async (items) => {
      const downloadable = items.filter(isDownloadableWork);
      if (!downloadable.length) {
        Toast.warning(t('选中项中没有可下载结果'));
        return;
      }
      for (const item of downloadable) {
        await downloadCreationWorkAsset(item, 'video');
      }
    },
    [isDownloadableWork, t],
  );

  const retryWorkItems = useCallback(
    (items) => {
      const retryable = items.filter(isRetryableWork);
      if (!retryable.length) {
        Toast.warning(t('选中项中没有可重试任务'));
        return;
      }
      retryable.forEach((item) => retryTask(item));
    },
    [isRetryableWork, retryTask, t],
  );

  const cancelWorkItems = useCallback((items) => {
    const activeIds = items.filter(isCreationTaskActive).map((item) => item.id);
    if (!activeIds.length) return;
    cancelVideoTasks(activeIds);
    setQueuePanelOpen(true);
  }, []);

  const deleteSelectedWorks = useCallback(() => {
    if (!selectedIds.size) return;
    deleteWorkIds([...selectedIds]);
    setSelectionMode(false);
  }, [deleteWorkIds, selectedIds]);

  const deleteFailedWorks = useCallback(() => {
    deleteWorkIds(
      singleAllResultItems
        .filter(
          (item) =>
            item.status === TASK_STATUS.ERROR && !isCreationTaskCancelled(item),
        )
        .map((item) => item.id),
    );
  }, [deleteWorkIds, singleAllResultItems]);

  const clearCompletedStoppedWorks = useCallback(() => {
    deleteWorkIds(
      singleAllResultItems
        .filter(
          (item) =>
            item.status === TASK_STATUS.SUCCESS ||
            isCreationTaskCancelled(item),
        )
        .map((item) => item.id),
    );
  }, [deleteWorkIds, singleAllResultItems]);

  return (
    <div className='ai-creation-page ai-creation-page--video w-full px-4 pb-32 pt-4 sm:px-6 lg:px-8'>
      <span
        className='ai-creation-route-chip ai-creation-route-chip--hidden'
        aria-hidden='true'
      >
        /ai-creation/video
      </span>
      <div className='ai-creation-top-nav'>
        <div className='ai-creation-video-modebar'>
          <VideoModeSwitch
            activeTab={activeTab}
            onChange={setActiveTab}
            t={t}
          />
        </div>
      </div>

      {activeTab === 'single' ? (
        <div className='ai-creation-single-pane ai-creation-video-single-pane mt-4'>
          <section className='ai-creation-video-creator-panel'>
            <div className='ai-creation-composer-wrap mx-auto max-w-[760px]'>
              {hasAnyVideoModel ? (
                <VideoSingleTab
                  inputs={inputs}
                  models={filteredModels}
                  groups={filteredGroups}
                  handleInputChange={handleInputChange}
                  onEnqueue={handleEnqueue}
                  queueSummary={queueSummary}
                />
              ) : (
                <NoVideoAccessPanel t={t} />
              )}
            </div>
          </section>

          <CreationGalleryPanel
            mediaType='video'
            variant='single'
            title={t('我的作品')}
            caption={t('查看最近生成的视频和队列状态')}
            style={singleGalleryStyle}
            actions={
              <BatchResultsActions
                disabled={singleAllResultItems.length === 0}
                selectionMode={selectionMode}
                selectedCount={selectedIds.size}
                onEnterSelection={() => setSelectionMode(true)}
                onExitSelection={() => setSelectionMode(false)}
                onSelectVisible={selectAllVisible}
                onDownloadSelected={() => downloadWorkItems(selectedWorkItems)}
                onRetrySelected={() => retryWorkItems(selectedWorkItems)}
                onCancelSelected={() => cancelWorkItems(selectedWorkItems)}
                onDeleteSelected={deleteSelectedWorks}
                onDownloadAll={() => downloadWorkItems(singleAllResultItems)}
                onRetryFailed={() => retryWorkItems(singleAllResultItems)}
                onCancelActive={() => cancelWorkItems(singleAllResultItems)}
                onClearSettled={clearCompletedStoppedWorks}
                onDeleteFailed={deleteFailedWorks}
                onDeleteAll={() =>
                  deleteWorkIds(singleAllResultItems.map((item) => item.id))
                }
                activeCount={activeWorkCount}
                activeSelectedCount={activeSelectedWorkCount}
                downloadableSelectedCount={downloadableSelectedWorkCount}
                retryableSelectedCount={retryableSelectedWorkCount}
                retryableCount={retryableWorkCount}
                settledCount={settledWorkCount}
                failedCount={failedWorkCount}
                t={t}
              />
            }
            gridRef={worksGridRef}
            isEmpty={singleResultItems.length === 0}
            emptyState={
              <CreationGalleryEmptyState icon={<Video size={22} />}>
                <span>{t('还没有作品，先生成一段视频吧')}</span>
              </CreationGalleryEmptyState>
            }
            pagination={
              singleAllResultItems.length > 0
                ? {
                    total: singleAllResultItems.length,
                    pageSize: worksPageSize,
                    currentPage: worksPage,
                    onPageChange: setWorksPage,
                    t,
                  }
                : null
            }
          >
            {singleResultItems.map((item) => (
              <CreationWorkCard
                key={item.id}
                mediaType='video'
                item={item}
                selected={selectedIds.has(item.id)}
                selectionMode={selectionMode}
                onToggleSelect={toggleSelection}
                onOpen={setPreview}
                onDelete={deleteTask}
                onCancel={cancelTask}
                onRetry={retryTask}
                onShowError={setErrorTask}
                t={t}
              />
            ))}
          </CreationGalleryPanel>
        </div>
      ) : (
        <div className='ai-creation-video-batch-pane mt-4'>
          {hasAnyVideoModel ? (
            <VideoBatchTab
              inputs={inputs}
              models={filteredModels}
              groups={filteredGroups}
              handleInputChange={handleInputChange}
              tasks={tasks}
              onEnqueue={handleEnqueue}
              onDeleteTasks={deleteVideoTasks}
              onCancelTasks={cancelVideoTasks}
              onRetryTask={retryTask}
              onShowError={setErrorTask}
              onPreview={setPreview}
            />
          ) : (
            <NoVideoAccessPanel t={t} />
          )}
        </div>
      )}

      <VideoQueueDock
        tasks={tasks}
        summary={queueSummary}
        open={queuePanelOpen}
        onToggle={() => setQueuePanelOpen((visible) => !visible)}
        onRetry={retryTask}
        onDelete={deleteTask}
        onCancel={cancelTask}
        onCancelActive={confirmCancelActiveTasks}
        onClearFinished={clearFinishedTasks}
        t={t}
      />
      {preview && (
        <PreviewLightbox
          preview={preview}
          onClose={() => setPreview(null)}
          t={t}
        />
      )}
      {errorTask && (
        <ErrorDetailModal
          task={errorTask}
          onClose={() => setErrorTask(null)}
          onRetry={(task) => {
            retryTask(task);
            setErrorTask(null);
          }}
          t={t}
        />
      )}
    </div>
  );
}

function VideoQueueDock({
  tasks,
  summary,
  open,
  onToggle,
  onRetry,
  onDelete,
  onCancel,
  onCancelActive,
  onClearFinished,
  t,
}) {
  if (summary.total === 0) return null;
  const recentTasks = tasks.slice(0, 12);
  return (
    <div className='ai-creation-queue-dock fixed bottom-4 left-1/2 z-40 w-[calc(100%-24px)] max-w-[820px] -translate-x-1/2'>
      {open && (
        <div
          className='ai-creation-queue-panel mb-2 overflow-hidden rounded-[12px] border'
          style={{ background: 'var(--semi-color-bg-2, #ffffff)' }}
        >
          <div className='flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3'>
            <div>
              <h3 className='text-sm font-medium text-neutral-950'>
                {t('视频任务队列')}
              </h3>
              <p className='mt-0.5 text-xs text-neutral-500'>
                {t('生成在后台进行，您可以继续提交新批次')}
              </p>
            </div>
            <div className='ai-creation-queue-header-actions'>
              {summary.active > 0 && (
                <button
                  type='button'
                  className='ai-creation-queue-text-action ai-creation-queue-text-action--danger'
                  onClick={onCancelActive}
                >
                  {t('停止全部')}
                </button>
              )}
              <button
                type='button'
                className='ai-creation-queue-text-action'
                disabled={
                  summary.success + summary.error + summary.cancelled === 0
                }
                onClick={onClearFinished}
              >
                {t('清除完成/失败')}
              </button>
            </div>
          </div>
          <div className='max-h-[360px] overflow-auto p-2'>
            {recentTasks.map((task) => (
              <div
                key={task.id}
                className='ai-creation-queue-row mb-2 flex items-center gap-3 rounded-[8px] px-3 py-2.5 last:mb-0'
              >
                <div className='grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[8px] bg-white text-neutral-500'>
                  {task.url || task.remoteUrl ? (
                    <CachedQueueVideoThumb task={task} />
                  ) : task.status === TASK_STATUS.GENERATING ? (
                    <Loader2 size={17} className='animate-spin' />
                  ) : (
                    <Video size={17} />
                  )}
                </div>
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-2'>
                    <span className='shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] text-neutral-600'>
                      {statusText(task, t)}
                    </span>
                    <span className='truncate text-sm text-neutral-900'>
                      {compactPrompt(task.prompt) || t('未命名任务')}
                    </span>
                  </div>
                  <p className='mt-1 truncate text-xs text-neutral-500'>
                    {task.ratio} · {task.duration}
                    {task.referenceCount
                      ? ` · ${t('{{count}} 张参考图', {
                          count: task.referenceCount,
                        })}`
                      : ''}
                    {task.error ? ` · ${task.error}` : ''}
                  </p>
                </div>
                {(task.status === TASK_STATUS.ERROR ||
                  isCreationTaskCancelled(task)) && (
                  <button
                    type='button'
                    className='grid h-8 w-8 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-white hover:text-neutral-950'
                    title={t('重试')}
                    onClick={() => onRetry(task)}
                  >
                    <RotateCcw size={15} />
                  </button>
                )}
                {isCreationTaskActive(task) ? (
                  <CreationTaskActionButton
                    action='stop'
                    title={t('停止')}
                    onClick={() => onCancel?.(task.id)}
                  />
                ) : (
                  <CreationTaskActionButton
                    action='delete'
                    title={t('删除')}
                    onClick={() => onDelete(task.id)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <button
        type='button'
        onClick={onToggle}
        className='ai-creation-queue-toggle flex w-full items-center justify-between gap-3 rounded-[12px] border px-4 py-3 text-left transition'
        style={{ background: 'var(--semi-color-bg-2, #ffffff)' }}
      >
        <span className='flex min-w-0 items-center gap-3'>
          <span className='grid h-9 w-9 place-items-center rounded-full bg-neutral-950 text-white'>
            {summary.running > 0 ? (
              <Loader2 size={17} className='animate-spin' />
            ) : (
              <Video size={17} />
            )}
          </span>
          <span className='min-w-0'>
            <span className='block text-sm font-medium text-neutral-950'>
              {t('视频生成队列')}
            </span>
            <span className='block truncate text-xs text-neutral-500'>
              {t('{{count}} 个生成中', { count: summary.running })} ·{' '}
              {t('{{count}} 个已完成', { count: summary.success })} ·{' '}
              {t('{{count}} 个失败', { count: summary.error })} ·{' '}
              {t('已停止 {{count}} 个', {
                count: summary.cancelled,
              })}
            </span>
          </span>
        </span>
        <ChevronDown
          size={18}
          className={clsx(
            'shrink-0 text-neutral-500 transition',
            open && 'rotate-180',
          )}
        />
      </button>
    </div>
  );
}

function CachedQueueVideoThumb({ task }) {
  const displayUrl = useCachedVideoDisplayUrl(task);
  return displayUrl ? (
    <video
      src={displayUrl}
      className='h-full w-full object-cover'
      muted
      playsInline
      preload='metadata'
    />
  ) : (
    <Video size={17} />
  );
}

const formatErrorDump = (task) => {
  const lines = [];
  if (task.error) lines.push(`Error: ${task.error}`);
  if (task.errorDetail?.status)
    lines.push(`HTTP Status: ${task.errorDetail.status}`);
  if (task.errorDetail?.body) {
    try {
      lines.push(
        `Response Body:\n${JSON.stringify(task.errorDetail.body, null, 2)}`,
      );
    } catch {
      lines.push(`Response Body: ${String(task.errorDetail.body)}`);
    }
  }
  if (task.model) lines.push(`Model: ${task.model}`);
  if (task.group) lines.push(`Group: ${task.group}`);
  if (task.prompt) lines.push(`Prompt: ${task.prompt}`);
  if (task.ratio) lines.push(`Ratio: ${task.ratio}`);
  if (task.duration) lines.push(`Duration: ${task.duration}`);
  if (task.resolution) lines.push(`Resolution: ${task.resolution}`);
  if (task.referenceCount)
    lines.push(`Reference images: ${task.referenceCount}`);
  return lines.join('\n');
};

function ErrorDetailModal({ task, onClose, onRetry, t }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dump = useMemo(() => formatErrorDump(task), [task]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(dump);
      Toast.success(t('已复制错误详情'));
    } catch {
      Toast.error(t('复制失败'));
    }
  };

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4'
      onMouseDown={onClose}
    >
      <div
        className='ai-creation-error-modal relative w-full max-w-[640px] overflow-hidden rounded-[16px]'
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className='flex items-center justify-between gap-3 border-b px-5 py-4'>
          <div className='flex min-w-0 items-center gap-2'>
            <AlertCircle size={18} className='shrink-0 text-red-500' />
            <h3 className='text-base font-medium'>{t('生成失败')}</h3>
          </div>
          <button
            type='button'
            onClick={onClose}
            className='grid h-8 w-8 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900'
          >
            <X size={16} />
          </button>
        </header>
        <div className='px-5 py-4'>
          <p className='mb-3 text-sm text-neutral-600'>
            {t('请将以下信息反馈给开发者：')}
          </p>
          <pre className='ai-creation-error-dump max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-[10px] p-3 text-xs leading-relaxed'>
            {dump || t('（无详细信息）')}
          </pre>
        </div>
        <footer className='flex items-center justify-end gap-2 border-t px-5 py-3'>
          <button
            type='button'
            onClick={handleCopy}
            className='inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm text-neutral-700 transition hover:bg-neutral-100'
          >
            <Copy size={14} />
            {t('复制详情')}
          </button>
          {onRetry && (
            <button
              type='button'
              onClick={() => onRetry(task)}
              className='inline-flex h-9 items-center gap-1.5 rounded-full bg-neutral-950 px-4 text-sm text-white transition hover:bg-neutral-800'
            >
              <RotateCcw size={14} />
              {t('重试')}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function NoVideoAccessPanel({ t }) {
  return (
    <div className='flex flex-col items-center justify-center gap-3 rounded-[24px] border border-dashed border-neutral-200 bg-white px-6 py-16 text-center'>
      <div className='grid h-14 w-14 place-items-center rounded-full bg-neutral-100 text-neutral-400'>
        <Video size={26} />
      </div>
      <h3 className='text-[17px] font-medium text-neutral-900'>
        {t('当前账号没有可用的视频生成模型')}
      </h3>
      <p className='max-w-md text-sm text-neutral-500'>
        {t(
          '请联系管理员为你所在的分组开通 grok-imagine-video 等视频模型，然后刷新页面重试。',
        )}
      </p>
    </div>
  );
}

function compactPrompt(prompt) {
  const text = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > 28 ? `${text.slice(0, 28)}...` : text;
}

function PreviewLightbox({ preview, onClose, t }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className='ai-creation-lightbox fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4'
      onMouseDown={onClose}
    >
      <div
        className='ai-creation-lightbox__stage relative max-h-[92vh] max-w-[92vw]'
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type='button'
          onClick={onClose}
          className='ai-creation-lightbox__close absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full bg-white/90 text-neutral-900 shadow-sm transition hover:bg-white'
          title={t('关闭')}
        >
          <X size={18} />
        </button>
        {preview.type === 'image' ? (
          <img
            src={preview.url}
            alt={preview.title || ''}
            className='ai-creation-lightbox__media max-h-[92vh] max-w-[92vw] rounded-[12px] object-contain shadow-2xl'
          />
        ) : (
          <video
            src={preview.url}
            className='ai-creation-lightbox__media max-h-[92vh] max-w-[92vw] rounded-[12px] object-contain shadow-2xl'
            controls
            autoPlay
            playsInline
          />
        )}
      </div>
    </div>
  );
}

function statusText(task, t) {
  return getCreationTaskStatusLabel(task, t);
}
