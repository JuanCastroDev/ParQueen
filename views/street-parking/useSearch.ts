import { useState, useRef, useEffect } from 'react';
import { getMapboxToken } from '../../utils/browserCredentials';
import { registerAndroidBackOverlay } from '../../utils/androidBackOverlay';

export function useSearch() {
    const inputRef = useRef<HTMLInputElement>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchOpen, setSearchOpen] = useState(false);
    const [results, setResults] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const [selectedDestination, setSelectedDestination] = useState<{
        name: string;
        fullName: string;
        center: [number, number];
    } | null>(null);

    useEffect(() => {
        if (!searchOpen || searchQuery.trim().length < 2) {
            setResults([]);
            return;
        }

        const token = getMapboxToken();

        const t = setTimeout(async () => {
            try {
                abortRef.current?.abort();
                const controller = new AbortController();
                abortRef.current = controller;

                setLoading(true);

                const url =
                    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(searchQuery)}.json` +
                    `?autocomplete=true&limit=6&types=place,locality,address,postcode,poi&language=en&access_token=${token}`;

                const res = await fetch(url, { signal: controller.signal });
                const data = await res.json();

                setResults(Array.isArray(data.features) ? data.features : []);
            } catch (e: any) {
                if (e.name !== "AbortError") console.warn("Geocode failed", e);
            } finally {
                setLoading(false);
            }
        }, 300);

        return () => {
            clearTimeout(t);
            abortRef.current?.abort();
        };
    }, [searchQuery, searchOpen]);

    const handleCancelSearch = () => {
        setSearchQuery("");
        setResults([]);
        setSearchOpen(false);
        inputRef.current?.blur();
    };
    const handleCancelSearchRef = useRef(handleCancelSearch);
    handleCancelSearchRef.current = handleCancelSearch;

    useEffect(() => {
        if (!searchOpen) return;
        return registerAndroidBackOverlay({
            layer: 'transient',
            dismiss: () => {
                handleCancelSearchRef.current();
            },
            isActive: () => {
                const el = inputRef.current;
                if (!el) return true;
                try {
                    return !el.closest?.('[inert]');
                } catch {
                    return true;
                }
            },
        });
    }, [searchOpen]);

    const handleSelectResult = (result: any) => {
        setSelectedDestination({
            name: result.text,
            fullName: result.place_name,
            center: result.center as [number, number],
        });
        setSearchQuery('');
        setResults([]);
        setSearchOpen(false);
        inputRef.current?.blur();
    };

    const clearDestination = () => {
        setSelectedDestination(null);
    };

    return {
        inputRef,
        searchQuery,
        setSearchQuery,
        searchOpen,
        setSearchOpen,
        results,
        setResults,
        loading,
        handleCancelSearch,
        selectedDestination,
        handleSelectResult,
        clearDestination,
    };
}
