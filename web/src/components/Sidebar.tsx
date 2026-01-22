import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ChevronRight,
  Plus,
  Settings,
  LogOut,
  MessageSquare,
} from 'lucide-react';
import type { Project, Workspace, ConversationWithContext } from '@fastest/shared';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Popover, PopoverTrigger, PopoverPopup } from './ui/popover';

interface ProjectWithWorkspaces extends Project {
  workspaces?: Workspace[];
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
  const [currentConversation, setCurrentConversation] = useState<ConversationWithContext | null>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [createProjectName, setCreateProjectName] = useState('');
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [creatingWorkspaceFor, setCreatingWorkspaceFor] = useState<string | null>(null);
  const [createWorkspaceName, setCreateWorkspaceName] = useState('');

  // Load initial data
  useEffect(() => {
    loadData();
  }, []);

  // Load current conversation when conversationId changes
  useEffect(() => {
    if (conversationId) {
      loadCurrentConversation(conversationId);
    } else {
      setCurrentConversation(null);
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
      setCurrentConversation(conversation);

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
      setProjects(prev => prev.map(p =>
        p.id === projectId
          ? { ...p, workspaces, isLoadingWorkspaces: false }
          : p
      ));
    } catch (err) {
      console.error('Failed to load workspaces:', err);
      setProjects(prev => prev.map(p =>
        p.id === projectId ? { ...p, isLoadingWorkspaces: false } : p
      ));
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

  const isWorkspaceActive = (workspaceId: string) => {
    return currentConversation?.workspace_id === workspaceId;
  };

  return (
    <div className="w-60 h-full flex flex-col bg-gray-50 border-r border-gray-200">
      {/* Header */}
      <div className="flex-shrink-0 h-12 px-4 flex items-center justify-between border-b border-gray-200 bg-white">
        <Link to="/" className="text-lg font-bold text-primary-600">
          Fastest
        </Link>
        <div className="flex items-center gap-2">
          {user?.picture ? (
            <img
              src={user.picture}
              alt={user.name || user.email}
              className="w-6 h-6 rounded-full"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-primary-100 flex items-center justify-center text-xs font-medium text-primary-700">
              {(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
            </div>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Projects section */}
        <div className="px-3 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Projects
            </span>
          </div>

          {loading ? (
            <div className="text-sm text-gray-400 px-2 py-4">Loading...</div>
          ) : projects.length === 0 ? (
            <div className="text-sm text-gray-400 px-2 py-4">No projects yet</div>
          ) : (
            <div className="space-y-1">
              {projects.map(project => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  isActive={currentConversation?.project_id === project.id}
                  isWorkspaceActive={isWorkspaceActive}
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
            <PopoverTrigger className="w-full mt-2 flex items-center gap-2 px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md transition-colors">
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                autoFocus
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleCreateProject}
                  disabled={!createProjectName.trim() || isCreatingProject}
                  className="flex-1 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                >
                  {isCreatingProject ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={() => {
                    setCreateProjectOpen(false);
                    setCreateProjectName('');
                  }}
                  className="px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-lg text-sm"
                >
                  Cancel
                </button>
              </div>
            </PopoverPopup>
          </Popover>
        </div>

        {/* Divider */}
        <div className="mx-3 border-t border-gray-200" />

        {/* Recent conversations section */}
        <div className="px-3 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Recent
            </span>
          </div>

          {recentConversations.length === 0 ? (
            <div className="text-sm text-gray-400 px-2 py-4">No conversations yet</div>
          ) : (
            <div className="space-y-1">
              {recentConversations.map(conv => (
                <Link
                  key={conv.id}
                  to="/$conversationId"
                  params={{ conversationId: conv.id }}
                  className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors ${
                    conversationId === conv.id
                      ? 'bg-primary-100 text-primary-700'
                      : 'text-gray-700 hover:bg-gray-100'
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

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-gray-200 bg-white">
        <Link
          to="/settings"
          className="flex items-center gap-2 px-4 py-3 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <Settings className="w-4 h-4" />
          <span>Settings</span>
        </Link>
        <button
          onClick={logout}
          className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-600 hover:bg-gray-50 transition-colors border-t border-gray-100"
        >
          <LogOut className="w-4 h-4" />
          <span>Logout</span>
        </button>
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
          <div className="relative bg-white rounded-lg shadow-xl w-80 p-4">
            <div className="text-sm font-medium text-gray-900 mb-3">New Workspace</div>
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
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              autoFocus
            />
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => creatingWorkspaceFor && handleCreateWorkspace(creatingWorkspaceFor)}
                disabled={!createWorkspaceName.trim()}
                className="flex-1 px-3 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setCreatingWorkspaceFor(null);
                  setCreateWorkspaceName('');
                }}
                className="px-3 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm"
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
  isActive: boolean;
  isWorkspaceActive: (workspaceId: string) => boolean;
  onToggle: () => void;
  onCreateWorkspace: () => void;
  onCreateConversation: (workspaceId: string) => void;
}

function ProjectItem({
  project,
  isActive,
  isWorkspaceActive,
  onToggle,
  onCreateWorkspace,
  onCreateConversation,
}: ProjectItemProps) {
  const [hovering, setHovering] = useState(false);

  return (
    <div>
      {/* Project row */}
      <div
        className={`group flex items-center gap-1 px-2 py-1.5 rounded-md transition-colors ${
          isActive ? 'bg-primary-50' : 'hover:bg-gray-100'
        }`}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {/* Expand/collapse button */}
        <button
          onClick={onToggle}
          className="flex-shrink-0 p-0.5 text-gray-400 hover:text-gray-600"
        >
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${project.isExpanded ? 'rotate-90' : ''}`} />
        </button>

        {/* Project name - links to project page */}
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className={`flex-1 text-sm font-medium truncate ${
            isActive ? 'text-primary-700' : 'text-gray-700'
          }`}
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
            className="flex-shrink-0 p-0.5 text-gray-400 hover:text-primary-600"
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
            <div className="px-2 py-1 text-xs text-gray-400">Loading...</div>
          ) : project.workspaces?.length === 0 ? (
            <div className="px-2 py-1 text-xs text-gray-400">No workspaces</div>
          ) : (
            project.workspaces?.map(workspace => (
              <WorkspaceItem
                key={workspace.id}
                workspace={workspace}
                isActive={isWorkspaceActive(workspace.id)}
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
  workspace: Workspace;
  isActive: boolean;
  onCreateConversation: () => void;
}

function WorkspaceItem({ workspace, isActive, onCreateConversation }: WorkspaceItemProps) {
  const [hovering, setHovering] = useState(false);

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${
        isActive ? 'bg-primary-100 text-primary-700' : 'hover:bg-gray-100 text-gray-600'
      }`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Status indicator */}
      <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${
        isActive ? 'bg-primary-500' : 'bg-gray-300'
      }`} />

      {/* Workspace name - links to workspace page */}
      <Link
        to="/workspaces/$workspaceId"
        params={{ workspaceId: workspace.id }}
        className="flex-1 text-sm truncate"
      >
        {workspace.name}
        {workspace.name === 'main' && (
          <span className="ml-1 text-xs text-green-600">(prod)</span>
        )}
      </Link>

      {/* Plus button for creating conversation */}
      {hovering && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onCreateConversation();
          }}
          className="flex-shrink-0 p-0.5 text-gray-400 hover:text-primary-600"
          title="New conversation"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
