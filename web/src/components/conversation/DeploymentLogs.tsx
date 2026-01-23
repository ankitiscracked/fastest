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
    install: 'terminal-step-install',
    build: 'terminal-step-build',
    deploy: 'terminal-step-deploy',
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  return (
    <div className="terminal flex flex-col h-full">
      {/* Header */}
      <div className="terminal-header">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-white">Deployment Logs</h3>
          {isStreaming && (
            <span className="flex items-center gap-1 text-xs text-status-success">
              <span className="w-2 h-2 bg-status-success rounded-full animate-pulse" />
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
              className={`px-2 py-1 text-xs rounded-sm transition-colors ${
                filter === f
                  ? 'bg-surface-700 text-white'
                  : 'text-surface-400 hover:text-white'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {onClose && (
          <button
            onClick={onClose}
            className="text-surface-400 hover:text-white transition-colors"
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
        className="terminal-content flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        {filteredEntries.length === 0 ? (
          <div className="text-surface-500 text-center py-8">
            {isStreaming ? 'Waiting for logs...' : 'No logs available'}
          </div>
        ) : (
          filteredEntries.map((entry, idx) => (
            <div key={idx} className="terminal-line">
              <span className="terminal-timestamp">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              <span className={`terminal-step ${stepColors[entry.step] || 'text-surface-400'}`}>
                [{entry.step}]
              </span>
              <span
                className={`terminal-output ${
                  entry.stream === 'stderr' ? 'terminal-error' : ''
                }`}
              >
                {entry.content}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Footer with auto-scroll toggle */}
      <div className="terminal-header border-t border-surface-700">
        <span className="text-xs text-surface-400">
          {entries.length} log {entries.length === 1 ? 'entry' : 'entries'}
        </span>
        <label className="flex items-center gap-2 text-xs text-surface-400 cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded-sm border-surface-600 bg-surface-700 text-accent-500 focus:ring-surface-400"
          />
          Auto-scroll
        </label>
      </div>
    </div>
  );
}
