import { useState, useRef, useEffect } from 'react';

interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  disabled?: boolean;
  placeholder?: string;
  isRunning?: boolean;
  queuedCount?: number;
}

export function PromptInput({
  onSubmit,
  disabled = false,
  placeholder = 'What do you want to build?',
  isRunning = false,
  queuedCount = 0,
}: PromptInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [value]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed && !disabled) {
      onSubmit(trimmed);
      setValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const getPlaceholder = () => {
    if (isRunning && queuedCount > 0) {
      return `${queuedCount} job(s) queued. Add another...`;
    }
    if (isRunning) {
      return 'Agent is working... (your message will queue)';
    }
    return placeholder;
  };

  return (
    <div className="relative">
      <div className="flex items-end gap-2 bg-white border border-gray-300 rounded-xl shadow-sm focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500 transition-all">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={getPlaceholder()}
          disabled={disabled}
          rows={1}
          className="flex-1 px-4 py-3 bg-transparent border-0 resize-none focus:ring-0 focus:outline-none text-sm placeholder-gray-400 disabled:text-gray-400"
          style={{ maxHeight: '200px' }}
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="m-2 p-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Send (Enter)"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
        </button>
      </div>

      {/* Running indicator */}
      {isRunning && (
        <div className="absolute -top-6 left-0 flex items-center gap-2 text-xs text-gray-500">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          <span>Agent is working...</span>
        </div>
      )}
    </div>
  );
}
