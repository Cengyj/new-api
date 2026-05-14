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

import {
  CreationEmptyState as SharedCreationEmptyState,
  CreationMediaGrid,
  CreationPagination as SharedCreationPagination,
} from './AiCreationShared.jsx';

const DEFAULT_CLASS_NAMES = {
  header: '',
  titleline: '',
  title: '',
  caption: '',
  actions: '',
  body: '',
  gridShell: '',
  grid: '',
  pagination: '',
};

export const CREATION_GALLERY_PRESETS = {
  image: {
    minCardWidth: 220,
    mediaRatio: '4 / 3',
  },
  video: {
    minCardWidth: 230,
    mediaRatio: '16 / 9',
  },
};

export function getCreationGalleryStyle(mediaType, overrides = {}) {
  const preset =
    CREATION_GALLERY_PRESETS[mediaType] || CREATION_GALLERY_PRESETS.image;
  const minCardWidth = overrides.minCardWidth ?? preset.minCardWidth;
  const mediaRatio = overrides.mediaRatio ?? preset.mediaRatio;

  return {
    '--ai-creation-gallery-card-min': `${minCardWidth}px`,
    '--ai-creation-gallery-media-ratio': mediaRatio,
    ...overrides.style,
  };
}

export function CreationGalleryPanel({
  mediaType = 'image',
  variant = 'single',
  title,
  caption,
  meta,
  actions,
  emptyState,
  isEmpty = false,
  pagination,
  gridRef,
  children,
  className,
  style,
  classNames,
  shellClassName,
  gridClassName,
  bodyClassName,
}) {
  const slots = { ...DEFAULT_CLASS_NAMES, ...(classNames || {}) };
  const captionText = caption ?? meta;

  return (
    <section
      className={clsx(
        'ai-creation-gallery',
        mediaType && `ai-creation-gallery--${mediaType}`,
        variant && `ai-creation-gallery--${variant}`,
        className,
      )}
      style={style}
    >
      <div className={clsx('ai-creation-gallery__header', slots.header)}>
        <div
          className={clsx('ai-creation-gallery__titleline', slots.titleline)}
        >
          {title ? (
            <h2 className={clsx('ai-creation-gallery__title', slots.title)}>
              {title}
            </h2>
          ) : null}
          {captionText ? (
            <p className={clsx('ai-creation-gallery__caption', slots.caption)}>
              {captionText}
            </p>
          ) : null}
        </div>
        {actions ? (
          <CreationGalleryActions className={slots.actions}>
            {actions}
          </CreationGalleryActions>
        ) : null}
      </div>

      <div
        className={clsx('ai-creation-gallery__body', slots.body, bodyClassName)}
      >
        <div
          ref={gridRef}
          className={clsx(
            'ai-creation-gallery__grid-shell',
            slots.gridShell,
            shellClassName,
          )}
        >
          {isEmpty && emptyState ? (
            emptyState
          ) : (
            <CreationGalleryGrid
              mediaType={mediaType}
              className={clsx(slots.grid, gridClassName)}
            >
              {children}
            </CreationGalleryGrid>
          )}
        </div>
      </div>

      {pagination ? (
        <CreationGalleryPagination
          pagination={pagination}
          className={slots.pagination}
        />
      ) : null}
    </section>
  );
}

export function CreationGalleryActions({ children, className }) {
  return (
    <div className={clsx('ai-creation-gallery__actions', className)}>
      {children}
    </div>
  );
}

export function CreationGalleryGrid({ mediaType, children, className }) {
  return (
    <CreationMediaGrid
      mediaType={mediaType}
      className={clsx('ai-creation-gallery__grid', className)}
    >
      {children}
    </CreationMediaGrid>
  );
}

export function CreationGalleryEmptyState({ children, icon, className }) {
  return (
    <SharedCreationEmptyState
      icon={icon}
      className={clsx('ai-creation-gallery__empty', className)}
    >
      {children}
    </SharedCreationEmptyState>
  );
}

export function CreationGalleryPagination({ pagination, className }) {
  if (React.isValidElement(pagination)) {
    return (
      <div className={clsx('ai-creation-gallery__pagination', className)}>
        {pagination}
      </div>
    );
  }

  return (
    <div className={clsx('ai-creation-gallery__pagination', className)}>
      <SharedCreationPagination {...pagination} />
    </div>
  );
}
