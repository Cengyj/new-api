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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getTimestampId } from '../utils.js';
import {
  createChatSession,
  deriveChatSessionTitle,
  limitChatSessions,
  loadActiveChatSessionId,
  loadChatSessions,
  MAX_CHAT_SESSIONS,
  normalizeChatSessionInputs,
  saveChatSessions,
  syncChatSessions,
} from '../chatSessions.js';

export const useChatSessions = ({
  t,
  inputs,
  messages,
  setMessage,
  applyInputChange,
  closeMobileSidebar,
}) => {
  const defaultTitle = t('新对话');
  const imageTitle = t('图片对话');
  const [sessions, setSessions] = useState(() => syncChatSessions(loadChatSessions()));
  const [activeSessionId, setActiveSessionId] = useState(() =>
    loadActiveChatSessionId(),
  );
  const [sessionQuery, setSessionQuery] = useState('');
  const initializedRef = useRef(false);
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const inputsRef = useRef(inputs);
  const messagesRef = useRef(messages);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    inputsRef.current = inputs;
  }, [inputs]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const getSessionInputs = useCallback(
    (overrides = {}) =>
      normalizeChatSessionInputs({
        ...inputsRef.current,
        ...overrides,
      }),
    [],
  );

  const buildTitle = useCallback(
    (nextMessages) =>
      deriveChatSessionTitle(nextMessages, defaultTitle, { imageTitle }),
    [defaultTitle, imageTitle],
  );

  const commitSessions = useCallback((updater, nextActiveId) => {
    setSessions((prevSessions) => {
      const updatedSessions = limitChatSessions(
        typeof updater === 'function' ? updater(prevSessions) : updater,
        MAX_CHAT_SESSIONS,
      );
      sessionsRef.current = updatedSessions;
      const activeId = nextActiveId ?? activeSessionIdRef.current;
      saveChatSessions(updatedSessions, activeId);
      return updatedSessions;
    });
  }, []);

  const applySessionToView = useCallback(
    (session) => {
      const safeMessages = Array.isArray(session?.messages)
        ? session.messages
        : [];
      setMessage(safeMessages);
      Object.entries(normalizeChatSessionInputs(session?.inputs || {})).forEach(
        ([key, value]) => applyInputChange(key, value),
      );
      messagesRef.current = safeMessages;
    },
    [applyInputChange, setMessage],
  );

  const persistSessionSnapshot = useCallback(
    (sessionId, nextMessages = messagesRef.current, options = {}) => {
      if (!sessionId) return;
      const safeMessages = Array.isArray(nextMessages) ? nextMessages : [];
      const nextInputs = getSessionInputs(options.inputs || {});
      const now = new Date().toISOString();

      commitSessions((prevSessions) =>
        prevSessions.map((session) => {
          if (session.id !== sessionId) return session;

          return {
            ...session,
            messages: safeMessages,
            inputs: nextInputs,
            title:
              options.keepTitle && session.title
                ? session.title
                : buildTitle(safeMessages),
            updatedAt: now,
          };
        }),
      );
    },
    [buildTitle, commitSessions, getSessionInputs],
  );

  const ensureActiveSession = useCallback(
    (nextMessages = messagesRef.current) => {
      const currentId = activeSessionIdRef.current;
      if (currentId) return currentId;

      const newSession = createChatSession({
        id: getTimestampId('chat-session'),
        title: buildTitle(nextMessages),
        messages: Array.isArray(nextMessages) ? nextMessages : [],
        inputs: getSessionInputs(),
      });
      activeSessionIdRef.current = newSession.id;
      setActiveSessionId(newSession.id);
      commitSessions((prevSessions) => [newSession, ...prevSessions], newSession.id);
      return newSession.id;
    },
    [buildTitle, commitSessions, getSessionInputs],
  );

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const storedSessions = syncChatSessions(loadChatSessions());
    const storedActiveId = loadActiveChatSessionId();
    const active =
      storedSessions.find((session) => session.id === storedActiveId) ||
      storedSessions[0];

    if (active) {
      sessionsRef.current = storedSessions;
      activeSessionIdRef.current = active.id;
      setSessions(storedSessions);
      setActiveSessionId(active.id);
      applySessionToView(active);
      saveChatSessions(storedSessions, active.id);
      return;
    }

    const initialSession = createChatSession({
      id: getTimestampId('chat-session'),
      title: defaultTitle,
      messages: [],
      inputs: getSessionInputs(),
    });
    sessionsRef.current = [initialSession];
    activeSessionIdRef.current = initialSession.id;
    setSessions([initialSession]);
    setActiveSessionId(initialSession.id);
    setMessage([]);
    saveChatSessions([initialSession], initialSession.id);
  }, [applySessionToView, defaultTitle, getSessionInputs, setMessage]);

  const activeSession = useMemo(
    () =>
      sessions.find((session) => session.id === activeSessionId) ||
      sessions[0] ||
      null,
    [activeSessionId, sessions],
  );

  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) =>
      (session.title || defaultTitle).toLowerCase().includes(query),
    );
  }, [defaultTitle, sessionQuery, sessions]);

  const createNewChat = useCallback(() => {
    const currentMessages = messagesRef.current;
    const currentActiveId = activeSessionIdRef.current;
    if (currentActiveId && currentMessages.length > 0) {
      persistSessionSnapshot(currentActiveId, currentMessages);
    }

    if (currentActiveId && currentMessages.length === 0) {
      closeMobileSidebar?.();
      return currentActiveId;
    }

    const newSession = createChatSession({
      id: getTimestampId('chat-session'),
      title: defaultTitle,
      messages: [],
      inputs: getSessionInputs(),
    });

    activeSessionIdRef.current = newSession.id;
    setActiveSessionId(newSession.id);
    setMessage([]);
    messagesRef.current = [];
    commitSessions(
      (prevSessions) => [
        newSession,
        ...prevSessions.filter((session) => session.id !== newSession.id),
      ],
      newSession.id,
    );
    closeMobileSidebar?.();
    return newSession.id;
  }, [
    closeMobileSidebar,
    commitSessions,
    defaultTitle,
    getSessionInputs,
    persistSessionSnapshot,
    setMessage,
  ]);

  const activateSession = useCallback(
    (session) => {
      if (!session || session.id === activeSessionIdRef.current) {
        closeMobileSidebar?.();
        return;
      }

      const currentActiveId = activeSessionIdRef.current;
      if (currentActiveId) {
        persistSessionSnapshot(currentActiveId, messagesRef.current);
      }

      activeSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      applySessionToView(session);
      saveChatSessions(sessionsRef.current, session.id);
      closeMobileSidebar?.();
    },
    [applySessionToView, closeMobileSidebar, persistSessionSnapshot],
  );

  const deleteSession = useCallback(
    (sessionId) => {
      const remainingSessions = sessionsRef.current.filter(
        (session) => session.id !== sessionId,
      );

      if (remainingSessions.length === 0) {
        activeSessionIdRef.current = '';
        setActiveSessionId('');
        commitSessions([], '');
        createNewChat();
        return;
      }

      const nextActive =
        sessionId === activeSessionIdRef.current
          ? remainingSessions[0]
          : remainingSessions.find(
              (session) => session.id === activeSessionIdRef.current,
            ) || remainingSessions[0];

      sessionsRef.current = remainingSessions;
      activeSessionIdRef.current = nextActive.id;
      setActiveSessionId(nextActive.id);
      setSessions(remainingSessions);
      saveChatSessions(remainingSessions, nextActive.id);

      if (sessionId === activeSessionId) {
        applySessionToView(nextActive);
      }
    },
    [activeSessionId, applySessionToView, commitSessions, createNewChat],
  );

  const updateActiveSessionInputs = useCallback(
    (inputPatch) => {
      const currentActiveId = activeSessionIdRef.current;
      if (!currentActiveId) return;

      inputsRef.current = {
        ...inputsRef.current,
        ...inputPatch,
      };
      const nextInputs = getSessionInputs();
      commitSessions((prevSessions) =>
        prevSessions.map((session) =>
          session.id === currentActiveId
            ? {
                ...session,
                inputs: nextInputs,
              }
            : session,
        ),
      );
    },
    [commitSessions, getSessionInputs],
  );

  const saveMessagesWithSession = useCallback(
    (messagesToSave, options = {}) => {
      const safeMessages = Array.isArray(messagesToSave)
        ? messagesToSave
        : messagesRef.current;
      const sessionId = options.sessionId || ensureActiveSession(safeMessages);
      persistSessionSnapshot(sessionId, safeMessages, options);
    },
    [ensureActiveSession, persistSessionSnapshot],
  );

  return {
    sessions,
    activeSession,
    activeSessionId,
    filteredSessions,
    sessionQuery,
    setSessionQuery,
    getSessionInputs,
    updateActiveSessionInputs,
    ensureActiveSession,
    createNewChat,
    activateSession,
    deleteSession,
    saveMessagesWithSession,
    getCurrentMessages: () => messagesRef.current,
  };
};
