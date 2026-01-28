import { useEffect, useState } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { ArrowLeft, Save, Settings2, Database } from 'lucide-react';
import type { DeploymentSettings, ProjectEnvVar } from '@fastest/shared';
import { api } from '../api/client';

type RuntimeOption = 'auto' | 'node' | 'python' | 'go' | 'static';

export function DeploymentSettingsPage() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [workspaceName, setWorkspaceName] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);

  const [runtimeOverride, setRuntimeOverride] = useState<RuntimeOption>('auto');
  const [autoDeploy, setAutoDeploy] = useState(false);
  const [buildCommand, setBuildCommand] = useState('');
  const [startCommand, setStartCommand] = useState('');

  const [envVars, setEnvVars] = useState<ProjectEnvVar[]>([]);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [newEnvSecret, setNewEnvSecret] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const ws = await api.getWorkspace(workspaceId);
        if (!mounted) return;
        setWorkspaceName(ws.workspace.name);
        setProjectId(ws.workspace.project_id);

        const [settingsRes, envRes] = await Promise.all([
          api.getDeploymentSettings(workspaceId),
          api.getEnvVars(ws.workspace.project_id),
        ]);

        if (!mounted) return;
        setSettings(settingsRes.settings);
        setAutoDeploy(settingsRes.settings.auto_deploy);
        setRuntimeOverride(settingsRes.settings.runtime_override ?? 'auto');
        setBuildCommand(settingsRes.settings.build_command || '');
        setStartCommand(settingsRes.settings.start_command || '');
        setEnvVars(envRes.variables);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'Failed to load settings');
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, [workspaceId]);

  const handleSave = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      const update = await api.updateDeploymentSettings(workspaceId, {
        auto_deploy: autoDeploy,
        runtime_override: runtimeOverride === 'auto' ? null : runtimeOverride,
        build_command: buildCommand.trim() || null,
        start_command: startCommand.trim() || null,
      });
      setSettings(update.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleAddEnvVar = async () => {
    if (!projectId || !newEnvKey.trim()) return;
    try {
      await api.setEnvVar(projectId, newEnvKey.trim(), newEnvValue, newEnvSecret);
      const envRes = await api.getEnvVars(projectId);
      setEnvVars(envRes.variables);
      setNewEnvKey('');
      setNewEnvValue('');
      setNewEnvSecret(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add env var');
    }
  };

  const handleDeleteEnvVar = async (key: string) => {
    if (!projectId) return;
    try {
      await api.deleteEnvVar(projectId, key);
      const envRes = await api.getEnvVars(projectId);
      setEnvVars(envRes.variables);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete env var');
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-gray-500">Loading deployment settings…</p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="p-6">
        <p className="text-sm text-red-600">{error || 'Unable to load deployment settings.'}</p>
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
            <h1 className="text-xl font-semibold text-gray-900">Deployment Settings</h1>
            <p className="text-sm text-gray-500">{workspaceName}</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-gray-600" />
              <h2 className="text-sm font-semibold text-gray-900">Automation</h2>
            </div>
            <div className="mt-4 flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Auto‑deploy on snapshot create</p>
                <p className="text-xs text-gray-500">Deploys the latest snapshot automatically.</p>
              </div>
              <button
                onClick={() => setAutoDeploy(!autoDeploy)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                  autoDeploy ? 'bg-black' : 'bg-gray-300'
                }`}
                aria-pressed={autoDeploy}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                    autoDeploy ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">Build & Run</h2>
            <div className="mt-4 grid gap-4">
              <label className="text-sm text-gray-700">
                Runtime
                <select
                  className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                  value={runtimeOverride}
                  onChange={(e) => setRuntimeOverride(e.target.value as RuntimeOption)}
                >
                  <option value="auto">Auto‑detect</option>
                  <option value="node">Node.js</option>
                  <option value="python">Python</option>
                  <option value="go">Go</option>
                  <option value="static">Static</option>
                </select>
              </label>
              <label className="text-sm text-gray-700">
                Build command
                <input
                  value={buildCommand}
                  onChange={(e) => setBuildCommand(e.target.value)}
                  placeholder="(auto)"
                  className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-sm text-gray-700">
                Start command
                <input
                  value={startCommand}
                  onChange={(e) => setStartCommand(e.target.value)}
                  placeholder="(auto)"
                  className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                />
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-gray-600" />
              <h2 className="text-sm font-semibold text-gray-900">Environment Variables</h2>
            </div>
            <div className="mt-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <input
                  value={newEnvKey}
                  onChange={(e) => setNewEnvKey(e.target.value)}
                  placeholder="KEY"
                  className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                />
                <input
                  value={newEnvValue}
                  onChange={(e) => setNewEnvValue(e.target.value)}
                  placeholder="VALUE"
                  className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                />
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={newEnvSecret}
                      onChange={() => setNewEnvSecret(!newEnvSecret)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    Secret
                  </label>
                  <button
                    onClick={handleAddEnvVar}
                    className="rounded-md bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-black"
                  >
                    Add
                  </button>
                </div>
              </div>

              {envVars.length === 0 ? (
                <p className="text-xs text-gray-500">No environment variables set.</p>
              ) : (
                <div className="space-y-2">
                  {envVars.map((env) => (
                    <div key={env.id} className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2 text-xs">
                      <div>
                        <span className="font-medium text-gray-900">{env.key}</span>
                        <span className="ml-3 text-gray-500">
                          {env.is_secret ? '••••••••' : env.value}
                        </span>
                      </div>
                      <button
                        onClick={() => handleDeleteEnvVar(env.key)}
                        className="text-xs text-red-600 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900">Managed Provider</h3>
            <p className="mt-2 text-xs text-gray-500">
              Deployments use the managed default provider unless you set custom credentials.
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900">Deployment Plan</h3>
            <p className="mt-2 text-xs text-gray-500">
              The system detects runtime and resources on each deploy. Overrides above apply to new deploys.
            </p>
            <Link
              to="/workspaces/$workspaceId/deployments"
              params={{ workspaceId }}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              View deployment history
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
