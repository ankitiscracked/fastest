import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Project, Workspace, ConversationWithContext } from '@fastest/shared';
import { api } from '../api/client';
import { PromptInput, ContextBar } from '../components/conversation';

export function Home() {
  const navigate = useNavigate();

  // Data state
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [conversations, setConversations] = useState<ConversationWithContext[]>([]);

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);

  // Load initial data
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [projectsRes, conversationsRes] = await Promise.all([
        api.listProjects(),
        api.listConversations({ limit: 20 }),
      ]);

      setProjects(projectsRes.projects);
      setConversations(conversationsRes.conversations);

      // Select first project if available
      if (projectsRes.projects.length > 0) {
        const firstProject = projectsRes.projects[0];
        setCurrentProject(firstProject);
        await loadWorkspacesForProject(firstProject.id);
      }
    } catch (err) {
      console.error('Failed to load data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const loadWorkspacesForProject = async (projectId: string) => {
    try {
      const { workspaces: workspaceList } = await api.listWorkspaces(projectId);
      setWorkspaces(workspaceList);

      // Select main workspace or first available
      if (workspaceList.length > 0) {
        const mainWorkspace = workspaceList.find((w) => w.name === 'main') || workspaceList[0];
        setCurrentWorkspace(mainWorkspace);
      } else {
        setCurrentWorkspace(null);
      }
    } catch (err) {
      console.error('Failed to load workspaces:', err);
    }
  };

  const handleProjectChange = async (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (project) {
      setCurrentProject(project);
      await loadWorkspacesForProject(projectId);
    }
  };

  const handleWorkspaceChange = (workspaceId: string) => {
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (workspace) {
      setCurrentWorkspace(workspace);
    }
  };

  const handleClearSelection = () => {
    setCurrentProject(null);
    setCurrentWorkspace(null);
    setWorkspaces([]);
  };

  const handleCreateProject = async (name: string) => {
    setIsCreatingProject(true);
    setError(null);
    try {
      const { project } = await api.createProject(name);
      setProjects((prev) => [project, ...prev]);
      setCurrentProject(project);

      // Create default 'main' workspace for new project
      const { workspace } = await api.createWorkspace(project.id, 'main');
      setWorkspaces([workspace]);
      setCurrentWorkspace(workspace);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleCreateWorkspace = async (name: string) => {
    if (!currentProject) return;

    setIsCreatingWorkspace(true);
    setError(null);
    try {
      const { workspace } = await api.createWorkspace(currentProject.id, name);
      setWorkspaces((prev) => [...prev, workspace]);
      setCurrentWorkspace(workspace);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setIsCreatingWorkspace(false);
    }
  };

  const handleSubmitPrompt = async (prompt: string) => {
    setIsCreating(true);
    setError(null);

    try {
      let workspaceId = currentWorkspace?.id;

      // Auto-create project and workspace if not selected
      if (!workspaceId) {
        // Generate a project name from the prompt (first few words, cleaned up)
        const projectName = prompt
          .slice(0, 50)
          .replace(/[^a-zA-Z0-9\s-]/g, '')
          .trim()
          .split(/\s+/)
          .slice(0, 4)
          .join('-')
          .toLowerCase() || 'new-project';

        // Create project
        const { project } = await api.createProject(projectName);
        setProjects((prev) => [project, ...prev]);
        setCurrentProject(project);

        // Create default 'main' workspace
        const { workspace } = await api.createWorkspace(project.id, 'main');
        setWorkspaces([workspace]);
        setCurrentWorkspace(workspace);
        workspaceId = workspace.id;
      }

      // Create a new conversation
      const { conversation } = await api.createConversation(workspaceId);

      // Navigate to the conversation
      navigate({ to: '/$conversationId', params: { conversationId: conversation.id } });

      // The ConversationView will handle sending the initial message
      // Store the prompt in sessionStorage for the ConversationView to pick up
      sessionStorage.setItem('pendingPrompt', prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create conversation');
      setIsCreating(false);
    }
  };

  const handleConversationClick = (conversationId: string) => {
    navigate({ to: '/$conversationId', params: { conversationId } });
  };

  const formatTimestamp = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-8">
          {/* Hero / Prompt Section */}
          <div className="text-center mb-8">
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">What do you want to build?</h1>
            <p className="text-gray-500">Start a new conversation or continue where you left off</p>
          </div>

          {/* Prompt Input */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-8">
            <PromptInput
              onSubmit={handleSubmitPrompt}
              isRunning={isCreating}
              placeholder="Describe what you want to build..."
            />
            <div className="mt-3">
              <ContextBar
                projects={projects}
                currentProject={currentProject}
                workspaces={workspaces}
                currentWorkspace={currentWorkspace}
                onProjectChange={handleProjectChange}
                onWorkspaceChange={handleWorkspaceChange}
                onCreateProject={handleCreateProject}
                onCreateWorkspace={handleCreateWorkspace}
                onClearSelection={handleClearSelection}
                isCreatingProject={isCreatingProject}
                isCreatingWorkspace={isCreatingWorkspace}
              />
            </div>
          </div>

          {/* Quick Next Steps */}
          <div className="mb-8">
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
              Quick Actions
            </h2>
            <div className="grid grid-cols-3 gap-3">
              <QuickActionCard
                icon={
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    />
                  </svg>
                }
                title="New Project"
                description="Start from scratch"
                onClick={() => {
                  // TODO: Implement new project flow
                }}
              />
              <QuickActionCard
                icon={
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </svg>
                }
                title="Import Repository"
                description="From GitHub or local"
                onClick={() => {
                  // TODO: Implement import flow
                }}
              />
              <QuickActionCard
                icon={
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                }
                title="Templates"
                description="Start with a template"
                onClick={() => {
                  // TODO: Implement templates
                }}
              />
            </div>
          </div>

          {/* Recent Conversations */}
          <div>
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
              Recent Conversations
            </h2>
            {conversations.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                <p className="text-gray-500">No conversations yet. Start one above!</p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
                {conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    onClick={() => handleConversationClick(conversation.id)}
                    className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors first:rounded-t-xl last:rounded-b-xl"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 truncate">
                            {conversation.title || 'Untitled conversation'}
                          </span>
                          <span className="text-xs text-gray-400">•</span>
                          <span className="text-xs text-gray-500 truncate">
                            {conversation.workspace_name}
                          </span>
                          <span className="text-xs text-gray-400">•</span>
                          <span className="text-xs text-gray-500">{conversation.project_name}</span>
                        </div>
                        {conversation.last_message_preview && (
                          <p className="text-sm text-gray-500 truncate mt-0.5">
                            {conversation.last_message_preview}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3 ml-4">
                        <span className="text-xs text-gray-400">
                          {formatTimestamp(conversation.updated_at)}
                        </span>
                        <svg
                          className="w-4 h-4 text-gray-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

interface QuickActionCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}

function QuickActionCard({ icon, title, description, onClick }: QuickActionCardProps) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-200 hover:border-primary-300 hover:shadow-sm transition-all text-center group"
    >
      <div className="w-10 h-10 rounded-full bg-gray-100 group-hover:bg-primary-100 flex items-center justify-center text-gray-500 group-hover:text-primary-600 transition-colors mb-2">
        {icon}
      </div>
      <span className="text-sm font-medium text-gray-900">{title}</span>
      <span className="text-xs text-gray-500">{description}</span>
    </button>
  );
}
