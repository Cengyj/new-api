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

import React, { forwardRef, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

export const normalizeCreationOptions = (items, fallbackValue) => {
  const rows = (items || [])
    .map((item) => ({
      value: item.value ?? item.key ?? item.model_code ?? item.code ?? item,
      label: item.label ?? item.name ?? item.value ?? item.key ?? item,
    }))
    .filter((item) => item.value !== undefined && item.value !== null);

  if (rows.length) return rows;
  return fallbackValue ? [{ value: fallbackValue, label: fallbackValue }] : [];
};

export function ComposerSelect({ value, options, onChange, disabled, wide }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const triggerRef = useRef(null);
  const current =
    options.find((option) => String(option.value) === String(value)) ??
    options[0];

  useEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const minWidth = wide ? 240 : Math.max(132, rect.width);
      const viewportWidth =
        window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight =
        window.innerHeight || document.documentElement.clientHeight;
      const gap = 8;
      const safe = 12;
      const below = viewportHeight - rect.bottom - safe - gap;
      const above = rect.top - safe - gap;
      const openUp = below < 180 && above > below;
      const maxHeight = Math.max(160, Math.min(360, openUp ? above : below));

      setMenuStyle({
        position: 'fixed',
        left: Math.max(
          safe,
          Math.min(rect.left, viewportWidth - minWidth - safe),
        ),
        top: openUp ? undefined : rect.bottom + gap,
        bottom: openUp ? viewportHeight - rect.top + gap : undefined,
        minWidth,
        maxHeight,
        zIndex: 10050,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, wide]);

  return (
    <div
      className='relative'
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type='button'
        disabled={disabled || !current}
        onClick={() => setOpen((visible) => !visible)}
        className={clsx(
          'ai-creation-select-trigger inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm text-sky-500 outline-none transition',
          wide &&
            'ai-creation-select-trigger--wide min-w-[150px] justify-between',
          open ? 'is-open' : '',
          disabled && 'is-disabled cursor-not-allowed text-neutral-400',
        )}
      >
        <span className='truncate'>{current?.label || value}</span>
        <ChevronDown
          size={15}
          className={clsx('shrink-0 transition', open && 'rotate-180')}
        />
      </button>

      {open &&
        !disabled &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className={clsx(
              'composer-select-menu ai-creation-select-menu ai-creation-floating-select-menu overflow-hidden rounded-[18px] border border-neutral-200 bg-white p-1.5 shadow-[0_18px_50px_rgba(15,23,42,.14)]',
              wide ? 'min-w-[190px]' : 'min-w-[132px]',
            )}
            style={menuStyle || undefined}
          >
            {options.map((option) => {
              const selected = String(option.value) === String(value);
              return (
                <button
                  key={option.value}
                  type='button'
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={clsx(
                    'ai-creation-select-option flex h-10 w-full items-center justify-between gap-3 rounded-[12px] px-3 text-left text-sm transition',
                    selected
                      ? 'is-selected bg-neutral-100 text-neutral-950'
                      : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-950',
                  )}
                >
                  <span className='truncate'>{option.label}</span>
                  {selected && <Check size={16} className='shrink-0' />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function CreationModeTabs({
  items,
  activeKey,
  onChange,
  className,
  tabClassName,
}) {
  return (
    <div className={clsx('ai-creation-mode-tabs', className)} role='tablist'>
      {items.map((item) => (
        <button
          key={item.key}
          type='button'
          role='tab'
          aria-selected={activeKey === item.key}
          className={clsx(
            'ai-creation-mode-tab',
            tabClassName,
            activeKey === item.key && 'is-active',
          )}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export const clampCreationNumber = (value, min, max) =>
  Math.min(max, Math.max(min, value));

export function CreationTaskActionButton({
  action = 'delete',
  title,
  onClick,
  disabled,
}) {
  const isStop = action === 'stop';
  return (
    <button
      type='button'
      className={clsx(
        'ai-creation-task-action ai-creation-task-action--danger',
        `ai-creation-task-action--${action}`,
      )}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {isStop ? <CircleStop size={13} /> : <Trash2 size={13} />}
    </button>
  );
}

export const getCreationPageCount = (total, pageSize) =>
  Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));

export function useResponsiveGridPageSize({
  minCardWidth,
  cardAspect = 1,
  cardChrome = 0,
  gap = 14,
  minRows = 1,
  maxRows = 3,
  maxColumns = 10,
  fallback = 6,
  bottomReserve = 176,
  topFallbackRatio = 0.45,
  watchKey = '',
}) {
  const ref = useRef(null);
  const [pageSize, setPageSize] = useState(fallback);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frame = 0;

    const measure = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const node = ref.current;
        const rect = node?.getBoundingClientRect?.();
        const viewportWidth =
          window.innerWidth || document.documentElement.clientWidth || 1280;
        const viewportHeight =
          window.innerHeight || document.documentElement.clientHeight || 760;
        const width = Math.max(
          minCardWidth,
          node?.clientWidth || viewportWidth - 48,
        );
        const top = rect
          ? Math.max(0, rect.top)
          : viewportHeight * topFallbackRatio;
        const availableHeight = Math.max(
          180,
          viewportHeight - top - bottomReserve,
        );
        const columns = clampCreationNumber(
          Math.floor((width + gap) / (minCardWidth + gap)) || 1,
          1,
          maxColumns,
        );
        const cardWidth = Math.max(
          minCardWidth * 0.76,
          (width - gap * (columns - 1)) / columns,
        );
        const cardHeight = cardWidth / Math.max(0.1, cardAspect) + cardChrome;
        const rows = clampCreationNumber(
          Math.floor((availableHeight + gap) / (cardHeight + gap)) || minRows,
          minRows,
          maxRows,
        );
        setPageSize(Math.max(1, columns * rows));
      });
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measure)
        : null;
    if (ref.current && resizeObserver) resizeObserver.observe(ref.current);

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [
    bottomReserve,
    cardAspect,
    cardChrome,
    fallback,
    gap,
    maxColumns,
    maxRows,
    minCardWidth,
    minRows,
    topFallbackRatio,
    watchKey,
  ]);

  return [ref, pageSize];
}

export function CreationPagination({
  total,
  pageSize,
  currentPage,
  onPageChange,
  className = 'ai-creation-pagination-bar',
  countClassName = 'ai-creation-pagination-count',
  showQuickJumper = true,
  t,
}) {
  const { t: translateFromHook } = useTranslation();
  const translate = t || translateFromHook;

  if (total <= 0) return null;

  const pageCount = getCreationPageCount(total, pageSize);
  const safePage = clampCreationNumber(currentPage, 1, pageCount);
  const changePage = (page) =>
    onPageChange(clampCreationNumber(page, 1, pageCount));

  return (
    <div className={className}>
      <button
        type='button'
        className='ai-creation-pagination-btn'
        disabled={safePage <= 1}
        aria-label='previous page'
        onClick={() => changePage(safePage - 1)}
      >
        <ChevronLeft size={14} />
      </button>
      <span
        className={clsx(
          countClassName,
          'ai-creation-pagination-status tabular-nums',
        )}
      >
        {safePage} / {pageCount}
        {'\u9875'}
      </span>
      <button
        type='button'
        className='ai-creation-pagination-btn'
        disabled={safePage >= pageCount}
        aria-label='next page'
        onClick={() => changePage(safePage + 1)}
      >
        <ChevronRight size={14} />
      </button>
      {showQuickJumper && (
        <CreationPageJump
          currentPage={safePage}
          pageCount={pageCount}
          onPageChange={changePage}
          t={translate}
        />
      )}
    </div>
  );
}

function CreationPageJump({ currentPage, pageCount, onPageChange, t }) {
  const [value, setValue] = useState(String(currentPage));

  useEffect(() => {
    setValue(String(currentPage));
  }, [currentPage]);

  const jumpToPage = (event) => {
    event.preventDefault();
    const parsed = Number.parseInt(value, 10);
    const next = Number.isFinite(parsed)
      ? clampCreationNumber(parsed, 1, pageCount)
      : currentPage;
    setValue(String(next));
    onPageChange(next);
  };

  return (
    <form className='ai-creation-pagination-jump' onSubmit={jumpToPage}>
      <input
        type='number'
        min='1'
        max={pageCount}
        value={value}
        aria-label={t('跳转')}
        className='ai-creation-pagination-jump-input'
        onChange={(event) => setValue(event.target.value)}
      />
      <button type='submit' className='ai-creation-pagination-jump-btn'>
        {t('跳转')}
      </button>
    </form>
  );
}

export const CreationMediaGrid = forwardRef(function CreationMediaGrid(
  { mediaType, className, children },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(
        'ai-creation-media-grid',
        mediaType && `ai-creation-media-grid--${mediaType}`,
        className,
      )}
    >
      {children}
    </div>
  );
});

export function CreationEmptyState({ icon, children, className }) {
  return (
    <div
      className={clsx(
        'ai-creation-empty-state grid place-items-center rounded-[14px] border border-dashed py-14',
        className,
      )}
    >
      <div className='ai-creation-empty-state__content'>
        {icon ? (
          <span className='ai-creation-empty-state__icon'>{icon}</span>
        ) : null}
        {children}
      </div>
    </div>
  );
}
