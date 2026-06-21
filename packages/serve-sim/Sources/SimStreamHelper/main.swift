import Foundation
import CoreVideo
import CoreMedia
import AppKit

// Force unbuffered output
setbuf(stdout, nil)
setbuf(stderr, nil)

// Initialize AppKit (needed for HID touch subprocess)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let args = CommandLine.arguments

// Diagnostic: capture ground-truth scroll bytes from a real SimHIDCaptureManager
// session. Usage: serve-sim-bin --capture-scroll <udid> [seconds]
if args.count >= 3, args[1] == "--capture-scroll" {
    let secs = args.count >= 4 ? (Double(args[3]) ?? 20) : 20
    try await CaptureScroll.run(udid: args[2], seconds: secs)
    // CaptureScroll.run calls exit(); this is unreachable.
}

guard args.count >= 2 else {
    fputs("Usage: serve-sim-bin <device-udid> [--port 3100]\n", stderr)
    exit(1)
}

let deviceUDID = args[1]
var port: UInt16 = 3100

// Parse optional --port flag
if let portIdx = args.firstIndex(of: "--port"), portIdx + 1 < args.count,
   let p = UInt16(args[portIdx + 1]) {
    port = p
}

print("[main] Starting serve-sim-bin")
print("[main] Device UDID: \(deviceUDID)")
print("[main] Port: \(port)")

let httpServer = HTTPServer(deviceUDID: deviceUDID, port: port)
let frameCapture = FrameCapture()
let videoEncoder = VideoEncoder(quality: 0.7)
let h264Encoder = H264Encoder(fps: 60)
let hidInjector = HIDInjector()
private let screenState = ScreenState()
private let startup = StartupSignal()
let encodeQueue = DispatchQueue(label: "encode", qos: .userInteractive)
let h264Queue = DispatchQueue(label: "encode.h264", qos: .userInteractive)

var screenWidth = 0
var screenHeight = 0
var encoderReady = false
var encoding = false // backpressure flag (MJPEG)
var h264Encoding = false // backpressure flag (H.264)
// Set when an AVCC client connects; the next H.264 frame is forced to an IDR
// so the freshly-configured decoder has a keyframe to start from.
var forceKeyframe = false

// H.264 output → AVCC envelope → broadcast to /stream.avcc clients.
h264Encoder.onEncoded = { encoded in
    Task {
        if let description = encoded.description {
            await httpServer.clientManager.broadcastAvcc(AVCCEnvelope.description(avcc: description), isDescription: true)
        }
        switch encoded.kind {
        case .keyframe: await httpServer.clientManager.broadcastAvcc(AVCCEnvelope.keyframe(avcc: encoded.avcc))
        case .delta: await httpServer.clientManager.broadcastAvcc(AVCCEnvelope.delta(avcc: encoded.avcc))
        }
    }
}

// Setup HID injector
do {
    try hidInjector.setup(deviceUDID: deviceUDID)
} catch {
    print("[main] Warning: HID setup failed: \(error.localizedDescription)")
}

let clientEventsTask = Task {
    for await event in clientManager.events {
        switch event {
        case .touch(let touch):
            let size = await screenState.size()
            hidInjector.sendTouch(type: touch.type, x: touch.x, y: touch.y,
                                    screenWidth: size.width, screenHeight: size.height,
                                    edge: touch.edge ?? 0)

        case .button(let button):
            if let page = button.page, let usage = button.usage {
                hidInjector.sendButtonHID(page: page, usage: usage, phase: button.phase ?? "press")
            } else {
                hidInjector.sendButton(button: button.button, deviceUDID: deviceUDID)
            }

        case .multiTouch(let multiTouch):
            let size = await screenState.size()
            hidInjector.sendMultiTouch(type: multiTouch.type,
                                        x1: multiTouch.x1, y1: multiTouch.y1,
                                        x2: multiTouch.x2, y2: multiTouch.y2,
                                        screenWidth: size.width, screenHeight: size.height)

        case .key(let key):
            hidInjector.sendKey(type: key.type, usage: key.usage)

        case .orientation(let value, let name):
            if hidInjector.sendOrientation(orientation: value) {
                await clientManager.setScreenOrientation(name)
            } else {
                print("[clients] Orientation request failed: \(name)")
            }

        case .caDebug(let payload):
            _ = hidInjector.setCADebugOption(name: payload.option, enabled: payload.enabled)

        case .memoryWarning:
            hidInjector.simulateMemoryWarning()

        case .digitalCrown(let payload):
            hidInjector.sendDigitalCrown(delta: payload.delta)

        case .scroll(let payload):
            let size = await screenState.size()
            // Payload deltas are a fraction of the display; scale to device pixels.
            hidInjector.sendScroll(dx: payload.dx * Double(size.width),
                                    dy: payload.dy * Double(size.height),
                                    anchorX: payload.x, anchorY: payload.y,
                                    screenWidth: size.width, screenHeight: size.height)

        case .avccClientConnected:
            h264Queue.async {
                requestKeyframe()
            }
        }
    }
}

let serverTask = Task {
    do {
        try await httpServer.run {
            await startup.succeed()
        }
    } catch is CancellationError {
        // Normal shutdown.
    } catch {
        await startup.fail(error)
        throw error
    }
}

// Start HTTP + WebSocket server
do {
    try await startup.wait()
} catch {
    print("[main] Failed to start server: \(error.localizedDescription)")
    clientEventsTask.cancel()
    exit(1)
}

// Start frame capture — encoder is initialized lazily on first frame.
// The framebuffer surface may not be available immediately after boot,
// so retry a few times with backoff before giving up.
let frameHandler: (CVPixelBuffer, CMTime) -> Void = { pixelBuffer, timestamp in
    let w = CVPixelBufferGetWidth(pixelBuffer)
    let h = CVPixelBufferGetHeight(pixelBuffer)

    // Initialize encoder on first frame with actual dimensions
    if !encoderReady || w != screenWidth || h != screenHeight {
        screenWidth = w
        screenHeight = h
        print("[main] Frame dimensions: \(w)x\(h), (re)initializing encoder")

        videoEncoder.stop()
        videoEncoder.setup(
            width: Int32(w),
            height: Int32(h),
            fps: 60,
            onEncodedFrame: { jpegData in
                Task {
                    await httpServer.clientManager.broadcastFrame(jpegData: jpegData)
                }
            }
        )
        encoderReady = true

        // Update client manager config
        Task {
            await screenState.set(width: w, height: h)
            await httpServer.clientManager.setScreenSize(width: w, height: h)
        }
    }

    if encoderReady, !encoding {
        // Backpressure: skip frame if encoder is still working on the previous one
        encoding = true
        let workItem = DispatchWorkItem {
            videoEncoder.encode(pixelBuffer: pixelBuffer)
            encoding = false
        }
        encodeQueue.async(execute: workItem)
    }

    // H.264 path runs only while at least one AVCC viewer is connected, so an
    // all-MJPEG session pays no VideoToolbox cost. Its own backpressure flag
    // lets it skip independently of the JPEG encoder.
    Task {
        guard await httpServer.clientManager.hasAvccClients() else { return }
        let workItem = DispatchWorkItem {
            if h264Encoding { return }
            h264Encoding = true
            let force = forceKeyframe
            forceKeyframe = false
            h264Encoder.encode(pixelBuffer, forceKeyframe: force) {
                h264Queue.async {
                    h264Encoding = false
                }
            }
        }
        h264Queue.async(execute: workItem)
    }
}

do {
    try frameCapture.start(deviceUDID: deviceUDID, onFrame: frameHandler)
    print("[main] Capture started, waiting for frames...")
    print("\nOpen your browser at: http://localhost:\(port)")
    print("Press Ctrl+C to stop.\n")
} catch {
    print("[main] Failed to start capture: \(error.localizedDescription)")
    clientEventsTask.cancel()
    serverTask.cancel()
    await httpServer.clientManager.stop()
    exit(1)
}

await waitForTerminationSignal()

print("\n[main] Shutting down...")
frameCapture.stop()
videoEncoder.stop()
h264Encoder.stop()
await httpServer.clientManager.stop()
clientEventsTask.cancel()
serverTask.cancel()
_ = try? await serverTask.value

private func waitForTerminationSignal() async {
    await withCheckedContinuation { continuation in
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)

        let sigint = DispatchSource.makeSignalSource(signal: SIGINT)
        let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM)
        let state = SignalContinuation(continuation: continuation, sources: [sigint, sigterm])

        sigint.setEventHandler {
            Task { await state.resume() }
        }
        sigterm.setEventHandler {
            Task { await state.resume() }
        }

        sigint.resume()
        sigterm.resume()
    }
}

private actor StartupSignal {
    private var continuation: CheckedContinuation<Void, Error>?
    private var result: Result<Void, Error>?

    func wait() async throws {
        if let result {
            try result.get()
            return
        }

        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func succeed() {
        complete(.success(()))
    }

    func fail(_ error: Error) {
        complete(.failure(error))
    }

    private func complete(_ result: Result<Void, Error>) {
        guard self.result == nil else { return }
        self.result = result
        continuation?.resume(with: result)
        continuation = nil
    }
}

private actor ScreenState {
    private var width = 0
    private var height = 0

    func set(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    func size() -> (width: Int, height: Int) {
        (width, height)
    }
}

private actor SignalContinuation {
    private var continuation: CheckedContinuation<Void, Never>?
    private let sources: [DispatchSourceSignal]

    init(continuation: CheckedContinuation<Void, Never>, sources: [DispatchSourceSignal]) {
        self.continuation = continuation
        self.sources = sources
    }

    func resume() {
        guard let continuation else { return }
        self.continuation = nil
        for source in sources {
            source.cancel()
        }
        continuation.resume()
    }
}
