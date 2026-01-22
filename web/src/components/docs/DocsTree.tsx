import { useState, useMemo } from 'react';
import type { WorkspaceDocs, DocFile } from '@fastest/shared';

interface SelectedDoc {
  workspaceId: string;
  workspaceName: string;
  path: string;
}

interface DocsTreeProps {
  workspaces: WorkspaceDocs[];
  selectedDoc: SelectedDoc | null;
  visibleWorkspaces: Set<string>;
  onSelectDoc: (workspaceId: string, workspaceName: string, path: string) => void;
  onToggleWorkspace: (workspaceId: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: TreeNode[];
  file?: DocFile;
}

function buildTree(files: DocFile[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let existing = currentLevel.find(n => n.name === part);

      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          isFolder: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        currentLevel.push(existing);
      }

      if (!isLast) {
        currentLevel = existing.children;
      }
    }
  }

  // Sort: folders first, then alphabetically
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => sortNodes(n.children));
  };

  sortNodes(root);
  return root;
}

export function DocsTree({
  workspaces,
  selectedDoc,
  visibleWorkspaces,
  onSelectDoc,
  onToggleWorkspace,
}: DocsTreeProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(
    () => new Set(workspaces.map(w => w.workspace_id))
  );

  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleWorkspaceExpand = (workspaceId: string) => {
    setExpandedWorkspaces(prev => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  };

  // Build trees for each workspace
  const workspaceTrees = useMemo(() => {
    return workspaces.map(ws => ({
      ...ws,
      tree: buildTree(ws.files),
    }));
  }, [workspaces]);

  return (
    <div className="flex flex-col h-full">
      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-2">
        {workspaceTrees.map(ws => (
          <WorkspaceNode
            key={ws.workspace_id}
            workspace={ws}
            tree={ws.tree}
            isExpanded={expandedWorkspaces.has(ws.workspace_id)}
            expandedFolders={expandedFolders}
            selectedDoc={selectedDoc}
            onToggleExpand={() => toggleWorkspaceExpand(ws.workspace_id)}
            onToggleFolder={toggleFolder}
            onSelectDoc={onSelectDoc}
          />
        ))}
      </div>

      {/* Workspace filter */}
      <div className="border-t border-surface-200 p-3">
        <div className="text-xs font-medium text-surface-500 uppercase mb-2">
          Filter workspaces
        </div>
        <div className="space-y-1 max-h-32 overflow-y-auto">
          {workspaces.map(ws => (
            <label
              key={ws.workspace_id}
              className="flex items-center gap-2 text-sm text-surface-700 cursor-pointer hover:text-surface-900"
            >
              <input
                type="checkbox"
                checked={visibleWorkspaces.has(ws.workspace_id)}
                onChange={() => onToggleWorkspace(ws.workspace_id)}
                className="rounded border-surface-300 text-accent-500 focus:ring-accent-500"
              />
              <span className="truncate">{ws.workspace_name}</span>
              <span className="text-surface-400 text-xs">({ws.files.length})</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

interface WorkspaceNodeProps {
  workspace: WorkspaceDocs;
  tree: TreeNode[];
  isExpanded: boolean;
  expandedFolders: Set<string>;
  selectedDoc: SelectedDoc | null;
  onToggleExpand: () => void;
  onToggleFolder: (path: string) => void;
  onSelectDoc: (workspaceId: string, workspaceName: string, path: string) => void;
}

function WorkspaceNode({
  workspace,
  tree,
  isExpanded,
  expandedFolders,
  selectedDoc,
  onToggleExpand,
  onToggleFolder,
  onSelectDoc,
}: WorkspaceNodeProps) {
  const isMain = workspace.workspace_name === 'main';

  return (
    <div className="mb-1">
      {/* Workspace header */}
      <button
        onClick={onToggleExpand}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
          isMain
            ? 'bg-accent-50 hover:bg-accent-100'
            : 'hover:bg-surface-100'
        }`}
      >
        <svg
          className={`w-4 h-4 text-surface-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
        <span className={`flex-1 text-sm font-medium truncate ${isMain ? 'text-accent-700' : 'text-surface-700'}`}>
          {workspace.workspace_name}
        </span>
        {isMain && (
          <span className="text-xs bg-accent-100 text-accent-600 px-1.5 py-0.5 rounded">
            main
          </span>
        )}
      </button>

      {/* Tree content */}
      {isExpanded && (
        <div className="ml-4 mt-1">
          {tree.map(node => (
            <TreeNodeComponent
              key={node.path}
              node={node}
              workspaceId={workspace.workspace_id}
              workspaceName={workspace.workspace_name}
              depth={0}
              expandedFolders={expandedFolders}
              selectedDoc={selectedDoc}
              onToggleFolder={onToggleFolder}
              onSelectDoc={onSelectDoc}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface TreeNodeComponentProps {
  node: TreeNode;
  workspaceId: string;
  workspaceName: string;
  depth: number;
  expandedFolders: Set<string>;
  selectedDoc: SelectedDoc | null;
  onToggleFolder: (path: string) => void;
  onSelectDoc: (workspaceId: string, workspaceName: string, path: string) => void;
}

function TreeNodeComponent({
  node,
  workspaceId,
  workspaceName,
  depth,
  expandedFolders,
  selectedDoc,
  onToggleFolder,
  onSelectDoc,
}: TreeNodeComponentProps) {
  const fullPath = `${workspaceId}:${node.path}`;
  const isExpanded = expandedFolders.has(fullPath);
  const isSelected =
    selectedDoc?.workspaceId === workspaceId && selectedDoc?.path === node.path;

  if (node.isFolder) {
    return (
      <div>
        <button
          onClick={() => onToggleFolder(fullPath)}
          className="w-full flex items-center gap-2 px-2 py-1 rounded text-left hover:bg-surface-100"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <svg
            className={`w-3 h-3 text-surface-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          <span className="text-sm text-surface-700">{node.name}</span>
        </button>
        {isExpanded && (
          <div>
            {node.children.map(child => (
              <TreeNodeComponent
                key={child.path}
                node={child}
                workspaceId={workspaceId}
                workspaceName={workspaceName}
                depth={depth + 1}
                expandedFolders={expandedFolders}
                selectedDoc={selectedDoc}
                onToggleFolder={onToggleFolder}
                onSelectDoc={onSelectDoc}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File node
  return (
    <button
      onClick={() => onSelectDoc(workspaceId, workspaceName, node.path)}
      className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left transition-colors ${
        isSelected
          ? 'bg-accent-100 text-accent-700'
          : 'hover:bg-surface-100 text-surface-700'
      }`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <FileIcon filename={node.name} />
      <span className="text-sm truncate">{node.name}</span>
    </button>
  );
}

function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase();

  if (ext === 'md' || ext === 'mdx') {
    return (
      <svg className="w-4 h-4 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
      </svg>
    );
  }

  return (
    <svg className="w-4 h-4 text-surface-400" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
    </svg>
  );
}
