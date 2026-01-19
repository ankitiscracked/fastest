import * as React from 'react';
import { Menu as BaseMenu } from '@base-ui-components/react/menu';

// Re-export base components
export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const MenuPortal = BaseMenu.Portal;
export const MenuPositioner = BaseMenu.Positioner;
export const MenuArrow = BaseMenu.Arrow;
export const MenuGroup = BaseMenu.Group;
export const MenuGroupLabel = BaseMenu.GroupLabel;
export const MenuSeparator = BaseMenu.Separator;
export const MenuRadioGroup = BaseMenu.RadioGroup;

// Styled MenuPopup
interface MenuPopupProps extends React.ComponentPropsWithoutRef<typeof BaseMenu.Popup> {
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

export function MenuPopup({
  children,
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  className = '',
  ...props
}: MenuPopupProps) {
  return (
    <MenuPortal>
      <MenuPositioner side={side} align={align} sideOffset={sideOffset}>
        <BaseMenu.Popup
          className={`
            z-50 min-w-[12rem] bg-white border border-gray-200 rounded-lg shadow-lg py-1
            animate-in fade-in-0 zoom-in-95
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95
            ${className}
          `.trim()}
          {...props}
        >
          {children}
        </BaseMenu.Popup>
      </MenuPositioner>
    </MenuPortal>
  );
}

// Styled MenuItem
interface MenuItemProps extends React.ComponentPropsWithoutRef<typeof BaseMenu.Item> {
  selected?: boolean;
}

export function MenuItem({
  children,
  selected = false,
  className = '',
  ...props
}: MenuItemProps) {
  return (
    <BaseMenu.Item
      className={`
        w-full text-left px-4 py-2 text-sm outline-none cursor-pointer
        flex items-center justify-between
        ${selected ? 'bg-primary-50 text-primary-700' : 'text-gray-700'}
        hover:bg-gray-50 focus:bg-gray-50
        data-[highlighted]:bg-gray-50
        ${className}
      `.trim()}
      {...props}
    >
      {children}
    </BaseMenu.Item>
  );
}

// Styled MenuRadioItem
interface MenuRadioItemProps extends React.ComponentPropsWithoutRef<typeof BaseMenu.RadioItem> {
  selected?: boolean;
}

export function MenuRadioItem({
  children,
  selected = false,
  className = '',
  ...props
}: MenuRadioItemProps) {
  return (
    <BaseMenu.RadioItem
      className={`
        w-full text-left px-4 py-2 text-sm outline-none cursor-pointer
        flex items-center gap-2
        ${selected ? 'bg-primary-50 text-primary-700' : 'text-gray-700'}
        hover:bg-gray-50 focus:bg-gray-50
        data-[highlighted]:bg-gray-50
        ${className}
      `.trim()}
      {...props}
    >
      <span className={`w-2 h-2 rounded-full ${selected ? 'bg-primary-500' : 'bg-gray-300'}`} />
      {children}
    </BaseMenu.RadioItem>
  );
}
