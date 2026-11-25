import AppKit
import zlib

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let canvas = NSSize(width: 64, height: 64)
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 48, weight: .medium),
    .foregroundColor: NSColor(calibratedWhite: 0.55, alpha: 1),
]

// Recompress the filtered scanlines without changing any other PNG chunk.
func optimizedPNG(_ png: Data, scanlineCapacity: Int) -> Data {
    let idat = Array("IDAT".utf8)
    let bytes = [UInt8](png)
    var compressed: [UInt8] = []
    var start: Int?
    var end = 8 // Skip the PNG signature.
    while end < bytes.count {
        let length = bytes[end..<(end + 4)].reduce(0) { ($0 << 8) | Int($1) }
        let chunkEnd = end + 12 + length
        if bytes[(end + 4)..<(end + 8)].elementsEqual(idat) {
            start = start ?? end
            compressed += bytes[(end + 8)..<(chunkEnd - 4)]
        } else if start != nil {
            break
        }
        end = chunkEnd
    }
    guard let start else { return png }

    var scanlines = [UInt8](repeating: 0, count: scanlineCapacity)
    var scanlineLength = uLongf(scanlines.count)
    guard uncompress(&scanlines, &scanlineLength, compressed, uLong(compressed.count)) == Z_OK
    else { return png }

    var outputLength = compressBound(scanlineLength)
    var output = [UInt8](repeating: 0, count: Int(outputLength))
    guard compress2(&output, &outputLength, scanlines, scanlineLength, Z_BEST_COMPRESSION) == Z_OK,
          outputLength < compressed.count else { return png }

    let payload = idat + output.prefix(Int(outputLength))
    let checksum = UInt32(crc32(0, payload, uInt(payload.count)))
    var lengthField = UInt32(outputLength).bigEndian
    var crcField = checksum.bigEndian
    var result = Data(bytes[..<start])
    withUnsafeBytes(of: &lengthField) { result.append(contentsOf: $0) }
    result.append(contentsOf: payload)
    withUnsafeBytes(of: &crcField) { result.append(contentsOf: $0) }
    result.append(contentsOf: bytes[end...])
    return result
}

while let line = readLine() {
    let fields = line.split(separator: "\t", maxSplits: 1)
    let filename = String(fields[0]) + ".png"
    let glyph = String(fields[1]) as NSString
    let size = glyph.size(withAttributes: attributes)
    let image = NSImage(size: canvas)
    image.lockFocus()
    glyph.draw(at: NSPoint(x: (canvas.width - size.width) / 2,
                           y: (canvas.height - size.height) / 2), withAttributes: attributes)
    image.unlockFocus()

    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: filename])
    }
    let preview = fields[0].hasPrefix("unicode-")
        ? optimizedPNG(png, scanlineCapacity: bitmap.pixelsHigh * (bitmap.bytesPerRow + 1))
        : png
    try preview.write(to: directory.appendingPathComponent(filename))
}
