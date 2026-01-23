import { useState, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import type { Project } from '@fastest/shared';
import { api } from '../api/client';

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  useEffect(() => {
    fetchProjects();
  }, []);

  const fetchProjects = async () => {
    try {
      setError(null);
      const data = await api.listProjects();
      setProjects(data.projects || []);
    } catch (err) {
      console.error('Failed to fetch projects:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch projects');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const data = await api.createProject(newProjectName);
      setProjects([data.project, ...projects]);
      setNewProjectName('');
      setShowCreate(false);
    } catch (err) {
      console.error('Failed to create project:', err);
      setError(err instanceof Error ? err.message : 'Failed to create project');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-surface-500">Loading projects...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-surface-800">Projects</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary"
        >
          New Project
        </button>
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Create project modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-md p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold text-surface-800 mb-4">Create New Project</h2>
            <form onSubmit={handleCreateProject}>
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Project name"
                className="input mb-4"
                autoFocus
              />
              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="btn-ghost"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Projects list */}
      {projects.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-md border border-surface-200">
          <h3 className="text-lg font-medium text-surface-800 mb-2">No projects yet</h3>
          <p className="text-surface-500 mb-4">Create your first project to get started</p>
          <p className="text-sm text-surface-400">
            Or run <code className="bg-surface-100 px-1 py-0.5 rounded">fst init my-project</code> from the CLI
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-md border border-surface-200 overflow-hidden">
          <ul className="divide-y divide-surface-200">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="block px-6 py-4 hover:bg-surface-50"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-medium text-surface-800">{project.name}</h3>
                      <p className="text-xs text-surface-500 font-mono">{project.id}</p>
                    </div>
                    <div className="text-sm text-surface-500">
                      Updated {new Date(project.updated_at).toLocaleDateString()}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
