import path from "node:path"
import { randomUUID } from "node:crypto"

import { moduleIntegrationTestRunner } from "@medusajs/test-utils"

import {
  DIGITAL_DOWNLOADS_MODULE,
  DigitalDownloadsModuleService,
} from "../../src/modules/digital-downloads"
import * as moduleModels from "../../src/modules/digital-downloads/models"
import {
  AccessSessionStatus,
  DigitalAssetKind,
  DigitalAssetRole,
  DigitalAssetStatus,
  DigitalDeliveryMode,
  DigitalEntitlementStatus,
  DigitalProductStatus,
  DigitalReleaseStatus,
  DigitalStorageProvider,
  DownloadEventType,
  DownloadGrantStatus,
  LicenseActivationStatus,
  LicenseAssignmentStatus,
  LicensePoolKeyStatus,
  LicenseStrategy,
} from "../../src/modules/digital-downloads/types"

moduleIntegrationTestRunner<DigitalDownloadsModuleService>({
  moduleName: DIGITAL_DOWNLOADS_MODULE,
  moduleModels: Object.values(moduleModels),
  resolve: path.resolve(__dirname, "../../src/modules/digital-downloads"),
  moduleOptions: {
    tokenSecret: "domain-regression-token-secret-32-bytes-minimum",
    encryptionKey: "2".repeat(64),
    storage: {
      local: {
        rootPath: path.resolve(__dirname, "../.tmp/domain-regressions"),
        signingSecret: "domain-regression-signing-secret-32-bytes-minimum",
      },
    },
  },
  testSuite: ({ service, MikroOrmWrapper }) => {
    const rawService = service as any

    async function createProduct(
      deliveryType: DigitalDeliveryMode = DigitalDeliveryMode.DOWNLOAD,
    ) {
      const suffix = randomUUID()
      return service.createDigitalProductConfigs({
        title: `Regression ${suffix}`,
        handle: `regression-${suffix}`,
        status: DigitalProductStatus.ACTIVE,
        delivery_type: deliveryType,
      })
    }

    async function createDownloadRelease(product: any, version: string) {
      const release = await rawService.createDigitalProductReleases({
        digital_product_id: product.id,
        version,
        status: DigitalReleaseStatus.READY,
        is_current: false,
      })
      const body = Buffer.from(`private:${product.id}:${version}`)
      const storageKey = `regressions/${product.id}/${version}/${randomUUID()}.bin`
      const stored = await service.storeAssetObject({
        key: storageKey,
        body,
        mime_type: "application/octet-stream",
      })
      const asset = await rawService.createDigitalAssets({
        release_id: release.id,
        name: `Download ${version}`,
        role: DigitalAssetRole.DOWNLOAD,
        kind: DigitalAssetKind.FILE,
        status: DigitalAssetStatus.READY,
        delivery_type: DigitalDeliveryMode.DOWNLOAD,
        storage_provider: DigitalStorageProvider.LOCAL,
        storage_key: storageKey,
        storage_bucket: null,
        original_filename: `download-${version}.bin`,
        mime_type: "application/octet-stream",
        size_bytes: stored.size,
        checksum_sha256: stored.checksumSha256,
        is_enabled: true,
      })
      const published = await service.publishDigitalProductRelease(release.id)
      return { release: published, asset, body }
    }

    async function createDownloadFixture(options: {
      customerId?: string | null
      downloadLimit?: number | null
      orderId?: string
    } = {}) {
      const product = await createProduct()
      const { release, asset, body } = await createDownloadRelease(product, "1.0.0")
      const orderId = options.orderId ?? `order_${randomUUID()}`
      const [entitlement] = await service.issueOrderEntitlements({
        order_id: orderId,
        customer_id: options.customerId === undefined ? "cus_owner" : options.customerId,
        customer_email: "buyer@example.test",
        items: [
          {
            digital_product_id: product.id,
            release_id: release.id,
            order_line_item_id: `item_${randomUUID()}`,
            download_limit:
              options.downloadLimit === undefined ? 5 : options.downloadLimit,
          },
        ],
      })
      return { product, release, asset, entitlement, body, orderId }
    }

    async function createLicenseFixture(
      requireDeviceId = true,
      customerId: string | null = "cus_license",
    ) {
      const product = await createProduct(DigitalDeliveryMode.LICENSE)
      const policy = await rawService.createLicensePolicies({
        digital_product_id: product.id,
        strategy: LicenseStrategy.POOL,
        activation_limit: 2,
        require_device_id: requireDeviceId,
        is_enabled: true,
      })
      const release = await rawService.createDigitalProductReleases({
        digital_product_id: product.id,
        version: "1.0.0",
        status: DigitalReleaseStatus.READY,
      })
      const published = await service.publishDigitalProductRelease(release.id)
      const [entitlement] = await service.issueOrderEntitlements({
        order_id: `order_license_${randomUUID()}`,
        customer_id: customerId,
        customer_email: "license@example.test",
        items: [
          {
            digital_product_id: product.id,
            release_id: published.id,
            order_line_item_id: `item_license_${randomUUID()}`,
          },
        ],
      })
      const key = `POOL-${randomUUID()}`.toUpperCase()
      await service.importLicenseKeys({
        license_policy_id: policy.id,
        keys: [key],
      })
      const assignment = await service.assignLicenseKey({
        entitlement_id: entitlement.id,
        license_policy_id: policy.id,
        idempotency_key: `assignment-${randomUUID()}`,
      })
      return { product, policy, entitlement, key, assignment }
    }

    describe("frozen domain regressions", () => {
      it("rejects a license asset without an enabled generated or pool policy", async () => {
        const product = await createProduct(DigitalDeliveryMode.LICENSE)
        const release = await rawService.createDigitalProductReleases({
          digital_product_id: product.id,
          version: "1.0.0",
          status: DigitalReleaseStatus.READY,
        })
        const body = Buffer.from(`license-asset:${product.id}`)
        const storageKey = `regressions/${product.id}/license/${randomUUID()}.txt`
        const stored = await service.storeAssetObject({
          key: storageKey,
          body,
          mime_type: "text/plain",
        })
        await rawService.createDigitalAssets({
          release_id: release.id,
          name: "License instructions",
          role: DigitalAssetRole.LICENSE,
          kind: DigitalAssetKind.FILE,
          status: DigitalAssetStatus.READY,
          delivery_type: DigitalDeliveryMode.LICENSE,
          storage_provider: DigitalStorageProvider.LOCAL,
          storage_key: storageKey,
          storage_bucket: null,
          original_filename: "license.txt",
          mime_type: "text/plain",
          size_bytes: stored.size,
          checksum_sha256: stored.checksumSha256,
          is_enabled: true,
        })

        await expect(
          service.publishDigitalProductRelease(release.id),
        ).rejects.toThrow(/ready deliverables for license delivery/)
      })

      it.each([
        {
          initialRole: DigitalAssetRole.DOWNLOAD,
          initialDeliveryType: DigitalDeliveryMode.DOWNLOAD,
          targetRole: DigitalAssetRole.STREAM,
          targetDeliveryType: DigitalDeliveryMode.STREAM,
          productDeliveryType: DigitalDeliveryMode.STREAM,
          action: "stream" as const,
        },
        {
          initialRole: DigitalAssetRole.STREAM,
          initialDeliveryType: DigitalDeliveryMode.STREAM,
          targetRole: DigitalAssetRole.DOWNLOAD,
          targetDeliveryType: DigitalDeliveryMode.DOWNLOAD,
          productDeliveryType: DigitalDeliveryMode.DOWNLOAD,
          action: "download" as const,
        },
      ])(
        "keeps $targetRole role and delivery authorization aligned through publication",
        async ({
          initialRole,
          initialDeliveryType,
          targetRole,
          targetDeliveryType,
          productDeliveryType,
          action,
        }) => {
          const product = await createProduct(productDeliveryType)
          const release = await rawService.createDigitalProductReleases({
            digital_product_id: product.id,
            version: `role-transition-${randomUUID()}`,
            status: DigitalReleaseStatus.READY,
          })
          const body = Buffer.from(`role-transition:${product.id}:${targetRole}`)
          const storageKey = `regressions/${product.id}/role/${randomUUID()}.bin`
          const stored = await service.storeAssetObject({
            key: storageKey,
            body,
            mime_type: "application/octet-stream",
          })
          const asset = await rawService.createDigitalAssets({
            release_id: release.id,
            name: "Role transition asset",
            role: initialRole,
            kind: DigitalAssetKind.FILE,
            status: DigitalAssetStatus.READY,
            delivery_type: initialDeliveryType,
            storage_provider: DigitalStorageProvider.LOCAL,
            storage_key: storageKey,
            storage_bucket: null,
            original_filename: "role-transition.bin",
            mime_type: "application/octet-stream",
            size_bytes: stored.size,
            checksum_sha256: stored.checksumSha256,
            is_enabled: true,
          })

          await service.updateDigitalAssets({ id: asset.id, role: targetRole })
          const updated = await rawService.retrieveDigitalAsset(asset.id)
          expect(updated).toMatchObject({
            role: targetRole,
            delivery_type: targetDeliveryType,
          })

          const published = await service.publishDigitalProductRelease(release.id)
          const [entitlement] = await service.issueOrderEntitlements({
            order_id: `order_role_${randomUUID()}`,
            customer_id: `cus_role_${randomUUID()}`,
            customer_email: "role-transition@example.test",
            items: [
              {
                digital_product_id: product.id,
                release_id: published.id,
                order_line_item_id: `item_role_${randomUUID()}`,
              },
            ],
          })
          const issued = await service.createDownloadGrant({
            entitlement_id: entitlement.id,
            asset_id: asset.id,
            action,
            idempotency_key: `role-grant-${randomUUID()}`,
          })

          expect(issued.grant).toMatchObject({
            entitlement_id: entitlement.id,
            asset_id: asset.id,
            metadata: expect.objectContaining({ action }),
          })
        },
      )

      it("rolls back guest rotation when the replacement notification cannot be persisted", async () => {
        const fixture = await createDownloadFixture({ customerId: null })
        const beforeSessions = await rawService.listEntitlementAccessSessions({
          entitlement_id: fixture.entitlement.id,
        })
        expect(beforeSessions).toEqual([
          expect.objectContaining({ status: AccessSessionStatus.ACTIVE }),
        ])

        const manager = MikroOrmWrapper.getManager().fork()
        await manager.execute(
          `alter table "notification_delivery" add constraint "CK_test_reissue_outbox_failure" check ("template" <> 'digital-downloads-reissued')`,
        )
        try {
          await expect(
            service.reissueEntitlement({
              entitlement_id: fixture.entitlement.id,
              reason: "Failure injection",
              rotate_guest_token: true,
              create_guest_access: false,
              notify: true,
            }),
          ).rejects.toBeDefined()
        } finally {
          await manager.execute(
            `alter table "notification_delivery" drop constraint if exists "CK_test_reissue_outbox_failure"`,
          )
        }

        const entitlement = await rawService.retrieveDigitalEntitlement(
          fixture.entitlement.id,
        )
        const afterSessions = await rawService.listEntitlementAccessSessions({
          entitlement_id: fixture.entitlement.id,
        })
        expect(entitlement.metadata?.last_reissue_id).toBeUndefined()
        expect(afterSessions).toEqual([
          expect.objectContaining({
            id: beforeSessions[0].id,
            status: AccessSessionStatus.ACTIVE,
          }),
        ])
        await expect(
          rawService.listNotificationDeliveries({
            entitlement_id: fixture.entitlement.id,
            template: "digital-downloads-reissued",
          }),
        ).resolves.toHaveLength(0)
      })

      it("keeps a due entitlement active for expiry retry when its outbox write fails", async () => {
        const fixture = await createDownloadFixture()
        const dueAt = new Date(Date.now() - 60_000)
        await rawService.updateDigitalEntitlements({
          id: fixture.entitlement.id,
          expires_at: dueAt,
        })

        const manager = MikroOrmWrapper.getManager().fork()
        await manager.execute(
          `alter table "notification_delivery" add constraint "CK_test_expiry_outbox_failure" check ("template" <> 'digital-downloads-expired')`,
        )
        try {
          await expect(
            service.expireEntitlement(fixture.entitlement.id),
          ).rejects.toBeDefined()
        } finally {
          await manager.execute(
            `alter table "notification_delivery" drop constraint if exists "CK_test_expiry_outbox_failure"`,
          )
        }

        const entitlement = await rawService.retrieveDigitalEntitlement(
          fixture.entitlement.id,
        )
        expect(entitlement).toMatchObject({
          status: DigitalEntitlementStatus.ACTIVE,
        })
        expect(new Date(entitlement.expires_at).getTime()).toBe(dueAt.getTime())
        expect(entitlement.metadata?.last_expiration_id).toBeUndefined()
        await expect(
          rawService.listNotificationDeliveries({
            entitlement_id: fixture.entitlement.id,
            template: "digital-downloads-expired",
          }),
        ).resolves.toHaveLength(0)

        const retried = await service.expireEntitlement(fixture.entitlement.id)
        const expiryKey = retried.delivery?.idempotency_key
        expect(retried).toMatchObject({
          entitlement: { status: DigitalEntitlementStatus.EXPIRED },
          delivery: {
            idempotency_key: expect.stringMatching(
              new RegExp(`^${fixture.entitlement.id}:expired:[0-9a-f-]{36}$`),
            ),
            template: "digital-downloads-expired",
          },
        })
        await expect(
          rawService.listNotificationDeliveries({
            idempotency_key: expiryKey,
          }),
        ).resolves.toHaveLength(1)
      })

      it("renews expired access and creates one retryable notice per expiry cycle", async () => {
        const fixture = await createDownloadFixture()
        const now = Date.now()
        const purchasedAt = new Date(now - 2 * 86_400_000)
        const firstExpiry = new Date(now - 86_400_000)
        const manager = MikroOrmWrapper.getManager().fork()
        await manager.execute(
          `update "digital_entitlement" set "created_at" = '${purchasedAt.toISOString()}', "expires_at" = '${firstExpiry.toISOString()}' where "id" = '${fixture.entitlement.id}'`,
        )

        const first = await service.expireEntitlement(fixture.entitlement.id)
        const reissued = await service.reissueEntitlement({
          entitlement_id: fixture.entitlement.id,
          notify: false,
        })
        expect(reissued.entitlement.status).toBe(DigitalEntitlementStatus.ACTIVE)
        expect(new Date(reissued.entitlement.expires_at).getTime()).toBeGreaterThan(
          Date.now() + 86_300_000,
        )

        await rawService.updateDigitalEntitlements({
          id: fixture.entitlement.id,
          expires_at: new Date(Date.now() - 1),
          metadata: {
            ...(reissued.entitlement.metadata ?? {}),
            last_reissued_at: new Date(
              Date.now() - 86_400_001,
            ).toISOString(),
          },
        })
        const second = await service.expireEntitlement(fixture.entitlement.id)
        expect(second.delivery?.idempotency_key).not.toBe(
          first.delivery?.idempotency_key,
        )
        await expect(
          rawService.listNotificationDeliveries({
            entitlement_id: fixture.entitlement.id,
            template: "digital-downloads-expired",
          }),
        ).resolves.toHaveLength(2)

        const secondReissue = await service.reissueEntitlement({
          entitlement_id: fixture.entitlement.id,
          notify: false,
        })
        expect(
          new Date(secondReissue.entitlement.expires_at).getTime(),
        ).toBeGreaterThan(Date.now() + 86_300_000)
      })

      it("persists the exact explicit future deadline when reissuing", async () => {
        const fixture = await createDownloadFixture()
        const manager = MikroOrmWrapper.getManager().fork()
        await manager.execute(
          `update "digital_entitlement" set "expires_at" = now() - interval '1 day', "metadata" = '{}'::jsonb where "id" = '${fixture.entitlement.id}'`,
        )
        const staleScanCutoff = new Date()
        const replacementExpiry = new Date(Date.now() + 45 * 86_400_000)

        const reissued = await service.reissueEntitlement({
          entitlement_id: fixture.entitlement.id,
          expires_at: replacementExpiry.toISOString(),
          notify: false,
        })

        expect(reissued.entitlement.status).toBe(
          DigitalEntitlementStatus.ACTIVE,
        )
        expect(new Date(reissued.entitlement.expires_at).getTime()).toBe(
          replacementExpiry.getTime(),
        )
        await expect(
          rawService.retrieveDigitalEntitlement(fixture.entitlement.id),
        ).resolves.toMatchObject({
          expires_at: replacementExpiry,
        })
        await expect(
          service.expireEntitlementIfDue({
            entitlement_id: fixture.entitlement.id,
            as_of: staleScanCutoff,
          }),
        ).resolves.toMatchObject({
          entitlement: { status: DigitalEntitlementStatus.ACTIVE },
          expired: false,
        })
      })

      it("reconciles a legacy expired row without a seeded cycle exactly once", async () => {
        const fixture = await createDownloadFixture()
        const manager = MikroOrmWrapper.getManager().fork()
        await manager.execute(
          `update "digital_entitlement" set "status" = 'expired', "expires_at" = now() - interval '1 day', "metadata" = '{}'::jsonb where "id" = '${fixture.entitlement.id}'`,
        )

        const before = await service.listLifecycleNotificationRepairCandidates({
          limit: 10,
        })
        expect(before).toContainEqual({
          id: fixture.entitlement.id,
          status: DigitalEntitlementStatus.EXPIRED,
          reason: "Entitlement access period expired",
        })

        const repairInput = {
          entitlement_id: fixture.entitlement.id,
          expected_status: DigitalEntitlementStatus.EXPIRED,
          reason: "Entitlement access period expired",
        } as const
        const [first, concurrentReplay] = await Promise.all([
          service.repairLifecycleNotification(repairInput),
          service.repairLifecycleNotification(repairInput),
        ])
        expect(first).toMatchObject({
          repaired: true,
          entitlement: {
            id: fixture.entitlement.id,
            status: DigitalEntitlementStatus.EXPIRED,
          },
          delivery: {
            idempotency_key: expect.stringMatching(
              new RegExp(`^${fixture.entitlement.id}:expired:[0-9a-f-]{36}$`),
            ),
          },
        })
        expect(concurrentReplay.delivery?.id).toBe(first.delivery?.id)
        await expect(
          service.listLifecycleNotificationRepairCandidates({ limit: 10 }),
        ).resolves.not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: fixture.entitlement.id }),
          ]),
        )

        const replay = await service.repairLifecycleNotification(repairInput)
        expect(replay.delivery?.id).toBe(first.delivery?.id)
        await expect(
          rawService.listNotificationDeliveries({
            entitlement_id: fixture.entitlement.id,
            template: "digital-downloads-expired",
          }),
        ).resolves.toHaveLength(1)
      })

      it("does not let invalid legacy email or reason starve lifecycle repair", async () => {
        const invalidEmail = await createDownloadFixture()
        const malformedReason = await createDownloadFixture()
        const manager = MikroOrmWrapper.getManager().fork()
        await manager.execute(
          `update "digital_entitlement" set "status" = 'expired', "customer_email" = ' INVALID ', "metadata" = '{}'::jsonb, "updated_at" = now() - interval '2 days' where "id" = '${invalidEmail.entitlement.id}'`,
        )
        await manager.execute(
          `update "digital_entitlement" set "status" = 'revoked', "revoke_reason" = E'unsafe\\nreason', "metadata" = '{}'::jsonb, "updated_at" = now() - interval '1 day' where "id" = '${malformedReason.entitlement.id}'`,
        )

        const candidates = await service.listLifecycleNotificationRepairCandidates({
          limit: 1,
        })
        expect(candidates).toEqual([
          {
            id: malformedReason.entitlement.id,
            status: DigitalEntitlementStatus.REVOKED,
            reason: "Lifecycle notification reconciliation",
          },
        ])
        await expect(
          service.repairLifecycleNotification({
            entitlement_id: candidates[0].id,
            expected_status: candidates[0].status,
            reason: candidates[0].reason,
          }),
        ).resolves.toMatchObject({ repaired: true })
      })

      it("treats an invalid stored cycle as legacy without requeueing its v1 outbox", async () => {
        const fixture = await createDownloadFixture()
        const manager = MikroOrmWrapper.getManager().fork()
        await manager.execute(
          `update "digital_entitlement" set "status" = 'expired', "metadata" = jsonb_build_object('last_expiration_id', E'unsafe\\ncycle') where "id" = '${fixture.entitlement.id}'`,
        )
        await rawService.createNotificationDeliveries({
          entitlement_id: fixture.entitlement.id,
          idempotency_key: `${fixture.entitlement.id}:expired:v1`,
          channel: "email",
          template: "digital-downloads-expired",
          recipient_hash: "legacy-cycle-recipient",
          state: "sent",
          attempt_count: 1,
          max_attempts: 8,
          payload: {},
          metadata: {},
        })

        await expect(
          service.listLifecycleNotificationRepairCandidates({ limit: 10 }),
        ).resolves.not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: fixture.entitlement.id }),
          ]),
        )
        await expect(
          service.repairLifecycleNotification({
            entitlement_id: fixture.entitlement.id,
            expected_status: DigitalEntitlementStatus.EXPIRED,
            reason: "Entitlement access period expired",
          }),
        ).resolves.toMatchObject({
          delivery: {
            idempotency_key: `${fixture.entitlement.id}:expired:v1`,
          },
          repaired: true,
        })
        await expect(
          rawService.listNotificationDeliveries({
            entitlement_id: fixture.entitlement.id,
            template: "digital-downloads-expired",
          }),
        ).resolves.toHaveLength(1)
      })

      it("repairs a missing current-cycle or soft-deleted expiry outbox", async () => {
        const fixture = await createDownloadFixture()
        const manager = MikroOrmWrapper.getManager().fork()
        const currentCycle = randomUUID()
        await manager.execute(
          `update "digital_entitlement" set "status" = 'expired', "metadata" = jsonb_build_object('last_expiration_id', '${currentCycle}') where "id" = '${fixture.entitlement.id}'`,
        )
        await rawService.createNotificationDeliveries({
          entitlement_id: fixture.entitlement.id,
          idempotency_key: `${fixture.entitlement.id}:expired:older-cycle`,
          channel: "email",
          template: "digital-downloads-expired",
          recipient_hash: "older-cycle-recipient",
          state: "sent",
          attempt_count: 1,
          max_attempts: 8,
          payload: {},
          metadata: {},
        })

        await expect(
          service.listLifecycleNotificationRepairCandidates({ limit: 10 }),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: fixture.entitlement.id }),
          ]),
        )
        const repaired = await service.repairLifecycleNotification({
          entitlement_id: fixture.entitlement.id,
          expected_status: DigitalEntitlementStatus.EXPIRED,
          reason: "Entitlement access period expired",
        })
        expect(repaired.delivery?.idempotency_key).toBe(
          `${fixture.entitlement.id}:expired:${currentCycle}`,
        )

        await rawService.updateNotificationDeliveries({
          id: repaired.delivery.id,
          state: "sent",
          sent_at: new Date(),
        })
        await expect(
          service.listLifecycleNotificationRepairCandidates({ limit: 10 }),
        ).resolves.not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: fixture.entitlement.id }),
          ]),
        )

        await manager.execute(
          `update "notification_delivery" set "deleted_at" = now() where "id" = '${repaired.delivery.id}'`,
        )
        await expect(
          service.listLifecycleNotificationRepairCandidates({ limit: 10 }),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: fixture.entitlement.id }),
          ]),
        )
        const recreated = await service.repairLifecycleNotification({
          entitlement_id: fixture.entitlement.id,
          expected_status: DigitalEntitlementStatus.EXPIRED,
          reason: "Entitlement access period expired",
        })
        expect(recreated.delivery?.id).not.toBe(repaired.delivery?.id)
        expect(recreated.delivery?.idempotency_key).toBe(
          repaired.delivery?.idempotency_key,
        )
        await expect(
          rawService.listNotificationDeliveries({
            idempotency_key: repaired.delivery?.idempotency_key,
          }),
        ).resolves.toHaveLength(1)
      })

      it("retries missing legacy revoked and refunded outboxes without duplicates", async () => {
        const revokedFixture = await createDownloadFixture()
        const refundedFixture = await createDownloadFixture()
        await service.revokeEntitlement(
          revokedFixture.entitlement.id,
          "Legacy revocation",
        )
        await service.revokeEntitlement(
          refundedFixture.entitlement.id,
          "Legacy refund",
        )
        const manager = MikroOrmWrapper.getManager().fork()
        await manager.execute(
          `update "digital_entitlement" set "metadata" = '{}'::jsonb where "id" = '${revokedFixture.entitlement.id}'`,
        )
        await manager.execute(
          `update "digital_entitlement" set "status" = 'refunded', "metadata" = '{}'::jsonb where "id" = '${refundedFixture.entitlement.id}'`,
        )

        const candidates = await service.listLifecycleNotificationRepairCandidates({
          limit: 10,
        })
        expect(candidates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: revokedFixture.entitlement.id,
              status: DigitalEntitlementStatus.REVOKED,
            }),
            expect.objectContaining({
              id: refundedFixture.entitlement.id,
              status: DigitalEntitlementStatus.REFUNDED,
            }),
          ]),
        )

        await manager.execute(
          `alter table "notification_delivery" add constraint "CK_test_legacy_revocation_repair_failure" check ("template" <> 'digital-downloads-revoked')`,
        )
        try {
          await expect(
            service.repairLifecycleNotification({
              entitlement_id: revokedFixture.entitlement.id,
              expected_status: DigitalEntitlementStatus.REVOKED,
              reason: "Legacy revocation",
            }),
          ).rejects.toBeDefined()
        } finally {
          await manager.execute(
            `alter table "notification_delivery" drop constraint if exists "CK_test_legacy_revocation_repair_failure"`,
          )
        }
        await expect(
          rawService.retrieveDigitalEntitlement(revokedFixture.entitlement.id),
        ).resolves.toMatchObject({
          status: DigitalEntitlementStatus.REVOKED,
          metadata: expect.not.objectContaining({
            last_revocation_id: expect.anything(),
          }),
        })

        const repaired = []
        for (const candidate of candidates) {
          repaired.push(
            await service.repairLifecycleNotification({
              entitlement_id: candidate.id,
              expected_status: candidate.status,
              reason: candidate.reason,
            }),
          )
        }
        expect(repaired).toHaveLength(2)
        expect(repaired.every((result) => result.repaired)).toBe(true)
        await expect(
          rawService.retrieveDigitalEntitlement(revokedFixture.entitlement.id),
        ).resolves.toMatchObject({ status: DigitalEntitlementStatus.REVOKED })
        await expect(
          rawService.retrieveDigitalEntitlement(refundedFixture.entitlement.id),
        ).resolves.toMatchObject({ status: DigitalEntitlementStatus.REFUNDED })

        await expect(
          service.listLifecycleNotificationRepairCandidates({ limit: 10 }),
        ).resolves.toHaveLength(0)
        for (const fixture of [revokedFixture, refundedFixture]) {
          await expect(
            rawService.listNotificationDeliveries({
              entitlement_id: fixture.entitlement.id,
              template: "digital-downloads-revoked",
            }),
          ).resolves.toHaveLength(1)
        }

        for (const candidate of candidates) {
          await service.repairLifecycleNotification({
            entitlement_id: candidate.id,
            expected_status: candidate.status,
            reason: candidate.reason,
          })
        }
        for (const fixture of [revokedFixture, refundedFixture]) {
          await expect(
            rawService.listNotificationDeliveries({
              entitlement_id: fixture.entitlement.id,
              template: "digital-downloads-revoked",
            }),
          ).resolves.toHaveLength(1)
        }
      })

      it("rolls back an order-wide refund when any revocation outbox insert fails", async () => {
        const orderId = `order_atomic_${randomUUID()}`
        const first = await createDownloadFixture({ orderId })
        const second = await createDownloadFixture({ orderId })
        const manager = MikroOrmWrapper.getManager().fork()
        await manager.execute(
          `alter table "notification_delivery" add constraint "CK_test_order_revoke_outbox_failure" check ("template" <> 'digital-downloads-revoked' or "entitlement_id" <> '${second.entitlement.id}')`,
        )
        try {
          await expect(
            service.revokeOrderEntitlements({
              order_id: orderId,
              reason: "Atomic refund failure injection",
              trigger: "refund",
              notify: true,
            }),
          ).rejects.toBeDefined()
        } finally {
          await manager.execute(
            `alter table "notification_delivery" drop constraint if exists "CK_test_order_revoke_outbox_failure"`,
          )
        }

        for (const fixture of [first, second]) {
          await expect(
            rawService.retrieveDigitalEntitlement(fixture.entitlement.id),
          ).resolves.toMatchObject({ status: DigitalEntitlementStatus.ACTIVE })
          await expect(
            rawService.listNotificationDeliveries({
              entitlement_id: fixture.entitlement.id,
              template: "digital-downloads-revoked",
            }),
          ).resolves.toHaveLength(0)
        }

        const completed = await service.revokeOrderEntitlements({
          order_id: orderId,
          reason: "Atomic refund retry",
          trigger: "refund",
          notify: true,
        })
        expect(completed.revoked).toHaveLength(2)
        expect(
          completed.revoked.every(
            (entitlement) =>
              entitlement.status === DigitalEntitlementStatus.REFUNDED,
          ),
        ).toBe(true)
        expect(completed.deliveries).toHaveLength(2)

        await service.revokeOrderEntitlements({
          order_id: orderId,
          reason: "Atomic refund retry",
          trigger: "refund",
          notify: true,
        })
        for (const fixture of [first, second]) {
          await expect(
            rawService.listNotificationDeliveries({
              entitlement_id: fixture.entitlement.id,
              template: "digital-downloads-revoked",
            }),
          ).resolves.toHaveLength(1)
        }
      })

      it("keeps published and entitlement-pinned release history immutable", async () => {
        const fixture = await createDownloadFixture()

        await expect(
          rawService.updateDigitalAssets({
            id: fixture.asset.id,
            name: "Mutated historical name",
          }),
        ).rejects.toThrow(/immutable/)
        await expect(
          rawService.deleteDigitalAssets(fixture.asset.id),
        ).rejects.toThrow(/cannot be deleted/)
        await expect(
          rawService.createDigitalAssets({
            release_id: fixture.release.id,
            name: "Late attachment",
            role: DigitalAssetRole.DOWNLOAD,
            kind: DigitalAssetKind.FILE,
            status: DigitalAssetStatus.READY,
            delivery_type: DigitalDeliveryMode.DOWNLOAD,
            storage_provider: DigitalStorageProvider.LOCAL,
            storage_key: `late/${randomUUID()}.bin`,
            original_filename: "late.bin",
            mime_type: "application/octet-stream",
            size_bytes: 1,
            checksum_sha256: "0".repeat(64),
          }),
        ).rejects.toThrow(/immutable/)
        await expect(
          rawService.updateDigitalProductReleases({
            id: fixture.release.id,
            release_notes: "rewritten history",
          }),
        ).rejects.toThrow(/immutable/)
        await expect(
          rawService.deleteDigitalProductReleases(fixture.release.id),
        ).rejects.toThrow(/cannot be deleted/)

        const next = await createDownloadRelease(fixture.product, "2.0.0")
        const pinned = await rawService.retrieveDigitalEntitlement(
          fixture.entitlement.id,
        )
        expect(pinned.release_id).toBe(fixture.release.id)
        expect(
          await rawService.retrieveDigitalProductRelease(fixture.release.id),
        ).toMatchObject({ status: DigitalReleaseStatus.RETIRED })
        await expect(
          service.createDownloadGrant({
            entitlement_id: fixture.entitlement.id,
            asset_id: fixture.asset.id,
            idempotency_key: `historical-${randomUUID()}`,
          }),
        ).resolves.toMatchObject({ created: true })
        await expect(
          service.createDownloadGrant({
            entitlement_id: fixture.entitlement.id,
            asset_id: next.asset.id,
            idempotency_key: `wrong-release-${randomUUID()}`,
          }),
        ).rejects.toThrow(/entitled release/)
      })

      it("rejects oversized quantity before allocating any entitlement rows", async () => {
        const fixture = await createDownloadFixture()
        const orderId = `order_cap_${randomUUID()}`

        await expect(
          service.issueOrderEntitlements({
            order_id: orderId,
            customer_email: "cap@example.test",
            items: [
              {
                digital_product_id: fixture.product.id,
                release_id: fixture.release.id,
                order_line_item_id: "item_cap_a",
                quantity: 10_000,
              },
              {
                digital_product_id: fixture.product.id,
                release_id: fixture.release.id,
                order_line_item_id: "item_cap_b",
                quantity: 1,
              },
            ],
          }),
        ).rejects.toThrow(/cannot exceed 10000/)
        expect(
          await rawService.listDigitalEntitlements({ order_id: orderId }),
        ).toHaveLength(0)
      })

      it("fingerprints the complete grant request and safely replays omitted defaults", async () => {
        const fixture = await createDownloadFixture()
        const idempotencyKey = `grant-fingerprint-${randomUUID()}`
        const request = {
          entitlement_id: fixture.entitlement.id,
          asset_id: fixture.asset.id,
          idempotency_key: idempotencyKey,
          ttl_seconds: 120,
          max_uses: 2,
          action: "download" as const,
          bind_ip: "203.0.113.20",
          bind_user_agent: "Regression Agent/1.0",
        }
        const created = await service.createDownloadGrant(request)
        const replay = await service.createDownloadGrant(request)
        expect(replay).toMatchObject({
          created: false,
          token: created.token,
          grant: { id: created.grant.id },
        })
        for (const changed of [
          { ...request, ttl_seconds: 121 },
          { ...request, max_uses: 3 },
          { ...request, bind_ip: "203.0.113.21" },
          { ...request, bind_user_agent: "Regression Agent/2.0" },
        ]) {
          await expect(service.createDownloadGrant(changed)).rejects.toThrow(
            /another grant request/,
          )
        }
        const stored = await rawService.retrieveDownloadGrant(created.grant.id)
        expect(stored.metadata.request_fingerprint).toMatch(/^[a-f0-9]{64}$/)
        expect(stored.bound_ip_hash).toMatch(/^[a-f0-9]{64}$/)
        expect(stored.bound_user_agent_hash).toMatch(/^[a-f0-9]{64}$/)
        expect(JSON.stringify(stored)).not.toContain("203.0.113.20")
        expect(JSON.stringify(stored)).not.toContain("Regression Agent/1.0")
        expect(stored.token_hash).not.toBe(created.token)

        const defaultKey = `grant-default-${randomUUID()}`
        const defaultGrant = await service.createDownloadGrant({
          entitlement_id: fixture.entitlement.id,
          asset_id: fixture.asset.id,
          idempotency_key: defaultKey,
        })
        await service.updateSettings({ default_grant_ttl_seconds: 120 })
        await expect(
          service.createDownloadGrant({
            entitlement_id: fixture.entitlement.id,
            asset_id: fixture.asset.id,
            idempotency_key: defaultKey,
          }),
        ).resolves.toMatchObject({
          created: false,
          token: defaultGrant.token,
          grant: { id: defaultGrant.grant.id },
        })
      })

      it("serializes completion and revocation without invalid transfer states", async () => {
        const revokedFirst = await createDownloadFixture()
        const grantA = await service.createDownloadGrant({
          entitlement_id: revokedFirst.entitlement.id,
          asset_id: revokedFirst.asset.id,
          idempotency_key: `revoke-first-${randomUUID()}`,
        })
        const transferA = await service.redeemDownloadGrant(grantA.token, {
          asset_id: revokedFirst.asset.id,
        })
        await service.revokeEntitlement(revokedFirst.entitlement.id, "refund")
        await expect(
          service.completeDownloadGrant(transferA.event_id, {
            bytes_transferred: revokedFirst.body.length,
          }),
        ).rejects.toThrow(/not active|no longer active/)
        await expect(
          service.failDownloadGrant(transferA.event_id, { reason: "revoked" }),
        ).resolves.toMatchObject({
          event: { event_type: DownloadEventType.TRANSFER_FAILED },
        })

        const completedFirst = await createDownloadFixture()
        const grantB = await service.createDownloadGrant({
          entitlement_id: completedFirst.entitlement.id,
          asset_id: completedFirst.asset.id,
          idempotency_key: `complete-first-${randomUUID()}`,
        })
        const transferB = await service.redeemDownloadGrant(grantB.token, {
          asset_id: completedFirst.asset.id,
        })
        await service.completeDownloadGrant(transferB.event_id, {
          bytes_transferred: completedFirst.body.length,
        })
        await expect(
          service.failDownloadGrant(transferB.event_id, { reason: "too late" }),
        ).rejects.toThrow(/in-progress/)
        await service.revokeEntitlement(completedFirst.entitlement.id, "refund")
        expect(
          await rawService.retrieveDigitalEntitlement(completedFirst.entitlement.id),
        ).toMatchObject({
          status: DigitalEntitlementStatus.REVOKED,
          download_count: 1,
        })

        const raced = await createDownloadFixture()
        const grantC = await service.createDownloadGrant({
          entitlement_id: raced.entitlement.id,
          asset_id: raced.asset.id,
          idempotency_key: `race-revoke-${randomUUID()}`,
        })
        const transferC = await service.redeemDownloadGrant(grantC.token, {
          asset_id: raced.asset.id,
        })
        const [completion, revocation] = await Promise.allSettled([
          service.completeDownloadGrant(transferC.event_id, {
            bytes_transferred: raced.body.length,
          }),
          service.revokeEntitlement(raced.entitlement.id, "concurrent refund"),
        ])
        expect(revocation.status).toBe("fulfilled")
        const finalEntitlement = await rawService.retrieveDigitalEntitlement(
          raced.entitlement.id,
        )
        const finalGrant = await rawService.retrieveDownloadGrant(grantC.grant.id)
        const finalEvent = await rawService.retrieveDownloadEvent(transferC.event_id)
        expect(finalEntitlement.status).toBe(DigitalEntitlementStatus.REVOKED)
        expect(finalGrant.status).toBe(DownloadGrantStatus.REVOKED)
        if (completion.status === "fulfilled") {
          expect(finalEntitlement.download_count).toBe(1)
          expect(finalEvent.event_type).toBe(DownloadEventType.TRANSFER_COMPLETED)
        } else {
          expect(finalEntitlement.download_count).toBe(0)
          expect(finalEvent.event_type).toBe(DownloadEventType.TRANSFER_STARTED)
          await service.failDownloadGrant(finalEvent.id, { reason: "revoked" })
        }
      })

      it("allows failure only from TRANSFER_STARTED and keeps it idempotent", async () => {
        const fixture = await createDownloadFixture()
        const grant = await service.createDownloadGrant({
          entitlement_id: fixture.entitlement.id,
          asset_id: fixture.asset.id,
          idempotency_key: `state-machine-${randomUUID()}`,
        })
        const grantedEvents = await rawService.listDownloadEvents({
          grant_id: grant.grant.id,
          event_type: DownloadEventType.GRANTED,
        })
        await expect(
          service.failDownloadGrant(grantedEvents[0].id, { reason: "invalid" }),
        ).rejects.toThrow(/in-progress/)

        const transfer = await service.redeemDownloadGrant(grant.token, {
          asset_id: fixture.asset.id,
        })
        const failed = await service.failDownloadGrant(transfer.event_id, {
          reason: "network failure",
        })
        expect(failed.event.event_type).toBe(DownloadEventType.TRANSFER_FAILED)
        await expect(
          service.failDownloadGrant(transfer.event_id, { reason: "retry" }),
        ).resolves.toMatchObject({
          event: { event_type: DownloadEventType.TRANSFER_FAILED },
        })
        await expect(
          service.completeDownloadGrant(transfer.event_id),
        ).rejects.toThrow(/committable state/)
      })

      it("opens range continuation for exactly fifteen minutes and denies it after expiry", async () => {
        const fixture = await createDownloadFixture()
        const grant = await service.createDownloadGrant({
          entitlement_id: fixture.entitlement.id,
          asset_id: fixture.asset.id,
          idempotency_key: `continuation-${randomUUID()}`,
          max_uses: 1,
        })
        const first = await service.redeemDownloadGrant(grant.token, {
          asset_id: fixture.asset.id,
          range: { start: 0, end: 3 },
        })
        const beforeCompletion = Date.now()
        await service.completeDownloadGrant(first.event_id, { bytes_transferred: 4 })
        const afterCompletion = Date.now()
        const stored = await rawService.retrieveDownloadGrant(grant.grant.id)
        const startedAt = new Date(stored.continuation_started_at).getTime()
        const expiresAt = new Date(stored.continuation_expires_at).getTime()
        expect(startedAt).toBeGreaterThanOrEqual(beforeCompletion)
        expect(startedAt).toBeLessThanOrEqual(afterCompletion)
        expect(expiresAt - startedAt).toBe(15 * 60 * 1000)

        await expect(
          service.redeemDownloadGrant(grant.token, {
            asset_id: fixture.asset.id,
            range: { start: 4, end: 7 },
          }),
        ).resolves.toMatchObject({ authorized: true })
        await rawService.updateDownloadGrants({
          id: grant.grant.id,
          continuation_expires_at: new Date(Date.now() - 1),
        })
        await expect(
          service.redeemDownloadGrant(grant.token, {
            asset_id: fixture.asset.id,
            range: { start: 8, end: 11 },
          }),
        ).rejects.toThrow(/exhausted/)
      })

      it("delivers guest capability once, stores only its hash, and rotates it on reissue", async () => {
        const fixture = await createDownloadFixture({ customerId: null })
        const firstToken = fixture.entitlement.guest_access.token as string
        expect(firstToken).toMatch(/^dda_/)
        const replay = await service.issueOrderEntitlements({
          order_id: fixture.entitlement.order_id,
          customer_id: null,
          customer_email: "buyer@example.test",
          items: [
            {
              digital_product_id: fixture.product.id,
              release_id: fixture.release.id,
              order_line_item_id: fixture.entitlement.order_line_item_id,
            },
          ],
        })
        expect(replay[0].guest_access.token).toBe(firstToken)
        const before = await rawService.listEntitlementAccessSessions({
          entitlement_id: fixture.entitlement.id,
        })
        expect(before).toHaveLength(1)
        expect(before[0].token_hash).toMatch(/^[a-f0-9]{64}$/)
        expect(before[0].token_hash).not.toBe(firstToken)
        expect(JSON.stringify(before[0])).not.toContain(firstToken)
        expect(JSON.stringify(await rawService.retrieveDigitalEntitlement(
          fixture.entitlement.id,
        ))).not.toContain(firstToken)

        const reissued = await service.reissueEntitlement({
          entitlement_id: fixture.entitlement.id,
          reason: "customer recovery",
          rotate_guest_token: true,
        })
        const secondToken = reissued.guest_access?.token as string
        expect(secondToken).toMatch(/^dda_/)
        expect(secondToken).not.toBe(firstToken)
        await expect(
          service.resolveGuestEntitlement(firstToken, {
            email: "buyer@example.test",
          }),
        ).rejects.toThrow(/inactive/)
        await expect(
          service.resolveGuestEntitlement(secondToken, {
            email: " BUYER@Example.test ",
          }),
        ).resolves.toMatchObject({
          entitlement: { id: fixture.entitlement.id },
        })
        const after = await rawService.listEntitlementAccessSessions({
          entitlement_id: fixture.entitlement.id,
        })
        expect(after).toHaveLength(2)
        expect(after.map((row: any) => row.status).sort()).toEqual([
          AccessSessionStatus.ACTIVE,
          AccessSessionStatus.REVOKED,
        ])
        expect(JSON.stringify(after)).not.toContain(firstToken)
        expect(JSON.stringify(after)).not.toContain(secondToken)
      })

      it("requires the normalized order email before consuming a guest capability", async () => {
        const fixture = await createDownloadFixture({ customerId: null })
        const token = fixture.entitlement.guest_access.token as string
        const sessionId = fixture.entitlement.guest_access.session.id as string

        await expect(
          service.resolveGuestEntitlement(token),
        ).rejects.toThrow(/credentials are invalid/)
        await expect(
          service.resolveGuestEntitlement(token, {
            email: "attacker@example.test",
          }),
        ).rejects.toThrow(/credentials are invalid/)
        expect(
          await rawService.retrieveEntitlementAccessSession(sessionId),
        ).toMatchObject({
          status: AccessSessionStatus.ACTIVE,
          use_count: 0,
        })

        await expect(
          service.resolveGuestEntitlement(token, {
            email: "  BUYER@EXAMPLE.TEST  ",
          }),
        ).resolves.toMatchObject({
          entitlement: { id: fixture.entitlement.id },
          session: { id: sessionId, use_count: 1 },
        })
      })

      it("binds guest grants to one active session and rejects revoked, expired, or foreign sessions", async () => {
        const fixture = await createDownloadFixture({ customerId: null })
        const createSession = (label: string) =>
          service.createGuestAccessSession({
            entitlement_id: fixture.entitlement.id,
            idempotency_key: `guest-grant-${label}-${randomUUID()}`,
          })
        const activeA = await createSession("active-a")
        const activeB = await createSession("active-b")
        const revoked = await createSession("revoked")
        const expired = await createSession("expired")

        await service.revokeGuestAccessSession(
          String(revoked.session.id),
          "security regression",
        )
        await rawService.updateEntitlementAccessSessions({
          id: expired.session.id,
          expires_at: new Date(Date.now() - 1_000),
        })

        for (const [label, sessionId] of [
          ["revoked", revoked.session.id],
          ["expired", expired.session.id],
        ] as const) {
          await expect(
            service.createDownloadGrant({
              entitlement_id: fixture.entitlement.id,
              asset_id: fixture.asset.id,
              guest_session_id: String(sessionId),
              idempotency_key: `guest-${label}-${randomUUID()}`,
            }),
          ).rejects.toThrow(/session is inactive/)
        }

        const foreign = await createDownloadFixture({ customerId: null })
        const foreignSession = await service.createGuestAccessSession({
          entitlement_id: foreign.entitlement.id,
          idempotency_key: `guest-grant-foreign-${randomUUID()}`,
        })
        await expect(
          service.createDownloadGrant({
            entitlement_id: fixture.entitlement.id,
            asset_id: fixture.asset.id,
            guest_session_id: String(foreignSession.session.id),
            idempotency_key: `guest-foreign-${randomUUID()}`,
          }),
        ).rejects.toThrow(/session is inactive/)

        const idempotencyKey = `guest-session-binding-${randomUUID()}`
        const first = await service.createDownloadGrant({
          entitlement_id: fixture.entitlement.id,
          asset_id: fixture.asset.id,
          guest_session_id: String(activeA.session.id),
          idempotency_key: idempotencyKey,
        })
        await expect(
          service.createDownloadGrant({
            entitlement_id: fixture.entitlement.id,
            asset_id: fixture.asset.id,
            guest_session_id: String(activeA.session.id),
            idempotency_key: idempotencyKey,
          }),
        ).resolves.toMatchObject({
          created: false,
          token: first.token,
          grant: { id: first.grant.id },
        })
        await expect(
          service.createDownloadGrant({
            entitlement_id: fixture.entitlement.id,
            asset_id: fixture.asset.id,
            guest_session_id: String(activeB.session.id),
            idempotency_key: idempotencyKey,
          }),
        ).rejects.toThrow(/another grant request/)
      })

      it("cannot mint from a previously resolved guest session after revocation linearizes", async () => {
        const fixture = await createDownloadFixture({ customerId: null })
        const session = await service.createGuestAccessSession({
          entitlement_id: fixture.entitlement.id,
          idempotency_key: `guest-race-${randomUUID()}`,
        })
        const sessionId = String(session.session.id)
        const grantKey = `guest-race-grant-${randomUUID()}`
        const resolvedBeforeRevocation = await service.resolveGuestEntitlement(
          session.token,
          { email: "buyer@example.test" },
        )
        expect(resolvedBeforeRevocation.session).toMatchObject({ id: sessionId })

        await service.revokeGuestAccessSession(
          sessionId,
          "concurrent rotation",
        )
        await expect(
          service.createDownloadGrant({
            entitlement_id: fixture.entitlement.id,
            asset_id: fixture.asset.id,
            guest_session_id: String(resolvedBeforeRevocation.session.id),
            idempotency_key: grantKey,
          }),
        ).rejects.toMatchObject({
          type: "unauthorized",
          message: expect.stringMatching(/session is inactive/),
        })
        expect(
          await rawService.listDownloadGrants({ idempotency_key: grantKey }),
        ).toHaveLength(0)
      })

      it("keeps one settings row and prevents API-level fingerprint rotation", async () => {
        const [first, second] = await Promise.all([
          service.getSettings(),
          service.getSettings(),
        ])
        expect(second.id).toBe(first.id)
        expect(first.singleton_key).toBe("global")
        expect(first.storage_namespace_fingerprint).toMatch(/^[a-f0-9]{64}$/)
        expect(first.token_secret_fingerprint).toMatch(/^[a-f0-9]{64}$/)
        expect(first.encryption_key_fingerprint).toMatch(/^[a-f0-9]{64}$/)

        const updated = await service.updateSettings({
          singleton_key: "attacker-controlled",
          storage_namespace_fingerprint: "0".repeat(64),
          token_secret_fingerprint: "1".repeat(64),
          encryption_key_fingerprint: "2".repeat(64),
          download_limit_default: 7,
        })
        expect(updated).toMatchObject({
          id: first.id,
          singleton_key: "global",
          storage_namespace_fingerprint: first.storage_namespace_fingerprint,
          token_secret_fingerprint: first.token_secret_fingerprint,
          encryption_key_fingerprint: first.encryption_key_fingerprint,
          default_download_limit: 7,
        })
        expect(await rawService.listDigitalDownloadsSettings({})).toHaveLength(1)
        await expect(
          rawService.createDigitalDownloadsSettings({ singleton_key: "global" }),
        ).rejects.toBeDefined()
      })

      it("requires device IDs when configured and rejects unsupported external policies", async () => {
        const required = await createLicenseFixture(true)
        await expect(
          service.validateLicenseByKey({ license_key: required.key }),
        ).resolves.toEqual({ valid: false, reason: "instance_required" })
        await expect(
          service.activateLicenseByKey({ license_key: required.key }),
        ).rejects.toThrow(/instance_id is required/)

        const optional = await createLicenseFixture(false)
        await expect(
          service.validateLicenseByKey({ license_key: optional.key }),
        ).resolves.toMatchObject({ valid: true })
        const product = await createProduct(DigitalDeliveryMode.LICENSE)
        await expect(
          rawService.createLicensePolicies({
            digital_product_id: product.id,
            strategy: LicenseStrategy.EXTERNAL,
            is_enabled: true,
          }),
        ).rejects.toThrow(/not supported/)
        expect(
          await rawService.listLicensePolicies({ digital_product_id: product.id }),
        ).toHaveLength(0)
      })

      it("keeps blocked license instances blocked across public activation and deactivation", async () => {
        const fixture = await createLicenseFixture(true)
        const activated = await service.activateLicenseByKey({
          license_key: fixture.key,
          instance_id: "blocked-device",
        })
        await rawService.updateLicenseActivations({
          id: activated.activation.id,
          status: LicenseActivationStatus.BLOCKED,
        })

        await expect(
          service.activateLicenseByKey({
            license_key: fixture.key,
            instance_id: "blocked-device",
          }),
        ).rejects.toThrow(/instance is blocked/)
        await expect(
          service.deactivateLicenseByKey({
            license_key: fixture.key,
            instance_id: "blocked-device",
          }),
        ).resolves.toMatchObject({
          deactivated: false,
          activation: { status: LicenseActivationStatus.BLOCKED },
        })
        expect(
          await rawService.retrieveLicenseActivation(activated.activation.id),
        ).toMatchObject({ status: LicenseActivationStatus.BLOCKED })
        expect(
          await rawService.retrieveLicenseAssignment(
            fixture.assignment.assignment.id,
          ),
        ).toMatchObject({ activation_count: 1 })
      })

      it("cleans active devices before reusing a revoked assignment for a replacement key", async () => {
        const fixture = await createLicenseFixture(true)
        const active = await service.activateLicenseByKey({
          license_key: fixture.key,
          instance_id: "previous-active-device",
        })
        const blocked = await service.activateLicenseByKey({
          license_key: fixture.key,
          instance_id: "previous-blocked-device",
        })
        await rawService.updateLicenseActivations({
          id: blocked.activation.id,
          status: LicenseActivationStatus.BLOCKED,
        })
        await service.revealLicenseKey({
          assignment_id: fixture.assignment.assignment.id,
          customer_id: "cus_license",
        })
        await rawService.updateLicenseAssignments({
          id: fixture.assignment.assignment.id,
          status: LicenseAssignmentStatus.REVOKED,
          revoked_at: new Date(),
          revoke_reason: "replace compromised key",
        })

        const replacementKey = `POOL-${randomUUID()}`.toUpperCase()
        await service.importLicenseKeys({
          license_policy_id: fixture.policy.id,
          keys: [replacementKey],
        })
        const replacement = await service.assignLicenseKey({
          entitlement_id: fixture.entitlement.id,
          license_policy_id: fixture.policy.id,
          idempotency_key: `replacement-${randomUUID()}`,
        })

        expect(replacement).toMatchObject({
          license_key: replacementKey,
          assignment: {
            id: fixture.assignment.assignment.id,
            status: LicenseAssignmentStatus.ACTIVE,
            activation_count: 0,
            revealed_at: null,
          },
        })
        expect(
          await rawService.retrieveLicenseActivation(active.activation.id),
        ).toMatchObject({ status: LicenseActivationStatus.DEACTIVATED })
        expect(
          await rawService.retrieveLicenseActivation(blocked.activation.id),
        ).toMatchObject({ status: LicenseActivationStatus.BLOCKED })
        const [storedReplacement] = await MikroOrmWrapper.getManager()
          .fork()
          .execute(
            'select "license_pool_key_id" from "license_assignment" where "id" = ?',
            [replacement.assignment.id],
          )
        expect(storedReplacement.license_pool_key_id).toBe(
          replacement.assignment.license_pool_key_id,
        )
        await expect(
          rawService.retrieveLicensePoolKey(
            storedReplacement.license_pool_key_id,
          ),
        ).resolves.toMatchObject({ status: LicensePoolKeyStatus.ASSIGNED })
        await expect(
          rawService.listLicenseAssignments({
            license_pool_key_id: storedReplacement.license_pool_key_id,
          }),
        ).resolves.toEqual([
          expect.objectContaining({ id: replacement.assignment.id }),
        ])
        await expect(
          service.validateLicenseByKey({ license_key: fixture.key }),
        ).resolves.toMatchObject({ valid: false })
        await expect(
          service.activateLicenseByKey({
            license_key: replacementKey,
            instance_id: "previous-active-device",
          }),
        ).resolves.toMatchObject({
          activation: { status: LicenseActivationStatus.ACTIVE },
          assignment: { activation_count: 1 },
        })
        await expect(
          service.activateLicenseByKey({
            license_key: replacementKey,
            instance_id: "previous-blocked-device",
          }),
        ).rejects.toThrow(/instance is blocked/)
      })

      it("rotates a past-due active assignment when its entitlement is reissued", async () => {
        const fixture = await createLicenseFixture(true)
        const activated = await service.activateLicenseByKey({
          license_key: fixture.key,
          instance_id: "past-due-device",
        })
        const previousPoolKeyId = fixture.assignment.assignment.license_pool_key_id
        const past = new Date(Date.now() - 86_400_000)
        const renewedUntil = new Date(Date.now() + 14 * 86_400_000)
        await rawService.updateDigitalEntitlements({
          id: fixture.entitlement.id,
          status: DigitalEntitlementStatus.EXPIRED,
          expires_at: past,
        })
        await rawService.updateLicenseAssignments({
          id: fixture.assignment.assignment.id,
          status: LicenseAssignmentStatus.ACTIVE,
          expires_at: past,
        })
        const replacementKey = `POOL-${randomUUID()}`.toUpperCase()
        await service.importLicenseKeys({
          license_policy_id: fixture.policy.id,
          keys: [replacementKey],
        })

        const reissued = await service.reissueEntitlement({
          entitlement_id: fixture.entitlement.id,
          reason: "renew expired license",
          expires_at: renewedUntil,
        })
        const [stored] = await MikroOrmWrapper.getManager().fork().execute(
          'select "license_pool_key_id", "status", "activation_count", "revealed_at", "expires_at" from "license_assignment" where "id" = ?',
          [fixture.assignment.assignment.id],
        )

        expect(reissued.entitlement).toMatchObject({
          status: DigitalEntitlementStatus.ACTIVE,
        })
        expect(new Date(reissued.entitlement.expires_at).getTime()).toBe(
          renewedUntil.getTime(),
        )
        expect(stored).toMatchObject({
          status: LicenseAssignmentStatus.ACTIVE,
          activation_count: 0,
          revealed_at: null,
        })
        expect(stored.license_pool_key_id).not.toBe(previousPoolKeyId)
        expect(new Date(stored.expires_at).getTime()).toBe(
          renewedUntil.getTime(),
        )
        await expect(
          rawService.retrieveLicensePoolKey(previousPoolKeyId),
        ).resolves.toMatchObject({ status: LicensePoolKeyStatus.REVOKED })
        await expect(
          rawService.retrieveLicenseActivation(activated.activation.id),
        ).resolves.toMatchObject({
          status: LicenseActivationStatus.DEACTIVATED,
        })
        await expect(
          service.activateLicenseByKey({
            license_key: replacementKey,
            instance_id: "renewed-device",
          }),
        ).resolves.toMatchObject({
          assignment: { id: fixture.assignment.assignment.id },
          activation: { status: LicenseActivationStatus.ACTIVE },
        })
        await expect(
          service.validateLicenseByKey({ license_key: fixture.key }),
        ).resolves.toMatchObject({ valid: false })
      })

      it("rotates an active assignment on a permitted active reissue", async () => {
        const fixture = await createLicenseFixture(true)
        const previousPoolKeyId = fixture.assignment.assignment.license_pool_key_id
        const replacementKey = `POOL-${randomUUID()}`.toUpperCase()
        await service.importLicenseKeys({
          license_policy_id: fixture.policy.id,
          keys: [replacementKey],
        })

        await expect(
          service.reissueEntitlement({
            entitlement_id: fixture.entitlement.id,
            reason: "rotate active license",
            expires_at: null,
          }),
        ).resolves.toMatchObject({
          entitlement: {
            id: fixture.entitlement.id,
            status: DigitalEntitlementStatus.ACTIVE,
            expires_at: null,
          },
        })
        const [stored] = await MikroOrmWrapper.getManager().fork().execute(
          'select "license_pool_key_id", "status", "expires_at" from "license_assignment" where "id" = ?',
          [fixture.assignment.assignment.id],
        )
        expect(stored).toMatchObject({
          status: LicenseAssignmentStatus.ACTIVE,
          expires_at: null,
        })
        expect(stored.license_pool_key_id).not.toBe(previousPoolKeyId)
        await expect(
          rawService.retrieveLicensePoolKey(previousPoolKeyId),
        ).resolves.toMatchObject({ status: LicensePoolKeyStatus.REVOKED })
        await expect(
          service.activateLicenseByKey({
            license_key: replacementKey,
            instance_id: "active-reissue-device",
          }),
        ).resolves.toMatchObject({
          assignment: { id: fixture.assignment.assignment.id },
        })
      })

      it("rotates a generated key inside the reissue transaction and rolls a failed rotation back", async () => {
        const product = await createProduct(DigitalDeliveryMode.LICENSE)
        const policy = await rawService.createLicensePolicies({
          digital_product_id: product.id,
          strategy: LicenseStrategy.GENERATED,
          activation_limit: 1,
          require_device_id: true,
          is_enabled: true,
        })
        const release = await rawService.createDigitalProductReleases({
          digital_product_id: product.id,
          version: "1.0.0",
          status: DigitalReleaseStatus.READY,
        })
        const published = await service.publishDigitalProductRelease(release.id)
        const [entitlement] = await service.issueOrderEntitlements({
          order_id: `order_generated_${randomUUID()}`,
          customer_id: "cus_generated_reissue",
          customer_email: "generated-reissue@example.test",
          items: [
            {
              digital_product_id: product.id,
              release_id: published.id,
              order_line_item_id: `item_generated_${randomUUID()}`,
            },
          ],
        })
        const original = await service.assignLicenseKey({
          entitlement_id: entitlement.id,
          license_policy_id: policy.id,
          idempotency_key: `generated-original-${randomUUID()}`,
        })
        const originalPoolKeyId = original.assignment.license_pool_key_id
        const activation = await service.activateLicenseByKey({
          license_key: original.license_key,
          instance_id: "generated-original-device",
        })

        await service.revokeEntitlement(
          entitlement.id,
          "rotate generated license",
        )
        await expect(
          service.validateLicenseByKey({
            license_key: original.license_key,
            instance_id: "generated-original-device",
          }),
        ).resolves.toMatchObject({ valid: false })

        await expect(
          service.reissueEntitlement({
            entitlement_id: entitlement.id,
            reason: "restore with a fresh generated key",
          }),
        ).resolves.toMatchObject({
          entitlement: {
            id: entitlement.id,
            status: DigitalEntitlementStatus.ACTIVE,
          },
        })

        const replacement = await rawService.retrieveLicenseAssignment(
          original.assignment.id,
        )
        expect(replacement).toMatchObject({
          status: LicenseAssignmentStatus.ACTIVE,
          activation_count: 0,
          revealed_at: null,
        })
        expect(replacement.license_pool_key_id).not.toBe(originalPoolKeyId)
        await expect(
          rawService.retrieveLicensePoolKey(originalPoolKeyId),
        ).resolves.toMatchObject({ status: LicensePoolKeyStatus.REVOKED })
        await expect(
          rawService.retrieveLicenseActivation(activation.activation.id),
        ).resolves.toMatchObject({
          status: LicenseActivationStatus.DEACTIVATED,
        })

        const revealed = await service.revealLicenseKey({
          assignment_id: replacement.id,
          customer_id: "cus_generated_reissue",
        })
        expect(revealed.license_key).not.toBe(original.license_key)
        const replacementActivation = await service.activateLicenseByKey({
          license_key: revealed.license_key,
          instance_id: "generated-replacement-device",
        })
        expect(replacementActivation).toMatchObject({
          assignment: { id: replacement.id },
          activation: { status: LicenseActivationStatus.ACTIVE },
        })

        await service.revokeEntitlement(
          entitlement.id,
          "prepare generated rollback proof",
        )
        const observer = MikroOrmWrapper.getManager().fork()
        const [beforeEntitlement] = await observer.execute(
          'select "status", "download_count", "guest_access_epoch", "revoked_at", "revoke_reason", "metadata" from "digital_entitlement" where "id" = ?',
          [entitlement.id],
        )
        const [beforeAssignment] = await observer.execute(
          'select "license_pool_key_id", "status", "activation_count", "revealed_at", "revoked_at", "revoke_reason" from "license_assignment" where "id" = ?',
          [replacement.id],
        )
        const [beforePoolKey] = await observer.execute(
          'select "status", "assigned_at", "revoked_at" from "license_pool_key" where "id" = ?',
          [replacement.license_pool_key_id],
        )
        const [beforeActivation] = await observer.execute(
          'select "status", "deactivated_at", "last_seen_at" from "license_activation" where "id" = ?',
          [replacementActivation.activation.id],
        )
        const [beforeKeyCount] = await observer.execute(
          'select count(*)::integer as "count" from "license_pool_key" where "license_policy_id" = ? and "deleted_at" is null',
          [policy.id],
        )

        await observer.execute(
          'alter table "license_audit_event" add constraint "CK_test_generated_reissue_post_flush_failure" check ("action" <> \'key_assigned\') not valid',
        )
        try {
          await expect(
            service.reissueEntitlement({
              entitlement_id: entitlement.id,
              reason: "force rollback after generated key flush",
            }),
          ).rejects.toThrow()
        } finally {
          await observer.execute(
            'alter table "license_audit_event" drop constraint if exists "CK_test_generated_reissue_post_flush_failure"',
          )
        }

        const verifier = MikroOrmWrapper.getManager().fork()
        const [afterEntitlement] = await verifier.execute(
          'select "status", "download_count", "guest_access_epoch", "revoked_at", "revoke_reason", "metadata" from "digital_entitlement" where "id" = ?',
          [entitlement.id],
        )
        const [afterAssignment] = await verifier.execute(
          'select "license_pool_key_id", "status", "activation_count", "revealed_at", "revoked_at", "revoke_reason" from "license_assignment" where "id" = ?',
          [replacement.id],
        )
        const [afterPoolKey] = await verifier.execute(
          'select "status", "assigned_at", "revoked_at" from "license_pool_key" where "id" = ?',
          [replacement.license_pool_key_id],
        )
        const [afterActivation] = await verifier.execute(
          'select "status", "deactivated_at", "last_seen_at" from "license_activation" where "id" = ?',
          [replacementActivation.activation.id],
        )
        const [afterKeyCount] = await verifier.execute(
          'select count(*)::integer as "count" from "license_pool_key" where "license_policy_id" = ? and "deleted_at" is null',
          [policy.id],
        )

        expect(afterEntitlement).toEqual(beforeEntitlement)
        expect(afterAssignment).toEqual(beforeAssignment)
        expect(afterPoolKey).toEqual(beforePoolKey)
        expect(afterActivation).toEqual(beforeActivation)
        expect(afterKeyCount).toEqual(beforeKeyCount)
      })

      it("serializes activation behind revocation before querying device state", async () => {
        const fixture = await createLicenseFixture(true)
        const existing = await service.activateLicenseByKey({
          license_key: fixture.key,
          instance_id: "existing-device",
        })
        const blockerManager = MikroOrmWrapper.getManager().fork()
        const observer = MikroOrmWrapper.getManager().fork()
        let releaseBlocker!: () => void
        const blockerRelease = new Promise<void>((resolve) => {
          releaseBlocker = resolve
        })
        let reportBlocker!: (pid: number) => void
        const blockerReady = new Promise<number>((resolve) => {
          reportBlocker = resolve
        })
        const blocker = blockerManager.transactional(async (transaction) => {
          const [backend] = await transaction.execute(
            "select pg_backend_pid() as pid",
          )
          await transaction.execute(
            'select "id" from "license_activation" where "id" = ? for update',
            [existing.activation.id],
          )
          reportBlocker(Number(backend.pid))
          await blockerRelease
        })
        const blockerPid = await blockerReady
        const waitForBlockedPid = async (blockingPid: number) => {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const blocked = await observer.execute(
              'select "pid" from "pg_stat_activity" where cast(? as integer) = any(pg_blocking_pids("pid")) order by "pid"',
              [blockingPid],
            )
            if (blocked.length) return Number(blocked[0].pid)
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          throw new Error(`No transaction blocked behind backend ${blockingPid}`)
        }

        const revocation = service.revokeEntitlement(
          fixture.entitlement.id,
          "concurrent refund",
        )
        const revokePid = await waitForBlockedPid(blockerPid)
        const activation = service.activateLicenseByKey({
          license_key: fixture.key,
          instance_id: "racing-device",
        })
        const activationOutcome = activation.then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason) => ({ status: "rejected" as const, reason }),
        )
        let serializationState: "blocked" | "settled"
        try {
          serializationState = await Promise.race([
            waitForBlockedPid(revokePid).then(() => "blocked" as const),
            activationOutcome.then(() => "settled" as const),
          ])
        } finally {
          releaseBlocker()
        }

        await blocker
        await expect(revocation).resolves.toMatchObject({
          status: DigitalEntitlementStatus.REVOKED,
        })
        const activationResult = await activationOutcome
        expect(serializationState).toBe("blocked")
        expect(activationResult.status).toBe("rejected")
        expect(
          await rawService.retrieveLicenseAssignment(
            fixture.assignment.assignment.id,
          ),
        ).toMatchObject({
          status: LicenseAssignmentStatus.REVOKED,
          activation_count: 0,
        })
        await expect(
          rawService.listLicenseActivations({
            assignment_id: fixture.assignment.assignment.id,
            status: LicenseActivationStatus.ACTIVE,
          }),
        ).resolves.toHaveLength(0)
      }, 30_000)

      it("hides unknown and foreign license assignments before exposing owned lifecycle state", async () => {
        const owned = await createLicenseFixture(true, "cus_reveal_owner")
        const foreign = await createLicenseFixture(true, "cus_reveal_foreign")
        let unknownError: any
        let foreignError: any

        try {
          await service.revealLicenseKey({
            assignment_id: `dlassn_missing_${randomUUID()}`,
            customer_id: "cus_reveal_owner",
          })
        } catch (error) {
          unknownError = error
        }
        try {
          await service.revealLicenseKey({
            assignment_id: foreign.assignment.assignment.id,
            customer_id: "cus_reveal_owner",
          })
        } catch (error) {
          foreignError = error
        }

        expect(unknownError).toMatchObject({
          type: "not_found",
          message: "License assignment was not found",
        })
        expect(foreignError).toMatchObject({
          type: unknownError.type,
          message: unknownError.message,
        })

        await rawService.updateLicenseAssignments({
          id: owned.assignment.assignment.id,
          status: LicenseAssignmentStatus.REVOKED,
          revoked_at: new Date(),
          revoke_reason: "owned-state-probe",
        })
        await expect(
          service.revealLicenseKey({
            assignment_id: owned.assignment.assignment.id,
            customer_id: "cus_reveal_owner",
          }),
        ).rejects.toMatchObject({
          type: "forbidden",
          message: "License assignment is not active",
        })
      })

      it("rejects crossed guest license reveals before acquiring either target graph", async () => {
        const first = await createLicenseFixture(true, null)
        const second = await createLicenseFixture(true, null)
        const firstToken = first.entitlement.guest_access.token as string
        const secondToken = second.entitlement.guest_access.token as string
        const originalLock = rawService.lockLicenseAssignmentGraph_.bind(
          rawService,
        )
        let lockArrivals = 0
        let releaseBoth!: () => void
        const bothLocked = new Promise<void>((resolve) => {
          releaseBoth = resolve
        })
        rawService.lockLicenseAssignmentGraph_ = async (...args: any[]) => {
          const graph = await originalLock(...args)
          lockArrivals += 1
          if (lockArrivals === 2) releaseBoth()
          await Promise.race([
            bothLocked,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("crossed reveal lock barrier timed out")),
                5_000,
              ),
            ),
          ])
          return graph
        }

        let outcomes: PromiseSettledResult<any>[]
        try {
          outcomes = await Promise.allSettled([
            service.revealLicenseKey({
              assignment_id: first.assignment.assignment.id,
              guest_token: secondToken,
              guest_email: "license@example.test",
            }),
            service.revealLicenseKey({
              assignment_id: second.assignment.assignment.id,
              guest_token: firstToken,
              guest_email: "license@example.test",
            }),
          ])
        } finally {
          rawService.lockLicenseAssignmentGraph_ = originalLock
          releaseBoth()
        }

        expect(lockArrivals).toBe(0)
        expect(outcomes).toEqual([
          expect.objectContaining({
            status: "rejected",
            reason: expect.objectContaining({
              type: "not_found",
              message: "License assignment was not found",
            }),
          }),
          expect.objectContaining({
            status: "rejected",
            reason: expect.objectContaining({
              type: "not_found",
              message: "License assignment was not found",
            }),
          }),
        ])
      }, 30_000)

      it("makes pool duplicate reject atomic and skip deterministic under concurrency", async () => {
        const product = await createProduct(DigitalDeliveryMode.LICENSE)
        const policy = await rawService.createLicensePolicies({
          digital_product_id: product.id,
          strategy: LicenseStrategy.POOL,
          require_device_id: true,
          is_enabled: true,
        })
        await expect(
          service.importLicenseKeys({
            license_policy_id: policy.id,
            keys: ["DUPLICATE-KEY-0001", " duplicate-key-0001 "],
            duplicate_policy: "reject",
          }),
        ).rejects.toThrow(/duplicate license keys/)
        expect(
          await rawService.listLicensePoolKeys({ license_policy_id: policy.id }),
        ).toHaveLength(0)

        await service.importLicenseKeys({
          license_policy_id: policy.id,
          keys: ["EXISTING-KEY-0001"],
          duplicate_policy: "reject",
        })
        await expect(
          service.importLicenseKeys({
            license_policy_id: policy.id,
            keys: ["NEW-KEY-0002", "EXISTING-KEY-0001"],
            duplicate_policy: "reject",
          }),
        ).rejects.toThrow(/already exist/)
        expect(
          await rawService.listLicensePoolKeys({ license_policy_id: policy.id }),
        ).toHaveLength(1)

        const skipped = await service.importLicenseKeys({
          license_policy_id: policy.id,
          keys: ["NEW-KEY-0002", "EXISTING-KEY-0001"],
          duplicate_policy: "skip",
        })
        expect(skipped).toHaveLength(1)
        expect(skipped[0]).toMatchObject({
          key_hint: "••••-0002",
          status: LicensePoolKeyStatus.AVAILABLE,
        })

        const concurrentKey = "CONCURRENT-KEY-0003"
        const raced = await Promise.allSettled([
          service.importLicenseKeys({
            license_policy_id: policy.id,
            keys: [concurrentKey],
            duplicate_policy: "reject",
          }),
          service.importLicenseKeys({
            license_policy_id: policy.id,
            keys: [concurrentKey],
            duplicate_policy: "reject",
          }),
        ])
        expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1)
        expect(
          await rawService.listLicensePoolKeys({ license_policy_id: policy.id }),
        ).toHaveLength(3)
      })
    })
  },
})
