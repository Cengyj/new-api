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
  FileImage,
  Image,
  Loader2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { UserContext } from '../../context/User';
import { useDataLoader } from '../../hooks/playground/useDataLoader';
import { usePlaygroundState } from '../../hooks/playground/usePlaygroundState';
import { useScenePreference } from '../../hooks/useScenePreference';
import { IMAGE_MODEL_WHITELIST, TASK_STATUS } from './constants.js';
import {
  IMAGE_PROMPT_LIBRARY_ITEMS,
  PROMPT_LIBRARY_CATEGORIES,
} from './promptLibrary/zhCNPromptLibrary.js';
import {
  isImageBatchGeneratedTask,
  summarizeImageBatchTasks,
} from './imageBatchQueue.js';
import { loadBatchRows } from './imageBatchTable.js';
import {
  clearSettledImageTasks,
  cancelActiveImageTasks,
  cancelImageTask,
  cancelImageTasks,
  deleteImageTask,
  deleteImageTasks,
  enqueueImageTasks,
  retryImageTask,
  subscribeImageTasks,
} from './imageCreationController.js';
import {
  ensureCachedImageUrl,
  isDataImageUrl,
  isSessionBlobUrl,
} from './imageCache.js';
import {
  CreationTaskActionButton,
  clampCreationNumber as clampNumber,
  getCreationPageCount as getPageCount,
  useResponsiveGridPageSize,
} from './AiCreationShared.jsx';
import { BatchResultsActions } from './BatchExcelShared.jsx';
import {
  CreationGalleryPanel,
  getCreationGalleryStyle,
} from './CreationGallery.jsx';
import {
  CreationWorkCard,
  CreationWorksEmptyState,
  downloadCreationWorkAsset,
  getCreationWorkSourceUrl,
} from './CreationWorkCard.jsx';
import PromptInspirationLibrary, {
  getChinesePromptItems,
} from './PromptInspirationLibrary.jsx';
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
import ImageSingleTab from './ImageSingleTab.jsx';
import ImageBatchTab from './ImageBatchTab.jsx';
import './imageBatchExcel.css';
import './styles.css';

const ACTIVE_TAB_STORAGE_KEY = 'ai_creation_image_active_tab';
const SINGLE_GALLERY_TAB_STORAGE_KEY = 'ai_creation_image_single_gallery_tab';

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

const loadSingleGalleryTab = () => {
  if (typeof window === 'undefined') return 'inspiration';
  try {
    const value = window.localStorage.getItem(SINGLE_GALLERY_TAB_STORAGE_KEY);
    return value === 'works' ? 'works' : 'inspiration';
  } catch {
    return 'inspiration';
  }
};

const persistSingleGalleryTab = (value) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SINGLE_GALLERY_TAB_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
};

export default function ImageGenerationTab() {
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
        whitelist: IMAGE_MODEL_WHITELIST,
      }),
    [groups, pricedModels, groupModels],
  );

  const filteredGroups = useMemo(
    () => (groups || []).filter((g) => allowedGroupSet.has(g.value)),
    [groups, allowedGroupSet],
  );

  const effectiveImageGroup = allowedGroupSet.has(inputs.group)
    ? inputs.group
    : filteredGroups[0]?.value || inputs.group;

  const effectiveInputs = useMemo(
    () =>
      effectiveImageGroup === inputs.group
        ? inputs
        : { ...inputs, group: effectiveImageGroup },
    [effectiveImageGroup, inputs],
  );

  const allowedImageModelSet = useMemo(
    () =>
      getAllowedCreationModels({
        models: pricedModels,
        groupModels,
        whitelist: IMAGE_MODEL_WHITELIST,
        selectedGroup: effectiveImageGroup,
        allowedGroupSet,
      }),
    [pricedModels, groupModels, effectiveImageGroup, allowedGroupSet],
  );

  const filteredModels = useMemo(
    () =>
      (pricedModels || []).filter((option) =>
        allowedImageModelSet.has(option.value),
      ),
    [pricedModels, allowedImageModelSet],
  );

  const hasAnyImageModel = allowedGroupSet.size > 0;

  const { hydrated } = useScenePreference({
    scene: 'image',
    inputs,
    handleInputChange,
    allowedModelSet: allowedImageModelSet,
    allowedGroupSet,
    groupModels,
    ready: hasAnyImageModel,
  });

  useEffect(() => {
    if (!hasAnyImageModel) return;
    if (!allowedGroupSet.has(inputs.group) && effectiveImageGroup) {
      handleInputChange('group', effectiveImageGroup);
    }
  }, [
    hasAnyImageModel,
    allowedGroupSet,
    inputs.group,
    effectiveImageGroup,
    handleInputChange,
  ]);

  useEffect(() => {
    if (!hasAnyImageModel) return;
    if (!hydrated) return;
    if (filteredModels.length === 0) return;
    if (!allowedImageModelSet.has(effectiveInputs.model)) {
      handleInputChange('model', filteredModels[0].value);
    }
  }, [
    hasAnyImageModel,
    hydrated,
    allowedImageModelSet,
    effectiveInputs.model,
    filteredModels,
    handleInputChange,
  ]);

  const [tasks, setTasks] = useState([]);
  const [preview, setPreview] = useState(null);
  const [errorTask, setErrorTask] = useState(null);
  const [queuePanelOpen, setQueuePanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(loadActiveTab);
  const [singleGalleryTab, setSingleGalleryTab] =
    useState(loadSingleGalleryTab);
  const [inspirationCategory, setInspirationCategory] = useState('all');
  const [inspirationPage, setInspirationPage] = useState(1);
  const [worksPage, setWorksPage] = useState(1);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [promptPreset, setPromptPreset] = useState(null);
  const inspirationItems = useMemo(
    () => getChinesePromptItems(IMAGE_PROMPT_LIBRARY_ITEMS),
    [],
  );
  const filteredInspirationItems = useMemo(
    () =>
      inspirationCategory === 'all'
        ? inspirationItems
        : inspirationItems.filter(
            (item) => item.category === inspirationCategory,
          ),
    [inspirationCategory, inspirationItems],
  );
  const [inspirationGridRef, inspirationPageSize] = useResponsiveGridPageSize({
    minCardWidth: 224,
    cardAspect: 4 / 5,
    gap: 14,
    minRows: 1,
    maxRows: 1,
    maxColumns: 5,
    fallback: 5,
    watchKey: `${activeTab}:${singleGalleryTab}`,
  });
  const [worksGridRef, worksPageSize] = useResponsiveGridPageSize({
    minCardWidth: 204,
    cardAspect: 1,
    cardChrome: 44,
    gap: 14,
    minRows: 1,
    maxRows: 3,
    fallback: 6,
    watchKey: `${activeTab}:${singleGalleryTab}`,
  });

  const queueSummary = useMemo(() => summarizeImageBatchTasks(tasks), [tasks]);
  const batchTaskIdSet = useMemo(() => {
    const ids = new Set();
    loadBatchRows().forEach((row) => {
      (row.taskIds || []).forEach((id) => ids.add(id));
    });
    return ids;
  }, [tasks]);

  useEffect(() => subscribeImageTasks(setTasks), []);

  useEffect(() => {
    persistActiveTab(activeTab);
  }, [activeTab]);

  useEffect(() => {
    persistSingleGalleryTab(singleGalleryTab);
  }, [singleGalleryTab]);

  useEffect(() => {
    if (!selectionMode) setSelectedIds(new Set());
  }, [selectionMode]);

  const handleEnqueue = useCallback((queuedTasks, concurrency) => {
    if (!queuedTasks?.length) return;
    enqueueImageTasks(queuedTasks, concurrency);
    setQueuePanelOpen(true);
  }, []);

  const retryTask = useCallback((task) => {
    retryImageTask(task);
    setQueuePanelOpen(true);
  }, []);

  const deleteTask = useCallback((taskId) => {
    deleteImageTask(taskId);
    setPreview((current) => (current?.id === taskId ? null : current));
    setSelectedIds((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const cancelTask = useCallback((taskId) => {
    cancelImageTask(taskId);
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
      onOk: () => cancelActiveImageTasks(),
    });
  }, [queueSummary.active, t]);

  const clearFinishedTasks = useCallback(() => {
    clearSettledImageTasks();
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
          item.kind !== 'video' &&
          (item.status !== TASK_STATUS.ERROR || item.prompt) &&
          !isImageBatchGeneratedTask(item, batchTaskIdSet),
      ),
    [batchTaskIdSet, tasks],
  );

  const inspirationPageCount = getPageCount(
    filteredInspirationItems.length,
    inspirationPageSize,
  );
  const worksPageCount = getPageCount(
    singleAllResultItems.length,
    worksPageSize,
  );

  useEffect(() => {
    setInspirationPage((page) => clampNumber(page, 1, inspirationPageCount));
  }, [inspirationPageCount]);

  useEffect(() => {
    setInspirationPage(1);
  }, [inspirationCategory]);

  useEffect(() => {
    setWorksPage((page) => clampNumber(page, 1, worksPageCount));
  }, [worksPageCount]);

  const pagedSuggestions = useMemo(
    () =>
      filteredInspirationItems.slice(
        (inspirationPage - 1) * inspirationPageSize,
        inspirationPage * inspirationPageSize,
      ),
    [filteredInspirationItems, inspirationPage, inspirationPageSize],
  );

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
    () =>
      getCreationGalleryStyle('image', {
        minCardWidth: 204,
        mediaRatio: '1 / 1',
      }),
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
      Boolean(getCreationWorkSourceUrl(item, 'image')),
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
    deleteImageTasks(taskIds);
    setPreview((current) =>
      current?.id && idSet.has(current.id) ? null : current,
    );
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
        await downloadCreationWorkAsset(item, 'image');
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
    cancelImageTasks(activeIds);
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
    <div className='ai-creation-page ai-creation-page--image w-full px-6 pb-36 pt-8 sm:px-10 lg:px-14'>
      <div className='ai-creation-page-header mb-5 flex flex-wrap items-end justify-between gap-3'>
        <div className='min-w-0'>
          <h1 className='ai-creation-page-title text-[26px] font-medium'>
            {t('图片创作')}
          </h1>
          <p className='ai-creation-page-subtitle'>
            {t('用提示词、参考图和参数快速生成视觉资产')}
          </p>
        </div>
        <span className='ai-creation-route-chip'>/ai-creation/image</span>
      </div>

      <div className='ai-creation-top-nav'>
        <div
          className='ai-creation-mode-tabs ai-creation-image-tabs'
          role='tablist'
        >
          {[
            { key: 'single', label: t('单张生成') },
            { key: 'batch', label: t('批量生成') },
          ].map((item) => (
            <button
              key={item.key}
              type='button'
              role='tab'
              aria-selected={activeTab === item.key}
              className={clsx(
                'ai-creation-mode-tab',
                activeTab === item.key && 'is-active',
              )}
              onClick={() => setActiveTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'single' ? (
        <div className='ai-creation-single-pane mt-4'>
          <div className='ai-creation-composer-wrap mx-auto max-w-[1100px]'>
            {hasAnyImageModel ? (
              <ImageSingleTab
                inputs={effectiveInputs}
                models={filteredModels}
                groups={filteredGroups}
                handleInputChange={handleInputChange}
                onEnqueue={handleEnqueue}
                queueSummary={queueSummary}
                promptPreset={promptPreset}
              />
            ) : (
              <NoImageAccessPanel t={t} />
            )}
          </div>

          <section className='ai-creation-section ai-creation-single-resource mt-8'>
            <div className='ai-creation-single-resource__header'>
              <div className='ai-creation-single-gallery-tabs' role='tablist'>
                {[
                  { key: 'inspiration', label: t('创作灵感') },
                  { key: 'works', label: t('我的作品') },
                ].map((item) => (
                  <button
                    key={item.key}
                    type='button'
                    role='tab'
                    aria-selected={singleGalleryTab === item.key}
                    className={clsx(
                      'ai-creation-single-gallery-tab',
                      singleGalleryTab === item.key && 'is-active',
                    )}
                    onClick={() => setSingleGalleryTab(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className='ai-creation-single-resource__body'>
              {singleGalleryTab === 'inspiration' ? (
                <PromptInspirationLibrary
                  items={inspirationItems}
                  visibleItems={pagedSuggestions}
                  categories={PROMPT_LIBRARY_CATEGORIES}
                  activeCategory={inspirationCategory}
                  onCategoryChange={setInspirationCategory}
                  gridRef={inspirationGridRef}
                  onApplyPrompt={(item) =>
                    setPromptPreset({
                      prompt: item.prompt,
                      nonce: Date.now(),
                    })
                  }
                  onPreviewImage={(item) =>
                    setPreview({
                      id: item.id,
                      url: item.image,
                      title: item.title,
                    })
                  }
                  pagination={{
                    total: filteredInspirationItems.length,
                    pageSize: inspirationPageSize,
                    currentPage: inspirationPage,
                    onPageChange: setInspirationPage,
                  }}
                  t={t}
                />
              ) : (
                <CreationGalleryPanel
                  mediaType='image'
                  variant='single'
                  style={singleGalleryStyle}
                  actions={
                    <BatchResultsActions
                      disabled={singleAllResultItems.length === 0}
                      selectionMode={selectionMode}
                      selectedCount={selectedIds.size}
                      onEnterSelection={() => setSelectionMode(true)}
                      onExitSelection={() => setSelectionMode(false)}
                      onSelectVisible={selectAllVisible}
                      onDownloadSelected={() =>
                        downloadWorkItems(selectedWorkItems)
                      }
                      onRetrySelected={() => retryWorkItems(selectedWorkItems)}
                      onCancelSelected={() =>
                        cancelWorkItems(selectedWorkItems)
                      }
                      onDeleteSelected={deleteSelectedWorks}
                      onDownloadAll={() =>
                        downloadWorkItems(singleAllResultItems)
                      }
                      onRetryFailed={() => retryWorkItems(singleAllResultItems)}
                      onCancelActive={() =>
                        cancelWorkItems(singleAllResultItems)
                      }
                      onClearSettled={clearCompletedStoppedWorks}
                      onDeleteFailed={deleteFailedWorks}
                      onDeleteAll={() =>
                        deleteWorkIds(
                          singleAllResultItems.map((item) => item.id),
                        )
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
                    <CreationWorksEmptyState icon={<FileImage size={28} />}>
                      <p className='mt-2 text-sm'>
                        {t('还没有作品，先生成一张图片吧')}
                      </p>
                    </CreationWorksEmptyState>
                  }
                  title={t('我的作品')}
                  caption={t('查看最近生成的图片和队列状态')}
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
                      mediaType='image'
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
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className='ai-creation-batch-pane ai-creation-image-batch-pane mt-4'>
          {hasAnyImageModel ? (
            <ImageBatchTab
              inputs={effectiveInputs}
              models={filteredModels}
              groups={filteredGroups}
              handleInputChange={handleInputChange}
              tasks={tasks}
              onEnqueue={handleEnqueue}
              onDeleteTasks={deleteImageTasks}
              onCancelTasks={cancelImageTasks}
              onRetryTask={retryTask}
              onShowError={setErrorTask}
              onPreview={setPreview}
            />
          ) : (
            <NoImageAccessPanel t={t} />
          )}
        </div>
      )}

      <ImageQueueDock
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

function ImageQueueDock({
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
                {t('图片任务队列')}
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
                <QueueTaskThumbnail task={task} />
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
                    {task.ratio} · {task.quality}
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
              <Image size={17} />
            )}
          </span>
          <span className='min-w-0'>
            <span className='block text-sm font-medium text-neutral-950'>
              {t('批量生成队列')}
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

function QueueTaskThumbnail({ task }) {
  const sourceUrl = getTaskImageSourceUrl(task);
  const [displayUrl, setDisplayUrl] = useState(
    isDataImageUrl(sourceUrl) ? sourceUrl : '',
  );

  useEffect(() => {
    if (task.status !== TASK_STATUS.SUCCESS) {
      setDisplayUrl('');
      return;
    }

    if (isDataImageUrl(sourceUrl)) {
      setDisplayUrl(sourceUrl);
      return;
    }

    let cancelled = false;
    ensureCachedImageUrl(task.id, sourceUrl)
      .then((blobUrl) => {
        if (cancelled) return;
        setDisplayUrl(blobUrl || '');
      })
      .catch(() => {
        if (!cancelled) setDisplayUrl('');
      });

    return () => {
      cancelled = true;
    };
  }, [task.id, task.status, sourceUrl]);

  return (
    <div className='grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[8px] bg-white text-neutral-500'>
      {displayUrl ? (
        <img
          src={displayUrl}
          alt=''
          className='h-full w-full object-cover'
          loading='lazy'
        />
      ) : task.status === TASK_STATUS.LOADING ? (
        <Loader2 size={17} className='animate-spin' />
      ) : (
        <FileImage size={17} />
      )}
    </div>
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
  if (task.quality) lines.push(`Quality: ${task.quality}`);
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

const getTaskImageSourceUrl = (item = {}) => {
  const url = typeof item.url === 'string' ? item.url : '';
  const remoteUrl = typeof item.remoteUrl === 'string' ? item.remoteUrl : '';
  if (isSessionBlobUrl(url)) {
    return isSessionBlobUrl(remoteUrl) ? '' : remoteUrl;
  }
  return url || (isSessionBlobUrl(remoteUrl) ? '' : remoteUrl);
};

function NoImageAccessPanel({ t }) {
  return (
    <div className='flex flex-col items-center justify-center gap-3 rounded-[24px] border border-dashed border-neutral-200 bg-white px-6 py-16 text-center'>
      <div className='grid h-14 w-14 place-items-center rounded-full bg-neutral-100 text-neutral-400'>
        <Image size={26} />
      </div>
      <h3 className='text-[17px] font-medium text-neutral-900'>
        {t('当前账号没有可用的图片生成模型')}
      </h3>
      <p className='max-w-md text-sm text-neutral-500'>
        {t(
          '请联系管理员为你所在的分组开通 gpt-image-2 或 grok-imagine-image 等图片模型，然后刷新页面重试。',
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

const LIGHTBOX_MIN_ZOOM = 0.25;
const LIGHTBOX_MAX_ZOOM = 5;
const LIGHTBOX_WHEEL_FACTOR = 1.12;
const LIGHTBOX_FIT_PADDING = 24;
const LIGHTBOX_EMPTY_PAN = { x: 0, y: 0 };

const clampLightboxZoom = (value) =>
  Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, Number(value) || 1));

const clampLightboxPan = (pan, zoom, naturalSize, viewportSize) => {
  if (!naturalSize || !viewportSize.width || !viewportSize.height) {
    return LIGHTBOX_EMPTY_PAN;
  }
  const scaledWidth = naturalSize.width * zoom;
  const scaledHeight = naturalSize.height * zoom;
  const maxX = Math.max(0, (scaledWidth - viewportSize.width) / 2);
  const maxY = Math.max(0, (scaledHeight - viewportSize.height) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x || 0)),
    y: Math.min(maxY, Math.max(-maxY, pan.y || 0)),
  };
};

function PreviewLightbox({ preview, onClose, t }) {
  const viewportRef = useRef(null);
  const zoomRef = useRef(1);
  const panRef = useRef(LIGHTBOX_EMPTY_PAN);
  const panStateRef = useRef(null);
  const [naturalSize, setNaturalSize] = useState(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState('fit');
  const [pan, setPan] = useState(LIGHTBOX_EMPTY_PAN);
  const [isPanning, setIsPanning] = useState(false);

  const fitZoom = useMemo(() => {
    if (!naturalSize || !viewportSize.width || !viewportSize.height) return 1;
    const availableWidth = Math.max(
      1,
      viewportSize.width - LIGHTBOX_FIT_PADDING,
    );
    const availableHeight = Math.max(
      1,
      viewportSize.height - LIGHTBOX_FIT_PADDING,
    );
    return clampLightboxZoom(
      Math.min(
        1,
        availableWidth / naturalSize.width,
        availableHeight / naturalSize.height,
      ),
    );
  }, [naturalSize, viewportSize.height, viewportSize.width]);

  const scaledWidth = naturalSize
    ? Math.max(1, Math.round(naturalSize.width * zoom))
    : 0;
  const scaledHeight = naturalSize
    ? Math.max(1, Math.round(naturalSize.height * zoom))
    : 0;
  const canPan = Boolean(
    naturalSize &&
    (scaledWidth > viewportSize.width || scaledHeight > viewportSize.height),
  );
  const zoomPercent = `${Math.round(zoom * 100)}%`;

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    setNaturalSize(null);
    setZoom(1);
    setZoomMode('fit');
    setPan(LIGHTBOX_EMPTY_PAN);
    setIsPanning(false);
    panStateRef.current = null;
  }, [preview?.url]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const measure = () => {
      setViewportSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });
    };

    measure();
    let observer;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(viewport);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(
    () => () => {
      if (preview?.revokeOnClose && preview.url?.startsWith('blob:')) {
        URL.revokeObjectURL(preview.url);
      }
    },
    [preview],
  );

  useEffect(() => {
    if (zoomMode !== 'fit') return;
    zoomRef.current = fitZoom;
    setZoom(fitZoom);
    setPan(LIGHTBOX_EMPTY_PAN);
  }, [fitZoom, zoomMode]);

  useEffect(() => {
    setPan((current) => {
      const nextPan = clampLightboxPan(
        current,
        zoom,
        naturalSize,
        viewportSize,
      );
      if (nextPan.x === current.x && nextPan.y === current.y) return current;
      return nextPan;
    });
  }, [naturalSize, viewportSize, zoom]);

  const zoomTo = useCallback(
    (nextZoom, nextMode = 'custom', resetPan = false) => {
      const targetZoom = clampLightboxZoom(nextZoom);
      setZoomMode(nextMode);
      zoomRef.current = targetZoom;
      setZoom(targetZoom);
      setPan((current) =>
        resetPan
          ? LIGHTBOX_EMPTY_PAN
          : clampLightboxPan(current, targetZoom, naturalSize, viewportSize),
      );
    },
    [naturalSize, viewportSize],
  );

  const panTo = useCallback(
    (nextPan) => {
      setPan(
        clampLightboxPan(nextPan, zoomRef.current, naturalSize, viewportSize),
      );
    },
    [naturalSize, viewportSize],
  );

  const handleZoomOut = useCallback(() => {
    zoomTo(zoomRef.current / 1.25);
  }, [zoomTo]);

  const handleZoomIn = useCallback(() => {
    zoomTo(zoomRef.current * 1.25);
  }, [zoomTo]);

  const handleResetFit = useCallback(() => {
    zoomTo(fitZoom, 'fit', true);
  }, [fitZoom, zoomTo]);

  const handleActualSize = useCallback(() => {
    zoomTo(1, 'actual', true);
  }, [zoomTo]);

  const handleWheel = useCallback(
    (event) => {
      if (!naturalSize) return;
      event.preventDefault();
      event.stopPropagation();
      const factor =
        event.deltaY < 0 ? LIGHTBOX_WHEEL_FACTOR : 1 / LIGHTBOX_WHEEL_FACTOR;
      zoomTo(zoomRef.current * factor);
    },
    [naturalSize, zoomTo],
  );

  const handleImageLoad = useCallback((event) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (naturalWidth > 0 && naturalHeight > 0) {
      setNaturalSize({ width: naturalWidth, height: naturalHeight });
      setZoomMode('fit');
    }
  }, []);

  const handleImageMouseDown = useCallback(
    (event) => {
      event.stopPropagation();
      if (!canPan || event.button !== 0) return;
      const viewport = viewportRef.current;
      if (!viewport) return;
      event.preventDefault();
      panStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        startPan: panRef.current,
      };
      setIsPanning(true);
    },
    [canPan],
  );

  const handleImageDoubleClick = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (zoomMode === 'actual' || Math.abs(zoomRef.current - 1) < 0.01) {
        zoomTo(fitZoom, 'fit', true);
      } else {
        zoomTo(1, 'actual', true);
      }
    },
    [fitZoom, zoomMode, zoomTo],
  );

  useEffect(() => {
    if (!isPanning) return undefined;

    const handleMouseMove = (event) => {
      const viewport = viewportRef.current;
      const state = panStateRef.current;
      if (!viewport || !state) return;
      event.preventDefault();
      panTo({
        x: state.startPan.x + event.clientX - state.startX,
        y: state.startPan.y + event.clientY - state.startY,
      });
    };
    const handleMouseUp = () => {
      panStateRef.current = null;
      setIsPanning(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning]);

  const stopPreviewClose = (event) => event.stopPropagation();
  const imageStyle = naturalSize
    ? {
        width: `${naturalSize.width}px`,
        height: `${naturalSize.height}px`,
        transform: `scale(${zoom})`,
      }
    : undefined;
  const surfaceStyle = naturalSize
    ? {
        width: `${naturalSize.width}px`,
        height: `${naturalSize.height}px`,
        transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
      }
    : undefined;

  return (
    <div
      className='ai-creation-lightbox ai-creation-lightbox--image-zoom fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4'
      role='dialog'
      aria-modal='true'
      onClick={onClose}
    >
      <div className='ai-creation-lightbox__stage relative max-h-[92vh] max-w-[92vw]'>
        <div
          className='ai-creation-lightbox__toolbar'
          onMouseDown={stopPreviewClose}
          onClick={stopPreviewClose}
        >
          <button
            type='button'
            className='ai-creation-lightbox__tool'
            title={t('收起')}
            aria-label={t('收起')}
            disabled={!naturalSize || zoom <= LIGHTBOX_MIN_ZOOM + 0.005}
            onClick={handleZoomOut}
          >
            <ZoomOut size={16} />
          </button>
          <span className='ai-creation-lightbox__zoom-label'>
            {zoomPercent}
          </span>
          <button
            type='button'
            className='ai-creation-lightbox__tool'
            title={t('放大')}
            aria-label={t('放大')}
            disabled={!naturalSize || zoom >= LIGHTBOX_MAX_ZOOM - 0.005}
            onClick={handleZoomIn}
          >
            <ZoomIn size={16} />
          </button>
          <button
            type='button'
            className='ai-creation-lightbox__tool'
            title={t('重置')}
            aria-label={t('重置')}
            disabled={!naturalSize}
            onClick={handleResetFit}
          >
            <RotateCcw size={15} />
          </button>
          <button
            type='button'
            className='ai-creation-lightbox__tool ai-creation-lightbox__tool--text'
            title='100%'
            aria-label='100%'
            disabled={!naturalSize}
            onClick={handleActualSize}
          >
            100%
          </button>
          <button
            type='button'
            onClick={onClose}
            className='ai-creation-lightbox__tool ai-creation-lightbox__close'
            title={t('关闭')}
            aria-label={t('关闭')}
          >
            <X size={17} />
          </button>
        </div>
        <div
          ref={viewportRef}
          className={clsx(
            'ai-creation-lightbox__viewport',
            canPan && 'can-pan',
            isPanning && 'is-panning',
          )}
          onWheel={handleWheel}
        >
          <div className='ai-creation-lightbox__surface' style={surfaceStyle}>
            <img
              src={preview.url}
              alt={preview.title || ''}
              className='ai-creation-lightbox__media ai-creation-lightbox__image max-h-[92vh] max-w-[92vw] rounded-[12px] object-contain shadow-2xl'
              style={imageStyle}
              draggable={false}
              onLoad={handleImageLoad}
              onMouseDown={handleImageMouseDown}
              onClick={stopPreviewClose}
              onDoubleClick={handleImageDoubleClick}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function statusText(task, t) {
  return getCreationTaskStatusLabel(task, t);
}
