import { ExclamationCircle, FolderOpen } from "@medusajs/icons"
import { Button, Container, Heading, Skeleton, Text } from "@medusajs/ui"
import type { ReactNode } from "react"

export const LoadingState = ({ rows = 4 }: { rows?: number }) => (
  <Container aria-busy="true" aria-label="Loading" className="space-y-3 p-6">
    {Array.from({ length: rows }, (_, index) => (
      <Skeleton className="h-10 w-full" key={index} />
    ))}
  </Container>
)

interface ErrorStateProps {
  title?: string
  message: string
  onRetry?: () => void
}

export const ErrorState = ({
  title = "Something went wrong",
  message,
  onRetry,
}: ErrorStateProps) => (
  <Container
    aria-live="polite"
    className="flex flex-col items-center gap-2 px-6 py-12 text-center"
  >
    <ExclamationCircle className="text-ui-fg-error" />
    <Heading level="h2">{title}</Heading>
    <Text className="max-w-xl text-ui-fg-subtle" size="small">
      {message}
    </Text>
    {onRetry ? (
      <Button className="mt-2" onClick={onRetry} size="small" variant="secondary">
        Try again
      </Button>
    ) : null}
  </Container>
)

interface EmptyStateProps {
  title: string
  description: string
  action?: ReactNode
}

export const EmptyState = ({ title, description, action }: EmptyStateProps) => (
  <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
    <FolderOpen className="text-ui-fg-muted" />
    <Heading level="h2">{title}</Heading>
    <Text className="max-w-lg text-ui-fg-subtle" size="small">
      {description}
    </Text>
    {action ? <div className="mt-2">{action}</div> : null}
  </div>
)
