import * as React from "react"

import { cn } from "../../lib/utils"
import { inputClassName } from "./input"

// shadcn NativeSelect: the browser's own <select> (accessible, mobile pickers) with the shadcn field look.
// The chevron is drawn by CSS gradients (`.ui-select` in components.css) because the CSP allows no data: images.
export const nativeSelectClassName = cn(inputClassName, "ui-select cursor-pointer appearance-none pr-9")

const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, ...props }, ref) => (
    <select ref={ref} data-slot="native-select" className={cn(nativeSelectClassName, className)} {...props} />
  )
)
NativeSelect.displayName = "NativeSelect"

export { NativeSelect }
