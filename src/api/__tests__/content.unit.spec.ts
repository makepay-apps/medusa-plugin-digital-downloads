import { Readable, Writable } from "node:stream";

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { streamGrantedContent } from "../lib/content";

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
});
