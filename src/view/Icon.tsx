import React, { useEffect, useRef } from 'react';
import { setIcon } from 'obsidian';

/** One of Obsidian's icons (or one the plugin registered), sized and coloured by the theme. */
export function Icon({ name, className }: { name: string; className?: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (ref.current) setIcon(ref.current, name);
    }, [name]);
    return <span ref={ref} className={`alphaino-icon ${className ?? ''}`} aria-hidden="true" />;
}
