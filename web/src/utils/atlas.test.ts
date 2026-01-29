import { describe, expect, it } from 'bun:test';
import type { Manifest } from '@fastest/shared';
import { deriveAtlasData } from './atlas';

describe('deriveAtlasData', () => {
  it('derives systems, modules, and code concepts from a manifest', () => {
    const manifest: Manifest = {
      version: '1',
      files: [
        { path: 'src/index.ts', hash: 'a', size: 10, mode: 0o644 },
        { path: 'src/utils/helpers.ts', hash: 'b', size: 20, mode: 0o644 },
        { path: 'lib/service.ts', hash: 'c', size: 30, mode: 0o644 },
        { path: 'node_modules/react/index.js', hash: 'd', size: 40, mode: 0o644 },
      ],
    };

    const data = deriveAtlasData(manifest);

    const systemNames = data.conceptsByLayer.system.map(c => c.name);
    const moduleNames = data.conceptsByLayer.module.map(c => c.name);
    const codeNames = data.conceptsByLayer.code.map(c => c.name);

    expect(systemNames).toContain('src');
    expect(systemNames).toContain('lib');
    expect(systemNames).not.toContain('node_modules');

    expect(moduleNames).toContain('src');
    expect(moduleNames).toContain('src/utils');
    expect(moduleNames).toContain('lib');

    expect(codeNames).toContain('index.ts');
    expect(codeNames).toContain('helpers.ts');
    expect(codeNames).toContain('service.ts');
  });
});
