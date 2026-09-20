'use strict';

const { createMinimumShadowSources } = require('./minimumShadowSources');

describe('minimum shadow source composition', () => {
  it('constructs fresh request-scoped CSCL/DOT/sink adapters without eager auth or network activity', () => {
    const fetchFn = vi.fn();
    const getSocrataToken = vi.fn();
    const logger = { info: vi.fn() };
    const input = {
      dotEvidence: {
        complete: true,
        selectedRows: [],
        sourceVersion: {
          resourceId: 'nfid-uabd', rowsUpdatedAt: '2026-01-01T00:00:00.000Z',
          viewLastModified: '2026-01-02T00:00:00.000Z',
        },
      },
    };

    const first = createMinimumShadowSources(input, { fetchFn, getSocrataToken, logger });
    const second = createMinimumShadowSources(input, { fetchFn, getSocrataToken, logger });

    expect(first).not.toBe(second);
    expect(first.candidateStore).not.toBe(second.candidateStore);
    expect(first.dotSource).not.toBe(second.dotSource);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(getSocrataToken).not.toHaveBeenCalled();
  });
});
