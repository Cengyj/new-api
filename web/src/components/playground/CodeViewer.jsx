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

import React, { useState, useMemo, useCallback } from 'react';
import { Button, Tooltip, Toast } from '@douyinfe/semi-ui';
import { Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { copy } from '../../helpers';

const PERFORMANCE_CONFIG = {
  MAX_DISPLAY_LENGTH: 50000, // 最大显示字符数
  PREVIEW_LENGTH: 5000, // 预览长度
  VERY_LARGE_MULTIPLIER: 2, // 超大内容倍数
};

const codeThemeStyles = {
  container: {
    backgroundColor:
      'var(--ai-chat-code-header-bg, var(--ai-chat-surface, var(--semi-color-bg-0)))',
    color: 'var(--ai-chat-text, var(--semi-color-text-0))',
    fontFamily: 'Consolas, "Courier New", Monaco, "SF Mono", monospace',
    fontSize: '13px',
    lineHeight: '1.4',
    borderRadius: '14px',
    border:
      '1px solid var(--ai-chat-code-block-border, var(--ai-chat-border, var(--semi-color-border)))',
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: 'var(--ai-chat-code-shadow, 0 8px 24px rgba(15, 23, 42, 0.06))',
  },
  header: {
    minHeight: '40px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '8px 10px 8px 14px',
    borderBottom:
      '1px solid var(--ai-chat-code-block-border, var(--ai-chat-border, var(--semi-color-border)))',
    background:
      'var(--ai-chat-code-header-bg, var(--ai-chat-surface, var(--semi-color-fill-0)))',
    color: 'var(--ai-chat-code-block-text, var(--semi-color-text-0))',
  },
  headerTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    fontWeight: 600,
  },
  headerMeta: {
    flexShrink: 0,
    padding: '2px 6px',
    borderRadius: '999px',
    border:
      '1px solid var(--ai-chat-code-block-border, var(--ai-chat-border, var(--semi-color-border)))',
    color: 'var(--ai-chat-code-block-text, var(--semi-color-text-2))',
    fontSize: '11px',
    lineHeight: 1.2,
    opacity: 0.78,
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'auto',
    padding: '16px',
    margin: 0,
    whiteSpace: 'pre',
    wordBreak: 'normal',
    background: 'var(--ai-chat-code-block-bg, var(--semi-color-fill-0))',
    color: 'var(--ai-chat-code-block-text, var(--semi-color-text-0))',
  },
  actionButton: {
    position: 'absolute',
    zIndex: 10,
    backgroundColor:
      'var(--ai-chat-code-header-bg, var(--ai-chat-surface, rgba(255, 255, 255, 0.92)))',
    border:
      '1px solid var(--ai-chat-code-block-border, var(--ai-chat-border, var(--semi-color-border)))',
    color:
      'var(--ai-chat-code-block-text, var(--ai-chat-text, var(--semi-color-text-0)))',
    borderRadius: '6px',
    transition: 'all 0.2s ease',
  },
  headerButton: {
    backgroundColor: 'transparent',
    border:
      '1px solid var(--ai-chat-code-block-border, var(--ai-chat-border, var(--semi-color-border)))',
    color:
      'var(--ai-chat-code-block-text, var(--ai-chat-text, var(--semi-color-text-0)))',
    borderRadius: '8px',
    transition: 'all 0.2s ease',
  },
  actionButtonHover: {
    backgroundColor: 'var(--ai-chat-bubble-hover, var(--semi-color-fill-1))',
    borderColor: 'var(--ai-chat-border-strong, var(--semi-color-border))',
    transform: 'scale(1.05)',
  },
  noContent: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--ai-chat-muted, var(--semi-color-text-2))',
    fontSize: '14px',
    fontStyle: 'italic',
    backgroundColor:
      'var(--ai-chat-code-block-bg, var(--ai-chat-surface, var(--semi-color-fill-0)))',
    border:
      '1px solid var(--ai-chat-code-block-border, var(--ai-chat-border, var(--semi-color-border)))',
    borderRadius: '14px',
  },
  performanceWarning: {
    padding: '8px 12px',
    backgroundColor: 'var(--ai-chat-bubble-user, rgba(15, 23, 42, 0.04))',
    border: '1px solid var(--ai-chat-border, rgba(15, 23, 42, 0.12))',
    borderRadius: '6px',
    color: 'var(--ai-chat-muted, var(--semi-color-text-1))',
    fontSize: '12px',
    margin: '8px 8px 0',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
};

const escapeHtml = (str) => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const highlightJson = (str) => {
  const tokenRegex =
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;

  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(str)) !== null) {
    // Escape non-token text (structural chars like {, }, [, ], :, comma, whitespace)
    result += escapeHtml(str.slice(lastIndex, match.index));

    const token = match[0];
    let color = 'var(--ai-chat-code-token-comment, var(--semi-color-text-2))';
    if (/^"/.test(token)) {
      color = /:$/.test(token)
        ? 'var(--ai-chat-code-token-title, var(--semi-color-primary))'
        : 'var(--ai-chat-code-token-string, var(--semi-color-success))';
    } else if (/true|false|null/.test(token)) {
      color = 'var(--ai-chat-code-token-number, var(--semi-color-warning))';
    }
    // Escape token content before wrapping in span
    result += `<span style="color: ${color}">${escapeHtml(token)}</span>`;
    lastIndex = tokenRegex.lastIndex;
  }

  // Escape remaining text
  result += escapeHtml(str.slice(lastIndex));
  return result;
};

const linkRegex = /(https?:\/\/(?:[^\s<"'\]),;&}]|&amp;)+)/g;

const linkifyHtml = (html) => {
  const parts = html.split(/(<[^>]+>)/g);
  return parts
    .map((part) => {
      if (part.startsWith('<')) return part;
      return part.replace(
        linkRegex,
        (url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`,
      );
    })
    .join('');
};

const isJsonLike = (content, language) => {
  if (language === 'json') return true;
  const trimmed = content.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
};

const formatContent = (content) => {
  if (!content) return '';

  if (typeof content === 'object') {
    try {
      return JSON.stringify(content, null, 2);
    } catch (e) {
      return String(content);
    }
  }

  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch (e) {
      return content;
    }
  }

  return String(content);
};

const CodeViewer = ({ content, title, language = 'json' }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [isHoveringCopy, setIsHoveringCopy] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const formattedContent = useMemo(() => formatContent(content), [content]);

  const contentMetrics = useMemo(() => {
    const length = formattedContent.length;
    const isLarge = length > PERFORMANCE_CONFIG.MAX_DISPLAY_LENGTH;
    const isVeryLarge =
      length >
      PERFORMANCE_CONFIG.MAX_DISPLAY_LENGTH *
        PERFORMANCE_CONFIG.VERY_LARGE_MULTIPLIER;
    return { length, isLarge, isVeryLarge };
  }, [formattedContent.length]);

  const displayContent = useMemo(() => {
    if (!contentMetrics.isLarge || isExpanded) {
      return formattedContent;
    }
    return (
      formattedContent.substring(0, PERFORMANCE_CONFIG.PREVIEW_LENGTH) +
      '\n\n// ... 内容被截断以提升性能 ...'
    );
  }, [formattedContent, contentMetrics.isLarge, isExpanded]);

  const highlightedContent = useMemo(() => {
    if (contentMetrics.isVeryLarge && !isExpanded) {
      return escapeHtml(displayContent);
    }

    if (isJsonLike(displayContent, language)) {
      return highlightJson(displayContent);
    }

    return escapeHtml(displayContent);
  }, [displayContent, language, contentMetrics.isVeryLarge, isExpanded]);

  const renderedContent = useMemo(() => {
    return linkifyHtml(highlightedContent);
  }, [highlightedContent]);

  const viewerTitle = useMemo(() => {
    const titleMap = {
      preview: t('预览请求体'),
      request: t('实际请求体'),
      response: t('响应'),
    };
    return titleMap[title] || title || t('代码');
  }, [title, t]);

  const languageLabel = (language || 'text').toUpperCase();

  const handleCopy = useCallback(async () => {
    try {
      const textToCopy =
        typeof content === 'object' && content !== null
          ? JSON.stringify(content, null, 2)
          : content;

      const success = await copy(textToCopy);
      setCopied(true);
      Toast.success(t('已复制到剪贴板'));
      setTimeout(() => setCopied(false), 2000);

      if (!success) {
        throw new Error('Copy operation failed');
      }
    } catch (err) {
      Toast.error(t('复制失败'));
      console.error('Copy failed:', err);
    }
  }, [content, t]);

  const handleToggleExpand = useCallback(() => {
    if (contentMetrics.isVeryLarge && !isExpanded) {
      setIsProcessing(true);
      setTimeout(() => {
        setIsExpanded(true);
        setIsProcessing(false);
      }, 100);
    } else {
      setIsExpanded(!isExpanded);
    }
  }, [isExpanded, contentMetrics.isVeryLarge]);

  if (!content) {
    const placeholderText =
      {
        preview: t('正在构造请求体预览...'),
        request: t('暂无请求数据'),
        response: t('暂无响应数据'),
      }[title] || t('暂无数据');

    return (
      <div style={codeThemeStyles.noContent}>
        <span>{placeholderText}</span>
      </div>
    );
  }

  const contentPadding = contentMetrics.isLarge ? '16px 16px 56px' : '16px';

  return (
    <div
      style={codeThemeStyles.container}
      className='ai-chat-code-viewer h-full'
    >
      <div
        style={codeThemeStyles.header}
        className='ai-chat-code-viewer-header'
      >
        <div style={codeThemeStyles.headerTitle}>{viewerTitle}</div>
        <div className='flex items-center gap-2'>
          <span style={codeThemeStyles.headerMeta}>{languageLabel}</span>
          <Tooltip content={copied ? t('已复制') : t('复制代码')}>
            <Button
              icon={<Copy size={14} />}
              onClick={handleCopy}
              size='small'
              theme='borderless'
              style={{
                ...codeThemeStyles.headerButton,
                ...(isHoveringCopy ? codeThemeStyles.actionButtonHover : {}),
                color: copied
                  ? 'var(--semi-color-success)'
                  : codeThemeStyles.headerButton.color,
                padding: '5px',
              }}
              onMouseEnter={() => setIsHoveringCopy(true)}
              onMouseLeave={() => setIsHoveringCopy(false)}
            />
          </Tooltip>
        </div>
      </div>
      {/* 性能警告 */}
      {contentMetrics.isLarge && (
        <div style={codeThemeStyles.performanceWarning}>
          <span>⚡</span>
          <span>
            {contentMetrics.isVeryLarge
              ? t('内容较大，已启用性能优化模式')
              : t('内容较大，部分功能可能受限')}
          </span>
        </div>
      )}

      {/* 代码内容 */}
      <div
        style={{
          ...codeThemeStyles.content,
          padding: contentPadding,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
        className='ai-chat-code-viewer-content model-settings-scroll'
      >
        {isProcessing ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '200px',
              color: 'var(--ai-chat-muted, var(--semi-color-text-2))',
            }}
          >
            <div
              style={{
                width: '20px',
                height: '20px',
                border:
                  '2px solid var(--ai-chat-code-block-border, var(--semi-color-border))',
                borderTop:
                  '2px solid var(--ai-chat-code-block-text, var(--semi-color-text-0))',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
                marginRight: '8px',
              }}
            />
            {t('正在处理大内容...')}
          </div>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: renderedContent }} />
        )}
      </div>

      {/* 展开/收起按钮 */}
      {contentMetrics.isLarge && !isProcessing && (
        <div
          style={{
            ...codeThemeStyles.actionButton,
            bottom: '12px',
            left: '50%',
            transform: 'translateX(-50%)',
          }}
        >
          <Tooltip content={isExpanded ? t('收起内容') : t('显示完整内容')}>
            <Button
              icon={
                isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />
              }
              onClick={handleToggleExpand}
              size='small'
              theme='borderless'
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                color: 'var(--ai-chat-text, var(--semi-color-text-0))',
                padding: '6px 12px',
              }}
            >
              {isExpanded ? t('收起') : t('展开')}
              {!isExpanded && (
                <span
                  style={{ fontSize: '11px', opacity: 0.7, marginLeft: '4px' }}
                >
                  (+
                  {Math.round(
                    (contentMetrics.length -
                      PERFORMANCE_CONFIG.PREVIEW_LENGTH) /
                      1000,
                  )}
                  K)
                </span>
              )}
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
};

export default CodeViewer;
