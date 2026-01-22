import type { DurableObjectState } from 'cloudflare:workers';
import { parseSSEStream } from '@cloudflare/sandbox';
import type { DeploymentLogEntry, DeploymentLog } from '@fastest/shared';
import type { Env } from './index';
import type { ConversationState, Deployment, ProjectInfo, SandboxRunner } from './conversation_types';
import type { ConversationFiles } from './conversation_files';
import type { ConversationSandbox } from './conversation_sandbox';

type ExecEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'complete'; exitCode: number }
  | { type: 'error'; error: string };

type Broadcast = (event: { type: string; [key: string]: unknown }) => void;

export class ConversationDeployments {
  private env: Env;
  private ctx: DurableObjectState;
  private ensureState: () => Promise<ConversationState>;
  private sandbox: ConversationSandbox;
  private files: ConversationFiles;
  private broadcast: Broadcast;

  constructor(deps: {
    env: Env;
    ctx: DurableObjectState;
    ensureState: () => Promise<ConversationState>;
    sandbox: ConversationSandbox;
    files: ConversationFiles;
    broadcast: Broadcast;
  }) {
    this.env = deps.env;
    this.ctx = deps.ctx;
    this.ensureState = deps.ensureState;
    this.sandbox = deps.sandbox;
    this.files = deps.files;
    this.broadcast = deps.broadcast;
  }

  /**
   * Detect project type by checking for wrangler config
   */
  async detectProjectType(apiUrl: string, apiToken: string): Promise<ProjectInfo> {
    const state = await this.ensureState();
    const sandbox = await this.sandbox.getSandboxRunner();
    const workDir = this.sandbox.getSandboxWorkDir(sandbox);

    if (state.lastManifestHash) {
      await this.files.restoreFiles(sandbox, apiUrl, apiToken, state.lastManifestHash, workDir);
    }

    const tomlCheck = await sandbox.exec(`test -f ${workDir}/wrangler.toml && echo "exists"`);
    const jsoncCheck = await sandbox.exec(`test -f ${workDir}/wrangler.jsonc && echo "exists"`);

    let projectInfo: ProjectInfo = { type: 'unknown' };

    if (tomlCheck.stdout.includes('exists')) {
      const catResult = await sandbox.exec(`cat ${workDir}/wrangler.toml`);
      const nameMatch = catResult.stdout.match(/name\s*=\s*["']([^"']+)["']/);
      projectInfo = {
        type: 'wrangler',
        name: nameMatch?.[1],
        configFile: 'wrangler.toml',
      };
    } else if (jsoncCheck.stdout.includes('exists')) {
      const catResult = await sandbox.exec(`cat ${workDir}/wrangler.jsonc`);
      try {
        const jsonContent = catResult.stdout.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const config = JSON.parse(jsonContent);
        projectInfo = {
          type: 'wrangler',
          name: config.name,
          configFile: 'wrangler.jsonc',
        };
      } catch {
        projectInfo = {
          type: 'wrangler',
          configFile: 'wrangler.jsonc',
        };
      }
    }

    state.projectInfo = projectInfo;
    await this.ctx.storage.put('state', state);
    this.broadcast({ type: 'project_info', info: projectInfo });

    return projectInfo;
  }

  /**
   * Deploy the project to Cloudflare Workers
   */
  async deploy(deploymentId: string, apiUrl: string, apiToken: string): Promise<void> {
    const state = await this.ensureState();
    const sandbox = await this.sandbox.getSandboxRunner();
    const workDir = this.sandbox.getSandboxWorkDir(sandbox);

    const deploymentLog: DeploymentLog = {
      deploymentId,
      entries: [],
      startedAt: new Date().toISOString(),
    };

    const appendLog = async (step: DeploymentLogEntry['step'], stream: 'stdout' | 'stderr', content: string) => {
      const entry: DeploymentLogEntry = {
        timestamp: new Date().toISOString(),
        step,
        stream,
        content,
      };
      deploymentLog.entries.push(entry);
      this.broadcast({ type: 'deployment_log', deploymentId, entry });
    };

    const deployment: Deployment = {
      id: deploymentId,
      url: '',
      status: 'deploying',
      createdAt: new Date().toISOString(),
    };
    state.deployments.push(deployment);
    await this.ctx.storage.put('state', state);
    this.broadcast({ type: 'deployment_started', deployment });

    try {
      if (state.lastManifestHash) {
        await this.files.restoreFiles(sandbox, apiUrl, apiToken, state.lastManifestHash, workDir);
      }

      if (!state.projectInfo) {
        await this.detectProjectType(apiUrl, apiToken);
      }

      if (state.projectInfo?.type !== 'wrangler') {
        throw new Error('Only Wrangler projects are supported for deployment');
      }

      const envVars = await this.fetchProjectEnvVars(apiUrl, apiToken, state.projectId);

      const packageJsonCheck = await sandbox.exec(`test -f ${workDir}/package.json && echo "exists"`);
      if (packageJsonCheck.stdout.includes('exists')) {
        await appendLog('install', 'stdout', 'Installing dependencies...\n');
        await this.runCommandWithLogs(sandbox, `cd ${workDir} && npm install 2>&1`, 'install', appendLog, { timeout: 120000 });
      }

      const packageJson = await sandbox.exec(`cat ${workDir}/package.json 2>/dev/null`);
      if (packageJson.success) {
        try {
          const pkg = JSON.parse(packageJson.stdout);
          if (pkg.scripts?.build) {
            await appendLog('build', 'stdout', 'Running build...\n');
            await this.runCommandWithLogs(sandbox, `cd ${workDir} && npm run build 2>&1`, 'build', appendLog, { timeout: 120000 });
          }
        } catch {
          // Ignore JSON parse errors
        }
      }

      const projectName = `fastest-${state.projectId.slice(0, 8)}`;

      const varFlags = envVars
        .map(v => `--var ${v.key}:${this.shellEscape(v.value)}`)
        .join(' ');

      await appendLog('deploy', 'stdout', 'Deploying to Cloudflare Workers...\n');

      const deployOutput = await this.runCommandWithLogs(
        sandbox,
        `cd ${workDir} && npx wrangler deploy --name ${projectName} --compatibility-date 2024-01-01 ${varFlags} 2>&1`,
        'deploy',
        appendLog,
        {
          timeout: 120000,
          env: {
            CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_DEPLOY_TOKEN || '',
            CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID || '',
          },
        }
      );

      const urlMatch = deployOutput.match(/https:\/\/[^\s)]+\.workers\.dev/);
      const deployedUrl = urlMatch?.[0] || `https://${projectName}.workers.dev`;

      deployment.url = deployedUrl;
      deployment.status = 'success';
      deployment.completedAt = new Date().toISOString();

      deploymentLog.completedAt = new Date().toISOString();
      await this.ctx.storage.put(`deployment_log:${deploymentId}`, deploymentLog);
      await this.ctx.storage.put('state', state);

      await appendLog('deploy', 'stdout', `\nDeployed successfully to ${deployedUrl}\n`);
      this.broadcast({ type: 'deployment_complete', deployment });
    } catch (error) {
      deployment.status = 'failed';
      deployment.error = error instanceof Error ? error.message : String(error);
      deployment.completedAt = new Date().toISOString();

      deploymentLog.completedAt = new Date().toISOString();
      await this.ctx.storage.put(`deployment_log:${deploymentId}`, deploymentLog);
      await this.ctx.storage.put('state', state);

      await appendLog('deploy', 'stderr', `\nDeployment failed: ${deployment.error}\n`);
      this.broadcast({ type: 'deployment_complete', deployment });
    }
  }

  private async runCommandWithLogs(
    sandbox: SandboxRunner,
    command: string,
    step: DeploymentLogEntry['step'],
    appendLog: (step: DeploymentLogEntry['step'], stream: 'stdout' | 'stderr', content: string) => Promise<void>,
    options?: { env?: Record<string, string>; timeout?: number }
  ): Promise<string> {
    const summarize = (value?: string) => {
      if (!value) return '';
      const trimmed = value.trim();
      return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
    };
    if (sandbox.execStream) {
      const stream = await sandbox.execStream(command, options);
      let fullOutput = '';

      for await (const event of parseSSEStream(stream) as AsyncIterable<ExecEvent>) {
        switch (event.type) {
          case 'stdout':
            fullOutput += event.data;
            await appendLog(step, 'stdout', event.data);
            break;
          case 'stderr':
            await appendLog(step, 'stderr', event.data);
            break;
          case 'complete':
            if (event.exitCode !== 0) {
              console.error('[Sandbox] Command failed (stream)', {
                step,
                command,
                exitCode: event.exitCode,
                output: summarize(fullOutput),
              });
              throw new Error(`Command failed with exit code ${event.exitCode}`);
            }
            return fullOutput;
          case 'error':
            console.error('[Sandbox] Command stream error', { step, command, error: event.error });
            throw new Error(event.error);
        }
      }
      return fullOutput;
    }

    const result = await sandbox.exec(command, { env: options?.env });
    if (result.stdout) {
      await appendLog(step, 'stdout', result.stdout);
    }
    if (result.stderr) {
      await appendLog(step, 'stderr', result.stderr);
    }
    if (!result.success) {
      console.error('[Sandbox] Command failed', {
        step,
        command,
        exitCode: result.exitCode,
        stdout: summarize(result.stdout),
        stderr: summarize(result.stderr),
      });
      throw new Error(`Command failed${result.exitCode !== undefined ? ` with exit code ${result.exitCode}` : ''}`);
    }
    return result.stdout || '';
  }

  private async fetchProjectEnvVars(
    apiUrl: string,
    apiToken: string,
    projectId: string
  ): Promise<Array<{ key: string; value: string; is_secret: boolean }>> {
    try {
      const response = await fetch(`${apiUrl}/v1/projects/${projectId}/env-vars/values`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });

      if (!response.ok) {
        console.warn('Failed to fetch env vars, proceeding without them');
        return [];
      }

      const data = await response.json() as { variables: Array<{ key: string; value: string; is_secret: boolean }> };
      return data.variables;
    } catch {
      console.warn('Error fetching env vars, proceeding without them');
      return [];
    }
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
}
