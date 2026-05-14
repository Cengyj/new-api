import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const featureDir = path.resolve(path.dirname(currentFile), '..');
const srcDir = path.resolve(featureDir, '..', '..');

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const read = (relativePath) =>
  fs.readFileSync(path.join(srcDir, relativePath), 'utf8');

const exists = (relativePath) => fs.existsSync(path.join(srcDir, relativePath));

const oldComponentsDir = path.join(srcDir, 'components/ai-creation');
assert(
  !fs.existsSync(oldComponentsDir) ||
    fs.readdirSync(oldComponentsDir).length === 0,
  'Do not keep a second AI creation UI under web/src/components/ai-creation.',
);

assert(
  !exists('features/ai-creation/index.jsx'),
  'Do not restore AiCreationCenter or a parent tab UI in features/ai-creation/index.jsx.',
);

assert(
  !exists('pages/AiCreation/index.jsx'),
  'Do not restore a parent /pages/AiCreation index page. Use the direct Chat/Image/Video routes.',
);

assert(
  !exists('features/ai-creation/SingleCreationWorks.jsx'),
  'SingleCreationWorks.jsx is retired; single works must use CreationGalleryPanel and CreationWorkCard directly.',
);

const routeFiles = {
  'pages/AiCreation/Chat.jsx': 'features/ai-creation/ChatTab',
  'pages/AiCreation/Image.jsx': 'features/ai-creation/ImageGenerationTab',
  'pages/AiCreation/Video.jsx': 'features/ai-creation/VideoGenerationTab',
};

for (const [routeFile, requiredImport] of Object.entries(routeFiles)) {
  const source = read(routeFile);
  assert(
    source.includes(requiredImport),
    `${routeFile} must import ${requiredImport} directly.`,
  );
  assert(
    !source.includes('components/ai-creation'),
    `${routeFile} must not import the removed components/ai-creation UI.`,
  );
}

const appSource = read('App.jsx');
for (const route of [
  '/console/ai-creation/chat',
  '/console/ai-creation/image',
  '/console/ai-creation/video',
]) {
  assert(appSource.includes(route), `App.jsx must keep route ${route}.`);
}

assert(
  !appSource.includes('pages/AiCreation/index') &&
    !appSource.includes("pages/AiCreation'"),
  'App.jsx must not import a parent AiCreation page.',
);

const imageTabSource = read('features/ai-creation/ImageGenerationTab.jsx');
const videoTabSource = read('features/ai-creation/VideoGenerationTab.jsx');
const imageSingleSource = read('features/ai-creation/ImageSingleTab.jsx');
const videoSingleSource = read('features/ai-creation/VideoSingleTab.jsx');
const imageBatchSource = read('features/ai-creation/ImageBatchTab.jsx');
const videoBatchSource = read('features/ai-creation/VideoBatchTab.jsx');
const chatTabSource = read('features/ai-creation/ChatTab.jsx');
const aiCreationSharedSource = read(
  'features/ai-creation/AiCreationShared.jsx',
);
const creationGallerySource = read('features/ai-creation/CreationGallery.jsx');
const creationWorkCardSource = read(
  'features/ai-creation/CreationWorkCard.jsx',
);
const batchResultGallerySource = read(
  'features/ai-creation/BatchResultGallery.jsx',
);
const batchExcelSharedSource = read(
  'features/ai-creation/BatchExcelShared.jsx',
);
const resultGroupCssSource = read(
  'features/ai-creation/creationResultGroup.css',
);
const resultGroupModalSource = read(
  'features/ai-creation/CreationResultGroupModal.jsx',
);
const resultGroupViewerSource = read(
  'features/ai-creation/CreationResultGroupViewer.jsx',
);
const stylesSource = read('features/ai-creation/styles.css');
const imageBatchExcelCssSource = read(
  'features/ai-creation/imageBatchExcel.css',
);
const constantsSource = read('features/ai-creation/constants.js');
const promptLibrarySource = read(
  'features/ai-creation/promptLibrary/zhCNPromptLibrary.js',
);
const promptLibraryModule = await import(
  pathToFileURL(
    path.join(
      srcDir,
      'features/ai-creation/promptLibrary/zhCNPromptLibrary.js',
    ),
  ).href
);
const imageRegistrySource = read('features/ai-creation/imageModelRegistry.js');
const imageAdaptersSource = read('features/ai-creation/adapters.js');
const imageParamsSource = read('features/ai-creation/imageParams.js');
const videoRegistrySource = read('features/ai-creation/videoModelRegistry.js');
const videoAdaptersSource = read('features/ai-creation/videoAdapters.js');
const videoParamsSource = read('features/ai-creation/videoParams.js');
for (const required of [
  'ai-creation-page--image',
  'ai-creation-route-chip',
  'ImageSingleTab',
  'ImageBatchTab',
  'useScenePreference',
  'IMAGE_MODEL_WHITELIST',
  'subscribeImageTasks',
  'ImageQueueDock',
  'CreationGalleryPanel',
  'CreationWorkCard',
  'BatchResultsActions',
  'function PreviewLightbox',
  'function NoImageAccessPanel',
]) {
  assert(
    imageTabSource.includes(required),
    `ImageGenerationTab must keep the image creation page structure: ${required}.`,
  );
}

for (const [sourceName, source] of [
  ['ImageGenerationTab', imageTabSource],
  ['VideoGenerationTab', videoTabSource],
]) {
  assert(
    !source.includes('SingleCreationWorks'),
    `${sourceName} must not import or render the retired SingleCreationWorks chain.`,
  );
}

for (const required of [
  'function ComposerSelect',
  'MAX_ATTACHMENTS = 5',
  "placeholder={t('描述新图片')}",
  'ai-creation-composer',
  'createImageBatchQueueItems',
  'referenceImages: attachments.map',
  "title={t('上传参考图')}",
]) {
  assert(
    imageSingleSource.includes(required),
    `ImageSingleTab must keep the image single-generation behavior: ${required}.`,
  );
}

for (const forbidden of [
  'setCount(Number(parameterState.defaults.count) || 1)',
  'setRatio(parameterState.defaults.ratio || DEFAULT_IMAGE_CONFIG.ratio)',
  'setResolution(parameterState.defaults.quality || DEFAULT_IMAGE_CONFIG.quality)',
]) {
  assert(
    !imageSingleSource.includes(forbidden),
    `ImageSingleTab must not reset composer controls after single-image submit: ${forbidden}.`,
  );
}

for (const required of [
  'IMAGE_MODEL_SPECS',
  'IMAGE_ADAPTERS',
  'getImageAdapterKeyForModel',
  'getImageParameterStateForModel',
]) {
  assert(
    imageRegistrySource.includes(required),
    `imageModelRegistry must keep model capabilities and adapter registry surface: ${required}.`,
  );
}

for (const required of [
  'IMAGE_PROVIDER_ADAPTERS',
  'buildGrokImageGenerationPayload',
  'buildOpenAiImageGenerationPayload',
  'shouldUseImageEdit',
]) {
  assert(
    imageAdaptersSource.includes(required),
    `adapters.js must keep provider-specific image adapter boundaries: ${required}.`,
  );
}

for (const required of [
  'createSingleImageParams',
  'createBatchRowImageParams',
  'getImageParameterState',
]) {
  assert(
    imageParamsSource.includes(required),
    `imageParams.js must keep the shared image parameter normalization API: ${required}.`,
  );
}

for (const required of [
  'ai-creation-page--video',
  'ai-creation-route-chip',
  'VideoSingleTab',
  'VideoBatchTab',
  'useScenePreference',
  'VIDEO_MODEL_WHITELIST',
  'subscribeVideoTasks',
  'VideoQueueDock',
  'CreationGalleryPanel',
  'CreationWorkCard',
  'BatchResultsActions',
  'function PreviewLightbox',
  'function NoVideoAccessPanel',
]) {
  assert(
    videoTabSource.includes(required),
    `VideoGenerationTab must keep the video creation page structure: ${required}.`,
  );
}

for (const required of [
  "placeholder={t('描述新视频')}",
  'VIDEO_DURATIONS = [6, 10, 12, 16, 20]',
  'MAX_ATTACHMENTS = 7',
  'createVideoBatchQueueItems',
  'referenceImages: attachments.map',
  "title={t('上传参考图')}",
]) {
  assert(
    videoSingleSource.includes(required),
    `VideoSingleTab must keep the video single-generation behavior: ${required}.`,
  );
}

for (const required of [
  'normalizeCreationOptions',
  'function ComposerSelect',
  'function CreationModeTabs',
]) {
  assert(
    aiCreationSharedSource.includes(required),
    `AiCreationShared must keep shared image/video creation UI helper: ${required}.`,
  );
}

for (const required of [
  'export function CreationWorkCard',
  'export function useCreationWorkMedia',
  'BatchResultFolderCard',
  'useCachedVideoDisplayUrl',
  'getTaskImageSourceUrl',
  'getTaskVideoSourceUrl',
  'resolveCreationWorkAssetUrl',
  'downloadCreationWorkAsset',
  "preload='metadata'",
  '<BatchResultFolderCard',
  'mediaItems={mediaItems}',
  'canOpenWhenEmpty',
]) {
  assert(
    creationWorkCardSource.includes(required),
    `CreationWorkCard must keep shared single-generation works behavior: ${required}.`,
  );
}

for (const forbidden of [
  'export function CreationWorkMedia',
  'export function CreationWorkMeta',
  'export function CreationWorkActions',
  'export function CreationWorkStatus',
  'ai-creation-work-card',
  'ai-creation-work-card__media',
  'ai-creation-work-card__meta',
  'ai-creation-work-card__actions',
  'ai-creation-work-ratio-badge',
]) {
  assert(
    !creationWorkCardSource.includes(forbidden),
    `CreationWorkCard must be a BatchResultFolderCard adapter, not a separate single-card visual implementation: ${forbidden}.`,
  );
}

for (const [sourceName, source] of [
  ['ImageSingleTab', imageSingleSource],
  ['VideoSingleTab', videoSingleSource],
  ['ImageBatchTab', imageBatchSource],
  ['VideoBatchTab', videoBatchSource],
]) {
  assert(
    source.includes("from './AiCreationShared.jsx'"),
    `${sourceName} must import shared creation controls from AiCreationShared.`,
  );
}

assert(
  !videoSingleSource.includes("from './ImageSingleTab.jsx'"),
  'VideoSingleTab must not depend on ImageSingleTab for shared controls.',
);
assert(
  !videoBatchSource.includes("from './ImageSingleTab.jsx'"),
  'VideoBatchTab must not depend on ImageSingleTab for shared controls.',
);
assert(
  !videoBatchSource.includes('setEditingCell'),
  'VideoBatchTab must not keep stale image-table editing state calls.',
);
assert(
  videoBatchSource.includes('setRowGalleryRow(row.id)') &&
    videoBatchSource.includes('rows.find((row) => row.id === rowGalleryRow)'),
  'VideoBatchTab row gallery must use stable row ids instead of row indexes.',
);
for (const [sourceName, source] of [
  ['ImageBatchTab', imageBatchSource],
  ['VideoBatchTab', videoBatchSource],
]) {
  assert(
    source.includes("import './creationResultGroup.css'"),
    `${sourceName} must explicitly load result group modal styles at the batch page entry.`,
  );
  assert(
    source.includes('CreationResultGroupModalContainer'),
    `${sourceName} must use the shared result group modal container.`,
  );
  assert(
    !source.includes('batch-excel-row-gallery'),
    `${sourceName} must not keep the old eager row gallery markup.`,
  );
}

for (const required of [
  'export function CreationGalleryPanel',
  'export function CreationGalleryActions',
  'export function CreationGalleryGrid',
  'export function CreationGalleryPagination',
  'export function CreationGalleryEmptyState',
  'ai-creation-gallery',
]) {
  assert(
    creationGallerySource.includes(required),
    `CreationGallery must keep the shared gallery shell: ${required}.`,
  );
}

for (const [sourceName, source] of [
  ['ImageGenerationTab', imageTabSource],
  ['VideoGenerationTab', videoTabSource],
  ['BatchResultGallery', batchResultGallerySource],
]) {
  assert(
    source.includes('CreationGalleryPanel'),
    `${sourceName} must use CreationGalleryPanel for works gallery structure.`,
  );
}

for (const [sourceName, source] of [
  ['ImageGenerationTab', imageTabSource],
  ['VideoGenerationTab', videoTabSource],
]) {
  assert(
    source.includes("import './imageBatchExcel.css'"),
    `${sourceName} must load the batch result card stylesheet when single works reuse BatchResultFolderCard.`,
  );
  for (const required of [
    'CreationGalleryPanel',
    'CreationWorkCard',
    'BatchResultsActions',
    "variant='single'",
    "title={t('我的作品')}",
    'activeSelectedCount',
    'downloadableSelectedCount',
    'retryableSelectedCount',
  ]) {
    assert(
      source.includes(required),
      `${sourceName} single works must directly use the shared gallery/card/actions contract: ${required}.`,
    );
  }
}

assert(
  imageTabSource.includes("caption={t('查看最近生成的图片和队列状态')}"),
  'ImageGenerationTab works caption must describe recent image results and queue state.',
);
assert(
  videoTabSource.includes("caption={t('查看最近生成的视频和队列状态')}"),
  'VideoGenerationTab works caption must describe recent video results and queue state.',
);

for (const [sourceName, source, caption] of [
  [
    'ImageBatchTab',
    imageBatchSource,
    "meta={t('按批量任务展示生成的图片作品')}",
  ],
  [
    'VideoBatchTab',
    videoBatchSource,
    "meta={t('按批量任务展示生成的视频作品')}",
  ],
]) {
  for (const required of [
    '<BatchResultGallery',
    "title={t('我的作品')}",
    caption,
    'BatchResultFolderCard',
    'activeSelectedCount',
    'downloadableSelectedCount',
    'retryableSelectedCount',
  ]) {
    assert(
      source.includes(required),
      `${sourceName} batch works must keep the shared batch gallery contract: ${required}.`,
    );
  }
}

for (const [sourceName, source] of [
  ['ImageGenerationTab', imageTabSource],
  ['VideoGenerationTab', videoTabSource],
  ['ImageBatchTab', imageBatchSource],
  ['VideoBatchTab', videoBatchSource],
]) {
  assert(
    source.includes('BatchResultsActions'),
    `${sourceName} must use the shared gallery actions for works management.`,
  );
}

assert(
  batchResultGallerySource.includes("variant='batch'") ||
    batchResultGallerySource.includes('variant="batch"'),
  'BatchResultGallery must remain a thin batch variant wrapper around CreationGalleryPanel.',
);
assert(
  !batchResultGallerySource.includes('classNames={{'),
  'BatchResultGallery must not reintroduce a parallel batch header/grid slot class map.',
);
assert(
  !batchResultGallerySource.includes('ai-batch-results__header') &&
    !batchResultGallerySource.includes('ai-batch-results__grid') &&
    !batchResultGallerySource.includes('ai-batch-results__pagination'),
  'BatchResultGallery must delegate header/grid/pagination structure to CreationGalleryPanel.',
);
assert(
  !batchResultGallerySource.includes("'ai-batch-results'") &&
    !batchResultGallerySource.includes('"ai-batch-results"') &&
    !creationGallerySource.includes('--ai-batch-results') &&
    !stylesSource.includes('--ai-batch-results') &&
    !imageBatchExcelCssSource.includes('--ai-batch-results'),
  'Works gallery containers must use ai-creation-gallery classes and variables, not parallel ai-batch-results containers.',
);
for (const required of [
  'export function CreationResultPreviewTile',
  'export function CreationResultPreviewGrid',
  'BatchResultMediaGrid',
  'CreationResultPreviewTile',
  'useFolderTileClass',
  'creation-result-preview-tile',
]) {
  assert(
    batchResultGallerySource.includes(required),
    `BatchResultGallery must keep the shared batch result preview tile surface: ${required}.`,
  );
}

for (const forbidden of [
  'semi-modal',
  'semi-modal-header',
  'semi-modal-title',
]) {
  assert(
    !resultGroupCssSource.includes(forbidden),
    `creationResultGroup.css must not depend on Semi internal selector: ${forbidden}.`,
  );
}
for (const required of [
  'CreationResultGroupHeader',
  'width={760}',
  'closable',
]) {
  assert(
    resultGroupModalSource.includes(required),
    `CreationResultGroupModal must keep the row gallery modal close to the original shell: ${required}.`,
  );
}
for (const required of [
  'IntersectionObserver',
  'CREATION_RESULT_GROUP_INITIAL_COUNT',
  'CREATION_RESULT_GROUP_BATCH_SIZE',
  'CreationResultPreviewTile',
  'creation-result-group-gallery__item',
  'useFolderTileClass={false}',
]) {
  assert(
    resultGroupViewerSource.includes(required),
    `CreationResultGroupViewer must keep incremental scroll rendering: ${required}.`,
  );
}
assert(
  !resultGroupViewerSource.includes('BatchResultFolderCard'),
  'CreationResultGroupViewer must render lightweight result items instead of wrapping every item in BatchResultFolderCard.',
);
for (const forbidden of [
  'creation-result-group-gallery__media',
  'creation-result-group-gallery__status-tile',
  'ResultStatusTile',
  'function ItemAction',
  'ai-batch-listview-preview__more',
]) {
  assert(
    !resultGroupViewerSource.includes(forbidden) &&
      !resultGroupCssSource.includes(forbidden),
    `Result group modal preview must reuse CreationResultPreviewTile instead of old gallery thumbnail structure: ${forbidden}.`,
  );
}
assert(
  resultGroupCssSource.includes('--creation-result-preview-ratio') &&
    resultGroupCssSource.includes('.creation-result-group-gallery__preview') &&
    !resultGroupCssSource.includes(
      '.creation-result-group-gallery .ai-batch-result-folder',
    ),
  'creationResultGroup.css must size the lightweight result preview with semantic classes and CSS variables, not batch folder card overrides.',
);

for (const required of [
  'VIDEO_MODEL_SPECS',
  'VIDEO_ADAPTERS',
  'getVideoAdapterKeyForModel',
  'getVideoParameterStateForModel',
  'getVideoPollingSpecForModel',
]) {
  assert(
    videoRegistrySource.includes(required),
    `videoModelRegistry must keep model capabilities and adapter registry surface: ${required}.`,
  );
}

for (const required of [
  'GROK_VIDEO_ADAPTER',
  'VIDEO_PROVIDER_ADAPTERS',
  'buildGrokVideoFormDataWithConfig',
  'getVideoResponseSpecForModel',
]) {
  assert(
    videoAdaptersSource.includes(required),
    `videoAdapters.js must keep provider-specific video adapter boundaries: ${required}.`,
  );
}

for (const required of [
  'createSingleVideoParams',
  'createBatchRowVideoParams',
  'getVideoParameterState',
]) {
  assert(
    videoParamsSource.includes(required),
    `videoParams.js must keep the shared video parameter normalization API: ${required}.`,
  );
}

for (const [sourceName, source] of [
  ['ImageBatchTab', imageBatchSource + batchExcelSharedSource],
  ['VideoBatchTab', videoBatchSource + batchExcelSharedSource],
]) {
  for (const required of [
    'batch-excel-shell',
    'BatchResultGallery',
    'onEnqueue',
    'onPreview',
    'download',
    'historyRef',
  ]) {
    assert(
      source.includes(required),
      `${sourceName} must keep batch editing/results behavior: ${required}.`,
    );
  }
}

for (const required of [
  'onDownloadSelected',
  'onRetrySelected',
  'onRetryFailed',
  'onClearSettled',
  'onCancelSelected',
  'onCancelActive',
  'activeSelectedCount',
  'downloadableSelectedCount',
  'retryableSelectedCount',
  'retryableCount',
  'settledCount',
  "t('下载选中')",
  "t('重试选中')",
  "t('重试失败/已停止')",
]) {
  assert(
    batchExcelSharedSource.includes(required),
    `BatchResultsActions must keep result multi-select management action: ${required}.`,
  );
}

for (const [sourceName, source] of [
  ['ImageBatchTab', imageBatchSource],
  ['VideoBatchTab', videoBatchSource],
]) {
  for (const required of [
    'BatchListView',
    'ai-batch-listview__table-card',
    'downloadSelectedResultRows',
    'retrySelectedResultRows',
    'retryAllFailedResultRows',
    '...(info.failedTasks || [])',
    '...(info.cancelledTasks || [])',
    "Toast.warning(t('选中项中没有可重试任务'))",
    "Toast.warning(t('选中项中没有可下载结果'))",
  ]) {
    assert(
      source.includes(required),
      `${sourceName} must keep scoped result selection download/retry behavior: ${required}.`,
    );
  }
}

for (const required of [
  '.ai-creation-composer',
  '.ai-batch-result-folder',
  '.ai-batch-result-folder__media',
  '.ai-batch-result-folder__meta',
  '.ai-creation-gallery__toolbar-action',
  '.ai-creation-queue-dock',
  '.ai-creation-page .batch-excel-shell',
]) {
  assert(
    (stylesSource + imageBatchExcelCssSource).includes(required),
    `styles.css must keep scoped image/video polish selector: ${required}.`,
  );
}

for (const forbidden of [
  '.ai-single-works',
  '.ai-single-work-card',
  '.ai-creation-work-card',
  '.ai-creation-work-card__media',
  '.ai-creation-work-card__meta',
  '.ai-creation-work-media',
  '.ai-creation-work-meta',
  'SingleCreationWorksPanel',
  'SingleCreationWorkCard',
]) {
  assert(
    !stylesSource.includes(forbidden) &&
      !imageTabSource.includes(forbidden) &&
      !videoTabSource.includes(forbidden) &&
      !creationWorkCardSource.includes(forbidden),
    `Retired single works selector/component must not return: ${forbidden}.`,
  );
}

assert(
  !constantsSource.includes('IMAGE_INSPIRATION_ITEMS') &&
    !constantsSource.includes('/examples/case-'),
  'Image prompt inspirations must come from the generated EvoLinkAI prompt library, not local example constants.',
);

for (const required of [
  'IMAGE_PROMPT_LIBRARY_ITEMS',
  'PROMPT_LIBRARY_CATEGORIES',
  "from './promptLibrary/zhCNPromptLibrary.js'",
  'filteredInspirationItems',
  'onCategoryChange={setInspirationCategory}',
  'setPromptPreset({',
]) {
  assert(
    imageTabSource.includes(required),
    `ImageGenerationTab must use the generated categorized prompt library: ${required}.`,
  );
}

for (const required of [
  '创作灵感',
  'aria-pressed',
  'prompt-inspiration-library__chip-count',
  'PROMPT_LIBRARY_SOURCE',
]) {
  assert(
    promptLibrarySource.includes(required) ||
      read('features/ai-creation/PromptInspirationLibrary.jsx').includes(
        required,
      ),
    `PromptInspirationLibrary must keep the categorized source-library UI contract: ${required}.`,
  );
}

for (const [key, label] of [
  ['ecommerce', '电商'],
  ['ad-creative', '广告创意'],
  ['portrait', '人像摄影'],
  ['poster', '海报插画'],
  ['character', '角色设计'],
  ['ui', 'UI / 社交媒体'],
  ['comparison', '对比案例'],
]) {
  assert(
    (promptLibrarySource.includes(`"key": "${key}"`) ||
      promptLibrarySource.includes(`key: '${key}'`)) &&
      (promptLibrarySource.includes(`"label": "${label}"`) ||
        promptLibrarySource.includes(`label: '${label}'`)),
    `zhCNPromptLibrary must include category ${key} (${label}).`,
  );
}

assert(
  promptLibrarySource.includes("new URL('./assets/") &&
    promptLibrarySource.includes('localImagePath') &&
    !promptLibrarySource.includes('/prompt-library/') &&
    !promptLibrarySource.includes('raw.githubusercontent.com'),
  'Generated prompt library items must use feature-local static assets, not public paths or GitHub raw images.',
);

const hasMeaningfulChinese = (value = '') =>
  (String(value).match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length || 0) >= 6;
const getCjkCount = (value = '') =>
  String(value).match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length || 0;
const getLatinLetterCount = (value = '') =>
  String(value).match(/[A-Za-z]/g)?.length || 0;
const hasJapaneseKana = (value = '') => /[\u3040-\u30ff]/u.test(String(value));
const isCleanChinesePrompt = (value = '') => {
  const prompt = String(value);
  const cjkCount = getCjkCount(prompt);
  if (!hasMeaningfulChinese(prompt) || hasJapaneseKana(prompt)) return false;
  return getLatinLetterCount(prompt) / Math.max(1, cjkCount) <= 0.3;
};
const looksJsonPrompt = (value = '') => {
  const prompt = String(value).trim();
  if (!prompt || !/^[{[]/.test(prompt)) return false;
  try {
    JSON.parse(prompt);
    return true;
  } catch {
    return /^[{[][\s\S]*["'][\w-]+["']\s*:/.test(prompt);
  }
};

const {
  IMAGE_PROMPT_LIBRARY_ITEMS,
  PROMPT_LIBRARY_CATEGORIES,
  PROMPT_LIBRARY_SOURCE,
} = promptLibraryModule;
const promptCategoryKeys = new Set(
  PROMPT_LIBRARY_CATEGORIES.map((category) => category.key),
);
const promptItemCounts = new Map();

assert(
  PROMPT_LIBRARY_SOURCE?.translation?.runtimeNetwork === false,
  'Prompt library data must be static at frontend runtime.',
);
assert(
  PROMPT_LIBRARY_SOURCE?.assets?.storage === 'feature-local-vite-import' &&
    PROMPT_LIBRARY_SOURCE?.assets?.root ===
      'web/src/features/ai-creation/promptLibrary/assets',
  'Prompt library images must be stored under the ai-creation feature and loaded through Vite asset URLs.',
);
assert(
  PROMPT_LIBRARY_SOURCE?.sources?.some(
    (source) =>
      source.sourceUrl ===
      'https://github.com/freestylefly/awesome-gpt-image-2',
  ),
  'Prompt library must include the freestylefly awesome-gpt-image-2 source.',
);
assert(
  IMAGE_PROMPT_LIBRARY_ITEMS.length > 0,
  'zhCNPromptLibrary must include clean Chinese prompt items.',
);

assert(
  chatTabSource.includes('useScenePreference') &&
    chatTabSource.includes("scene: 'chat'") &&
    chatTabSource.includes('if (!hydrated) return;'),
  'ChatTab must persist chat model/group selection and hydrate before repairing invalid model state.',
);

for (const [sourceName, source, storageKey] of [
  ['ImageGenerationTab', imageTabSource, 'ai_creation_image_active_tab'],
  ['VideoGenerationTab', videoTabSource, 'ai_creation_video_active_tab'],
]) {
  assert(
    source.includes(storageKey) &&
      source.includes("return value === 'batch' ? 'batch' : 'single'") &&
      source.includes('useState(loadActiveTab)') &&
      source.includes('persistActiveTab(activeTab)'),
    `${sourceName} must keep single/batch tab persistence constrained to known tabs.`,
  );
}

assert(
  imageTabSource.includes('ai_creation_image_single_gallery_tab') &&
    imageTabSource.includes('loadSingleGalleryTab') &&
    imageTabSource.includes(
      "return value === 'works' ? 'works' : 'inspiration'",
    ) &&
    imageTabSource.includes('useState(loadSingleGalleryTab)') &&
    imageTabSource.includes('persistSingleGalleryTab(singleGalleryTab)'),
  'ImageGenerationTab must persist the single image inspiration/works tab and constrain it to known tabs.',
);

assert(
  videoSingleSource.includes('ai_creation_video_single_config') &&
    videoSingleSource.includes(
      'saveSingleConfig({ ratio, duration, resolution })',
    ),
  'VideoSingleTab must persist its ratio/duration/resolution combo state.',
);

assert(
  imageBatchSource.includes('ai_creation_image_batch_config') &&
    imageBatchSource.includes('saveBatchConfig({ resolution })'),
  'ImageBatchTab must persist its batch resolution combo state.',
);

const selectTriggerBlocks = stylesSource.match(
  /[^{}]*\.ai-creation-select-trigger[^{}]*\{[\s\S]*?\}/g,
);
assert(
  selectTriggerBlocks?.length > 0,
  'AI creation styles must define ComposerSelect trigger blocks.',
);
for (const block of selectTriggerBlocks) {
  assert(
    !block.includes('background: transparent !important;'),
    'ComposerSelect trigger blocks must not make the trigger background transparent.',
  );
}
assert(
  stylesSource.includes('background: var(--ai-creation-fill,') ||
    stylesSource.includes(
      'background: var(--ai-creation-neutral-1) !important;',
    ) ||
    stylesSource.includes(
      'background: var(--ai-creation-neutral-0) !important;',
    ) ||
    stylesSource.includes(
      'background: var(--ai-creation-panel-strong) !important;',
    ),
  'Image/video ComposerSelect triggers must use a solid surface.',
);

assert(
  stylesSource.includes(
    'background: var(--semi-color-bg-0, #ffffff) !important;',
  ) &&
    !stylesSource.includes(
      '.composer-select-menu.ai-creation-floating-select-menu {\n  border-color: var(--ai-creation-neutral-border)',
    ),
  'Portaled ComposerSelect menus must use globally available solid backgrounds.',
);

for (const item of IMAGE_PROMPT_LIBRARY_ITEMS) {
  promptItemCounts.set(
    item.category,
    (promptItemCounts.get(item.category) || 0) + 1,
  );
  assert(
    promptCategoryKeys.has(item.category),
    `Prompt library item ${item.id} must use a declared category.`,
  );
  assert(
    item.promptLanguage === 'zh-CN' && isCleanChinesePrompt(item.prompt),
    `Prompt library item ${item.id} must expose a clean Chinese prompt without Japanese kana or heavy English.`,
  );
  assert(
    !looksJsonPrompt(item.prompt),
    `Prompt library item ${item.id} must not expose raw JSON prompt content.`,
  );
  assert(
    item.image &&
      !item.image.includes('raw.githubusercontent.com') &&
      !item.image.startsWith('http://') &&
      !item.image.startsWith('https://'),
    `Prompt library item ${item.id} must resolve to a local feature asset URL.`,
  );
  assert(
    item.localImagePath?.startsWith(
      'src/features/ai-creation/promptLibrary/assets/',
    ) && item.localImageFileSize > 0,
    `Prompt library item ${item.id} must keep a local feature image path and file size.`,
  );
  assert(
    item.upstreamImagePath?.startsWith('images/') ||
      item.upstreamImagePath?.startsWith('data/images/'),
    `Prompt library item ${item.id} must keep the upstream image path for pair auditing.`,
  );
  assert(
    fs.existsSync(path.resolve(srcDir, '..', item.localImagePath)) &&
      fs.statSync(path.resolve(srcDir, '..', item.localImagePath)).size ===
        item.localImageFileSize,
    `Prompt library image file must exist under web/src for item ${item.id}: ${item.localImagePath}`,
  );
}

console.log('ai-creation structure guard passed');
