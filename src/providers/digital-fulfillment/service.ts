import type {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateFulfillmentResult,
  CreateShippingOptionDTO,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"

/**
 * Optional zero-cost fulfillment provider for merchants that want digital
 * delivery represented in Medusa's native fulfillment UI. Entitlements are
 * still issued by order/payment subscribers, so using this provider never
 * replaces or forks cart completion.
 */
export default class DigitalFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = "makepay-digital"

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      {
        id: "digital-delivery",
        name: "Digital delivery",
        service_code: "DIGITAL",
      },
    ]
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext
  ): Promise<Record<string, unknown>> {
    return {
      ...optionData,
      ...data,
      digital_delivery: true,
    }
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return !data.id || data.id === "digital-delivery"
  }

  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return true
  }

  async calculatePrice(
    _optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    _context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    return {
      calculated_amount: 0,
      is_calculated_price_tax_inclusive: true,
    }
  }

  async createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<
      Omit<FulfillmentDTO, "provider_id" | "data" | "items">
    >
  ): Promise<CreateFulfillmentResult> {
    return {
      data: {
        ...data,
        digital_delivery: true,
        fulfillment_id: fulfillment.id,
        order_id: order?.id,
        item_ids: items.map((item) => item.line_item_id).filter(Boolean),
        acknowledged_at: new Date().toISOString(),
      },
      labels: [],
    }
  }

  async cancelFulfillment(
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return {
      ...data,
      canceled_at: new Date().toISOString(),
    }
  }

  async createReturnFulfillment(
    fulfillment: Record<string, unknown>
  ): Promise<CreateFulfillmentResult> {
    return {
      data: {
        ...fulfillment,
        digital_return: true,
        acknowledged_at: new Date().toISOString(),
      },
      labels: [],
    }
  }
}
