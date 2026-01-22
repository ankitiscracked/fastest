import { useState, useRef, useEffect } from 'react';
import type { Project, Workspace } from '@fastest/shared';
import { Menu, MenuTrigger, MenuPopup, MenuItem } from '../ui/menu';
import { Popover, PopoverTrigger, PopoverPopup } from '../ui/popover';
import { InfoTooltip } from '../ui/tooltip';

interface ContextBarProps {
  projects: Project[];
  currentProject: Project | null;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  onProjectChange: (projectId: string) => void;
  onWorkspaceChange: (workspaceId: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onCreateWorkspace: (name: string) => Promise<void>;
  onClearSelection?: () => void;
  isCreatingProject?: boolean;
  isCreatingWorkspace?: boolean;
  driftCount?: number;
  runningMessagesCount?: number;
}

export function ContextBar({
  projects,
  currentProject,
  workspaces,
  currentWorkspace,
  onProjectChange,
  onWorkspaceChange,
  onCreateProject,
  onCreateWorkspace,
  onClearSelection,
  isCreatingProject = false,
  isCreatingWorkspace = false,
  driftCount = 0,
  runningMessagesCount = 0,
}: ContextBarProps) {
  const hasSelection = currentProject !== null || currentWorkspace !== null;

  return (
    <div className="flex items-center gap-2 text-sm">
      {/* Project Selector */}
      <SelectorWithCreate
        type="project"
        items={projects.map((p) => ({ id: p.id, name: p.name }))}
        currentItem={currentProject ? { id: currentProject.id, name: currentProject.name } : null}
        onSelect={onProjectChange}
        onCreate={onCreateProject}
        isCreating={isCreatingProject}
        infoContent={
          <>
            <strong>Projects</strong> are like Git repositories — isolated codebases with their own
            files and history.
          </>
        }
      />

      <span className="text-surface-300">/</span>

      {/* Workspace Selector */}
      <SelectorWithCreate
        type="workspace"
        items={workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          badge: w.name === 'main' ? 'prod' : undefined,
        }))}
        currentItem={
          currentWorkspace
            ? {
                id: currentWorkspace.id,
                name: currentWorkspace.name,
                badge: currentWorkspace.name === 'main' ? 'prod' : undefined,
              }
            : null
        }
        onSelect={onWorkspaceChange}
        onCreate={onCreateWorkspace}
        isCreating={isCreatingWorkspace}
        disabled={!currentProject}
        infoContent={
          <>
            <strong>Workspaces</strong> are like Git worktrees — parallel working directories of
            the same project. No branches to manage.
          </>
        }
      />

      {/* Clear Selection Button */}
      {hasSelection && onClearSelection && (
        <button
          onClick={onClearSelection}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
          title="Clear selection (Ctrl+X)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span className="text-xs">Clear</span>
        </button>
      )}

      {/* Status Badges */}
      {runningMessagesCount > 0 && (
        <span className="flex items-center gap-1 text-xs text-status-running ml-2">
          <span className="w-1.5 h-1.5 bg-status-running rounded-full animate-pulse" />
          running
        </span>
      )}

      {driftCount > 0 && (
        <button className="flex items-center gap-1 px-2 py-1 rounded-full bg-status-warning/10 text-status-warning hover:bg-status-warning/20 transition-colors ml-2">
          <span className="text-xs">⚠️ {driftCount} changes</span>
        </button>
      )}
    </div>
  );
}

// Selector with merged dropdown and create button
interface SelectorItem {
  id: string;
  name: string;
  badge?: string;
}

interface SelectorWithCreateProps {
  type: 'project' | 'workspace';
  items: SelectorItem[];
  currentItem: SelectorItem | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  isCreating?: boolean;
  disabled?: boolean;
  infoContent: React.ReactNode;
}

function SelectorWithCreate({
  type,
  items,
  currentItem,
  onSelect,
  onCreate,
  isCreating = false,
  disabled = false,
  infoContent,
}: SelectorWithCreateProps) {
  const [createName, setCreateName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const label = type === 'project' ? 'Project' : 'Workspace';
  const hasItems = items.length > 0;

  useEffect(() => {
    if (createOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [createOpen]);

  const handleCreate = async () => {
    if (!createName.trim()) return;
    await onCreate(createName.trim());
    setCreateName('');
    setCreateOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCreate();
    } else if (e.key === 'Escape') {
      setCreateOpen(false);
      setCreateName('');
    }
  };

  // No items: show create button only
  if (!hasItems) {
    return (
      <div className="flex items-center gap-1">
        <Popover open={createOpen} onOpenChange={setCreateOpen}>
          <PopoverTrigger
            disabled={disabled || isCreating}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              disabled
                ? 'text-surface-400 cursor-not-allowed'
                : 'text-accent-600 bg-accent-50 hover:bg-accent-100'
            }`}
          >
            {isCreating ? (
              <>
                <Spinner />
                Creating...
              </>
            ) : (
              <>
                <PlusIcon />
                Create {label}
              </>
            )}
          </PopoverTrigger>
          <PopoverPopup className="w-64 p-3">
            <input
              ref={inputRef}
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`${label} name...`}
              className="input"
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={handleCreate}
                disabled={!createName.trim() || isCreating}
                className="btn-primary flex-1"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setCreateOpen(false);
                  setCreateName('');
                }}
                className="btn-ghost"
              >
                Cancel
              </button>
            </div>
          </PopoverPopup>
        </Popover>

        <InfoTooltip>{infoContent}</InfoTooltip>
      </div>
    );
  }

  // Has items: show dropdown with create action
  return (
    <div className="flex items-center gap-0.5">
      <div className="flex">
        {/* Dropdown */}
        <Menu>
          <MenuTrigger
            disabled={disabled}
            className={`flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-l-lg text-sm font-medium transition-colors border-r border-surface-200 ${
              disabled
                ? 'text-surface-400 cursor-not-allowed bg-surface-50'
                : 'text-surface-700 hover:bg-surface-100'
            }`}
          >
            <span>{currentItem?.name || `Select ${label.toLowerCase()}`}</span>
            {currentItem?.badge && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-status-success/10 text-status-success">
                {currentItem.badge}
              </span>
            )}
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup className="w-64">
            <div className="px-3 py-2 text-xs font-medium text-surface-500 uppercase tracking-wide">
              {label}s
            </div>
            {items.map((item) => {
              const isSelected = item.id === currentItem?.id;
              return (
                <MenuItem
                  key={item.id}
                  selected={isSelected}
                  onClick={() => onSelect(item.id)}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${isSelected ? 'bg-accent-500' : 'bg-surface-300'}`}
                    />
                    <span className="font-medium">{item.name}</span>
                  </div>
                  {item.badge && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-status-success/10 text-status-success">
                      {item.badge}
                    </span>
                  )}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>

        {/* Create button with popover */}
        <Popover open={createOpen} onOpenChange={setCreateOpen}>
          <PopoverTrigger
            disabled={disabled || isCreating}
            className={`flex items-center px-2 py-1.5 rounded-r-lg text-sm transition-colors ${
              disabled
                ? 'text-surface-400 cursor-not-allowed bg-surface-50'
                : 'text-surface-500 hover:bg-surface-100 hover:text-accent-600'
            }`}
            title={`Create new ${label.toLowerCase()}`}
          >
            {isCreating ? <Spinner /> : <PlusIcon />}
          </PopoverTrigger>
          <PopoverPopup className="w-64 p-3">
            <div className="text-xs font-medium text-surface-500 uppercase tracking-wide mb-2">
              New {label}
            </div>
            <input
              ref={inputRef}
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`${label} name...`}
              className="input"
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={handleCreate}
                disabled={!createName.trim() || isCreating}
                className="btn-primary flex-1"
              >
                {isCreating ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => {
                  setCreateOpen(false);
                  setCreateName('');
                }}
                className="btn-ghost"
              >
                Cancel
              </button>
            </div>
          </PopoverPopup>
        </Popover>
      </div>

      <InfoTooltip>{infoContent}</InfoTooltip>
    </div>
  );
}

// Icons
function PlusIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="w-4 h-4 text-surface-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
