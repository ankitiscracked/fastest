export type CheckKind = 'install' | 'build' | 'typecheck' | 'test';

export interface CheckCommands {
  install?: string;
  build?: string;
  typecheck?: string;
  test?: string;
}

export interface CheckSelectionInput {
  packageJson?: {
    scripts?: Record<string, string>;
    packageManager?: string;
  };
  overrides?: CheckCommands;
}

function inferPackageManager(pkg?: { packageManager?: string }): 'npm' | 'pnpm' | 'yarn' {
  const declared = pkg?.packageManager?.toLowerCase() || '';
  if (declared.startsWith('pnpm')) return 'pnpm';
  if (declared.startsWith('yarn')) return 'yarn';
  return 'npm';
}

function buildRunCommand(pm: 'npm' | 'pnpm' | 'yarn', script: string): string {
  if (pm === 'yarn') return `yarn ${script}`;
  if (pm === 'pnpm') return `pnpm ${script}`;
  return `npm run ${script}`;
}

function pickScript(scripts: Record<string, string> | undefined, candidates: string[]): string | null {
  if (!scripts) return null;
  for (const candidate of candidates) {
    if (scripts[candidate]) return candidate;
  }
  return null;
}

export function selectCheckCommands(input: CheckSelectionInput): CheckCommands {
  const scripts = input.packageJson?.scripts || {};
  const pm = inferPackageManager(input.packageJson);

  const buildScript = pickScript(scripts, ['build', 'compile']);
  const typecheckScript = pickScript(scripts, ['typecheck', 'type-check', 'tsc', 'check:types', 'lint:types']);
  const testScript = pickScript(scripts, ['test', 'test:ci', 'ci:test', 'unit', 'unit:test']);

  const defaults: CheckCommands = {
    install: pm === 'yarn' ? 'yarn install' : pm === 'pnpm' ? 'pnpm install' : 'npm install',
    build: buildScript ? buildRunCommand(pm, buildScript) : undefined,
    typecheck: typecheckScript ? buildRunCommand(pm, typecheckScript) : undefined,
    test: testScript ? buildRunCommand(pm, testScript) : undefined,
  };

  return {
    ...defaults,
    ...(input.overrides || {}),
  };
}
