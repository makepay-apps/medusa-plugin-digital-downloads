import DigitalFulfillmentProviderService from "../service"

describe("DigitalFulfillmentProviderService", () => {
  const provider = new DigitalFulfillmentProviderService()

  it("offers native zero-cost digital delivery", async () => {
    await expect(provider.getFulfillmentOptions()).resolves.toEqual([
      expect.objectContaining({ id: "digital-delivery" }),
    ])
    await expect(provider.canCalculate({} as any)).resolves.toBe(true)
    await expect(
      provider.calculatePrice({} as any, {} as any, {} as any)
    ).resolves.toEqual({
      calculated_amount: 0,
      is_calculated_price_tax_inclusive: true,
    })
  })

  it("marks fulfillment data without creating physical labels", async () => {
    const result = await provider.createFulfillment(
      {},
      [
        { line_item_id: "item_digital", quantity: 2 },
        { line_item_id: "item_other", quantity: 1 },
      ] as any,
      { id: "order_1" } as any,
      { id: "ful_1" } as any
    )
    expect(result.labels).toEqual([])
    expect(result.data).toMatchObject({
      digital_delivery: true,
      order_id: "order_1",
      fulfillment_id: "ful_1",
      item_ids: ["item_digital", "item_other"],
    })
  })

  it("supports cancel and return lifecycle calls idempotently", async () => {
    await expect(
      provider.cancelFulfillment({ digital_delivery: true })
    ).resolves.toMatchObject({ digital_delivery: true })
    await expect(
      provider.createReturnFulfillment({ order_id: "order_1" })
    ).resolves.toMatchObject({
      labels: [],
      data: { order_id: "order_1", digital_return: true },
    })
  })
})
