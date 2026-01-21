import type { OpenCodePart, OpenCodeFilePart, OpenCodeToolPart, OpenCodePatchPart } from '../../api/opencode';
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

export function OpenCodeParts({ parts }: OpenCodePartsProps) {
  if (parts.length === 0) return null;

  return (
    <div className="space-y-3 text-sm text-gray-700">
      {parts.map((part) => {
        switch (part.type) {
          case 'text':
            return (
              <div key={part.id}>
                <MarkdownContent content={(part as { text?: string }).text || ''} mode="streaming" />
              </div>
            );
          case 'file': {
            const file = part as OpenCodeFilePart;
            return (
              <div key={part.id} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <div className="text-xs font-medium text-gray-500">File</div>
                <div className="font-mono text-xs text-gray-700">{file.filename || file.url}</div>
                {file.mime && <div className="text-xs text-gray-500">{file.mime}</div>}
              </div>
            );
          }
          case 'tool': {
            const tool = part as OpenCodeToolPart;
            const { status, output } = extractToolOutput(tool);
            return (
              <div key={part.id} className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="flex items-center justify-between text-xs font-medium text-gray-500">
                  <span>Tool</span>
                  {status && <span className="uppercase tracking-wide text-gray-400">{status}</span>}
                </div>
                <div className="font-mono text-xs text-gray-700">{tool.tool || 'unknown'}</div>
                {output ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-gray-500">Output</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-600">
                      {output}
                    </pre>
                  </details>
                ) : null}
              </div>
            );
          }
          case 'patch': {
            const patch = part as OpenCodePatchPart;
            return (
              <div key={part.id} className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="text-xs font-medium text-gray-500">Patch</div>
                <div className="text-xs text-gray-700">
                  {patch.files?.length ? `${patch.files.length} files` : 'Patch created'}
                </div>
              </div>
            );
          }
          default:
            return (
              <div key={part.id || `${part.type}-part`} className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="text-xs font-medium text-gray-500">Part</div>
                <div className="text-xs text-gray-700">{part.type}</div>
              </div>
            );
        }
      })}
    </div>
  );
}
