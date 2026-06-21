import Foundation
import Hummingbird
import HummingbirdWebSocket
import HTTPTypes
import NIOCore

/// HTTP + WebSocket server using Hummingbird.
/// Serves MJPEG stream on /stream.mjpeg, AVCC on /stream.avcc, WebSocket on /ws for input.
struct HTTPServer: Sendable {
    let clientManager = ClientManager()

    private let port: UInt16
    private let deviceUDID: String
    private let corsHeaders: HTTPFields = [
        .accessControlAllowOrigin: "*",
        .accessControlAllowMethods: "GET, POST, OPTIONS",
        .accessControlAllowHeaders: "Content-Type",
    ]

    init(deviceUDID: String, port: UInt16 = 3100) {
        self.deviceUDID = deviceUDID
        self.port = port
    }

    func run(onServerRunning: @Sendable @escaping () async -> Void) async throws {
        let router = Router()
        registerRoutes(on: router)

        let app = Application(
            router: router,
            server: .http1WebSocketUpgrade { request, _, _ in
                guard request.path == "/ws" else { return .dontUpgrade }
                return .upgrade([:]) { inbound, outbound, _ in
                    let session = await clientManager.addWSClient(outbound: outbound)
                    do {
                        for try await message in inbound.messages(maxSize: 1 << 20) {
                            guard case .binary(var buffer) = message else { continue }
                            let data = buffer.readData(length: buffer.readableBytes) ?? Data()
                            await clientManager.handleMessage(from: session, data: data)
                        }
                        await clientManager.removeWSClient(session)
                    } catch {
                        await clientManager.removeWSClient(session)
                        throw error
                    }
                }
            },
            configuration: .init(address: .hostname("0.0.0.0", port: Int(port))),
            onServerRunning: { _ in
                print("[server] Listening on http://0.0.0.0:\(port)")
                await onServerRunning()
            }
        )

        try await app.runService(gracefulShutdownSignals: [])
    }

    private func registerRoutes(on router: Router<BasicRequestContext>) {
        router.get("/stream.mjpeg") { request, _ -> Response in
            let client = await clientManager.addMJPEGClient()

            // WebKit (Safari/iOS Safari/WKWebView) refuses to expose a
            // multipart/x-mixed-replace response body to fetch()'s
            // ReadableStream. Consumers that read the stream via fetch()
            // can opt in to a plain byte stream by requesting ?raw=1; the
            // JPEG frames on the wire are unchanged.
            let raw = request.uri.queryParameters["raw"] == "1"
            let contentType = raw
                ? "application/octet-stream"
                : "multipart/x-mixed-replace; boundary=frame"

            return streamingResponse(contentType: contentType) { writer in
                do {
                    await clientManager.sendLatestFrame(to: client)
                    for await chunk in client.chunks {
                        try Task.checkCancellation()
                        try await writer.write(Self.byteBuffer(from: chunk))
                    }
                    try await writer.finish(nil)
                    await clientManager.removeMJPEGClient(client)
                } catch {
                    await clientManager.removeMJPEGClient(client)
                    throw error
                }
            }
        }

        // AVCC (H.264) stream endpoint. Emits length-prefixed envelope chunks
        // (see AVCCEnvelope) as a plain byte stream the client reads via
        // fetch()'s ReadableStream and decodes with WebCodecs VideoDecoder.
        router.get("/stream.avcc") { _, _ -> Response in
            let client = await clientManager.addAvccClient()
            return streamingResponse(contentType: "application/octet-stream") { writer in
                do {
                    await clientManager.sendInitialAvcc(to: client)
                    for await chunk in client.chunks {
                        try Task.checkCancellation()
                        try await writer.write(Self.byteBuffer(from: chunk))
                    }
                    try await writer.finish(nil)
                    await clientManager.removeAvccClient(client)
                } catch {
                    await clientManager.removeAvccClient(client)
                    throw error
                }
            }
        }

        // Config endpoint
        router.get("/config") { _, _ -> Response in
            let config = await clientManager.screenConfig()
            return try jsonResponse(config)
        }

        // Health endpoint
        router.get("/health") { _, _ -> Response in
            try jsonResponse(["status": "ok"])
        }

        // Accessibility tree (replaces a global `axe describe-ui` install).
        // Returns axe's flat-array JSON shape so the Node-side normalizer
        // in src/ax.ts works unchanged.
        router.get("/ax") { _, _ -> Response in
            do {
                let data = try AccessibilityBridge.shared.describeUI(udid: deviceUDID)
                return dataResponse(data, status: .ok, contentType: "application/json")
            } catch {
                let payload: [String: Any] = [
                    "error": "ax_unavailable",
                    "message": error.localizedDescription,
                ]
                let body = try JSONSerialization.data(withJSONObject: payload)
                return dataResponse(body, status: .serviceUnavailable, contentType: "application/json")
            }
        }

        // Frontmost-app probe. Returns `{bundleId, pid}` for the visible
        // app right now — used to bootstrap `/appstate` SSE clients after
        // a page reload, since SpringBoard's foreground log is edge-only.
        router.get("/foreground") { _, _ -> Response in
            do {
                let info = try AccessibilityBridge.shared.frontmostApp(udid: deviceUDID)
                let data = try JSONSerialization.data(withJSONObject: info)
                return dataResponse(data, status: .ok, contentType: "application/json")
            } catch {
                let payload: [String: Any] = [
                    "error": "foreground_unavailable",
                    "message": error.localizedDescription,
                ]
                let body = try JSONSerialization.data(withJSONObject: payload)
                return dataResponse(body, status: .serviceUnavailable, contentType: "application/json")
            }
        }

        // CORS preflight
        router.on("**", method: .options) { _, _ -> Response in
            var headers = corsHeaders
            headers[.contentLength] = "0"
            return Response(status: .noContent, headers: headers)
        }
    }

    private func streamingResponse(
        contentType: String,
        write: @Sendable @escaping (inout any ResponseBodyWriter) async throws -> Void
    ) -> Response {
        var headers = corsHeaders
        headers[.contentType] = contentType
        headers[.cacheControl] = "no-cache, no-store"
        headers[.connection] = "keep-alive"
        return Response(status: .ok, headers: headers, body: ResponseBody(write))
    }

    private func jsonResponse(_ object: [String: Any]) throws -> Response {
        let data = try JSONSerialization.data(withJSONObject: object)
        return dataResponse(data, status: .ok, contentType: "application/json")
    }

    private func dataResponse(
        _ data: Data,
        status: HTTPResponse.Status,
        contentType: String
    ) -> Response {
        var headers = corsHeaders
        headers[.contentType] = contentType
        headers[.cacheControl] = "no-cache, no-store"
        return Response(status: status, headers: headers, body: ResponseBody(byteBuffer: Self.byteBuffer(from: data)))
    }

    private static func byteBuffer(from data: Data) -> ByteBuffer {
        var buffer = ByteBufferAllocator().buffer(capacity: data.count)
        buffer.writeBytes(data)
        return buffer
    }
}
