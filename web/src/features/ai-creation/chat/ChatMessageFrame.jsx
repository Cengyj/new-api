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

import React, { useMemo } from 'react';
import clsx from 'clsx';
import { FileText, Image } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OptimizedMessageContent } from '../../../components/playground/OptimizedComponents';
import {
  getChatTextContent,
  isChatMessageGenerating,
  stripInlineThinking,
} from './chatMessageUtils.js';
import { formatFileSize, getAttachmentKindLabel } from './chatAttachments.js';

const ChatMessageFrame = ({
  message,
  className,
  styleState,
  onToggleReasoningExpansion,
  isEditing,
  onEditSave,
  onEditCancel,
  editValue,
  onEditValueChange,
}) => {
  const { t } = useTranslation();
  const sanitizedMessage = useMemo(
    () => ({
      ...message,
      reasoningContent: null,
      isReasoningExpanded: false,
      content: stripInlineThinking(message.content),
    }),
    [message],
  );
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : [];
  const hasAttachments = attachments.length > 0;
  const hasDisplayText = getChatTextContent(sanitizedMessage).trim().length > 0;
  const hasReasoningText =
    typeof message.reasoningContent === 'string' &&
    message.reasoningContent.trim().length > 0;
  const isAttachmentOnly = hasAttachments && !hasDisplayText && !isEditing;
  const isBlankAssistant =
    message.role === 'assistant' &&
    !hasDisplayText &&
    !hasAttachments &&
    !hasReasoningText &&
    !isEditing;
  const isAssistantGenerating =
    isBlankAssistant && isChatMessageGenerating(message);

  return (
    <div
      className={clsx(
        'ai-chat-message-frame',
        `ai-chat-message-frame-${message.role}`,
        hasAttachments && 'has-attachments',
        isAttachmentOnly && 'is-attachment-only',
      )}
    >
      {isBlankAssistant ? (
        <div
          className={clsx(
            'ai-chat-message',
            'ai-chat-message-assistant',
            'ai-chat-message-assistant-placeholder',
            isAssistantGenerating ? 'is-generating' : 'is-empty',
          )}
          aria-live={isAssistantGenerating ? 'polite' : undefined}
        >
          <span className='ai-chat-message-loading-dot' aria-hidden='true' />
          <span className='ai-chat-message-loading-dot' aria-hidden='true' />
          <span className='ai-chat-message-loading-dot' aria-hidden='true' />
        </div>
      ) : (
        !isAttachmentOnly && (
        <OptimizedMessageContent
          message={sanitizedMessage}
          className={className}
          styleState={styleState}
          onToggleReasoningExpansion={onToggleReasoningExpansion}
          isEditing={isEditing}
          onEditSave={onEditSave}
          onEditCancel={onEditCancel}
          editValue={editValue}
          onEditValueChange={onEditValueChange}
          userMarkdownClassName='ai-chat-message-user-markdown'
        />
        )
      )}
      {hasAttachments && (
        <div className='ai-chat-message-attachments'>
          {attachments.map((attachment, index) => (
            <div
              key={attachment.id || `${attachment.name}-${index}`}
              className='ai-chat-message-attachment'
              title={attachment.name || t('未命名文件')}
            >
              <span className='ai-chat-message-attachment-icon'>
                {attachment.kind === 'image' ? (
                  <Image size={15} />
                ) : (
                  <FileText size={15} />
                )}
              </span>
              <span className='ai-chat-message-attachment-text'>
                <strong>{attachment.name || t('未命名文件')}</strong>
                <small>
                  {getAttachmentKindLabel(attachment, t)} ·{' '}
                  {formatFileSize(attachment.size)}
                </small>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default React.memo(ChatMessageFrame);
