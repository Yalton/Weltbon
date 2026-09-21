import { describe, it } from 'vitest';


// Once filled in, these suites switch to `describe.skipIf(!process.env.RUN_PERF)`
// so CI doesn't pay the 60s+ PDF cost on every run.
const RUN_PERF = Boolean(process.env.RUN_PERF);
void RUN_PERF;

describe.skip('perf: 220-entry seedLargeUniverse — markdown ZIP completes in <5s', () => {
  it('placeholder', () => {

  });
});

describe.skip('perf: 220-entry seedLargeUniverse — PDF completes in <60s', () => {
  it('placeholder', () => {

  });
});

describe.skip('perf: 220-entry seedLargeUniverse — DOCX completes in <10s', () => {
  it('placeholder', () => {

  });
});
