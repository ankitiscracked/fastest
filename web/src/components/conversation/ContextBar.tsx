import { useState, useRef, useEffect } from 'react';
import type { Project, Workspace } from '@fastest/shared';

interface ContextBarProps {
  projects: Project[];
  currentProject: Project | null;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  onProjectChange: (projectId: string) => void;
  onWorkspaceChange: (workspaceId: string) => void;
  onNewWorkspace: () => void;
  driftCount?: number;
  suggestionsCount?: number;
  runningJobsCount?: number;
}

export function ContextBar({
  projects,
  currentProject,
  workspaces,
  currentWorkspace,
  onProjectChange,
  onWorkspaceChange,
  onNewWorkspace,
  driftCount = 0,
  suggestionsCount = 0,
  runningJobsCount = 0,
}: ContextBarProps) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <div className="flex items-center gap-2">
        {/* Project Selector */}
        <Dropdown
          value={currentProject?.name || 'Select project'}
          options={projects.map((p) => ({
            id: p.id,
            label: p.name,
            selected: p.id === currentProject?.id,
          }))}
          onSelect={onProjectChange}
          placeholder="No projects"
        />

        <span className="text-gray-400">/</span>

        {/* Workspace Selector */}
        <WorkspaceDropdown
          workspaces={workspaces}
          currentWorkspace={currentWorkspace}
          onSelect={onWorkspaceChange}
          onNewWorkspace={onNewWorkspace}
          runningJobsCount={runningJobsCount}
        />

        {/* Status Badges */}
        {driftCount > 0 && (
          <button className="flex items-center gap-1 px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 hover:bg-yellow-200 transition-colors">
            <span>⚠️</span>
            <span className="text-xs font-medium">{driftCount}</span>
          </button>
        )}

        {suggestionsCount > 0 && (
          <button className="flex items-center gap-1 px-2 py-1 rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors">
            <span>💡</span>
            <span className="text-xs font-medium">{suggestionsCount}</span>
          </button>
        )}
      </div>

      {/* New Workspace Button */}
      <button
        onClick={onNewWorkspace}
        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        New workspace
      </button>
    </div>
  );
}

// Generic Dropdown Component
interface DropdownOption {
  id: string;
  label: string;
  selected?: boolean;
  badge?: string;
  subtitle?: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onSelect: (id: string) => void;
  placeholder?: string;
}

function Dropdown({ value, options, onSelect, placeholder = 'Select...' }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors font-medium text-gray-700"
      >
        <span>{value}</span>
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
          {options.length === 0 ? (
            <div className="px-4 py-2 text-sm text-gray-500">{placeholder}</div>
          ) : (
            options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => {
                  onSelect(opt.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center justify-between ${
                  opt.selected ? 'bg-primary-50 text-primary-700' : 'text-gray-700'
                }`}
              >
                <div>
                  <div className="font-medium">{opt.label}</div>
                  {opt.subtitle && <div className="text-xs text-gray-500">{opt.subtitle}</div>}
                </div>
                {opt.badge && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    {opt.badge}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Workspace-specific Dropdown
interface WorkspaceDropdownProps {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  onSelect: (workspaceId: string) => void;
  onNewWorkspace: () => void;
  runningJobsCount?: number;
}

function WorkspaceDropdown({
  workspaces,
  currentWorkspace,
  onSelect,
  onNewWorkspace,
  runningJobsCount = 0,
}: WorkspaceDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const displayName = currentWorkspace?.name || 'Select workspace';
  const isMain = currentWorkspace?.name === 'main';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors font-medium text-gray-700"
      >
        <span>{displayName}</span>
        {isMain && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">
            prod
          </span>
        )}
        {runningJobsCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-blue-600">
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
            running
          </span>
        )}
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
          <div className="px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
            Workspaces
          </div>

          {workspaces.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-500">No workspaces yet</div>
          ) : (
            workspaces.map((ws) => {
              const isSelected = ws.id === currentWorkspace?.id;
              const wsIsMain = ws.name === 'main';

              return (
                <button
                  key={ws.id}
                  onClick={() => {
                    onSelect(ws.id);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-4 py-2 hover:bg-gray-50 ${
                    isSelected ? 'bg-primary-50' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${isSelected ? 'bg-primary-500' : 'bg-gray-300'}`}
                      />
                      <span className={`font-medium ${isSelected ? 'text-primary-700' : 'text-gray-700'}`}>
                        {ws.name}
                      </span>
                      {wsIsMain && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                          prod
                        </span>
                      )}
                    </div>
                  </div>
                  {ws.local_path && (
                    <div className="ml-4 text-xs text-gray-500 truncate">{ws.local_path}</div>
                  )}
                </button>
              );
            })
          )}

          <div className="border-t border-gray-100 mt-1 pt-1">
            <button
              onClick={() => {
                onNewWorkspace();
                setOpen(false);
              }}
              className="w-full text-left px-4 py-2 text-sm text-primary-600 hover:bg-primary-50 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
