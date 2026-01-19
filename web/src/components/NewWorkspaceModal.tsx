import { useState, useEffect, useRef } from 'react';
import type { Workspace } from '@fastest/shared';
import { api } from '../api/client';

interface NewWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (workspace: Workspace) => void;
  snapshots?: Array<{ id: string; created_at: string }>;
}

export function NewWorkspaceModal({
  isOpen,
  onClose,
  projectId,
  onCreated,
  snapshots = [],
}: NewWorkspaceModalProps) {
  const [name, setName] = useState('');
  const [baseSnapshotId, setBaseSnapshotId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setName('');
      setBaseSnapshotId('');
      setError(null);
      // Focus the name input when modal opens
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isLoading) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, isLoading, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Workspace name is required');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await api.createWorkspace(
        projectId,
        trimmedName,
        baseSnapshotId || undefined
      );
      onCreated(response.workspace);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isLoading) {
      onClose();
    }
  };

  if (!isOpen) {
    return null;
  }

  const formatSnapshotDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">New Workspace</h2>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-4">
            {/* Workspace name */}
            <div>
              <label
                htmlFor="workspace-name"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Workspace name <span className="text-red-500">*</span>
              </label>
              <input
                ref={inputRef}
                id="workspace-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., feature-auth, bugfix-login"
                disabled={isLoading}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100 disabled:text-gray-500 text-sm"
              />
            </div>

            {/* Base snapshot */}
            <div>
              <label
                htmlFor="base-snapshot"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Base
              </label>
              <select
                id="base-snapshot"
                value={baseSnapshotId}
                onChange={(e) => setBaseSnapshotId(e.target.value)}
                disabled={isLoading}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100 disabled:text-gray-500 text-sm bg-white"
              >
                <option value="">main's latest</option>
                {snapshots.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {snapshot.id.slice(0, 8)} - {formatSnapshotDate(snapshot.created_at)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                Select which snapshot to branch from. Defaults to the latest snapshot on main.
              </p>
            </div>

            {/* Error display */}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 rounded-b-lg flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !name.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-lg shadow-sm hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {isLoading && (
                <svg
                  className="animate-spin h-4 w-4 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
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
              )}
              {isLoading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
