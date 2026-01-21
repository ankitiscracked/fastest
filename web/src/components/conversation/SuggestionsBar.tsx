interface Suggestion {
  id: string;
  label: string;
  icon?: 'sync' | 'test' | 'merge' | 'deploy' | 'retry' | 'continue' | 'refactor' | 'snapshot';
  variant?: 'default' | 'warning' | 'primary' | 'success';
  onClick: () => void;
}

interface SuggestionsBarProps {
  suggestions: Suggestion[];
  maxVisible?: number;
}

export function SuggestionsBar({ suggestions, maxVisible = 5 }: SuggestionsBarProps) {
  const visible = suggestions.slice(0, maxVisible);
  const hasMore = suggestions.length > maxVisible;

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {visible.map((suggestion) => (
        <SuggestionButton key={suggestion.id} suggestion={suggestion} />
      ))}

      {hasMore && (
        <button className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
          +{suggestions.length - maxVisible} more
        </button>
      )}
    </div>
  );
}

function SuggestionButton({ suggestion }: { suggestion: Suggestion }) {
  const variantStyles: Record<NonNullable<Suggestion['variant']>, string> = {
    default: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
    warning: 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200',
    primary: 'bg-primary-100 text-primary-700 hover:bg-primary-200',
    success: 'bg-green-100 text-green-700 hover:bg-green-200',
  };

  const variant = suggestion.variant || 'default';

  return (
    <button
      onClick={suggestion.onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${variantStyles[variant]}`}
    >
      {suggestion.icon && <SuggestionIcon icon={suggestion.icon} />}
      <span>{suggestion.label}</span>
    </button>
  );
}

function SuggestionIcon({ icon }: { icon: NonNullable<Suggestion['icon']> }) {
  const iconClass = 'w-4 h-4';

  switch (icon) {
    case 'sync':
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
      );
    case 'test':
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
          />
        </svg>
      );
    case 'merge':
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
          />
        </svg>
      );
    case 'deploy':
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>
      );
    case 'retry':
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
      );
    case 'continue':
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      );
    case 'refactor':
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
          />
        </svg>
      );
    case 'snapshot':
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      );
    default:
      return null;
  }
}

// Helper to generate suggestions based on state
export function generateSuggestions(options: {
  lastMessageStatus?: 'completed' | 'failed' | 'cancelled' | null;
  lastUserPrompt?: string;
  hasDrift?: boolean;
  driftCount?: number;
  hasUncommittedChanges?: boolean;
  isMainWorkspace?: boolean;
  onAction: (action: string, data?: unknown) => void;
}): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // Failed message - offer retry
  if (options.lastMessageStatus === 'failed' && options.lastUserPrompt) {
    suggestions.push({
      id: 'retry',
      label: 'Retry',
      icon: 'retry',
      variant: 'warning',
      onClick: () => options.onAction('retry', { prompt: options.lastUserPrompt }),
    });
  }

  // Drift warning
  if (options.hasDrift && options.driftCount) {
    suggestions.push({
      id: 'sync',
      label: `Sync with main (${options.driftCount})`,
      icon: 'sync',
      variant: 'warning',
      onClick: () => options.onAction('sync'),
    });
  }

  // Uncommitted changes
  if (options.hasUncommittedChanges) {
    suggestions.push({
      id: 'snapshot',
      label: 'Create snapshot',
      icon: 'snapshot',
      variant: 'primary',
      onClick: () => options.onAction('snapshot'),
    });
  }

  // Non-main workspace - offer merge
  if (!options.isMainWorkspace && options.hasUncommittedChanges) {
    suggestions.push({
      id: 'merge',
      label: 'Merge to main',
      icon: 'merge',
      variant: 'success',
      onClick: () => options.onAction('merge'),
    });
  }

  // Default suggestions
  suggestions.push({
    id: 'test',
    label: 'Run tests',
    icon: 'test',
    onClick: () => options.onAction('test'),
  });

  if (options.isMainWorkspace) {
    suggestions.push({
      id: 'deploy',
      label: 'Deploy',
      icon: 'deploy',
      onClick: () => options.onAction('deploy'),
    });
  }

  return suggestions;
}
