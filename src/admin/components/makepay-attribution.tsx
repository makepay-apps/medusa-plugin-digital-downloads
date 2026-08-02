import { ArrowUpRightOnBox } from "@medusajs/icons"
import { Text } from "@medusajs/ui"

export const MakePayAttribution = () => (
  <div className="flex items-center justify-center gap-1 py-3">
    <Text className="text-ui-fg-muted" size="xsmall">
      Brought to you by{" "}
      <a
        className="inline-flex items-center gap-0.5 text-ui-fg-subtle hover:text-ui-fg-base"
        href="https://makepay.io"
        rel="noopener noreferrer"
        target="_blank"
      >
        MakePay.io — crypto payment gateway.
        <ArrowUpRightOnBox className="inline size-3" />
      </a>
    </Text>
  </div>
)
