import * as React from 'react';
import { Popover as BasePopover } from '@base-ui-components/react/popover';

// Re-export base components
export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;
export const PopoverPortal = BasePopover.Portal;
export const PopoverPositioner = BasePopover.Positioner;
export const PopoverArrow = BasePopover.Arrow;
export const PopoverClose = BasePopover.Close;
export const PopoverTitle = BasePopover.Title;
export const PopoverDescription = BasePopover.Description;

// Styled PopoverPopup with default styles
interface PopoverPopupProps extends React.ComponentPropsWithoutRef<typeof BasePopover.Popup> {
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

export function PopoverPopup({
  children,
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  className = '',
  ...props
}: PopoverPopupProps) {
  return (
    <PopoverPortal>
      <PopoverPositioner side={side} align={align} sideOffset={sideOffset}>
        <BasePopover.Popup
          className={`
            z-50 bg-white border border-gray-200 rounded-lg shadow-lg
            animate-in fade-in-0 zoom-in-95
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95
            ${className}
          `.trim()}
          {...props}
        >
          {children}
        </BasePopover.Popup>
      </PopoverPositioner>
    </PopoverPortal>
  );
}
