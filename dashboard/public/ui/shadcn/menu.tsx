import * as React from "react"
import { Menu } from "@base-ui/react/menu"

import { cn } from "../../lib/utils"

// shadcn DropdownMenu look (new-york) on the Base UI Menu primitive that already owns focus,
// keyboard navigation, dismissal and collision handling.
export const menuContentClassName =
  "z-50 min-w-[210px] flex flex-col overflow-hidden rounded-md border border-line bg-surface p-1 text-foreground shadow-md outline-none"
export const menuItemClassName =
  "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-3 py-2 text-[13px] outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"

const MenuContent = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof Menu.Popup>>(
  ({ className, ...props }, ref) => <Menu.Popup ref={ref} className={cn(menuContentClassName, className)} {...props} />
)
MenuContent.displayName = "MenuContent"

const MenuItem = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof Menu.Item> & { destructive?: boolean }>(
  ({ className, destructive, ...props }, ref) => (
    <Menu.Item ref={ref} className={cn(menuItemClassName, destructive && "text-destructive", className)} {...props} />
  )
)
MenuItem.displayName = "MenuItem"

export { MenuContent, MenuItem }
