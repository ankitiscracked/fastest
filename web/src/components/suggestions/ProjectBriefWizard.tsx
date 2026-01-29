import { useState } from 'react';
import type { ProjectBrief, ProjectIntent, StartupBrief, PersonalToolBrief } from '@fastest/shared';
import { api } from '../../api/client';

interface ProjectBriefWizardProps {
  projectId: string;
  onComplete: (brief: ProjectBrief) => void;
  onClose: () => void;
}

type Step = 'intent' | 'details';

export function ProjectBriefWizard({ projectId, onComplete, onClose }: ProjectBriefWizardProps) {
  const [step, setStep] = useState<Step>('intent');
  const [intent, setIntent] = useState<ProjectIntent | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [startup, setStartup] = useState({
    problem: '',
    target_users: '',
    unique_angle: '',
    mvp_features: '',
    non_goals: '',
    reference_projects: '',
    tech_preferences: '',
    current_stage: 'idea' as StartupBrief['current_stage'],
    has_users: false,
    has_revenue: false,
  });

  const [personal, setPersonal] = useState({
    problem: '',
    current_workaround: '',
    must_have: '',
    nice_to_have: '',
    platforms: '',
    tech_preferences: '',
    polish_level: 'functional' as PersonalToolBrief['polish_level'],
  });

  const splitList = (value: string): string[] =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

  const handleSave = async () => {
    setError(null);
    if (!intent) {
      setError('Select an intent to continue.');
      return;
    }

    let brief: ProjectBrief | null = null;

    if (intent === 'startup') {
      if (!startup.problem.trim()) {
        setError('Problem statement is required.');
        return;
      }
      const targetUsers = splitList(startup.target_users);
      const mvpFeatures = splitList(startup.mvp_features);
      const nonGoals = splitList(startup.non_goals);
      if (targetUsers.length === 0 || mvpFeatures.length === 0) {
        setError('Target users and MVP features are required.');
        return;
      }
      brief = {
        intent: 'startup',
        problem: startup.problem.trim(),
        target_users: targetUsers,
        unique_angle: startup.unique_angle.trim() || undefined,
        mvp_features: mvpFeatures,
        non_goals: nonGoals,
        reference_projects: splitList(startup.reference_projects),
        tech_preferences: splitList(startup.tech_preferences),
        current_stage: startup.current_stage,
        has_users: startup.has_users,
        has_revenue: startup.has_revenue,
      } as StartupBrief;
    }

    if (intent === 'personal_tool') {
      if (!personal.problem.trim()) {
        setError('Problem statement is required.');
        return;
      }
      const mustHave = splitList(personal.must_have);
      if (mustHave.length === 0) {
        setError('Must-have features are required.');
        return;
      }
      brief = {
        intent: 'personal_tool',
        problem: personal.problem.trim(),
        current_workaround: personal.current_workaround.trim() || undefined,
        must_have: mustHave,
        nice_to_have: splitList(personal.nice_to_have),
        platforms: splitList(personal.platforms),
        tech_preferences: splitList(personal.tech_preferences),
        polish_level: personal.polish_level,
      } as PersonalToolBrief;
    }

    if (!brief) {
      setError('Unable to build brief.');
      return;
    }

    setSaving(true);
    try {
      await api.updateProjectBrief(projectId, { intent, brief });
      onComplete(brief);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save brief');
    } finally {
      setSaving(false);
    }
  };

  if (!projectId) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-md shadow-xl max-w-2xl w-full mx-4 p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-lg font-semibold text-surface-800">Project Brief</h3>
            <p className="text-sm text-surface-500">Set context to unlock tailored next steps.</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-surface-400 hover:text-surface-700 rounded-sm"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-status-error">{error}</p>
          </div>
        )}

        {step === 'intent' ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <button
                onClick={() => {
                  setIntent('startup');
                  setStep('details');
                }}
                className="p-4 border border-surface-200 rounded-md text-left hover:border-surface-300"
              >
                <h4 className="font-medium text-surface-800">Startup / Company</h4>
                <p className="text-sm text-surface-500 mt-1">
                  Building to launch, get users, and find product-market fit.
                </p>
              </button>
              <button
                onClick={() => {
                  setIntent('personal_tool');
                  setStep('details');
                }}
                className="p-4 border border-surface-200 rounded-md text-left hover:border-surface-300"
              >
                <h4 className="font-medium text-surface-800">Personal Tool</h4>
                <p className="text-sm text-surface-500 mt-1">
                  Building for yourself to save time or reduce friction.
                </p>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {intent === 'startup' && (
              <div className="space-y-3">
                <input
                  className="input w-full"
                  placeholder="Problem (what pain are you solving?)"
                  value={startup.problem}
                  onChange={(e) => setStartup((prev) => ({ ...prev, problem: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Target users (comma-separated)"
                  value={startup.target_users}
                  onChange={(e) => setStartup((prev) => ({ ...prev, target_users: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Unique angle (optional)"
                  value={startup.unique_angle}
                  onChange={(e) => setStartup((prev) => ({ ...prev, unique_angle: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="MVP features (comma-separated)"
                  value={startup.mvp_features}
                  onChange={(e) => setStartup((prev) => ({ ...prev, mvp_features: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Non-goals (comma-separated)"
                  value={startup.non_goals}
                  onChange={(e) => setStartup((prev) => ({ ...prev, non_goals: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Reference projects (comma-separated, optional)"
                  value={startup.reference_projects}
                  onChange={(e) => setStartup((prev) => ({ ...prev, reference_projects: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Tech preferences (comma-separated, optional)"
                  value={startup.tech_preferences}
                  onChange={(e) => setStartup((prev) => ({ ...prev, tech_preferences: e.target.value }))}
                />
                <div className="flex flex-wrap gap-3">
                  <label className="text-sm text-surface-600">
                    Stage
                    <select
                      className="input ml-2"
                      value={startup.current_stage}
                      onChange={(e) => setStartup((prev) => ({ ...prev, current_stage: e.target.value as StartupBrief['current_stage'] }))}
                    >
                      <option value="idea">Idea</option>
                      <option value="building_mvp">Building MVP</option>
                      <option value="pre_launch">Pre-launch</option>
                      <option value="launched">Launched</option>
                      <option value="growing">Growing</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-surface-600">
                    <input
                      type="checkbox"
                      checked={startup.has_users}
                      onChange={(e) => setStartup((prev) => ({ ...prev, has_users: e.target.checked }))}
                    />
                    Has users
                  </label>
                  <label className="flex items-center gap-2 text-sm text-surface-600">
                    <input
                      type="checkbox"
                      checked={startup.has_revenue}
                      onChange={(e) => setStartup((prev) => ({ ...prev, has_revenue: e.target.checked }))}
                    />
                    Has revenue
                  </label>
                </div>
              </div>
            )}

            {intent === 'personal_tool' && (
              <div className="space-y-3">
                <input
                  className="input w-full"
                  placeholder="Problem (what do you want to fix?)"
                  value={personal.problem}
                  onChange={(e) => setPersonal((prev) => ({ ...prev, problem: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Current workaround (optional)"
                  value={personal.current_workaround}
                  onChange={(e) => setPersonal((prev) => ({ ...prev, current_workaround: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Must-have features (comma-separated)"
                  value={personal.must_have}
                  onChange={(e) => setPersonal((prev) => ({ ...prev, must_have: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Nice-to-have features (comma-separated)"
                  value={personal.nice_to_have}
                  onChange={(e) => setPersonal((prev) => ({ ...prev, nice_to_have: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Platforms (comma-separated)"
                  value={personal.platforms}
                  onChange={(e) => setPersonal((prev) => ({ ...prev, platforms: e.target.value }))}
                />
                <input
                  className="input w-full"
                  placeholder="Tech preferences (comma-separated, optional)"
                  value={personal.tech_preferences}
                  onChange={(e) => setPersonal((prev) => ({ ...prev, tech_preferences: e.target.value }))}
                />
                <label className="text-sm text-surface-600">
                  Polish level
                  <select
                    className="input ml-2"
                    value={personal.polish_level}
                    onChange={(e) => setPersonal((prev) => ({ ...prev, polish_level: e.target.value as PersonalToolBrief['polish_level'] }))}
                  >
                    <option value="hacky">Hacky</option>
                    <option value="functional">Functional</option>
                    <option value="polished">Polished</option>
                  </select>
                </label>
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setStep('intent')}
                className="text-sm text-surface-600 hover:text-surface-800"
              >
                Back
              </button>
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm text-surface-600 hover:text-surface-800"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-surface-800 hover:bg-surface-900 rounded-sm disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save brief'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
