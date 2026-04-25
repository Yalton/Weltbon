import { describe, it } from 'vitest';

// Wave 0 stub for the 220-entry perf budget — implementation lands in plan 04-05.
// Once filled in, these suites switch to `describe.skipIf(!process.env.RUN_PERF)`
// so CI doesn't pay the 60s+ PDF cost on every run.
const RUN_PERF = Boolean(process.env.RUN_PERF);
void RUN_PERF;

describe.skip('perf: 220-entry seedLargeUniverse — markdown ZIP completes in <5s', () => {
  it('placeholder', () => {
    // TODO plan 04-05
  });
});

describe.skip('perf: 220-entry seedLargeUniverse — PDF completes in <60s', () => {
  it('placeholder', () => {
    // TODO plan 04-05
  });
});

describe.skip('perf: 220-entry seedLargeUniverse — DOCX completes in <10s', () => {
  it('placeholder', () => {
    // TODO plan 04-05
  });
});
