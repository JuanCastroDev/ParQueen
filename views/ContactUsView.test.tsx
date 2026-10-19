import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => { store.set(key, String(value)); },
            removeItem: (key: string) => { store.delete(key); },
            clear: () => { store.clear(); },
        },
    });
});

import en from '../i18n/en';
import es from '../i18n/es';
import { setLang } from '../i18n';
import { ContactUsView } from './ContactUsView';

const textOf = (node: any): string => typeof node === 'string'
    ? node
    : (node?.children ?? []).map(textOf).join('');

function renderContactUs(onBack = vi.fn()) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
        renderer = TestRenderer.create(<ContactUsView onBack={onBack} />);
    });
    return { renderer, onBack };
}

beforeEach(() => setLang('en'));
afterEach(() => setLang('en'));

describe('ContactUsView', () => {
    it('renders the English heading and support description', () => {
        const { renderer } = renderContactUs();

        expect(textOf(renderer.root.findByType('h1'))).toBe('Contact Us');
        expect(textOf(renderer.toJSON())).toContain("Have questions, feedback, or need support? We'd love to hear from you.");

        act(() => renderer.unmount());
    });

    it('renders the Spanish heading and support description', () => {
        setLang('es');
        const { renderer } = renderContactUs();

        expect(textOf(renderer.root.findByType('h1'))).toBe('Contáctanos');
        expect(textOf(renderer.toJSON())).toContain('¿Tienes preguntas, comentarios o necesitas ayuda? Nos encantará saber de ti.');

        act(() => renderer.unmount());
    });

    it('updates all Contact Us copy when the language changes while mounted', () => {
        const { renderer } = renderContactUs();
        expect(textOf(renderer.toJSON())).toContain('Email us');

        act(() => setLang('es'));

        const text = textOf(renderer.toJSON());
        expect(text).toContain('Contáctanos');
        expect(text).toContain('Envíanos un correo');
        expect(text).toContain('Visita nuestro sitio web');
        expect(renderer.root.findByProps({ 'aria-label': 'Atrás' })).toBeDefined();

        act(() => renderer.unmount());
    });

    it('uses full-row, named native links with 44px touch targets and exact destinations', () => {
        const { renderer } = renderContactUs();
        const links = renderer.root.findAllByType('a');

        expect(links).toHaveLength(2);
        expect(links[0].props.href).toBe('mailto:hello@parqueen.app');
        expect(links[0].props['aria-label']).toBe('Email us: hello@parqueen.app');
        expect(links[1].props.href).toBe('https://parqueen.app/');
        expect(links[1].props.target).toBe('_blank');
        expect(links[1].props.rel).toBe('noopener noreferrer');
        expect(links[1].props['aria-label']).toBe('Visit our website: parqueen.app');

        for (const link of links) {
            expect(link.props.className).toContain('flex');
            expect(link.props.className).toContain('w-full');
            expect(link.props.className).toContain('min-h-11');
            expect(link.props.className).toContain('focus-visible:ring-2');
            expect(link.findAllByType('svg')).toHaveLength(1);
            expect(link.findByType('svg').props['aria-hidden']).toBe('true');
        }

        act(() => renderer.unmount());
    });

    it('preserves the localized Back control and callback', () => {
        const onBack = vi.fn();
        const { renderer } = renderContactUs(onBack);

        act(() => renderer.root.findByProps({ 'aria-label': 'Back' }).props.onClick());
        expect(onBack).toHaveBeenCalledTimes(1);

        act(() => renderer.unmount());
    });
});

describe('Contact Us translation parity', () => {
    const keys = ['profile.contact_us', 'profile.back_aria', 'contact.intro', 'contact.email_us', 'contact.website'] as const;

    it.each(keys)('%s resolves to nonempty English and Spanish copy', key => {
        expect(en[key]?.trim()).toBeTruthy();
        expect(es[key]?.trim()).toBeTruthy();
        expect(en[key]).not.toBe(key);
        expect(es[key]).not.toBe(key);
    });
});
