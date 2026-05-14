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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from '@douyinfe/semi-ui';
import { ArrowUp, Paperclip, X } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { getModelDisplayName } from './constants.js';
import {
  createSingleVideoParams,
  getVideoParameterState,
} from './videoParams.js';
import {
  ComposerSelect,
  normalizeCreationOptions,
} from './AiCreationShared.jsx';
import { readImageFileAsDataUrl } from './utils.js';
import {
  VIDEO_TASK_SOURCE,
  createVideoBatchQueueItems,
} from './videoBatchQueue.js';

const MAX_ATTACHMENTS = 7;
const VIDEO_DURATIONS = [6, 10, 12, 16, 20];
const STORAGE_KEY = 'ai_creation_video_single_config';

function loadSingleConfig() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSingleConfig(patch) {
  if (typeof window === 'undefined') return;
  try {
    const prev = loadSingleConfig();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...prev, ...patch }),
    );
  } catch {
    /* ignore */
  }
}

const getOptionLabels = (options = []) =>
  options.map((item) => ({
    value: item.value,
    label: item.label,
  }));

export default function VideoSingleTab({
  inputs,
  models,
  groups,
  handleInputChange,
  onEnqueue,
}) {
  const { t } = useTranslation();
  const saved = loadSingleConfig();
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState(saved.ratio ?? '16:9');
  const [duration, setDuration] = useState(saved.duration ?? '6s');
  const [resolution, setResolution] = useState(saved.resolution ?? '720p');
  const [attachments, setAttachments] = useState([]);
  const [dragActive, setDragActive] = useState(false);

  const promptRef = useRef(null);
  const fileInputRef = useRef(null);
  const attachIdRef = useRef(0);
  const dragDepthRef = useRef(0);

  const modelOptions = useMemo(
    () =>
      normalizeCreationOptions(models, inputs.model).map((opt) => {
        const src = (models || []).find((m) => (m.value ?? m) === opt.value);
        return {
          ...opt,
          label: getModelDisplayName(opt.value) || opt.label,
          quota_type: src?.quota_type,
          model_price: src?.model_price,
          model_ratio: src?.model_ratio,
          image_ratio: src?.image_ratio,
        };
      }),
    [models, inputs.model],
  );
  const groupOptions = useMemo(
    () => normalizeCreationOptions(groups, inputs.group),
    [groups, inputs.group],
  );
  const parameterState = useMemo(
    () => getVideoParameterState(inputs.model),
    [inputs.model],
  );
  const ratioOptions = useMemo(
    () => getOptionLabels(parameterState.ratioOptions),
    [parameterState.ratioOptions],
  );
  const durationOptions = useMemo(
    () => getOptionLabels(parameterState.durationOptions),
    [parameterState.durationOptions],
  );
  const resolutionOptions = useMemo(
    () => getOptionLabels(parameterState.resolutionOptions),
    [parameterState.resolutionOptions],
  );
  const effectiveMaxAttachments = useMemo(
    () =>
      Math.min(
        parameterState.maxReferenceImages || MAX_ATTACHMENTS,
        MAX_ATTACHMENTS,
      ),
    [parameterState.maxReferenceImages],
  );

  useEffect(() => {
    if (!ratioOptions.some((option) => option.value === ratio)) {
      setRatio(parameterState.defaults.ratio);
    }
    if (!durationOptions.some((option) => option.value === duration)) {
      setDuration(parameterState.defaults.duration);
    }
    if (!resolutionOptions.some((option) => option.value === resolution)) {
      setResolution(parameterState.defaults.resolution);
    }
  }, [
    ratio,
    duration,
    resolution,
    ratioOptions,
    durationOptions,
    resolutionOptions,
    parameterState.defaults.ratio,
    parameterState.defaults.duration,
    parameterState.defaults.resolution,
  ]);

  useEffect(() => {
    setAttachments((prev) =>
      prev.length > effectiveMaxAttachments
        ? prev.slice(0, effectiveMaxAttachments)
        : prev,
    );
  }, [effectiveMaxAttachments]);
  const expectedCost = useMemo(() => {
    const opt = modelOptions.find((item) => item.value === inputs.model);
    if (!opt) return null;
    if (opt.quota_type === 1 && opt.model_price != null) {
      return opt.model_price;
    }
    if (opt.quota_type === 0 && opt.model_ratio != null) {
      const imgRatio = opt.image_ratio ?? 1;
      return opt.model_ratio * imgRatio;
    }
    return null;
  }, [modelOptions, inputs.model]);

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
    el.style.overflowY = el.scrollHeight > 260 ? 'auto' : 'hidden';
  }, [prompt]);

  useEffect(() => {
    const hasRatio = ratioOptions.some((option) => option.value === ratio);
    const hasDuration = durationOptions.some(
      (option) => option.value === duration,
    );
    const hasResolution = resolutionOptions.some(
      (option) => option.value === resolution,
    );
    if (!hasRatio || !hasDuration || !hasResolution) return;
    saveSingleConfig({ ratio, duration, resolution });
  }, [
    ratio,
    duration,
    resolution,
    ratioOptions,
    durationOptions,
    resolutionOptions,
  ]);

  const handleAttachFiles = async (files) => {
    if (!files?.length) return;
    const imageFiles = Array.from(files).filter((file) =>
      file.type?.startsWith('image/'),
    );
    if (!imageFiles.length) {
      Toast.info(t('请选择图片文件'));
      return;
    }
    const slots = Math.max(0, effectiveMaxAttachments - attachments.length);
    if (slots <= 0) {
      Toast.info(
        t('最多上传 {{count}} 张参考图', { count: effectiveMaxAttachments }),
      );
      return;
    }
    const picked = imageFiles.slice(0, slots);
    try {
      const data = await Promise.all(
        picked.map(async (file) => ({
          id: `att-${++attachIdRef.current}`,
          name: file.name,
          dataUrl: await readImageFileAsDataUrl(file),
        })),
      );
      setAttachments((prev) => [...prev, ...data]);
      if (imageFiles.length > slots) {
        Toast.info(
          t('已保留前 {{count}} 张参考图', { count: effectiveMaxAttachments }),
        );
      }
    } catch {
      Toast.error(t('读取图片失败'));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const submit = () => {
    if (!prompt.trim()) {
      Toast.info(t('先描述你想创作的内容'));
      return;
    }
    const videoParams = createSingleVideoParams({
      source: VIDEO_TASK_SOURCE.SINGLE,
      prompt: prompt.trim(),
      ratio,
      duration,
      resolution,
      model: inputs.model,
      group: inputs.group,
      referenceImages: attachments.map((item) => item.dataUrl),
    });
    const queuedTasks = createVideoBatchQueueItems({
      ...videoParams,
      source: VIDEO_TASK_SOURCE.SINGLE,
    });
    onEnqueue?.(queuedTasks);
    setPrompt('');
    setAttachments([]);
    Toast.success(t('已加入生成队列，可继续提交新批次'));
  };

  return (
    <div
      className={clsx(
        'ai-creation-composer ai-creation-composer--video rounded-[28px] border bg-white p-4 shadow-[0_18px_55px_rgba(15,23,42,.10)] transition-colors',
        dragActive
          ? 'is-drag-active border-neutral-950 ring-2 ring-neutral-950/10'
          : 'border-neutral-200',
      )}
      onPaste={(event) => {
        const items = event.clipboardData?.items;
        if (!items) return;
        const images = [];
        for (const item of Array.from(items)) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) images.push(file);
          }
        }
        if (!images.length) return;
        event.preventDefault();
        void handleAttachFiles(images);
      }}
      onDragEnter={(event) => {
        if (
          !Array.from(event.dataTransfer.items).some(
            (item) => item.kind === 'file',
          )
        )
          return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (
          !Array.from(event.dataTransfer.items).some(
            (item) => item.kind === 'file',
          )
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragActive(false);
        void handleAttachFiles(event.dataTransfer.files);
      }}
    >
      <textarea
        ref={promptRef}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={t('描述新视频')}
        className='studio-prompt ai-creation-composer__textarea min-h-[66px] w-full resize-none border-0 bg-transparent px-2 pt-1 text-[15px] font-normal leading-7 text-neutral-950 outline-none ring-0 placeholder:font-normal placeholder:text-neutral-400 focus:border-0 focus:outline-none focus:ring-0'
        maxLength={5000}
      />

      <input
        ref={fileInputRef}
        type='file'
        accept='image/*'
        multiple
        className='hidden'
        onChange={(event) => void handleAttachFiles(event.target.files)}
      />

      <div className='ai-creation-composer__footer ai-creation-video-control-shelf mt-2 flex items-center justify-between gap-3'>
        <div className='ai-creation-composer__controls ai-creation-video-param-grid flex min-w-0 flex-wrap items-center gap-2'>
          <button
            className='ai-creation-reference-icon-btn grid h-8 w-8 place-items-center rounded-full text-neutral-600 transition hover:bg-neutral-100'
            title={t('上传参考图')}
            type='button'
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={18} />
          </button>
          {groupOptions.length > 1 && (
            <div className='ai-creation-video-param'>
              <ComposerSelect
                value={inputs.group || groupOptions[0]?.value || ''}
                onChange={(value) => handleInputChange('group', value)}
                options={groupOptions}
              />
            </div>
          )}
          <div className='ai-creation-video-param ai-creation-video-param--model'>
            <ComposerSelect
              value={inputs.model || modelOptions[0]?.value || ''}
              onChange={(value) => handleInputChange('model', value)}
              options={modelOptions}
              wide
            />
          </div>
          <div className='ai-creation-video-param'>
            <ComposerSelect
              value={ratio}
              onChange={setRatio}
              options={ratioOptions}
            />
          </div>
          <div className='ai-creation-video-param'>
            <ComposerSelect
              value={duration}
              onChange={setDuration}
              options={durationOptions}
            />
          </div>
          <div className='ai-creation-video-param'>
            <ComposerSelect
              value={resolution}
              onChange={setResolution}
              options={resolutionOptions}
            />
          </div>
        </div>

        <div className='ai-creation-composer__actions ai-creation-video-actions'>
          <span className='ai-creation-cost'>
            {expectedCost != null
              ? `${expectedCost % 1 === 0 ? expectedCost : expectedCost.toFixed(4)} ${t('额度')}`
              : t('价格计算中...')}
          </span>
          <button
            type='button'
            onClick={submit}
            className='ai-creation-submit-btn ai-creation-video-submit-btn grid h-10 w-10 place-items-center rounded-full bg-neutral-950 text-white transition hover:bg-neutral-800'
            title={t('生成')}
          >
            <ArrowUp size={19} />
          </button>
        </div>
      </div>

      {attachments.length > 0 && (
        <div
          className='ai-creation-reference-strip ai-creation-video-reference-strip mt-3 flex flex-wrap gap-2'
          aria-label={t('参考图')}
        >
          {attachments.map((item) => (
            <div
              key={item.id}
              className='ai-creation-reference-thumb group relative h-14 w-14 overflow-hidden rounded-[12px] bg-neutral-100'
            >
              <img
                src={item.dataUrl}
                alt={item.name}
                className='h-full w-full object-cover'
              />
              <button
                type='button'
                onClick={() =>
                  setAttachments((prev) =>
                    prev.filter((asset) => asset.id !== item.id),
                  )
                }
                className='ai-creation-reference-remove absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100'
                title={t('移除')}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
