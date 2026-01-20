const COLIMA_CPU = 4;
const COLIMA_MEMORY = 8;

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

function runInherit(cmd: string[]): void {
  Bun.spawnSync(cmd, { stdio: ['inherit', 'inherit', 'inherit'] });
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

function startColima(): void {
  log.info(`Starting Colima with ${COLIMA_CPU} CPUs and ${COLIMA_MEMORY}GB RAM...`);
  runInherit(['colima', 'start', '--cpu', String(COLIMA_CPU), '--memory', String(COLIMA_MEMORY)]);
}

function stopColima(): void {
  runQuiet(['colima', 'stop']);
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

function isAppleSilicon(): boolean {
  const result = run(['uname', '-m']);
  return result.success && result.stdout === 'arm64';
}

function canRunAmd64Containers(): boolean {
  // Test if we can run a simple amd64 container
  const result = Bun.spawnSync(
    ['docker', 'run', '--rm', '--platform', 'linux/amd64', 'alpine:latest', 'echo', 'ok'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return result.exitCode === 0 && result.stdout?.toString().trim() === 'ok';
}

function setupQemuEmulation(): void {
  log.info('Setting up QEMU emulation for amd64 containers...');
  // Register QEMU binfmt handlers for cross-platform execution
  runInherit([
    'docker', 'run', '--rm', '--privileged',
    'tonistiigi/binfmt:latest',
    '--install', 'amd64'
  ]);
}

async function main() {
  // Setup Docker/Colima
  if (!isDockerRunning()) {
    startColima();
  } else {
    log.info('Docker is already running');

    const { cpus, memory } = getDockerResources();
    if (cpus < COLIMA_CPU || memory < COLIMA_MEMORY) {
      log.warn(`Current resources (${cpus} CPUs, ${memory}GB) below recommended (${COLIMA_CPU} CPUs, ${COLIMA_MEMORY}GB)`);
      log.info('Restarting Colima with more resources...');
      stopColima();
      startColima();
    }
  }

  // Clean stale containers
  cleanupStaleContainers();

  // Verify Docker is ready
  if (!isDockerRunning()) {
    log.error('Docker failed to start');
    process.exit(1);
  }

  const { cpus, memory } = getDockerResources();
  log.info(`Docker ready with ${cpus} CPUs and ${memory}GB RAM`);

  // On Apple Silicon, ensure we can run amd64 containers (sandbox image is amd64-only)
  if (isAppleSilicon()) {
    log.info('Apple Silicon detected, checking amd64 container support...');
    if (!canRunAmd64Containers()) {
      log.warn('Cannot run amd64 containers, setting up QEMU emulation...');
      setupQemuEmulation();
      if (!canRunAmd64Containers()) {
        log.error('Failed to set up amd64 container support. The sandbox requires amd64 containers.');
        process.exit(1);
      }
    }
    log.info('amd64 container support verified');
  }

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
    cleanupContainers();
    log.info('Stopping Colima...');
    stopColima();
    log.info('Cleanup complete');
    process.exit(0);
  };

  // Handle signals
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Wait for wrangler to exit
  const exitCode = await wrangler.exited;
  log.info('\nWrangler exited');
  cleanupContainers();
  log.info('Stopping Colima...');
  stopColima();
  log.info('Cleanup complete');
  process.exit(exitCode);
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
