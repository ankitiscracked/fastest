import { useState, useEffect } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import type { Workspace, DriftReport } from '@fastest/shared';
import { api } from '../api/client';

interface WorkspaceWithDrift extends Workspace {
  drift?: DriftReport | null;
}

export function Workspaces() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const [workspaces, setWorkspaces] = useState<WorkspaceWithDrift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWorkspaces();
  }, [projectId]);

  const fetchWorkspaces = async () => {
    if (!projectId) return;
    try {
      setError(null);
      const data = await api.listWorkspaces(projectId);
      setWorkspaces(data.workspaces || []);
    } catch (err) {
      console.error('Failed to fetch workspaces:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch workspaces');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-gray-500">Loading workspaces...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <Link to="/projects/$projectId" params={{ projectId: projectId! }} className="text-sm text-gray-500 hover:text-gray-700">
            &larr; Back to Project
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">Workspaces</h1>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {workspaces.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <h3 className="text-lg font-medium text-gray-900 mb-2">No workspaces</h3>
          <p className="text-gray-500 mb-4">
            Create a workspace to start working on this project
          </p>
          <div className="bg-gray-100 rounded-lg p-4 inline-block text-left">
            <code className="text-sm">fst workspace create --name my-workspace</code>
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          {workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              to="/"
              className="block bg-white rounded-lg border border-gray-200 p-4 hover:border-primary-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-medium text-gray-900">{workspace.name}</h3>
                  <p className="text-sm text-gray-500 font-mono">{workspace.local_path}</p>
                  {workspace.base_snapshot_id && (
                    <p className="text-xs text-gray-400 mt-1">
                      Base: {workspace.base_snapshot_id.slice(0, 8)}...
                    </p>
                  )}
                </div>

                {/* Drift summary */}
                {workspace.drift && (
                  <div className="text-right">
                    <div className="flex items-center gap-2 text-sm">
                      {workspace.drift.files_added > 0 && (
                        <span className="text-green-600">+{workspace.drift.files_added}</span>
                      )}
                      {workspace.drift.files_modified > 0 && (
                        <span className="text-yellow-600">~{workspace.drift.files_modified}</span>
                      )}
                      {workspace.drift.files_deleted > 0 && (
                        <span className="text-red-600">-{workspace.drift.files_deleted}</span>
                      )}
                    </div>
                    {workspace.drift.summary && (
                      <p className="text-xs text-gray-500 mt-1 max-w-xs text-right">
                        {workspace.drift.summary}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Last seen */}
              <div className="mt-3 flex items-center text-xs text-gray-400">
                <span
                  className={`w-2 h-2 rounded-full mr-2 ${
                    workspace.last_seen_at &&
                    new Date(workspace.last_seen_at) > new Date(Date.now() - 60000)
                      ? 'bg-green-400'
                      : 'bg-gray-300'
                  }`}
                />
                {workspace.last_seen_at
                  ? `Last seen ${new Date(workspace.last_seen_at).toLocaleString()}`
                  : 'Never seen'}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
