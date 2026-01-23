import * as React from 'react';
import { Tooltip as BaseTooltip } from '@base-ui-components/react/tooltip';

// Re-export base components
export const Tooltip = BaseTooltip.Root;
export const TooltipTrigger = BaseTooltip.Trigger;
export const TooltipPortal = BaseTooltip.Portal;
export const TooltipPositioner = BaseTooltip.Positioner;
export const TooltipArrow = BaseTooltip.Arrow;

// Styled TooltipPopup with default styles
interface TooltipPopupProps extends React.ComponentPropsWithoutRef<typeof BaseTooltip.Popup> {
  side?: 'top' | 'bottom' | 'left' | 'right';
  sideOffset?: number;
}

export function TooltipPopup({
  children,
  side = 'top',
  sideOffset = 8,
  className = '',
  ...props
}: TooltipPopupProps) {
  return (
    <TooltipPortal>
      <TooltipPositioner side={side} sideOffset={sideOffset}>
        <BaseTooltip.Popup
          className={`
            z-50 px-3 py-2 text-xs
            bg-surface-800 text-white rounded-md shadow-lg
            max-w-64 leading-relaxed
            animate-in fade-in-0 zoom-in-95
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95
            ${className}
          `.trim()}
          {...props}
        >
          {children}
          <TooltipArrow className="fill-surface-800" />
        </BaseTooltip.Popup>
      </TooltipPositioner>
    </TooltipPortal>
  );
}

// Convenience component for info icon with tooltip
interface InfoTooltipProps {
  children: React.ReactNode;
}

export function InfoTooltip({ children }: InfoTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger className="p-1 text-surface-400 hover:text-surface-600 transition-colors cursor-help">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>{children}</TooltipPopup>
    </Tooltip>
  );
}
