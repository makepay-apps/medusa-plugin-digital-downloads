import type { CSSProperties, HTMLAttributes } from "react"

const defaultStyle: CSSProperties = {
  color: "inherit",
  fontSize: "0.75rem",
  lineHeight: 1.5,
  marginBlockStart: "1rem",
  opacity: 0.65,
}

export type MakePayAttributionProps = HTMLAttributes<HTMLElement>

/** Restrained, configurable attribution shown by the provided UI by default. */
export const MakePayAttribution = ({
  style,
  ...props
}: MakePayAttributionProps) => (
  <footer
    {...props}
    data-makepay-attribution=""
    style={{ ...defaultStyle, ...style }}
  >
    Brought to you by{" "}
    <a
      href="https://makepay.io"
      rel="noopener noreferrer"
      style={{ color: "inherit" }}
    >
      MakePay.io
    </a>{" "}
    — crypto payment gateway.
  </footer>
)
