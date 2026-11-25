// Read one SVG per line and return its visible pixel bounds (left, top, right, bottom).
import AppKit

func inkBounds(_ svg: String) -> String {
    guard let image = NSImage(data: Data(svg.utf8)),
          let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          bitmap.pixelsWide == Int(image.size.width),
          bitmap.pixelsHigh == Int(image.size.height),
          bitmap.bitsPerSample == 8, bitmap.bitsPerPixel == 32,
          bitmap.hasAlpha, !bitmap.isPlanar,
          bitmap.bitmapFormat.isDisjoint(with: [.alphaFirst, .thirtyTwoBitLittleEndian]),
          let bytes = bitmap.bitmapData else {
        return "unsupported bitmap"
    }

    var left = bitmap.pixelsWide, top = bitmap.pixelsHigh
    var right = 0, bottom = 0
    for y in 0..<bitmap.pixelsHigh {
        let row = bytes + y * bitmap.bytesPerRow
        for x in 0..<bitmap.pixelsWide where row[x * 4 + 3] >= 32 {
            left = min(left, x)
            top = min(top, y)
            right = max(right, x + 1)
            bottom = max(bottom, y + 1)
        }
    }
    return left < right ? "\(left) \(top) \(right) \(bottom)" : "no visible ink"
}

while let svg = readLine() {
    print(inkBounds(svg))
}
