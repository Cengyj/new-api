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

import { MESSAGE_STATUS } from '../../../constants/playground.constants.js';

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';

export const CHAT_GENERATING_STATUSES = new Set([
  MESSAGE_STATUS.LOADING,
  MESSAGE_STATUS.INCOMPLETE,
]);

export const isChatMessageGenerating = (message) =>
  Boolean(message && CHAT_GENERATING_STATUSES.has(message.status));

export const isChatGenerating = (messages = []) =>
  Array.isArray(messages) && messages.some(isChatMessageGenerating);

export const stripInlineThinking = (content) => {
  if (typeof content === 'string') {
    return content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*/g, '')
      .trim();
  }

  if (Array.isArray(content)) {
    return content.map((item) => {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        return {
          ...item,
          text: stripInlineThinking(item.text),
        };
      }
      return item;
    });
  }

  return content;
};

export const getChatTextContent = (message) => {
  if (!message) return '';
  const content = message.content ?? message.text ?? '';

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        return item.text || item.content || '';
      })
      .filter(Boolean)
      .join(' ');
  }

  return typeof content === 'string' ? content : String(content || '');
};

export const getChatImageCount = (message) => {
  if (!Array.isArray(message?.content)) return 0;
  return message.content.filter((item) => item?.type === 'image_url').length;
};

export const hasOnlyIncompleteThinking = (message) => {
  const content = typeof message?.content === 'string' ? message.content : '';
  return (
    content.includes(THINK_OPEN_TAG) &&
    !content.includes(THINK_CLOSE_TAG) &&
    !message?.reasoningContent
  );
};
