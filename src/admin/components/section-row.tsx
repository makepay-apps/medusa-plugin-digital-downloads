import { Text } from "@medusajs/ui"
import type { ReactNode } from "react"

interface SectionRowProps {
  label: string
  value?: ReactNode
  actions?: ReactNode
}

export const SectionRow = ({ label, value, actions }: SectionRowProps) => (
  <div className="grid min-h-14 grid-cols-[minmax(120px,1fr)_minmax(0,2fr)_auto] items-center gap-4 px-6 py-3">
    <Text className="text-ui-fg-subtle" size="small">
      {label}
    </Text>
    <div className="min-w-0 text-ui-fg-base txt-small">{value ?? "—"}</div>
    {actions ? <div>{actions}</div> : null}
  </div>
)
