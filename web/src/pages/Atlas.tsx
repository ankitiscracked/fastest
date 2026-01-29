import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { ChevronLeft, Home, Search, X, FileText } from 'lucide-react';
import type { ProjectDecision, AtlasDecisionLink, Snapshot, AtlasDiagram } from '@fastest/shared';
import { api } from '../api/client';
import {
  AtlasData,
  Concept,
  LayerKey,
  BINARY_EXTENSIONS,
  deriveAtlasData,
  getExtension,
  mapDecisionsToConcepts,
  searchConcepts,
  buildAtlasFromIndex,
} from '../utils/atlas';
import { DiagramView, type DiagramData } from '../components/atlas/DiagramView';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  conceptRefs?: string[];
};


export function Atlas() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const [atlas, setAtlas] = useState<AtlasData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<ProjectDecision[]>([]);
  const [decisionsLoading, setDecisionsLoading] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionLinks, setDecisionLinks] = useState<AtlasDecisionLink[]>([]);
  const [indexing, setIndexing] = useState(false);

  const [navStack, setNavStack] = useState<string[]>([]);
  const [filePreview, setFilePreview] = useState<{ path: string; content: string; error?: string; loading?: boolean } | null>(null);
  const [diagrams, setDiagrams] = useState<AtlasDiagram[]>([]);
  const [diagramsLoading, setDiagramsLoading] = useState(false);

  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSearching, setChatSearching] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [isCompact, setIsCompact] = useState(false);

  const activeConceptId = navStack[navStack.length - 1] || null;
  const activeConcept = activeConceptId ? atlas?.conceptIndex[activeConceptId] : null;

  const visibleLayers = useMemo(() => {
    if (!atlas) return null;
    return atlas.conceptsByLayer;
  }, [atlas]);

  const decisionMap = useMemo(() => {
    if (!atlas) return {};
    if (decisionLinks.length > 0) {
      const map: Record<string, ProjectDecision[]> = {};
      const decisionLookup = new Map(decisions.map((d) => [d.id, d]));
      for (const link of decisionLinks) {
        const decision = decisionLookup.get(link.decision_id);
        if (!decision) continue;
        map[link.concept_id] = map[link.concept_id] || [];
        map[link.concept_id].push(decision);
      }
      return map;
    }
    return mapDecisionsToConcepts(atlas.conceptIndex, decisions);
  }, [atlas, decisions, decisionLinks]);

  const overlayHeight = chatExpanded ? (isCompact ? '75%' : '60%') : '56px';
  const overlayPadding = chatExpanded ? (isCompact ? '75vh' : '60vh') : '96px';

  const loadAtlas = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const projectData = await api.getProject(projectId);
      const project = projectData.project;
      let snapshot: Snapshot | undefined;
      if (project.last_snapshot_id) {
        const snap = await api.getSnapshot(project.last_snapshot_id);
        snapshot = snap.snapshot;
      } else if (projectData.snapshots?.length) {
        snapshot = projectData.snapshots
          .slice()
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
      }

      if (!snapshot) {
        setAtlas({
          projectName: project.name,
          conceptsByLayer: { narrative: [], capability: [], system: [], module: [], code: [] },
          conceptIndex: {},
          moduleToFiles: {},
          systemToModules: {},
          fileIndex: {},
        });
        setLoading(false);
        return;
      }

      const manifest = await api.getManifest(snapshot.manifest_hash);
      const fileIndex: Record<string, { hash: string; size: number }> = {};
      for (const file of manifest.files) {
        fileIndex[file.path] = { hash: file.hash, size: file.size };
      }

      let atlasIndex = await api.getAtlasIndex(projectId);
      if (atlasIndex.concepts.length === 0) {
        setIndexing(true);
        await api.buildAtlasIndex(projectId);
        atlasIndex = await api.getAtlasIndex(projectId);
        setIndexing(false);
      }

      setDecisionLinks(atlasIndex.decision_links || []);

      if (atlasIndex.concepts.length > 0) {
        const built = buildAtlasFromIndex({
          concepts: atlasIndex.concepts.map((c) => ({
            id: c.id,
            name: c.name,
            layer: c.layer,
            description: c.description,
          })),
          edges: atlasIndex.edges,
          fileIndex,
          projectName: project.name,
          snapshotDate: snapshot.created_at ? new Date(snapshot.created_at).toLocaleDateString() : undefined,
        });
        built.snapshot = snapshot;
        built.manifest = manifest;
        setAtlas(built);
      } else {
        const derived = deriveAtlasData(manifest, snapshot);
        derived.projectName = project.name;
        setAtlas(derived);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Atlas');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadDecisions = useCallback(async () => {
    if (!projectId) return;
    setDecisionsLoading(true);
    setDecisionError(null);
    try {
      const result = await api.listProjectDecisions(projectId);
      setDecisions(result.decisions || []);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : 'Failed to load decisions');
    } finally {
      setDecisionsLoading(false);
    }
  }, [projectId]);

  const loadDiagrams = useCallback(async (conceptId?: string | null) => {
    if (!projectId) return;
    setDiagramsLoading(true);
    try {
      const result = await api.listAtlasDiagrams(projectId, conceptId || undefined);
      setDiagrams(result.diagrams || []);
    } catch {
      setDiagrams([]);
    } finally {
      setDiagramsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadAtlas();
  }, [loadAtlas]);

  useEffect(() => {
    loadDecisions();
  }, [loadDecisions]);

  useEffect(() => {
    loadDiagrams(activeConceptId);
  }, [loadDiagrams, activeConceptId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, chatExpanded]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault();
        setChatExpanded(prev => !prev);
      }
      if (event.key === 'Escape') {
        setChatExpanded(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const update = () => setIsCompact(window.innerWidth < 1024);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const navigateHome = () => {
    setNavStack([]);
  };

  const navigateBack = () => {
    setNavStack(prev => prev.slice(0, -1));
  };

  const openConcept = (conceptId: string) => {
    setNavStack(prev => [...prev, conceptId]);
  };

  const extractDecisions = async () => {
    if (!projectId) return;
    setDecisionsLoading(true);
    setDecisionError(null);
    try {
      const result = await api.extractProjectDecisions(projectId, { maxConversations: 4, messagesPerConversation: 10 });
      setDecisions(result.decisions || []);
      const atlasIndex = await api.getAtlasIndex(projectId);
      setDecisionLinks(atlasIndex.decision_links || []);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : 'Failed to extract decisions');
    } finally {
      setDecisionsLoading(false);
    }
  };

  const loadFile = async (path: string) => {
    if (!atlas) return;
    const file = atlas.fileIndex[path];
    if (!file) return;
    const extension = getExtension(path);
    if (BINARY_EXTENSIONS.has(extension)) {
      setFilePreview({ path, content: '', error: 'Binary file preview is not supported yet.' });
      return;
    }
    if (file.size > 400_000) {
      setFilePreview({ path, content: '', error: 'File is too large to preview.' });
      return;
    }

    setFilePreview({ path, content: '', loading: true });
    try {
      const data = await api.downloadBlob(file.hash);
      const text = new TextDecoder().decode(data);
      setFilePreview({ path, content: text });
    } catch (err) {
      setFilePreview({ path, content: '', error: err instanceof Error ? err.message : 'Failed to load file.' });
    }
  };

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!atlas) return;
    const query = chatInput.trim();
    if (!query) return;

    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: 'user', content: query };
    const assistantId = `assistant-${Date.now()}`;
    setChatMessages(prev => [...prev, userMessage, {
      id: assistantId,
      role: 'assistant',
      content: 'Searching...',
    }]);
    setChatInput('');
    setChatExpanded(true);

    setChatSearching(true);
    try {
      const results = await api.searchAtlas(projectId, query, 8);
      const conceptRefs = results.results.map(r => r.id);
      const message = conceptRefs.length ? 'Here are the closest matches:' : 'No matching concepts yet.';
      setChatMessages(prev => prev.map(m => m.id === assistantId ? {
        ...m,
        content: message,
        conceptRefs,
      } : m));
    } catch (err) {
      const fallback = searchConcepts(query, atlas.conceptIndex);
      setChatMessages(prev => prev.map(m => m.id === assistantId ? {
        ...m,
        content: fallback.length ? 'Here are the closest matches:' : 'No matching concepts yet.',
        conceptRefs: fallback.map(c => c.id),
      } : m));
    } finally {
      setChatSearching(false);
    }
  };

  const renderConceptCard = (concept: Concept) => {
    const decisionCount = decisionMap[concept.id]?.length ?? 0;
    return (
    <button
      key={concept.id}
      onClick={() => openConcept(concept.id)}
      className="w-full text-left bg-white border border-surface-200 rounded-md px-4 py-3 hover:border-surface-300 hover:shadow-sm transition"
    >
      <div className="text-sm font-semibold text-surface-800">{concept.name}</div>
      <div className="text-xs text-surface-500 mt-1">{concept.description}</div>
      <div className="text-xs text-surface-400 mt-2">
        {typeof concept.childCount === 'number' && (
          <span>
            {concept.childCount}{' '}
            {concept.layer === 'system'
              ? 'modules'
              : concept.layer === 'module'
                ? 'files'
                : 'items'}
          </span>
        )}
        {typeof concept.childCount === 'number' && (
          <span className="mx-2 text-surface-300">•</span>
        )}
        <span>{decisionCount} decisions</span>
        {concept.lastActivity && (
          <>
            <span className="mx-2 text-surface-300">•</span>
            <span>{concept.lastActivity}</span>
          </>
        )}
      </div>
    </button>
    );
  };

  const renderLayer = (title: string, layer: LayerKey) => {
    const items = visibleLayers?.[layer] || [];
    if (!items.length) {
      return (
        <div className="border border-dashed border-surface-200 rounded-md p-4 text-xs text-surface-400">
          No {title.toLowerCase()} found yet.
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {items.slice(0, 8).map(renderConceptCard)}
        {items.length > 8 && (
          <div className="text-xs text-surface-400">Showing 8 of {items.length}. Refine your view in Explore.</div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-surface-500">Loading Atlas…</div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-red-600">{error}</div>
    );
  }

  return (
    <div className="h-full flex flex-col lg:flex-row bg-surface-50">
      <div className="flex-1 relative overflow-hidden">
        {/* Main view */}
        <div
          className="h-full overflow-y-auto px-6 py-5"
          style={{ paddingBottom: overlayPadding }}
        >
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="text-xs uppercase tracking-wide text-surface-400">Atlas</div>
              <h1 className="text-xl font-semibold text-surface-800">{atlas?.projectName || 'Project Map'}</h1>
              {atlas?.snapshot?.created_at && (
                <div className="text-xs text-surface-400 mt-1">
                  Latest snapshot {new Date(atlas.snapshot.created_at).toLocaleDateString()}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={loadAtlas}
                className="text-xs px-2.5 py-1.5 border border-surface-300 rounded-md text-surface-600 hover:bg-surface-100"
              >
                Refresh
              </button>
              <button
                onClick={async () => {
                  if (!projectId) return;
                  setIndexing(true);
                  await api.buildAtlasIndex(projectId);
                  await loadAtlas();
                  setIndexing(false);
                }}
                disabled={indexing}
                className="text-xs px-2.5 py-1.5 border border-surface-300 rounded-md text-surface-600 hover:bg-surface-100 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {indexing ? 'Indexing…' : 'Rebuild Index'}
              </button>
            </div>
          </div>

          {indexing && (
            <div className="mb-4 text-xs text-surface-400">Building Atlas index…</div>
          )}

          {decisionError && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
              {decisionError}
            </div>
          )}

          {decisions.length === 0 && !decisionsLoading && (
            <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-surface-200 bg-white px-4 py-3 text-xs text-surface-600">
              <span>No decisions captured yet.</span>
              <button
                onClick={extractDecisions}
                disabled={decisionsLoading}
                className="text-xs px-2.5 py-1.5 border border-surface-300 rounded-md text-surface-600 hover:bg-surface-50 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Extract decisions
              </button>
            </div>
          )}

          {decisionsLoading && (
            <div className="mb-4 text-xs text-surface-400">Updating decisions…</div>
          )}

          {!atlas?.snapshot && (
            <div className="mb-6 rounded-md border border-dashed border-surface-200 bg-white p-4 text-sm text-surface-500">
              Atlas needs a snapshot to map your project. Create a snapshot from any workspace to populate this view.
            </div>
          )}

          {activeConcept ? (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <button
                  onClick={navigateBack}
                  className="text-surface-500 hover:text-surface-700"
                  title="Back"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={navigateHome}
                  className="text-surface-500 hover:text-surface-700"
                  title="Home"
                >
                  <Home className="w-4 h-4" />
                </button>
                <span className="text-xs uppercase tracking-wide text-surface-400">{activeConcept.layer}</span>
              </div>

              <div className="bg-white border border-surface-200 rounded-md p-5">
                <div className="text-sm font-semibold text-surface-800">{activeConcept.name}</div>
                <div className="text-xs text-surface-500 mt-1">{activeConcept.description}</div>
                {activeConcept.layer === 'code' && activeConcept.filePath && (
                  <button
                    onClick={() => loadFile(activeConcept.filePath!)}
                    className="mt-4 inline-flex items-center gap-2 text-xs px-2.5 py-1.5 border border-surface-300 rounded-md text-surface-600 hover:bg-surface-50"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Preview file
                  </button>
                )}
                <button
                  onClick={async () => {
                    if (!projectId) return;
                    await api.createAtlasDiagram(projectId, { conceptId: activeConcept.id, type: 'dependency' });
                    await loadDiagrams(activeConcept.id);
                  }}
                  className="mt-4 ml-3 inline-flex items-center gap-2 text-xs px-2.5 py-1.5 border border-surface-300 rounded-md text-surface-600 hover:bg-surface-50"
                >
                  Generate diagram
                </button>
              </div>

              <div className="mt-6">
                <div className="text-xs uppercase tracking-wide text-surface-400 mb-2">Decisions</div>
                {decisionMap[activeConcept.id]?.length ? (
                  <div className="space-y-3">
                    {decisionMap[activeConcept.id].map((decision) => (
                      <div key={decision.id} className="bg-white border border-surface-200 rounded-md px-4 py-3">
                        <div className="text-xs font-semibold text-surface-700">{decision.decision}</div>
                        {decision.rationale && (
                          <div className="text-xs text-surface-500 mt-1">{decision.rationale}</div>
                        )}
                        <div className="text-xs text-surface-400 mt-2">
                          {decision.category || 'decision'} · {new Date(decision.decided_at).toLocaleDateString()}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-surface-400">No decisions linked to this concept yet.</div>
                )}
              </div>

              {activeConcept.layer === 'system' && atlas && (
                <div className="mt-6">
                  <div className="text-xs uppercase tracking-wide text-surface-400 mb-2">Modules</div>
                  <div className="space-y-3">
                    {(atlas.systemToModules[activeConcept.id] || []).map(moduleId => {
                      const concept = atlas.conceptIndex[moduleId];
                      return concept ? renderConceptCard(concept) : null;
                    })}
                  </div>
                </div>
              )}

              {activeConcept.layer === 'module' && atlas && (
                <div className="mt-6">
                  <div className="text-xs uppercase tracking-wide text-surface-400 mb-2">Files</div>
                  <div className="space-y-2">
                    {(atlas.moduleToFiles[activeConcept.id] || []).slice(0, 50).map(path => (
                      <button
                        key={path}
                        onClick={() => loadFile(path)}
                        className="w-full text-left text-xs px-3 py-2 border border-surface-200 rounded-md bg-white hover:bg-surface-50"
                      >
                        {path}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-10">
              <div>
                <div className="text-xs uppercase tracking-wide text-surface-400 mb-3">Narrative</div>
                {renderLayer('Narrative', 'narrative')}
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-surface-400 mb-3">Systems</div>
                {renderLayer('Systems', 'system')}
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-surface-400 mb-3">Capabilities</div>
                {renderLayer('Capabilities', 'capability')}
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-surface-400 mb-3">Modules</div>
                {renderLayer('Modules', 'module')}
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-surface-400 mb-3">Code</div>
                {renderLayer('Code', 'code')}
              </div>
            </div>
          )}
        </div>

        {/* Chat overlay */}
        <div
          className={`absolute left-0 right-0 bottom-0 transition-all duration-200 ${chatExpanded ? 'shadow-lg' : ''}`}
          style={{ height: overlayHeight }}
        >
          <div className="h-full bg-white border-t border-surface-200 flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b border-surface-100">
              <div className="flex items-center gap-2 text-xs text-surface-500">
                <Search className="w-3.5 h-3.5" />
                Ask Atlas
              </div>
              <button
                onClick={() => setChatExpanded(false)}
                className="text-surface-400 hover:text-surface-600"
                title="Collapse"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {chatExpanded && (
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {chatMessages.length === 0 && (
                  <div className="text-xs text-surface-400">
                    Ask a question to search concepts. Try: "auth", "deployment", "snapshot".
                  </div>
                )}
                {chatMessages.map(message => (
                  <div key={message.id} className={message.role === 'user' ? 'text-right' : 'text-left'}>
                    <div className={`inline-block px-3 py-2 rounded-md text-xs ${message.role === 'user'
                      ? 'bg-accent-600 text-white'
                      : 'bg-surface-100 text-surface-700'
                    }`}>
                      {message.content}
                    </div>
                    {message.conceptRefs && message.conceptRefs.length > 0 && (
                      <div className="mt-2 space-y-2">
                        {message.conceptRefs.map(ref => {
                          const concept = atlas?.conceptIndex[ref];
                          if (!concept) return null;
                          return (
                            <button
                              key={ref}
                              onClick={() => openConcept(ref)}
                              className="block w-full text-left text-xs px-3 py-2 border border-surface-200 rounded-md bg-white hover:bg-surface-50"
                            >
                              <div className="text-surface-700 font-medium">{concept.name}</div>
                              <div className="text-surface-400">{concept.description}</div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            )}
            <form onSubmit={handleAsk} className="px-4 py-3 border-t border-surface-100">
              <div className="flex items-center gap-2">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  disabled={chatSearching}
                  className="flex-1 text-xs px-3 py-2 border border-surface-200 rounded-md focus:outline-none focus:ring-2 focus:ring-accent-500"
                  placeholder="Ask Atlas..."
                />
                <button
                  type="submit"
                  disabled={chatSearching}
                  className="text-xs px-3 py-2 bg-accent-600 text-white rounded-md hover:bg-accent-700 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {chatSearching ? 'Searching' : 'Ask'}
                </button>
                <button
                  type="button"
                  onClick={() => setChatExpanded(prev => !prev)}
                  className="text-xs px-2 py-2 border border-surface-200 rounded-md text-surface-500 hover:bg-surface-50"
                  title="Toggle chat"
                >
                  {chatExpanded ? 'Hide' : 'Show'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* Canvas panel */}
      <aside className="w-full h-[40vh] lg:h-auto lg:w-96 border-t lg:border-t-0 lg:border-l border-surface-200 bg-white flex flex-col">
        <div className="px-4 py-3 border-b border-surface-100 text-xs uppercase tracking-wide text-surface-400">
          Canvas
        </div>
        <div className="flex-1 overflow-y-auto p-4 text-xs text-surface-600">
          {filePreview ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-surface-700">{filePreview.path}</div>
                <button
                  onClick={() => setFilePreview(null)}
                  className="text-surface-400 hover:text-surface-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {filePreview.loading && (
                <div className="text-surface-400">Loading file…</div>
              )}
              {filePreview.error && (
                <div className="text-red-600">{filePreview.error}</div>
              )}
              {!filePreview.loading && !filePreview.error && (
                <pre className="text-xs whitespace-pre-wrap bg-surface-50 border border-surface-200 rounded-md p-3 max-h-[70vh] overflow-y-auto">
                  {filePreview.content}
                </pre>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {diagramsLoading && (
                <div className="text-surface-400">Loading diagrams…</div>
              )}
              {!diagramsLoading && diagrams.length === 0 && (
                <div className="text-surface-400">
                  No diagrams yet. Generate one from a concept.
                </div>
              )}
              {diagrams.map((diagram) => {
                let data: DiagramData | null = null;
                try {
                  data = JSON.parse(diagram.data);
                } catch {
                  data = null;
                }
                return (
                  <div key={diagram.id} className="border border-surface-200 rounded-md p-3 bg-surface-50">
                    <div className="text-xs font-semibold text-surface-700">{data?.title || 'Diagram'}</div>
                    <div className="text-xs text-surface-400 mt-1">{diagram.type}</div>
                    {data && (
                      <div className="mt-3">
                        <DiagramView data={data} type={diagram.type} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
