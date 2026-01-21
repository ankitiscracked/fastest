import type { OpenCodePart, OpenCodeFilePart, OpenCodeToolPart, OpenCodePatchPart } from '../../api/opencode';
import { MarkdownContent } from './MarkdownContent';

interface OpenCodePartsProps {
  parts: OpenCodePart[];
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
            return (
              <div key={part.id} className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="text-xs font-medium text-gray-500">Tool</div>
                <div className="font-mono text-xs text-gray-700">{tool.tool || 'unknown'}</div>
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
