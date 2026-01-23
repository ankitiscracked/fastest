import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ChevronRight,
  Plus,
  Settings,
  LogOut,
  MessageSquare,
  AlertTriangle,
  Check,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';
import type { Project, Workspace, ConversationWithContext } from '@fastest/shared';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Popover, PopoverTrigger, PopoverPopup } from './ui/popover';

interface WorkspaceWithDrift extends Workspace {
  hasDrift?: boolean;
  isMainWorkspace?: boolean;
  driftLoading?: boolean;
}

interface ProjectWithWorkspaces extends Project {
  workspaces?: WorkspaceWithDrift[];
  isExpanded?: boolean;
  isLoadingWorkspaces?: boolean;
}

export function Sidebar() {
  const navigate = useNavigate();
  const { conversationId } = useParams({ strict: false }) as { conversationId?: string };
  const { user, logout } = useAuth();

  // Data state
  const [projects, setProjects] = useState<ProjectWithWorkspaces[]>([]);
  const [recentConversations, setRecentConversations] = useState<ConversationWithContext[]>([]);

  // UI state
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [createProjectName, setCreateProjectName] = useState('');
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [creatingWorkspaceFor, setCreatingWorkspaceFor] = useState<string | null>(null);
  const [createWorkspaceName, setCreateWorkspaceName] = useState('');

  // Load initial data
  useEffect(() => {
    loadData();
  }, []);

  // Load current conversation when conversationId changes (for auto-expanding project)
  useEffect(() => {
    if (conversationId) {
      loadCurrentConversation(conversationId);
    }
  }, [conversationId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [projectsRes, conversationsRes] = await Promise.all([
        api.listProjects(),
        api.listConversations({ limit: 10 }),
      ]);

      setProjects(projectsRes.projects.map(p => ({ ...p, isExpanded: false })));
      setRecentConversations(conversationsRes.conversations);
    } catch (err) {
      console.error('Failed to load sidebar data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadCurrentConversation = async (convId: string) => {
    try {
      const { conversation } = await api.getConversation(convId);

      // Auto-expand the project containing this conversation
      const projectId = conversation.project_id;
      setProjects(prev => prev.map(p => {
        if (p.id === projectId && !p.isExpanded) {
          // Load workspaces if not already loaded
          if (!p.workspaces) {
            loadWorkspacesForProject(projectId);
          }
          return { ...p, isExpanded: true };
        }
        return p;
      }));
    } catch (err) {
      console.error('Failed to load current conversation:', err);
    }
  };

  const loadWorkspacesForProject = async (projectId: string) => {
    setProjects(prev => prev.map(p =>
      p.id === projectId ? { ...p, isLoadingWorkspaces: true } : p
    ));

    try {
      const { workspaces } = await api.listWorkspaces(projectId);

      // Get project to find main workspace
      const project = projects.find(p => p.id === projectId);
      const mainWorkspaceId = project?.main_workspace_id;

      // Mark workspaces and start loading drift
      const workspacesWithDrift: WorkspaceWithDrift[] = workspaces.map(ws => ({
        ...ws,
        isMainWorkspace: ws.id === mainWorkspaceId,
        hasDrift: false,
        driftLoading: ws.id !== mainWorkspaceId && !!mainWorkspaceId, // Load drift for non-main workspaces
      }));

      setProjects(prev => prev.map(p =>
        p.id === projectId
          ? { ...p, workspaces: workspacesWithDrift, isLoadingWorkspaces: false }
          : p
      ));

      // Load drift for each non-main workspace (in background)
      if (mainWorkspaceId) {
        for (const ws of workspacesWithDrift) {
          if (!ws.isMainWorkspace) {
            loadDriftForWorkspace(projectId, ws.id);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load workspaces:', err);
      setProjects(prev => prev.map(p =>
        p.id === projectId ? { ...p, isLoadingWorkspaces: false } : p
      ));
    }
  };

  const loadDriftForWorkspace = async (projectId: string, workspaceId: string) => {
    try {
      const { drift, is_main_workspace } = await api.getDriftComparison(workspaceId);

      setProjects(prev => prev.map(p => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          workspaces: p.workspaces?.map(ws => {
            if (ws.id !== workspaceId) return ws;
            return {
              ...ws,
              hasDrift: drift ? drift.total_drift_files > 0 : false,
              isMainWorkspace: is_main_workspace,
              driftLoading: false,
            };
          }),
        };
      }));
    } catch (err) {
      console.error('Failed to load drift for workspace:', err);
      setProjects(prev => prev.map(p => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          workspaces: p.workspaces?.map(ws =>
            ws.id === workspaceId ? { ...ws, driftLoading: false } : ws
          ),
        };
      }));
    }
  };

  const toggleProject = (projectId: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) {
        const willExpand = !p.isExpanded;
        // Load workspaces when expanding if not already loaded
        if (willExpand && !p.workspaces) {
          loadWorkspacesForProject(projectId);
        }
        return { ...p, isExpanded: willExpand };
      }
      return p;
    }));
  };

  const handleCreateProject = async () => {
    if (!createProjectName.trim()) return;

    setIsCreatingProject(true);
    try {
      const { project } = await api.createProject(createProjectName.trim());

      // Create default 'main' workspace
      const { workspace } = await api.createWorkspace(project.id, 'main');

      // Add to projects list with workspace
      setProjects(prev => [{
        ...project,
        workspaces: [workspace],
        isExpanded: true,
      }, ...prev]);

      setCreateProjectName('');
      setCreateProjectOpen(false);
    } catch (err) {
      console.error('Failed to create project:', err);
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleCreateWorkspace = async (projectId: string) => {
    if (!createWorkspaceName.trim()) return;

    try {
      const { workspace } = await api.createWorkspace(projectId, createWorkspaceName.trim());

      // Add to project's workspaces
      setProjects(prev => prev.map(p =>
        p.id === projectId
          ? { ...p, workspaces: [...(p.workspaces || []), workspace] }
          : p
      ));

      setCreateWorkspaceName('');
      setCreatingWorkspaceFor(null);
    } catch (err) {
      console.error('Failed to create workspace:', err);
    }
  };

  const handleCreateConversation = async (workspaceId: string) => {
    try {
      const { conversation } = await api.createConversation(workspaceId);
      navigate({ to: '/$conversationId', params: { conversationId: conversation.id } });

      // Refresh recent conversations
      const conversationsRes = await api.listConversations({ limit: 10 });
      setRecentConversations(conversationsRes.conversations);
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  };

  return (
    <div className={`${collapsed ? 'w-14' : 'w-60'} h-full flex flex-col bg-surface-50 border-r border-surface-200 transition-all duration-200`}>
      {/* Header */}
      <div className={`flex-shrink-0 h-12 ${collapsed ? 'px-2' : 'px-4'} flex items-center justify-between border-b border-surface-200 bg-white`}>
        {!collapsed && (
          <Link to="/" className="text-lg font-bold text-accent-600">
            Fastest
          </Link>
        )}
        <div className={`flex items-center gap-2 ${collapsed ? 'w-full justify-center' : ''}`}>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1.5 text-surface-400 hover:text-surface-600 hover:bg-surface-100 rounded-md transition-colors"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
          {!collapsed && (
            user?.picture ? (
              <img
                src={user.picture}
                alt={user.name || user.email}
                className="w-6 h-6 rounded-full"
              />
            ) : (
              <div className="w-6 h-6 rounded-full bg-accent-100 flex items-center justify-center text-xs font-medium text-accent-700">
                {(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
              </div>
            )
          )}
        </div>
      </div>

      {/* Scrollable content */}
      {collapsed ? (
        // Collapsed view - just icons
        <div className="flex-1 overflow-y-auto py-3">
          <div className="flex flex-col items-center gap-2">
            <Link
              to="/"
              className="p-2 text-surface-500 hover:text-accent-600 hover:bg-surface-100 rounded-md transition-colors"
              title="Home"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            </Link>
            {recentConversations.slice(0, 5).map(conv => (
              <Link
                key={conv.id}
                to="/$conversationId"
                params={{ conversationId: conv.id }}
                className={`p-2 rounded-md transition-colors ${
                  conversationId === conv.id
                    ? 'bg-surface-100 text-surface-700'
                    : 'text-surface-500 hover:text-surface-700 hover:bg-surface-100'
                }`}
                title={conv.title || 'Untitled'}
              >
                <MessageSquare className="w-5 h-5" />
              </Link>
            ))}
          </div>
        </div>
      ) : (
        // Expanded view - full content
        <div className="flex-1 overflow-y-auto">
          {/* Projects section */}
          <div className="px-3 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-surface-500">
                Projects
              </span>
            </div>

            {loading ? (
              <div className="text-sm text-surface-400 px-2 py-4">Loading...</div>
            ) : projects.length === 0 ? (
              <div className="text-sm text-surface-400 px-2 py-4">No projects yet</div>
            ) : (
              <div className="space-y-1">
                {projects.map(project => (
                  <ProjectItem
                    key={project.id}
                    project={project}
                    onToggle={() => toggleProject(project.id)}
                    onCreateWorkspace={() => {
                      setCreatingWorkspaceFor(project.id);
                    }}
                    onCreateConversation={handleCreateConversation}
                  />
                ))}
              </div>
            )}

            {/* New Project Button */}
            <Popover open={createProjectOpen} onOpenChange={setCreateProjectOpen}>
              <PopoverTrigger className="w-full mt-2 flex items-center gap-2 px-2 py-1.5 text-sm text-surface-600 hover:bg-surface-100 rounded-md transition-colors">
                <Plus className="w-4 h-4" />
                <span>New Project</span>
              </PopoverTrigger>
              <PopoverPopup className="w-56 p-3">
                <input
                  type="text"
                  value={createProjectName}
                  onChange={e => setCreateProjectName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreateProject();
                    if (e.key === 'Escape') {
                      setCreateProjectOpen(false);
                      setCreateProjectName('');
                    }
                  }}
                  placeholder="Project name..."
                  className="input"
                  autoFocus
                />
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={handleCreateProject}
                    disabled={!createProjectName.trim() || isCreatingProject}
                    className="btn-primary flex-1"
                  >
                    {isCreatingProject ? 'Creating...' : 'Create'}
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

          {/* Divider */}
          <div className="mx-3 border-t border-surface-200" />

          {/* Recent conversations section */}
          <div className="px-3 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-surface-500">
                Recent
              </span>
            </div>

            {recentConversations.length === 0 ? (
              <div className="text-sm text-surface-400 px-2 py-4">No conversations yet</div>
            ) : (
              <div className="space-y-1">
                {recentConversations.map(conv => (
                  <Link
                    key={conv.id}
                    to="/$conversationId"
                    params={{ conversationId: conv.id }}
                    className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors ${
                      conversationId === conv.id
                        ? 'bg-surface-100 text-surface-900'
                        : 'text-surface-700 hover:bg-surface-100'
                    }`}
                    title={conv.title || 'Untitled'}
                  >
                    <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">{conv.title || 'Untitled'}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-surface-200 bg-white">
        {collapsed ? (
          // Collapsed footer - just icons
          <div className="flex flex-col items-center py-2 gap-1">
            <Link
              to="/settings"
              className="p-2 text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-md transition-colors"
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </Link>
            <button
              onClick={logout}
              className="p-2 text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-md transition-colors"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        ) : (
          // Expanded footer
          <>
            <Link
              to="/settings"
              className="flex items-center gap-2 px-4 py-3 text-sm text-surface-600 hover:bg-surface-50 transition-colors"
            >
              <Settings className="w-4 h-4" />
              <span>Settings</span>
            </Link>
            <button
              onClick={logout}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm text-surface-600 hover:bg-surface-50 transition-colors border-t border-surface-100"
            >
              <LogOut className="w-4 h-4" />
              <span>Logout</span>
            </button>
          </>
        )}
      </div>

      {/* Create Workspace Modal */}
      {creatingWorkspaceFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => {
              setCreatingWorkspaceFor(null);
              setCreateWorkspaceName('');
            }}
          />
          <div className="relative bg-white rounded-md shadow-xl w-80 p-4">
            <div className="text-sm font-medium text-surface-800 mb-3">New Workspace</div>
            <input
              type="text"
              value={createWorkspaceName}
              onChange={e => setCreateWorkspaceName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && creatingWorkspaceFor) handleCreateWorkspace(creatingWorkspaceFor);
                if (e.key === 'Escape') {
                  setCreatingWorkspaceFor(null);
                  setCreateWorkspaceName('');
                }
              }}
              placeholder="Workspace name..."
              className="input"
              autoFocus
            />
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => creatingWorkspaceFor && handleCreateWorkspace(creatingWorkspaceFor)}
                disabled={!createWorkspaceName.trim()}
                className="btn-primary flex-1"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setCreatingWorkspaceFor(null);
                  setCreateWorkspaceName('');
                }}
                className="btn-ghost"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ProjectItemProps {
  project: ProjectWithWorkspaces;
  onToggle: () => void;
  onCreateWorkspace: () => void;
  onCreateConversation: (workspaceId: string) => void;
}

function ProjectItem({
  project,
  onToggle,
  onCreateWorkspace,
  onCreateConversation,
}: ProjectItemProps) {
  const [hovering, setHovering] = useState(false);

  return (
    <div>
      {/* Project row */}
      <div
        className="group flex items-center gap-1 px-2 py-1.5 rounded-md transition-colors hover:bg-surface-100"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {/* Expand/collapse button */}
        <button
          onClick={onToggle}
          className="flex-shrink-0 p-0.5 text-surface-400 hover:text-surface-600"
        >
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${project.isExpanded ? 'rotate-90' : ''}`} />
        </button>

        {/* Project name - links to project page */}
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className="flex-1 text-sm font-medium truncate text-surface-700"
        >
          {project.name}
        </Link>

        {/* Plus button for creating workspace */}
        {hovering && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCreateWorkspace();
            }}
            className="flex-shrink-0 p-0.5 text-surface-400 hover:text-accent-600"
            title="New workspace"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Workspaces */}
      {project.isExpanded && (
        <div className="ml-4 mt-0.5 space-y-0.5">
          {project.isLoadingWorkspaces ? (
            <div className="px-2 py-1 text-xs text-surface-400">Loading...</div>
          ) : project.workspaces?.length === 0 ? (
            <div className="px-2 py-1 text-xs text-surface-400">No workspaces</div>
          ) : (
            project.workspaces?.map(workspace => (
              <WorkspaceItem
                key={workspace.id}
                workspace={workspace}
                onCreateConversation={() => onCreateConversation(workspace.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface WorkspaceItemProps {
  workspace: WorkspaceWithDrift;
  onCreateConversation: () => void;
}

function WorkspaceItem({ workspace, onCreateConversation }: WorkspaceItemProps) {
  const [hovering, setHovering] = useState(false);

  const getDriftIndicator = () => {
    if (workspace.isMainWorkspace) {
      return null; // Main workspace doesn't show drift indicator
    }
    if (workspace.driftLoading) {
      return (
        <span className="flex-shrink-0 w-3 h-3 rounded-full border border-surface-300 border-t-transparent animate-spin" />
      );
    }
    if (workspace.hasDrift) {
      return (
        <span title="Out of sync with main">
          <AlertTriangle className="flex-shrink-0 w-3.5 h-3.5 text-status-warning" />
        </span>
      );
    }
    return (
      <span title="Synced with main">
        <Check className="flex-shrink-0 w-3.5 h-3.5 text-status-success" />
      </span>
    );
  };

  return (
    <div
      className="group flex items-center gap-1 px-2 py-1 rounded-md transition-colors hover:bg-surface-100 text-surface-600"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Status indicator */}
      <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-surface-300" />

      {/* Workspace name - links to workspace page */}
      <Link
        to="/workspaces/$workspaceId"
        params={{ workspaceId: workspace.id }}
        className="flex-1 text-sm truncate"
      >
        {workspace.name}
        {workspace.isMainWorkspace && (
          <span className="ml-1 text-xs text-status-success">(main)</span>
        )}
      </Link>

      {/* Drift indicator */}
      {!hovering && getDriftIndicator()}

      {/* Plus button for creating conversation */}
      {hovering && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onCreateConversation();
          }}
          className="flex-shrink-0 p-0.5 text-surface-400 hover:text-accent-600"
          title="New conversation"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
