import { useState, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import type { UserApiKey, ApiKeyProvider } from '@fastest/shared';
import { API_KEY_PROVIDERS } from '@fastest/shared';
import { api } from '../api/client';

export function Settings() {
  const [apiKeys, setApiKeys] = useState<UserApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<ApiKeyProvider | null>(null);

  // Form state for adding/editing keys
  const [editingProvider, setEditingProvider] = useState<ApiKeyProvider | null>(null);
  const [newKeyValue, setNewKeyValue] = useState('');

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    try {
      setError(null);
      const data = await api.listApiKeys();
      setApiKeys(data.api_keys || []);
    } catch (err) {
      console.error('Failed to fetch API keys:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch API keys');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveKey = async (provider: ApiKeyProvider) => {
    if (!newKeyValue.trim()) return;

    setSaving(provider);
    try {
      await api.setApiKey(provider, newKeyValue.trim());
      setEditingProvider(null);
      setNewKeyValue('');
      await fetchApiKeys();
    } catch (err) {
      console.error('Failed to save API key:', err);
      setError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setSaving(null);
    }
  };

  const handleDeleteKey = async (provider: ApiKeyProvider) => {
    if (!confirm(`Delete ${API_KEY_PROVIDERS[provider].name} API key?`)) return;

    try {
      await api.deleteApiKey(provider);
      await fetchApiKeys();
    } catch (err) {
      console.error('Failed to delete API key:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete API key');
    }
  };

  const getKeyForProvider = (provider: ApiKeyProvider): UserApiKey | undefined => {
    return apiKeys.find(k => k.provider === provider);
  };

  const providers = Object.entries(API_KEY_PROVIDERS) as [ApiKeyProvider, typeof API_KEY_PROVIDERS[ApiKeyProvider]][];

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-gray-500">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage your API keys and preferences
          </p>
        </div>
        <Link
          to="/"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Back to Home
        </Link>
      </div>

      {/* Error display */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* API Keys Section */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-medium text-gray-900">Model Provider API Keys</h3>
          <p className="text-xs text-gray-500 mt-1">
            Your API keys are used to authenticate with AI model providers when running agents.
            Keys are stored securely and passed to OpenCode at runtime.
          </p>
        </div>

        <div className="divide-y divide-gray-200">
          {providers.map(([provider, config]) => {
            const existingKey = getKeyForProvider(provider);
            const isEditing = editingProvider === provider;
            const isSaving = saving === provider;

            return (
              <div key={provider} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">{config.name}</span>
                      {existingKey && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                          Configured
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500">{config.description}</p>
                    <p className="text-xs text-gray-400 font-mono mt-1">{config.keyName}</p>

                    {existingKey && !isEditing && (
                      <div className="mt-2 text-sm text-gray-500 font-mono">
                        {existingKey.key_value}
                      </div>
                    )}

                    {isEditing && (
                      <div className="mt-3 flex items-center gap-2">
                        <input
                          type="password"
                          value={newKeyValue}
                          onChange={(e) => setNewKeyValue(e.target.value)}
                          placeholder={`Enter your ${config.name} API key`}
                          className="flex-1 text-sm border border-gray-300 rounded-md px-3 py-2 font-mono focus:ring-primary-500 focus:border-primary-500"
                          autoFocus
                        />
                        <button
                          onClick={() => handleSaveKey(provider)}
                          disabled={isSaving || !newKeyValue.trim()}
                          className="px-3 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isSaving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onClick={() => {
                            setEditingProvider(null);
                            setNewKeyValue('');
                          }}
                          className="px-3 py-2 text-gray-600 hover:text-gray-900 text-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>

                  {!isEditing && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setEditingProvider(provider);
                          setNewKeyValue('');
                        }}
                        className="px-3 py-1.5 text-sm text-primary-600 hover:text-primary-700 hover:bg-primary-50 rounded-md transition-colors"
                      >
                        {existingKey ? 'Update' : 'Add Key'}
                      </button>
                      {existingKey && (
                        <button
                          onClick={() => handleDeleteKey(provider)}
                          className="p-1.5 text-gray-400 hover:text-red-600 rounded-md transition-colors"
                          title="Delete key"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Info box */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex gap-3">
          <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="text-sm text-blue-800">
            <p className="font-medium">How API keys are used</p>
            <p className="mt-1">
              Your API keys are passed to the coding agent (OpenCode) when starting a session.
              They are stored encrypted and never exposed in logs or the UI.
              If no user keys are configured, the system will fall back to default keys if available.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
