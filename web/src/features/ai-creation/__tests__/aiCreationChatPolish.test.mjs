import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aiCreationDir = path.resolve(__dirname, '..');
const srcDir = path.resolve(aiCreationDir, '..', '..');

const chatStyles = fs.readFileSync(
  path.join(aiCreationDir, 'chat/chatStyles.css'),
  'utf8',
);
const aiChatPage = fs.readFileSync(
  path.join(srcDir, 'pages/AiCreation/Chat.jsx'),
  'utf8',
);
const markdownRenderer = fs.readFileSync(
  path.join(srcDir, 'components/common/markdown/MarkdownRenderer.jsx'),
  'utf8',
);
const codeViewer = fs.readFileSync(
  path.join(srcDir, 'components/playground/CodeViewer.jsx'),
  'utf8',
);
const chatComposer = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatComposer.jsx'),
  'utf8',
);
const chatHeader = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatHeader.jsx'),
  'utf8',
);
const chatSidebar = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatSidebar.jsx'),
  'utf8',
);
const chatMessageFrame = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatMessageFrame.jsx'),
  'utf8',
);
const chatMessageActions = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatMessageActions.jsx'),
  'utf8',
);
const chatModelMenu = fs.readFileSync(
  path.join(aiCreationDir, 'chat/ChatModelMenu.jsx'),
  'utf8',
);
const chatModelRegistry = fs.readFileSync(
  path.join(aiCreationDir, 'chat/chatModelRegistry.js'),
  'utf8',
);
const chatAttachments = fs.readFileSync(
  path.join(aiCreationDir, 'chat/chatAttachments.js'),
  'utf8',
);
const chatTab = fs.readFileSync(
  path.join(aiCreationDir, 'ChatTab.jsx'),
  'utf8',
);
const chatArea = fs.readFileSync(
  path.join(srcDir, 'components/playground/ChatArea.jsx'),
  'utf8',
);
const studioPrimitivesPath = path.join(aiCreationDir, 'StudioPrimitives.jsx');

const assertIncludes = (source, expected, message) => {
  assert.ok(source.includes(expected), message || `expected ${expected}`);
};

assertIncludes(
  chatArea,
  'renderInputAreaOverride',
  'ChatArea must expose a renderInputAreaOverride extension point.',
);
assertIncludes(
  chatArea,
  'enableUpload = true',
  'ChatArea must keep Semi upload support enabled by default.',
);
assertIncludes(
  chatArea,
  'enableUpload={enableUpload}',
  'ChatArea must allow page-specific control over Semi upload handling.',
);
assertIncludes(
  chatTab,
  'showClearContext={false}',
  'AI creation chat must disable Semi clear-context rendering.',
);
assertIncludes(
  chatTab,
  'showStopGenerate={false}',
  'AI creation chat must disable Semi built-in stop button rendering.',
);
assertIncludes(
  chatTab,
  'enableUpload={false}',
  'AI creation chat must let its dedicated composer own paste-upload behavior.',
);
assertIncludes(
  chatTab,
  'renderInputAreaOverride={renderInputAreaOverride}',
  'AI creation chat must render the dedicated composer through ChatArea.',
);
assertIncludes(
  chatComposer,
  'ai-chat-composer-shell',
  'AI creation chat must keep a dedicated composer shell for page-only styling.',
);
assertIncludes(
  chatComposer,
  'ArrowUp',
  'AI creation composer must force the right action to a send button.',
);
assertIncludes(
  chatComposer,
  'ai-chat-composer-plus',
  'AI creation composer must use a compact plus action instead of management controls.',
);
assertIncludes(
  chatComposer,
  'getClipboardImageFiles',
  'AI creation composer must explicitly detect clipboard image files.',
);
assertIncludes(
  chatComposer,
  'getClipboardFiles',
  'AI creation composer must collect pasted files without taking over plain text paste.',
);
assertIncludes(
  chatComposer,
  'hasClipboardText',
  'AI creation composer must preserve native text paste behavior.',
);
assertIncludes(
  chatComposer,
  'if (clipboardFiles.length === 0 && !hasImages) return;',
  'Pure text and multiline code paste must stay native and avoid attachment interception.',
);
assertIncludes(
  chatComposer,
  'if (!hasClipboardText(clipboardData))',
  'File-only paste should be intercepted without stealing text+file clipboard text.',
);
assertIncludes(
  chatComposer,
  'buildAttachmentRecord',
  'AI creation composer must create generic attachment records for all file types.',
);
assertIncludes(
  chatComposer,
  'onAddAttachments',
  'AI creation composer must publish generic attachments through the attachment context.',
);
assertIncludes(
  chatComposer,
  'fileInputRef.current?.click()',
  'AI creation composer must keep file picking inside the dedicated composer.',
);
assertIncludes(
  chatComposer,
  'attachments.map',
  'AI creation composer must render generic attachment cards before send.',
);
assertIncludes(
  chatTab,
  'readAttachmentAsDataUrl',
  'AI creation chat must read attachment bytes only when the user sends.',
);
assertIncludes(
  chatModelRegistry,
  'file_data',
  'AI creation chat must send generic files through official file content parts.',
);
assertIncludes(
  chatModelRegistry,
  "type: 'file'",
  'AI creation chat must serialize PDF/DOCX/other files as file content parts.',
);
assertIncludes(
  chatAttachments,
  "kind = isImageFile(file) ? 'image' : 'file'",
  'AI creation attachments must classify non-images as files instead of rejecting them.',
);
assertIncludes(
  chatAttachments,
  'readAsDataURL(attachment.file)',
  'AI creation attachments must upload bytes on send without parsing file content into prompt text.',
);
assertIncludes(
  chatComposer,
  'onDragOver={handleDragOver}',
  'AI creation composer must support GPT-style drag/drop files.',
);
assertIncludes(
  chatComposer,
  'addFiles(droppedFiles)',
  'AI creation composer must add dropped PDF/DOCX/other files through the same generic path.',
);
assertIncludes(
  chatTab,
  'messageAttachments',
  'AI creation chat must keep lightweight attachment metadata on the UI message.',
);
assertIncludes(
  chatTab,
  'clearAttachments',
  'AI creation chat must clear file attachments after send/session changes.',
);
assertIncludes(
  chatComposer,
  'FILE_INPUT_ACCEPT',
  'AI creation composer file picker must allow all files as attachments.',
);
assertIncludes(
  chatComposer,
  'accept={FILE_INPUT_ACCEPT}',
  'AI creation composer must not leave the file picker image-only.',
);
assertIncludes(
  chatTab,
  'Promise.allSettled',
  'AI creation chat must include partial-success handling for attachment reads.',
);
assertIncludes(
  chatTab,
  'Promise.allSettled',
  'AI creation chat must allow partial success when reading multiple attachments.',
);
assertIncludes(
  chatTab,
  'if (!textContent && attachments.length === 0)',
  'AI creation chat must still allow attachment-only sends when attachments exist.',
);
assert.ok(
  !chatComposer.includes('dataUrls.forEach((base64) => onPasteImage(base64));'),
  'AI creation composer should not append pasted images through the old repeated update path.',
);
assert.ok(
  !chatComposer.includes("aria-label={t('上传图片')}"),
  'AI creation composer attachment action should not be labelled as image-only.',
);
assert.ok(
  !chatComposer.includes("t('{{count}} 张参考图'"),
  'AI creation composer attachment strip should not call chat attachments reference images.',
);
assert.ok(
  !chatComposer.includes('clearContextNode'),
  'AI creation composer must not receive or clone the clear-context node.',
);
assertIncludes(
  chatArea,
  'showStopGenerate = true',
  'ChatArea must keep the legacy built-in stop button enabled by default.',
);
assertIncludes(
  chatArea,
  'showStopGenerate={showStopGenerate}',
  'ChatArea must pass the configurable stop button flag to Semi Chat.',
);
assert.ok(
  !fs.existsSync(studioPrimitivesPath),
  'AI creation must not keep the removed StudioPrimitives compatibility shell.',
);
assertIncludes(
  chatHeader,
  'ChatModelMenu',
  'AI creation chat header must use the compact ChatGPT-style model menu.',
);
assert.ok(
  !chatHeader.includes('ModelGroupControls'),
  'AI creation chat header must not render two adjacent model/group selects.',
);
assert.ok(
  !chatHeader.includes('messageCountLabel'),
  'AI creation chat header must not keep a persistent message count.',
);
assertIncludes(
  chatTab,
  'ChatMessageActions',
  'AI creation chat must use page-specific message actions.',
);
assertIncludes(
  chatMessageFrame,
  "userMarkdownClassName='ai-chat-message-user-markdown'",
  'AI creation user markdown must use the page-specific markdown class.',
);
assertIncludes(
  chatMessageFrame,
  "hasAttachments && 'has-attachments'",
  'AI creation message frame must mark messages that carry attachments.',
);
assertIncludes(
  chatMessageFrame,
  "isAttachmentOnly && 'is-attachment-only'",
  'AI creation message frame must avoid rendering an empty user bubble for attachment-only sends.',
);
assertIncludes(
  chatMessageFrame,
  'isChatMessageGenerating',
  'AI creation assistant loading placeholders must use the shared chat generating status helper.',
);
assertIncludes(
  chatMessageFrame,
  'ai-chat-message-assistant-placeholder',
  'AI creation assistant messages must keep an AI Creation-scoped visible placeholder while streaming starts.',
);
assertIncludes(
  chatMessageActions,
  'onMessageDelete',
  'AI creation message actions must keep the delete action wired.',
);
assertIncludes(
  chatMessageActions,
  "className='ai-chat-menu ai-chat-message-menu'",
  'AI creation message actions must use the shared compact menu surface.',
);
assertIncludes(
  chatModelMenu,
  "className='ai-chat-menu ai-chat-model-menu'",
  'AI creation model picker must use the shared compact menu surface.',
);
assert.ok(
  !chatSidebar.includes('ai-chat-sidebar-mark'),
  'AI creation chat sidebar should not render the decorative title mark.',
);
assert.ok(
  !chatSidebar.includes('ai-chat-sidebar-foot'),
  'AI creation chat sidebar should not render the old footer count.',
);
assertIncludes(
  aiChatPage,
  "style={{ background: 'var(--semi-color-bg-0)' }}",
  'AI chat page shell should follow the current Semi theme background.',
);

for (const required of [
  '--ai-chat-page: var(--semi-color-bg-0, #ffffff);',
  '--ai-chat-rail: var(--semi-color-fill-0, #f7f7f8);',
  '--ai-chat-text: var(--semi-color-text-0, #0d0d0d);',
  '--ai-chat-code-border: var(--semi-color-border, #d9d9d9);',
  '--ai-chat-code-block-bg: var(--semi-color-fill-0, #f7f7f8);',
  '--ai-chat-code-header-bg: var(--semi-color-fill-1, #ececec);',
  '--ai-chat-radius-sm: 6px;',
  'background: var(--ai-chat-surface);',
  '.ai-chat-area .semi-chat-chatBox {\n  display: flex;\n  width: 100%;',
  'max-width: none !important;',
  'width: min(780px, 100%);',
  'border-radius: var(--ai-chat-radius-md)',
  'background: transparent !important;',
  'background-color 180ms ease',
  '.markdown-code-shell',
  '.ai-chat-code-viewer-content',
  "body[theme-mode='dark'] .ai-chat-layout",
  'html.dark .ai-chat-layout',
  '--ai-chat-code-token-comment: #6e7781;',
  '--ai-chat-code-token-keyword: #0550ae;',
  '--ai-chat-code-token-string: #0a3069;',
  '--ai-chat-code-token-number: #cf222e;',
  '.ai-chat-attachment-strip',
  '.ai-chat-attachment-strip-head',
  '.ai-chat-attachment-label',
  '.ai-chat-file-attachment',
  '.ai-chat-file-attachment-meta',
  'width: min(176px, 100%);',
  'height: 48px;',
  'width: 28px;',
  'overflow-x: auto;',
  '.ai-chat-area .semi-chat-chatBox-right',
  'justify-content: flex-end;',
  '.ai-chat-area .semi-chat-chatBox:not(.semi-chat-chatBox-right)',
  'align-items: flex-start;',
  'margin-left: auto;',
  '.ai-chat-message-frame-user',
  '.ai-chat-message-frame-user.has-attachments',
  '.ai-chat-message-frame-assistant',
  '.ai-chat-message-assistant-placeholder',
  '.ai-chat-message-loading-dot',
  '.ai-chat-message-frame-user.is-attachment-only .ai-chat-message-attachments',
  'display: inline-block;',
  'border: 1px solid var(--ai-chat-bubble-user-border);',
  'box-shadow: none !important;',
  'color: var(--ai-chat-text) !important;',
  '--tw-prose-body: var(--ai-chat-text);',
  '.ai-chat-message-frame-user .ai-chat-message-attachments',
  'max-width: min(176px, 100%);',
  '.ai-chat-message-user-markdown',
  '.ai-chat-menu',
  '.ai-chat-menu-item',
  '.ai-chat-model-trigger',
  '.ai-chat-model-menu',
  '.ai-chat-message-menu',
  '.markdown-html-preview',
  '.markdown-html-preview-header',
  '.markdown-html-preview-frame',
  '.ai-chat-session-group + .ai-chat-session-group',
  '.ai-chat-sidebar-action-row',
  '.ai-chat-search-close',
  '.ai-chat-composer-send.semi-button .semi-button-content',
  '.ai-chat-composer-action.ai-chat-composer-plus',
  'ChatGPT-style, theme-following chat polish',
  '@media (max-width: 767px)',
]) {
  assertIncludes(
    chatStyles,
    required,
    `chat polish CSS must include ${required}`,
  );
}

const modelTriggerBlock =
  chatStyles.match(
    /\.ai-chat-model-trigger\.semi-button\s*\{[\s\S]*?\}/,
  )?.[0] || '';
assertIncludes(
  modelTriggerBlock,
  'background: var(--ai-chat-surface-raised) !important;',
  'AI creation chat model/group trigger must use a solid surface.',
);
assert.ok(
  !modelTriggerBlock.includes('background: transparent !important;'),
  'AI creation chat model/group trigger must not be transparent.',
);

for (const required of [
  'const codeThemeVars = {',
  'var(--ai-chat-code-block-bg, var(--semi-color-fill-0))',
  'var(--ai-chat-code-bg, var(--semi-color-fill-1))',
  'var(--ai-chat-code-header-bg, var(--ai-chat-surface, var(--semi-color-fill-0)))',
  'backgroundColor: codeThemeVars.codeBlockBg',
  'backgroundColor: codeThemeVars.inlineCodeBg',
  'codeBlockBorder:',
  "className='markdown-code-shell'",
  "className='markdown-code-header'",
  'data-language={languageLabel ||',
  'getCodeLanguage',
  "setMermaidCode('');",
  "setHtmlCode('');",
  "const HTML_PREVIEW_LANGUAGES = new Set(['html', 'htm', 'svg', 'xml']);",
  'shouldPreviewHtml',
  "className='markdown-html-preview'",
  "className='markdown-html-preview-header'",
  "className='markdown-html-preview-frame'",
  "t('HTML 预览')",
  'const { inline, className, children } = props;',
]) {
  assertIncludes(
    markdownRenderer,
    required,
    `MarkdownRenderer must include ${required}`,
  );
}

for (const required of [
  'var(--ai-chat-surface, var(--semi-color-bg-0))',
  'var(--ai-chat-code-block-bg, var(--semi-color-fill-0))',
  'var(--ai-chat-code-header-bg',
  'var(--ai-chat-code-block-border',
  'var(--ai-chat-code-block-text, var(--semi-color-text-0))',
  'ai-chat-code-viewer',
  'codeThemeStyles.header',
  'var(--ai-chat-code-token-string',
  'var(--ai-chat-code-token-number',
]) {
  assertIncludes(codeViewer, required, `CodeViewer must include ${required}`);
}

for (const deprecated of [
  '--ai-chat-accent: #2563eb;',
  'from-purple-500',
  'bg-[#f5f6fa]',
  'background: var(--ai-chat-primary) !important;\n  color: #ffffff !important;',
  '.ai-chat-composer-plus .semi-button::before',
  "content: '+';",
  '#1e1e1e',
  '#d4d4d4',
  '.ai-chat-sidebar-foot',
  '.ai-chat-sidebar-mark',
  '.ai-chat-area .semi-chat-chatBox {\n  width: min(780px, 100%);',
  'HTML预览:',
  "querySelector('code.language-html')",
  '.ai-chat-message-user .user-message',
  'inset 0 0 0 9999px',
]) {
  assert.ok(
    !chatStyles.includes(deprecated),
    `chat polish CSS should avoid old colorful/heavy treatment: ${deprecated}`,
  );
}

for (const deprecated of ['#1e1e1e', '#d4d4d4', '#9cdcfe']) {
  assert.ok(
    !codeViewer.includes(deprecated),
    `CodeViewer should avoid hardcoded VS Code dark palette: ${deprecated}`,
  );
}

console.log('ai-creation chat polish guard passed');
