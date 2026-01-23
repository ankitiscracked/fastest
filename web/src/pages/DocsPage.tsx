import { useState, useEffect } from 'react';
import { useParams } from '@tanstack/react-router';
import { api } from '../api/client';
import type { WorkspaceDocs, GetDocContentResponse } from '@fastest/shared';
import { DocsTree } from '../components/docs/DocsTree';
import { DocViewer } from '../components/docs/DocViewer';

interface SelectedDoc {
  workspaceId: string;
  workspaceName: string;
  path: string;
}

export function DocsPage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };

  // State
  const [workspaces, setWorkspaces] = useState<WorkspaceDocs[]>([]);
  const [totalFiles, setTotalFiles] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected doc state
  const [selectedDoc, setSelectedDoc] = useState<SelectedDoc | null>(null);
  const [docContent, setDocContent] = useState<GetDocContentResponse | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // Workspace filter
  const [visibleWorkspaces, setVisibleWorkspaces] = useState<Set<string>>(new Set());

  // Load docs on mount
  useEffect(() => {
    if (projectId) {
      loadDocs();
    }
  }, [projectId]);

  // Load doc content when selection changes
  useEffect(() => {
    if (selectedDoc && projectId) {
      loadDocContent(selectedDoc);
    } else {
      setDocContent(null);
    }
  }, [selectedDoc, projectId]);

  const loadDocs = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.listProjectDocs(projectId);
      setWorkspaces(response.workspaces);
      setTotalFiles(response.total_files);

      // Initialize all workspaces as visible
      setVisibleWorkspaces(new Set(response.workspaces.map(w => w.workspace_id)));

      // Auto-select first doc if available
      if (response.workspaces.length > 0 && response.workspaces[0].files.length > 0) {
        const firstWorkspace = response.workspaces[0];
        const firstFile = firstWorkspace.files[0];
        setSelectedDoc({
          workspaceId: firstWorkspace.workspace_id,
          workspaceName: firstWorkspace.workspace_name,
          path: firstFile.path,
        });
      }
    } catch (err) {
      console.error('Failed to load docs:', err);
      setError(err instanceof Error ? err.message : 'Failed to load documentation');
    } finally {
      setLoading(false);
    }
  };

  const loadDocContent = async (doc: SelectedDoc) => {
    setLoadingContent(true);

    try {
      const response = await api.getDocContent(projectId, doc.workspaceId, doc.path);
      setDocContent(response);
    } catch (err) {
      console.error('Failed to load doc content:', err);
      setDocContent(null);
    } finally {
      setLoadingContent(false);
    }
  };

  const handleSelectDoc = (workspaceId: string, workspaceName: string, path: string) => {
    setSelectedDoc({ workspaceId, workspaceName, path });
  };

  const handleToggleWorkspace = (workspaceId: string) => {
    setVisibleWorkspaces(prev => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-50">
        <div className="text-surface-500">Loading documentation...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-50">
        <div className="text-center">
          <p className="text-status-error mb-4">{error}</p>
          <button
            onClick={loadDocs}
            className="px-4 py-2 bg-accent-500 text-white rounded-md hover:bg-accent-600"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-50">
      {/* Header */}
      <div className="bg-white border-b border-surface-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-accent-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <h1 className="text-lg font-semibold text-surface-800">Project Docs</h1>
            <span className="text-sm text-surface-500">
              {totalFiles} {totalFiles === 1 ? 'file' : 'files'} across {workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'}
            </span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {workspaces.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/* Tree sidebar */}
            <div className="w-72 border-r border-surface-200 bg-white flex flex-col">
              <DocsTree
                workspaces={workspaces}
                selectedDoc={selectedDoc}
                visibleWorkspaces={visibleWorkspaces}
                onSelectDoc={handleSelectDoc}
                onToggleWorkspace={handleToggleWorkspace}
              />
            </div>

            {/* Doc viewer */}
            <div className="flex-1 overflow-hidden">
              <DocViewer
                content={docContent}
                loading={loadingContent}
                selectedDoc={selectedDoc}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center py-16">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-surface-100 mb-4">
          <svg className="w-8 h-8 text-surface-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-surface-800 mb-2">No documentation yet</h3>
        <p className="text-surface-500 max-w-sm mx-auto">
          Documentation files (.md, .txt) will appear here when they are created in your workspaces.
        </p>
      </div>
    </div>
  );
}
