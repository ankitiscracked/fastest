import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Project, Workspace, ConversationWithContext } from '@fastest/shared';
import { api } from '../api/client';
import { PromptInput, ContextBar } from '../components/conversation';
import { ActionItems } from '../components/conversation/ActionItems';
import { NextSteps, ProjectBriefWizard } from '../components/suggestions';

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
  const [showBriefWizard, setShowBriefWizard] = useState(false);

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
        <div className="text-surface-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-50">
      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3">
          <p className="text-sm text-status-error">{error}</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-8">
          {/* Hero / Prompt Section */}
          <div className="text-center mb-8">
            <h1 className="text-2xl font-semibold text-surface-800 mb-2">What do you want to build?</h1>
            <p className="text-surface-500">Start a new conversation or continue where you left off</p>
          </div>

          {/* Prompt Input */}
          <div className="bg-white rounded-md border border-surface-200 p-4 mb-8">
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
                mainWorkspaceId={currentProject?.main_workspace_id}
                onProjectChange={handleProjectChange}
                onWorkspaceChange={handleWorkspaceChange}
                onCreateProject={handleCreateProject}
                onBranch={async () => {}} // Branching happens in conversation view
                isCreatingProject={isCreatingProject}
              />
            </div>
          </div>

          {/* Action Items - cross-workspace insights */}
          <div className="mb-8">
            <ActionItems
              onNavigateToWorkspace={(workspaceId, _projectId) => {
                // Find a conversation for this workspace, or create one
                const conv = conversations.find((c) => c.workspace_id === workspaceId);
                if (conv) {
                  navigate({ to: '/$conversationId', params: { conversationId: conv.id } });
                } else {
                  // Navigate to workspace detail or create conversation
                  navigate({ to: '/workspaces/$workspaceId', params: { workspaceId } });
                }
              }}
              onSyncWorkspace={(workspaceId) => {
                // Navigate to workspace and trigger sync
                navigate({ to: '/workspaces/$workspaceId', params: { workspaceId } });
              }}
              onApplyPrompt={async (workspaceId, prompt) => {
                // Find or create a conversation for this workspace, then navigate with the prompt pre-filled
                const conv = conversations.find((c) => c.workspace_id === workspaceId);
                if (conv) {
                  // Store the prompt in sessionStorage for the ConversationView to pick up
                  sessionStorage.setItem('pendingPrompt', prompt);
                  navigate({ to: '/$conversationId', params: { conversationId: conv.id } });
                } else {
                  // Create a new conversation for this workspace
                  try {
                    const { conversation } = await api.createConversation(workspaceId);
                    sessionStorage.setItem('pendingPrompt', prompt);
                    navigate({ to: '/$conversationId', params: { conversationId: conversation.id } });
                  } catch (err) {
                    console.error('Failed to create conversation:', err);
                    // Fallback: navigate to workspace
                    navigate({ to: '/workspaces/$workspaceId', params: { workspaceId } });
                  }
                }
              }}
            />
          </div>

          {/* Next Steps */}
          {currentProject?.brief && (
            <div className="mb-8">
              <NextSteps
                projectId={currentProject.id}
                onStartSuggestion={(_suggestionId, prompt) => {
                  void handleSubmitPrompt(prompt);
                }}
              />
            </div>
          )}

          {/* Project Brief CTA */}
          {currentProject && !currentProject.brief && (
            <div className="mb-8 p-4 bg-accent-50 border border-accent-200 rounded-md">
              <p className="text-sm text-accent-800 mb-2">
                Set up your project brief to get tailored next steps.
              </p>
              <button
                onClick={() => setShowBriefWizard(true)}
                className="text-sm font-medium text-accent-600 hover:text-accent-700"
              >
                Set up project →
              </button>
            </div>
          )}

          {/* Recent Conversations */}
          <div>
            <h2 className="text-sm font-medium text-surface-500 mb-3">
              Recent conversations
            </h2>
            {conversations.length === 0 ? (
              <div className="bg-white rounded-md border border-surface-200 p-8 text-center">
                <p className="text-surface-500">No conversations yet. Start one above!</p>
              </div>
            ) : (
              <div className="bg-white rounded-md border border-surface-200 divide-y divide-surface-100">
                {conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    onClick={() => handleConversationClick(conversation.id)}
                    className="w-full text-left px-4 py-3 hover:bg-surface-50 transition-colors first:rounded-t-md last:rounded-b-md"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-surface-800 truncate">
                            {conversation.title || 'Untitled conversation'}
                          </span>
                          <span className="text-xs text-surface-400">•</span>
                          <span className="text-xs text-surface-500 truncate">
                            {conversation.workspace_name}
                          </span>
                          <span className="text-xs text-surface-400">•</span>
                          <span className="text-xs text-surface-500">{conversation.project_name}</span>
                        </div>
                        {conversation.last_message_preview && (
                          <p className="text-sm text-surface-500 truncate mt-0.5">
                            {conversation.last_message_preview}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3 ml-4">
                        <span className="text-xs text-surface-400">
                          {formatTimestamp(conversation.updated_at)}
                        </span>
                        <svg
                          className="w-4 h-4 text-surface-400"
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

      {showBriefWizard && currentProject && (
        <ProjectBriefWizard
          projectId={currentProject.id}
          onClose={() => setShowBriefWizard(false)}
          onComplete={(brief) => {
            setShowBriefWizard(false);
            setCurrentProject((prev) =>
              prev ? { ...prev, brief, intent: brief.intent } : prev
            );
            setProjects((prev) =>
              prev.map((project) =>
                project.id === currentProject.id
                  ? { ...project, brief, intent: brief.intent }
                  : project
              )
            );
          }}
        />
      )}

    </div>
  );
}
