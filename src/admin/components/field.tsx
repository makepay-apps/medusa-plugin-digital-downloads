import { Label, Text } from "@medusajs/ui"
import type { ReactNode } from "react"

interface FieldProps {
  label: string
  htmlFor: string
  hint?: string
  error?: string
  required?: boolean
  children: ReactNode
}

export const Field = ({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: FieldProps) => (
  <div className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={htmlFor} size="small">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Label>
      {hint ? (
        <Text className="text-ui-fg-muted" size="xsmall">
          {hint}
        </Text>
      ) : null}
    </div>
    {children}
    {error ? (
      <Text aria-live="polite" className="text-ui-fg-error" size="xsmall">
        {error}
      </Text>
    ) : null}
  </div>
)
