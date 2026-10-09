/**
 * shadcn/ui Drawer — **Base UI branch**.
 *
 * One branch only, on purpose. Base UI and the older Vaul implementation expose
 * incompatible props and data attributes, and mixing them in one codebase
 * produces drawers that silently ignore half their configuration. This file
 * therefore uses Base UI part names and Base UI props exclusively:
 *
 *   disablePointerDismissal, modal, snapPoints, swipeDirection,
 *   data-swiping, data-starting-style, data-expanded
 *
 * Vaul-only props (`handleOnly`, `repositionInputs`, `activeSnapPoint`, …) and
 * `data-vaul-*` selectors must never appear here or in any screen.
 *
 * Composition: `DrawerContent` composes portal → backdrop → viewport → popup,
 * matching the documented anatomy. The lower-level parts stay exported.
 *
 * iOS note from the Base UI docs: the drawer's backdrop is absolutely
 * positioned, so `body` must be positioned for it to cover the viewport after
 * the page has been scrolled — that is set in src/styles/globals.css.
 */
import * as React from 'react';
import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import { cn } from '@/lib/utils';

function Drawer({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Backdrop>) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/70',
        'transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Popup>) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            'relative flex w-full max-w-xl flex-col',
            'max-h-[92dvh] rounded-t-2xl border-t border-default bg-surface text-primary',
            'shadow-md outline-none',
            'transition-transform duration-200 ease-out',
            'data-[starting-style]:translate-y-full data-[ending-style]:translate-y-full',
            // reduced motion is handled globally in globals.css
            className,
          )}
          {...props}
        >
          <DrawerSwipeArea />
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  );
}

/**
 * The grab affordance and drag region. Base UI exports this part as
 * `DrawerSwipeArea` in 1.9; the shadcn-familiar name is kept as an alias so
 * screens can use either without pulling in a second implementation.
 */
function DrawerSwipeArea({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.SwipeArea>) {
  return (
    <DrawerPrimitive.SwipeArea
      data-slot="drawer-swipe-area"
      className={cn('flex shrink-0 justify-center pt-3 pb-2', className)}
      {...props}
    >
      <div className="h-1 w-10 rounded-full bg-secondary/40" aria-hidden="true" />
    </DrawerPrimitive.SwipeArea>
  );
}

const DrawerSwipeHandle = DrawerSwipeArea;

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex flex-col gap-1 px-5 pb-3', className)}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn('mt-auto flex flex-col gap-2 px-5 pt-3 pb-safe', className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('text-lg font-semibold text-primary', className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-sm text-secondary', className)}
      {...props}
    />
  );
}

function DrawerClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

export {
  Drawer,
  DrawerTrigger,
  DrawerPortal,
  DrawerOverlay,
  DrawerContent,
  DrawerSwipeArea,
  DrawerSwipeHandle,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
};
