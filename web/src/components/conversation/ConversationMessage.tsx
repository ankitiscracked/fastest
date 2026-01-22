import { MarkdownContent } from './MarkdownContent';
import { OpenCodeParts } from './OpenCodeParts';
import { OpenCodeQuestion } from './OpenCodeQuestion';

type MessageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// Message display data
interface MessageData {
  id: string;
  prompt: string;
  output?: string;
  status: MessageStatus;
  error?: string;
  created_at: string;
  completed_at?: string;
}

interface ConversationMessageProps {
  message: MessageData;
  isStreaming?: boolean;
  streamingContent?: string;
  parts?: import('../../api/opencode').OpenCodePart[];
  questions?: import('../../api/opencode').OpenCodeQuestionRequest[];
  onQuestionSubmit?: (requestId: string, answers: string[][]) => Promise<void> | void;
  onQuestionReject?: (requestId: string) => Promise<void> | void;
}

export function ConversationMessage({ message, isStreaming, streamingContent, parts, questions, onQuestionSubmit, onQuestionReject }: ConversationMessageProps) {
  const hasParts = !!parts && parts.length > 0;
  const hasQuestions = !!questions && questions.length > 0;
  return (
    <div className="space-y-3">
      {/* User message - only render if there's a prompt */}
      {message.prompt && (
        <div className="flex justify-end">
          <div className="max-w-[85%] bg-accent-500 text-white rounded-2xl rounded-tr-sm px-4 py-3">
            <p className="text-sm whitespace-pre-wrap">{message.prompt}</p>
          </div>
        </div>
      )}

      {/* Agent message - only show for assistant messages (no prompt but has output/streaming/running status) */}
      {(!message.prompt || message.output || isStreaming) && (
        <div className="flex justify-start">
          <div className="max-w-[85%] bg-white border border-surface-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-surface-500">Agent</span>
              <StatusBadge status={message.status} />
            </div>

            {/* Content based on status */}
            {message.status === 'pending' && (
              <p className="text-sm text-surface-500 italic">Waiting to run...</p>
            )}

            {message.status === 'running' && (
              <div className="space-y-2">
                {hasQuestions && onQuestionSubmit && onQuestionReject ? (
                  <div className="space-y-3">
                    {questions?.map((question) => (
                      <OpenCodeQuestion
                        key={question.id}
                        request={question}
                        onSubmit={(answers) => onQuestionSubmit(question.id, answers)}
                        onReject={() => onQuestionReject(question.id)}
                      />
                    ))}
                  </div>
                ) : hasParts ? (
                  <OpenCodeParts parts={parts} />
                ) : isStreaming && streamingContent ? (
                  <MarkdownContent content={streamingContent} mode="streaming" />
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-status-running rounded-full animate-pulse" />
                    <p className="text-sm text-surface-500">Working on it...</p>
                  </div>
                )}
              </div>
            )}

            {message.status === 'completed' && (
              <div className="space-y-3">
                {message.output ? (
                  <MarkdownContent content={message.output} mode="static" />
                ) : hasQuestions && onQuestionSubmit && onQuestionReject ? (
                  <div className="space-y-3">
                    {questions?.map((question) => (
                      <OpenCodeQuestion
                        key={question.id}
                        request={question}
                        onSubmit={(answers) => onQuestionSubmit(question.id, answers)}
                        onReject={() => onQuestionReject(question.id)}
                      />
                    ))}
                  </div>
                ) : hasParts ? (
                  <OpenCodeParts parts={parts} />
                ) : (
                  <p className="text-sm text-surface-700">Task completed successfully.</p>
                )}
              </div>
            )}

            {message.status === 'failed' && (
              <div className="space-y-2">
                <p className="text-sm text-status-error">{message.error || 'An error occurred'}</p>
              </div>
            )}

            {message.status === 'cancelled' && (
              <p className="text-sm text-surface-500 italic">Cancelled</p>
            )}

            {/* Timestamp */}
            <div className="mt-2 text-xs text-surface-400">
              {formatTimestamp(message.created_at)}
              {message.completed_at && (
                <span className="ml-2">
                  ({formatDuration(new Date(message.created_at), new Date(message.completed_at))})
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: MessageStatus }) {
  const styles: Record<MessageStatus, string> = {
    pending: 'badge-pending',
    running: 'badge-running',
    completed: 'badge-success',
    failed: 'badge-error',
    cancelled: 'badge-warning',
  };

  const labels: Record<MessageStatus, string> = {
    pending: 'Pending',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };

  return (
    <span className={styles[status]}>
      {status === 'running' && (
        <span className="inline-block w-1.5 h-1.5 bg-status-running rounded-full mr-1 animate-pulse" />
      )}
      {labels[status]}
    </span>
  );
}

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const seconds = Math.floor(ms / 1000);

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
