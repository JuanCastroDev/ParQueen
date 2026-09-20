import { RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { registerAndroidBackOverlay } from '../utils/androidBackOverlay';

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalAccessibilityOptions {
  isOpen: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onEscape?: () => void;
}

interface IsolationEntry {
  element: HTMLElement;
  inertAttribute: string | null;
  inertProperty: boolean;
  ariaHidden: string | null;
  owners: Set<symbol>;
}

const isolationRegistry = new WeakMap<HTMLElement, IsolationEntry>();

function acquireIsolation(element: HTMLElement, owner: symbol) {
  let entry = isolationRegistry.get(element);
  if (!entry) {
    entry = {
      element,
      inertAttribute: element.getAttribute('inert'),
      inertProperty: Boolean((element as HTMLElement & { inert?: boolean }).inert),
      ariaHidden: element.getAttribute('aria-hidden'),
      owners: new Set(),
    };
    isolationRegistry.set(element, entry);
  }
  entry.owners.add(owner);
  (element as HTMLElement & { inert?: boolean }).inert = true;
  element.setAttribute('inert', '');
  element.setAttribute('aria-hidden', 'true');
}

function releaseIsolation(element: HTMLElement, owner: symbol) {
  const entry = isolationRegistry.get(element);
  if (!entry) return;
  entry.owners.delete(owner);
  if (entry.owners.size > 0) return;

  (element as HTMLElement & { inert?: boolean }).inert = entry.inertProperty;
  if (entry.inertAttribute === null) element.removeAttribute('inert');
  else element.setAttribute('inert', entry.inertAttribute);
  if (entry.ariaHidden === null) element.removeAttribute('aria-hidden');
  else element.setAttribute('aria-hidden', entry.ariaHidden);
  isolationRegistry.delete(element);
}

function canFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element || element.isConnected === false) return false;
  if ((element as HTMLButtonElement).disabled || element.getAttribute?.('aria-disabled') === 'true') return false;
  if ((element as HTMLElement & { inert?: boolean }).inert) return false;
  try {
    if (element.closest?.('[inert]')) return false;
    if (element.matches?.(FOCUSABLE)) return true;
  } catch {
    return false;
  }
  return element.tabIndex >= 0;
}

function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(canFocus);
}

function focusSafely(element: HTMLElement | null | undefined): boolean {
  if (!canFocus(element)) return false;
  try {
    // preventScroll: focusing an element scrolls every scrollable ancestor to
    // reveal it — including the overflow:hidden .sp-page map shell, which then
    // visibly jumps the map up on open and back down on dismiss.
    element.focus({ preventScroll: true });
    return document.activeElement === element;
  } catch {
    return false;
  }
}

function focusInsideDialog(dialog: HTMLElement, preferred?: HTMLElement | null) {
  if (focusSafely(preferred) || focusSafely(focusableWithin(dialog)[0])) return;
  dialog.tabIndex = -1;
  try { dialog.focus({ preventScroll: true }); } catch { /* no focus target available */ }
}

function modalRootIsSuspended(modalRoot: HTMLElement | null): boolean {
  if (!modalRoot) return false;
  if ((modalRoot as HTMLElement & { inert?: boolean }).inert) return true;
  if (modalRoot.getAttribute('aria-hidden') === 'true') return true;
  try {
    // An ancestor marked inert (e.g. Map kept mounted under a full-screen
    // overlay) is not itself a modal root, but its descendant dialogs must
    // not trap or reclaim focus from the foreground screen.
    return Boolean(modalRoot.closest?.('[inert]'));
  } catch {
    return false;
  }
}

export function useModalAccessibility({
  isOpen,
  dialogRef,
  initialFocusRef,
  returnFocusRef,
  onEscape,
}: ModalAccessibilityOptions) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useLayoutEffect(() => {
    if (!isOpen || !dialogRef.current || typeof document === 'undefined' || typeof window === 'undefined') return;

    const dialog = dialogRef.current;
    const modalRoot = dialog.parentElement;
    const backgroundParent = modalRoot?.parentElement ?? null;
    const opener = document.activeElement as HTMLElement | null;
    const owner = Symbol('modal-isolation-owner');
    const owned = new Set<HTMLElement>();
    const isolate = (element: HTMLElement) => {
      if (element === modalRoot || owned.has(element)) return;
      owned.add(element);
      acquireIsolation(element, owner);
    };

    if (backgroundParent) {
      Array.from(backgroundParent.children).forEach(element => isolate(element as HTMLElement));
    }

    const observer = backgroundParent && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(records => {
          for (const record of records) {
            record.addedNodes.forEach(node => {
              const element = node as HTMLElement;
              if (element.parentElement === backgroundParent && typeof element.setAttribute === 'function') {
                // A newly mounted modal is the next top layer. Its own hook
                // isolates this modal root and all other background siblings.
                if (element.hasAttribute('data-modal-root')) return;
                isolate(element);
              }
            });
          }
        })
      : null;
    observer?.observe(backgroundParent!, { childList: true });

    if (!modalRootIsSuspended(modalRoot)) {
      focusInsideDialog(dialog, initialFocusRef?.current);
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalRootIsSuspended(modalRoot)) return;
      if (event.key === 'Escape' && onEscapeRef.current) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableWithin(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        try { dialog.focus({ preventScroll: true }); } catch { /* no focus target available */ }
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      const wasSuspended = modalRootIsSuspended(modalRoot);
      window.removeEventListener('keydown', handleKeyDown);
      observer?.disconnect();
      for (const element of owned) releaseIsolation(element, owner);

      // A lower modal can disappear while a newer modal remains mounted.
      // Releasing its isolation ownership must not steal focus from the top layer.
      if (wasSuspended) return;

      if (focusSafely(returnFocusRef?.current) || focusSafely(opener)) return;
      for (const element of owned) {
        if (focusSafely(element)) return;
        const fallback = focusableWithin(element)[0];
        if (focusSafely(fallback)) return;
      }
      const persistentMain = document.querySelector?.<HTMLElement>('main, [role="main"], #root');
      if (persistentMain && persistentMain.isConnected !== false) {
        const priorTabIndex = persistentMain.getAttribute('tabindex');
        persistentMain.tabIndex = -1;
        try { persistentMain.focus({ preventScroll: true }); } catch { /* fail closed without throwing */ }
        if (priorTabIndex === null) persistentMain.removeAttribute('tabindex');
        else persistentMain.setAttribute('tabindex', priorTabIndex);
      }
    };
  }, [isOpen, dialogRef, initialFocusRef, returnFocusRef]);

  useEffect(() => {
    if (!isOpen) return;
    return registerAndroidBackOverlay({
      dismiss: () => {
        onEscapeRef.current?.();
      },
      isActive: () => {
        const modalRoot = dialogRef.current?.parentElement ?? null;
        return !modalRootIsSuspended(modalRoot);
      },
    });
  }, [isOpen, dialogRef]);

  useLayoutEffect(() => {
    if (!isOpen || !dialogRef.current || typeof document === 'undefined') return;
    const dialog = dialogRef.current;
    const modalRoot = dialog.parentElement;
    if (modalRootIsSuspended(modalRoot)) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && dialog.contains(active) && canFocus(active)) return;
    focusInsideDialog(dialog, initialFocusRef?.current);
  });
}
