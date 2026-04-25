import { describe, it } from 'vitest';

// Wave 0 stub for the export DropdownMenu — implementation lands in plan 04-05.
// Filled tests will mount the component, click each item, and assert fetch()
// was invoked with the right format query plus auth header.

describe.skip('ExportMenu renders 4 items: JSON, Markdown ZIP, PDF, DOCX', () => {
  it('placeholder', () => {
    // TODO plan 04-05
  });
});

describe.skip('clicking each item triggers fetch /universes/:uid/export?format={X} with auth header', () => {
  it('placeholder', () => {
    // TODO plan 04-05
  });
});

describe.skip('spinner appears on the clicked item only; other items remain enabled', () => {
  it('placeholder', () => {
    // TODO plan 04-05
  });
});

describe.skip('failure shows toast "Export failed"; success closes menu', () => {
  it('placeholder', () => {
    // TODO plan 04-05
  });
});
