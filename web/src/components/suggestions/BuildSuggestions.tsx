import { useEffect, useState } from 'react';
import type { BuildSuggestion } from '@fastest/shared';
import { api } from '../../api/client';

interface BuildSuggestionsProps {
  projectId: string;
  onStartSuggestion: (suggestionId: string, prompt: string) => void;
}

function buildPrompt(suggestion: BuildSuggestion): string {
  const description = suggestion.description ? `\n\nDetails: ${suggestion.description}` : '';
  const rationale = suggestion.rationale ? `\n\nWhy now: ${suggestion.rationale}` : '';
  return `Work on this product suggestion: ${suggestion.title}.${description}${rationale}`.trim();
}

function priorityLabel(priority: number): string {
  if (priority === 1) return 'High';
  if (priority === 3) return 'Low';
  return 'Medium';
}

export function BuildSuggestions({ projectId, onStartSuggestion }: BuildSuggestionsProps) {
  const [suggestions, setSuggestions] = useState<BuildSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [feedbackId, setFeedbackId] = useState<string | null>(null);

  useEffect(() => {
    void loadSuggestions();
  }, [projectId]);

  const loadSuggestions = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listBuildSuggestions(projectId);
      setSuggestions(res.suggestions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load suggestions');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      await api.generateBuildSuggestions(projectId);
      await loadSuggestions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate suggestions');
    } finally {
      setIsGenerating(false);
    }
  };

  const updateStatus = async (suggestion: BuildSuggestion, status: BuildSuggestion['status']) => {
    setUpdatingId(suggestion.id);
    try {
      const res = await api.updateBuildSuggestion(projectId, suggestion.id, status);
      setSuggestions((prev) => prev.map((item) => (item.id === suggestion.id ? res.suggestion : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update suggestion');
    } finally {
      setUpdatingId(null);
    }
  };

  const submitFeedback = async (suggestion: BuildSuggestion, helpful: boolean) => {
    setFeedbackId(suggestion.id);
    try {
      const res = await api.submitBuildSuggestionFeedback(projectId, suggestion.id, helpful);
      setSuggestions((prev) => prev.map((item) => (item.id === suggestion.id ? res.suggestion : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record feedback');
    } finally {
      setFeedbackId(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-md border border-surface-200 p-4">
        <div className="text-sm text-surface-500">Loading suggestions...</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-md border border-surface-200">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200">
        <div>
          <h3 className="text-sm font-medium text-surface-800">Build Suggestions</h3>
          <p className="text-xs text-surface-500">Product-focused ideas tailored to this project</p>
        </div>
        <button
          onClick={handleGenerate}
          disabled={isGenerating}
          className="px-3 py-1.5 text-xs font-medium text-accent-700 bg-accent-50 hover:bg-accent-100 rounded-sm border border-accent-200 disabled:opacity-50"
        >
          {isGenerating ? 'Generating...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 border-b border-surface-200 bg-red-50">
          <p className="text-xs text-status-error">{error}</p>
        </div>
      )}

      {suggestions.length === 0 ? (
        <div className="p-4">
          <p className="text-sm text-surface-600">No suggestions yet.</p>
          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="mt-3 px-3 py-1.5 text-xs font-medium text-accent-700 bg-accent-50 hover:bg-accent-100 rounded-sm border border-accent-200 disabled:opacity-50"
          >
            {isGenerating ? 'Generating...' : 'Generate suggestions'}
          </button>
        </div>
      ) : (
        <div className="divide-y divide-surface-200">
          {suggestions.map((suggestion) => (
            <div key={suggestion.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-medium text-surface-800">{suggestion.title}</h4>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-100 text-surface-600">
                      {suggestion.category}
                    </span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-100 text-surface-600">
                      {priorityLabel(suggestion.priority)} priority
                    </span>
                    {suggestion.effort && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-100 text-surface-600">
                        {suggestion.effort} effort
                      </span>
                    )}
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-100 text-surface-600">
                      {suggestion.status}
                    </span>
                  </div>
                  {suggestion.description && (
                    <p className="text-sm text-surface-600 mt-2">{suggestion.description}</p>
                  )}
                  {suggestion.rationale && (
                    <p className="text-xs text-surface-500 mt-2">Why now: {suggestion.rationale}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const prompt = buildPrompt(suggestion);
                      onStartSuggestion(suggestion.id, prompt);
                      void updateStatus(suggestion, 'started');
                    }}
                    disabled={updatingId === suggestion.id}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-surface-800 hover:bg-surface-900 rounded-sm disabled:opacity-50"
                  >
                    Start
                  </button>
                  <button
                    onClick={() => void updateStatus(suggestion, 'dismissed')}
                    disabled={updatingId === suggestion.id}
                    className="px-3 py-1.5 text-xs font-medium text-surface-600 hover:text-surface-800 hover:bg-surface-100 rounded-sm disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => void submitFeedback(suggestion, true)}
                  disabled={feedbackId === suggestion.id}
                  className="px-2 py-1 text-xs text-surface-600 hover:text-surface-800 hover:bg-surface-100 rounded-sm disabled:opacity-50"
                >
                  Helpful · {suggestion.helpful_count}
                </button>
                <button
                  onClick={() => void submitFeedback(suggestion, false)}
                  disabled={feedbackId === suggestion.id}
                  className="px-2 py-1 text-xs text-surface-600 hover:text-surface-800 hover:bg-surface-100 rounded-sm disabled:opacity-50"
                >
                  Not helpful · {suggestion.not_helpful_count}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
