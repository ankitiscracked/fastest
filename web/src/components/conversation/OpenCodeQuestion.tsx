import { useMemo, useState } from 'react';
import type { OpenCodeQuestionRequest, OpenCodeQuestionInfo } from '../../api/opencode';

interface OpenCodeQuestionProps {
  request: OpenCodeQuestionRequest;
  onSubmit: (answers: string[][]) => Promise<void> | void;
  onReject: () => Promise<void> | void;
}

export function OpenCodeQuestion({ request, onSubmit, onReject }: OpenCodeQuestionProps) {
  const questions = request.questions || [];
  const [selected, setSelected] = useState<Record<number, Set<string>>>(() => ({}));
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = useMemo(() => {
    if (questions.length === 0) return false;
    return questions.every((_, idx) => (selected[idx]?.size || 0) > 0);
  }, [questions, selected]);

  const toggleOption = (index: number, option: string, multiple?: boolean) => {
    setSelected(prev => {
      const next = new Map(Object.entries(prev).map(([k, v]) => [Number(k), new Set(v as unknown as string[])]));
      const current = next.get(index) || new Set<string>();
      if (multiple) {
        if (current.has(option)) {
          current.delete(option);
        } else {
          current.add(option);
        }
      } else {
        current.clear();
        current.add(option);
      }
      next.set(index, current);
      return Object.fromEntries([...next.entries()].map(([k, v]) => [k, v]));
    });
  };

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const answers = questions.map((_, idx) => Array.from(selected[idx] || []));
      await onSubmit(answers);
    } finally {
      setSubmitting(false);
    }
  };

  const renderQuestion = (question: OpenCodeQuestionInfo, index: number) => {
    return (
      <div key={`${request.id}-${index}`} className="space-y-2">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{question.header}</div>
        <p className="text-sm text-gray-800">{question.question}</p>
        <div className="space-y-2">
          {question.options.map((option) => {
            const selectedForQuestion = selected[index]?.has(option.label) || false;
            return (
              <button
                key={option.label}
                type="button"
                onClick={() => toggleOption(index, option.label, question.multiple)}
                className={`w-full text-left rounded-lg border px-3 py-2 transition ${
                  selectedForQuestion
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <div className="text-sm font-medium">{option.label}</div>
                <div className="text-xs text-gray-500">{option.description}</div>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Assistant Question</div>
      {questions.map(renderQuestion)}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || submitting}
          className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {submitting ? 'Submitting...' : 'Submit'}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={submitting}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
