import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Workspace, DriftReport } from '@fastest/shared';
import { api } from '../api/client';

interface DriftDetail {
  base_snapshot_id: string;
  files_added: string[];
  files_modified: string[];
  files_deleted: string[];
  total_bytes_changed: number;
}

export function WorkspaceDetail() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [drift, setDrift] = useState<DriftReport | null>(null);
  const [driftDetail, setDriftDetail] = useState<DriftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWorkspace();
  }, [workspaceId]);

  const fetchWorkspace = async () => {
    if (!workspaceId) return;
    try {
      setError(null);
      const data = await api.getWorkspace(workspaceId);
      setWorkspace(data.workspace);
      setDrift(data.drift);
      // Note: drift_detail will come from a separate endpoint when implemented
      setDriftDetail(null);
    } catch (err) {
      console.error('Failed to fetch workspace:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch workspace');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-gray-500">Loading workspace...</div>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="text-center py-12">
        <h2 className="text-lg font-medium text-gray-900">Workspace not found</h2>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Header */}
      <div>
        <Link
          to={`/projects/${workspace.project_id}/workspaces`}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          &larr; Back to Workspaces
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">{workspace.name}</h1>
        <p className="text-sm text-gray-500 font-mono">{workspace.local_path}</p>
      </div>

      {/* Drift Summary */}
      {drift && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-medium text-gray-900 mb-3">Drift Summary</h3>

          <div className="flex items-center gap-6 mb-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">+{drift.files_added}</div>
              <div className="text-xs text-gray-500">Added</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-yellow-600">~{drift.files_modified}</div>
              <div className="text-xs text-gray-500">Modified</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">-{drift.files_deleted}</div>
              <div className="text-xs text-gray-500">Deleted</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-600">
                {formatBytes(drift.bytes_changed)}
              </div>
              <div className="text-xs text-gray-500">Changed</div>
            </div>
          </div>

          {drift.summary && (
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-sm text-gray-700">{drift.summary}</p>
              <p className="text-xs text-gray-400 mt-1">
                Generated {new Date(drift.reported_at).toLocaleString()}
              </p>
            </div>
          )}
        </div>
      )}

      {/* File Changes */}
      {driftDetail && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-sm font-medium text-gray-900">Changed Files</h3>
          </div>

          <div className="divide-y divide-gray-200">
            {/* Added files */}
            {driftDetail.files_added.map((file) => (
              <div key={file} className="px-4 py-2 flex items-center">
                <span className="w-6 text-green-600 font-bold">+</span>
                <span className="font-mono text-sm text-gray-700">{file}</span>
              </div>
            ))}

            {/* Modified files */}
            {driftDetail.files_modified.map((file) => (
              <div key={file} className="px-4 py-2 flex items-center">
                <span className="w-6 text-yellow-600 font-bold">~</span>
                <span className="font-mono text-sm text-gray-700">{file}</span>
              </div>
            ))}

            {/* Deleted files */}
            {driftDetail.files_deleted.map((file) => (
              <div key={file} className="px-4 py-2 flex items-center">
                <span className="w-6 text-red-600 font-bold">-</span>
                <span className="font-mono text-sm text-gray-700">{file}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="bg-gray-800 rounded-lg p-4 text-white">
        <h3 className="text-sm font-medium text-gray-300 mb-3">CLI Actions</h3>
        <div className="space-y-2 font-mono text-sm">
          <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code>fst drift --summary</code>
            <button
              onClick={() => copyToClipboard('fst drift --summary')}
              className="text-gray-400 hover:text-white"
            >
              Copy
            </button>
          </div>
          <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code>fst snapshot</code>
            <button
              onClick={() => copyToClipboard('fst snapshot')}
              className="text-gray-400 hover:text-white"
            >
              Copy
            </button>
          </div>
          <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code>fst merge {workspace.name}</code>
            <button
              onClick={() => copyToClipboard(`fst merge ${workspace.name}`)}
              className="text-gray-400 hover:text-white"
            >
              Copy
            </button>
          </div>
        </div>
      </div>

      {/* Workspace Info */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-medium text-gray-900 mb-3">Workspace Info</h3>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">ID</dt>
            <dd className="font-mono text-gray-900">{workspace.id}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Base Snapshot</dt>
            <dd className="font-mono text-gray-900">
              {workspace.base_snapshot_id || 'None'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Machine ID</dt>
            <dd className="font-mono text-gray-900">{workspace.machine_id || 'Unknown'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Last Seen</dt>
            <dd className="text-gray-900">
              {workspace.last_seen_at
                ? new Date(workspace.last_seen_at).toLocaleString()
                : 'Never'}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
