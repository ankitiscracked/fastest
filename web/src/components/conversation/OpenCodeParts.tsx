import { useState } from 'react';
import type {
  OpenCodePart,
  OpenCodeFilePart,
  OpenCodeToolPart,
  OpenCodePatchPart,
  OpenCodeReasoningPart,
  OpenCodeSnapshotPart,
} from '../../api/opencode';
import { MarkdownContent } from './MarkdownContent';

interface OpenCodePartsProps {
  parts: OpenCodePart[];
}

function extractToolOutput(tool: OpenCodeToolPart): { status?: string; output?: string } {
  const state = tool.state as {
    status?: string;
    output?: string;
    raw?: string;
    metadata?: { output?: string };
  } | undefined;

  const output = state?.output || state?.metadata?.output || state?.raw;
  return { status: state?.status, output };
}

// Infer file change type from path patterns
function inferChangeType(path: string): 'added' | 'modified' | 'deleted' {
  // This is a heuristic - in a real implementation, the backend would provide this
  if (path.includes('.new') || path.includes('_new')) return 'added';
  if (path.includes('.deleted') || path.includes('_deleted')) return 'deleted';
  return 'modified';
}

// Get file name from path
function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

// Get directory from path
function getDirPath(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

export function OpenCodeParts({ parts }: OpenCodePartsProps) {
  if (parts.length === 0) return null;

  return (
    <div className="space-y-2 text-sm text-surface-700">
      {parts.map((part) => {
        switch (part.type) {
          case 'text':
            return (
              <div key={part.id}>
                <MarkdownContent content={(part as { text?: string }).text || ''} mode="streaming" />
              </div>
            );

          case 'reasoning':
            return <ReasoningPart key={part.id} part={part as OpenCodeReasoningPart} />;

          case 'file':
            return <FilePart key={part.id} part={part as OpenCodeFilePart} />;

          case 'tool':
            return <ToolPart key={part.id} part={part as OpenCodeToolPart} />;

          case 'patch':
            return <PatchPart key={part.id} part={part as OpenCodePatchPart} />;

          case 'snapshot':
            return <SnapshotPart key={part.id} part={part as OpenCodeSnapshotPart} />;

          default:
            // Don't render unknown/internal part types (step-start, step-finish, etc.)
            return null;
        }
      })}
    </div>
  );
}

// Reasoning Part - Collapsible thinking/reasoning display
function ReasoningPart({ part }: { part: OpenCodeReasoningPart }) {
  const [isOpen, setIsOpen] = useState(true); // Default to open to show streaming content
  const text = part.text || '';

  // Show a preview of the reasoning when collapsed
  const previewLength = 100;
  const preview = text.length > previewLength
    ? text.substring(0, previewLength).trim() + '...'
    : text;

  return (
    <details
      className="reasoning-block"
      open={isOpen}
      onToggle={(e) => setIsOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        <ThinkingIcon className="w-3.5 h-3.5 text-accent-500" />
        <span>Agent reasoning</span>
        {!isOpen && text.length > 0 && (
          <span className="ml-2 text-surface-400 font-normal truncate">
            — {preview}
          </span>
        )}
      </summary>
      <div className="reasoning-content">
        <MarkdownContent content={text} mode="streaming" />
      </div>
    </details>
  );
}

// File Part - File reference display
function FilePart({ part }: { part: OpenCodeFilePart }) {
  return (
    <div className="rounded-md border border-surface-200 bg-surface-50 px-3 py-2">
      <div className="flex items-center gap-2">
        <FileIcon className="w-4 h-4 text-surface-400" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs text-surface-700 truncate">
            {part.filename || part.url}
          </div>
          {part.mime && (
            <div className="text-xs text-surface-400">{part.mime}</div>
          )}
        </div>
        {part.url && (
          <a
            href={part.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent-600 hover:text-accent-700 hover:underline"
          >
            Open
          </a>
        )}
      </div>
    </div>
  );
}

// Tool Part - Tool invocation with status
function ToolPart({ part }: { part: OpenCodeToolPart }) {
  const { status, output } = extractToolOutput(part);
  const normalizedStatus = status?.toLowerCase();
  const isCompleted = normalizedStatus === 'success' || normalizedStatus === 'completed';

  return (
    <div className="tool-part rounded-md border border-surface-200 bg-white px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ToolIcon className="w-4 h-4 text-surface-400" />
          <span className="font-mono text-xs text-surface-700">
            {part.tool || 'unknown'}
          </span>
        </div>
        {status && !isCompleted && <ToolStatus status={status} />}
      </div>
      {output && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-surface-500 hover:text-surface-700">
            View output
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface-50 p-2 text-[11px] leading-relaxed text-surface-600">
            {output}
          </pre>
        </details>
      )}
    </div>
  );
}

// Tool Status Badge
function ToolStatus({ status }: { status: string }) {
  const normalizedStatus = status.toLowerCase();
  const statusClass =
    normalizedStatus === 'success' || normalizedStatus === 'completed' ? 'success' :
    normalizedStatus === 'error' || normalizedStatus === 'failed' ? 'error' :
    normalizedStatus === 'running' || normalizedStatus === 'pending' ? 'running' :
    'pending';

  return (
    <span className={`tool-status ${statusClass}`}>
      {normalizedStatus === 'running' && (
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      )}
      {status}
    </span>
  );
}

// Patch Part - Enhanced file change visualization
function PatchPart({ part }: { part: OpenCodePatchPart }) {
  const [expanded, setExpanded] = useState(false);
  const files = part.files || [];
  const fileCount = files.length;

  // Categorize files by change type (heuristic)
  const categorized = files.map(path => ({
    path,
    fileName: getFileName(path),
    dirPath: getDirPath(path),
    changeType: inferChangeType(path),
  }));

  const added = categorized.filter(f => f.changeType === 'added').length;
  const modified = categorized.filter(f => f.changeType === 'modified').length;
  const deleted = categorized.filter(f => f.changeType === 'deleted').length;

  return (
    <div className="rounded-md border border-surface-200 bg-white px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PatchIcon className="w-4 h-4 text-surface-400" />
          <span className="text-xs font-medium text-surface-700">
            {fileCount > 0 ? `${fileCount} file${fileCount !== 1 ? 's' : ''} changed` : 'Patch created'}
          </span>
        </div>
        {fileCount > 0 && (
          <div className="flex items-center gap-2 text-xs">
            {added > 0 && <span className="text-status-success">+{added}</span>}
            {modified > 0 && <span className="text-status-warning">~{modified}</span>}
            {deleted > 0 && <span className="text-status-error">-{deleted}</span>}
          </div>
        )}
      </div>

      {fileCount > 0 && (
        <>
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-2 flex items-center gap-1 text-xs text-surface-500 hover:text-surface-700"
          >
            <ChevronIcon className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            {expanded ? 'Hide files' : 'Show files'}
          </button>

          {expanded && (
            <div className="patch-visualization">
              {categorized.map((file, idx) => (
                <div key={idx} className="patch-file-item">
                  <span className={`patch-file-badge ${file.changeType}`}>
                    {file.changeType === 'added' ? 'A' : file.changeType === 'modified' ? 'M' : 'D'}
                  </span>
                  <span className="text-surface-700 truncate" title={file.path}>
                    {file.fileName}
                  </span>
                  {file.dirPath && (
                    <span className="text-surface-400 truncate flex-shrink" title={file.dirPath}>
                      {file.dirPath}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {part.hash && (
        <div className="mt-2 text-[10px] text-surface-400 font-mono">
          {part.hash.substring(0, 8)}
        </div>
      )}
    </div>
  );
}

// Snapshot Part
function SnapshotPart({ part }: { part: OpenCodeSnapshotPart }) {
  return (
    <div className="rounded-md border border-accent-200 bg-accent-50 px-3 py-2">
      <div className="flex items-center gap-2">
        <SnapshotIcon className="w-4 h-4 text-accent-500" />
        <div>
          <div className="text-xs font-medium text-accent-700">Snapshot created</div>
          {part.snapshot && (
            <div className="text-[10px] text-accent-600 font-mono">
              {part.snapshot.substring(0, 12)}...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Icons
function ThinkingIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
      />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
  );
}

function ToolIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}

function PatchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
      />
    </svg>
  );
}

function SnapshotIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}
