'use strict';

const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');

const SERVICE_URL = 'https://parqueen-curb-resolver-spike-oxbozdhlwa-uc.a.run.app';
const VALID_TUPLE = Object.freeze({
  borough: 'MANHATTAN', onStreet: 'GOLD STREET', crossStreetOne: 'BEEKMAN STREET',
  crossStreetTwo: 'ANN STREET', compassDirection: 'W', // mocked sample matches reviewed live Gold/W resolver fixture
});
const VALID_SUCCESS = Object.freeze({
  ok: true,
  officialBlockFaceId: '0212261301',
  normalizedStreetNames: {
    onStreet: 'GOLD STREET', crossStreetOne: 'BEEKMAN STREET', crossStreetTwo: 'ANN STREET',
  },
  returnCode: '00',
  reasonCode: ' ',
  sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
});

const response = (status, body) => ({
  status,
  text: async () => typeof body === 'string' ? body : JSON.stringify(body),
});

function harness(overrides = {}) {
  const getIdToken = overrides.getIdToken || vi.fn(async () => 'short-lived-id-token');
  const transport = overrides.transport || vi.fn(async () => response(200, VALID_SUCCESS));
  const resolver = createPrivateBlockfaceResolver({
    mode: 'shadow', serviceUrl: SERVICE_URL, getIdToken, transport,
  });
  return { resolver, getIdToken, transport };
}

describe('private blockface resolver request contract', () => {
  it('sends one authenticated request using the service URL as the audience', async () => {
    const { resolver, getIdToken, transport } = harness();

    await expect(resolver.resolve(VALID_TUPLE)).resolves.toEqual(VALID_SUCCESS);
    expect(getIdToken).toHaveBeenCalledOnce();
    expect(getIdToken).toHaveBeenCalledWith(SERVICE_URL);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith({
      url: `${SERVICE_URL}/resolve-blockface`, method: 'POST',
      headers: { Authorization: 'Bearer short-lived-id-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_TUPLE), signal: undefined,
    });
  });

  it.each([
    ['invalid borough', { ...VALID_TUPLE, borough: 'MN' }],
    ['invalid direction', { ...VALID_TUPLE, compassDirection: 'North' }],
    ['blank street', { ...VALID_TUPLE, onStreet: '' }],
    ['padded street', { ...VALID_TUPLE, onStreet: ' GOLD STREET' }],
    ['NUL', { ...VALID_TUPLE, onStreet: 'GOLD\x00STREET' }],
    ['newline', { ...VALID_TUPLE, onStreet: 'GOLD\nSTREET' }],
    ['carriage return', { ...VALID_TUPLE, onStreet: 'GOLD\rSTREET' }],
    ['tab', { ...VALID_TUPLE, onStreet: 'GOLD\tSTREET' }],
    ['DEL', { ...VALID_TUPLE, onStreet: 'GOLD\x7fSTREET' }],
    ['non-ASCII', { ...VALID_TUPLE, onStreet: 'CAFÉ STREET' }],
    ['over 32 bytes', { ...VALID_TUPLE, onStreet: 'A'.repeat(33) }],
    ['missing field', { borough: 'MANHATTAN' }],
    ['unexpected field', { ...VALID_TUPLE, officialBlockFaceId: '0212261301' }],
  ])('rejects %s without authentication or transport', async (_label, tuple) => {
    const { resolver, getIdToken, transport } = harness();

    await expect(resolver.resolve(tuple)).resolves.toEqual({ ok: false, failureClass: 'INVALID_REQUEST' });
    expect(getIdToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('passes the parent AbortSignal without serializing it', async () => {
    const controller = new AbortController();
    const { resolver, transport } = harness();
    await resolver.resolve({ ...VALID_TUPLE, signal: controller.signal });
    const request = transport.mock.calls[0][0];
    expect(request.signal).toBe(controller.signal);
    expect(JSON.parse(request.body)).toEqual(VALID_TUPLE);
  });
});

describe('private blockface resolver response contract', () => {
  it('accepts the reviewed authoritative response without coercion', async () => {
    const { resolver } = harness();
    await expect(resolver.resolve(VALID_TUPLE)).resolves.toEqual(VALID_SUCCESS);
  });

  it.each([
    ['short BFI', { ...VALID_SUCCESS, officialBlockFaceId: '123' }],
    ['all-zero BFI', { ...VALID_SUCCESS, officialBlockFaceId: '0000000000' }],
    ['numeric BFI', { ...VALID_SUCCESS, officialBlockFaceId: 212261301 }],
    ['missing BFI', { ...VALID_SUCCESS, officialBlockFaceId: undefined }],
    ['non-00 return code', { ...VALID_SUCCESS, returnCode: '01' }],
    ['padded normalized name', { ...VALID_SUCCESS,
      normalizedStreetNames: { ...VALID_SUCCESS.normalizedStreetNames, onStreet: ' GOLD STREET' } }],
    ['control character in normalized name', { ...VALID_SUCCESS,
      normalizedStreetNames: { ...VALID_SUCCESS.normalizedStreetNames, onStreet: 'GOLD\nSTREET' } }],
    ['overlong normalized name', { ...VALID_SUCCESS,
      normalizedStreetNames: { ...VALID_SUCCESS.normalizedStreetNames, onStreet: 'A'.repeat(33) } }],
    ['missing source version', { ...VALID_SUCCESS, sourceVersion: undefined }],
    ['unexpected success field', { ...VALID_SUCCESS, providerMessage: 'raw detail' }],
  ])('fails closed for %s', async (_label, body) => {
    const { resolver } = harness({ transport: vi.fn(async () => response(200, body)) });
    await expect(resolver.resolve(VALID_TUPLE)).resolves.toEqual({ ok: false, failureClass: 'INVALID_RESPONSE' });
  });

  it('preserves only reviewed safe-rejection fields and discards identity-looking data', async () => {
    const body = { ok: false, returnCode: '44', reasonCode: ' ', failureClass: 'NOT_AUTHORITATIVE',
      officialBlockFaceId: '0212261301', normalizedStreetNames: VALID_SUCCESS.normalizedStreetNames };
    const { resolver } = harness({ transport: vi.fn(async () => response(200, body)) });
    await expect(resolver.resolve(VALID_TUPLE)).resolves.toEqual({
      ok: false, returnCode: '44', reasonCode: ' ', failureClass: 'NOT_AUTHORITATIVE',
    });
  });
});

describe('private blockface resolver failure behavior', () => {
  it.each([
    [400, 'INVALID_REQUEST'], [401, 'AUTHENTICATION_FAILURE'], [403, 'AUTHENTICATION_FAILURE'],
    [404, 'ROUTING_FAILURE'], [429, 'SATURATED'], [503, 'UPSTREAM_UNAVAILABLE'],
    [500, 'UPSTREAM_UNAVAILABLE'],
  ])('maps HTTP %i to %s without retry', async (status, failureClass) => {
    const transport = vi.fn(async () => response(status, { sensitive: 'ignored' }));
    const { resolver } = harness({ transport });
    await expect(resolver.resolve(VALID_TUPLE)).resolves.toEqual({ ok: false, failureClass });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    ['timeout', Object.assign(new Error('secret timeout body'), { name: 'TimeoutError' }), 'TIMEOUT'],
    ['abort', Object.assign(new Error('secret abort body'), { name: 'AbortError' }), 'ABORTED'],
    ['connection failure', new Error('secret connection body'), 'UPSTREAM_UNAVAILABLE'],
  ])('maps %s without retry', async (_label, error, failureClass) => {
    const transport = vi.fn(async () => { throw error; });
    const { resolver } = harness({ transport });
    await expect(resolver.resolve(VALID_TUPLE)).resolves.toEqual({ ok: false, failureClass });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('maps token acquisition failure without making a transport call', async () => {
    const getIdToken = vi.fn(async () => { throw new Error('secret credential body'); });
    const { resolver, transport } = harness({ getIdToken });
    await expect(resolver.resolve(VALID_TUPLE)).resolves.toEqual({
      ok: false, failureClass: 'AUTHENTICATION_FAILURE',
    });
    expect(getIdToken).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not start transport when the parent aborts during token acquisition', async () => {
    const controller = new AbortController();
    let releaseToken;
    const getIdToken = vi.fn(() => new Promise(resolve => { releaseToken = resolve; }));
    const { resolver, transport } = harness({ getIdToken });

    const pending = resolver.resolve({ ...VALID_TUPLE, signal: controller.signal });
    controller.abort();
    releaseToken('short-lived-id-token');

    await expect(pending).resolves.toEqual({ ok: false, failureClass: 'ABORTED' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails closed on invalid JSON without retry', async () => {
    const transport = vi.fn(async () => response(200, '<html>not json</html>'));
    const { resolver } = harness({ transport });
    await expect(resolver.resolve(VALID_TUPLE)).resolves.toEqual({ ok: false, failureClass: 'INVALID_RESPONSE' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('emits no sensitive diagnostics on failure', async () => {
    const spies = ['log', 'warn', 'error'].map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    const transport = vi.fn(async () => {
      throw new Error(`token-for ${VALID_TUPLE.onStreet} ${VALID_SUCCESS.officialBlockFaceId}`);
    });
    const { resolver } = harness({ transport });
    await resolver.resolve(VALID_TUPLE);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    spies.forEach(spy => spy.mockRestore());
  });
});

describe('private blockface resolver request scope', () => {
  it('deduplicates identical tuples within one resolver instance', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const transport = vi.fn(async () => { await pending; return response(200, VALID_SUCCESS); });
    const { resolver, getIdToken } = harness({ transport });
    const first = resolver.resolve(VALID_TUPLE);
    const second = resolver.resolve({ ...VALID_TUPLE });
    release();
    await Promise.all([first, second]);
    expect(getIdToken).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not deduplicate distinct tuples', async () => {
    const { resolver, transport } = harness();
    await Promise.all([resolver.resolve(VALID_TUPLE), resolver.resolve({ ...VALID_TUPLE, compassDirection: 'E' })]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('defaults to off with zero authentication or transport activity', async () => {
    const getIdToken = vi.fn(async () => 'must-not-run');
    const transport = vi.fn(async () => response(200, VALID_SUCCESS));
    const resolver = createPrivateBlockfaceResolver({ serviceUrl: SERVICE_URL, getIdToken, transport });
    await expect(resolver.resolve(VALID_TUPLE)).resolves.toEqual({ ok: false, failureClass: 'DISABLED' });
    expect(getIdToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
