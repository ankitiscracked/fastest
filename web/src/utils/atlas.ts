import type { Manifest, Snapshot, ProjectDecision } from '@fastest/shared';

export type LayerKey = 'narrative' | 'capability' | 'system' | 'module' | 'code';

export type Concept = {
  id: string;
  name: string;
  layer: LayerKey;
  description: string;
  childCount?: number;
  decisionCount?: number;
  lastActivity?: string;
  contains?: string[];
  filePath?: string;
};

export type AtlasData = {
  projectName?: string;
  snapshot?: Snapshot;
  manifest?: Manifest;
  conceptsByLayer: Record<LayerKey, Concept[]>;
  conceptIndex: Record<string, Concept>;
  moduleToFiles: Record<string, string[]>;
  systemToModules: Record<string, string[]>;
  fileIndex: Record<string, { hash: string; size: number }>;
};

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.fst',
  '.fast',
  '.next',
  'coverage',
]);

export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg',
  'pdf', 'zip', 'gz', 'tar', '7z', 'woff', 'woff2',
  'mp4', 'mov', 'mp3', 'wav', 'ogg', 'bin', 'dylib',
]);

function isIgnoredPath(path: string) {
  const parts = path.split('/');
  if (parts.length === 0) return true;
  const first = parts[0];
  if (!first) return true;
  if (first.startsWith('.')) return true;
  if (IGNORED_DIRS.has(first)) return true;
  return false;
}

export function getExtension(path: string) {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return '';
  return path.slice(idx + 1).toLowerCase();
}

export function deriveAtlasData(manifest: Manifest, snapshot?: Snapshot): AtlasData {
  const systems = new Map<string, { id: string; name: string; files: Set<string>; modules: Set<string> }>();
  const modules = new Map<string, { id: string; name: string; systemId: string; files: Set<string> }>();
  const fileIndex: Record<string, { hash: string; size: number }> = {};

  for (const file of manifest.files) {
    if (isIgnoredPath(file.path)) continue;
    const parts = file.path.split('/');
    const systemKey = parts.length > 1 ? parts[0] : 'root';
    const systemId = `system:${systemKey}`;
    const systemName = systemKey === 'root' ? 'Root' : systemKey;

    if (!systems.has(systemId)) {
      systems.set(systemId, { id: systemId, name: systemName, files: new Set(), modules: new Set() });
    }

    const moduleKey = parts.length > 2
      ? `${parts[0]}/${parts[1]}`
      : (parts.length > 1 ? parts[0] : 'root');
    const moduleId = `module:${moduleKey}`;
    const moduleName = moduleKey === 'root' ? 'Root' : moduleKey;

    if (!modules.has(moduleId)) {
      modules.set(moduleId, { id: moduleId, name: moduleName, systemId, files: new Set() });
    }

    systems.get(systemId)!.files.add(file.path);
    systems.get(systemId)!.modules.add(moduleId);
    modules.get(moduleId)!.files.add(file.path);
    fileIndex[file.path] = { hash: file.hash, size: file.size };
  }

  const conceptsByLayer: Record<LayerKey, Concept[]> = {
    narrative: [],
    capability: [],
    system: [],
    module: [],
    code: [],
  };

  const conceptIndex: Record<string, Concept> = {};
  const moduleToFiles: Record<string, string[]> = {};
  const systemToModules: Record<string, string[]> = {};

  const lastActivity = snapshot?.created_at
    ? new Date(snapshot.created_at).toLocaleDateString()
    : undefined;

  for (const system of systems.values()) {
    const concept: Concept = {
      id: system.id,
      name: system.name,
      layer: 'system',
      description: `Top-level area with ${system.files.size} files`,
      childCount: system.modules.size,
      decisionCount: 0,
      lastActivity,
      contains: Array.from(system.modules),
    };
    conceptsByLayer.system.push(concept);
    conceptIndex[concept.id] = concept;
    systemToModules[concept.id] = Array.from(system.modules);
  }

  for (const module of modules.values()) {
    const concept: Concept = {
      id: module.id,
      name: module.name,
      layer: 'module',
      description: `Contains ${module.files.size} files`,
      childCount: module.files.size,
      decisionCount: 0,
      lastActivity,
      contains: Array.from(module.files).map(path => `code:${path}`),
    };
    conceptsByLayer.module.push(concept);
    conceptIndex[concept.id] = concept;
    moduleToFiles[concept.id] = Array.from(module.files);
  }

  for (const [path] of Object.entries(fileIndex)) {
    const concept: Concept = {
      id: `code:${path}`,
      name: path.split('/').pop() || path,
      layer: 'code',
      description: path,
      childCount: undefined,
      decisionCount: 0,
      lastActivity,
      filePath: path,
    };
    conceptsByLayer.code.push(concept);
    conceptIndex[concept.id] = concept;
  }

  const sortByName = (a: Concept, b: Concept) => a.name.localeCompare(b.name);
  conceptsByLayer.system.sort(sortByName);
  conceptsByLayer.module.sort(sortByName);
  conceptsByLayer.code.sort(sortByName);

  return {
    snapshot,
    manifest,
    conceptsByLayer,
    conceptIndex,
    moduleToFiles,
    systemToModules,
    fileIndex,
  };
}

export function searchConcepts(query: string, concepts: Record<string, Concept>) {
  const q = query.trim().toLowerCase();
  if (!q) return [] as Concept[];
  return Object.values(concepts)
    .filter(c => `${c.name} ${c.description}`.toLowerCase().includes(q))
    .slice(0, 12);
}

function conceptNameVariants(concept: Concept) {
  const variants = new Set<string>();
  const name = concept.name.trim();
  if (!name) return [] as string[];
  variants.add(name);
  if (name.includes('/')) {
    variants.add(name.split('/').pop() || name);
  }
  return Array.from(variants).filter(v => v.length >= 3 && v.toLowerCase() !== 'root');
}

export function mapDecisionsToConcepts(
  concepts: Record<string, Concept>,
  decisions: ProjectDecision[]
) {
  const mapping: Record<string, ProjectDecision[]> = {};
  for (const concept of Object.values(concepts)) {
    const variants = conceptNameVariants(concept);
    if (variants.length === 0) continue;
    const matches: ProjectDecision[] = [];
    for (const decision of decisions) {
      const haystack = `${decision.decision} ${decision.rationale || ''}`.toLowerCase();
      const matched = variants.some((variant) => haystack.includes(variant.toLowerCase()));
      if (matched) {
        matches.push(decision);
      }
    }
    if (matches.length) {
      mapping[concept.id] = matches;
    }
  }
  return mapping;
}

export function buildAtlasFromIndex(args: {
  concepts: Array<{
    id: string;
    name: string;
    layer: LayerKey;
    description: string | null;
  }>;
  edges: Array<{ from_concept_id: string; to_concept_id: string; type: string }>;
  fileIndex: Record<string, { hash: string; size: number }>;
  snapshotId?: string;
  projectName?: string;
  snapshotDate?: string;
}): AtlasData {
  const conceptsByLayer: Record<LayerKey, Concept[]> = {
    narrative: [],
    capability: [],
    system: [],
    module: [],
    code: [],
  };

  const conceptIndex: Record<string, Concept> = {};
  const moduleToFiles: Record<string, string[]> = {};
  const systemToModules: Record<string, string[]> = {};
  const childCounts: Record<string, number> = {};

  for (const edge of args.edges) {
    if (edge.type !== 'contains') continue;
    childCounts[edge.from_concept_id] = (childCounts[edge.from_concept_id] || 0) + 1;
  }

  for (const concept of args.concepts) {
    const description = concept.description || '';
    const entry: Concept = {
      id: concept.id,
      name: concept.name,
      layer: concept.layer,
      description,
      childCount: childCounts[concept.id],
      decisionCount: 0,
      lastActivity: args.snapshotDate,
    };
    if (concept.id.startsWith('code:')) {
      entry.filePath = concept.id.slice('code:'.length);
    }
    conceptsByLayer[concept.layer].push(entry);
    conceptIndex[concept.id] = entry;
  }

  for (const edge of args.edges) {
    if (edge.type !== 'contains') continue;
    if (edge.from_concept_id.startsWith('system:') && edge.to_concept_id.startsWith('module:')) {
      systemToModules[edge.from_concept_id] = systemToModules[edge.from_concept_id] || [];
      systemToModules[edge.from_concept_id].push(edge.to_concept_id);
    }
    if (edge.from_concept_id.startsWith('module:') && edge.to_concept_id.startsWith('code:')) {
      moduleToFiles[edge.from_concept_id] = moduleToFiles[edge.from_concept_id] || [];
      moduleToFiles[edge.from_concept_id].push(edge.to_concept_id.slice('code:'.length));
    }
  }

  const sortByName = (a: Concept, b: Concept) => a.name.localeCompare(b.name);
  conceptsByLayer.system.sort(sortByName);
  conceptsByLayer.module.sort(sortByName);
  conceptsByLayer.code.sort(sortByName);

  return {
    projectName: args.projectName,
    conceptsByLayer,
    conceptIndex,
    moduleToFiles,
    systemToModules,
    fileIndex: args.fileIndex,
  };
}
