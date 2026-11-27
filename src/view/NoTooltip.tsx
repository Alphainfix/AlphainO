/**
 * AlphainZ's hover tooltip, left out of AlphainO (the owner, 11-26: none of them helped, and in Obsidian's
 * sidebar they could land away from what they described). The bundler puts this in place of
 * `@beaver/agent-ui/primitives/Tooltip` everywhere, shared components included; it draws what it wraps and
 * nothing else. Labels for screen readers stay on the buttons themselves.
 */
import React from 'react';

export interface TooltipProps {
    children: React.ReactNode;
    [prop: string]: unknown;
}

const Tooltip: React.FC<TooltipProps> = ({ children }) => <>{children}</>;

export default Tooltip;
