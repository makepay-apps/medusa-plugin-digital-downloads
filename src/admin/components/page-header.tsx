import { ArrowUturnLeft } from "@medusajs/icons"
import { Button, Container, Heading, Text } from "@medusajs/ui"
import type { ReactNode } from "react"

interface PageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
  onBack?: () => void
}

export const PageHeader = ({
  title,
  description,
  actions,
  onBack,
}: PageHeaderProps) => (
  <Container className="flex items-center justify-between gap-4 px-6 py-4">
    <div className="flex min-w-0 items-center gap-3">
      {onBack ? (
        <Button
          aria-label="Go back"
          onClick={onBack}
          size="small"
          variant="transparent"
        >
          <ArrowUturnLeft />
        </Button>
      ) : null}
      <div className="min-w-0">
        <Heading level="h1">{title}</Heading>
        {description ? (
          <Text className="text-ui-fg-subtle" size="small">
            {description}
          </Text>
        ) : null}
      </div>
    </div>
    {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
  </Container>
)
