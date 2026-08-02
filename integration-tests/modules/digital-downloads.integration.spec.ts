import path from "node:path";

import { moduleIntegrationTestRunner } from "@medusajs/test-utils";

import {
  DIGITAL_DOWNLOADS_MODULE,
  DigitalDownloadsModuleService,
} from "../../src/modules/digital-downloads";
import { Migration20260801114300 } from "../../src/modules/digital-downloads/migrations/Migration20260801114300";
import * as moduleModels from "../../src/modules/digital-downloads/models";
import {
  DigitalAssetKind,
  DigitalAssetRole,
  DigitalAssetStatus,
  DigitalDeliveryMode,
  DigitalEntitlementStatus,
  DigitalProductStatus,
  DigitalReleaseStatus,
  DigitalStorageProvider,
  DownloadEventType,
  FulfillmentOperationState,
  LicenseActivationStatus,
  LicenseAssignmentStatus,
  LicensePoolKeyStatus,
  LicenseStrategy,
  NotificationDeliveryState,
} from "../../src/modules/digital-downloads/types";

moduleIntegrationTestRunner<DigitalDownloadsModuleService>({
  moduleName: DIGITAL_DOWNLOADS_MODULE,
  moduleModels: Object.values(moduleModels),
  resolve: path.resolve(__dirname, "../../src/modules/digital-downloads"),
  moduleOptions: {
    tokenSecret: "integration-token-secret-32-bytes-minimum",
    encryptionKey: "1".repeat(64),
    storage: {
      local: {
        rootPath: path.resolve(__dirname, "../.tmp/digital-downloads"),
        signingSecret: "integration-signing-secret-32-bytes-minimum",
      },
    },
  },
  testSuite: ({ service, MikroOrmWrapper }) => {
    const rawService = service as any;

    async function productFixture(
      deliveryType: DigitalDeliveryMode = DigitalDeliveryMode.DOWNLOAD,
      releaseStatus: DigitalReleaseStatus = DigitalReleaseStatus.PUBLISHED,
    ) {
      const suffix = Math.random().toString(36).slice(2);
      const product = await service.createDigitalProductConfigs({
        title: `Product ${suffix}`,
        handle: `product-${suffix}`,
        status: DigitalProductStatus.ACTIVE,
        delivery_type: deliveryType,
      });
      const release = await rawService.createDigitalProductReleases({
        digital_product_id: product.id,
        version: "1.0.0",
        status: releaseStatus,
        is_current: releaseStatus === DigitalReleaseStatus.PUBLISHED,
        published_at:
          releaseStatus === DigitalReleaseStatus.PUBLISHED ? new Date() : null,
      });
      return { product, release };
    }

    async function downloadFixture(
      options: { body?: Buffer; downloadLimit?: number | null } = {},
    ) {
      const { product, release: unpublishedRelease } = await productFixture(
        DigitalDeliveryMode.DOWNLOAD,
        DigitalReleaseStatus.READY,
      );
      const body = options.body ?? Buffer.from("private data");
      const storageKey = `objects/${product.id}/manual.pdf`;
      const stored = await service.storeAssetObject({
        key: storageKey,
        body,
        mime_type: "application/pdf",
      });
      const asset = await rawService.createDigitalAssets({
        release_id: unpublishedRelease.id,
        name: "Private manual",
        role: DigitalAssetRole.DOWNLOAD,
        kind: DigitalAssetKind.PDF,
        status: DigitalAssetStatus.READY,
        delivery_type: DigitalDeliveryMode.DOWNLOAD,
        storage_provider: DigitalStorageProvider.LOCAL,
        storage_key: storageKey,
        storage_bucket: null,
        original_filename: "manual.pdf",
        mime_type: "application/pdf",
        size_bytes: stored.size,
        checksum_sha256: stored.checksumSha256,
        is_enabled: true,
      });
      const release = await service.publishDigitalProductRelease(
        unpublishedRelease.id,
      );
      const [entitlement] = await service.issueOrderEntitlements({
        order_id: `order_${product.id}`,
        customer_id: "cus_owner",
        customer_email: "Owner@Example.test",
        items: [
          {
            digital_product_id: product.id,
            release_id: release.id,
            order_line_item_id: `item_${product.id}`,
            quantity: 1,
            download_limit:
              options.downloadLimit === undefined ? 2 : options.downloadLimit,
          },
        ],
      });
      return { product, release, asset, entitlement };
    }

    describe("digital downloads PostgreSQL module", () => {
      it("upgrades the historic attribution constraint and default on PostgreSQL", async () => {
        const settings = await service.getSettings();
        const manager = MikroOrmWrapper.getManager().fork();
        const releasedLabel =
          "Brought to you by MakePay.io — crypto payment gateway.";
        const legacyLabel =
          "Brought to you by MakePay.io — crypto payment gateway";

        await manager.execute(
          'alter table "digital_downloads_settings" drop constraint if exists "CK_digital_downloads_settings_attribution_label"',
        );
        await manager.execute(
          'alter table "digital_downloads_settings" drop constraint if exists "ck_digital_downloads_settings_attribution_label"',
        );
        await manager.execute(
          'update "digital_downloads_settings" set "attribution_label" = ? where "id" = ?',
          [legacyLabel, settings.id],
        );
        await manager.execute(
          `alter table "digital_downloads_settings" alter column "attribution_label" set default '${legacyLabel}'`,
        );
        await manager.execute(
          `alter table "digital_downloads_settings" add constraint "ck_digital_downloads_settings_attribution_label" check ("attribution_label" = '${legacyLabel}')`,
        );

        const statements: string[] = [];
        await (Migration20260801114300.prototype.up as any).call({
          addSql: (statement: string) => statements.push(statement),
        });
        for (const statement of statements) {
          await manager.execute(statement);
        }

        const [row] = await manager.execute(
          'select "attribution_label" from "digital_downloads_settings" where "id" = ?',
          [settings.id],
        );
        expect(row.attribution_label).toBe(releasedLabel);

        const [column] = await manager.execute(
          `select "column_default" from "information_schema"."columns" where "table_schema" = current_schema() and "table_name" = 'digital_downloads_settings' and "column_name" = 'attribution_label'`,
        );
        expect(column.column_default).toContain(releasedLabel);

        const constraints = await manager.execute(
          `select "conname", pg_get_constraintdef("oid") as "definition" from "pg_constraint" where "conrelid" = 'digital_downloads_settings'::regclass and "conname" ilike '%attribution_label%'`,
        );
        expect(constraints).toEqual([
          expect.objectContaining({
            conname: "CK_digital_downloads_settings_attribution_label",
            definition: expect.stringContaining(releasedLabel),
          }),
        ]);

        const probeId = `ddset_migration_${Date.now()}`;
        const [inserted] = await manager.execute(
          'insert into "digital_downloads_settings" ("id", "singleton_key") values (?, ?) returning "attribution_label"',
          [probeId, `migration-probe-${Date.now()}`],
        );
        expect(inserted.attribution_label).toBe(releasedLabel);

        await expect(
          manager.transactional((transaction) =>
            transaction.execute(
              'update "digital_downloads_settings" set "attribution_label" = ? where "id" = ?',
              [legacyLabel, settings.id],
            ),
          ),
        ).rejects.toBeDefined();
      });

      it("boots the custom module, seeds fixed settings, and enforces unique product handles", async () => {
        const settings = await service.getSettings();

        expect(settings.singleton_key).toBe("global");
        expect(settings.show_makepay_attribution).toBe(true);
        expect(settings.attribution_url).toBe("https://makepay.io");

        const product = await service.createDigitalProductConfigs({
          title: "Integration Product",
          handle: "integration-product",
          status: DigitalProductStatus.ACTIVE,
          delivery_type: DigitalDeliveryMode.DOWNLOAD,
        });

        expect(product).toMatchObject({
          handle: "integration-product",
          status: DigitalProductStatus.ACTIVE,
          delivery_type: DigitalDeliveryMode.DOWNLOAD,
        });

        await expect(
          service.createDigitalProductConfigs({
            title: "Duplicate Handle",
            handle: "integration-product",
          }),
        ).rejects.toBeDefined();
      });

      it("applies persisted settings immediately while keeping attribution immutable", async () => {
        await service.updateSettings({
          default_download_limit: 1,
          default_grant_ttl_seconds: 120,
          max_grant_ttl_seconds: 240,
        });
        const { product, release } = await productFixture();
        const [entitlement] = await service.issueOrderEntitlements({
          order_id: "order_live_settings",
          customer_email: "settings@example.test",
          items: [
            {
              digital_product_id: product.id,
              release_id: release.id,
              order_line_item_id: "item_live_settings",
            },
          ],
        });

        expect(entitlement.download_limit).toBe(1);
        expect(await service.getSettings()).toMatchObject({
          default_download_limit: 1,
          default_grant_ttl_seconds: 120,
          max_grant_ttl_seconds: 240,
          attribution_url: "https://makepay.io",
        });
        await expect(
          service.updateSettings({ attribution_url: "https://evil.test" }),
        ).rejects.toThrow(/fixed/);
      });

      it("issues one durable entitlement per unit and replays the natural idempotency keys", async () => {
        const { product, release } = await productFixture();
        const input = {
          order_id: "order_quantity",
          customer_id: "cus_quantity",
          customer_email: "  BUYER@Example.test ",
          items: [
            {
              digital_product_id: product.id,
              release_id: release.id,
              order_line_item_id: "item_quantity",
              quantity: 3,
              snapshot: { title: "Immutable purchase title" },
            },
          ],
        };

        const first = await service.issueOrderEntitlements(input);
        const replay = await service.issueOrderEntitlements(input);

        expect(first).toHaveLength(3);
        expect(first.map((row) => row.unit_index)).toEqual([0, 1, 2]);
        expect(first.map((row) => row.quantity)).toEqual([1, 1, 1]);
        expect(first.map((row) => row.customer_email)).toEqual([
          "buyer@example.test",
          "buyer@example.test",
          "buyer@example.test",
        ]);
        expect(replay.map((row) => row.id)).toEqual(first.map((row) => row.id));
        await expect(
          rawService.createDigitalEntitlements({
            digital_product_id: product.id,
            release_id: release.id,
            status: DigitalEntitlementStatus.ACTIVE,
            source: "order",
            order_id: "order_quantity",
            order_line_item_id: "item_quantity",
            customer_email: "buyer@example.test",
            unit_index: 0,
            quantity: 1,
            idempotency_key: "different-key-same-natural-unit",
          }),
        ).rejects.toBeDefined();
        expect(
          await rawService.listDigitalEntitlements({
            order_id: "order_quantity",
          }),
        ).toHaveLength(3);
      });

      it("converges concurrent entitlement and grant issuance on one row and one token", async () => {
        const { product, release, asset, entitlement } =
          await downloadFixture();
        const row = {
          idempotency_key: "race-entitlement-key",
          order_id: "order_race",
          line_item_id: "item_race",
          email: "race@example.test",
          digital_product_id: product.id,
          digital_product_release_id: release.id,
          unit_index: 0,
        };
        const entitlementRace = await Promise.all([
          service.issueOrderEntitlements(row),
          service.issueOrderEntitlements(row),
        ]);
        expect(entitlementRace[0][0].id).toBe(entitlementRace[1][0].id);

        const grantInput = {
          entitlement_id: entitlement.id,
          asset_id: asset.id,
          idempotency_key: "race-grant-key",
          max_uses: 1,
        };
        const grantRace = await Promise.all([
          service.createDownloadGrant(grantInput),
          service.createDownloadGrant(grantInput),
        ]);
        expect(grantRace[0].grant.id).toBe(grantRace[1].grant.id);
        expect(grantRace[0].token).toBe(grantRace[1].token);
        expect(
          await rawService.listDownloadGrants({
            idempotency_key: "race-grant-key",
          }),
        ).toHaveLength(1);
      });

      it("reserves a grant atomically, commits accounting before delivery, and treats partial ranges as continuations", async () => {
        const { asset, entitlement } = await downloadFixture();
        const issued = await service.createDownloadGrant({
          entitlement_id: entitlement.id,
          asset_id: asset.id,
          idempotency_key: "grant-transfer",
          max_uses: 1,
          bind_ip: "203.0.113.10",
        });

        const attempts = await Promise.allSettled([
          service.redeemDownloadGrant(issued.token, {
            asset_id: asset.id,
            ip: "203.0.113.10",
            range_header: "bytes=0-3",
          }),
          service.redeemDownloadGrant(issued.token, {
            asset_id: asset.id,
            ip: "203.0.113.10",
            range_header: "bytes=0-3",
          }),
        ]);
        const authorized = attempts.filter(
          (result): result is PromiseFulfilledResult<any> =>
            result.status === "fulfilled",
        );
        expect(authorized).toHaveLength(1);

        const initialEvent = await rawService.retrieveDownloadEvent(
          authorized[0].value.event_id,
        );
        expect(Number(initialEvent.range_start)).toBe(0);
        expect(Number(initialEvent.range_end)).toBe(3);
        expect(initialEvent.metadata).toMatchObject({
          is_partial_range: true,
          requested_bytes: 4,
        });

        await service.commitDownloadEvent(authorized[0].value.event_id);
        await service.completeDownloadGrant(authorized[0].value.event_id, {
          bytes_transferred: 4,
        });
        await expect(
          service.completeDownloadGrant(authorized[0].value.event_id, {
            bytes_transferred: 4,
          }),
        ).resolves.toBeDefined();

        const afterFirst = await rawService.retrieveDownloadGrant(
          issued.grant.id,
        );
        const afterEntitlement = await rawService.retrieveDigitalEntitlement(
          entitlement.id,
        );
        expect(afterFirst.use_count).toBe(1);
        expect(afterFirst.reservation_id).toBeNull();
        expect(afterEntitlement.download_count).toBe(1);

        await expect(
          service.redeemDownloadGrant(issued.token, {
            asset_id: asset.id,
            ip: "203.0.113.10",
          }),
        ).rejects.toThrow(/exhausted/);

        const continuation = await service.redeemDownloadGrant(issued.token, {
          asset_id: asset.id,
          ip: "203.0.113.10",
          range_header: "bytes=4-7",
        });
        await service.commitDownloadEvent(continuation.event_id);
        await service.completeDownloadGrant(continuation.event_id, {
          bytes_transferred: 4,
        });
        expect(
          (await rawService.retrieveDownloadGrant(issued.grant.id)).use_count,
        ).toBe(1);
        expect(
          (await rawService.retrieveDigitalEntitlement(entitlement.id))
            .download_count,
        ).toBe(1);

        const fullTransferGrant = await service.createDownloadGrant({
          entitlement_id: entitlement.id,
          asset_id: asset.id,
          idempotency_key: "grant-full-transfer",
          max_uses: 1,
        });
        const fullTransfer = await service.redeemDownloadGrant(
          fullTransferGrant.token,
          { asset_id: asset.id },
        );
        await service.completeDownloadGrant(fullTransfer.event_id, {
          bytes_transferred: 12,
        });
        await expect(
          service.redeemDownloadGrant(fullTransferGrant.token, {
            asset_id: asset.id,
            range: { start: 4, end: 7 },
          }),
        ).rejects.toThrow(/exhausted|continuation/);
      });

      it("canonicalizes HTTP ranges and never opens continuation for a whole-object range", async () => {
        const { asset, entitlement } = await downloadFixture({
          downloadLimit: 10,
        });

        for (const testCase of [
          { key: "open-ended", header: "bytes=4-", start: 4, end: 11 },
          { key: "suffix", header: "bytes=-4", start: 8, end: 11 },
        ]) {
          const issued = await service.createDownloadGrant({
            entitlement_id: entitlement.id,
            asset_id: asset.id,
            idempotency_key: `canonical-${testCase.key}`,
            max_uses: 1,
          });
          const transfer = await service.redeemDownloadGrant(issued.token, {
            asset_id: asset.id,
            range_header: testCase.header,
          });
          const event = await rawService.retrieveDownloadEvent(
            transfer.event_id,
          );

          expect(Number(event.range_start)).toBe(testCase.start);
          expect(Number(event.range_end)).toBe(testCase.end);
          expect(event.metadata).toMatchObject({
            is_range: true,
            is_partial_range: true,
            requested_bytes: testCase.end - testCase.start + 1,
          });

          await service.commitDownloadEvent(transfer.event_id);
          await service.completeDownloadEvent(transfer.event_id, {
            bytes_transferred: testCase.end - testCase.start + 1,
          });
          expect(
            (await rawService.retrieveDownloadGrant(issued.grant.id))
              .continuation_expires_at,
          ).not.toBeNull();
        }

        const wholeObject = await service.createDownloadGrant({
          entitlement_id: entitlement.id,
          asset_id: asset.id,
          idempotency_key: "canonical-whole-object",
          max_uses: 1,
        });
        const transfer = await service.redeemDownloadGrant(wholeObject.token, {
          asset_id: asset.id,
          range_header: "bytes=0-",
        });
        const event = await rawService.retrieveDownloadEvent(transfer.event_id);
        expect(Number(event.range_start)).toBe(0);
        expect(Number(event.range_end)).toBe(11);
        expect(event.metadata).toMatchObject({
          is_range: true,
          is_partial_range: false,
          requested_bytes: 12,
        });

        await service.commitDownloadEvent(transfer.event_id);
        await service.completeDownloadEvent(transfer.event_id, {
          bytes_transferred: 12,
        });
        expect(
          await rawService.retrieveDownloadGrant(wholeObject.grant.id),
        ).toMatchObject({
          use_count: 1,
          continuation_started_at: null,
          continuation_expires_at: null,
        });
        await expect(
          service.redeemDownloadGrant(wholeObject.token, {
            asset_id: asset.id,
            range_header: "bytes=0-",
          }),
        ).rejects.toThrow(/exhausted/);
      });

      it("caps range continuations by both request count and cumulative requested bytes", async () => {
        const body = Buffer.alloc(100, 0x61);

        const requestFixture = await downloadFixture({
          body,
          downloadLimit: 10,
        });
        const requestGrant = await service.createDownloadGrant({
          entitlement_id: requestFixture.entitlement.id,
          asset_id: requestFixture.asset.id,
          idempotency_key: "continuation-request-budget",
          max_uses: 1,
        });
        const requestInitial = await service.redeemDownloadGrant(
          requestGrant.token,
          {
            asset_id: requestFixture.asset.id,
            range_header: "bytes=0-0",
          },
        );
        await service.commitDownloadEvent(requestInitial.event_id);
        await service.completeDownloadEvent(requestInitial.event_id, {
          bytes_transferred: 1,
        });

        for (let index = 0; index < 64; index += 1) {
          await expect(
            service.redeemDownloadGrant(requestGrant.token, {
              asset_id: requestFixture.asset.id,
              range_header: "bytes=1-1",
            }),
          ).resolves.toMatchObject({ authorized: true });
        }
        await expect(
          service.redeemDownloadGrant(requestGrant.token, {
            asset_id: requestFixture.asset.id,
            range_header: "bytes=1-1",
          }),
        ).rejects.toThrow(/continuation budget/);

        const byteFixture = await downloadFixture({ body, downloadLimit: 10 });
        const byteGrant = await service.createDownloadGrant({
          entitlement_id: byteFixture.entitlement.id,
          asset_id: byteFixture.asset.id,
          idempotency_key: "continuation-byte-budget",
          max_uses: 1,
        });
        const byteInitial = await service.redeemDownloadGrant(byteGrant.token, {
          asset_id: byteFixture.asset.id,
          range_header: "bytes=0-0",
        });
        await service.commitDownloadEvent(byteInitial.event_id);
        await service.completeDownloadEvent(byteInitial.event_id, {
          bytes_transferred: 1,
        });
        for (let index = 0; index < 2; index += 1) {
          await expect(
            service.redeemDownloadGrant(byteGrant.token, {
              asset_id: byteFixture.asset.id,
              range_header: "bytes=0-98",
            }),
          ).resolves.toMatchObject({ authorized: true });
        }
        await expect(
          service.redeemDownloadGrant(byteGrant.token, {
            asset_id: byteFixture.asset.id,
            range_header: "bytes=0-2",
          }),
        ).rejects.toThrow(/continuation budget/);
      });

      it("deduplicates repeated and concurrent denials for the same grant and reason", async () => {
        const { asset, entitlement } = await downloadFixture({
          downloadLimit: 10,
        });
        const issued = await service.createDownloadGrant({
          entitlement_id: entitlement.id,
          asset_id: asset.id,
          idempotency_key: "deduplicated-denials",
          max_uses: 1,
        });
        const transfer = await service.redeemDownloadGrant(issued.token, {
          asset_id: asset.id,
        });
        await service.commitDownloadEvent(transfer.event_id);
        await service.completeDownloadEvent(transfer.event_id, {
          bytes_transferred: Number(asset.size_bytes),
        });

        const attempts = await Promise.allSettled(
          Array.from({ length: 24 }, () =>
            service.redeemDownloadGrant(issued.token, { asset_id: asset.id }),
          ),
        );
        expect(attempts).toHaveLength(24);
        expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(
          true,
        );

        const denied = await rawService.listDownloadEvents({
          grant_id: issued.grant.id,
          event_type: DownloadEventType.DENIED,
        });
        expect(denied).toHaveLength(1);
        expect(denied[0].denial_reason).toBe(
          "Download grant has been exhausted",
        );
      });

      it("counts a committed transfer before delivery and never rolls accounting back on failure", async () => {
        const { asset, entitlement } = await downloadFixture({
          downloadLimit: 10,
        });
        const issued = await service.createDownloadGrant({
          entitlement_id: entitlement.id,
          asset_id: asset.id,
          idempotency_key: "commit-before-delivery-failure",
          max_uses: 1,
        });
        const transfer = await service.redeemDownloadGrant(issued.token, {
          asset_id: asset.id,
        });

        await service.commitDownloadEvent(transfer.event_id);
        await service.commitDownloadEvent(transfer.event_id);
        expect(
          await rawService.retrieveDownloadEvent(transfer.event_id),
        ).toMatchObject({
          event_type: DownloadEventType.TRANSFER_STARTED,
          metadata: { accounting_committed: true },
        });
        expect(
          await rawService.retrieveDownloadGrant(issued.grant.id),
        ).toMatchObject({
          use_count: 1,
          reservation_id: null,
        });
        expect(
          await rawService.retrieveDigitalEntitlement(entitlement.id),
        ).toMatchObject({ download_count: 1 });

        await service.failDownloadEvent(transfer.event_id, {
          reason: "client disconnected",
          bytes_transferred: 3,
        });
        const failedEvent = await rawService.retrieveDownloadEvent(
          transfer.event_id,
        );
        expect(failedEvent).toMatchObject({
          event_type: DownloadEventType.TRANSFER_FAILED,
          metadata: { accounting_committed: true },
        });
        expect(Number(failedEvent.bytes_served)).toBe(3);
        expect(
          await rawService.retrieveDownloadGrant(issued.grant.id),
        ).toMatchObject({
          use_count: 1,
          reservation_id: null,
        });
        expect(
          await rawService.retrieveDigitalEntitlement(entitlement.id),
        ).toMatchObject({ download_count: 1 });
      });

      it("finalizes a committed transfer idempotently after entitlement revocation", async () => {
        const { asset, entitlement } = await downloadFixture({
          downloadLimit: 10,
        });
        const issued = await service.createDownloadGrant({
          entitlement_id: entitlement.id,
          asset_id: asset.id,
          idempotency_key: "commit-before-revocation",
          max_uses: 1,
        });
        const transfer = await service.redeemDownloadGrant(issued.token, {
          asset_id: asset.id,
        });
        await service.commitDownloadEvent(transfer.event_id);
        await service.revokeEntitlement(entitlement.id, "refund after commit");

        const completed = await service.completeDownloadEvent(
          transfer.event_id,
          {
            bytes_transferred: Number(asset.size_bytes),
          },
        );
        const replay = await service.completeDownloadEvent(transfer.event_id, {
          bytes_transferred: Number(asset.size_bytes),
        });

        expect(completed.event).toMatchObject({
          event_type: DownloadEventType.TRANSFER_COMPLETED,
          success: true,
          metadata: { accounting_committed: true },
        });
        expect(replay.event.id).toBe(completed.event.id);
        expect(
          await rawService.retrieveDownloadGrant(issued.grant.id),
        ).toMatchObject({
          status: "revoked",
          use_count: 1,
        });
        expect(
          await rawService.retrieveDigitalEntitlement(entitlement.id),
        ).toMatchObject({
          status: DigitalEntitlementStatus.REVOKED,
          download_count: 1,
        });
      });

      it("releases a failed transfer reservation without consuming access", async () => {
        const { asset, entitlement } = await downloadFixture();
        const issued = await service.createDownloadGrant({
          entitlement_id: entitlement.id,
          asset_id: asset.id,
          idempotency_key: "grant-failure",
        });
        const transfer = await service.redeemDownloadGrant(issued.token, {
          asset_id: asset.id,
        });

        await service.failDownloadGrant(transfer.event_id, {
          reason: "client disconnected",
        });

        expect(
          await rawService.retrieveDownloadEvent(transfer.event_id),
        ).toMatchObject({
          event_type: DownloadEventType.TRANSFER_FAILED,
          success: false,
        });
        expect(
          await rawService.retrieveDownloadGrant(issued.grant.id),
        ).toMatchObject({ use_count: 0, reservation_id: null });
        await expect(
          service.redeemDownloadGrant(issued.token, { asset_id: asset.id }),
        ).resolves.toMatchObject({ authorized: true });
      });

      it("keeps guest capabilities hashed and bound, then denies them after revocation", async () => {
        const { entitlement } = await downloadFixture();
        const created = await service.createGuestAccessSession({
          entitlement_id: entitlement.id,
          idempotency_key: "guest-session",
          bind_ip: "198.51.100.4",
        });
        const replay = await service.createGuestAccessSession({
          entitlement_id: entitlement.id,
          idempotency_key: "guest-session",
          bind_ip: "198.51.100.4",
        });

        expect(replay.token).toBe(created.token);
        expect(created.session).not.toHaveProperty("token_hash");
        await expect(
          service.resolveGuestEntitlement(created.token, {
            email: "owner@example.test",
            ip: "198.51.100.5",
          }),
        ).rejects.toThrow(/binding/);
        await expect(
          service.resolveGuestEntitlement(created.token, {
            email: " OWNER@Example.test ",
            ip: "198.51.100.4",
          }),
        ).resolves.toMatchObject({ entitlement: { id: entitlement.id } });

        await service.revokeEntitlement(entitlement.id, "order refunded", {
          type: "system",
          id: "refund-handler",
        });
        await expect(
          service.resolveGuestEntitlement(created.token, {
            email: "owner@example.test",
            ip: "198.51.100.4",
          }),
        ).rejects.toThrow(/inactive|not active/);
      });

      it("encrypts pooled licenses, assigns once, enforces activations, and revokes with the entitlement", async () => {
        const { product, release } = await productFixture(
          DigitalDeliveryMode.LICENSE,
          DigitalReleaseStatus.READY,
        );
        const policy = await rawService.createLicensePolicies({
          digital_product_id: product.id,
          strategy: LicenseStrategy.POOL,
          activation_limit: 2,
          require_device_id: true,
          is_enabled: true,
        });
        await service.publishDigitalProductRelease(release.id);
        const [entitlement] = await service.issueOrderEntitlements({
          order_id: "order_license",
          customer_id: "cus_license",
          customer_email: "license@example.test",
          items: [
            {
              digital_product_id: product.id,
              release_id: release.id,
              order_line_item_id: "item_license",
              license_activation_limit: 1,
            },
          ],
        });

        const imported = await service.importLicenseKeys({
          license_policy_id: policy.id,
          keys: [" pool-key-abcd ", "POOL-KEY-ABCD"],
          batch_id: "batch_1",
          duplicate_policy: "skip",
        });
        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatchObject({
          status: LicensePoolKeyStatus.AVAILABLE,
          key_hint: "••••-ABCD",
        });
        expect(imported[0]).not.toHaveProperty("key_ciphertext");

        const assigned = await service.assignLicenseKey({
          entitlement_id: entitlement.id,
          license_policy_id: policy.id,
          idempotency_key: "license-assignment",
        });
        const replay = await service.assignLicenseKey({
          entitlement_id: entitlement.id,
          license_policy_id: policy.id,
          idempotency_key: "license-assignment",
        });
        expect(assigned.license_key).toBe("POOL-KEY-ABCD");
        expect(replay).toMatchObject({
          created: false,
          license_key: assigned.license_key,
          assignment: { id: assigned.assignment.id },
        });
        const stored = await rawService.retrieveLicensePoolKey(
          assigned.assignment.license_pool_key_id,
        );
        expect(stored.status).toBe(LicensePoolKeyStatus.ASSIGNED);
        expect(stored.key_ciphertext).not.toContain(assigned.license_key);

        const activation = await service.activateLicenseByKey({
          license_key: assigned.license_key,
          instance_id: "machine-1",
          label: "Laptop",
        });
        const activationReplay = await service.activateLicenseByKey({
          license_key: assigned.license_key,
          instance_id: "machine-1",
        });
        expect(activation.created).toBe(true);
        expect(activationReplay.created).toBe(false);
        expect(activationReplay.activation.status).toBe(
          LicenseActivationStatus.ACTIVE,
        );
        await expect(
          service.activateLicenseByKey({
            license_key: assigned.license_key,
            instance_id: "machine-2",
          }),
        ).rejects.toThrow(/activation limit/);
        await expect(
          service.validateLicenseByKey({
            license_key: assigned.license_key,
            instance_id: "machine-1",
          }),
        ).resolves.toMatchObject({ valid: true });

        await service.revokeEntitlement(entitlement.id, "full refund");
        expect(
          await rawService.retrieveLicenseAssignment(assigned.assignment.id),
        ).toMatchObject({ status: LicenseAssignmentStatus.REVOKED });
        await expect(
          service.validateLicenseByKey({
            license_key: assigned.license_key,
            instance_id: "machine-1",
          }),
        ).resolves.toMatchObject({ valid: false });
        await expect(
          service.revealLicenseKey({
            assignment_id: assigned.assignment.id,
            customer_id: "cus_license",
          }),
        ).rejects.toThrow(/not active/);
      });

      it("claims a durable operation once and reclaims an expired worker lease", async () => {
        const { product, release } = await productFixture();
        const operation = await rawService.createFulfillmentOperations({
          idempotency_key: "fulfillment-operation",
          order_id: "order_worker",
          order_line_item_id: "item_worker",
          unit_index: 0,
          digital_product_id: product.id,
          digital_product_release_id: release.id,
          state: FulfillmentOperationState.PENDING,
          attempt_count: 0,
          max_attempts: 3,
          payload: {},
        });

        const raced = await Promise.all([
          service.claimFulfillmentOperations("worker-a", 10, 60),
          service.claimFulfillmentOperations("worker-b", 10, 60),
        ]);
        expect(raced.flat()).toHaveLength(1);
        const first = await rawService.retrieveFulfillmentOperation(
          operation.id,
        );
        expect(first).toMatchObject({
          state: FulfillmentOperationState.PROCESSING,
          attempt_count: 1,
        });

        await rawService.updateFulfillmentOperations({
          id: operation.id,
          lease_expires_at: new Date(Date.now() - 60_000),
        });
        const reclaimed = await service.claimFulfillmentOperations(
          "worker-recovery",
          10,
          60,
        );
        expect(reclaimed).toHaveLength(1);
        expect(reclaimed[0]).toMatchObject({
          id: operation.id,
          lease_owner: "worker-recovery",
          attempt_count: 2,
        });
      });

      it("atomically owns one notification attempt and rejects another worker", async () => {
        const { entitlement } = await downloadFixture();
        const delivery = await rawService.createNotificationDeliveries({
          entitlement_id: entitlement.id,
          idempotency_key: `notification-claim-${entitlement.id}`,
          channel: "email",
          template: "digital-downloads-delivery",
          recipient_hash: await service.recipientHash("owner@example.test"),
          state: NotificationDeliveryState.PENDING,
          attempt_count: 0,
          max_attempts: 1,
          payload: {},
          metadata: {},
        });

        const raced = await Promise.all([
          service.claimNotificationDelivery(delivery.id, "event-worker-a"),
          service.claimNotificationDelivery(delivery.id, "event-worker-b"),
        ]);
        const [owned] = raced.filter(Boolean) as any[];
        expect(raced.filter(Boolean)).toHaveLength(1);
        expect(owned).toMatchObject({
          id: delivery.id,
          state: NotificationDeliveryState.PROCESSING,
          attempt_count: 1,
        });

        await expect(
          service.claimNotificationDelivery(delivery.id, "intruder"),
        ).resolves.toBeNull();
        await expect(
          service.claimNotificationDelivery(delivery.id, owned.lease_owner, {
            expected_lease_owner: owned.lease_owner,
            lease_seconds: 120,
          }),
        ).resolves.toMatchObject({
          id: delivery.id,
          lease_owner: owned.lease_owner,
          attempt_count: 1,
        });
      });
    });
  },
});
