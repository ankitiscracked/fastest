import { useState, useEffect } from 'react';
import type { ActionItem, ActionItemRun } from '@fastest/shared';
import { api } from '../../api/client';

interface ActionItemsProps {
  onNavigateToWorkspace: (workspaceId: string, projectId: string) => void;
  onSyncWorkspace: (workspaceId: string) => void;
  onApplyPrompt?: (workspaceId: string, prompt: string) => void;
}

export function ActionItems({ onNavigateToWorkspace, onSyncWorkspace, onApplyPrompt }: ActionItemsProps) {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [activeItem, setActiveItem] = useState<ActionItem | null>(null);
  const [activeRun, setActiveRun] = useState<ActionItemRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [runsByItemId, setRunsByItemId] = useState<Record<string, ActionItemRun>>({});

  useEffect(() => {
    loadActionItems();
  }, []);

  const loadActionItems = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.getActionItems();
      setItems(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load action items');
    } finally {
      setLoading(false);
    }
  };

  const handleAction = (item: ActionItem) => {
    if (item.action_type === 'sync') {
      onSyncWorkspace(item.workspace_id);
      return;
    }

    if (item.type === 'refactoring' || item.type === 'security' || item.type === 'test_coverage' || item.type === 'build_failure') {
      startRun(item);
      return;
    }

    if (item.action_type === 'navigate') {
      onNavigateToWorkspace(item.workspace_id, item.project_id);
      return;
    }

    if (item.action_type === 'prompt') {
      const suggestedPrompt = item.action_data?.suggested_prompt as string | undefined;
      if (onApplyPrompt && suggestedPrompt) {
        onApplyPrompt(item.workspace_id, suggestedPrompt);
        return;
      }

      onNavigateToWorkspace(item.workspace_id, item.project_id);
    }
  };

  const handleDismiss = async (item: ActionItem) => {
    try {
      await api.dismissActionItem(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err) {
      console.error('Failed to dismiss item:', err);
    }
  };

  // Don't render if no items and not loading
  if (!loading && items.length === 0) {
    return null;
  }

  return (
    <>
      <div className="border border-surface-200 rounded-md bg-surface-50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-4 py-2 hover:bg-surface-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-surface-600">Action Items</span>
          {items.length > 0 && (
            <span className="px-1.5 py-0.5 text-xs font-medium bg-accent-100 text-accent-700 rounded-sm">
              {items.length}
            </span>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-surface-400 transition-transform ${collapsed ? '' : 'rotate-180'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Content */}
      {!collapsed && (
        <div className="border-t border-surface-200">
          {loading ? (
            <div className="px-4 py-3 text-sm text-surface-500 flex items-center gap-2">
              <LoadingSpinner />
              <span>Checking workspaces...</span>
            </div>
          ) : error ? (
            <div className="px-4 py-3 text-sm text-status-error flex items-center justify-between">
              <span>{error}</span>
              <button
                onClick={loadActionItems}
                className="text-xs text-accent-600 hover:text-accent-700"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="divide-y divide-surface-200">
              {items.map((item) => (
                <ActionItemRow
                  key={item.id}
                  item={item}
                  onAction={() => handleAction(item)}
                  onDismiss={() => handleDismiss(item)}
                  runStatus={runsByItemId[item.id]?.status}
                />
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      <ActionItemRunDrawer
        item={activeItem}
        run={activeRun}
        loading={runLoading}
        error={runError}
        applying={applying}
        onClose={() => {
          setActiveItem(null);
          setActiveRun(null);
          setRunError(null);
        }}
        onApply={async () => {
          if (!activeRun) return;
          try {
            setApplying(true);
            await api.applyActionItemRun(activeRun.id);
            const updated = await api.getActionItemRun(activeRun.id);
            setActiveRun(updated.run);
            setRunsByItemId((prev) => ({ ...prev, [updated.run.action_item_id]: updated.run }));
          } catch (err) {
            setRunError(err instanceof Error ? err.message : 'Failed to apply changes');
          } finally {
            setApplying(false);
          }
        }}
        onRefresh={async () => {
          if (!activeRun) return;
          try {
            const updated = await api.getActionItemRun(activeRun.id);
            setActiveRun(updated.run);
            setRunsByItemId((prev) => ({ ...prev, [updated.run.action_item_id]: updated.run }));
          } catch (err) {
            setRunError(err instanceof Error ? err.message : 'Failed to refresh run');
          }
        }}
      />
    </>
  );

  async function startRun(item: ActionItem) {
    try {
      setRunLoading(true);
      setRunError(null);
      setActiveItem(item);
      const response = await api.createActionItemRun(item.id);
      setActiveRun(response.run);
      setRunsByItemId((prev) => ({ ...prev, [response.run.action_item_id]: response.run }));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to start run');
    } finally {
      setRunLoading(false);
    }
  }
}

interface ActionItemRowProps {
  item: ActionItem;
  onAction: () => void;
  onDismiss: () => void;
  runStatus?: ActionItemRun['status'];
}

function ActionItemRow({ item, onAction, onDismiss, runStatus }: ActionItemRowProps) {
  const severityStyles = {
    info: 'text-surface-600',
    warning: 'text-status-warning',
    critical: 'text-status-error',
  };

  const iconBgStyles = {
    info: 'bg-surface-200',
    warning: 'bg-status-warning/10',
    critical: 'bg-status-error/10',
  };

  return (
    <div className="px-4 py-3 flex items-center gap-3 hover:bg-white transition-colors group">
      {/* Icon */}
      <div className={`p-1.5 rounded-sm ${iconBgStyles[item.severity]}`}>
        <ItemIcon type={item.type} className={`w-4 h-4 ${severityStyles[item.severity]}`} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-surface-700 truncate">
            {item.workspace_name}
          </span>
          <span className="text-xs text-surface-400">in {item.project_name}</span>
          {runStatus && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-surface-100 text-surface-600">
              {runStatus.toUpperCase()}
            </span>
          )}
          {runStatus && (
            <button
              onClick={onAction}
              className="text-[10px] text-accent-600 hover:text-accent-700"
              title="View run"
            >
              View
            </button>
          )}
        </div>
        <div className={`text-sm ${severityStyles[item.severity]}`}>
          {item.title}
        </div>
        {item.description && (
          <div className="text-xs text-surface-500 mt-0.5">{item.description}</div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onDismiss}
          className="p-1 text-surface-400 hover:text-surface-600 rounded"
          title="Dismiss"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <button
          onClick={onAction}
          className="px-3 py-1 text-sm font-medium bg-accent-600 text-white rounded-sm hover:bg-accent-700 transition-colors"
        >
          {item.action_label}
        </button>
      </div>
    </div>
  );
}

function ItemIcon({ type, className }: { type: ActionItem['type']; className?: string }) {
  switch (type) {
    case 'drift':
      return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
      );
    case 'refactoring':
      return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
          />
        </svg>
      );
    case 'security':
      return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      );
    case 'test_coverage':
      return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
          />
        </svg>
      );
    case 'build_failure':
      return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      );
    default:
      return null;
  }
}

function LoadingSpinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-surface-400" fill="none" viewBox="0 0 24 24">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function ActionItemRunDrawer({
  item,
  run,
  loading,
  error,
  applying,
  onClose,
  onApply,
  onRefresh,
}: {
  item: ActionItem | null;
  run: ActionItemRun | null;
  loading: boolean;
  error: string | null;
  applying: boolean;
  onClose: () => void;
  onApply: () => void;
  onRefresh: () => void;
}) {
  const [autoRefresh, setAutoRefresh] = useState<ReturnType<typeof setInterval> | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!run || run.status === 'ready' || run.status === 'failed' || run.status === 'applied') {
      if (autoRefresh) {
        clearInterval(autoRefresh);
        setAutoRefresh(null);
      }
      return;
    }

    if (!autoRefresh) {
      const timer = setInterval(() => onRefresh(), 2000);
      setAutoRefresh(timer);
    }

    return () => {
      if (autoRefresh) clearInterval(autoRefresh);
    };
  }, [run?.id, run?.status, onRefresh, autoRefresh]);

  if (!item && !run && !loading && !error) return null;

  const checks = run?.checks || [];
  const patch = run?.patch || '';
  const diffFiles = parseUnifiedDiff(patch);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full max-w-xl h-full bg-white shadow-xl border-l border-surface-200 flex flex-col">
        <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
          <div>
            <div className="text-sm text-surface-500">Run</div>
            <div className="text-base font-semibold text-surface-800">
              {item?.type === 'security' ? 'Fix' : item?.type === 'test_coverage' ? 'Add tests' : item?.type === 'build_failure' ? 'Analyze' : 'Refactor'}
            </div>
            {item?.title && <div className="text-xs text-surface-500 mt-0.5">{item.title}</div>}
          </div>
          <button onClick={onClose} className="text-surface-400 hover:text-surface-600">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {loading && (
            <div className="text-sm text-surface-500 flex items-center gap-2">
              <LoadingSpinner />
              <span>Starting run…</span>
            </div>
          )}

          {error && (
            <div className="text-sm text-status-error">{error}</div>
          )}

          {run && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-surface-500">Status</span>
                <span className="text-xs font-medium bg-surface-100 text-surface-700 px-2 py-0.5 rounded">
                  {run.status.toUpperCase()}
                </span>
              </div>

              {run.summary && (
                <div className="bg-surface-50 border border-surface-200 rounded-md p-3">
                  <div className="text-xs text-surface-500 mb-1">Summary</div>
                  <div className="text-sm text-surface-700 whitespace-pre-wrap">{run.summary}</div>
                </div>
              )}

              {checks.length > 0 && (
                <div className="border border-surface-200 rounded-md">
                  <div className="px-3 py-2 border-b border-surface-200 text-xs text-surface-500">Checks</div>
                  <div className="divide-y divide-surface-200">
                    {checks.map((check) => (
                      <div key={`${check.kind}-${check.command}`} className="px-3 py-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium text-surface-700">{check.kind}</span>
                          <span className={check.success ? 'text-status-success' : 'text-status-error'}>
                            {check.success ? 'passed' : 'failed'}
                          </span>
                        </div>
                        <div className="text-xs text-surface-500 mt-1">{check.command}</div>
                        {check.output && (
                          <pre className="mt-2 text-xs bg-surface-50 border border-surface-200 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                            {check.output}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {patch && (
                <div className="border border-surface-200 rounded-md">
                  <div className="px-3 py-2 border-b border-surface-200 text-xs text-surface-500">Diff Preview</div>
                  <div className="px-3 py-2 text-xs text-surface-500 flex flex-wrap gap-2">
                    {diffFiles.length > 0 ? (
                      diffFiles.map((file) => (
                        <a
                          key={file.path}
                          href={`#diff-${file.path.replace(/[^a-zA-Z0-9]/g, '-')}`}
                          className="px-2 py-0.5 rounded-sm border border-surface-200 text-surface-600 hover:bg-surface-50"
                        >
                          {file.path}
                        </a>
                      ))
                    ) : (
                      <span>—</span>
                    )}
                  </div>
                  {diffFiles.length > 0 && (
                    <div className="px-3 pb-2 flex items-center gap-2 text-[11px] text-surface-500">
                      <button
                        onClick={() => {
                          const allCollapsed: Record<string, boolean> = {};
                          for (const file of diffFiles) allCollapsed[file.path] = true;
                          setCollapsedFiles(allCollapsed);
                        }}
                        className="px-2 py-0.5 rounded-sm border border-surface-200 hover:bg-surface-50"
                      >
                        Collapse all
                      </button>
                      <button
                        onClick={() => {
                          const allExpanded: Record<string, boolean> = {};
                          for (const file of diffFiles) allExpanded[file.path] = false;
                          setCollapsedFiles(allExpanded);
                        }}
                        className="px-2 py-0.5 rounded-sm border border-surface-200 hover:bg-surface-50"
                      >
                        Expand all
                      </button>
                    </div>
                  )}
                  <div className="px-3 pb-3 space-y-3">
                    {diffFiles.map((file) => (
                      <div
                        key={file.path}
                        id={`diff-${file.path.replace(/[^a-zA-Z0-9]/g, '-')}`}
                        className="border border-surface-200 rounded-md overflow-hidden"
                      >
                        <div className="px-3 py-2 bg-surface-50 text-xs text-surface-600 flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <button
                              onClick={() => setCollapsedFiles((prev) => ({
                                ...prev,
                                [file.path]: !prev[file.path],
                              }))}
                              className="text-surface-500 hover:text-surface-700"
                              title={collapsedFiles[file.path] ? 'Expand' : 'Collapse'}
                            >
                              {collapsedFiles[file.path] ? '▸' : '▾'}
                            </button>
                            <span className="font-medium text-surface-700 truncate">{file.path}</span>
                          </div>
                          <span className="text-surface-500">+{file.added} / -{file.removed}</span>
                        </div>
                        {!collapsedFiles[file.path] && (
                          <div className="bg-white">
                            {file.hunks.map((hunk, index) => (
                              <div key={`${file.path}-hunk-${index}`} className="border-t border-surface-100">
                                <div className="px-3 py-1 text-[11px] font-mono text-surface-500 bg-surface-50">
                                  {hunk.header}
                                </div>
                                <div className="px-3 py-2 font-mono text-[11px] leading-5">
                                  {hunk.lines.map((line, lineIndex) => (
                                    <div
                                      key={`${file.path}-line-${index}-${lineIndex}`}
                                      className={
                                        line.type === 'add'
                                          ? 'text-status-success bg-status-success/10'
                                          : line.type === 'remove'
                                            ? 'text-status-error bg-status-error/10'
                                            : 'text-surface-600'
                                      }
                                    >
                                      <span className="opacity-70 select-none">{line.prefix}</span>
                                      <span className="whitespace-pre-wrap">{line.content}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {run.report && (
                <div className="border border-surface-200 rounded-md">
                  <div className="px-3 py-2 border-b border-surface-200 text-xs text-surface-500">Report</div>
                  <pre className="px-3 py-2 text-xs whitespace-pre-wrap overflow-x-auto">{run.report}</pre>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-surface-200 flex items-center justify-between gap-2">
          <button
            onClick={onRefresh}
            className="px-3 py-1.5 text-sm border border-surface-300 rounded-md text-surface-600 hover:bg-surface-50"
          >
            Refresh
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm border border-surface-300 rounded-md text-surface-600 hover:bg-surface-50"
            >
              Close
            </button>
            <button
              onClick={onApply}
              disabled={!run || run.status !== 'ready' || applying}
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-accent-600 text-white disabled:opacity-50"
            >
              {applying ? 'Applying…' : 'Apply changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function parseUnifiedDiff(patch: string): Array<{
  path: string;
  added: number;
  removed: number;
  hunks: Array<{ header: string; lines: Array<{ prefix: string; content: string; type: 'add' | 'remove' | 'context' }> }>;
}> {
  const files: Array<{
    path: string;
    added: number;
    removed: number;
    hunks: Array<{ header: string; lines: Array<{ prefix: string; content: string; type: 'add' | 'remove' | 'context' }> }>;
  }> = [];
  const lines = patch.split('\n');
  let currentFile: typeof files[number] | null = null;
  let currentHunk: typeof files[number]['hunks'][number] | null = null;

  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const path = line.replace('+++ ', '').replace(/^b\//, '').trim();
      if (!path || path === '/dev/null') continue;
      currentFile = { path, added: 0, removed: 0, hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (line.startsWith('@@ ')) {
      if (!currentFile) continue;
      currentHunk = { header: line, lines: [] };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    const prefix = line.slice(0, 1);
    const content = line.slice(1);
    if (prefix === '+') {
      currentFile.added += 1;
      currentHunk.lines.push({ prefix, content, type: 'add' });
    } else if (prefix === '-') {
      currentFile.removed += 1;
      currentHunk.lines.push({ prefix, content, type: 'remove' });
    } else {
      const safePrefix = prefix === ' ' ? ' ' : ' ';
      const safeContent = prefix === ' ' ? line.slice(1) : line;
      currentHunk.lines.push({ prefix: safePrefix, content: safeContent, type: 'context' });
    }
  }

  return files;
}
