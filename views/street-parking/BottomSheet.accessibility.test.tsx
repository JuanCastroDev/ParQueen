import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './BottomSheet';
import { AccessibleModal } from '../../components/AccessibleModal';

type Handler = (event: any) => void;

class FakeElement {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  disabled = false;
  inert = false;
  isConnected = true;
  tabIndex = -1;
  focus = vi.fn(() => { (globalThis.document as any).activeElement = this; });

  constructor(public readonly name: string, private focusables: FakeElement[] = []) {}

  contains(target: unknown) {
    return target === this || this.focusables.includes(target as FakeElement) || this.children.some(child => child.contains(target));
  }

  querySelectorAll() {
    return this.focusables;
  }

  querySelector() {
    return this.focusables[0] ?? null;
  }

  getAttribute(name: string) {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === 'inert') this.inert = true;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === 'inert') this.inert = false;
  }

  closest(selector: string) {
    let node: FakeElement | null = this;
    while (node) {
      if (selector === '[inert]' && (node.inert || node.hasAttribute('inert'))) return node;
      node = node.parentElement;
    }
    return null;
  }

  matches() {
    return this.isConnected && !this.disabled && !this.inert && this.tabIndex >= 0;
  }
}

function modalHarness() {
  const listeners = new Map<string, Set<Handler>>();
  let mutationCallback: ((records: Array<{ addedNodes: FakeElement[] }>) => void) | undefined;
  const first = new FakeElement('first');
  const last = new FakeElement('last');
  const opener = new FakeElement('opener');
  const fallback = new FakeElement('fallback');
  first.tabIndex = 0;
  last.tabIndex = 0;
  opener.tabIndex = 0;
  fallback.tabIndex = 0;
  const page = new FakeElement('page', [opener, fallback]);
  const preIsolated = new FakeElement('pre-isolated');
  preIsolated.attributes.set('inert', 'legacy-state');
  preIsolated.inert = true;
  preIsolated.attributes.set('aria-hidden', 'false');
  const modalRoot = new FakeElement('modal-root');
  modalRoot.attributes.set('data-modal-root', '');
  const appRoot = new FakeElement('app-root');
  const dialog = new FakeElement('dialog', [first, last]);

  appRoot.children = [page, preIsolated, modalRoot];
  for (const child of appRoot.children) child.parentElement = appRoot;
  dialog.parentElement = modalRoot;
  modalRoot.children = [dialog];

  const eventTarget = {
    addEventListener: (type: string, listener: Handler) => {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(listener);
      listeners.set(type, handlers);
    },
    removeEventListener: (type: string, listener: Handler) => listeners.get(type)?.delete(listener),
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: eventTarget });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { ...eventTarget, activeElement: opener, querySelector: () => null },
  });
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    value: class {
      constructor(callback: (records: Array<{ addedNodes: FakeElement[] }>) => void) {
        mutationCallback = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  (globalThis as any).requestAnimationFrame = (callback: () => void) => { callback(); return 0; };
  (globalThis as any).cancelAnimationFrame = () => {};

  const dispatchKey = (key: string, shiftKey = false) => {
    const event = { key, shiftKey, preventDefault: vi.fn() };
    listeners.get('keydown')?.forEach(listener => listener(event));
    return event;
  };

  const addBackgroundSibling = (element: FakeElement) => {
    element.parentElement = appRoot;
    appRoot.children.splice(appRoot.children.length - 1, 0, element);
    mutationCallback?.([{ addedNodes: [element] }]);
  };

  return { dialog, first, last, opener, fallback, page, preIsolated, modalRoot, dispatchKey, addBackgroundSibling };
}

describe('BottomSheet shared modal accessibility contract', () => {
  beforeEach(() => vi.useFakeTimers());

  it('moves focus inside and traps Tab even when focus starts outside', () => {
    const harness = modalHarness();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details">
          <button>First</button><button>Last</button>
        </BottomSheet>,
        { createNodeMock: element => element.props.role === 'dialog' ? harness.dialog : null },
      );
    });

    expect(harness.first.focus).toHaveBeenCalledTimes(1);
    (globalThis.document as any).activeElement = harness.opener;
    const tab = harness.dispatchKey('Tab');
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(harness.first.focus).toHaveBeenCalledTimes(2);

    act(() => renderer!.unmount());
  });

  it('restores each background sibling’s exact pre-existing inert and aria-hidden state', () => {
    const harness = modalHarness();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details"><button>Done</button></BottomSheet>,
        { createNodeMock: element => element.props.role === 'dialog' ? harness.dialog : null },
      );
    });

    expect(harness.page.inert).toBe(true);
    expect(harness.page.getAttribute('aria-hidden')).toBe('true');
    expect(harness.preIsolated.inert).toBe(true);
    expect(harness.preIsolated.getAttribute('aria-hidden')).toBe('true');

    act(() => renderer!.unmount());
    expect(harness.page.hasAttribute('inert')).toBe(false);
    expect(harness.page.hasAttribute('aria-hidden')).toBe(false);
    expect(harness.preIsolated.getAttribute('inert')).toBe('legacy-state');
    expect(harness.preIsolated.inert).toBe(true);
    expect(harness.preIsolated.getAttribute('aria-hidden')).toBe('false');
  });

  it('returns focus safely, falling back when the opener was removed or disabled', () => {
    const harness = modalHarness();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details"><button>Done</button></BottomSheet>,
        { createNodeMock: element => element.props.role === 'dialog' ? harness.dialog : null },
      );
    });

    harness.opener.disabled = true;
    harness.opener.isConnected = false;
    expect(() => act(() => renderer!.unmount())).not.toThrow();
    expect(harness.opener.focus).not.toHaveBeenCalled();
    expect(harness.fallback.focus).toHaveBeenCalledTimes(1);
    expect((globalThis.document as any).activeElement).toBe(harness.fallback);
  });

  it('repairs focus when an in-progress state disables or removes the active control', () => {
    const harness = modalHarness();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details"><button>Action</button></BottomSheet>,
        { createNodeMock: element => element.props.role === 'dialog' ? harness.dialog : null },
      );
    });
    expect((globalThis.document as any).activeElement).toBe(harness.first);

    harness.first.disabled = true;
    act(() => {
      renderer!.update(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details"><button>Working</button></BottomSheet>,
      );
    });

    expect(harness.last.focus).toHaveBeenCalledTimes(1);
    expect((globalThis.document as any).activeElement).toBe(harness.last);
    act(() => renderer!.unmount());
  });

  it('isolates and exactly restores an interactive background sibling mounted after open', () => {
    const harness = modalHarness();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details"><button>Action</button></BottomSheet>,
        { createNodeMock: element => element.props.role === 'dialog' ? harness.dialog : null },
      );
    });

    const lateToast = new FakeElement('foreground notification toast');
    lateToast.attributes.set('aria-hidden', 'false');
    act(() => harness.addBackgroundSibling(lateToast));
    expect(lateToast.inert).toBe(true);
    expect(lateToast.getAttribute('aria-hidden')).toBe('true');

    act(() => renderer!.unmount());
    expect(lateToast.hasAttribute('inert')).toBe(false);
    expect(lateToast.inert).toBe(false);
    expect(lateToast.getAttribute('aria-hidden')).toBe('false');
  });

  it('allows a later modal root to become the top layer without the lower modal stealing focus', () => {
    const harness = modalHarness();
    const onClose = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BottomSheet isOpen onClose={onClose} ariaLabel="Spot details"><button>Action</button></BottomSheet>,
        { createNodeMock: element => element.props.role === 'dialog' ? harness.dialog : null },
      );
    });

    const topModalRoot = new FakeElement('delete confirmation');
    topModalRoot.attributes.set('data-modal-root', '');
    act(() => harness.addBackgroundSibling(topModalRoot));
    expect(topModalRoot.inert).toBe(false);
    expect(topModalRoot.hasAttribute('aria-hidden')).toBe(false);

    harness.modalRoot.inert = true;
    harness.modalRoot.attributes.set('inert', '');
    harness.modalRoot.attributes.set('aria-hidden', 'true');
    (globalThis.document as any).activeElement = harness.opener;
    const tab = harness.dispatchKey('Tab');
    harness.dispatchKey('Escape');
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(harness.first.focus).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    act(() => renderer!.unmount());
  });

  it('keeps shared background isolated when a lower modal closes before the top modal', () => {
    const harness = modalHarness();
    let lower: TestRenderer.ReactTestRenderer;
    act(() => {
      lower = TestRenderer.create(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details"><button>Sheet action</button></BottomSheet>,
        { createNodeMock: element => element.props.role === 'dialog' ? harness.dialog : null },
      );
    });

    const topFirst = new FakeElement('cancel');
    topFirst.tabIndex = 0;
    const topDialog = new FakeElement('top-dialog', [topFirst]);
    const topRoot = new FakeElement('top-modal-root');
    topRoot.attributes.set('data-modal-root', '');
    topRoot.parentElement = harness.modalRoot.parentElement;
    topRoot.children = [topDialog];
    topDialog.parentElement = topRoot;
    act(() => harness.addBackgroundSibling(topRoot));

    let top: TestRenderer.ReactTestRenderer;
    act(() => {
      top = TestRenderer.create(
        <AccessibleModal
          ariaLabel="Delete this Ping?"
          onDismiss={vi.fn()}
          overlayClassName="overlay"
          panelClassName="panel"
        ><button>Cancel</button></AccessibleModal>,
        { createNodeMock: element => element.props.role === 'dialog' ? topDialog : null },
      );
    });
    expect(harness.page.inert).toBe(true);
    expect(harness.modalRoot.inert).toBe(true);
    expect((globalThis.document as any).activeElement).toBe(topFirst);

    act(() => lower!.unmount());
    expect(harness.page.inert).toBe(true);
    expect(harness.page.getAttribute('aria-hidden')).toBe('true');
    expect((globalThis.document as any).activeElement).toBe(topFirst);

    harness.modalRoot.isConnected = false;
    act(() => top!.unmount());
    expect(harness.page.inert).toBe(false);
    expect(harness.page.hasAttribute('inert')).toBe(false);
    expect(harness.page.hasAttribute('aria-hidden')).toBe(false);
    expect(harness.preIsolated.getAttribute('inert')).toBe('legacy-state');
    expect(harness.preIsolated.getAttribute('aria-hidden')).toBe('false');
  });

  it('does not reclaim or trap focus while an ancestor of the modal is inert, then resumes when that ancestor is interactive again', () => {
    const harness = modalHarness();
    const composer = new FakeElement('composer');
    composer.tabIndex = 0;
    const backgroundParent = harness.modalRoot.parentElement!;
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details"><button>Action</button></BottomSheet>,
        { createNodeMock: element => element.props.role === 'dialog' ? harness.dialog : null },
      );
    });
    expect(harness.first.focus).toHaveBeenCalledTimes(1);

    backgroundParent.setAttribute('inert', '');
    (globalThis.document as any).activeElement = composer;
    act(() => {
      renderer!.update(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details"><button>Action</button></BottomSheet>,
      );
    });
    expect(harness.first.focus).toHaveBeenCalledTimes(1);
    expect((globalThis.document as any).activeElement).toBe(composer);
    const tabWhileObscured = harness.dispatchKey('Tab');
    expect(tabWhileObscured.preventDefault).not.toHaveBeenCalled();

    backgroundParent.removeAttribute('inert');
    act(() => {
      renderer!.update(
        <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Spot details"><button>Action</button></BottomSheet>,
      );
    });
    expect(harness.first.focus).toHaveBeenCalledTimes(2);
    expect((globalThis.document as any).activeElement).toBe(harness.first);

    act(() => renderer!.unmount());
  });
});
