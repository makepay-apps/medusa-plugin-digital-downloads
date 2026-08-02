import {
  eventTransactionId,
  orderIdForPayment,
  subscriberRevocationPolicies,
} from "../_utils"

describe("subscriber helpers", () => {
  it("builds replay-stable transaction IDs from event metadata", () => {
    const event = {
      name: "payment.refunded",
      data: { id: "pay_1" },
      metadata: { created_at: new Date("2026-01-01T00:00:00.000Z") },
    }
    expect(eventTransactionId("refund", event, "pay_1")).toBe(
      "refund:pay_1:1767225600000"
    )
  })

  it("reads resolved camelCase policy options with safe fallbacks", () => {
    const resolvedContainer = {
      resolve: jest.fn().mockReturnValue({
        refundPolicy: "retain",
        cancellationPolicy: "any_refund",
      }),
    } as any
    expect(subscriberRevocationPolicies(resolvedContainer)).toEqual({
      refundPolicy: "retain",
      cancellationPolicy: "any_refund",
    })

    const isolatedContainer = {
      resolve: jest.fn(() => {
        throw new Error("loader not run")
      }),
    } as any
    expect(
      subscriberRevocationPolicies(isolatedContainer, {
        refundPolicy: "full_refund",
        cancellationPolicy: "all",
      })
    ).toEqual({ refundPolicy: "full_refund", cancellationPolicy: "all" })
  })

  it("resolves payment ownership through Medusa Query", async () => {
    const graph = jest.fn().mockResolvedValue({
      data: [{ payment_collection: { order: { id: "order_1" } } }],
    })
    const container = { resolve: jest.fn().mockReturnValue({ graph }) } as any
    await expect(orderIdForPayment(container, "pay_1")).resolves.toBe("order_1")
    expect(graph).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "payments", filters: { id: "pay_1" } })
    )
  })
})
