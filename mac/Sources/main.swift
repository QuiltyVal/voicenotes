// Voicenotes menu bar app: records system audio (any call app: Zoom, Telegram, Meet…) plus the
// microphone into one file with two audio tracks and uploads it to the Voicenotes server,
// which mixes the tracks, transcribes and makes notes.
import AVFoundation
import Cocoa
import ScreenCaptureKit
import Security

// MARK: - Settings

enum Keychain {
    static let service = "Voicenotes"

    static func get(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String, for account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
}

struct ServerSettings {
    var url: String
    var password: String

    static func load() -> ServerSettings? {
        guard let url = UserDefaults.standard.string(forKey: "serverURL"), !url.isEmpty else { return nil }
        return ServerSettings(url: url, password: Keychain.get(url) ?? "")
    }

    func save() {
        UserDefaults.standard.set(url, forKey: "serverURL")
        Keychain.set(password, for: url)
    }

    static func normalize(_ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.contains("://") { value = "https://" + value }
        while value.hasSuffix("/") { value.removeLast() }
        return value
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
    var onStop: ((Error) -> Void)?

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
        }

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
    private func append(_ buffer: CMSampleBuffer, to input: AVAssetWriterInput?) {
        guard let input, let writer, writer.status == .writing, CMSampleBufferIsValid(buffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
        if !sessionStarted {
            writer.startSession(atSourceTime: pts)
            sessionStart = pts
            sessionStarted = true
        }
        guard CMTimeCompare(pts, sessionStart) >= 0, input.isReadyForMoreMediaData else { return }
        input.append(buffer)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        append(sampleBuffer, to: systemInput)
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        append(sampleBuffer, to: micInput)
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
    if !server.password.isEmpty {
        let token = Data("mac:\(server.password)".utf8).base64EncodedString()
        request.setValue("Basic \(token)", forHTTPHeaderField: "Authorization")
    }
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
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                self?.statusItem.button?.title = " " + clock(Date().timeIntervalSince(since))
            }
            item("Остановить и отправить", #selector(stopRecording))
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
        let withMic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        Task { @MainActor in
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
        Task { @MainActor in
            do {
                let file = try await recorder.stop()
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
        let urlField = NSTextField(string: current?.url ?? "")
        urlField.placeholderString = "https://notes.example.com"
        let passwordField = NSSecureTextField(string: current?.password ?? "")
        passwordField.placeholderString = "Пароль от приложения"
        for field in [urlField, passwordField] { field.frame = NSRect(x: 0, y: 0, width: 300, height: 24) }
        let stack = NSStackView(views: [urlField, passwordField])
        stack.orientation = .vertical
        stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 300, height: 56)

        let dialog = NSAlert()
        dialog.messageText = "Настройки Voicenotes"
        dialog.informativeText = "Адрес твоего приложения и пароль от него."
        dialog.accessoryView = stack
        dialog.addButton(withTitle: "Сохранить")
        dialog.addButton(withTitle: "Отмена")
        NSApp.activate(ignoringOtherApps: true)
        dialog.window.initialFirstResponder = urlField
        guard dialog.runModal() == .alertFirstButtonReturn, !urlField.stringValue.isEmpty else { return }
        ServerSettings(url: ServerSettings.normalize(urlField.stringValue), password: passwordField.stringValue).save()
        refresh()
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
