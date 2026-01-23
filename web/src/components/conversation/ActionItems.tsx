import { useState, useEffect } from 'react';
import type { ActionItem } from '@fastest/shared';
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
    } else if (item.action_type === 'navigate') {
      onNavigateToWorkspace(item.workspace_id, item.project_id);
    } else if (item.action_type === 'prompt') {
      const suggestedPrompt = item.action_data?.suggested_prompt as string | undefined;
      if (onApplyPrompt && suggestedPrompt) {
        onApplyPrompt(item.workspace_id, suggestedPrompt);
      } else {
        // Fallback: just navigate to the workspace
        onNavigateToWorkspace(item.workspace_id, item.project_id);
      }
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
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ActionItemRowProps {
  item: ActionItem;
  onAction: () => void;
  onDismiss: () => void;
}

function ActionItemRow({ item, onAction, onDismiss }: ActionItemRowProps) {
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
