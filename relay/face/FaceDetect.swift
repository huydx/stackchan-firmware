// Face detection helper for the relay, using Apple's Vision framework.
// Reads frames from stdin as a 4-byte big-endian length followed by image
// data (JPEG), and writes one JSON line per frame:
//   {"faces":[{"x":0.5,"y":0.4,"w":0.2,"h":0.3}]}
// Coordinates are normalized with the origin at the top-left of the image.
import CoreGraphics
import Foundation
import ImageIO
import Vision

let input = FileHandle.standardInput
let output = FileHandle.standardOutput

func readExactly(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        let chunk = input.readData(ofLength: count - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

while let header = readExactly(4) {
    let length = header.reduce(0) { $0 << 8 | Int($1) }
    guard length > 0, length < 1_000_000, let image = readExactly(length) else { break }
    var faces: [[String: Double]] = []
    if let source = CGImageSourceCreateWithData(image as CFData, nil),
       let picture = CGImageSourceCreateImageAtIndex(source, 0, nil) {
        let request = VNDetectFaceRectanglesRequest()
        try? VNImageRequestHandler(cgImage: picture, options: [:]).perform([request])
        for face in request.results ?? [] {
            let box = face.boundingBox  // Vision's origin is bottom-left
            faces.append(["x": box.midX, "y": 1 - box.midY, "w": box.width, "h": box.height])
        }
    }
    var line = try JSONSerialization.data(withJSONObject: ["faces": faces])
    line.append(10)
    output.write(line)
}
