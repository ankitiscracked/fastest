import { useState, useRef, useEffect } from 'react';
import type { Project, Workspace } from '@fastest/shared';
import { Menu, MenuTrigger, MenuPopup, MenuItem } from '../ui/menu';
import { Popover, PopoverTrigger, PopoverPopup } from '../ui/popover';

interface ContextBarProps {
  projects: Project[];
  currentProject: Project | null;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  mainWorkspaceId?: string | null;
  onProjectChange: (projectId: string) => void;
  onWorkspaceChange: (workspaceId: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onBranch: (workspaceName: string) => Promise<void>;
  isCreatingProject?: boolean;
  isBranching?: boolean;
}

export function ContextBar({
  projects,
  currentProject,
  workspaces,
  currentWorkspace,
  mainWorkspaceId,
  onProjectChange,
  onWorkspaceChange,
  onCreateProject,
  onBranch,
  isCreatingProject = false,
  isBranching = false,
}: ContextBarProps) {
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectName, setCreateProjectName] = useState('');
  const branchInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const isOnMain = currentWorkspace?.id === mainWorkspaceId;
  const hasProjects = projects.length > 0;

  useEffect(() => {
    if (branchOpen && branchInputRef.current) {
      branchInputRef.current.focus();
    }
  }, [branchOpen]);

  useEffect(() => {
    if (createProjectOpen && projectInputRef.current) {
      projectInputRef.current.focus();
    }
  }, [createProjectOpen]);

  const handleBranch = async () => {
    if (!branchName.trim()) return;
    await onBranch(branchName.trim());
    setBranchName('');
    setBranchOpen(false);
  };

  const handleCreateProject = async () => {
    if (!createProjectName.trim()) return;
    await onCreateProject(createProjectName.trim());
    setCreateProjectName('');
    setCreateProjectOpen(false);
  };

  // No projects yet - show create project button
  if (!hasProjects) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Popover open={createProjectOpen} onOpenChange={setCreateProjectOpen}>
          <PopoverTrigger
            disabled={isCreatingProject}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-surface-600 hover:text-surface-800 hover:bg-surface-100 rounded-md transition-colors"
          >
            {isCreatingProject ? (
              <>
                <Spinner />
                <span>Creating...</span>
              </>
            ) : (
              <>
                <PlusIcon />
                <span>New project</span>
              </>
            )}
          </PopoverTrigger>
          <PopoverPopup className="w-64 p-3">
            <input
              ref={projectInputRef}
              type="text"
              value={createProjectName}
              onChange={(e) => setCreateProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateProject();
                if (e.key === 'Escape') {
                  setCreateProjectOpen(false);
                  setCreateProjectName('');
                }
              }}
              placeholder="Project name..."
              className="input"
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={handleCreateProject}
                disabled={!createProjectName.trim() || isCreatingProject}
                className="btn-primary flex-1"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setCreateProjectOpen(false);
                  setCreateProjectName('');
                }}
                className="btn-ghost"
              >
                Cancel
              </button>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 text-sm">
      {/* Project selector */}
      <Menu>
        <MenuTrigger className="flex items-center gap-1 px-2 py-1 text-surface-600 hover:text-surface-800 hover:bg-surface-100 rounded-md transition-colors">
          <span>{currentProject?.name || 'Select project'}</span>
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup className="w-56">
          {projects.map((project) => (
            <MenuItem
              key={project.id}
              selected={project.id === currentProject?.id}
              onClick={() => onProjectChange(project.id)}
            >
              {project.name}
            </MenuItem>
          ))}
          <div className="border-t border-surface-100 mt-1 pt-1">
            <MenuItem
              onClick={() => setCreateProjectOpen(true)}
            >
              <span className="flex items-center gap-2 text-surface-500">
                <PlusIcon />
                New project...
              </span>
            </MenuItem>
          </div>
        </MenuPopup>
      </Menu>

      <span className="text-surface-300">/</span>

      {/* Workspace display */}
      {workspaces.length > 1 ? (
        <Menu>
          <MenuTrigger className="flex items-center gap-1 px-2 py-1 text-surface-600 hover:text-surface-800 hover:bg-surface-100 rounded-md transition-colors">
            <span>{currentWorkspace?.name || 'main'}</span>
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup className="w-56">
            {workspaces.map((workspace) => (
              <MenuItem
                key={workspace.id}
                selected={workspace.id === currentWorkspace?.id}
                onClick={() => onWorkspaceChange(workspace.id)}
              >
                <span>{workspace.name}</span>
                {workspace.id === mainWorkspaceId && (
                  <span className="text-xs text-surface-400">main</span>
                )}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : (
        <span className="px-2 py-1 text-surface-500">
          {currentWorkspace?.name || 'main'}
        </span>
      )}

      {/* Branch button - only show when on main */}
      {isOnMain && currentProject && (
        <Popover open={branchOpen} onOpenChange={setBranchOpen}>
          <PopoverTrigger
            disabled={isBranching}
            className="flex items-center gap-1 ml-2 px-2 py-1 text-xs text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-md transition-colors border border-surface-200"
          >
            {isBranching ? (
              <>
                <Spinner />
                <span>Creating...</span>
              </>
            ) : (
              <>
                <BranchIcon />
                <span>Branch</span>
              </>
            )}
          </PopoverTrigger>
          <PopoverPopup className="w-72 p-3">
            <div className="text-sm font-medium text-surface-800 mb-1">
              Create workspace
            </div>
            <p className="text-xs text-surface-500 mb-3">
              Files will be copied from the current state.
            </p>
            <input
              ref={branchInputRef}
              type="text"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleBranch();
                if (e.key === 'Escape') {
                  setBranchOpen(false);
                  setBranchName('');
                }
              }}
              placeholder="feature-name"
              className="input font-mono"
            />
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleBranch}
                disabled={!branchName.trim() || isBranching}
                className="btn-primary flex-1"
              >
                {isBranching ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => {
                  setBranchOpen(false);
                  setBranchName('');
                }}
                className="btn-ghost"
              >
                Cancel
              </button>
            </div>
          </PopoverPopup>
        </Popover>
      )}

      {/* Create Project Popover (triggered from menu) */}
      <Popover open={createProjectOpen} onOpenChange={setCreateProjectOpen}>
        <PopoverTrigger className="hidden" />
        <PopoverPopup className="w-64 p-3">
          <input
            ref={projectInputRef}
            type="text"
            value={createProjectName}
            onChange={(e) => setCreateProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateProject();
              if (e.key === 'Escape') {
                setCreateProjectOpen(false);
                setCreateProjectName('');
              }
            }}
            placeholder="Project name..."
            className="input"
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleCreateProject}
              disabled={!createProjectName.trim() || isCreatingProject}
              className="btn-primary flex-1"
            >
              Create
            </button>
            <button
              onClick={() => {
                setCreateProjectOpen(false);
                setCreateProjectName('');
              }}
              className="btn-ghost"
            >
              Cancel
            </button>
          </div>
        </PopoverPopup>
      </Popover>
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
    <svg className="w-3.5 h-3.5 text-surface-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
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
