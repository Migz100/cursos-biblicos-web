// OCR de una imagen con Vision (español). Salida: JSON {"width":W,"height":H,"words":[{text,x,y,w,h,conf}]}
// Coordenadas en píxeles, origen arriba-izquierda.
// Uso: swift scripts/ocr-image.swift imagen.png
import Foundation
import Vision
import CoreImage

let args = CommandLine.arguments
guard args.count > 1 else {
  FileHandle.standardError.write("falta la ruta de la imagen\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: args[1])
guard let ciImage = CIImage(contentsOf: url) else {
  FileHandle.standardError.write("no se pudo abrir la imagen\n".data(using: .utf8)!)
  exit(1)
}
let W = ciImage.extent.width
let H = ciImage.extent.height

let request = VNRecognizeTextRequest()
request.recognitionLanguages = ["es"]
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
do {
  try handler.perform([request])
} catch {
  FileHandle.standardError.write("error Vision: \(error.localizedDescription)\n".data(using: .utf8)!)
  exit(1)
}

struct Word: Codable {
  let text: String
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let conf: Double
}

var words: [Word] = []
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let box = observation.boundingBox
  // Vision: origen abajo-izquierda, coordenadas normalizadas -> píxeles arriba-izquierda
  let x = box.origin.x * W
  let y = (1 - box.origin.y - box.height) * H
  words.append(Word(
    text: candidate.string,
    x: x, y: y,
    w: box.width * W,
    h: box.height * H,
    conf: Double(candidate.confidence)
  ))
}

let output: [String: Any] = ["width": W, "height": H, "words": words.map { ["text": $0.text, "x": $0.x, "y": $0.y, "w": $0.w, "h": $0.h, "conf": $0.conf] }]
let data = try JSONSerialization.data(withJSONObject: output)
FileHandle.standardOutput.write(data)
