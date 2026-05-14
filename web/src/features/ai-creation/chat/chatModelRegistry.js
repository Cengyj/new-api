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

import { buildApiPayload, createMessage } from '../../../helpers';
import { MESSAGE_ROLES } from '../../../constants/playground.constants';
import { CHAT_ATTACHMENT_LIMIT } from './chatAttachments.js';

export const DEFAULT_CHAT_MODEL_CAPABILITIES = {
  supportsImages: true,
  supportsStreaming: true,
  supportsReasoning: true,
  maxImageAttachments: CHAT_ATTACHMENT_LIMIT,
};

const CHAT_MODEL_CAPABILITY_RULES = [
  {
    match:
      /(vision|vl|image|multimodal|gpt-4o|gpt-4\.1|gemini|claude|pixtral|qwen.*vl|glm-4v|llava)/i,
    capabilities: {
      supportsImages: true,
    },
  },
  {
    match: /(deepseek-r1|reasoner|o1|o3|o4|thinking|reasoning)/i,
    capabilities: {
      supportsReasoning: true,
    },
  },
];

export const normalizeChatOption = (option) => {
  if (option && typeof option === 'object') {
    return {
      label: String(option.label ?? option.value ?? ''),
      value: String(option.value ?? option.label ?? ''),
      ratio: option.ratio,
      fullLabel: option.fullLabel,
    };
  }

  return {
    label: String(option ?? ''),
    value: String(option ?? ''),
  };
};

export const normalizeChatOptions = (options = []) =>
  (Array.isArray(options) ? options : [])
    .map(normalizeChatOption)
    .filter((option) => option.value || option.label);

export const normalizeAttachmentUrls = (
  imageUrls = [],
  limit = CHAT_ATTACHMENT_LIMIT,
) => {
  const seen = new Set();

  return (Array.isArray(imageUrls) ? imageUrls : [])
    .map((url) => (typeof url === 'string' ? url.trim() : ''))
    .filter(Boolean)
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .slice(0, limit);
};

const buildAttachmentContentPart = (attachment) => {
  if (!attachment?.dataUrl) return null;

  if (attachment.kind === 'image') {
    return {
      type: 'image_url',
      image_url: { url: attachment.dataUrl },
    };
  }

  return {
    type: 'file',
    file: {
      filename: attachment.name || 'attachment',
      file_data: attachment.dataUrl,
    },
  };
};

export const buildChatMessageContent = ({
  content,
  imageUrls = [],
  fileAttachments = [],
}) => {
  const textContent = typeof content === 'string' ? content : content || '';
  const validImageUrls = normalizeAttachmentUrls(imageUrls);
  const attachmentParts = (
    Array.isArray(fileAttachments) ? fileAttachments : []
  )
    .map(buildAttachmentContentPart)
    .filter(Boolean);

  if (
    !textContent &&
    validImageUrls.length === 0 &&
    attachmentParts.length === 0
  ) {
    return '';
  }

  if (validImageUrls.length > 0 || attachmentParts.length > 0) {
    return [
      { type: 'text', text: textContent || '' },
      ...validImageUrls.map((url) => ({
        type: 'image_url',
        image_url: { url: url.trim() },
      })),
      ...attachmentParts,
    ];
  }

  return textContent || '';
};

export const getChatModelCapabilities = (model) => {
  if (!model) {
    return {
      ...DEFAULT_CHAT_MODEL_CAPABILITIES,
      supportsImages: false,
      supportsStreaming: false,
      supportsReasoning: false,
    };
  }

  return CHAT_MODEL_CAPABILITY_RULES.reduce(
    (capabilities, rule) =>
      rule.match.test(model)
        ? { ...capabilities, ...rule.capabilities }
        : capabilities,
    { ...DEFAULT_CHAT_MODEL_CAPABILITIES },
  );
};

export const resolveChatRuntime = ({
  inputs = {},
  models = [],
  groups = [],
}) => {
  const modelOptions = normalizeChatOptions(models);
  const groupOptions = normalizeChatOptions(groups);
  const selectedModel = String(inputs.model || '');
  const selectedGroup = String(inputs.group || '');
  const capabilities = getChatModelCapabilities(selectedModel);
  const hasSelectedModel = Boolean(selectedModel);
  const hasKnownModel =
    !selectedModel ||
    modelOptions.length === 0 ||
    modelOptions.some((option) => option.value === selectedModel);
  const hasKnownGroup =
    !selectedGroup ||
    groupOptions.length === 0 ||
    groupOptions.some((option) => option.value === selectedGroup);

  return {
    selectedModel,
    selectedGroup,
    modelOptions,
    groupOptions,
    capabilities,
    hasSelectedModel,
    hasKnownModel,
    hasKnownGroup,
    canSend: hasSelectedModel && hasKnownModel && hasKnownGroup,
    sendDisabledReasonKey: !hasSelectedModel
      ? '请先选择模型'
      : !hasKnownModel
        ? '当前模型不可用，请重新选择'
        : !hasKnownGroup
          ? '当前分组不可用，请重新选择'
          : '',
    supportsImages: capabilities.supportsImages,
    supportsStreaming: capabilities.supportsStreaming,
    maxImageAttachments: capabilities.maxImageAttachments,
  };
};

export const createChatUserMessage = ({
  content,
  imageUrls = [],
  fileAttachments = [],
  messageAttachments = [],
}) => {
  const messageContent = buildChatMessageContent({
    content,
    imageUrls,
    fileAttachments,
  });

  return createMessage(
    MESSAGE_ROLES.USER,
    messageContent,
    messageAttachments.length > 0 ? { attachments: messageAttachments } : {},
  );
};

export const normalizeChatRequestInputs = (
  inputs = {},
  capabilities = DEFAULT_CHAT_MODEL_CAPABILITIES,
) => ({
  ...inputs,
  imageUrls: normalizeAttachmentUrls(
    inputs.imageUrls,
    capabilities.maxImageAttachments,
  ),
  imageEnabled: Boolean(
    capabilities.supportsImages && inputs.imageUrls?.length,
  ),
  stream: Boolean(capabilities.supportsStreaming && inputs.stream),
});

export const buildChatApiPayload = ({
  messages,
  inputs,
  parameterEnabled,
  capabilities,
  systemPrompt = null,
}) =>
  buildApiPayload(
    messages,
    systemPrompt,
    normalizeChatRequestInputs(inputs, capabilities),
    parameterEnabled,
  );
