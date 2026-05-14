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
import { Toast } from '@douyinfe/semi-ui';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';

import { UserContext } from '../../context/User';
import { useIsMobile } from '../../hooks/common/useIsMobile';
import { usePlaygroundState } from '../../hooks/playground/usePlaygroundState';
import { useMessageActions } from '../../hooks/playground/useMessageActions';
import { useApiRequest } from '../../hooks/playground/useApiRequest';
import { useMessageEdit } from '../../hooks/playground/useMessageEdit';
import { useDataLoader } from '../../hooks/playground/useDataLoader';
import { useScenePreference } from '../../hooks/useScenePreference';
import { createLoadingAssistantMessage } from '../../helpers';
import ChatArea from '../../components/playground/ChatArea';
import { PlaygroundProvider } from '../../contexts/PlaygroundContext';
import ChatSidebar from './chat/ChatSidebar.jsx';
import ChatHeader from './chat/ChatHeader.jsx';
import ChatComposer from './chat/ChatComposer.jsx';
import ChatMessageFrame from './chat/ChatMessageFrame.jsx';
import ChatMessageActions from './chat/ChatMessageActions.jsx';
import {
  buildChatApiPayload,
  createChatUserMessage,
  normalizeChatOption,
  resolveChatRuntime,
} from './chat/chatModelRegistry.js';
import { isChatGenerating } from './chat/chatMessageUtils.js';
import {
  CHAT_ATTACHMENT_LIMIT,
  getFileIdentity,
  readAttachmentAsDataUrl,
  revokeAttachmentPreview,
  toStoredAttachment,
} from './chat/chatAttachments.js';
import { getSessionTimestampLabel } from './chatSessions.js';
import { useChatSessions } from './chat/useChatSessions.js';
import './chat/chatStyles.css';

const EMPTY_STATE_SUGGESTIONS = [
  { title: '代码重构', prompt: '帮我写一个清晰的实现方案' },
  { title: '原理解释', prompt: '解释一段复杂代码' },
  { title: '文案润色', prompt: '润色一封重要邮件' },
  { title: '测试用例', prompt: '生成一个测试用例清单' },
  { title: '创意写作', prompt: '帮我写一个关于科幻的故事大纲' },
];

const getOptionValue = (option) => normalizeChatOption(option).value;

const toApiAttachment = (attachment, dataUrl) => ({
  ...toStoredAttachment(attachment),
  dataUrl,
});

const getAttachmentIdentity = (attachment) =>
  getFileIdentity(attachment?.file || attachment);

const ChatTab = () => {
  const { t } = useTranslation();
  const [userState] = useContext(UserContext);
  const isMobile = useIsMobile();
  const styleState = useMemo(() => ({ isMobile }), [isMobile]);

  const state = usePlaygroundState({
    useDefaultMessages: false,
    useStoredMessages: false,
    persistMessages: false,
  });
  const {
    inputs,
    parameterEnabled,
    models,
    groups,
    groupModels,
    message,
    sseSourceRef,
    chatRef,
    handleInputChange,
    setModels,
    setGroups,
    setGroupModels,
    setMessage,
    setDebugData,
    setActiveDebugTab,
  } = state;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const attachmentsRef = useRef([]);
  const isGenerating = useMemo(() => isChatGenerating(message), [message]);

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);

  const {
    sessions,
    activeSession,
    activeSessionId,
    filteredSessions,
    sessionQuery,
    setSessionQuery,
    updateActiveSessionInputs,
    ensureActiveSession,
    createNewChat,
    activateSession,
    deleteSession,
    saveMessagesWithSession,
    getCurrentMessages,
  } = useChatSessions({
    t,
    inputs,
    messages: message,
    setMessage,
    applyInputChange: handleInputChange,
    closeMobileSidebar,
  });

  const handleChatInputChange = useCallback(
    (name, value) => {
      handleInputChange(name, value);
      updateActiveSessionInputs({ [name]: value });
    },
    [handleInputChange, updateActiveSessionInputs],
  );

  useDataLoader(
    userState,
    inputs,
    handleChatInputChange,
    setModels,
    setGroups,
    setGroupModels,
  );

  const allowedGroupSet = useMemo(
    () => new Set((groups || []).map((option) => getOptionValue(option))),
    [groups],
  );
  const allowedModelSet = useMemo(
    () => new Set((models || []).map((option) => getOptionValue(option))),
    [models],
  );
  const hasChatOptions = (models || []).length > 0 && (groups || []).length > 0;

  const hasGroupedModelMap = useMemo(
    () =>
      Object.values(groupModels || {}).some((list) => Array.isArray(list)),
    [groupModels],
  );

  const filteredGroups = useMemo(() => {
    if (!hasGroupedModelMap) return groups || [];

    return (groups || []).filter((option) => {
      const group = getOptionValue(option);
      const groupList = groupModels?.[group];
      return (
        Array.isArray(groupList) &&
        groupList.some((model) => allowedModelSet.has(String(model)))
      );
    });
  }, [allowedModelSet, groupModels, groups, hasGroupedModelMap]);

  const filteredGroupSet = useMemo(
    () => new Set(filteredGroups.map((option) => getOptionValue(option))),
    [filteredGroups],
  );

  const effectiveChatGroup = useMemo(() => {
    if (inputs.group && filteredGroupSet.has(inputs.group)) {
      return inputs.group;
    }
    return filteredGroups[0] ? getOptionValue(filteredGroups[0]) : '';
  }, [filteredGroupSet, filteredGroups, inputs.group]);

  const groupForModelScope = effectiveChatGroup || inputs.group;

  const { hydrated } = useScenePreference({
    scene: 'chat',
    inputs,
    handleInputChange: handleChatInputChange,
    allowedModelSet,
    allowedGroupSet:
      filteredGroupSet.size > 0 ? filteredGroupSet : allowedGroupSet,
    groupModels,
    ready: hasChatOptions,
  });

  const scopedModels = useMemo(() => {
    const groupList = groupForModelScope
      ? groupModels?.[groupForModelScope]
      : null;
    if (!hasGroupedModelMap) return models;
    if (!Array.isArray(groupList) || groupList.length === 0) return [];

    const allowedModels = new Set(groupList);
    return (models || []).filter((option) =>
      allowedModels.has(getOptionValue(option)),
    );
  }, [groupForModelScope, groupModels, hasGroupedModelMap, models]);

  const effectiveChatModel = useMemo(() => {
    if (
      inputs.model &&
      scopedModels.some((option) => getOptionValue(option) === inputs.model)
    ) {
      return inputs.model;
    }
    return scopedModels[0] ? getOptionValue(scopedModels[0]) : '';
  }, [inputs.model, scopedModels]);

  const effectiveInputs = useMemo(
    () => ({
      ...inputs,
      group: effectiveChatGroup,
      model: effectiveChatModel,
    }),
    [effectiveChatGroup, effectiveChatModel, inputs],
  );

  useEffect(() => {
    if (!hydrated) return;
    if (effectiveChatGroup && effectiveChatGroup !== inputs.group) {
      handleChatInputChange('group', effectiveChatGroup);
    }
  }, [
    effectiveChatGroup,
    handleChatInputChange,
    hydrated,
    inputs.group,
  ]);

  useEffect(() => {
    if (!hydrated) return;
    if (!inputs.model || scopedModels.length === 0) return;
    if (effectiveChatModel && effectiveChatModel !== inputs.model) {
      handleChatInputChange('model', effectiveChatModel);
    }
  }, [
    effectiveChatModel,
    handleChatInputChange,
    hydrated,
    inputs.model,
    scopedModels.length,
  ]);

  const chatRuntime = useMemo(
    () =>
      resolveChatRuntime({
        inputs: effectiveInputs,
        models: scopedModels,
        groups: filteredGroups,
      }),
    [effectiveInputs, filteredGroups, scopedModels],
  );

  const runtimeStatusText = useMemo(() => {
    if (!chatRuntime.hasSelectedModel) return t('请先选择模型');
    if (!chatRuntime.hasKnownModel) return t('当前模型不可用，请重新选择');
    if (!chatRuntime.hasKnownGroup) return t('当前分组不可用，请重新选择');
    if ((models || []).length === 0) return t('暂无可用模型');
    return '';
  }, [
    chatRuntime.hasKnownGroup,
    chatRuntime.hasKnownModel,
    chatRuntime.hasSelectedModel,
    models,
    t,
  ]);

  const { sendRequest, onStopGenerator } = useApiRequest(
    setMessage,
    setDebugData,
    setActiveDebugTab,
    sseSourceRef,
    saveMessagesWithSession,
  );

  const {
    editingMessageId,
    editValue,
    setEditValue,
    handleMessageEdit,
    handleEditSave,
    handleEditCancel,
  } = useMessageEdit(
    setMessage,
    inputs,
    parameterEnabled,
    sendRequest,
    saveMessagesWithSession,
  );

  const roleInfo = useMemo(
    () => ({
      user: { name: '', avatar: '' },
      assistant: { name: '', avatar: '' },
      system: { name: '', avatar: '' },
    }),
    [],
  );

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(
    () => () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
    },
    [],
  );

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach(revokeAttachmentPreview);
      return [];
    });
  }, []);

  const showGeneratingGuard = useCallback(() => {
    Toast.warning({
      content: t('生成中，请先停止再操作'),
      duration: 2,
    });
  }, [t]);

  const readAttachmentsForRequest = useCallback(async () => {
    if (attachments.length === 0) return [];

    const results = await Promise.allSettled(
      attachments.map(readAttachmentAsDataUrl),
    );
    const apiAttachments = results
      .map((result, index) =>
        result.status === 'fulfilled' && result.value
          ? toApiAttachment(attachments[index], result.value)
          : null,
      )
      .filter(Boolean);
    const failedCount = results.length - apiAttachments.length;

    if (failedCount > 0) {
      Toast.error({
        content: t('{{count}} 个附件读取失败，已跳过', { count: failedCount }),
        duration: 3,
      });
    }

    return apiAttachments;
  }, [attachments, t]);

  const onMessageSend = useCallback(
    async (content) => {
      const textContent =
        typeof content === 'string' ? content.trim() : content || '';

      if (isGenerating) {
        showGeneratingGuard();
        return;
      }

      if (!textContent && attachments.length === 0) {
        Toast.warning({
          content: t('请输入消息内容'),
          duration: 2,
        });
        return;
      }

      if (!chatRuntime.canSend) {
        Toast.warning({
          content: t(chatRuntime.sendDisabledReasonKey || '请先选择模型'),
          duration: 3,
        });
        return;
      }

      const apiAttachments = await readAttachmentsForRequest();
      if (!textContent && apiAttachments.length === 0) {
        Toast.warning({
          content: t('附件读取失败，请重新添加后再发送'),
          duration: 3,
        });
        return;
      }

      const storedAttachments = attachments.map(toStoredAttachment);
      const baseMessages = getCurrentMessages();
      const currentSessionId = ensureActiveSession(baseMessages);
      const uiUserMessage = createChatUserMessage({
        content: textContent,
        messageAttachments: storedAttachments,
      });
      const apiUserMessage = createChatUserMessage({
        content: textContent,
        fileAttachments: apiAttachments,
      });
      const nextMessages = [...baseMessages, uiUserMessage];
      const loadingMessage = createLoadingAssistantMessage();
      const messagesWithLoading = [...nextMessages, loadingMessage];
      const requestInputs = {
        ...effectiveInputs,
        imageEnabled: apiAttachments.some(
          (attachment) => attachment.kind === 'image',
        ),
        imageUrls: [],
      };
      const payload = buildChatApiPayload({
        messages: [...baseMessages, apiUserMessage],
        inputs: requestInputs,
        parameterEnabled,
        capabilities: chatRuntime.capabilities,
      });

      setMessage(messagesWithLoading);
      saveMessagesWithSession(messagesWithLoading, {
        sessionId: currentSessionId,
        inputs: {
          imageEnabled: false,
          imageUrls: [],
        },
      });
      sendRequest(payload, requestInputs.stream);
      clearAttachments();

      if ((inputs.imageUrls || []).length > 0 || inputs.imageEnabled) {
        handleChatInputChange('imageUrls', []);
        handleChatInputChange('imageEnabled', false);
      }
    },
    [
      attachments,
      chatRuntime.canSend,
      chatRuntime.capabilities,
      chatRuntime.sendDisabledReasonKey,
      clearAttachments,
      effectiveInputs,
      ensureActiveSession,
      getCurrentMessages,
      handleChatInputChange,
      isGenerating,
      parameterEnabled,
      readAttachmentsForRequest,
      saveMessagesWithSession,
      sendRequest,
      setMessage,
      showGeneratingGuard,
      t,
    ],
  );

  const messageActions = useMessageActions(
    message,
    setMessage,
    onMessageSend,
    saveMessagesWithSession,
  );

  const handleCreateNewChat = useCallback(() => {
    if (isGenerating) {
      showGeneratingGuard();
      return;
    }
    clearAttachments();
    createNewChat();
  }, [clearAttachments, createNewChat, isGenerating, showGeneratingGuard]);

  const handleSessionActivate = useCallback(
    (session) => {
      if (isGenerating && session?.id !== activeSessionId) {
        showGeneratingGuard();
        return;
      }
      clearAttachments();
      activateSession(session);
    },
    [
      activateSession,
      activeSessionId,
      clearAttachments,
      isGenerating,
      showGeneratingGuard,
    ],
  );

  const handleDeleteSession = useCallback(
    (sessionId) => {
      if (isGenerating) {
        showGeneratingGuard();
        return;
      }
      deleteSession(sessionId);
    },
    [deleteSession, isGenerating, showGeneratingGuard],
  );

  const renderCustomChatContent = useCallback(
    ({ message, className }) => (
      <ChatMessageFrame
        message={message}
        className={className}
        styleState={styleState}
        onToggleReasoningExpansion={(id) =>
          setMessage((prev) =>
            prev.map((m) =>
              m.id === id
                ? { ...m, isReasoningExpanded: !m.isReasoningExpanded }
                : m,
            ),
          )
        }
        isEditing={editingMessageId === message.id}
        onEditSave={handleEditSave}
        onEditCancel={handleEditCancel}
        editValue={editValue}
        onEditValueChange={setEditValue}
      />
    ),
    [
      editValue,
      editingMessageId,
      handleEditCancel,
      handleEditSave,
      setEditValue,
      setMessage,
      styleState,
    ],
  );

  const renderInputAreaOverride = useCallback(
    (props) => <ChatComposer {...props} />,
    [],
  );

  const renderChatBoxAction = useCallback(
    (props) => (
      <ChatMessageActions
        message={props.message}
        styleState={styleState}
        onMessageReset={messageActions.handleMessageReset}
        onMessageCopy={messageActions.handleMessageCopy}
        onMessageDelete={messageActions.handleMessageDelete}
        onRoleToggle={messageActions.handleRoleToggle}
        onMessageEdit={handleMessageEdit}
        isAnyMessageGenerating={isGenerating}
        isEditing={editingMessageId === props.message.id}
      />
    ),
    [
      editingMessageId,
      handleMessageEdit,
      isGenerating,
      messageActions,
      styleState,
    ],
  );

  const sendDisabledReason = chatRuntime.sendDisabledReasonKey
    ? t(chatRuntime.sendDisabledReasonKey)
    : '';

  const appendChatAttachments = useCallback((incomingAttachments) => {
    const incoming = Array.isArray(incomingAttachments)
      ? incomingAttachments
      : [incomingAttachments].filter(Boolean);
    if (incoming.length === 0) return;

    setAttachments((prev) => {
      const seen = new Set(prev.map(getAttachmentIdentity));
      const merged = [...prev];

      for (const attachment of incoming) {
        const identity = getAttachmentIdentity(attachment);
        if (seen.has(identity)) {
          revokeAttachmentPreview(attachment);
          continue;
        }
        seen.add(identity);
        merged.push(attachment);
      }

      const kept = merged.slice(0, CHAT_ATTACHMENT_LIMIT);
      merged.slice(CHAT_ATTACHMENT_LIMIT).forEach(revokeAttachmentPreview);
      return kept;
    });
  }, []);

  const removeChatAttachment = useCallback((idOrIndex) => {
    setAttachments((prev) =>
      prev.filter((attachment, index) => {
        const shouldRemove = (attachment.id || index) === idOrIndex;
        if (shouldRemove) revokeAttachmentPreview(attachment);
        return !shouldRemove;
      }),
    );
  }, []);

  const playgroundContextValue = useMemo(
    () => ({
      onAddAttachments: appendChatAttachments,
      onRemoveAttachment: removeChatAttachment,
      attachments,
      maxAttachments: CHAT_ATTACHMENT_LIMIT,
      maxImageAttachments: chatRuntime.maxImageAttachments,
      imageEnabled: true,
      isGenerating,
      onStopGenerator,
      canSend: chatRuntime.canSend,
      sendDisabledReason,
    }),
    [
      appendChatAttachments,
      attachments,
      chatRuntime.canSend,
      chatRuntime.maxImageAttachments,
      isGenerating,
      onStopGenerator,
      removeChatAttachment,
      sendDisabledReason,
    ],
  );

  const emptyStateDescription = runtimeStatusText
    ? runtimeStatusText
    : t('我是您的 AI 助手，可以回答问题、编写代码、润色文章等。');

  return (
    <PlaygroundProvider value={playgroundContextValue}>
      <div className='ai-chat-layout'>
        <ChatSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          filteredSessions={filteredSessions}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
          isMobile={isMobile}
          mobileSidebarOpen={mobileSidebarOpen}
          setMobileSidebarOpen={setMobileSidebarOpen}
          handleCreateNewChat={handleCreateNewChat}
          handleSessionActivate={handleSessionActivate}
          handleDeleteSession={handleDeleteSession}
          sessionQuery={sessionQuery}
          setSessionQuery={setSessionQuery}
          isGenerating={isGenerating}
        />

        <main className='ai-chat-main'>
          <ChatHeader
            isMobile={isMobile}
            sidebarCollapsed={sidebarCollapsed}
            setSidebarCollapsed={setSidebarCollapsed}
            setMobileSidebarOpen={setMobileSidebarOpen}
            models={scopedModels}
            groups={filteredGroups}
            inputs={effectiveInputs}
            handleInputChange={handleChatInputChange}
            activeTitle={activeSession?.title || t('新对话')}
            updatedAtLabel={getSessionTimestampLabel(activeSession, t)}
            isGenerating={isGenerating}
            runtimeStatusText={runtimeStatusText}
          />

          <div className='ai-chat-stage'>
            {message.length === 0 && (
              <div className='ai-chat-empty-state'>
                <div className='ai-chat-empty-mark'>
                  <Sparkles size={32} />
                </div>
                <h1>{t('今天需要什么帮助？')}</h1>
                <p>{emptyStateDescription}</p>
                <div className='ai-chat-suggestion-grid'>
                  {EMPTY_STATE_SUGGESTIONS.map((item) => (
                    <button
                      key={item.title}
                      type='button'
                      className='ai-chat-suggestion-card'
                      disabled={isGenerating || !chatRuntime.canSend}
                      title={sendDisabledReason || t(item.prompt)}
                      onClick={() => onMessageSend(item.prompt)}
                    >
                      <span>{t(item.title)}</span>
                      <small>{t(item.prompt)}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <ChatArea
              chatRef={chatRef}
              message={message}
              inputs={effectiveInputs}
              styleState={styleState}
              showDebugPanel={false}
              roleInfo={roleInfo}
              onMessageSend={onMessageSend}
              onMessageCopy={messageActions.handleMessageCopy}
              onMessageReset={messageActions.handleMessageReset}
              onMessageDelete={messageActions.handleMessageDelete}
              onStopGenerator={onStopGenerator}
              onToggleDebugPanel={() => {}}
              renderCustomChatContent={renderCustomChatContent}
              renderChatBoxAction={renderChatBoxAction}
              renderInputAreaOverride={renderInputAreaOverride}
              showClearContext={false}
              showStopGenerate={false}
              enableUpload={false}
              hideHeader
              bodyHeight='100%'
              className='ai-chat-area'
            />
          </div>
        </main>
      </div>
    </PlaygroundProvider>
  );
};

export default ChatTab;
