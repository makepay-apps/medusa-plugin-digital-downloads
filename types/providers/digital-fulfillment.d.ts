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

export declare class DigitalFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier: string
  getFulfillmentOptions(): Promise<FulfillmentOption[]>
  validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: ValidateFulfillmentDataContext,
  ): Promise<Record<string, unknown>>
  validateOption(data: Record<string, unknown>): Promise<boolean>
  canCalculate(data: CreateShippingOptionDTO): Promise<boolean>
  calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"],
  ): Promise<CalculatedShippingOptionPrice>
  createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<
      Omit<FulfillmentDTO, "provider_id" | "data" | "items">
    >,
  ): Promise<CreateFulfillmentResult>
  cancelFulfillment(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  createReturnFulfillment(
    fulfillment: Record<string, unknown>,
  ): Promise<CreateFulfillmentResult>
}

export interface DigitalFulfillmentProviderDefinition {
  readonly services: readonly [typeof DigitalFulfillmentProviderService]
}

declare const digitalFulfillmentProvider: DigitalFulfillmentProviderDefinition
export default digitalFulfillmentProvider
