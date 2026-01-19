import { useState } from 'react';
import type { TimelineItem, FileChange } from '@fastest/shared';

interface TimelineProps {
  items: TimelineItem[];
}

export function Timeline({ items }: TimelineProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 p-4">
        <FileIcon className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-sm text-center">No file changes yet</p>
        <p className="text-xs text-center mt-1">Changes will appear here as you work</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-200">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Changes
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-4 top-0 bottom-0 w-px bg-gray-200" />

          {items.map((item) => (
            <TimelineEntry key={item.id} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}

interface TimelineEntryProps {
  item: TimelineItem;
}

function TimelineEntry({ item }: TimelineEntryProps) {
  const [expanded, setExpanded] = useState(false);

  const added = item.files.filter(f => f.change === 'added');
  const modified = item.files.filter(f => f.change === 'modified');
  const deleted = item.files.filter(f => f.change === 'deleted');

  const time = new Date(item.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="relative pl-8 pr-3 py-3 hover:bg-gray-50 transition-colors">
      {/* Timeline dot */}
      <div
        className={`absolute left-3 w-3 h-3 rounded-full border-2 border-white shadow-sm ${
          item.summaryStatus === 'generating'
            ? 'bg-blue-400 animate-pulse'
            : 'bg-primary-500'
        }`}
        style={{ top: '1rem' }}
      />

      {/* Time */}
      <div className="text-xs text-gray-400 mb-1">{time}</div>

      {/* Summary */}
      <div className="text-sm text-gray-900 mb-2">
        {item.summaryStatus === 'generating' ? (
          <span className="text-gray-500 italic">Generating summary...</span>
        ) : item.summaryStatus === 'pending' ? (
          <span className="text-gray-500 italic">Pending...</span>
        ) : (
          item.summary || 'Updated files'
        )}
      </div>

      {/* File change counts */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700"
      >
        {added.length > 0 && (
          <span className="text-green-600">+{added.length}</span>
        )}
        {modified.length > 0 && (
          <span className="text-yellow-600">~{modified.length}</span>
        )}
        {deleted.length > 0 && (
          <span className="text-red-600">-{deleted.length}</span>
        )}
        <ChevronIcon className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {/* Expanded file list */}
      {expanded && (
        <div className="mt-2 space-y-1">
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

  return (
    <div className="flex items-center gap-2 text-xs py-0.5">
      <span
        className={`w-4 h-4 flex items-center justify-center rounded text-white text-[10px] font-medium ${
          file.change === 'added'
            ? 'bg-green-500'
            : file.change === 'modified'
            ? 'bg-yellow-500'
            : 'bg-red-500'
        }`}
      >
        {file.change === 'added' ? 'A' : file.change === 'modified' ? 'M' : 'D'}
      </span>
      <span className="text-gray-700 truncate" title={file.path}>
        {fileName}
      </span>
      {dirPath && (
        <span className="text-gray-400 truncate flex-shrink" title={dirPath}>
          {dirPath}
        </span>
      )}
    </div>
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

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}
