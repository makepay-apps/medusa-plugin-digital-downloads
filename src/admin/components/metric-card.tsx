import { Container, Heading, Text } from "@medusajs/ui"

interface MetricCardProps {
  label: string
  value: string | number
  description?: string
}

export const MetricCard = ({ label, value, description }: MetricCardProps) => (
  <Container className="p-4">
    <Text className="text-ui-fg-subtle" size="small">
      {label}
    </Text>
    <Heading className="mt-1" level="h2">
      {value}
    </Heading>
    {description ? (
      <Text className="mt-1 text-ui-fg-muted" size="xsmall">
        {description}
      </Text>
    ) : null}
  </Container>
)
