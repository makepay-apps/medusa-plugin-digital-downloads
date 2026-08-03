import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import express from "express";

// Medusa uses this exact middleware when projectConfig.http.compression is
// enabled. It is a transitive runtime dependency of the framework.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const compression = require("compression");

import { streamGrantedContent, streamPublicPreview } from "../lib/content";
import { sendApiError } from "../lib/errors";

const TOKEN = "grant_abcdefghijklmnopqrstuvwxyz0123456789";

class TestResponse extends Writable {
  headers: Record<string, string> = {};
  statusCode = 200;
  chunks: Buffer[] = [];
  failWrites = false;

  set(values: Record<string, string>) {
    Object.assign(this.headers, values);
    return this;
  }

  setHeader(name: string, value: string | number) {
    this.headers[name] = String(value);
    return this;
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    if (this.failWrites) {
      callback(new Error("client disconnected"));
      return;
    }
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function requestFor(service: Record<string, unknown>, range?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    ...(range ? { range } : {}),
  };
  return {
    method: "GET",
    params: { asset_id: "dasset_test" },
    query: {},
    ip: "127.0.0.1",
    requestId: "req_test",
    get: (name: string) => headers[name.toLowerCase()],
    scope: {
      resolve: (name: string) => {
        if (name === "digitalDownloads") return service;
        throw new Error("not registered");
      },
    },
  } as unknown as MedusaRequest;
}

async function withCompressedGetRoute(
  route: string,
  service: Record<string, unknown>,
  handler: (req: MedusaRequest, res: MedusaResponse) => Promise<void>,
  run: (origin: string) => Promise<void>,
) {
  const app = express();
  app.use(compression({ threshold: 0 }));
  app.use((req, _res, next) => {
    Object.assign(req, {
      requestId: "req_http_test",
      scope: {
        resolve: (name: string) => {
          if (name === "digitalDownloads") return service;
          throw new Error(`not registered: ${name}`);
        },
      },
    });
    next();
  });
  app.get(route, (req, res, next) => {
    void handler(
      req as unknown as MedusaRequest,
      res as unknown as MedusaResponse,
    ).catch(next);
  });
  app.use((error: unknown, _req: unknown, res: express.Response, _next: unknown) => {
    sendApiError(res as unknown as MedusaResponse, error);
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function authorizedService() {
  return {
    redeemDownloadGrant: jest.fn().mockResolvedValue({
      authorized: true,
      event_id: "devent_transfer",
      grant: {
        id: "dgrant_test",
        asset_id: "dasset_test",
        metadata: { action: "download" },
      },
      asset: {
        id: "dasset_test",
        size_bytes: 5,
        original_filename: "hello.txt",
        mime_type: "text/plain",
      },
    }),
    openDigitalAsset: jest.fn().mockResolvedValue({
      body: Readable.from([Buffer.from("hello")]),
      size: 5,
      total_size: 5,
      filename: "hello.txt",
      mime_type: "text/plain",
      etag: "etag",
      status_code: 200,
    }),
    commitDownloadEvent: jest.fn().mockResolvedValue({}),
    completeDownloadGrant: jest.fn().mockResolvedValue({}),
    failDownloadGrant: jest.fn().mockResolvedValue({}),
  };
}

describe("protected content transfer accounting", () => {
  it("rejects Express' implicit HEAD fallback before grant redemption", async () => {
    const service = authorizedService();
    const response = new TestResponse();
    const request = requestFor(service) as MedusaRequest & { method: string };
    request.method = "HEAD";

    await expect(
      streamGrantedContent(request, response as unknown as MedusaResponse),
    ).rejects.toMatchObject({ status: 405, code: "method_not_allowed" });

    expect(response.headers.Allow).toBe("GET");
    expect(service.redeemDownloadGrant).not.toHaveBeenCalled();
    expect(service.openDigitalAsset).not.toHaveBeenCalled();
    expect(service.commitDownloadEvent).not.toHaveBeenCalled();
  });

  it("commits accounting before the first byte and finalizes exactly once", async () => {
    const service = authorizedService();
    const response = new TestResponse();
    service.commitDownloadEvent.mockImplementation(async () => {
      expect(Buffer.concat(response.chunks).toString()).toBe("");
      return {};
    });

    await streamGrantedContent(
      requestFor(service),
      response as unknown as MedusaResponse,
    );

    expect(service.commitDownloadEvent).toHaveBeenCalledTimes(1);
    expect(service.commitDownloadEvent).toHaveBeenCalledWith("devent_transfer");
    expect(service.completeDownloadGrant).toHaveBeenCalledTimes(1);
    expect(service.completeDownloadGrant).toHaveBeenCalledWith(
      "devent_transfer",
      { bytes_transferred: 5 },
    );
    expect(service.failDownloadGrant).not.toHaveBeenCalled();
    expect(Buffer.concat(response.chunks).toString()).toBe("hello");
  });

  it("sends no bytes and fails the transfer when accounting cannot commit", async () => {
    const service = authorizedService();
    const source = Readable.from([Buffer.from("hello")]);
    service.openDigitalAsset.mockResolvedValue({
      body: source,
      size: 5,
      total_size: 5,
      filename: "hello.txt",
      mime_type: "text/plain",
      etag: "etag",
      status_code: 200,
    });
    service.commitDownloadEvent.mockRejectedValue(
      new Error("database unavailable"),
    );
    const response = new TestResponse();

    await expect(
      streamGrantedContent(
        requestFor(service),
        response as unknown as MedusaResponse,
      ),
    ).rejects.toThrow("database unavailable");

    expect(Buffer.concat(response.chunks)).toHaveLength(0);
    expect(service.completeDownloadGrant).not.toHaveBeenCalled();
    expect(service.failDownloadGrant).toHaveBeenCalledWith("devent_transfer", {
      reason: "delivery_stream_failed",
      bytes_transferred: 0,
    });
    expect(source.destroyed).toBe(true);
  });

  it("releases the reservation when storage cannot open", async () => {
    const service = authorizedService();
    service.openDigitalAsset.mockRejectedValue(new Error("storage failed"));
    const response = new TestResponse();

    await expect(
      streamGrantedContent(
        requestFor(service),
        response as unknown as MedusaResponse,
      ),
    ).rejects.toThrow("storage failed");

    expect(service.completeDownloadGrant).not.toHaveBeenCalled();
    expect(service.commitDownloadEvent).not.toHaveBeenCalled();
    expect(service.failDownloadGrant).toHaveBeenCalledTimes(1);
    expect(service.failDownloadGrant).toHaveBeenCalledWith("devent_transfer", {
      reason: "delivery_preflight_failed",
      bytes_transferred: 0,
    });
  });

  it("retains committed accounting when a large transfer disconnects", async () => {
    const service = authorizedService();
    const body = Buffer.alloc(64 * 1024 + 5, "a");
    const source = Readable.from([body]);
    service.openDigitalAsset.mockResolvedValue({
      body: source,
      size: body.length,
      total_size: body.length,
      filename: "hello.txt",
      mime_type: "text/plain",
      etag: "etag",
      status_code: 200,
    });
    const response = new TestResponse();
    response.failWrites = true;

    await expect(
      streamGrantedContent(
        requestFor(service),
        response as unknown as MedusaResponse,
      ),
    ).rejects.toThrow("client disconnected");

    expect(service.commitDownloadEvent).toHaveBeenCalledWith("devent_transfer");
    expect(service.completeDownloadGrant).not.toHaveBeenCalled();
    expect(service.failDownloadGrant).toHaveBeenCalledWith("devent_transfer", {
      reason: "delivery_stream_failed",
      bytes_transferred: body.length,
    });
    expect(source.destroyed).toBe(true);
  });

  it("retains committed accounting when the first response write fails", async () => {
    const service = authorizedService();
    const source = Readable.from([Buffer.from("hello")]);
    service.openDigitalAsset.mockResolvedValue({
      body: source,
      size: 5,
      total_size: 5,
      filename: "hello.txt",
      mime_type: "text/plain",
      etag: "etag",
      status_code: 200,
    });
    const response = new TestResponse();
    response.failWrites = true;

    await expect(
      streamGrantedContent(
        requestFor(service),
        response as unknown as MedusaResponse,
      ),
    ).rejects.toThrow("client disconnected");

    expect(service.commitDownloadEvent).toHaveBeenCalledWith("devent_transfer");
    expect(service.completeDownloadGrant).not.toHaveBeenCalled();
    expect(service.failDownloadGrant).toHaveBeenCalledWith("devent_transfer", {
      reason: "delivery_stream_failed",
      bytes_transferred: 5,
    });
    expect(source.destroyed).toBe(true);
  });

  it("fails a short source after committing and reports the exact observed bytes", async () => {
    const service = authorizedService();
    service.openDigitalAsset.mockResolvedValue({
      body: Readable.from([Buffer.from("hell")]),
      size: 5,
      total_size: 5,
      filename: "hello.txt",
      mime_type: "text/plain",
      etag: "etag",
      status_code: 200,
    });
    const response = new TestResponse();

    await expect(
      streamGrantedContent(
        requestFor(service),
        response as unknown as MedusaResponse,
      ),
    ).rejects.toThrow("Storage returned fewer bytes than authorized.");

    expect(service.commitDownloadEvent).toHaveBeenCalledWith("devent_transfer");
    expect(service.completeDownloadGrant).not.toHaveBeenCalled();
    expect(service.failDownloadGrant).toHaveBeenCalledWith("devent_transfer", {
      reason: "delivery_stream_failed",
      bytes_transferred: 4,
    });
    expect(Buffer.concat(response.chunks).toString()).toBe("hell");
  });

  it("rejects an overlong source before forwarding the oversized chunk", async () => {
    const service = authorizedService();
    service.openDigitalAsset.mockResolvedValue({
      body: Readable.from([Buffer.from("hello!")]),
      size: 5,
      total_size: 5,
      filename: "hello.txt",
      mime_type: "text/plain",
      etag: "etag",
      status_code: 200,
    });
    const response = new TestResponse();

    await expect(
      streamGrantedContent(
        requestFor(service),
        response as unknown as MedusaResponse,
      ),
    ).rejects.toThrow("Storage returned more bytes than authorized.");

    expect(service.commitDownloadEvent).toHaveBeenCalledWith("devent_transfer");
    expect(service.completeDownloadGrant).not.toHaveBeenCalled();
    expect(service.failDownloadGrant).toHaveBeenCalledWith("devent_transfer", {
      reason: "delivery_stream_failed",
      bytes_transferred: 0,
    });
    expect(Buffer.concat(response.chunks)).toHaveLength(0);
  });

  it("keeps protected byte ranges untransformed when Medusa compression is enabled", async () => {
    const body = Buffer.from("0123456789".repeat(256));
    const start = 7;
    const end = 1_526;
    const expected = body.subarray(start, end + 1);
    const service = {
      redeemDownloadGrant: jest.fn().mockResolvedValue({
        authorized: true,
        event_id: "devent_compressed_range",
        grant: {
          id: "dgrant_compressed_range",
          asset_id: "dasset_compressed_range",
          metadata: { action: "download" },
        },
        asset: {
          id: "dasset_compressed_range",
          size_bytes: body.byteLength,
          original_filename: "compressible.txt",
          mime_type: "text/plain",
        },
      }),
      openDigitalAsset: jest.fn().mockResolvedValue({
        body: Readable.from([expected]),
        size: expected.byteLength,
        total_size: body.byteLength,
        filename: "compressible.txt",
        mime_type: "text/plain",
        etag: 'W/"range-test"',
        status_code: 206,
        content_range: `bytes ${start}-${end}/${body.byteLength}`,
      }),
      commitDownloadEvent: jest.fn().mockResolvedValue({}),
      completeDownloadGrant: jest.fn().mockResolvedValue({}),
      failDownloadGrant: jest.fn().mockResolvedValue({}),
    };

    await withCompressedGetRoute(
      "/store/digital-downloads/content/:asset_id",
      service,
      streamGrantedContent,
      async (origin) => {
        const headResponse = await fetch(
          `${origin}/store/digital-downloads/content/dasset_compressed_range`,
          {
            method: "HEAD",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              range: `bytes=${start}-${end}`,
            },
          },
        );
        expect(headResponse.status).toBe(405);
        expect(headResponse.headers.get("allow")).toBe("GET");
        expect(service.redeemDownloadGrant).not.toHaveBeenCalled();

        const response = await fetch(
          `${origin}/store/digital-downloads/content/dasset_compressed_range`,
          {
            headers: {
              authorization: `Bearer ${TOKEN}`,
              range: `bytes=${start}-${end}`,
              "accept-encoding": "gzip",
            },
          },
        );

        expect(response.status).toBe(206);
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("content-length")).toBe(
          String(expected.byteLength),
        );
        expect(response.headers.get("content-range")).toBe(
          `bytes ${start}-${end}/${body.byteLength}`,
        );
        expect(response.headers.get("cache-control")).toContain("no-transform");
        await expect(response.arrayBuffer()).resolves.toEqual(
          expected.buffer.slice(
            expected.byteOffset,
            expected.byteOffset + expected.byteLength,
          ),
        );
      },
    );

    expect(service.commitDownloadEvent).toHaveBeenCalledWith(
      "devent_compressed_range",
    );
    expect(service.completeDownloadGrant).toHaveBeenCalledWith(
      "devent_compressed_range",
      { bytes_transferred: expected.byteLength },
    );
  });

  it("projects semantic range failures as HTTP 416 without accounting", async () => {
    const service = {
      redeemDownloadGrant: jest.fn().mockRejectedValue(
        Object.assign(new Error("Byte range is not satisfiable"), {
          status: 416,
          statusCode: 416,
          code: "range_not_satisfiable",
          details: { total_size: 42 },
        }),
      ),
      openDigitalAsset: jest.fn(),
      commitDownloadEvent: jest.fn(),
      completeDownloadGrant: jest.fn(),
      failDownloadGrant: jest.fn(),
    };

    await withCompressedGetRoute(
      "/store/digital-downloads/content/:asset_id",
      service,
      streamGrantedContent,
      async (origin) => {
        const response = await fetch(
          `${origin}/store/digital-downloads/content/dasset_unsatisfiable`,
          {
            headers: {
              authorization: `Bearer ${TOKEN}`,
              range: "bytes=42-",
            },
          },
        );

        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */42");
        await expect(response.json()).resolves.toMatchObject({
          code: "range_not_satisfiable",
          details: { total_size: 42 },
        });
      },
    );

    expect(service.openDigitalAsset).not.toHaveBeenCalled();
    expect(service.commitDownloadEvent).not.toHaveBeenCalled();
    expect(service.completeDownloadGrant).not.toHaveBeenCalled();
  });

  it("keeps public preview ranges untransformed when compression is enabled", async () => {
    const body = Buffer.from("preview-data-".repeat(192));
    const start = 11;
    const end = 1_210;
    const expected = body.subarray(start, end + 1);
    const service = {
      retrieveDigitalAsset: jest.fn().mockResolvedValue({
        id: "dasset_preview_range",
        size_bytes: body.byteLength,
        original_filename: "preview.txt",
        mime_type: "text/plain",
      }),
      openDigitalAsset: jest.fn().mockResolvedValue({
        body: Readable.from([expected]),
        size: expected.byteLength,
        total_size: body.byteLength,
        filename: "preview.txt",
        mime_type: "text/plain",
        etag: 'W/"preview-range-test"',
        status_code: 206,
        content_range: `bytes ${start}-${end}/${body.byteLength}`,
      }),
    };

    await withCompressedGetRoute(
      "/store/digital-downloads/previews/:asset_id",
      service,
      streamPublicPreview,
      async (origin) => {
        const response = await fetch(
          `${origin}/store/digital-downloads/previews/dasset_preview_range`,
          {
            headers: {
              range: `bytes=${start}-${end}`,
              "accept-encoding": "gzip",
            },
          },
        );

        expect(response.status).toBe(206);
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("content-length")).toBe(
          String(expected.byteLength),
        );
        expect(response.headers.get("content-range")).toBe(
          `bytes ${start}-${end}/${body.byteLength}`,
        );
        expect(response.headers.get("cache-control")).toContain("public");
        expect(response.headers.get("cache-control")).toContain("no-transform");
        await expect(response.arrayBuffer()).resolves.toEqual(
          expected.buffer.slice(
            expected.byteOffset,
            expected.byteOffset + expected.byteLength,
          ),
        );
      },
    );
  });
});
