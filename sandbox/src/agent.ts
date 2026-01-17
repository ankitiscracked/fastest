/**
 * Agent execution - run OpenCode or other agents
 */

import { spawn } from 'child_process';

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
 * Run OpenCode with a prompt
 */
export async function runOpenCode(
  prompt: string,
  config: AgentConfig
): Promise<AgentResult> {
  const args = [
    '-p', prompt,           // Non-interactive prompt mode
    '-f', 'json',           // JSON output format
    '-q',                   // Quiet mode (no spinner)
    '-c', config.workDir,   // Working directory
  ];

  // Add max steps if specified
  if (config.maxSteps) {
    args.push('--max-steps', config.maxSteps.toString());
  }

  // Build environment with API keys
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
      env.GOOGLE_API_KEY = config.apiKey;
    } else {
      // Default to Anthropic
      env.ANTHROPIC_API_KEY = config.apiKey;
    }
  }

  console.log(`Running OpenCode with prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
  console.log(`  Working directory: ${config.workDir}`);

  return new Promise((resolve) => {
    const proc = spawn('opencode', args, {
      cwd: config.workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
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

    // Set a timeout (10 minutes by default)
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
}

/**
 * Parse OpenCode JSON output
 */
export function parseOpenCodeOutput(output: string): {
  success: boolean;
  messages?: Array<{ role: string; content: string }>;
  error?: string;
} {
  try {
    // OpenCode outputs JSON when using -f json
    const result = JSON.parse(output);
    return {
      success: true,
      messages: result.messages || [],
    };
  } catch {
    // If not valid JSON, treat as plain text output
    return {
      success: true,
      messages: [{ role: 'assistant', content: output }],
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
