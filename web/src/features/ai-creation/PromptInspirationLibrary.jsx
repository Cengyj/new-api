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

import React from 'react';
import clsx from 'clsx';

import { CreationMediaGrid, CreationPagination } from './AiCreationShared.jsx';

export { PROMPT_LIBRARY_SOURCE } from './promptLibrary/zhCNPromptLibrary.js';

const hasMeaningfulChinese = (value = '') => {
  const cjkMatches = String(value).match(/[\u3400-\u9fff\uf900-\ufaff]/gu);
  return (cjkMatches?.length || 0) >= 6;
};

const getCjkCount = (value = '') =>
  String(value).match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length || 0;

const getLatinLetterCount = (value = '') =>
  String(value).match(/[A-Za-z]/g)?.length || 0;

const hasJapaneseKana = (value = '') => /[\u3040-\u30ff]/u.test(String(value));

const isCleanChinesePrompt = (value = '') => {
  const prompt = String(value);
  const cjkCount = getCjkCount(prompt);
  if (!hasMeaningfulChinese(prompt) || hasJapaneseKana(prompt)) return false;
  return getLatinLetterCount(prompt) / Math.max(1, cjkCount) <= 0.3;
};

const looksJsonPrompt = (value = '') => {
  const prompt = String(value).trim();
  if (!prompt || !/^[{[]/.test(prompt)) return false;
  try {
    JSON.parse(prompt);
    return true;
  } catch {
    return /^[{[][\s\S]*["'][\w-]+["']\s*:/.test(prompt);
  }
};

export function getChinesePromptItems(items = []) {
  return items.filter(
    (item) =>
      item?.prompt &&
      item.promptLanguage === 'zh-CN' &&
      !item.needsTranslation &&
      !item.translationFailed &&
      isCleanChinesePrompt(item.prompt) &&
      !looksJsonPrompt(item.prompt),
  );
}

export default function PromptInspirationLibrary({
  items = [],
  visibleItems = items,
  categories = [],
  activeCategory = 'all',
  onCategoryChange,
  gridRef,
  pagination,
  onApplyPrompt,
  onPreviewImage,
  t,
}) {
  const translate = typeof t === 'function' ? t : (value) => value;
  const categoryCounts = new Map();
  items.forEach((item) => {
    if (!item?.category) return;
    categoryCounts.set(
      item.category,
      (categoryCounts.get(item.category) || 0) + 1,
    );
  });
  const categoryOptions = (
    categories.length
      ? categories
      : Array.from(categoryCounts.keys()).map((key) => ({ key, label: key }))
  ).filter((category) => categoryCounts.has(category.key));

  return (
    <section className='prompt-inspiration-library'>
      <div className='prompt-inspiration-library__header'>
        <div className='prompt-inspiration-library__titleline'>
          <h2 className='prompt-inspiration-library__title'>
            {translate('创作灵感')}
          </h2>
        </div>
        {categoryOptions.length > 0 ? (
          <div
            className='prompt-inspiration-library__categories'
            aria-label={translate('分类')}
          >
            <button
              type='button'
              className={clsx(
                'prompt-inspiration-library__chip',
                activeCategory === 'all' && 'is-active',
              )}
              aria-pressed={activeCategory === 'all'}
              onClick={() => onCategoryChange?.('all')}
            >
              <span>{translate('全部')}</span>
              <span className='prompt-inspiration-library__chip-count'>
                {items.length}
              </span>
            </button>
            {categoryOptions.map((category) => (
              <button
                key={category.key}
                type='button'
                className={clsx(
                  'prompt-inspiration-library__chip',
                  activeCategory === category.key && 'is-active',
                )}
                aria-pressed={activeCategory === category.key}
                onClick={() => onCategoryChange?.(category.key)}
              >
                <span>{translate(category.label)}</span>
                <span className='prompt-inspiration-library__chip-count'>
                  {categoryCounts.get(category.key)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <CreationMediaGrid
        ref={gridRef}
        mediaType='image'
        className='prompt-inspiration-library__grid'
      >
        {visibleItems.map((item) => (
          <PromptInspirationCard
            key={item.id || item.title}
            item={item}
            onApplyPrompt={onApplyPrompt}
            onPreviewImage={onPreviewImage}
            t={translate}
          />
        ))}
      </CreationMediaGrid>

      {pagination ? <CreationPagination {...pagination} t={translate} /> : null}
    </section>
  );
}

function PromptInspirationCard({ item, onApplyPrompt, onPreviewImage, t }) {
  const translate = typeof t === 'function' ? t : (value) => value;
  const categoryLabel = item.categoryLabel || item.category || '灵感';
  const imageAlt = item.title
    ? `${categoryLabel} - ${item.title}`
    : categoryLabel;

  return (
    <article
      className={clsx(
        'prompt-inspiration-card',
        item.image && 'prompt-inspiration-card--with-image',
      )}
    >
      {item.image ? (
        <button
          type='button'
          className='prompt-inspiration-card__media'
          onClick={() => onPreviewImage?.(item)}
          aria-label={imageAlt}
          title={item.title || categoryLabel}
        >
          <img src={item.image} alt={imageAlt} loading='lazy' />
        </button>
      ) : null}
      <button
        type='button'
        className='prompt-inspiration-card__body'
        onClick={() => onApplyPrompt?.(item)}
        title={item.prompt}
      >
        <span className='prompt-inspiration-card__eyebrow'>
          {translate(categoryLabel)}
        </span>
        <span className='prompt-inspiration-card__title'>{item.title}</span>
        <span className='prompt-inspiration-card__prompt'>{item.prompt}</span>
        {item.tags?.length ? (
          <span className='prompt-inspiration-card__tags'>
            {item.tags.slice(0, 3).map((tag) => (
              <span key={tag}>{translate(tag)}</span>
            ))}
          </span>
        ) : null}
      </button>
    </article>
  );
}
