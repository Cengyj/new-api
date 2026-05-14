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

import {
  MESSAGE_STATUS,
  THINK_TAG_REGEX,
} from '../../constants/playground.constants.js';
import {
  getChatImageCount,
  getChatTextContent,
} from './chat/chatMessageUtils.js';

export const CHAT_SESSIONS_STORAGE_KEY = 'ai_creation_chat_sessions';
export const CHAT_ACTIVE_SESSION_KEY = 'ai_creation_chat_active_session';
export const MAX_CHAT_SESSIONS = 30;

export const CHAT_SESSION_INPUT_KEYS = [
  'model',
  'group',
  'imageEnabled',
  'imageUrls',
  'stream',
];

const safeParse = (raw, fallback) => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const safeIsoDate = (value) => {
  if (!value) return new Date(0).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
};

const processThinkTags = (content, reasoningContent = '') => {
  if (!content || !content.includes('<think>')) {
    return { content, reasoningContent };
  }

  const thoughts = [];
  const replyParts = [];
  let lastIndex = 0;
  let match;

  THINK_TAG_REGEX.lastIndex = 0;
  while ((match = THINK_TAG_REGEX.exec(content)) !== null) {
    replyParts.push(content.substring(lastIndex, match.index));
    thoughts.push(match[1]);
    lastIndex = match.index + match[0].length;
  }
  replyParts.push(content.substring(lastIndex));

  const processedContent = replyParts
    .join('')
    .replace(/<\/?think>/g, '')
    .trim();
  const thoughtsStr = thoughts.join('\n\n---\n\n');
  const processedReasoningContent =
    reasoningContent && thoughtsStr
      ? `${reasoningContent}\n\n---\n\n${thoughtsStr}`
      : reasoningContent || thoughtsStr;

  return {
    content: processedContent,
    reasoningContent: processedReasoningContent,
  };
};

const processIncompleteThinkTags = (content, reasoningContent = '') => {
  if (!content) return { content: '', reasoningContent };

  const lastOpenThinkIndex = content.lastIndexOf('<think>');
  if (lastOpenThinkIndex === -1) {
    return processThinkTags(content, reasoningContent);
  }

  const fragmentAfterLastOpen = content.substring(lastOpenThinkIndex);
  if (!fragmentAfterLastOpen.includes('</think>')) {
    const unclosedThought = fragmentAfterLastOpen
      .substring('<think>'.length)
      .trim();
    const cleanContent = content.substring(0, lastOpenThinkIndex);
    const processedReasoningContent = unclosedThought
      ? reasoningContent
        ? `${reasoningContent}\n\n---\n\n${unclosedThought}`
        : unclosedThought
      : reasoningContent;

    return processThinkTags(cleanContent, processedReasoningContent);
  }

  return processThinkTags(content, reasoningContent);
};

const normalizeMessage = (message) => {
  if (!message || typeof message !== 'object') return null;
  const normalized = { ...message };

  if (
    normalized.status === MESSAGE_STATUS.LOADING ||
    normalized.status === MESSAGE_STATUS.INCOMPLETE
  ) {
    const processed = processIncompleteThinkTags(
      typeof normalized.content === 'string' ? normalized.content : '',
      normalized.reasoningContent || '',
    );
    normalized.status = MESSAGE_STATUS.COMPLETE;
    normalized.content = processed.content;
    normalized.reasoningContent = processed.reasoningContent || null;
    normalized.isThinkingComplete = true;
  }

  return normalized;
};

export const normalizeChatSessionInputs = (inputs = {}) =>
  CHAT_SESSION_INPUT_KEYS.reduce((result, key) => {
    if (key === 'imageUrls') {
      result.imageUrls = Array.isArray(inputs.imageUrls)
        ? inputs.imageUrls.filter((url) => typeof url === 'string' && url.trim())
        : [];
      return result;
    }

    if (key === 'imageEnabled' || key === 'stream') {
      result[key] = Boolean(inputs[key]);
      return result;
    }

    result[key] = inputs[key] == null ? '' : String(inputs[key]);
    return result;
  }, {});

export const loadChatSessions = () => {
  if (typeof window === 'undefined') return [];
  const sessions = safeParse(
    window.localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY),
    [],
  );
  return Array.isArray(sessions) ? sessions : [];
};

export const loadActiveChatSessionId = () => {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(CHAT_ACTIVE_SESSION_KEY) || '';
};

export const saveChatSessions = (sessions, activeSessionId) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CHAT_SESSIONS_STORAGE_KEY,
      JSON.stringify(sessions),
    );
    if (activeSessionId) {
      window.localStorage.setItem(CHAT_ACTIVE_SESSION_KEY, activeSessionId);
    } else {
      window.localStorage.removeItem(CHAT_ACTIVE_SESSION_KEY);
    }
  } catch (error) {
    console.error('保存对话列表失败:', error);
  }
};

export const normalizeChatSession = (session) => {
  if (!session || typeof session !== 'object') return null;
  const id = String(session.id || '').trim();
  if (!id) return null;

  return {
    id,
    title: String(session.title || ''),
    messages: Array.isArray(session.messages)
      ? session.messages.map(normalizeMessage).filter(Boolean)
      : [],
    inputs: normalizeChatSessionInputs(session.inputs || {}),
    updatedAt: safeIsoDate(session.updatedAt),
  };
};

const cleanTitleText = (text) =>
  String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+]\([^)]*\)/g, ' ')
    .replace(/[#*_`>~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const deriveChatSessionTitle = (
  messages = [],
  fallback = '新对话',
  options = {},
) => {
  const firstUserMessage = messages.find((item) => item?.role === 'user');
  if (!firstUserMessage) return fallback;

  const rawContent = cleanTitleText(getChatTextContent(firstUserMessage));

  if (!rawContent || rawContent === 'Hello' || rawContent === '你好') {
    return getChatImageCount(firstUserMessage) > 0
      ? options.imageTitle || fallback
      : fallback;
  }

  return rawContent.length > 24 ? `${rawContent.slice(0, 24)}…` : rawContent;
};

export const createChatSession = ({
  id,
  title,
  messages = [],
  inputs = {},
}) => ({
  id,
  title,
  messages,
  inputs: normalizeChatSessionInputs(inputs),
  updatedAt: new Date().toISOString(),
});

export const limitChatSessions = (sessions, max = MAX_CHAT_SESSIONS) =>
  [...sessions]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, max);

export const syncChatSessions = (sessions) =>
  limitChatSessions(
    sessions.map((session) => normalizeChatSession(session)).filter(Boolean),
  );

export const getSessionTimestampLabel = (session, t) => {
  if (!session?.updatedAt) return t('刚刚');

  const updatedAt = new Date(session.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return t('刚刚');

  return updatedAt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const generateAvatarDataUrl = (username, stringToColor, encodeToBase64) => {
  if (!username) {
    return 'https://lf3-static.bytednsdoc.com/obj/eden-cn/ptlz_zlp/ljhwZthlaukjlkulzlp/docs-icon.png';
  }
  const firstLetter = username[0].toUpperCase();
  const bgColor = stringToColor(username);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="16" fill="${bgColor}" />
      <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-size="16" fill="#ffffff" font-family="sans-serif">${firstLetter}</text>
    </svg>
  `;
  return `data:image/svg+xml;base64,${encodeToBase64(svg)}`;
};
