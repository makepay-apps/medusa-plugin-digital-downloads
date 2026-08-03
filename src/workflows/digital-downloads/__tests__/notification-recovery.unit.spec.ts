import { NotificationDeliveryState } from "../../../modules/digital-downloads/types"
import { markSentNotificationRecoveryFailed } from "../revocation-workflows"

describe("sent notification recovery", () => {
  it("reserves a claimable recovery slot on the final configured attempt", async () => {
    const service = {
      updateNotificationDeliveries: jest.fn().mockResolvedValue(undefined),
    }

    await markSentNotificationRecoveryFailed(
      service,
      {
        id: "ndel_final_attempt",
        attempt_count: 3,
        max_attempts: 3,
      },
      new Error("activation temporarily unavailable")
    )

    expect(service.updateNotificationDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ndel_final_attempt",
        state: NotificationDeliveryState.FAILED,
        attempt_count: 2,
        next_retry_at: expect.any(Date),
        lease_owner: null,
        lease_expires_at: null,
        error_code: "notification_failed",
        error_message: "activation temporarily unavailable",
      })
    )
    expect(service.updateNotificationDeliveries).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: NotificationDeliveryState.DEAD_LETTER })
    )
  })
})
