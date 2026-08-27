import Foundation
import Speech

final class Runner: NSObject {
  let url: URL
  var text = ""
  var done = false

  init(url: URL) { self.url = url }

  func start() {
    SFSpeechRecognizer.requestAuthorization { status in
      DispatchQueue.main.async { self.recognize(status) }
    }
  }

  func recognize(_ status: SFSpeechRecognizerAuthorizationStatus) {
    guard status == .authorized else {
      fputs("Allow Speech Recognition for OctoBot (System Settings → Privacy & Security → Speech Recognition).\n", stderr)
      exit(4)
    }
    let rec =
      SFSpeechRecognizer(locale: .current)
      ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    guard let rec else {
      fputs("no recognizer\n", stderr)
      exit(2)
    }
    let req = SFSpeechURLRecognitionRequest(url: url)
    req.shouldReportPartialResults = true
    // On-device-only often returns empty. Let macOS pick.
    req.requiresOnDeviceRecognition = false
    rec.recognitionTask(with: req) { [weak self] result, error in
      guard let self else { return }
      if let t = result?.bestTranscription.formattedString, !t.isEmpty {
        self.text = t
      }
      let finish = {
        guard !self.done else { return }
        self.done = true
        if !self.text.isEmpty {
          print(self.text)
          exit(0)
        }
        if let error {
          fputs("\(error.localizedDescription)\n", stderr)
          exit(3)
        }
        fputs("no speech in recording\n", stderr)
        exit(5)
      }
      if result?.isFinal == true || error != nil { finish() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 18) { [weak self] in
      guard let self, !self.done else { return }
      self.done = true
      if !self.text.isEmpty {
        print(self.text)
        exit(0)
      }
      fputs("speech timed out\n", stderr)
      exit(5)
    }
  }
}

guard CommandLine.arguments.count >= 2 else {
  fputs("usage: dictate FILE.wav\n", stderr)
  exit(1)
}

let path = CommandLine.arguments[1]
guard FileManager.default.fileExists(atPath: path) else {
  fputs("missing audio file\n", stderr)
  exit(1)
}

Runner(url: URL(fileURLWithPath: path)).start()
RunLoop.main.run()
