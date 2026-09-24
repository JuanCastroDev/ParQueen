'use strict';

const { runProductRestrictionLookup } = require('./productRestrictionLookup');
const { logRestrictionEvent, RESTRICTION_EVENTS } = require('./productRestrictionModel');

const baseRow = {
  record_type: 'Current',
  sign_design_voided_on_date: null,
  borough: 'Manhattan',
  on_street: 'GOLD STREET',
  from_street: 'BEEKMAN STREET',
  to_street: 'ANN STREET',
  side_of_street: 'W',
  sign_description: 'NO STANDING MON-FRI 4PM-7PM <->',
};

const input = {
  parkingSide: 'West',
  streetContext: {
    borough: 'MANHATTAN',
    onStreet: 'Gold Street',
    crossStreetOne: 'Beekman Street',
    crossStreetTwo: 'Ann Street',
  },
};

function fetchRows(rows) {
  return async () => ({ ok: true, json: async () => rows });
}

describe('product restriction lookup', () => {
  it('H/I. matches a whole-face No Standing rule on the resolved side', async () => {
    const result = await runProductRestrictionLookup(input, { fetchFn: fetchRows([baseRow]), getSocrataToken: () => '' });
    expect(result.state).toBe('supported');
    expect(result.rules[0].type).toBe('noStanding');
    expect(JSON.stringify(result)).not.toMatch(/BEEKMAN|GOLD STREET|order_number|BFI/);
  });

  it('O. omits an opposite-side sign', async () => {
    const result = await runProductRestrictionLookup(input, {
      fetchFn: fetchRows([{ ...baseRow, side_of_street: 'E' }]),
    });
    expect(result.state).toBe('omitted');
    expect(result.event).toBe(RESTRICTION_EVENTS.NO_MATCH);
    expect(result.rules).toEqual([]);
  });

  it('P. omits single-arrow extent', async () => {
    const result = await runProductRestrictionLookup(input, {
      fetchFn: fetchRows([{ ...baseRow, sign_description: 'NO STANDING MON-FRI 4PM-7PM -->' }]),
    });
    expect(result.event).toBe(RESTRICTION_EVENTS.UNCERTAIN_EXTENT);
  });

  it('Q. ignores historical and voided rows', async () => {
    const result = await runProductRestrictionLookup(input, {
      fetchFn: fetchRows([
        { ...baseRow, record_type: 'Historical' },
        { ...baseRow, sign_design_voided_on_date: '2019-01-01T00:00:00' },
      ]),
    });
    expect(result.state).toBe('omitted');
  });

  it('S. lookup failure omits restrictions without throwing', async () => {
    const result = await runProductRestrictionLookup(input, {
      fetchFn: async () => { throw new Error('down'); },
    });
    expect(result.state).toBe('unavailable');
    expect(result.rules).toEqual([]);
  });

  it('AB. privacy logs stay aggregate-safe', () => {
    const lines = [];
    const payload = logRestrictionEvent({
      event: RESTRICTION_EVENTS.SUPPORTED,
      state: 'supported',
      reason: 'matched',
      ruleCount: 1,
      lat: 40.7,
      uid: 'u',
    }, line => lines.push(line));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe(RESTRICTION_EVENTS.SUPPORTED);
    expect(payload.lat).toBeUndefined();
    expect(payload.uid).toBeUndefined();
  });

  it('AC. issues one bounded query without retry', async () => {
    let calls = 0;
    await runProductRestrictionLookup(input, {
      fetchFn: async () => {
        calls += 1;
        return { ok: true, json: async () => [baseRow] };
      },
    });
    expect(calls).toBe(1);
  });
});
