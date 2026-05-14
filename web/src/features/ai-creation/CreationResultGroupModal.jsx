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
import { Modal } from '@douyinfe/semi-ui';
import clsx from 'clsx';
import { CircleStop, Download, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import CreationResultGroupViewer from './CreationResultGroupViewer.jsx';
import { isCreationResultGroupRetryable } from './creationResultGroupAdapters.js';

function HeaderAction({ disabled, icon: Icon, label, onClick, variant }) {
  return (
    <button
      type='button'
      className={clsx(
        'creation-result-group-header__action',
        variant && `is-${variant}`,
      )}
      disabled={disabled}
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}

function CreationResultGroupHeader({
  title,
  stats = {},
  onDownloadAll,
  onRetryFailed,
  onCancelActive,
}) {
  const { t } = useTranslation();
  const safeStats = {
    completed: Number(stats?.completed) || 0,
    failed: Number(stats?.failed) || 0,
    processing: Number(stats?.processing) || 0,
    cancelled: Number(stats?.cancelled) || 0,
  };
  const retryable = isCreationResultGroupRetryable(safeStats);
  const total =
    safeStats.completed +
    safeStats.failed +
    safeStats.processing +
    safeStats.cancelled;
  const statItems = [
    {
      key: 'completed',
      label: t('成功'),
      value: safeStats.completed,
      tone: 'success',
    },
    {
      key: 'processing',
      label: t('生成中'),
      value: safeStats.processing,
      tone: 'processing',
    },
    {
      key: 'failed',
      label: t('失败'),
      value: safeStats.failed,
      tone: 'failed',
    },
    {
      key: 'cancelled',
      label: t('已停止'),
      value: safeStats.cancelled,
      tone: 'cancelled',
    },
  ];

  return (
    <div className='creation-result-group-header'>
      <span className='creation-result-group-header__titleline'>
        <span className='creation-result-group-header__title'>{title}</span>
        <span className='creation-result-group-header__total'>
          {t('共 {{count}} 个', { count: total })}
        </span>
      </span>
      <span className='creation-result-group-header__stats'>
        {statItems.map((item) => (
          <span
            key={item.key}
            className={clsx(
              'creation-result-group-header__stat',
              `is-${item.tone}`,
              item.value <= 0 && 'is-empty',
            )}
          >
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </span>
        ))}
      </span>
      <span className='creation-result-group-header__actions'>
        {onDownloadAll ? (
          <HeaderAction
            icon={Download}
            label={t('下载全部')}
            disabled={safeStats.completed <= 0}
            onClick={onDownloadAll}
          />
        ) : null}
        {onRetryFailed ? (
          <HeaderAction
            icon={RotateCcw}
            label={t('重试失败')}
            disabled={!retryable}
            onClick={onRetryFailed}
          />
        ) : null}
        {onCancelActive ? (
          <HeaderAction
            icon={CircleStop}
            label={t('停止生成')}
            disabled={safeStats.processing <= 0}
            onClick={onCancelActive}
            variant='danger'
          />
        ) : null}
      </span>
    </div>
  );
}

export default function CreationResultGroupModal({
  visible,
  onCancel,
  mediaType = 'image',
  className,
  title,
  stats,
  onDownloadAll,
  onRetryFailed,
  onCancelActive,
  ...viewerProps
}) {
  return (
    <Modal
      title={
        <CreationResultGroupHeader
          title={title}
          stats={stats}
          onDownloadAll={onDownloadAll}
          onRetryFailed={onRetryFailed}
          onCancelActive={onCancelActive}
        />
      }
      visible={visible}
      onCancel={onCancel}
      footer={null}
      bodyStyle={{ paddingTop: 6 }}
      width={760}
      closable
      className={clsx(
        'creation-result-group-modal',
        mediaType && `creation-result-group-modal--${mediaType}`,
        className,
      )}
    >
      <CreationResultGroupViewer
        {...viewerProps}
        mediaType={mediaType}
        title={title}
        stats={stats}
        onDownloadAll={onDownloadAll}
        onRetryFailed={onRetryFailed}
        onCancelActive={onCancelActive}
      />
    </Modal>
  );
}
