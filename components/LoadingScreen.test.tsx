import React from 'react';
import TestRenderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineLoader, LoadingScreen, SectionLoader } from './LoadingScreen';

const render = (element: React.ReactElement) => TestRenderer.create(element).root;

const isLogo = (node: TestRenderer.ReactTestInstance) =>
  node.type === 'img' && node.props['data-pq-loader'] === 'logo';

describe('LoadingScreen (canonical app-level loader)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the ParQueen logo from a bundled asset inside a labelled status region', () => {
    const root = render(<LoadingScreen />);
    const status = root.find(node => node.props.role === 'status');
    expect(status.props['aria-label']).toBe('Loading ParQueen');
    expect(status.props['aria-live']).toBe('polite');
    expect(String(status.props.className)).toContain('pq-loading-screen');

    const logo = root.find(isLogo);
    expect(String(logo.props.src)).toMatch(/Parqueen_Logo/);
    // Bundled with the app: never a remote URL that could leave a blank frame.
    expect(String(logo.props.src)).not.toMatch(/^https?:/);
    expect(logo.props.width).toBe(160);
    expect(logo.props['aria-hidden']).toBe('true');
  });

  it('pulses (never spins), and only through the reduced-motion-aware class', () => {
    const logo = render(<LoadingScreen />).find(isLogo);
    expect(String(logo.props.className)).toContain('pq-brand-pulse');
    expect(String(logo.props.className)).not.toMatch(/animate-(spin|pulse)/);
  });

  it('keeps every loader on one shared pulse phase so hand-offs do not restart it', () => {
    vi.spyOn(performance, 'now').mockReturnValue(12_345);
    const logo = render(<LoadingScreen />).find(isLogo);
    expect(logo.props.style.animationDelay).toBe('-345ms');
    const inline = render(<InlineLoader />).find(node => node.props['data-pq-loader'] === 'inline');
    expect(inline.props.style.animationDelay).toBe('-345ms');
  });

  it('accepts a contextual label and overlay classes', () => {
    const status = render(<LoadingScreen label="Loading map" className="absolute inset-0" />)
      .find(node => node.props.role === 'status');
    expect(status.props['aria-label']).toBe('Loading map');
    expect(status.props.className).toBe('pq-loading-screen absolute inset-0');
  });
});

describe('SectionLoader', () => {
  it('shows a smaller logo with its caption in one status region', () => {
    const root = render(
      <SectionLoader size={48} className="gap-4 h-48">
        <p>Checking nearby activity…</p>
      </SectionLoader>,
    );
    const status = root.find(node => node.props.role === 'status');
    expect(status.props.className).toBe('flex flex-col items-center justify-center gap-4 h-48');
    expect(root.find(isLogo).props.width).toBe(48);
    expect(root.findByType('p').children).toEqual(['Checking nearby activity…']);
  });

  it('defaults to gap-3 and carries an accessible label when there is no caption', () => {
    const status = render(<SectionLoader label="Loading…" />).find(node => node.props.role === 'status');
    expect(status.props['aria-label']).toBe('Loading…');
    expect(status.props.className).toContain('gap-3');
  });
});

describe('InlineLoader', () => {
  const find = (root: TestRenderer.ReactTestInstance) =>
    root.find(node => node.props['data-pq-loader'] === 'inline');

  it('draws the ParQueen pin glyph in currentColor at control size', () => {
    const node = find(render(<InlineLoader size={18} className="text-white/50" />));
    expect(node.type).toBe('span');
    expect(String(node.props.style.maskImage)).toMatch(/Parqueen_Pin/);
    expect(String(node.props.style.WebkitMaskImage)).toMatch(/Parqueen_Pin/);
    expect(node.props.style.height).toBe(18);
    expect(node.props.style.width).toBe(16);
    expect(node.props.className).toContain('bg-current');
    expect(node.props.className).toContain('text-white/50');
    expect(node.props.className).toContain('pq-brand-pulse');
  });

  it('is decorative unless it is the only signal', () => {
    expect(find(render(<InlineLoader />)).props['aria-hidden']).toBe(true);
    const labelled = find(render(<InlineLoader label="Loading…" />));
    expect(labelled.props.role).toBe('status');
    expect(labelled.props['aria-label']).toBe('Loading…');
    expect(labelled.props['aria-hidden']).toBeUndefined();
  });
});
