import Foundation
import CoreVideo
import CoreMedia

// The capture + encode engine, reused verbatim from SimStreamHelper. Replicates
// main.swift's frameHandler: MJPEG always encodes while clients exist; H.264 runs
// only while AVCC is active. Encoded bytes (JPEG, or natively-framed AVCC
// envelopes) are handed back through a Swift closure on a native encode thread;
// the node-swift binding (sim-module.swift) marshals them onto the JS thread via
// a NodeAsyncQueue (threadsafe function).

/// (codec, data, width, height, flags) -> Void, invoked on a native encode
/// thread. codec: 0 = MJPEG, 1 = AVCC. flags (AVCC): bit0 = description,
/// bit1 = keyframe. `data` is a freshly-copied value safe to retain.
typealias SimFrameCallback = (Int32, Data, Int32, Int32, Int32) -> Void

actor CaptureEngine {
    static let codecMJPEG: Int32 = 0
    static let codecAVCC: Int32 = 1
    static let flagDescription: Int32 = 1 << 0
    static let flagKeyframe: Int32 = 1 << 1

    private let deviceUDID: String
    private let onFrame: SimFrameCallback

    private let frameCapture = FrameCapture()
    private let videoEncoder = VideoEncoder(quality: 0.7)
    private let h264Encoder = H264Encoder(fps: 60)
    private static let h264EncodeTimeoutMs = 500

    // Mirrors main.swift's globals; mutated from the capture queue, read from the
    // encode queues. Benign races (same pattern as the standalone helper).
    private var screenWidth = 0
    private var screenHeight = 0
    private var forceKeyframe = false
    private var avccActive = false
    private var h264FrameToken: UInt64 = 0
    private var started = false
    private var stopped = false

    init(deviceUDID: String, onFrame: @escaping SimFrameCallback) {
        self.deviceUDID = deviceUDID
        self.onFrame = onFrame
    }

    /// Hand encoded bytes to the binding. Gated by `stopped` so no callback fires
    /// once teardown has begun.
    private func emit(codec: Int32, data: Data, flags: Int32) {
        if stopped { return }
        onFrame(codec, data, Int32(screenWidth), Int32(screenHeight), flags)
    }

    func start() throws {
        guard !started else { return }
        // Latch `started` only after capture actually begins: if start() throws
        // (e.g. device not booted), a later retry should still be allowed.
        let (frames, frameContinuation) = AsyncStream.makeStream(
            of: CVPixelBuffer.self,
            // drop old frames if there's backpressure
            bufferingPolicy: .bufferingNewest(1)
        )
        try frameCapture.start(deviceUDID: deviceUDID) { [weak self] pixelBuffer, _ in
            guard let self else { return }
            // TODO: skip if there's backpressure
            if let copy = self.copyPixelBuffer(pixelBuffer) {
                frameContinuation.yield(copy)
            }
        }
        Task {
            for await frame in frames {
                await handleFrame(frame)
            }
        }
        started = true
    }

    private func handleFrame(_ pixelBuffer: CVPixelBuffer) async {
        screenWidth = CVPixelBufferGetWidth(pixelBuffer)
        screenHeight = CVPixelBufferGetHeight(pixelBuffer)
        async let handleJPEG = self.handleJPEG(pixelBuffer)
        async let handleH264 = self.handleH264(pixelBuffer)
        _ = await (handleJPEG, handleH264)
    }

    private func handleJPEG(_ pixelBuffer: CVPixelBuffer) async {
        guard let jpeg = await self.videoEncoder.encode(pixelBuffer: pixelBuffer) else { return }
        emit(codec: Self.codecMJPEG, data: jpeg, flags: 0)
    }

    private func handleH264(_ pixelBuffer: CVPixelBuffer) async {
        // H.264 runs only while a viewer wants AVCC, so an all-MJPEG session pays
        // no VideoToolbox cost.
        guard let h264Request = reserveH264EncodeIfNeeded() else { return }
        // TODO: cancel after h264EncodeTimeoutMs
        guard let encoded = await h264Encoder.encode(pixelBuffer, forceKeyframe: h264Request.forceKeyframe)
              else { return }

        if let description = encoded.description {
            emit(
                codec: Self.codecAVCC,
                data: AVCCEnvelope.description(avcc: description),
                flags: Self.flagDescription
            )
        }
        switch encoded.kind {
        case .keyframe:
            emit(
                codec: Self.codecAVCC,
                data: AVCCEnvelope.keyframe(avcc: encoded.avcc),
                flags: Self.flagKeyframe
            )
        case .delta:
            emit(
                codec: Self.codecAVCC,
                data: AVCCEnvelope.delta(avcc: encoded.avcc),
                flags: 0
            )
        }
    }

    /// Copy the live Simulator IOSurface immediately on the capture queue. The
    /// encoders run later and SimulatorKit recycles/mutates that IOSurface in
    /// place, so passing the wrapper CVPixelBuffer across queues can encode a
    /// half-updated frame.
    private nonisolated func copyPixelBuffer(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        let width = CVPixelBufferGetWidth(source)
        let height = CVPixelBufferGetHeight(source)
        let pixelFormat = CVPixelBufferGetPixelFormatType(source)
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ]
        var out: CVPixelBuffer?
        guard CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, pixelFormat, attrs as CFDictionary, &out
        ) == kCVReturnSuccess, let dst = out else { return nil }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        guard let srcAddr = CVPixelBufferGetBaseAddress(source),
              let dstAddr = CVPixelBufferGetBaseAddress(dst) else { return nil }
        let srcStride = CVPixelBufferGetBytesPerRow(source)
        let dstStride = CVPixelBufferGetBytesPerRow(dst)
        let rows = CVPixelBufferGetHeight(source)
        let copyBytes = min(srcStride, dstStride)
        for row in 0..<rows {
            memcpy(dstAddr + row * dstStride, srcAddr + row * srcStride, copyBytes)
        }
        return dst
    }

    private func reserveH264EncodeIfNeeded() -> (forceKeyframe: Bool, token: UInt64)? {
        guard avccActive else { return nil }
        h264FrameToken &+= 1
        let token = h264FrameToken
        let force = forceKeyframe
        forceKeyframe = false
        return (forceKeyframe: force, token: token)
    }

    /// Toggle H.264 encoding. Turning it on forces the next frame to an IDR so a
    /// freshly-connected decoder has a keyframe to start from.
    func setAvccActive(_ active: Bool) {
        if active && !self.avccActive { self.forceKeyframe = true }
        self.avccActive = active
    }

    func requestKeyframe() {
        self.forceKeyframe = true
    }

    func screenSize() -> (Int, Int) { (screenWidth, screenHeight) }

    /// Halt frame production and drain the encode queues so no callback can fire
    /// after this returns — the N-API layer relies on that before releasing the
    /// threadsafe function.
    func stop() {
        if stopped { return }
        stopped = true
        frameCapture.stop()
        Task { [h264Encoder] in await h264Encoder.stop() }
    }
}
