import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aiCreationDir = path.resolve(__dirname, '..');

const chatStyles = fs.readFileSync(
  path.join(aiCreationDir, 'chat/chatStyles.css'),
  'utf8',
);
const chatComposer = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatComposer.jsx'),
  'utf8',
);
const chatSidebar = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatSidebar.jsx'),
  'utf8',
);
const chatModelMenu = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatModelMenu.jsx'),
  'utf8',
);
const chatMessageActions = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatMessageActions.jsx'),
  'utf8',
);
const chatMessageFrame = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatMessageFrame.jsx'),
  'utf8',
);

const assertIncludes = (source, expected, message) => {
  assert.ok(source.includes(expected), message || `expected ${expected}`);
};

for (const required of [
  "type='button'",
  "aria-label={t('添加附件')}",
  "aria-label={t('移除附件')}",
  "aria-live='polite'",
  'tabIndex={-1}',
  'title={uploadTitle}',
]) {
  assertIncludes(
    chatComposer,
    required,
    `composer accessibility guard must include ${required}`,
  );
}

for (const required of [
  '.ai-chat-composer-action:focus-visible',
  '.ai-chat-attachment-remove:focus-visible',
  '.ai-chat-message-attachment-text strong',
  '.ai-chat-message-attachment-text small',
  '.ai-chat-sidebar-overlay.open',
  '@media (max-width: 767px)',
  '.ai-chat-composer-shell',
  '.ai-chat-menu-item:focus-visible',
  '.ai-chat-message-action-button.semi-button:focus-visible',
  '.ai-chat-session-more:focus-visible',
]) {
  assertIncludes(
    chatStyles,
    required,
    `chat polish CSS must include ${required}`,
  );
}

for (const required of [
  "title={attachment.name || t('未命名文件')}",
  "aria-live={isAssistantGenerating ? 'polite' : undefined}",
  "className='ai-chat-message-attachment-text'",
  "className='ai-chat-message-attachment-icon'",
]) {
  assertIncludes(
    chatMessageFrame,
    required,
    `message attachment accessibility guard must include ${required}`,
  );
}

for (const required of [
  "aria-label={t('",
  "aria-current={isActive ? 'page' : undefined}",
  "aria-haspopup='menu'",
  'aria-expanded={openSessionMenuId === session.id}',
  "role='menu'",
  "role='menuitem'",
]) {
  assertIncludes(
    chatSidebar,
    required,
    `sidebar accessibility guard must include ${required}`,
  );
}

for (const required of [
  "aria-label={t('",
  "aria-haspopup='menu'",
  'aria-expanded={open}',
  "role='menu'",
  "role='menuitemradio'",
  'aria-checked={selected}',
]) {
  assertIncludes(
    chatModelMenu,
    required,
    `model menu accessibility guard must include ${required}`,
  );
}

for (const required of [
  "aria-label={t('",
  "aria-haspopup='menu'",
  'aria-expanded={menuOpen}',
  "role='menu'",
  "role='menuitem'",
]) {
  assertIncludes(
    chatMessageActions,
    required,
    `message action accessibility guard must include ${required}`,
  );
}

console.log('ai-creation chat accessibility guard passed');
