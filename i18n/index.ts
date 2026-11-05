import { useState, useEffect } from 'react';
import en from './en';
import es from './es';

type Lang = 'en' | 'es';

const LANG_KEY = 'parqueen_lang';
const DICTIONARIES: Record<Lang, Record<string, string>> = { en, es };

function resolveInitialLang(): Lang {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'en' || stored === 'es') return stored;
    return 'en';
}

// Module-level lang state + subscriber list for React re-renders
let currentLang: Lang = resolveInitialLang();
const subscribers = new Set<() => void>();

export function getLang(): Lang {
    return currentLang;
}

/** Keep <html lang> in step, or a screen reader narrates Spanish with an English voice. */
function syncDocumentLang(lang: Lang): void {
    if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = lang;
}

export function setLang(lang: Lang): void {
    if (lang !== 'en' && lang !== 'es') return;
    currentLang = lang;
    syncDocumentLang(lang);
    localStorage.setItem(LANG_KEY, lang);
    subscribers.forEach(fn => fn());
}

export function t(key: string, params?: Record<string, string | number>): string {
    const dict = DICTIONARIES[currentLang];
    let value = dict[key] ?? DICTIONARIES['en'][key] ?? key;
    if (params) {
        Object.entries(params).forEach(([k, v]) => {
            value = value.replace(`{${k}}`, String(v));
        });
    }
    return value;
}

/** Translate in a specific language without changing the active one (used to measure layouts in both languages). */
export function translateIn(lang: Lang, key: string): string {
    return DICTIONARIES[lang]?.[key] ?? DICTIONARIES['en'][key] ?? key;
}

export type { Lang };

export function useLang(): Lang {
    const [lang, setLangState] = useState<Lang>(currentLang);
    useEffect(() => {
        const notify = () => setLangState(currentLang);
        subscribers.add(notify);
        return () => { subscribers.delete(notify); };
    }, []);
    return lang;
}

syncDocumentLang(currentLang);
