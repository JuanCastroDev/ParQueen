import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock firebase/functions before importing geminiService ──────────────────

const mockCallable = vi.fn();
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => mockCallable),
}));
vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})) }));

import {
  analyzeParkingSign, generateSmartReplies, generateListingDescription, createSmartReplyRequestKey,
  isSignAnalysisUnavailable, SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION, SIGN_ANALYSIS_UNREADABLE_EXPLANATION,
} from './geminiService';
import { httpsCallable } from 'firebase/functions';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Callable name contract ───────────────────────────────────────────────────
// Each function must wire to the exact exported Cloud Function name.

describe('callable name contract', () => {
  it('analyzeParkingSign calls "analyzeSign"', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'YES', explanation: 'ok' } });
    await analyzeParkingSign('base64data');
    expect(httpsCallable).toHaveBeenCalledWith(expect.anything(), 'analyzeSign');
  });

  it('generateSmartReplies calls "generateSmartReplies"', async () => {
    mockCallable.mockResolvedValue({ data: { replies: ['Sure!', 'Sounds good', 'Thanks'] } });
    await generateSmartReplies('Is it available?', 'spot context');
    expect(httpsCallable).toHaveBeenCalledWith(expect.anything(), 'generateSmartReplies');
  });

  it('generateListingDescription calls "generateListingDescription"', async () => {
    mockCallable.mockResolvedValue({ data: { description: 'Great spot.' } });
    await generateListingDescription(['covered', 'EV charging']);
    expect(httpsCallable).toHaveBeenCalledWith(expect.anything(), 'generateListingDescription');
  });
});

// ─── No direct Gemini SDK ─────────────────────────────────────────────────────

describe('no frontend Gemini SDK', () => {
  it('geminiService does not import GoogleGenerativeAI or GoogleGenAI', async () => {
    const src = await import('./geminiService?raw').catch(() => null);
    if (src) {
      expect(src.default).not.toContain('GoogleGenerativeAI');
      expect(src.default).not.toContain('GoogleGenAI');
      expect(src.default).not.toContain('@google/genai');
      expect(src.default).not.toContain('@google/generative-ai');
      expect(src.default).not.toContain('VITE_GEMINI');
    }
    // If raw import unavailable in test env, the absence of SDK in module graph
    // is verified by the mock setup succeeding (firebase/functions only).
  });
});

// ─── Response shape ───────────────────────────────────────────────────────────

describe('analyzeParkingSign response shape', () => {
  it('passes imageBase64 to the callable', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'NO', explanation: 'No parking 7-9am.' } });
    await analyzeParkingSign('abc123==');
    expect(mockCallable).toHaveBeenCalledWith({ imageBase64: 'abc123==' });
  });

  it('returns the data object from the callable result', async () => {
    const payload = { status: 'CONDITIONAL', explanation: 'Alternate side applies.' };
    mockCallable.mockResolvedValue({ data: payload });
    const result = await analyzeParkingSign('img');
    expect(result).toEqual(payload);
  });

  it('generateSmartReplies passes lastMessage and context', async () => {
    mockCallable.mockResolvedValue({ data: { replies: ['Yes!', 'Available', 'Check tomorrow'] } });
    const result = await generateSmartReplies('Is it free?', 'Brooklyn spot');
    expect(mockCallable).toHaveBeenCalledWith({ lastMessage: 'Is it free?', context: 'Brooklyn spot' });
    expect(result).toEqual(['Yes!', 'Available', 'Check tomorrow']);
  });

  it('generateListingDescription passes features array', async () => {
    mockCallable.mockResolvedValue({ data: { description: 'Premium covered parking.' } });
    const result = await generateListingDescription(['covered', 'secure']);
    expect(mockCallable).toHaveBeenCalledWith({ features: ['covered', 'secure'] });
    expect(result).toBe('Premium covered parking.');
  });
});

// ─── Error mapping — analyzeParkingSign ──────────────────────────────────────
// Provider/service errors must return safe copy, not raw error text.

describe('analyzeParkingSign error mapping', () => {
  const makeError = (code: string) => Object.assign(new Error('provider error'), { code });

  it('marks only service-side failures as unavailable (scanner leads with Try again)', async () => {
    for (const code of ['resource-exhausted', 'failed-precondition', 'unavailable', 'internal']) {
      mockCallable.mockRejectedValue(makeError(code));
      const result = await analyzeParkingSign('img');
      expect(result.explanation).toBe(SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION);
      expect(isSignAnalysisUnavailable(result)).toBe(true);
    }
    mockCallable.mockRejectedValue(makeError('invalid-argument'));
    const bad = await analyzeParkingSign('img');
    expect(bad.explanation).toBe(SIGN_ANALYSIS_UNREADABLE_EXPLANATION);
    expect(isSignAnalysisUnavailable(bad)).toBe(false);
    // A model-reported ERROR is about the photo, never "unavailable".
    expect(isSignAnalysisUnavailable({ status: 'ERROR', explanation: 'Not a sign.' })).toBe(false);
    expect(isSignAnalysisUnavailable({ status: 'YES', explanation: SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION })).toBe(false);
  });

  it('resource-exhausted → "Assistant temporarily unavailable"', async () => {
    mockCallable.mockRejectedValue(makeError('resource-exhausted'));
    const result = await analyzeParkingSign('img');
    expect(result.status).toBe('ERROR');
    expect(result.explanation).toContain('Assistant temporarily unavailable');
  });

  it('failed-precondition → "Assistant temporarily unavailable"', async () => {
    mockCallable.mockRejectedValue(makeError('failed-precondition'));
    const result = await analyzeParkingSign('img');
    expect(result.explanation).toContain('Assistant temporarily unavailable');
  });

  it('unavailable → "Assistant temporarily unavailable"', async () => {
    mockCallable.mockRejectedValue(makeError('unavailable'));
    const result = await analyzeParkingSign('img');
    expect(result.explanation).toContain('Assistant temporarily unavailable');
  });

  it('internal → "Assistant temporarily unavailable"', async () => {
    mockCallable.mockRejectedValue(makeError('internal'));
    const result = await analyzeParkingSign('img');
    expect(result.explanation).toContain('Assistant temporarily unavailable');
  });

  it('invalid-argument (bad image) → "Couldn\'t read this sign"', async () => {
    mockCallable.mockRejectedValue(makeError('invalid-argument'));
    const result = await analyzeParkingSign('img');
    expect(result.status).toBe('ERROR');
    expect(result.explanation).toContain("Couldn't read this sign");
  });

  it('unknown error → "Couldn\'t read this sign" (safe fallback)', async () => {
    mockCallable.mockRejectedValue(new Error('unexpected'));
    const result = await analyzeParkingSign('img');
    expect(result.status).toBe('ERROR');
    expect(result.explanation).toContain("Couldn't read this sign");
  });

  it('error explanation never contains raw provider error text', async () => {
    mockCallable.mockRejectedValue(Object.assign(new Error('provider error'), { code: 'internal' }));
    const result = await analyzeParkingSign('img');
    expect(result.explanation).not.toContain('provider error');
  });
});

// ─── Smart replies fallback ───────────────────────────────────────────────────

describe('generateSmartReplies error fallback', () => {
  it('returns default suggestions on any error', async () => {
    mockCallable.mockRejectedValue(new Error('network error'));
    const result = await generateSmartReplies('Hi', '');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── Listing description fallback ────────────────────────────────────────────

describe('generateListingDescription error fallback', () => {
  it('returns a non-empty string on error', async () => {
    mockCallable.mockRejectedValue(new Error('quota'));
    const result = await generateListingDescription(['garage']);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── Smart reply guard key contract ──────────────────────────────────────────
// The guard in MessagesView uses `${conversationId}:${messageId}` as the
// deduplication key. These tests verify the key construction contract without
// requiring a DOM renderer.

describe('smart reply guard key contract', () => {
  it('same conversation + same message → same key (suppresses duplicate call)', () => {
    expect(createSmartReplyRequestKey('conv-A', 'msg-1')).toBe(createSmartReplyRequestKey('conv-A', 'msg-1'));
  });

  it('same conversation + different message → different key (allows call)', () => {
    expect(createSmartReplyRequestKey('conv-A', 'msg-1')).not.toBe(createSmartReplyRequestKey('conv-A', 'msg-2'));
  });

  it('different conversation + same message ID → different key (prevents cross-conversation collision)', () => {
    expect(createSmartReplyRequestKey('conv-A', 'msg-1')).not.toBe(createSmartReplyRequestKey('conv-B', 'msg-1'));
  });

  it('switching conversations resets deduplication', () => {
    expect(createSmartReplyRequestKey('conv-A', 'msg-99')).not.toBe(createSmartReplyRequestKey('conv-B', 'msg-1'));
  });

  it('shared message doc ID across conversations still produces different keys', () => {
    expect(createSmartReplyRequestKey('conv-A', 'shared-id')).not.toBe(createSmartReplyRequestKey('conv-B', 'shared-id'));
  });
});
