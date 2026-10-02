// Voicenotes menu bar app: records system audio (any call app: Zoom, Telegram, Meet…) plus the
// microphone into one file with two audio tracks and uploads it to the Voicenotes server,
// which mixes the tracks, transcribes and makes notes.
import AVFoundation
import Cocoa
import ScreenCaptureKit

// MARK: - Settings

struct ServerSettings {
    var url: String
    var password: String

    static func load() -> ServerSettings? {
        guard let url = UserDefaults.standard.string(forKey: "serverURL"), !url.isEmpty else { return nil }
        // Stored in the app's own preferences: no Keychain, so macOS never asks for the Mac password.
        return ServerSettings(url: url, password: UserDefaults.standard.string(forKey: "serverPassword") ?? "")
    }

    func save() {
        UserDefaults.standard.set(url, forKey: "serverURL")
        UserDefaults.standard.set(password, forKey: "serverPassword")
    }

    static func normalize(_ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.contains("://") { value = "https://" + value }
        // http:// on a real domain gets redirected to https, and the redirect drops the password.
        if value.hasPrefix("http://"), let host = URL(string: value)?.host,
           !(host == "localhost" || host.hasPrefix("127.") || host.hasSuffix(".local")) {
            value = "https://" + value.dropFirst("http://".count)
        }
        if let url = URL(string: value), let scheme = url.scheme, let host = url.host {
            value = "\(scheme)://\(host)" + (url.port.map { ":\($0)" } ?? "") // drop any path like /#/m/...
        }
        return value
    }

    func authorize(_ request: inout URLRequest) {
        guard !password.isEmpty else { return }
        let token = Data("voicenotes:\(password)".utf8).base64EncodedString()
        request.setValue("Basic \(token)", forHTTPHeaderField: "Authorization")
    }

    /// nil when the server accepts the address and password, otherwise what's wrong.
    func check() async -> String? {
        guard let url = URL(string: self.url + "/api/status") else { return "Неверный адрес." }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        authorize(&request)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
            case 200: return nil
            case 401: return "Сервер не принял пароль. Введи тот же пароль, что при входе в приложение в браузере (логин там любой)."
            case let code: return "Сервер ответил \(code). Проверь адрес — тот же, что открываешь в браузере."
            }
        } catch {
            return "Не удалось подключиться к \(self.url): \(error.localizedDescription)"
        }
    }
}

// MARK: - Recorder

enum RecorderError: LocalizedError {
    case noDisplay, writer(String), empty

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "Не найден экран для захвата звука."
        case .writer(let detail): return "Не удалось записать файл: \(detail)"
        case .empty: return "Запись пустая — звук не поступал."
        }
    }
}

/// Appends to ~/Library/Logs/Voicenotes.log — what the app saw, for diagnosing silent recordings.
func vnLog(_ message: String) {
    let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Voicenotes.log")
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    if let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? Data(line.utf8).write(to: url)
    }
}

/// How much audio a source delivered: buffers received, appended to the file, and loudest sample.
struct SourceStats {
    var received = 0
    var appended = 0
    var peak: Float = 0
    var format = ""

    var summary: String {
        if received == 0 { return "не поступает" }
        if peak < 0.0005 { return "тишина" }
        return "есть звук"
    }
}

/// Loudest sample in an audio buffer (float or 16-bit PCM), 0…1.
func peakLevel(of buffer: CMSampleBuffer, format: AudioStreamBasicDescription) -> Float {
    var sizeNeeded = 0
    CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        buffer, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil, bufferListSize: 0,
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
    guard sizeNeeded > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
    var block: CMBlockBuffer?
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        buffer, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: sizeNeeded,
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block) == noErr
    else { return 0 }
    let isFloat = format.mFormatFlags & kAudioFormatFlagIsFloat != 0
    var peak: Float = 0
    for audio in UnsafeMutableAudioBufferListPointer(list) {
        guard let data = audio.mData else { continue }
        if isFloat && format.mBitsPerChannel == 32 {
            let count = Int(audio.mDataByteSize) / 4
            let samples = data.bindMemory(to: Float.self, capacity: count)
            for i in 0..<count { peak = max(peak, abs(samples[i])) }
        } else if format.mBitsPerChannel == 16 {
            let count = Int(audio.mDataByteSize) / 2
            let samples = data.bindMemory(to: Int16.self, capacity: count)
            for i in 0..<count { peak = max(peak, Float(abs(Int32(samples[i]))) / 32768) }
        }
    }
    return peak
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let queue = DispatchQueue(label: "voicenotes.writer")
    private var stream: SCStream?
    private var session: AVCaptureSession?
    private var writer: AVAssetWriter?
    private var systemInput: AVAssetWriterInput?
    private var micInput: AVAssetWriterInput?
    private var sessionStarted = false
    private var sessionStart = CMTime.invalid
    private var fileURL: URL?
    private var systemStats = SourceStats()
    private var micStats = SourceStats()
    private(set) var micEnabled = false
    var onStop: ((Error) -> Void)?

    /// Live numbers for the menu (read on the writer queue, where they're updated).
    func stats() -> (system: SourceStats, mic: SourceStats) {
        queue.sync { (systemStats, micStats) }
    }

    static var recordingsDir: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Voicenotes/recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func start(withMicrophone: Bool) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw RecorderError.noDisplay }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 1
        // Video can't be switched off; keep it as small and rare as possible.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let url = Recorder.recordingsDir.appendingPathComponent("meeting_\(formatter.string(from: Date())).mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let aac: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64000,
        ]
        let system = AVAssetWriterInput(mediaType: .audio, outputSettings: aac)
        system.expectsMediaDataInRealTime = true
        writer.add(system)
        var mic: AVAssetWriterInput?
        if withMicrophone {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: aac)
            input.expectsMediaDataInRealTime = true
            writer.add(input)
            mic = input
        }
        guard writer.startWriting() else {
            throw RecorderError.writer(writer.error?.localizedDescription ?? "неизвестная ошибка")
        }

        queue.sync {
            self.writer = writer
            self.systemInput = system
            self.micInput = mic
            self.fileURL = url
            self.sessionStarted = false
            self.systemStats = SourceStats()
            self.micStats = SourceStats()
        }
        micEnabled = withMicrophone
        vnLog("start: microphone=\(withMicrophone) display=\(display.width)x\(display.height) file=\(url.lastPathComponent)")

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream

        if withMicrophone, let device = AVCaptureDevice.default(for: .audio) {
            let session = AVCaptureSession()
            let input = try AVCaptureDeviceInput(device: device)
            if session.canAddInput(input) { session.addInput(input) }
            let output = AVCaptureAudioDataOutput()
            output.audioSettings = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsNonInterleaved: false,
                AVLinearPCMIsBigEndianKey: false,
            ]
            output.setSampleBufferDelegate(self, queue: queue)
            if session.canAddOutput(output) { session.addOutput(output) }
            session.startRunning()
            self.session = session
        }
    }

    func stop() async throws -> URL {
        if let stream { try? await stream.stopCapture() }
        stream = nil
        session?.stopRunning()
        session = nil
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard let writer = self.writer, let url = self.fileURL else {
                    return continuation.resume(throwing: RecorderError.writer("нет файла"))
                }
                self.writer = nil
                let sys = self.systemStats, mic = self.micStats
                vnLog("stop: system received=\(sys.received) appended=\(sys.appended) peak=\(sys.peak); mic received=\(mic.received) appended=\(mic.appended) peak=\(mic.peak)")
                guard self.sessionStarted else {
                    writer.cancelWriting()
                    return continuation.resume(throwing: RecorderError.empty)
                }
                self.systemInput?.markAsFinished()
                self.micInput?.markAsFinished()
                writer.finishWriting {
                    if writer.status == .completed {
                        continuation.resume(returning: url)
                    } else {
                        continuation.resume(throwing: RecorderError.writer(writer.error?.localizedDescription ?? "ошибка записи"))
                    }
                }
            }
        }
    }

    // Both sources deliver host-clock timestamps on the same queue, so they line up in one file.
    private func measure(_ buffer: CMSampleBuffer, _ stats: inout SourceStats, _ name: String) {
        stats.received += 1
        guard let description = CMSampleBufferGetFormatDescription(buffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee
        else { return }
        if stats.format.isEmpty {
            stats.format = "\(Int(asbd.mSampleRate)) Hz, \(asbd.mChannelsPerFrame) ch, \(asbd.mBitsPerChannel) bit, flags \(asbd.mFormatFlags)"
            vnLog("\(name): first buffer \(stats.format)")
        }
        stats.peak = max(stats.peak, peakLevel(of: buffer, format: asbd))
    }

    @discardableResult
    private func append(_ buffer: CMSampleBuffer, to input: AVAssetWriterInput?) -> Bool {
        guard let input, let writer, CMSampleBufferIsValid(buffer) else { return false }
        guard writer.status == .writing else {
            if writer.status == .failed { vnLog("writer failed: \(writer.error?.localizedDescription ?? "?")") }
            return false
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
        if !sessionStarted {
            writer.startSession(atSourceTime: pts)
            sessionStart = pts
            sessionStarted = true
        }
        guard CMTimeCompare(pts, sessionStart) >= 0, input.isReadyForMoreMediaData else { return false }
        if !input.append(buffer) {
            vnLog("append failed: \(writer.error?.localizedDescription ?? "unknown")")
            return false
        }
        return true
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        measure(sampleBuffer, &systemStats, "system")
        if append(sampleBuffer, to: systemInput) { systemStats.appended += 1 }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        measure(sampleBuffer, &micStats, "mic")
        if append(sampleBuffer, to: micInput) { micStats.appended += 1 }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { self.onStop?(error) }
    }
}

// MARK: - Upload

enum UploadError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let text) = self { return text }
        return nil
    }
}

func upload(file: URL, recordedAt: Date, to server: ServerSettings) async throws -> URL {
    guard var components = URLComponents(string: server.url + "/api/meetings") else {
        throw UploadError.message("Неверный адрес сервера в настройках")
    }
    components.queryItems = [
        URLQueryItem(name: "filename", value: file.lastPathComponent),
        URLQueryItem(name: "recordedAt", value: ISO8601DateFormatter().string(from: recordedAt)),
    ]
    var request = URLRequest(url: components.url!)
    request.httpMethod = "POST"
    request.timeoutInterval = 900
    request.setValue("video/quicktime", forHTTPHeaderField: "Content-Type")
    server.authorize(&request)
    let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 { throw UploadError.message("Неверный пароль — проверь настройки") }
    guard status == 201,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = json["id"] as? String
    else {
        let text = String(data: data, encoding: .utf8) ?? ""
        throw UploadError.message("Сервер ответил \(status) \(text.prefix(200))")
    }
    return URL(string: "\(server.url)/#/m/\(id)")!
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    enum State {
        case idle
        case starting
        case recording(since: Date)
        case uploading
        case failed(file: URL, recordedAt: Date, error: String)
    }

    // Created in applicationDidFinishLaunching: items made earlier can stay invisible on newer macOS.
    private var statusItem: NSStatusItem!
    private let recorder = Recorder()
    private var state = State.idle { didSet { refresh() } }
    private var timer: Timer?
    private var silenceWarned = false
    private var lastMeeting: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.isVisible = true
        NSLog("Voicenotes: started")
        recorder.onStop = { [weak self] error in
            guard let self, case .recording = self.state else { return }
            self.alert("Запись остановилась", error.localizedDescription)
            self.stopRecording()
        }
        // A recording left from a failed upload or an app restart: offer to send it.
        let leftovers = (try? FileManager.default.contentsOfDirectory(
            at: Recorder.recordingsDir, includingPropertiesForKeys: [.creationDateKey]
        ))?.filter { $0.pathExtension == "mov" } ?? []
        if let file = leftovers.max(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let created = (try? file.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
            state = .failed(file: file, recordedAt: created, error: "запись ещё не отправлена")
        }
        refresh()
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
        if ServerSettings.load() == nil { showSettings() }
    }

    // MARK: Menu

    private func refresh() {
        guard let statusItem, let button = statusItem.button else { return }
        let menu = NSMenu()
        func item(_ title: String, _ action: Selector?, enabled: Bool = true) {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
            entry.target = self
            entry.isEnabled = enabled && action != nil
            menu.addItem(entry)
        }

        timer?.invalidate()
        button.contentTintColor = nil
        switch state {
        case .idle:
            button.image = symbol("waveform")
            button.title = button.image == nil ? "VN" : ""
            item("Начать запись", #selector(startRecording))
            menu.addItem(.separator())
            item("Пишется звук всех приложений и микрофон. Предупреди участников.", nil, enabled: false)
        case .starting:
            button.image = symbol("hourglass")
            item("Запускаю…", nil, enabled: false)
        case .recording(let since):
            button.image = symbol("record.circle.fill")
            button.contentTintColor = .systemRed
            button.title = " " + clock(Date().timeIntervalSince(since))
            item("Остановить и отправить", #selector(stopRecording))
            menu.addItem(.separator())
            let systemLine = NSMenuItem(title: "Звук приложений: …", action: nil, keyEquivalent: "")
            let micLine = NSMenuItem(title: "Микрофон: …", action: nil, keyEquivalent: "")
            systemLine.isEnabled = false
            micLine.isEnabled = false
            menu.addItem(systemLine)
            menu.addItem(micLine)
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                guard let self else { return }
                let elapsed = Date().timeIntervalSince(since)
                self.statusItem.button?.title = " " + clock(elapsed)
                let stats = self.recorder.stats()
                systemLine.title = "Звук приложений: \(stats.system.summary)"
                micLine.title = self.recorder.micEnabled ? "Микрофон: \(stats.mic.summary)" : "Микрофон: не разрешён"
                // Speak up early instead of recording an hour of silence.
                if elapsed > 8, !self.silenceWarned,
                   stats.system.peak < 0.0005, !self.recorder.micEnabled || stats.mic.peak < 0.0005 {
                    self.silenceWarned = true
                    self.alert(
                        "Звук не записывается",
                        "Звук приложений: \(stats.system.summary). Микрофон: \(self.recorder.micEnabled ? stats.mic.summary : "не разрешён").\n\nПроверь: Системные настройки → Конфиденциальность и безопасность → «Микрофон» и «Запись экрана и системного звука» — Voicenotes включён. После включения перезапусти программу."
                    )
                }
            }
        case .uploading:
            button.image = symbol("arrow.up.circle")
            button.title = button.image == nil ? "VN" : ""
            item("Отправляю запись…", nil, enabled: false)
        case .failed(_, _, let error):
            button.image = symbol("exclamationmark.triangle")
            button.title = button.image == nil ? "VN" : ""
            item("Не отправилось: \(error)", nil, enabled: false)
            item("Повторить отправку", #selector(retryUpload))
            item("Показать файл в Finder", #selector(revealFailed))
            item("Удалить запись", #selector(discardFailed))
        }

        menu.addItem(.separator())
        if let lastMeeting {
            let entry = NSMenuItem(title: "Открыть последнюю встречу", action: #selector(openLastMeeting), keyEquivalent: "")
            entry.target = self
            menu.addItem(entry)
        }
        item("Открыть Voicenotes", #selector(openApp))
        item("Настройки…", #selector(showSettings))
        menu.addItem(.separator())
        item("Выйти", #selector(quit))
        statusItem.menu = menu
    }

    private func symbol(_ name: String) -> NSImage? {
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "Voicenotes")
        image?.isTemplate = true
        if image == nil { statusItem.button?.title = "VN" } // never leave an empty, zero-width item
        return image
    }

    // MARK: Actions

    @objc private func startRecording() {
        guard ServerSettings.load() != nil else { return showSettings() }
        state = .starting
        silenceWarned = false
        Task { @MainActor in
            // Ask for the microphone first and wait for the answer, so recording never starts without it by accident.
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .audio)
            }
            let withMic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
            do {
                try await recorder.start(withMicrophone: withMic)
                state = .recording(since: Date())
                if !withMic {
                    alert("Микрофон не разрешён", "Пишется только звук приложений. Разреши микрофон: Системные настройки → Конфиденциальность и безопасность → Микрофон → Voicenotes.")
                }
            } catch {
                state = .idle
                askForScreenPermission(error)
            }
        }
    }

    @objc private func stopRecording() {
        guard case .recording(let since) = state else { return }
        state = .uploading
        let stats = recorder.stats()
        Task { @MainActor in
            do {
                let file = try await recorder.stop()
                if stats.system.peak < 0.0005 && stats.mic.peak < 0.0005 {
                    state = .failed(file: file, recordedAt: since, error: "в записи тишина")
                    alert(
                        "Запись пустая",
                        "Звук приложений: \(stats.system.summary), микрофон: \(recorder.micEnabled ? stats.mic.summary : "не разрешён"). Файл не отправлен.\n\nПришли, что написано в журнале: в Терминале выполни  tail -20 ~/Library/Logs/Voicenotes.log"
                    )
                    return
                }
                await send(file: file, recordedAt: since)
            } catch {
                state = .idle
                alert("Не удалось сохранить запись", error.localizedDescription)
            }
        }
    }

    @MainActor private func send(file: URL, recordedAt: Date) async {
        guard let server = ServerSettings.load() else {
            state = .failed(file: file, recordedAt: recordedAt, error: "не указан сервер")
            return
        }
        state = .uploading
        do {
            let meeting = try await upload(file: file, recordedAt: recordedAt, to: server)
            try? FileManager.default.removeItem(at: file)
            lastMeeting = meeting
            state = .idle
            NSWorkspace.shared.open(meeting)
        } catch {
            state = .failed(file: file, recordedAt: recordedAt, error: error.localizedDescription)
        }
    }

    @objc private func retryUpload() {
        guard case .failed(let file, let recordedAt, _) = state else { return }
        Task { @MainActor in await send(file: file, recordedAt: recordedAt) }
    }

    @objc private func revealFailed() {
        guard case .failed(let file, _, _) = state else { return }
        NSWorkspace.shared.activateFileViewerSelecting([file])
    }

    @objc private func discardFailed() {
        guard case .failed(let file, _, _) = state else { return }
        try? FileManager.default.removeItem(at: file)
        state = .idle
    }

    @objc private func openLastMeeting() {
        if let lastMeeting { NSWorkspace.shared.open(lastMeeting) }
    }

    @objc private func openApp() {
        guard let server = ServerSettings.load(), let url = URL(string: server.url) else { return showSettings() }
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() {
        if case .recording = state {
            let confirm = NSAlert()
            confirm.messageText = "Идёт запись"
            confirm.informativeText = "Остановить её и отправить перед выходом?"
            confirm.addButton(withTitle: "Отправить и выйти")
            confirm.addButton(withTitle: "Отмена")
            NSApp.activate(ignoringOtherApps: true)
            guard confirm.runModal() == .alertFirstButtonReturn else { return }
            stopRecording()
            Task { @MainActor in
                while case .uploading = state { try? await Task.sleep(nanoseconds: 300_000_000) }
                NSApp.terminate(nil)
            }
            return
        }
        NSApp.terminate(nil)
    }

    @objc private func showSettings() {
        let current = ServerSettings.load()
        // Plain frame layout: NSAlert's accessory view doesn't size stack views reliably.
        let width: CGFloat = 320
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 116))
        func label(_ text: String, y: CGFloat) {
            let field = NSTextField(labelWithString: text)
            field.font = .systemFont(ofSize: 12, weight: .medium)
            field.frame = NSRect(x: 0, y: y, width: width, height: 16)
            container.addSubview(field)
        }
        label("Адрес приложения", y: 98)
        let urlField = NSTextField(frame: NSRect(x: 0, y: 70, width: width, height: 24))
        urlField.stringValue = current?.url ?? ""
        urlField.placeholderString = "https://notes.example.com"
        container.addSubview(urlField)
        label("Пароль от приложения", y: 40)
        let passwordField = NSSecureTextField(frame: NSRect(x: 0, y: 12, width: width, height: 24))
        passwordField.stringValue = current?.password ?? ""
        container.addSubview(passwordField)

        let dialog = NSAlert()
        dialog.messageText = "Настройки Voicenotes"
        dialog.informativeText = "Тот же адрес, что открываешь в браузере, и тот же пароль."
        dialog.accessoryView = container
        dialog.addButton(withTitle: "Сохранить")
        dialog.addButton(withTitle: "Отмена")
        NSApp.activate(ignoringOtherApps: true)
        dialog.window.initialFirstResponder = urlField
        guard dialog.runModal() == .alertFirstButtonReturn, !urlField.stringValue.isEmpty else { return }
        let settings = ServerSettings(
            url: ServerSettings.normalize(urlField.stringValue),
            password: passwordField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        settings.save()
        refresh()
        Task { @MainActor in
            if let problem = await settings.check() {
                alert("Не подключилось", problem)
                showSettings()
            } else {
                alert("Подключено ✓", "Адрес и пароль верные. Если запись не отправилась — в меню значка нажми «Повторить отправку».")
            }
        }
    }

    private func askForScreenPermission(_ error: Error) {
        let dialog = NSAlert()
        dialog.messageText = "Не получилось начать запись"
        dialog.informativeText = """
        Скорее всего, не выдано разрешение на запись звука. Открой Системные настройки → \
        Конфиденциальность и безопасность → «Запись экрана и системного звука», включи Voicenotes \
        и перезапусти программу.

        (\(error.localizedDescription))
        """
        dialog.addButton(withTitle: "Открыть настройки")
        dialog.addButton(withTitle: "Закрыть")
        NSApp.activate(ignoringOtherApps: true)
        if dialog.runModal() == .alertFirstButtonReturn,
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    private func alert(_ title: String, _ text: String) {
        let dialog = NSAlert()
        dialog.messageText = title
        dialog.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        dialog.runModal()
    }
}

func clock(_ seconds: TimeInterval) -> String {
    let s = Int(seconds)
    return s >= 3600
        ? String(format: "%d:%02d:%02d", s / 3600, s % 3600 / 60, s % 60)
        : String(format: "%02d:%02d", s / 60, s % 60)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
