import type { Subprocess } from 'bun';

const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const log = {
  info: (msg: string) => console.log(`${colors.green('[INFO]')} ${msg}`),
  warn: (msg: string) => console.log(`${colors.yellow('[WARN]')} ${msg}`),
  error: (msg: string) => console.log(`${colors.red('[ERROR]')} ${msg}`),
};

function run(cmd: string[]): { success: boolean; stdout: string } {
  const result = Bun.spawnSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    success: result.exitCode === 0,
    stdout: result.stdout?.toString().trim() ?? '',
  };
}

function runQuiet(cmd: string[]): boolean {
  return Bun.spawnSync(cmd, { stdio: ['ignore', 'ignore', 'ignore'] }).exitCode === 0;
}

function isDockerRunning(): boolean {
  return runQuiet(['docker', 'info']);
}

function getDockerResources(): { cpus: number; memory: number } {
  const cpuResult = run(['docker', 'info', '--format', '{{.NCPU}}']);
  const memResult = run(['docker', 'info', '--format', '{{.MemTotal}}']);

  if (!cpuResult.success || !memResult.success) {
    return { cpus: 0, memory: 0 };
  }

  const cpus = parseInt(cpuResult.stdout, 10);
  const memory = Math.floor(parseInt(memResult.stdout, 10) / 1024 / 1024 / 1024);
  return { cpus, memory };
}

function cleanupContainers(): void {
  const result = run(['docker', 'ps', '-q', '--filter', 'ancestor=cloudflare-dev/sandbox']);
  if (result.success && result.stdout) {
    log.info('Stopping sandbox containers...');
    const ids = result.stdout.split('\n').filter(Boolean);
    for (const id of ids) {
      runQuiet(['docker', 'stop', id]);
      runQuiet(['docker', 'rm', id]);
    }
  }
}

function cleanupStaleContainers(): void {
  const result = run(['docker', 'ps', '-aq', '--filter', 'ancestor=cloudflare-dev/sandbox']);
  if (result.success && result.stdout) {
    log.info('Cleaning up stale containers...');
    const ids = result.stdout.split('\n').filter(Boolean);
    for (const id of ids) {
      runQuiet(['docker', 'rm', '-f', id]);
    }
  }
}

function isOpenCodeInstalled(): boolean {
  return runQuiet(['which', 'opencode']);
}

function isOpenCodeRunning(port: number): boolean {
  // Check if OpenCode server is responding
  const result = run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}/doc`]);
  return result.success && result.stdout === '200';
}

function loadDevVars(): Record<string, string> {
  // Read .dev.vars file and parse key=value pairs
  const devVarsPath = `${process.cwd()}/.dev.vars`;
  try {
    const content = require('fs').readFileSync(devVarsPath, 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        vars[key] = value;
      }
    }
    return vars;
  } catch {
    return {};
  }
}

async function startOpenCode(port: number): Promise<Subprocess | null> {
  if (!isOpenCodeInstalled()) {
    log.warn('OpenCode not installed. Install with: npm install -g opencode-ai');
    log.warn('Sandbox will not be able to run agent tasks without OpenCode.');
    return null;
  }

  // Check if already running
  if (isOpenCodeRunning(port)) {
    log.info(`OpenCode already running on port ${port}`);
    return null;
  }

  // Load API keys from .dev.vars
  const devVars = loadDevVars();
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Pass through LLM provider API keys
  const apiKeyVars = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ];

  for (const key of apiKeyVars) {
    if (devVars[key]) {
      env[key] = devVars[key];
      log.info(`Passing ${key} to OpenCode`);
    }
  }

  log.info('Starting OpenCode server...');
  const opencode = Bun.spawn(['opencode', 'serve', '--hostname', '0.0.0.0', '--port', port.toString()], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
    env,
  });

  // Wait for it to be ready (up to 30 seconds)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (isOpenCodeRunning(port)) {
      log.info(`OpenCode ready on port ${port}`);
      return opencode;
    }
  }

  log.error('OpenCode failed to start within 30 seconds');
  opencode.kill();
  return null;
}

const OPENCODE_PORT = 4096;

async function main() {
  // Check Docker is running (Docker Desktop) - optional, only needed for sandbox
  const dockerAvailable = isDockerRunning();

  if (!dockerAvailable) {
    log.warn('Docker is not running. Sandbox features will be unavailable.');
    log.warn('Start Docker Desktop if you need to run sandbox containers.');
  } else {
    const { cpus, memory } = getDockerResources();
    log.info(`Docker ready with ${cpus} CPUs and ${memory}GB RAM`);

    // Clean stale containers
    cleanupStaleContainers();
  }

  // Start OpenCode server (for Apple Silicon local dev)
  const opencode = await startOpenCode(OPENCODE_PORT);

  // Spawn wrangler dev with full stdio passthrough
  log.info('Starting wrangler dev...');
  const wrangler = Bun.spawn(['wrangler', 'dev'], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: process.cwd(),
  });

  // Cleanup handler
  const cleanup = () => {
    log.info('\nShutting down...');
    wrangler.kill();
    if (opencode) {
      log.info('Stopping OpenCode server...');
      opencode.kill();
    }
    if (dockerAvailable) {
      cleanupContainers();
    }
    log.info('Cleanup complete');
    process.exit(0);
  };

  // Handle signals
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Wait for wrangler to exit
  const exitCode = await wrangler.exited;
  log.info('\nWrangler exited');
  if (opencode) {
    opencode.kill();
  }
  if (dockerAvailable) {
    cleanupContainers();
  }
  log.info('Cleanup complete');
  process.exit(exitCode);
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
