import { useEffect, useState } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, RotateCw } from 'lucide-react';
import type { DeploymentRecord } from '@fastest/shared';
import { api } from '../api/client';

const statusStyles: Record<DeploymentRecord['status'], string> = {
  deploying: 'bg-blue-50 text-blue-700 border-blue-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
};

export function DeploymentHistoryPage() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
  const [workspaceName, setWorkspaceName] = useState('');
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const ws = await api.getWorkspace(workspaceId);
      setWorkspaceName(ws.workspace.name);
      const res = await api.getDeploymentHistory(workspaceId, 50);
      setDeployments(res.deployments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deployments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-gray-500">Loading deployment history…</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/workspaces/$workspaceId"
            params={{ workspaceId }}
            className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Deployment History</h1>
            <p className="text-sm text-gray-500">{workspaceName}</p>
          </div>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <RotateCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {deployments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-6 py-12 text-center text-sm text-gray-500">
          No deployments yet. Trigger a deployment to see it here.
        </div>
      ) : (
        <div className="space-y-3">
          {deployments.map((deployment) => (
            <div key={deployment.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${statusStyles[deployment.status]}`}>
                    {deployment.status.toUpperCase()}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {new Date(deployment.started_at).toLocaleString()}
                    </p>
                    <p className="text-xs text-gray-500">
                      Trigger: {deployment.trigger}
                    </p>
                  </div>
                </div>
                {deployment.url && (
                  <a
                    href={deployment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 text-xs font-semibold text-gray-700 hover:text-gray-900"
                  >
                    Open URL
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              {deployment.error && (
                <div className="mt-3 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {deployment.error}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
