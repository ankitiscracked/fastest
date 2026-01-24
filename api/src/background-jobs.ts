/**
 * Background Jobs - Periodic processing for snapshots, drift, and analysis
 *
 * Triggered by Cloudflare Cron every 15 minutes.
 *
 * Jobs:
 * 1. Auto-snapshot: Create snapshots for workspaces with file changes
 * 2. Drift calculation: Update drift reports for changed workspaces
 * 3. (Future) Refactoring analysis: Analyze code quality
 */

import { eq, and, gt, desc, isNotNull, ne } from 'drizzle-orm';
import type { Env } from './index';
import type { Manifest } from '@fastest/shared';
import { compareDrift, fromJSON } from '@fastest/shared';
import { createDb, workspaces, projects, snapshots, conversations, driftReports, refactoringSuggestions } from './db';
import type { ConversationSession } from './conversation';

// Maximum workspaces to process per cron run (to stay within limits)
const MAX_WORKSPACES_PER_RUN = 10;

// Generate ULID (copied from workspaces.ts - could be extracted to utils)
function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const randomPart = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  return (timestamp + randomPart).toUpperCase();
}

/**
 * Main entry point for background jobs
 */
export async function runBackgroundJobs(env: Env): Promise<void> {
  console.log('[BackgroundJobs] Starting scheduled run');

  const startTime = Date.now();
  const results = {
    workspacesProcessed: 0,
    snapshotsCreated: 0,
    driftReportsUpdated: 0,
    refactoringSuggestionsCreated: 0,
    errors: [] as string[],
  };

  try {
    const db = createDb(env.DB);

    // Find workspaces with recent conversation activity
    // Join conversations to find those updated since their workspace's last snapshot
    const activeWorkspaces = await db
      .select({
        workspace_id: workspaces.id,
        workspace_name: workspaces.name,
        project_id: workspaces.projectId,
        base_snapshot_id: workspaces.baseSnapshotId,
        current_manifest_hash: workspaces.currentManifestHash,
        conversation_id: conversations.id,
        conversation_updated_at: conversations.updatedAt,
        main_workspace_id: projects.mainWorkspaceId,
        owner_user_id: projects.ownerUserId,
      })
      .from(workspaces)
      .innerJoin(projects, eq(workspaces.projectId, projects.id))
      .innerJoin(conversations, eq(conversations.workspaceId, workspaces.id))
      .where(isNotNull(workspaces.baseSnapshotId))
      .orderBy(desc(conversations.updatedAt))
      .limit(MAX_WORKSPACES_PER_RUN * 2); // Get more to filter

    console.log(`[BackgroundJobs] Found ${activeWorkspaces.length} workspaces with conversations`);

    // Deduplicate by workspace (keep latest conversation)
    const seenWorkspaces = new Set<string>();
    const workspacesToProcess: typeof activeWorkspaces = [];

    for (const ws of activeWorkspaces) {
      if (seenWorkspaces.has(ws.workspace_id)) continue;
      seenWorkspaces.add(ws.workspace_id);
      workspacesToProcess.push(ws);

      if (workspacesToProcess.length >= MAX_WORKSPACES_PER_RUN) break;
    }

    console.log(`[BackgroundJobs] Processing ${workspacesToProcess.length} workspaces`);

    for (const ws of workspacesToProcess) {
      try {
        const processed = await processWorkspace(env, db, ws);
        results.workspacesProcessed++;
        if (processed.snapshotCreated) results.snapshotsCreated++;
        if (processed.driftUpdated) results.driftReportsUpdated++;
        results.refactoringSuggestionsCreated += processed.suggestionsCreated;
      } catch (err) {
        const errorMsg = `Workspace ${ws.workspace_id}: ${err instanceof Error ? err.message : 'Unknown error'}`;
        console.error(`[BackgroundJobs] Error: ${errorMsg}`);
        results.errors.push(errorMsg);
      }
    }

  } catch (err) {
    console.error('[BackgroundJobs] Fatal error:', err);
    results.errors.push(`Fatal: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  const duration = Date.now() - startTime;
  console.log(`[BackgroundJobs] Completed in ${duration}ms:`, results);
}

interface ProcessResult {
  snapshotCreated: boolean;
  driftUpdated: boolean;
  suggestionsCreated: number;
}

async function processWorkspace(
  env: Env,
  db: ReturnType<typeof createDb>,
  ws: {
    workspace_id: string;
    workspace_name: string;
    project_id: string;
    base_snapshot_id: string | null;
    current_manifest_hash: string | null;
    conversation_id: string;
    conversation_updated_at: string;
    main_workspace_id: string | null;
    owner_user_id: string;
  }
): Promise<ProcessResult> {
  const result: ProcessResult = {
    snapshotCreated: false,
    driftUpdated: false,
    suggestionsCreated: 0,
  };

  // Get the conversation DO to check lastManifestHash
  const doId = env.ConversationSession.idFromName(ws.conversation_id);
  const stub = env.ConversationSession.get(doId) as DurableObjectStub<ConversationSession>;

  // Get current state from DO
  const stateResponse = await stub.fetch(new Request('http://do/state'));
  if (!stateResponse.ok) {
    console.log(`[BackgroundJobs] Could not get state for conversation ${ws.conversation_id}`);
    return result;
  }

  const { state } = await stateResponse.json() as { state: { lastManifestHash?: string } };
  const currentManifestHash = state?.lastManifestHash;

  if (!currentManifestHash) {
    console.log(`[BackgroundJobs] No manifest hash for workspace ${ws.workspace_id}`);
    return result;
  }

  // Get the workspace's latest snapshot manifest hash
  let existingManifestHash: string | null = null;
  const snapshotResult = await db
    .select({ id: snapshots.id, manifest_hash: snapshots.manifestHash })
    .from(snapshots)
    .where(eq(snapshots.workspaceId, ws.workspace_id))
    .orderBy(desc(snapshots.createdAt))
    .limit(1);
  existingManifestHash = snapshotResult[0]?.manifest_hash ?? null;

  // If manifest hasn't changed, nothing to do
  if (currentManifestHash === existingManifestHash) {
    console.log(`[BackgroundJobs] No changes for workspace ${ws.workspace_id}`);
    return result;
  }

  console.log(`[BackgroundJobs] Creating snapshot for workspace ${ws.workspace_id}`);

  // Create new snapshot
  const snapshotId = generateULID();
  const now = new Date().toISOString();

  await db.insert(snapshots).values({
    id: snapshotId,
    projectId: ws.project_id,
    workspaceId: ws.workspace_id,
    manifestHash: currentManifestHash,
    parentSnapshotId: snapshotResult[0]?.id || null,
    source: 'system', // Auto-created by background job
    createdAt: now,
  });

  // Update workspace's base_snapshot_id
  await db
    .update(workspaces)
    .set({
      baseSnapshotId: snapshotId,
      currentManifestHash: currentManifestHash,
    })
    .where(eq(workspaces.id, ws.workspace_id));

  result.snapshotCreated = true;
  console.log(`[BackgroundJobs] Created snapshot ${snapshotId} for workspace ${ws.workspace_id}`);

  // Calculate drift if this is not the main workspace
  if (ws.main_workspace_id && ws.workspace_id !== ws.main_workspace_id) {
    try {
      const driftUpdated = await calculateAndStoreDrift(
        env,
        db,
        ws.workspace_id,
        ws.main_workspace_id,
        ws.owner_user_id,
        currentManifestHash,
        snapshotId
      );
      result.driftUpdated = driftUpdated;
    } catch (err) {
      console.error(`[BackgroundJobs] Drift calculation failed for ${ws.workspace_id}:`, err);
    }
  }

  // Run refactoring analysis on the new snapshot
  try {
    const suggestionsCreated = await analyzeCodeForSuggestions(
      env,
      db,
      ws.workspace_id,
      snapshotId,
      ws.owner_user_id,
      currentManifestHash
    );
    result.suggestionsCreated = suggestionsCreated;
  } catch (err) {
    console.error(`[BackgroundJobs] Refactoring analysis failed for ${ws.workspace_id}:`, err);
  }

  return result;
}

async function calculateAndStoreDrift(
  env: Env,
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  mainWorkspaceId: string,
  userId: string,
  workspaceManifestHash: string,
  workspaceSnapshotId: string | null
): Promise<boolean> {
  // Get main workspace's latest snapshot manifest hash
  const mainSnapshotResult = await db
    .select({
      id: snapshots.id,
      manifest_hash: snapshots.manifestHash,
    })
    .from(snapshots)
    .where(eq(snapshots.workspaceId, mainWorkspaceId))
    .orderBy(desc(snapshots.createdAt))
    .limit(1);

  const mainManifestHash = mainSnapshotResult[0]?.manifest_hash;
  if (!mainManifestHash) {
    console.log(`[BackgroundJobs] Main workspace has no snapshot`);
    return false;
  }

  // Fetch manifests from R2
  const workspaceManifestKey = `${userId}/manifests/${workspaceManifestHash}.json`;
  const mainManifestKey = `${userId}/manifests/${mainManifestHash}.json`;

  const [workspaceManifestObj, mainManifestObj] = await Promise.all([
    env.BLOBS.get(workspaceManifestKey),
    env.BLOBS.get(mainManifestKey),
  ]);

  if (!workspaceManifestObj || !mainManifestObj) {
    console.log(`[BackgroundJobs] Could not fetch manifests`);
    return false;
  }

  let workspaceManifest: Manifest;
  let mainManifest: Manifest;

  try {
    workspaceManifest = fromJSON(await workspaceManifestObj.text());
    mainManifest = fromJSON(await mainManifestObj.text());
  } catch {
    console.log(`[BackgroundJobs] Failed to parse manifests`);
    return false;
  }

  // Compare manifests
  const comparison = compareDrift(workspaceManifest, mainManifest);
  const now = new Date().toISOString();
  const driftId = generateULID();

  // Save to drift_reports
  await db.insert(driftReports).values({
    id: driftId,
    workspaceId: workspaceId,
    sourceWorkspaceId: mainWorkspaceId,
    workspaceSnapshotId: workspaceSnapshotId,
    sourceSnapshotId: mainSnapshotResult[0]?.id || null,
    sourceOnly: JSON.stringify(comparison.source_only),
    workspaceOnly: JSON.stringify(comparison.workspace_only),
    bothSame: JSON.stringify(comparison.both_same),
    bothDifferent: JSON.stringify(comparison.both_different),
    filesAdded: comparison.source_only.length,
    filesModified: comparison.both_different.length,
    filesDeleted: 0,
    bytesChanged: 0,
    summary: null,
    reportedAt: now,
  });

  console.log(`[BackgroundJobs] Updated drift for workspace ${workspaceId}: +${comparison.source_only.length}, ~${comparison.both_different.length}`);
  return true;
}

// File extensions to analyze for code quality
const ANALYZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php'
]);

// Maximum files to analyze per run (to control AI costs)
const MAX_FILES_TO_ANALYZE = 5;
// Maximum file size to send to AI (in bytes)
const MAX_FILE_SIZE = 10000;

interface RefactoringSuggestion {
  type: 'security' | 'duplication' | 'performance' | 'naming' | 'structure';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  affectedFiles: string[];
  suggestedPrompt: string;
}

async function analyzeCodeForSuggestions(
  env: Env,
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  snapshotId: string,
  userId: string,
  manifestHash: string
): Promise<number> {
  // Fetch manifest to get file list
  const manifestKey = `${userId}/manifests/${manifestHash}.json`;
  const manifestObj = await env.BLOBS.get(manifestKey);

  if (!manifestObj) {
    console.log(`[BackgroundJobs] Could not fetch manifest for analysis`);
    return 0;
  }

  let manifest: Manifest;
  try {
    manifest = fromJSON(await manifestObj.text());
  } catch {
    console.log(`[BackgroundJobs] Failed to parse manifest for analysis`);
    return 0;
  }

  // Filter to analyzable code files and limit count
  const codeFiles = manifest.files
    .filter((file) => {
      const ext = file.path.substring(file.path.lastIndexOf('.'));
      return ANALYZABLE_EXTENSIONS.has(ext);
    })
    .slice(0, MAX_FILES_TO_ANALYZE);

  if (codeFiles.length === 0) {
    console.log(`[BackgroundJobs] No code files to analyze`);
    return 0;
  }

  // Fetch file contents from R2
  const fileContents: { path: string; content: string }[] = [];

  for (const file of codeFiles) {
    const blobKey = `${userId}/blobs/${file.hash}`;
    const blobObj = await env.BLOBS.get(blobKey);

    if (blobObj && file.size <= MAX_FILE_SIZE) {
      const content = await blobObj.text();
      fileContents.push({ path: file.path, content });
    }
  }

  if (fileContents.length === 0) {
    console.log(`[BackgroundJobs] No file contents available for analysis`);
    return 0;
  }

  // Build prompt for AI analysis
  const filesContext = fileContents
    .map(f => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const analysisPrompt = `Analyze the following code files for potential improvements. Focus on:
1. Security issues (hardcoded secrets, SQL injection, XSS vulnerabilities)
2. Code duplication that could be refactored
3. Performance issues (inefficient algorithms, unnecessary re-renders)
4. Naming issues (unclear variable/function names)
5. Structural issues (god classes, circular dependencies)

For each issue found, provide:
- type: one of "security", "duplication", "performance", "naming", "structure"
- severity: "critical" for security issues, "warning" for significant problems, "info" for minor improvements
- title: brief description (max 60 chars)
- description: detailed explanation
- affectedFiles: array of file paths involved
- suggestedPrompt: a prompt the user could give to an AI assistant to fix the issue

Respond with a JSON array of suggestions. If no significant issues found, respond with an empty array [].

Files to analyze:
${filesContext}`;

  try {
    // Call Workers AI for analysis
    // Using llama-2-7b-chat-int8 which is available in the current types
    const response = await env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
      messages: [
        { role: 'system', content: 'You are a code review assistant. Analyze code and output JSON arrays of improvement suggestions. Be concise and focus on actionable issues.' },
        { role: 'user', content: analysisPrompt }
      ],
      max_tokens: 2000,
    });

    // Parse AI response
    const responseText = typeof response === 'string' ? response : (response as { response?: string }).response || '';

    // Extract JSON from response (AI might include explanatory text)
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log(`[BackgroundJobs] No JSON found in AI response`);
      return 0;
    }

    const suggestions: RefactoringSuggestion[] = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      console.log(`[BackgroundJobs] No suggestions from AI analysis`);
      return 0;
    }

    // Store suggestions in database
    const now = new Date().toISOString();
    let insertedCount = 0;

    for (const suggestion of suggestions) {
      // Validate suggestion structure
      if (!suggestion.type || !suggestion.title) continue;

      const suggestionId = generateULID();

      await db.insert(refactoringSuggestions).values({
        id: suggestionId,
        workspaceId: workspaceId,
        snapshotId: snapshotId,
        type: suggestion.type,
        severity: suggestion.severity || 'info',
        title: suggestion.title.substring(0, 100),
        description: suggestion.description || null,
        affectedFiles: JSON.stringify(suggestion.affectedFiles || []),
        suggestedPrompt: suggestion.suggestedPrompt || null,
        status: 'pending',
        createdAt: now,
      });

      insertedCount++;
    }

    console.log(`[BackgroundJobs] Created ${insertedCount} refactoring suggestions for workspace ${workspaceId}`);
    return insertedCount;

  } catch (err) {
    console.error(`[BackgroundJobs] AI analysis error:`, err);
    return 0;
  }
}
