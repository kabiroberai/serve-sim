import Foundation
import HummingbirdWebSocket
import NIOCore

enum ClientEvent: Sendable {
    case touch(TouchEventPayload)
    case button(ButtonEventPayload)
    case multiTouch(MultiTouchEventPayload)
    case key(KeyEventPayload)
    case orientation(value: UInt32, name: String)
    case caDebug(CADebugEventPayload)
    case memoryWarning
    case digitalCrown(DigitalCrownEventPayload)
    case scroll(ScrollEventPayload)
    case avccClientConnected
}

/// Manages WebSocket clients for input and MJPEG stream clients for video.
actor ClientManager {
    nonisolated let events: AsyncStream<ClientEvent>

    private let eventContinuation: AsyncStream<ClientEvent>.Continuation
    private var wsSessions: [Int: InputWebSocketSession] = [:]

    private var screenWidth = 0
    private var screenHeight = 0
    private var screenOrientation = "portrait"

    /// Latest JPEG frame data, replaced on each new frame
    private var latestFrame: Data?
    private var mjpegClients: [Int: MJPEGClient] = [:]
    private var nextClientId = 0

    /// AVCC (H.264) stream clients + the cached avcC description envelope so
    /// late joiners can configure their decoder without waiting for the next
    /// natural IDR.
    private var avccClients: [Int: AVCCClient] = [:]
    private var cachedAvccDescription: Data?
    private var avccClientCount = 0

    init() {
        (events, eventContinuation) = AsyncStream.makeStream(of: ClientEvent.self)
    }

    // MARK: - Configuration

    func setScreenSize(width: Int, height: Int) async {
        let changed = width != screenWidth || height != screenHeight
        screenWidth = width
        screenHeight = height
        if changed { await broadcastConfig() }
    }

    func setScreenOrientation(_ orientation: String) async {
        let changed = orientation != screenOrientation
        screenOrientation = orientation
        if changed { await broadcastConfig() }
    }

    func screenConfig() -> [String: Any] {
        [
            "width": screenWidth,
            "height": screenHeight,
            "orientation": screenOrientation,
        ]
    }

    /// Tag for a server->client screen-config push. Distinct from the
    /// client->server input tags (0x03-0x0A); the frame layout mirrors input:
    /// `[tag][JSON payload]`.
    private static let wsMsgConfig: UInt8 = 0x82

    private func configFrame() -> [UInt8]? {
        guard let json = try? JSONSerialization.data(withJSONObject: screenConfig()) else { return nil }
        return [ClientManager.wsMsgConfig] + [UInt8](json)
    }

    /// Push the current screen config to every connected input WebSocket. This
    /// replaces the browser's old 1s `/config` poll — clients now receive
    /// dimensions/orientation over the socket they already hold open for input.
    func broadcastConfig() async {
        guard let frame = configFrame() else { return }
        for session in wsSessions.values {
            await session.writeBinary(Data(frame))
        }
    }

    // MARK: - MJPEG Client Management

    func addMJPEGClient() -> MJPEGClient {
        let client = MJPEGClient(id: nextClientId)
        nextClientId += 1
        mjpegClients[client.id] = client
        print("[clients] MJPEG client connected (\(mjpegClients.count) total)")
        return client
    }

    /// Send the latest cached frame to a client (call after writer is attached).
    func sendLatestFrame(to client: MJPEGClient) {
        if let frame = latestFrame {
            client.send(frame: frame)
        }
    }

    func removeMJPEGClient(_ client: MJPEGClient) {
        mjpegClients.removeValue(forKey: client.id)
        client.close()
        print("[clients] MJPEG client disconnected (\(mjpegClients.count) total)")
    }

    // MARK: - AVCC Client Management

    /// True when at least one viewer is consuming the H.264 stream. The owner
    /// gates VideoToolbox encoding on this so an all-MJPEG session pays no
    /// H.264 cost.
    func hasAvccClients() -> Bool {
        avccClientCount > 0
    }

    func addAvccClient() -> AVCCClient {
        let client = AVCCClient(id: nextClientId)
        nextClientId += 1
        avccClientCount += 1
        avccClients[client.id] = client
        print("[clients] AVCC client connected (\(avccClients.count) total)")
        return client
    }

    /// After a client's writer is attached: paint instantly with a JPEG seed,
    /// replay the cached decoder description, then ask the owner to force a
    /// keyframe so an IDR follows promptly.
    func sendInitialAvcc(to client: AVCCClient) {
        let data = (latestFrame ?? Data()) + (cachedAvccDescription ?? Data())
        if !data.isEmpty {
            client.send(data)
        }
        eventContinuation.yield(.avccClientConnected)
    }

    func removeAvccClient(_ client: AVCCClient) {
        avccClientCount = max(0, avccClientCount - 1)
        avccClients.removeValue(forKey: client.id)
        client.close()
        print("[clients] AVCC client disconnected (\(avccClients.count) total)")
    }

    /// Broadcast one enveloped AVCC chunk. Caches the description so it can be
    /// replayed to clients that connect after it was first emitted.
    func broadcastAvcc(_ envelope: Data, isDescription: Bool = false) {
        if isDescription { cachedAvccDescription = envelope }
        for client in avccClients.values {
            client.send(envelope)
        }
    }

    // MARK: - WebSocket Client Management (input only)

    func addWSClient(outbound: WebSocketOutboundWriter) async -> InputWebSocketSession {
        let id = nextClientId
        nextClientId += 1
        let session = InputWebSocketSession(id: id, outbound: outbound)
        wsSessions[id] = session
        // Seed the new client with the current screen config so it gets
        // dimensions/orientation immediately, replacing the old 1s poll.
        if let frame = configFrame() {
            await session.writeBinary(Data(frame))
        }
        print("[clients] WS input client connected (\(wsSessions.count) total)")
        return session
    }

    func removeWSClient(_ session: InputWebSocketSession) {
        wsSessions.removeValue(forKey: session.id)
        print("[clients] WS input client disconnected (\(wsSessions.count) total)")
    }

    // MARK: - Message Handling

    func handleMessage(from session: InputWebSocketSession, data: Data) {
        guard data.count >= 1 else { return }
        let type = data[0]

        if type == 0x03 { // WS_MSG_TOUCH
            guard let json = try? JSONDecoder().decode(TouchEventPayload.self, from: data[1...]) else { return }
            eventContinuation.yield(.touch(json))
        } else if type == 0x04 { // WS_MSG_BUTTON
            guard let json = try? JSONDecoder().decode(ButtonEventPayload.self, from: data[1...]) else { return }
            eventContinuation.yield(.button(json))
        } else if type == 0x05 { // WS_MSG_MULTI_TOUCH
            guard let json = try? JSONDecoder().decode(MultiTouchEventPayload.self, from: data[1...]) else { return }
            eventContinuation.yield(.multiTouch(json))
        } else if type == 0x06 { // WS_MSG_KEY
            guard let json = try? JSONDecoder().decode(KeyEventPayload.self, from: data[1...]) else { return }
            eventContinuation.yield(.key(json))
        } else if type == 0x07 { // WS_MSG_ORIENTATION
            guard let json = try? JSONDecoder().decode(OrientationEventPayload.self, from: data[1...]) else { return }
            let value: UInt32
            switch json.orientation {
            case "portrait":             value = HIDInjector.orientationPortrait
            case "portrait_upside_down": value = HIDInjector.orientationPortraitUpsideDown
            case "landscape_left":       value = HIDInjector.orientationLandscapeLeft
            case "landscape_right":      value = HIDInjector.orientationLandscapeRight
            default:
                print("[clients] Unknown orientation: \(json.orientation)")
                return
            }
            eventContinuation.yield(.orientation(value: value, name: json.orientation))
        } else if type == 0x08 { // WS_MSG_CA_DEBUG
            guard let json = try? JSONDecoder().decode(CADebugEventPayload.self, from: data[1...]) else { return }
            eventContinuation.yield(.caDebug(json))
        } else if type == 0x09 { // WS_MSG_MEMORY_WARNING
            eventContinuation.yield(.memoryWarning)
        } else if type == 0x0A { // WS_MSG_DIGITAL_CROWN
            guard let json = try? JSONDecoder().decode(DigitalCrownEventPayload.self, from: data[1...]) else { return }
            eventContinuation.yield(.digitalCrown(json))
        } else if type == 0x0B { // WS_MSG_SCROLL
            guard let json = try? JSONDecoder().decode(ScrollEventPayload.self, from: data[1...]) else { return }
            eventContinuation.yield(.scroll(json))
        }
    }

    // MARK: - Frame Broadcasting

    func broadcastFrame(jpegData: Data) {
        latestFrame = jpegData
        guard !mjpegClients.isEmpty else { return }
        for client in mjpegClients.values {
            client.send(frame: jpegData)
        }
    }

    func stop() {
        for client in mjpegClients.values {
            client.close()
        }
        for client in avccClients.values {
            client.close()
        }
        mjpegClients.removeAll()
        avccClients.removeAll()
        wsSessions.removeAll()
        avccClientCount = 0
        eventContinuation.finish()
    }
}

/// Thin adapter around Hummingbird's async WebSocket writer.
struct InputWebSocketSession: Sendable {
    let id: Int
    private let outbound: WebSocketOutboundWriter

    init(id: Int, outbound: WebSocketOutboundWriter) {
        self.id = id
        self.outbound = outbound
    }

    func writeBinary(_ data: Data) async {
        var buffer = ByteBufferAllocator().buffer(capacity: data.count)
        buffer.writeBytes(data)
        try? await outbound.write(.binary(buffer))
    }
}

/// A single AVCC streaming client. Unlike `MJPEGClient`, chunks already carry
/// their own length-prefixed envelope, so the writer just forwards raw bytes.
struct AVCCClient: Sendable {
    let id: Int
    let chunks: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation

    init(id: Int) {
        self.id = id
        (chunks, continuation) = AsyncStream.makeStream(of: Data.self, bufferingPolicy: .bufferingNewest(1))
    }

    func send(_ chunk: Data) {
        continuation.yield(chunk)
    }

    func close() {
        continuation.finish()
    }
}

/// Represents a single MJPEG streaming client with a continuation-based writer.
struct MJPEGClient: Sendable {
    let id: Int
    let chunks: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation
    private let boundary = "frame"

    init(id: Int) {
        self.id = id
        (chunks, continuation) = AsyncStream.makeStream(of: Data.self, bufferingPolicy: .bufferingNewest(1))
    }

    func send(frame jpegData: Data) {
        var chunk = Data()
        let header = "--\(boundary)\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpegData.count)\r\n\r\n"
        chunk.append(Data(header.utf8))
        chunk.append(jpegData)
        chunk.append(Data("\r\n".utf8))
        continuation.yield(chunk)
    }

    func close() {
        continuation.finish()
    }
}
