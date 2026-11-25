#!/usr/bin/env swift
// Renders crisp macOS-style PNG icons for the World Time Alfred workflow.
// Usage: swift world-time/scripts/render-icons.swift

import AppKit
import CoreGraphics
import Foundation

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let workflowDir = scriptURL.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("workflow")
let iconsDir = workflowDir.appendingPathComponent("icons")

try FileManager.default.createDirectory(at: iconsDir, withIntermediateDirectories: true)

func renderPNG(size: Int, to url: URL, draw: (CGContext, CGFloat) -> Void) throws {
    let s = CGFloat(size)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw NSError(domain: "render-icons", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create CGContext"])
    }
    ctx.setAllowsAntialiasing(true)
    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high
    draw(ctx, s)

    guard let cgImage = ctx.makeImage() else {
        throw NSError(domain: "render-icons", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to make CGImage"])
    }
    let rep = NSBitmapImageRep(cgImage: cgImage)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "render-icons", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to encode PNG"])
    }
    try png.write(to: url)
}

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1.0) -> CGColor {
    CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: [r / 255, g / 255, b / 255, a])!
}

func fillLinearGradient(
    _ ctx: CGContext,
    colors: [CGColor],
    locations: [CGFloat],
    start: CGPoint,
    end: CGPoint
) {
    let grad = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: colors as CFArray,
        locations: locations
    )!
    ctx.drawLinearGradient(grad, start: start, end: end, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

func drawSquircleBadge(_ ctx: CGContext, size s: CGFloat, colors: [CGColor]) {
    let pad = s * 0.055
    let rect = CGRect(x: pad, y: pad, width: s - pad * 2, height: s - pad * 2)
    let radius = rect.width * 0.225
    let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let locs: [CGFloat] = colors.count == 3 ? [0.0, 0.52, 1.0] : [0.0, 1.0]
    fillLinearGradient(ctx, colors: colors, locations: locs, start: CGPoint(x: 0, y: s), end: CGPoint(x: s, y: 0))

    // Subtle top highlight
    let highlight = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [color(255, 255, 255, 0.18), color(255, 255, 255, 0.0)] as CFArray,
        locations: [0.0, 0.45]
    )!
    ctx.drawLinearGradient(highlight, start: CGPoint(x: s / 2, y: s), end: CGPoint(x: s / 2, y: s * 0.45), options: [])
    ctx.restoreGState()

    // Crisp hairline border
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setStrokeColor(color(255, 255, 255, 0.16))
    ctx.setLineWidth(s * 0.012)
    ctx.strokePath()
    ctx.restoreGState()
}

func drawCircleBadge(_ ctx: CGContext, size s: CGFloat, colors: [CGColor]) {
    let pad = s * 0.08
    let rect = CGRect(x: pad, y: pad, width: s - pad * 2, height: s - pad * 2)
    let path = CGPath(ellipseIn: rect, transform: nil)

    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let locs: [CGFloat] = colors.count == 3 ? [0.0, 0.55, 1.0] : [0.0, 1.0]
    fillLinearGradient(ctx, colors: colors, locations: locs, start: CGPoint(x: 0, y: s), end: CGPoint(x: s, y: 0))
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(path)
    ctx.setStrokeColor(color(255, 255, 255, 0.22))
    ctx.setLineWidth(s * 0.02)
    ctx.strokePath()
    ctx.restoreGState()
}

// 1. Main Workflow Icon (256x256): Globe + World Clock
try renderPNG(size: 256, to: workflowDir.appendingPathComponent("icon.png")) { ctx, s in
    drawSquircleBadge(ctx, size: s, colors: [
        color(15, 23, 42),   // slate-900
        color(29, 78, 216),  // blue-700
        color(14, 165, 233), // sky-500
    ])

    let cx = s / 2
    let cy = s / 2
    let r = s * 0.34

    // Subtle glowing backdrop behind globe
    let glow = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [color(56, 189, 248, 0.25), color(56, 189, 248, 0.0)] as CFArray,
        locations: [0.0, 1.0]
    )!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: cx, y: cy), startRadius: 0, endCenter: CGPoint(x: cx, y: cy), endRadius: r * 1.25, options: [])

    // Globe circle & subtle meridians/parallels
    ctx.saveGState()
    let globeRect = CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
    let globePath = CGPath(ellipseIn: globeRect, transform: nil)
    ctx.addPath(globePath)
    ctx.clip()

    ctx.setStrokeColor(color(186, 230, 253, 0.28))
    ctx.setLineWidth(s * 0.011)
    // Equator & latitudes
    for factor in [-0.46, 0.0, 0.46] as [CGFloat] {
        let y = cy + r * factor
        ctx.move(to: CGPoint(x: cx - r, y: y))
        ctx.addLine(to: CGPoint(x: cx + r, y: y))
    }
    ctx.strokePath()
    // Meridians (ellipses)
    for wFactor in [0.42, 0.78] as [CGFloat] {
        let mw = r * wFactor
        ctx.strokeEllipse(in: CGRect(x: cx - mw, y: cy - r, width: mw * 2, height: r * 2))
    }
    ctx.restoreGState()

    // Outer clock ring
    ctx.setStrokeColor(color(255, 255, 255, 0.90))
    ctx.setLineWidth(s * 0.028)
    ctx.strokeEllipse(in: globeRect)

    // 12 crisp clock ticks
    for i in 0..<12 {
        let angle = CGFloat(i) * (.pi / 6.0)
        let isMajor = (i % 3 == 0)
        let inner = r * (isMajor ? 0.80 : 0.86)
        let outer = r * 0.93
        ctx.setStrokeColor(color(255, 255, 255, isMajor ? 0.92 : 0.50))
        ctx.setLineWidth(s * (isMajor ? 0.016 : 0.010))
        ctx.setLineCap(.round)
        ctx.move(to: CGPoint(x: cx + cos(angle) * inner, y: cy + sin(angle) * inner))
        ctx.addLine(to: CGPoint(x: cx + cos(angle) * outer, y: cy + sin(angle) * outer))
        ctx.strokePath()
    }

    // Clock hands (10:10 aesthetic)
    ctx.setLineCap(.round)
    // Hour hand (~10 o'clock = 150 deg)
    let hourAngle: CGFloat = 148 * .pi / 180
    ctx.setStrokeColor(color(255, 255, 255, 0.98))
    ctx.setLineWidth(s * 0.036)
    ctx.move(to: CGPoint(x: cx, y: cy))
    ctx.addLine(to: CGPoint(x: cx + cos(hourAngle) * r * 0.48, y: cy + sin(hourAngle) * r * 0.48))
    ctx.strokePath()

    // Minute hand (~2 o'clock = 32 deg)
    let minAngle: CGFloat = 32 * .pi / 180
    ctx.setStrokeColor(color(255, 255, 255, 0.98))
    ctx.setLineWidth(s * 0.026)
    ctx.move(to: CGPoint(x: cx, y: cy))
    ctx.addLine(to: CGPoint(x: cx + cos(minAngle) * r * 0.68, y: cy + sin(minAngle) * r * 0.68))
    ctx.strokePath()

    // Warm amber accent second hand pointing to ~6:20
    let secAngle: CGFloat = -70 * .pi / 180
    ctx.setStrokeColor(color(251, 191, 36, 0.98))
    ctx.setLineWidth(s * 0.014)
    ctx.move(to: CGPoint(x: cx - cos(secAngle) * r * 0.14, y: cy - sin(secAngle) * r * 0.14))
    ctx.addLine(to: CGPoint(x: cx + cos(secAngle) * r * 0.72, y: cy + sin(secAngle) * r * 0.72))
    ctx.strokePath()

    // Center hub
    let hubR = s * 0.036
    ctx.setFillColor(color(251, 191, 36, 1.0))
    ctx.fillEllipse(in: CGRect(x: cx - hubR, y: cy - hubR, width: hubR * 2, height: hubR * 2))
    let innerHubR = s * 0.016
    ctx.setFillColor(color(15, 23, 42, 1.0))
    ctx.fillEllipse(in: CGRect(x: cx - innerHubR, y: cy - innerHubR, width: innerHubR * 2, height: innerHubR * 2))
}

// 2. Day icon
try renderPNG(size: 128, to: iconsDir.appendingPathComponent("day.png")) { ctx, s in
    drawCircleBadge(ctx, size: s, colors: [color(56, 189, 248), color(14, 165, 233)])
    let cx = s / 2, cy = s / 2, sunR = s * 0.17
    ctx.setFillColor(color(254, 240, 138))
    ctx.fillEllipse(in: CGRect(x: cx - sunR, y: cy - sunR, width: sunR * 2, height: sunR * 2))
    ctx.setStrokeColor(color(254, 240, 138))
    ctx.setLineWidth(s * 0.045)
    ctx.setLineCap(.round)
    for i in 0..<8 {
        let a = CGFloat(i) * (.pi / 4)
        ctx.move(to: CGPoint(x: cx + cos(a) * s * 0.24, y: cy + sin(a) * s * 0.24))
        ctx.addLine(to: CGPoint(x: cx + cos(a) * s * 0.31, y: cy + sin(a) * s * 0.31))
    }
    ctx.strokePath()
}

// 3. Dawn icon
try renderPNG(size: 128, to: iconsDir.appendingPathComponent("dawn.png")) { ctx, s in
    drawCircleBadge(ctx, size: s, colors: [color(251, 146, 60), color(244, 114, 182), color(99, 102, 241)])
    let cx = s / 2, hy = s * 0.44, r = s * 0.18
    ctx.saveGState()
    ctx.clip(to: CGRect(x: 0, y: hy, width: s, height: s - hy))
    ctx.setFillColor(color(254, 243, 199))
    ctx.fillEllipse(in: CGRect(x: cx - r, y: hy - r, width: r * 2, height: r * 2))
    ctx.restoreGState()
    ctx.setStrokeColor(color(255, 255, 255, 0.9))
    ctx.setLineWidth(s * 0.045)
    ctx.setLineCap(.round)
    ctx.move(to: CGPoint(x: s * 0.24, y: hy))
    ctx.addLine(to: CGPoint(x: s * 0.76, y: hy))
    ctx.strokePath()
}

// 4. Dusk icon
try renderPNG(size: 128, to: iconsDir.appendingPathComponent("dusk.png")) { ctx, s in
    drawCircleBadge(ctx, size: s, colors: [color(234, 88, 12), color(147, 51, 234), color(30, 27, 75)])
    let cx = s / 2, hy = s * 0.44, r = s * 0.18
    ctx.saveGState()
    ctx.clip(to: CGRect(x: 0, y: hy, width: s, height: s - hy))
    ctx.setFillColor(color(253, 186, 116))
    ctx.fillEllipse(in: CGRect(x: cx - r, y: hy - r, width: r * 2, height: r * 2))
    ctx.restoreGState()
    ctx.setStrokeColor(color(255, 255, 255, 0.85))
    ctx.setLineWidth(s * 0.045)
    ctx.setLineCap(.round)
    ctx.move(to: CGPoint(x: s * 0.24, y: hy))
    ctx.addLine(to: CGPoint(x: s * 0.76, y: hy))
    ctx.strokePath()
}

// 5. Night icon
try renderPNG(size: 128, to: iconsDir.appendingPathComponent("night.png")) { ctx, s in
    drawCircleBadge(ctx, size: s, colors: [color(30, 41, 59), color(15, 23, 42)])
    let cx = s * 0.48, cy = s * 0.50, r = s * 0.22
    // Draw crescent moon using transparency layer
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    ctx.setFillColor(color(226, 232, 240))
    ctx.fillEllipse(in: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
    ctx.setBlendMode(.clear)
    ctx.fillEllipse(in: CGRect(x: cx - r * 0.35, y: cy - r * 0.65, width: r * 1.85, height: r * 1.85))
    ctx.endTransparencyLayer()
    ctx.setBlendMode(.normal)
    // Two tiny stars
    ctx.setFillColor(color(253, 224, 71, 0.95))
    ctx.fillEllipse(in: CGRect(x: s * 0.63, y: s * 0.62, width: s * 0.06, height: s * 0.06))
    ctx.fillEllipse(in: CGRect(x: s * 0.71, y: s * 0.48, width: s * 0.045, height: s * 0.045))
}

// 6. Home icon
try renderPNG(size: 128, to: iconsDir.appendingPathComponent("home.png")) { ctx, s in
    drawCircleBadge(ctx, size: s, colors: [color(16, 185, 129), color(5, 150, 105)])
    ctx.setStrokeColor(color(255, 255, 255))
    ctx.setFillColor(color(255, 255, 255))
    ctx.setLineWidth(s * 0.06)
    ctx.setLineJoin(.round)
    ctx.setLineCap(.round)
    // Roof
    ctx.move(to: CGPoint(x: s * 0.27, y: s * 0.52))
    ctx.addLine(to: CGPoint(x: s * 0.50, y: s * 0.72))
    ctx.addLine(to: CGPoint(x: s * 0.73, y: s * 0.52))
    ctx.strokePath()
    // House body
    let body = CGRect(x: s * 0.34, y: s * 0.30, width: s * 0.32, height: s * 0.23)
    ctx.fill(body)
}

// 7. Convert icon
try renderPNG(size: 128, to: iconsDir.appendingPathComponent("convert.png")) { ctx, s in
    drawCircleBadge(ctx, size: s, colors: [color(99, 102, 241), color(79, 70, 229)])
    ctx.setStrokeColor(color(255, 255, 255))
    ctx.setLineWidth(s * 0.065)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    // Right arrow
    ctx.move(to: CGPoint(x: s * 0.28, y: s * 0.50))
    ctx.addLine(to: CGPoint(x: s * 0.72, y: s * 0.50))
    ctx.move(to: CGPoint(x: s * 0.56, y: s * 0.66))
    ctx.addLine(to: CGPoint(x: s * 0.72, y: s * 0.50))
    ctx.addLine(to: CGPoint(x: s * 0.56, y: s * 0.34))
    ctx.strokePath()
}

// 8. Diff icon
try renderPNG(size: 128, to: iconsDir.appendingPathComponent("diff.png")) { ctx, s in
    drawCircleBadge(ctx, size: s, colors: [color(14, 116, 144), color(21, 94, 117)])
    ctx.setStrokeColor(color(255, 255, 255))
    ctx.setLineWidth(s * 0.065)
    ctx.setLineCap(.round)
    // Plus on top
    ctx.move(to: CGPoint(x: s * 0.36, y: s * 0.60))
    ctx.addLine(to: CGPoint(x: s * 0.64, y: s * 0.60))
    ctx.move(to: CGPoint(x: s * 0.50, y: s * 0.46))
    ctx.addLine(to: CGPoint(x: s * 0.50, y: s * 0.74))
    // Minus on bottom
    ctx.move(to: CGPoint(x: s * 0.36, y: s * 0.33))
    ctx.addLine(to: CGPoint(x: s * 0.64, y: s * 0.33))
    ctx.strokePath()
}

print("Rendered icons to \(workflowDir.path)")
