import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MarkerType, type Edge, type Node } from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';

export type DiagramNode = {
  id: string;
  label: string;
  type?: string;
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
  type?: string;
};

export type DiagramData = {
  title?: string;
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
};

const NODE_WIDTH = 180;
const NODE_HEIGHT = 48;

function inferLayer(nodeId: string) {
  if (nodeId.startsWith('system:')) return 'system';
  if (nodeId.startsWith('module:')) return 'module';
  if (nodeId.startsWith('code:')) return 'code';
  if (nodeId.startsWith('capability:')) return 'capability';
  if (nodeId.startsWith('narrative:')) return 'narrative';
  return 'concept';
}

function nodeStyleFor(layer: string, type?: string) {
  const base = {
    borderRadius: 10,
    fontSize: 12,
    padding: '6px 10px',
    color: '#0f172a',
    border: '1px solid #e2e8f0',
    background: '#ffffff',
  };

  const palette: Record<string, { background: string; border: string; color: string; badge: string }> = {
    narrative: { background: '#f8fafc', border: '#cbd5f5', color: '#1e3a8a', badge: '#e0e7ff' },
    capability: { background: '#ecfdf5', border: '#a7f3d0', color: '#065f46', badge: '#d1fae5' },
    system: { background: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8', badge: '#dbeafe' },
    module: { background: '#fefce8', border: '#fde68a', color: '#92400e', badge: '#fef9c3' },
    code: { background: '#f8fafc', border: '#e2e8f0', color: '#334155', badge: '#e2e8f0' },
    concept: { background: '#f8fafc', border: '#e2e8f0', color: '#334155', badge: '#e2e8f0' },
  };

  const paletteKey = palette[layer] ? layer : 'concept';
  const entry = palette[paletteKey];

  return {
    style: {
      ...base,
      background: entry.background,
      border: `1px solid ${entry.border}`,
      color: entry.color,
    },
    badgeColor: entry.badge,
    badgeLabel: type || layer,
  };
}

function edgeStyleFor(type?: string, label?: string) {
  const normalized = (type || label || '').toLowerCase();
  if (normalized.includes('contains')) return { stroke: '#94a3b8', marker: MarkerType.ArrowClosed };
  if (normalized.includes('depends')) return { stroke: '#2563eb', marker: MarkerType.ArrowClosed };
  if (normalized.includes('used')) return { stroke: '#14b8a6', marker: MarkerType.ArrowClosed };
  if (normalized.includes('relat')) return { stroke: '#a855f7', marker: MarkerType.ArrowClosed };
  return { stroke: '#94a3b8', marker: MarkerType.ArrowClosed };
}

function layoutElements(nodes: Node[], edges: Edge[], direction: 'LR' | 'TB') {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, nodesep: 40, ranksep: 60 });

  nodes.forEach((node) => {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  edges.forEach((edge) => {
    graph.setEdge(edge.source, edge.target);
  });

  dagre.layout(graph);

  return nodes.map((node) => {
    const position = graph.node(node.id);
    return {
      ...node,
      position: {
        x: position.x - NODE_WIDTH / 2,
        y: position.y - NODE_HEIGHT / 2,
      },
    };
  });
}

function directionForType(type?: string) {
  switch (type) {
    case 'sequence':
      return 'TB';
    case 'flow':
      return 'TB';
    case 'component':
      return 'LR';
    case 'dependency':
      return 'LR';
    default:
      return 'LR';
  }
}

export function DiagramView({
  data,
  type,
}: {
  data: DiagramData;
  type?: string;
}) {
  const { nodes, edges } = useMemo(() => {
    const rawNodes = data.nodes || [];
    const rawEdges = data.edges || [];
    const nodes: Node[] = rawNodes.map((node) => ({
      id: node.id,
      data: {
        label: (
          <div className="flex flex-col gap-1">
            <div className="font-medium text-[11px] leading-tight">{node.label}</div>
            <div
              className="text-[9px] uppercase tracking-wide rounded-full px-2 py-0.5 w-fit"
              style={{ background: nodeStyleFor(inferLayer(node.id), node.type).badgeColor }}
            >
              {nodeStyleFor(inferLayer(node.id), node.type).badgeLabel}
            </div>
          </div>
        ),
      },
      position: { x: 0, y: 0 },
      style: nodeStyleFor(inferLayer(node.id), node.type).style,
    }));

    const edges: Edge[] = rawEdges.map((edge, idx) => {
      const style = edgeStyleFor(edge.type, edge.label);
      return {
      id: `${edge.from}-${edge.to}-${idx}`,
      source: edge.from,
      target: edge.to,
      label: edge.label,
      animated: false,
      style: { stroke: style.stroke },
      labelStyle: { fill: '#64748b', fontSize: 10 },
      markerEnd: { type: style.marker, color: style.stroke },
    };
    });

    const direction = directionForType(type);
    const positionedNodes = layoutElements(nodes, edges, direction);

    return { nodes: positionedNodes, edges };
  }, [data, type]);

  if (nodes.length === 0) {
    return <div className="text-xs text-surface-400">No diagram nodes available.</div>;
  }

  return (
    <div className="h-52 rounded-md border border-surface-200">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        zoomOnScroll
        panOnScroll
      >
        <Background gap={16} size={1} color="#e2e8f0" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
