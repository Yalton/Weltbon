import { afterEach, describe, expect, it } from 'vitest';
import { _resetEnvForTests } from '../src/config.js';

describe('GET /api/runtime', () => {
  const original = process.env.WELTBON_LOCAL_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.WELTBON_LOCAL_MODE;
    else process.env.WELTBON_LOCAL_MODE = original;
    _resetEnvForTests();
  });

  it.each([
    ['0', 'server', true],
    ['1', 'local', false],
  ] as const)('reports %s as %s mode without auth', async (value, authMode, inviteRequestsEnabled) => {
    process.env.WELTBON_LOCAL_MODE = value;
    _resetEnvForTests();
    const { createApp } = await import('../src/index.js');
    const response = await createApp().request('/api/runtime');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authMode,
      landing: { inviteRequestsEnabled, repoUrl: 'https://github.com/Citreum-LLC/Weltbon' },
    });
  });
});
