import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useModalAccessibility } from '../../hooks/useModalAccessibility';

interface BottomSheetProps {
    isOpen: boolean;
    onClose: () => void;
    children: React.ReactNode;
    ariaLabel: string;
    /**
     * Optional inner Back (Ping Later, departure time picker, spot-stack).
     * Escape / Android Back try this first; backdrop tap still closes the sheet.
     */
    onNestedBack?: () => boolean;
}

const SHEET_MS = 280;
const DISMISS_PX = 80;

export const BottomSheet: React.FC<BottomSheetProps> = ({ isOpen, onClose, children, ariaLabel, onNestedBack }) => {
    const [visible, setVisible] = useState(false);
    const sheetRef = useRef<HTMLDivElement>(null);
    const backdropRef = useRef<HTMLDivElement>(null);
    const dragStartY = useRef<number | null>(null);
    const dragOffsetRef = useRef(0);
    const draggingRef = useRef(false);
    const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearInlineMotion = useCallback(() => {
        const sheet = sheetRef.current;
        const backdrop = backdropRef.current;
        // Guard style access — react-test-renderer fixtures may omit CSSStyleDeclaration.
        if (sheet?.style) {
            sheet.style.transition = '';
            sheet.style.transform = '';
        }
        sheet?.classList?.remove('is-dragging');
        if (backdrop?.style) {
            backdrop.style.transition = '';
            backdrop.style.opacity = '';
        }
        backdrop?.classList?.remove('is-dragging');
    }, []);

    const applyDragFrame = useCallback((dy: number) => {
        const sheet = sheetRef.current;
        const backdrop = backdropRef.current;
        if (sheet?.style) {
            // Direct compositor update — no React state on the move path.
            sheet.style.transition = 'none';
            sheet.style.transform = `translate3d(0, ${dy}px, 0)`;
        }
        if (backdrop?.style) {
            backdrop.style.transition = 'none';
            // Keep a little dim so the sheet never feels unanchored.
            backdrop.style.opacity = String(Math.max(0.18, 1 - dy / 320));
        }
    }, []);

    useEffect(() => {
        if (isOpen) {
            clearInlineMotion();
            dragOffsetRef.current = 0;
            draggingRef.current = false;
            requestAnimationFrame(() => setVisible(true));
        } else {
            setVisible(false);
            dragOffsetRef.current = 0;
            draggingRef.current = false;
            clearInlineMotion();
        }
    }, [isOpen, clearInlineMotion]);

    useEffect(() => () => {
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
        if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
    }, []);

    const dismiss = useCallback(() => {
        draggingRef.current = false;
        dragStartY.current = null;
        const sheet = sheetRef.current;
        const backdrop = backdropRef.current;
        sheet?.classList.remove('is-dragging');
        backdrop?.classList.remove('is-dragging');

        setVisible(false);

        // Animate off-screen with an explicit translate so release feels continuous.
        const height = sheet?.offsetHeight ?? Math.round(window.innerHeight * 0.85);
        if (sheet?.style) {
            sheet.style.transition = `transform ${SHEET_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
            sheet.style.transform = `translate3d(0, ${height}px, 0)`;
        }
        if (backdrop?.style) {
            backdrop.style.transition = `opacity ${SHEET_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
            backdrop.style.opacity = '0';
        }

        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = setTimeout(onClose, SHEET_MS);
    }, [onClose]);

    const onNestedBackRef = useRef(onNestedBack);
    onNestedBackRef.current = onNestedBack;
    const dismissFromBack = useCallback(() => {
        if (onNestedBackRef.current?.()) return;
        dismiss();
    }, [dismiss]);

    useModalAccessibility({ isOpen, dialogRef: sheetRef, onEscape: dismissFromBack });

    // Non-passive touchmove so we can preventDefault and stop scroll fighting the drag.
    useEffect(() => {
        const sheet = sheetRef.current;
        if (!sheet || !isOpen) return;

        const onStart = (e: TouchEvent) => {
            if (e.touches.length !== 1) {
                dragStartY.current = null;
                return;
            }
            const target = e.target as HTMLElement | null;
            const fromHandle = !!target?.closest('.pq-bottom-sheet-handle-row');
            // If content is scrolled, only the handle starts a dismiss drag.
            if (!fromHandle && sheet.scrollTop > 0) {
                dragStartY.current = null;
                return;
            }
            dragStartY.current = e.touches[0].clientY;
            dragOffsetRef.current = 0;
        };

        const onMove = (e: TouchEvent) => {
            if (dragStartY.current === null || e.touches.length !== 1) return;
            const dy = e.touches[0].clientY - dragStartY.current;
            if (dy <= 0) {
                // Ignore upward pull; allow native scroll instead.
                if (draggingRef.current) {
                    draggingRef.current = false;
                    dragOffsetRef.current = 0;
                    sheet.classList.remove('is-dragging');
                    backdropRef.current?.classList.remove('is-dragging');
                    applyDragFrame(0);
                }
                return;
            }

            if (!draggingRef.current) {
                draggingRef.current = true;
                sheet.classList.add('is-dragging');
                backdropRef.current?.classList.add('is-dragging');
            }

            dragOffsetRef.current = dy;
            applyDragFrame(dy);

            if (e.cancelable) e.preventDefault();
        };

        const onEnd = () => {
            if (dragStartY.current === null) return;
            const dy = dragOffsetRef.current;
            dragStartY.current = null;

            sheet.classList.remove('is-dragging');
            backdropRef.current?.classList.remove('is-dragging');
            draggingRef.current = false;

            if (dy > DISMISS_PX) {
                dismiss();
                return;
            }

            // Snap back — re-enable transition only after the finger lifts.
            dragOffsetRef.current = 0;
            if (sheet?.style) {
                sheet.style.transition = `transform ${SHEET_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
                sheet.style.transform = 'translate3d(0, 0, 0)';
            }
            const backdrop = backdropRef.current;
            if (backdrop?.style) {
                backdrop.style.transition = `opacity ${SHEET_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
                backdrop.style.opacity = '1';
            }

            if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
            snapTimerRef.current = setTimeout(() => {
                if (draggingRef.current) return;
                clearInlineMotion();
            }, SHEET_MS + 24);
        };

        // react-test-renderer fixtures omit EventTarget; skip native listeners there.
        if (typeof sheet.addEventListener !== 'function') return;

        sheet.addEventListener('touchstart', onStart, { passive: true });
        sheet.addEventListener('touchmove', onMove, { passive: false });
        sheet.addEventListener('touchend', onEnd);
        sheet.addEventListener('touchcancel', onEnd);
        return () => {
            sheet.removeEventListener('touchstart', onStart);
            sheet.removeEventListener('touchmove', onMove);
            sheet.removeEventListener('touchend', onEnd);
            sheet.removeEventListener('touchcancel', onEnd);
        };
    }, [isOpen, applyDragFrame, clearInlineMotion, dismiss]);

    if (!isOpen) return null;

    return (
        <div data-modal-root="" className="pq-bottom-sheet-root absolute inset-0 z-30">
            <div
                ref={backdropRef}
                className={`pq-bottom-sheet-backdrop absolute inset-0 ${
                    visible ? 'is-open' : ''
                }`}
                onClick={dismiss}
            />
            <div
                ref={sheetRef}
                role="dialog"
                aria-modal="true"
                aria-label={ariaLabel}
                className={`pq-bottom-sheet absolute bottom-0 left-0 right-0 max-h-[85vh] overflow-y-auto ${
                    visible ? 'is-open' : ''
                }`}
            >
                <div className="pq-bottom-sheet-handle-row">
                    <div className="pq-bottom-sheet-handle" />
                </div>
                <div className="pq-bottom-sheet-body px-5 pb-8">
                    {children}
                </div>
            </div>
        </div>
    );
};
