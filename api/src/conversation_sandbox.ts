import { getSandbox, type Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import { Sandbox as E2BSandbox } from 'e2b';
import type { Env } from './index';
import type { ConversationState, SandboxRunner, SandboxExecResult } from './conversation_types';

type EnsureState = () => Promise<ConversationState>;
type PersistState = (state: ConversationState) => Promise<void>;

export class ConversationSandbox {
  private env: Env;
  private ensureState: EnsureState;
  private persistState: PersistState;
  private sandbox: CloudflareSandbox | null = null;
  private sandboxReady = false;
  private e2bSandbox: E2BSandbox | null = null;

  constructor(deps: { env: Env; ensureState: EnsureState; persistState: PersistState }) {
    this.env = deps.env;
    this.ensureState = deps.ensureState;
    this.persistState = deps.persistState;
  }

  getSandboxProvider(): 'cloudflare' | 'e2b' {
    const provider = (this.env.SANDBOX_PROVIDER || '').toLowerCase();
    return provider === 'e2b' ? 'e2b' : 'cloudflare';
  }

  getSandboxWorkDir(sandbox: SandboxRunner): string {
    return sandbox.type === 'e2b' ? '/home/user/workspace' : '/workspace';
  }

  async getSandboxRunner(): Promise<SandboxRunner> {
    const provider = this.getSandboxProvider();

    if (provider === 'e2b') {
      const sandbox = await this.getE2BSandbox();
      return {
        exec: async (command, opts) => {
          try {
            const execResult = await sandbox.commands.run(command, { cwd: opts?.cwd, envs: opts?.env });
            if (execResult.exitCode !== 0) {
              console.error('[Sandbox][E2B] Command failed', {
                command,
                exitCode: execResult.exitCode,
                stdout: (execResult.stdout || '').slice(0, 2000),
                stderr: (execResult.stderr || '').slice(0, 2000),
              });
            }
            return {
              success: execResult.exitCode === 0,
              stdout: execResult.stdout || '',
              stderr: execResult.stderr || '',
              exitCode: execResult.exitCode,
            } satisfies SandboxExecResult;
          } catch (err) {
            const exitCode = (err && typeof err === 'object' && 'exitCode' in err)
              ? (err as { exitCode?: number }).exitCode
              : undefined;
            const stdout = (err && typeof err === 'object' && 'stdout' in err)
              ? String((err as { stdout?: string }).stdout || '')
              : '';
            const stderr = (err && typeof err === 'object' && 'stderr' in err)
              ? String((err as { stderr?: string }).stderr || '')
              : '';
            console.error('[Sandbox][E2B] Command exception', {
              command,
              error: err instanceof Error ? err.message : String(err),
              exitCode,
              stdout: stdout.slice(0, 2000),
              stderr: stderr.slice(0, 2000),
            });
            throw err;
          }
        },
        runBackground: async (command, opts) => {
          try {
            await sandbox.commands.run(command, { cwd: opts?.cwd, envs: opts?.env, background: true });
          } catch (err) {
            console.error('[Sandbox][E2B] Background command exception', {
              command,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        },
        getHost: (port) => sandbox.getHost(port),
        type: 'e2b',
      };
    }

    const sandbox = await this.getCloudflareSandbox();
    return {
      exec: (command, opts) => sandbox.exec(command, opts),
      execStream: (command, opts) => sandbox.execStream(command, opts),
      type: 'cloudflare',
    };
  }

  private async getCloudflareSandbox(): Promise<CloudflareSandbox> {
    if (this.sandbox && this.sandboxReady) {
      return this.sandbox;
    }

    const state = await this.ensureState();
    const sandbox = getSandbox(this.env.Sandbox, `workspace-${state.workspaceId}`, { normalizeId: true });
    if (!sandbox) {
      throw new Error('Failed to get sandbox instance');
    }
    this.sandbox = sandbox;
    this.sandboxReady = true;

    return this.sandbox;
  }

  async getE2BSandbox(): Promise<E2BSandbox> {
    const timeoutMs = 30 * 60 * 1000;
    const apiKey = (this.env.E2B_API_KEY || '').trim();
    const e2bOpts = apiKey ? { apiKey } : undefined;
    if (this.e2bSandbox) {
      try {
        if (await this.e2bSandbox.isRunning()) {
          try {
            await this.e2bSandbox.setTimeout(timeoutMs);
          } catch (err) {
            console.warn('[Sandbox][E2B] Failed to extend timeout', err);
          }
          return this.e2bSandbox;
        }
      } catch {
        // fall through to reconnect
      }
    }

    const state = await this.ensureState();
    const templateId = (this.env.E2B_TEMPLATE_ID || '').trim();
    if (state.e2bSandboxId) {
      try {
        const sandbox = await E2BSandbox.connect(state.e2bSandboxId, e2bOpts);
        try {
          await sandbox.setTimeout(timeoutMs);
        } catch (err) {
          console.warn('[Sandbox][E2B] Failed to extend timeout', err);
        }
        this.e2bSandbox = sandbox;
        return sandbox;
      } catch {
        state.e2bSandboxId = undefined;
        await this.persistState(state);
        // fall through to create
      }
    }

    const sandbox = templateId
      ? await E2BSandbox.create(templateId, { ...e2bOpts, timeoutMs })
      : await E2BSandbox.create({ ...e2bOpts, timeoutMs });
    try {
      await sandbox.setTimeout(timeoutMs);
    } catch (err) {
      console.warn('[Sandbox][E2B] Failed to set timeout', err);
    }
    state.e2bSandboxId = sandbox.sandboxId;
    await this.persistState(state);
    this.e2bSandbox = sandbox;
    return sandbox;
  }
}
