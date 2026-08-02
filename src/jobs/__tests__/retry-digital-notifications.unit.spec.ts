import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import digitalNotificationRequestedHandler from "../../subscribers/digital-notification-requested"
import { retryNotificationDeliveriesWorkflow } from "../../workflows"
import retryDigitalNotificationsJob, {
  NOTIFICATION_RETRY_BATCH_SIZE,
} from "../retry-digital-notifications"

const mockWorkflowRun = jest.fn()

jest.mock("../../workflows", () => ({
  retryNotificationDeliveriesWorkflow: jest.fn(() => ({
    run: mockWorkflowRun,
  })),
}))

jest.mock("../../subscribers/digital-notification-requested", () => ({
  __esModule: true,
  default: jest.fn(),
}))

const mockedHandler = digitalNotificationRequestedHandler as jest.MockedFunction<
  typeof digitalNotificationRequestedHandler
>
const mockedWorkflow =
  retryNotificationDeliveriesWorkflow as jest.MockedFunction<
    typeof retryNotificationDeliveriesWorkflow
  >

describe("digital notification retry job", () => {
  beforeEach(() => {
    mockWorkflowRun.mockReset()
    mockedHandler.mockReset()
    mockedWorkflow.mockClear()
  })

  it("claims a bounded batch and processes it strictly sequentially", async () => {
    const scheduledFor = new Date("2026-08-01T06:30:00.000Z")
    mockWorkflowRun.mockResolvedValue({
      result: {
        claimed: [
          { id: "ndel_1", lease_owner: "retry-owner" },
          { id: "ndel_2", lease_owner: "retry-owner" },
          { id: "ndel_3", lease_owner: "retry-owner" },
        ],
      },
    })
    let active = 0
    let maxActive = 0
    mockedHandler.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active -= 1
    })
    const logger = { error: jest.fn() }
    const container = {
      resolve: jest.fn((key) => {
        if (key === ContainerRegistrationKeys.LOGGER) return logger
        throw new Error(`Unexpected dependency ${String(key)}`)
      }),
    } as any

    await retryDigitalNotificationsJob(container, { scheduledFor })

    expect(mockWorkflowRun).toHaveBeenCalledWith({
      input: {
        as_of: scheduledFor.toISOString(),
        limit: NOTIFICATION_RETRY_BATCH_SIZE,
      },
      context: {
        transactionId: `digital-downloads:retry-notifications:${scheduledFor.toISOString()}`,
      },
    })
    expect(mockedHandler).toHaveBeenCalledTimes(3)
    expect(maxActive).toBe(1)
    expect(mockedHandler.mock.calls.map(([args]) => args.event.data)).toEqual([
      { delivery_id: "ndel_1", lease_owner: "retry-owner" },
      { delivery_id: "ndel_2", lease_owner: "retry-owner" },
      { delivery_id: "ndel_3", lease_owner: "retry-owner" },
    ])
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("continues the bounded batch when one delivery cannot acquire its lock", async () => {
    mockWorkflowRun.mockResolvedValue({
      result: {
        claimed: [
          { id: "ndel_locked", lease_owner: "retry-owner" },
          { id: "ndel_next", lease_owner: "retry-owner" },
        ],
      },
    })
    mockedHandler
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValueOnce(undefined)
    const logger = { error: jest.fn() }
    const container = {
      resolve: jest.fn((key) => {
        if (key === ContainerRegistrationKeys.LOGGER) return logger
        throw new Error(`Unexpected dependency ${String(key)}`)
      }),
    } as any

    await retryDigitalNotificationsJob(container, {
      scheduledFor: new Date("2026-08-01T06:32:00.000Z"),
    })

    expect(mockedHandler).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      "Digital download notification retry ndel_locked could not start: lock timeout"
    )
  })
})
