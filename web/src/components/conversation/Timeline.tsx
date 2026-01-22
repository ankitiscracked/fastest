import { useState } from 'react';
import type { TimelineItem, FileChange } from '@fastest/shared';

interface TimelineProps {
  items: TimelineItem[];
}

export function Timeline({ items }: TimelineProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-surface-400 p-4">
        <FileIcon className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-sm text-center">No file changes yet</p>
        <p className="text-xs text-center mt-1">Changes will appear here as you work</p>
      </div>
    );
  }

  // Calculate totals for the header
  const totals = items.reduce(
    (acc, item) => {
      item.files.forEach((f) => {
        if (f.change === 'added') acc.added++;
        else if (f.change === 'modified') acc.modified++;
        else if (f.change === 'deleted') acc.deleted++;
      });
      return acc;
    },
    { added: 0, modified: 0, deleted: 0 }
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header with summary */}
      <div className="px-3 py-2 border-b border-surface-200 bg-surface-50">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-surface-500 uppercase tracking-wide">
            Changes
          </h3>
          <div className="flex items-center gap-1.5 text-xs">
            {totals.added > 0 && (
              <span className="text-status-success font-medium">+{totals.added}</span>
            )}
            {totals.modified > 0 && (
              <span className="text-status-warning font-medium">~{totals.modified}</span>
            )}
            {totals.deleted > 0 && (
              <span className="text-status-error font-medium">-{totals.deleted}</span>
            )}
          </div>
        </div>
        <p className="text-[10px] text-surface-400 mt-0.5">
          {items.length} update{items.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Timeline entries */}
      <div className="flex-1 overflow-y-auto">
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-4 top-0 bottom-0 w-px bg-gradient-to-b from-surface-200 via-surface-200 to-transparent" />

          {items.map((item, index) => (
            <TimelineEntry
              key={item.id}
              item={item}
              isLatest={index === items.length - 1}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface TimelineEntryProps {
  item: TimelineItem;
  isLatest?: boolean;
}

function TimelineEntry({ item, isLatest }: TimelineEntryProps) {
  const [expanded, setExpanded] = useState(isLatest);

  const added = item.files.filter((f) => f.change === 'added');
  const modified = item.files.filter((f) => f.change === 'modified');
  const deleted = item.files.filter((f) => f.change === 'deleted');

  const time = new Date(item.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const isGenerating = item.summaryStatus === 'generating';
  const isPending = item.summaryStatus === 'pending';

  return (
    <div
      className={`relative pl-8 pr-3 py-3 transition-colors ${
        isLatest ? 'bg-accent-50/50' : 'hover:bg-surface-50'
      }`}
    >
      {/* Timeline dot */}
      <div
        className={`absolute left-[0.6875rem] w-3 h-3 rounded-full border-2 border-white shadow-sm ${
          isGenerating
            ? 'bg-status-running animate-pulse'
            : isLatest
            ? 'bg-accent-500'
            : 'bg-surface-300'
        }`}
        style={{ top: '1rem' }}
      />

      {/* Latest indicator */}
      {isLatest && (
        <span className="absolute right-3 top-3 text-[9px] font-semibold uppercase tracking-wider text-accent-600 bg-accent-100 px-1.5 py-0.5 rounded">
          Latest
        </span>
      )}

      {/* Time */}
      <div className="text-xs text-surface-400 mb-1 flex items-center gap-2">
        <ClockIcon className="w-3 h-3" />
        {time}
      </div>

      {/* Summary */}
      <div className="mb-2">
        {isGenerating ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-surface-500 italic">Generating summary</span>
            <LoadingDots />
          </div>
        ) : isPending ? (
          <span className="text-sm text-surface-400 italic">Pending...</span>
        ) : (
          <p className="text-sm text-surface-800 leading-relaxed">
            {item.summary || 'Updated files'}
          </p>
        )}
      </div>

      {/* File change counts */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-surface-500 hover:text-surface-700 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          {added.length > 0 && (
            <span className="inline-flex items-center gap-0.5 text-status-success">
              <PlusIcon className="w-3 h-3" />
              {added.length}
            </span>
          )}
          {modified.length > 0 && (
            <span className="inline-flex items-center gap-0.5 text-status-warning">
              <EditIcon className="w-3 h-3" />
              {modified.length}
            </span>
          )}
          {deleted.length > 0 && (
            <span className="inline-flex items-center gap-0.5 text-status-error">
              <MinusIcon className="w-3 h-3" />
              {deleted.length}
            </span>
          )}
        </div>
        <ChevronIcon
          className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {/* Expanded file list */}
      {expanded && (
        <div className="mt-2 space-y-0.5 pl-0.5">
          {item.files.map((file) => (
            <FileChangeRow key={file.path} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileChangeRow({ file }: { file: FileChange }) {
  const fileName = file.path.split('/').pop() || file.path;
  const dirPath = file.path.includes('/')
    ? file.path.substring(0, file.path.lastIndexOf('/'))
    : '';

  const changeConfig = {
    added: {
      bg: 'bg-status-success',
      text: 'text-status-success',
      label: 'A',
    },
    modified: {
      bg: 'bg-status-warning',
      text: 'text-status-warning',
      label: 'M',
    },
    deleted: {
      bg: 'bg-status-error',
      text: 'text-status-error',
      label: 'D',
    },
  };

  const config = changeConfig[file.change] || changeConfig.modified;

  return (
    <div className="flex items-center gap-2 text-xs py-1 group">
      <span
        className={`w-4 h-4 flex items-center justify-center rounded text-white text-[10px] font-semibold ${config.bg}`}
      >
        {config.label}
      </span>
      <span
        className={`font-medium truncate ${config.text} group-hover:text-surface-800 transition-colors`}
        title={file.path}
      >
        {fileName}
      </span>
      {dirPath && (
        <span className="text-surface-400 truncate flex-shrink text-[10px]" title={dirPath}>
          {dirPath}
        </span>
      )}
    </div>
  );
}

// Loading dots animation
function LoadingDots() {
  return (
    <span className="inline-flex gap-0.5">
      <span className="w-1 h-1 rounded-full bg-status-running animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1 h-1 rounded-full bg-status-running animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1 h-1 rounded-full bg-status-running animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  );
}

// Icons
function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function EditIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
      />
    </svg>
  );
}

function MinusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
    </svg>
  );
}
