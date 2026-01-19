import { useState, useEffect, useRef } from 'react';
import type { DeploymentLogEntry } from '@fastest/shared';

interface DeploymentLogsProps {
  deploymentId: string;
  isStreaming: boolean;
  entries: DeploymentLogEntry[];
  onClose?: () => void;
}

export function DeploymentLogs({
  deploymentId: _deploymentId,
  isStreaming,
  entries,
  onClose,
}: DeploymentLogsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<'all' | 'install' | 'build' | 'deploy'>('all');

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const filteredEntries = filter === 'all'
    ? entries
    : entries.filter(e => e.step === filter);

  const stepColors: Record<string, string> = {
    install: 'text-blue-400',
    build: 'text-yellow-400',
    deploy: 'text-green-400',
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-white">Deployment Logs</h3>
          {isStreaming && (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
              Live
            </span>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-2">
          {(['all', 'install', 'build', 'deploy'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                filter === f
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Log content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs"
        onScroll={handleScroll}
      >
        {filteredEntries.length === 0 ? (
          <div className="text-gray-500 text-center py-8">
            {isStreaming ? 'Waiting for logs...' : 'No logs available'}
          </div>
        ) : (
          filteredEntries.map((entry, idx) => (
            <div key={idx} className="flex gap-2 py-0.5 hover:bg-gray-800/50">
              <span className="text-gray-500 select-none w-20 flex-shrink-0">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              <span className={`w-16 flex-shrink-0 ${stepColors[entry.step] || 'text-gray-400'}`}>
                [{entry.step}]
              </span>
              <span
                className={`whitespace-pre-wrap break-all ${
                  entry.stream === 'stderr' ? 'text-red-400' : 'text-gray-100'
                }`}
              >
                {entry.content}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Footer with auto-scroll toggle */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-t border-gray-700">
        <span className="text-xs text-gray-400">
          {entries.length} log {entries.length === 1 ? 'entry' : 'entries'}
        </span>
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded border-gray-600 bg-gray-700 text-primary-500 focus:ring-primary-500"
          />
          Auto-scroll
        </label>
      </div>
    </div>
  );
}
