import type { GetDocContentResponse } from '@fastest/shared';
import { MarkdownContent } from '../conversation/MarkdownContent';

interface SelectedDoc {
  workspaceId: string;
  workspaceName: string;
  path: string;
}

interface DocViewerProps {
  content: GetDocContentResponse | null;
  loading: boolean;
  selectedDoc: SelectedDoc | null;
}

export function DocViewer({ content, loading, selectedDoc }: DocViewerProps) {
  if (!selectedDoc) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-50">
        <div className="text-center text-surface-500">
          <svg className="w-12 h-12 mx-auto mb-4 text-surface-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p>Select a document to view</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex flex-col bg-white">
        <DocHeader selectedDoc={selectedDoc} size={0} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2 text-surface-500">
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span>Loading...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="h-full flex flex-col bg-white">
        <DocHeader selectedDoc={selectedDoc} size={0} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-surface-500">
            <p>Failed to load document content</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <DocHeader selectedDoc={selectedDoc} size={content.size} />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-6">
          <MarkdownContent content={content.content} mode="static" />
        </div>
      </div>
    </div>
  );
}

interface DocHeaderProps {
  selectedDoc: SelectedDoc;
  size: number;
}

function DocHeader({ selectedDoc, size }: DocHeaderProps) {
  const filename = selectedDoc.path.split('/').pop() || selectedDoc.path;
  const isMain = selectedDoc.workspaceName === 'main';

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200 bg-surface-50">
      <div className="flex items-center gap-3">
        <FileIcon filename={filename} />
        <div>
          <div className="font-medium text-surface-800">{filename}</div>
          {selectedDoc.path !== filename && (
            <div className="text-xs text-surface-500">{selectedDoc.path}</div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4">
        {size > 0 && (
          <span className="text-xs text-surface-400">{formatSize(size)}</span>
        )}
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
          isMain
            ? 'bg-accent-100 text-accent-700'
            : 'bg-surface-100 text-surface-600'
        }`}>
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          {selectedDoc.workspaceName}
        </div>
      </div>
    </div>
  );
}

function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase();

  if (ext === 'md' || ext === 'mdx') {
    return (
      <svg className="w-6 h-6 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
      </svg>
    );
  }

  return (
    <svg className="w-6 h-6 text-surface-400" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
    </svg>
  );
}
