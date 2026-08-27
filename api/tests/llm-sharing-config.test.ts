import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config.js';

describe('shared LLM configuration', () => {
  it('defaults the shared monthly cap to one dollar', () => {
    const loaded = loadEnv({
      JWT_SECRET: 'test-jwt-secret-which-is-long-enough',
      DATABASE_URL: 'postgresql://localhost/weltbon',
    });
    expect(loaded.sharedLlmMonthlyCostUsd).toBe(1);
  });

  it.each(['0', '-1', 'NaN', 'Infinity'])('rejects an unsafe shared cap: %s', (value) => {
    expect(() => loadEnv({
      JWT_SECRET: 'test-jwt-secret-which-is-long-enough',
      DATABASE_URL: 'postgresql://localhost/weltbon',
      SHARED_LLM_MONTHLY_COST_USD: value,
    })).toThrow('SHARED_LLM_MONTHLY_COST_USD');
  });
});
