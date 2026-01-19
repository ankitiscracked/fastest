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
  job: MessageData;
  isStreaming?: boolean;
  streamingContent?: string;
}

export function ConversationMessage({ job, isStreaming, streamingContent }: ConversationMessageProps) {
  // Don't render if there's no prompt (user message)
  if (!job.prompt) return null;

  return (
    <div className="space-y-3">
      {/* User message */}
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-primary-600 text-white rounded-2xl rounded-tr-sm px-4 py-3">
          <p className="text-sm whitespace-pre-wrap">{job.prompt}</p>
        </div>
      </div>

      {/* Agent message */}
      <div className="flex justify-start">
        <div className="max-w-[85%] bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-500">Agent</span>
            <StatusBadge status={job.status} />
          </div>

          {/* Content based on status */}
          {job.status === 'pending' && (
            <p className="text-sm text-gray-500 italic">Waiting to run...</p>
          )}

          {job.status === 'running' && (
            <div className="space-y-2">
              {isStreaming && streamingContent ? (
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{streamingContent}</p>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                  <p className="text-sm text-gray-500">Working on it...</p>
                </div>
              )}
            </div>
          )}

          {job.status === 'completed' && (
            <div className="space-y-3">
              {job.output ? (
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{job.output}</p>
              ) : (
                <p className="text-sm text-gray-700">Task completed successfully.</p>
              )}
            </div>
          )}

          {job.status === 'failed' && (
            <div className="space-y-2">
              <p className="text-sm text-red-600">{job.error || 'An error occurred'}</p>
            </div>
          )}

          {job.status === 'cancelled' && (
            <p className="text-sm text-gray-500 italic">Cancelled</p>
          )}

          {/* Timestamp */}
          <div className="mt-2 text-xs text-gray-400">
            {formatTimestamp(job.created_at)}
            {job.completed_at && (
              <span className="ml-2">
                ({formatDuration(new Date(job.created_at), new Date(job.completed_at))})
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: MessageStatus }) {
  const styles: Record<MessageStatus, string> = {
    pending: 'bg-gray-100 text-gray-600',
    running: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-yellow-100 text-yellow-700',
  };

  const labels: Record<MessageStatus, string> = {
    pending: 'Pending',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status]}`}>
      {status === 'running' && (
        <span className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full mr-1 animate-pulse" />
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
