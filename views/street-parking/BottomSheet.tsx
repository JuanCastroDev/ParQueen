import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useModalAccessibility } from '../../hooks/useModalAccessibility';

interface BottomSheetProps {
    isOpen: boolean;
    onClose: () => void;
    children: React.ReactNode;
    ariaLabel: string;
}

const SHEET_MS = 280;

export const BottomSheet: React.FC<BottomSheetProps> = ({ isOpen, onClose, children, ariaLabel }) => {
    const [visible, setVisible] = useState(false);
    const dragStartY = useRef<number | null>(null);
    const sheetRef = useRef<HTMLDivElement>(null);
    const [dragOffset, setDragOffset] = useState(0);

    useEffect(() => {
        if (isOpen) {
            requestAnimationFrame(() => setVisible(true));
        } else {
            setVisible(false);
        }
    }, [isOpen]);

    const dismiss = useCallback(() => {
        setVisible(false);
        setTimeout(onClose, SHEET_MS);
    }, [onClose]);

    useModalAccessibility({ isOpen, dialogRef: sheetRef, onEscape: dismiss });

    const handleTouchStart = (e: React.TouchEvent) => {
        dragStartY.current = e.touches[0].clientY;
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (dragStartY.current === null) return;
        const dy = e.touches[0].clientY - dragStartY.current;
        setDragOffset(Math.max(0, dy));
    };

    const handleTouchEnd = () => {
        if (dragOffset > 80) dismiss();
        setDragOffset(0);
        dragStartY.current = null;
    };

    if (!isOpen) return null;

    return (
        <div data-modal-root="" className="pq-bottom-sheet-root absolute inset-0 z-30">
            <div
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
                style={{ transform: visible ? `translateY(${dragOffset}px)` : undefined }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
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
