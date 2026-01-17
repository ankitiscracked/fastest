/**
 * Agent execution - run OpenCode or other agents
 */

import { spawn, type ChildProcess } from 'child_process';

export interface AgentConfig {
  /** Working directory for the agent */
  workDir: string;
  /** Provider API key (e.g., ANTHROPIC_API_KEY) */
  apiKey?: string;
  /** Provider to use (anthropic, openai, etc.) */
  provider?: string;
  /** Model to use */
  model?: string;
  /** Maximum steps/iterations */
  maxSteps?: number;
}

export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

/**
 * Get default model for a provider
 */
function getDefaultModel(provider: string): string {
  switch (provider) {
    case 'google':
      return 'gemini-2.0-flash';
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
    default:
      return 'claude-sonnet-4-20250514';
  }
}

/**
 * Start OpenCode serve process
 */
function startServe(config: AgentConfig, port: number): ChildProcess {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: process.env.HOME || '/root',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  };

  // Set provider API key
  if (config.apiKey) {
    if (config.provider === 'openai') {
      env.OPENAI_API_KEY = config.apiKey;
    } else if (config.provider === 'google') {
      env.GOOGLE_GENERATIVE_AI_API_KEY = config.apiKey;
    } else {
      env.ANTHROPIC_API_KEY = config.apiKey;
    }
  }

  const proc = spawn('opencode', ['serve', '--port', port.toString()], {
    cwd: config.workDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  return proc;
}

/**
 * Wait for serve to be ready
 */
async function waitForServe(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/doc`);
      if (response.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Run OpenCode with a prompt using the serve API
 */
export async function runOpenCode(
  prompt: string,
  config: AgentConfig
): Promise<AgentResult> {
  const port = 19000 + Math.floor(Math.random() * 1000);
  let serveProc: ChildProcess | null = null;

  console.log(`Running OpenCode with prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
  console.log(`  Working directory: ${config.workDir}`);
  console.log(`  Starting serve on port ${port}...`);

  try {
    // Start serve process
    serveProc = startServe(config, port);

    // Wait for serve to be ready
    const ready = await waitForServe(port);
    if (!ready) {
      return {
        success: false,
        output: '',
        error: 'OpenCode serve failed to start',
        exitCode: -1,
      };
    }

    console.log('  Serve ready, warming up...');

    // Send a warmup message to initialize the model
    try {
      const warmupResponse = await fetch(`http://localhost:${port}/session?directory=${config.workDir}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (warmupResponse.ok) {
        const session = await warmupResponse.json() as { id: string };
        await fetch(`http://localhost:${port}/session/${session.id}/message?directory=${config.workDir}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: { providerID: config.provider, modelID: config.model || getDefaultModel(config.provider || 'anthropic') },
            parts: [{ type: 'text', text: 'say hi' }],
          }),
        });
      }
    } catch {
      // Warmup failed, continue anyway
    }

    console.log('  Running prompt...');

    // Build environment for run command
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      HOME: process.env.HOME || '/root',
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    };

    if (config.apiKey) {
      if (config.provider === 'openai') {
        env.OPENAI_API_KEY = config.apiKey;
      } else if (config.provider === 'google') {
        env.GOOGLE_GENERATIVE_AI_API_KEY = config.apiKey;
      } else {
        env.ANTHROPIC_API_KEY = config.apiKey;
      }
    }

    // Build run command args
    const model = config.model || getDefaultModel(config.provider || 'anthropic');
    const args = [
      'run',
      prompt,
      '--model', `${config.provider}/${model}`,
      '--attach', `http://localhost:${port}`,
      '--format', 'json',
    ];

    // Run opencode run with --attach
    const result = await new Promise<AgentResult>((resolve) => {
      const proc = spawn('opencode', args, {
        cwd: config.workDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Close stdin immediately to prevent TTY issues
      proc.stdin?.end();

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        resolve({
          success: false,
          output: stdout,
          error: `Failed to start OpenCode: ${error.message}`,
          exitCode: -1,
        });
      });

      proc.on('close', (code) => {
        const exitCode = code ?? 0;
        const success = exitCode === 0;

        if (!success) {
          console.log(`OpenCode exited with code ${exitCode}`);
          if (stderr) {
            console.log(`  stderr: ${stderr.slice(0, 500)}`);
          }
        }

        resolve({
          success,
          output: stdout,
          error: success ? undefined : (stderr || `Exit code ${exitCode}`),
          exitCode,
        });
      });

      // Set a timeout (10 minutes)
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({
          success: false,
          output: stdout,
          error: 'Agent execution timed out after 10 minutes',
          exitCode: -1,
        });
      }, 10 * 60 * 1000);

      proc.on('close', () => clearTimeout(timeout));
    });

    return result;

  } finally {
    // Clean up serve process
    if (serveProc) {
      serveProc.kill('SIGTERM');
    }
  }
}

/**
 * Parse OpenCode JSON output
 */
export function parseOpenCodeOutput(output: string): {
  success: boolean;
  toolCalls?: Array<{ tool: string; status: string }>;
  error?: string;
} {
  try {
    const lines = output.trim().split('\n');
    const toolCalls: Array<{ tool: string; status: string }> = [];
    let hasError = false;

    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line);

      if (event.type === 'tool_use' && event.part?.state) {
        toolCalls.push({
          tool: event.part.tool,
          status: event.part.state.status,
        });
      }

      if (event.type === 'error') {
        hasError = true;
      }
    }

    return {
      success: !hasError,
      toolCalls,
    };
  } catch {
    return {
      success: true,
    };
  }
}

/**
 * Check if OpenCode is installed
 */
export async function isOpenCodeInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('opencode', ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}
