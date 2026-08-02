import { readFileSync } from "node:fs"
import path from "node:path"

const example = (relativePath: string) =>
  readFileSync(path.join(process.cwd(), "examples/nextjs-starter", relativePath), "utf8")

describe("Next.js Store API examples", () => {
  const proxyRoute = example("src/app/api/digital-downloads/[...path]/route.ts.example")
  const grantCookieRoute = example(
    "src/app/api/digital-downloads/grant-cookie/route.ts.example"
  )

  it("bounds every proxied request body before forwarding it", () => {
    expect(proxyRoute).toContain("const MAX_PROXY_BODY_BYTES = 64 * 1024")
    expect(proxyRoute.indexOf('request.headers.get("content-length")')).toBeLessThan(
      proxyRoute.indexOf("request.body.getReader()")
    )
    expect(proxyRoute).toContain(
      "totalBytes + value.byteLength > MAX_PROXY_BODY_BYTES"
    )
    expect(proxyRoute).toContain('await reader.cancel("Request body too large.")')
    expect(proxyRoute).toContain("new RequestBodyError(413")
    expect(proxyRoute).not.toContain("request.arrayBuffer()")
    expect(proxyRoute).not.toContain("export const DELETE")
  })

  it("bounds and explicitly parses grant-cookie JSON", () => {
    expect(grantCookieRoute).toContain("const MAX_GRANT_COOKIE_BODY_BYTES = 8 * 1024")
    expect(grantCookieRoute.indexOf('request.headers.get("content-length")')).toBeLessThan(
      grantCookieRoute.indexOf("request.body.getReader()")
    )
    expect(grantCookieRoute).toContain(
      "totalBytes + value.byteLength > MAX_GRANT_COOKIE_BODY_BYTES"
    )
    expect(grantCookieRoute).toContain('await reader.cancel("Request body too large.")')
    expect(grantCookieRoute).toContain("new RequestBodyError(413")
    expect(grantCookieRoute).toContain("JSON.parse(")
    expect(grantCookieRoute).toContain('message: "Malformed JSON body."')
    expect(grantCookieRoute).not.toContain("request.json()")
  })
})
