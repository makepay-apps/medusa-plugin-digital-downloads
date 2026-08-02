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
  testSuite: ({ service }) => {
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
      customerId = "cus_license",
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
