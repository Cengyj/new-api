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

import React, { useCallback, useMemo, useRef } from 'react';
import { Toast } from '@douyinfe/semi-ui';
import { ArrowUp, FileText, Image, Paperclip, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayground } from '../../../contexts/PlaygroundContext';
import {
  buildAttachmentRecord,
  formatFileSize,
  getAttachmentKindLabel,
  getClipboardFiles,
  getClipboardImageFiles,
  getFileIdentity,
  hasClipboardText,
  isImageFile,
} from './chatAttachments.js';

const FILE_INPUT_ACCEPT = '';

const getComposerTextInput = (container) =>
  container?.querySelector(
    'textarea, [contenteditable="true"], input:not([type="file"])',
  );

const focusComposerInput = (container) => {
  const focusTarget = getComposerTextInput(container);
  if (!focusTarget) return;

  try {
    focusTarget.focus({ preventScroll: true });
  } catch (_) {
    focusTarget.focus();
  }
};

const showAttachmentLimitToast = (t, maxAttachments) => {
  Toast.warning({
    content: t('最多添加 {{count}} 个附件', { count: maxAttachments }),
    duration: 3,
  });
};

const showImageLimitToast = (t, maxImageAttachments) => {
  Toast.warning({
    content: t('最多添加 {{count}} 张图片', { count: maxImageAttachments }),
    duration: 3,
  });
};

const countImages = (attachments = []) =>
  attachments.filter((attachment) => attachment.kind === 'image').length;

const ChatComposer = ({ detailProps }) => {
  const { t } = useTranslation();
  const {
    onAddAttachments,
    onRemoveAttachment,
    maxAttachments = 8,
    maxImageAttachments = 8,
    attachments = [],
    isGenerating = false,
    onStopGenerator,
    canSend = true,
    sendDisabledReason = '',
  } = usePlayground();
  const { inputNode, sendNode, onClick } = detailProps;
  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const currentAttachmentIdentities = useMemo(
    () =>
      new Set(
        attachments.map((attachment) =>
          getFileIdentity(attachment?.file || attachment),
        ),
      ),
    [attachments],
  );

  const restoreInputFocus = useCallback(() => {
    if (
      typeof window !== 'undefined' &&
      typeof window.requestAnimationFrame === 'function'
    ) {
      window.requestAnimationFrame(() =>
        focusComposerInput(containerRef.current),
      );
      return;
    }
    focusComposerInput(containerRef.current);
  }, []);

  const addFiles = useCallback(
    (files) => {
      const incomingFiles = Array.from(files || []).filter(Boolean);
      if (incomingFiles.length === 0) return;

      if (isGenerating) {
        Toast.warning({
          content: t('生成中不能添加附件，请先停止生成'),
          duration: 3,
        });
        restoreInputFocus();
        return;
      }

      if (!onAddAttachments) {
        Toast.error({
          content: t('无法添加附件'),
          duration: 2,
        });
        restoreInputFocus();
        return;
      }

      const remainingSlots = Math.max(maxAttachments - attachments.length, 0);
      if (remainingSlots <= 0) {
        showAttachmentLimitToast(t, maxAttachments);
        restoreInputFocus();
        return;
      }

      const currentImageCount = countImages(attachments);
      let remainingImageSlots = Math.max(
        maxImageAttachments - currentImageCount,
        0,
      );
      const seenIdentities = new Set(currentAttachmentIdentities);
      const acceptedFiles = [];
      let skippedByTotal = 0;
      let skippedImages = 0;

      for (const file of incomingFiles) {
        const identity = getFileIdentity(file);
        if (seenIdentities.has(identity)) {
          continue;
        }

        seenIdentities.add(identity);

        if (acceptedFiles.length >= remainingSlots) {
          skippedByTotal += 1;
          continue;
        }

        if (isImageFile(file)) {
          if (remainingImageSlots <= 0) {
            skippedImages += 1;
            continue;
          }
          remainingImageSlots -= 1;
        }

        acceptedFiles.push(file);
      }

      if (skippedByTotal > 0) {
        showAttachmentLimitToast(t, maxAttachments);
      }

      if (skippedImages > 0) {
        showImageLimitToast(t, maxImageAttachments);
      }

      if (acceptedFiles.length === 0) {
        restoreInputFocus();
        return;
      }

      const nextAttachments = acceptedFiles.map(buildAttachmentRecord);
      onAddAttachments(nextAttachments);
      Toast.success({
        content:
          nextAttachments.length > 1
            ? t('{{count}} 个附件已添加', { count: nextAttachments.length })
            : t('附件已添加'),
        duration: 2,
      });
      restoreInputFocus();
    },
    [
      attachments,
      currentAttachmentIdentities,
      isGenerating,
      maxAttachments,
      maxImageAttachments,
      onAddAttachments,
      restoreInputFocus,
      t,
    ],
  );

  const handlePaste = useCallback(
    (event) => {
      if (event.defaultPrevented) return;
      const clipboardData =
        event.clipboardData || event.nativeEvent?.clipboardData;
      const clipboardFiles = getClipboardFiles(clipboardData);
      const hasImages =
        getClipboardImageFiles(clipboardData, clipboardFiles).length > 0;

      if (clipboardFiles.length === 0 && !hasImages) return;

      if (!hasClipboardText(clipboardData)) {
        event.preventDefault();
      }

      addFiles(clipboardFiles);
    },
    [addFiles],
  );

  const handleFileSelect = useCallback(
    (event) => {
      addFiles(event.target.files);
      event.target.value = '';
    },
    [addFiles],
  );

  const handleDragOver = useCallback(
    (event) => {
      if (isGenerating || !event.dataTransfer?.files?.length) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [isGenerating],
  );

  const handleDrop = useCallback(
    (event) => {
      const droppedFiles = event.dataTransfer?.files;
      if (!droppedFiles?.length) return;
      event.preventDefault();
      addFiles(droppedFiles);
    },
    [addFiles],
  );

  const showStopAsSend = isGenerating && onStopGenerator;
  const hasAttachments = attachments.length > 0;
  const hasSendableAttachments = hasAttachments;
  const uploadDisabled = isGenerating;
  const uploadTitle = uploadDisabled
    ? t('生成中不能添加附件，请先停止生成')
    : t('添加附件，或直接粘贴文本、图片、文件');

  const renderedSendNode = useMemo(
    () =>
      sendNode
        ? React.cloneElement(
            sendNode,
            {
              icon: showStopAsSend ? (
                <Square size={14} strokeWidth={0} fill='currentColor' />
              ) : (
                <ArrowUp size={18} strokeWidth={2.6} />
              ),
              'aria-label': showStopAsSend
                ? t('停止生成')
                : sendDisabledReason || t('发送'),
              title: showStopAsSend
                ? t('停止生成')
                : sendDisabledReason || t('发送'),
              onClick: showStopAsSend
                ? (event) => {
                    event?.stopPropagation?.();
                    onStopGenerator();
                  }
                : sendNode.props.onClick,
              disabled: showStopAsSend
                ? false
                : (!hasSendableAttachments && sendNode.props.disabled) ||
                  !canSend,
              className: `ai-chat-composer-send${showStopAsSend ? ' is-stop' : ''} flex-shrink-0 transition-all ${
                sendNode.props.className || ''
              }`,
              style: {
                ...sendNode.props.style,
                width: '36px',
                height: '36px',
                minWidth: '36px',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              },
            },
            null,
          )
        : null,
    [
      canSend,
      hasSendableAttachments,
      onStopGenerator,
      sendDisabledReason,
      sendNode,
      showStopAsSend,
      t,
    ],
  );

  return (
    <div
      className='ai-chat-composer-wrap'
      ref={containerRef}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className='ai-chat-composer-shell' onClick={onClick}>
        {hasAttachments && (
          <div className='ai-chat-attachment-strip' aria-live='polite'>
            <div className='ai-chat-attachment-strip-head'>
              <span className='ai-chat-attachment-label'>
                {t('{{count}} 个附件', { count: attachments.length })}
              </span>
              <span className='ai-chat-attachment-hint'>
                {t('附件会随消息发送')}
              </span>
            </div>
            <div className='ai-chat-attachments'>
              {attachments.map((attachment, index) => {
                const isImage = attachment.kind === 'image';
                const attachmentTitle = attachment.name || t('未命名文件');

                return (
                  <div
                    key={attachment.id || `${attachment.name}-${index}`}
                    className={`ai-chat-attachment-item ai-chat-file-attachment ${
                      isImage ? 'is-image' : ''
                    }`}
                    title={attachmentTitle}
                  >
                    <div className='ai-chat-file-attachment-icon'>
                      {isImage && attachment.previewUrl ? (
                        <img src={attachment.previewUrl} alt='' />
                      ) : isImage ? (
                        <Image size={18} />
                      ) : (
                        <FileText size={18} />
                      )}
                    </div>
                    <div className='ai-chat-file-attachment-meta'>
                      <span>{attachmentTitle}</span>
                      <small>
                        {getAttachmentKindLabel(attachment, t)} ·{' '}
                        {formatFileSize(attachment.size)}
                      </small>
                    </div>
                    <button
                      type='button'
                      className='ai-chat-attachment-remove'
                      aria-label={t('移除附件')}
                      disabled={isGenerating}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (isGenerating) return;
                        onRemoveAttachment?.(attachment.id ?? index);
                      }}
                      title={t('移除附件')}
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className='ai-chat-composer-row'>
          <div className='ai-chat-composer-actions-left'>
            <button
              type='button'
              className='ai-chat-composer-action ai-chat-composer-plus flex-shrink-0 transition-all'
              aria-label={t('添加附件')}
              aria-disabled={uploadDisabled}
              disabled={uploadDisabled}
              title={uploadTitle}
              onClick={(event) => {
                event.stopPropagation();
                if (uploadDisabled) return;
                fileInputRef.current?.click();
              }}
            >
              <Paperclip size={17} strokeWidth={2} />
            </button>
            <input
              type='file'
              accept={FILE_INPUT_ACCEPT}
              multiple
              ref={fileInputRef}
              className='ai-chat-file-input'
              onChange={handleFileSelect}
              disabled={uploadDisabled}
              tabIndex={-1}
            />
          </div>
          <div className='ai-chat-composer-input'>{inputNode}</div>
          <div className='ai-chat-composer-actions-right'>
            {renderedSendNode}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatComposer;
