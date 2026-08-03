import { MedusaError } from "@medusajs/framework/utils"

import { DigitalDownloadsModuleService } from ".."
import {
  LicenseAssignmentStatus,
  LicensePoolKeyStatus,
} from "../types"

const transactionContext = { transactionManager: { id: "license-test" } }
const prototype = DigitalDownloadsModuleService.prototype as any

describe("license lifecycle serialization", () => {
  it("locks the entitlement before the assignment and refreshes both rows", async () => {
    const events: string[] = []
    const service = {
      retrieveLicenseAssignment: jest
        .fn()
        .mockResolvedValueOnce({
          id: "dlassn_1",
          entitlement_id: "dent_1",
        })
        .mockResolvedValueOnce({
          id: "dlassn_1",
          entitlement_id: "dent_1",
          status: LicenseAssignmentStatus.ACTIVE,
        }),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_1",
        status: "active",
      }),
      lockRows_: jest.fn(async (table: string) => {
        events.push(table)
      }),
    }

    await prototype.lockLicenseAssignmentGraph_.call(
      service,
      "dlassn_1",
      undefined,
      transactionContext,
    )

    expect(events).toEqual(["digital_entitlement", "license_assignment"])
    expect(service.retrieveLicenseAssignment).toHaveBeenLastCalledWith(
      "dlassn_1",
      { options: { refresh: true } },
      transactionContext,
    )
    expect(service.retrieveDigitalEntitlement).toHaveBeenCalledWith(
      "dent_1",
      { options: { refresh: true } },
      transactionContext,
    )
  })

  it("rejects a key whose assignment relationship changed while waiting", async () => {
    const service = {
      lockLicenseAssignmentGraph_: jest.fn().mockResolvedValue({
        assignment: {
          id: "dlassn_1",
          entitlement_id: "dent_1",
          license_policy_id: "dlpol_1",
          license_pool_key_id: "dlkey_replacement",
        },
        entitlement: { id: "dent_1" },
      }),
      retrieveLicensePoolKey: jest.fn(),
    }

    await expect(
      prototype.lockAndRevalidateResolvedLicenseKey_.call(
        service,
        {
          assignment: {
            id: "dlassn_1",
            entitlement_id: "dent_1",
          },
          poolKey: { id: "dlkey_previous" },
        },
        transactionContext,
      ),
    ).rejects.toMatchObject({
      type: MedusaError.Types.UNAUTHORIZED,
      message: "License key is invalid",
    })
    expect(service.retrieveLicensePoolKey).not.toHaveBeenCalled()
  })

  it.each([
    ["activateLicenseByKey", "activateLicense"],
    ["deactivateLicenseByKey", "updateLicenseActivations"],
    ["heartbeatLicenseByKey", "updateLicenseActivations"],
  ])("revalidates stale keys before %s mutates lifecycle state", async (method, sink) => {
    const stale = new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      "License key is invalid",
    )
    const service: Record<string, any> = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      options_: {
        encryptionKey: "1".repeat(64),
        tokenSecret: "unit-test-token-secret-32-bytes-minimum",
      },
      resolveLicenseKeyRecord: jest.fn().mockResolvedValue({
        assignment: {
          id: "dlassn_1",
          entitlement_id: "dent_1",
        },
        poolKey: { id: "dlkey_previous" },
      }),
      lockAndRevalidateResolvedLicenseKey_: jest.fn().mockRejectedValue(stale),
      activateLicense: jest.fn(),
      listLicenseActivations: jest.fn(),
      updateLicenseActivations: jest.fn(),
    }

    await expect(
      prototype[method].call(
        service,
        {
          license_key: "PREVIOUS-KEY",
          instance_id: "device-1",
        },
        transactionContext,
      ),
    ).rejects.toBe(stale)
    expect(service[sink]).not.toHaveBeenCalled()
  })

  it("rechecks reveal ownership against the refreshed entitlement", async () => {
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      retrieveLicenseAssignment: jest.fn().mockResolvedValue({
        id: "dlassn_1",
        entitlement_id: "dent_1",
      }),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_1",
        customer_id: "cus_owner",
      }),
      lockLicenseAssignmentGraph_: jest.fn().mockResolvedValue({
        assignment: {
          id: "dlassn_1",
          entitlement_id: "dent_1",
          license_pool_key_id: "dlkey_1",
          status: LicenseAssignmentStatus.ACTIVE,
        },
        entitlement: {
          id: "dent_1",
          customer_id: "cus_reassigned",
          status: "active",
        },
      }),
      retrieveLicensePoolKey: jest.fn().mockResolvedValue({
        id: "dlkey_1",
        status: LicensePoolKeyStatus.ASSIGNED,
      }),
    }

    await expect(
      prototype.revealLicenseKey.call(
        service,
        {
          assignment_id: "dlassn_1",
          customer_id: "cus_owner",
        },
        transactionContext,
      ),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
      message: "License assignment was not found",
    })
    expect(service.retrieveLicensePoolKey).not.toHaveBeenCalled()
  })

  it("revalidates a pre-discovered guest capability after locking its graph", async () => {
    const events: string[] = []
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      retrieveLicenseAssignment: jest.fn().mockResolvedValue({
        id: "dlassn_1",
        entitlement_id: "dent_1",
      }),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_1",
        customer_id: null,
      }),
      discoverGuestAccessSession_: jest.fn(async () => {
        events.push("discover")
        return { hash: "guest_hash", session: { entitlement_id: "dent_1" } }
      }),
      lockLicenseAssignmentGraph_: jest.fn(async () => {
        events.push("lock")
        return {
          assignment: {
            id: "dlassn_1",
            entitlement_id: "dent_1",
            license_pool_key_id: "dlkey_1",
            status: LicenseAssignmentStatus.ACTIVE,
          },
          entitlement: {
            id: "dent_1",
            customer_id: null,
            status: "active",
          },
        }
      }),
      resolveGuestEntitlement: jest.fn(async () => {
        events.push("resolve")
        return { entitlement: { id: "dent_other" }, session: {} }
      }),
      retrieveLicensePoolKey: jest.fn(),
    }

    await expect(
      prototype.revealLicenseKey.call(
        service,
        {
          assignment_id: "dlassn_1",
          guest_token: "dda_guest",
          guest_email: "buyer@example.test",
        },
        transactionContext,
      ),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
      message: "License assignment was not found",
    })
    expect(events).toEqual(["discover", "lock", "resolve"])
    expect(service.retrieveLicensePoolKey).not.toHaveBeenCalled()
  })

  it("rejects crossed guest reveals before either entitlement graph is locked", async () => {
    let arrivals = 0
    let releaseDiscoveries!: () => void
    const bothDiscovered = new Promise<void>((resolve) => {
      releaseDiscoveries = resolve
    })
    const assignments: Record<string, string> = {
      dlassn_a: "dent_a",
      dlassn_b: "dent_b",
    }
    const tokenEntitlements: Record<string, string> = {
      token_a: "dent_a",
      token_b: "dent_b",
    }
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      retrieveLicenseAssignment: jest.fn(async (id: string) => ({
        id,
        entitlement_id: assignments[id],
      })),
      discoverGuestAccessSession_: jest.fn(async (token: string) => {
        arrivals += 1
        if (arrivals === 2) releaseDiscoveries()
        await bothDiscovered
        return {
          hash: `${token}-hash`,
          session: { entitlement_id: tokenEntitlements[token] },
        }
      }),
      retrieveDigitalEntitlement: jest.fn(),
      lockLicenseAssignmentGraph_: jest.fn(),
    }

    const outcomes = await Promise.allSettled([
      prototype.revealLicenseKey.call(
        service,
        { assignment_id: "dlassn_a", guest_token: "token_b" },
        transactionContext,
      ),
      prototype.revealLicenseKey.call(
        service,
        { assignment_id: "dlassn_b", guest_token: "token_a" },
        transactionContext,
      ),
    ])

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          type: MedusaError.Types.NOT_FOUND,
          message: "License assignment was not found",
        }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          type: MedusaError.Types.NOT_FOUND,
          message: "License assignment was not found",
        }),
      }),
    ])
    expect(service.lockLicenseAssignmentGraph_).not.toHaveBeenCalled()
    expect(service.retrieveDigitalEntitlement).not.toHaveBeenCalled()
  })
})
