#!/usr/bin/env python3
"""
Generates crisp, high-resolution PNG icons for the AI Usage Limits extension.
Uses only standard library (zlib, struct) without PIL/Pillow dependencies.
"""
import os
import math
import zlib
import struct

def make_png(width, height, pixel_func):
    """Creates a raw RGBA PNG bytes object."""
    raw_rows = []
    for y in range(height):
        row = [0]  # Filter byte: 0 = None
        for x in range(width):
            r, g, b, a = pixel_func(x, y, width, height)
            row.extend([r, g, b, a])
        raw_rows.append(bytes(row))
    raw_data = b"".join(raw_rows)
    compressed = zlib.compress(raw_data, level=9)

    png = b"\x89PNG\r\n\x1a\n"
    # IHDR
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png += struct.pack(">I", len(ihdr)) + b"IHDR" + ihdr + struct.pack(">I", zlib.crc32(b"IHDR" + ihdr))
    # IDAT
    png += struct.pack(">I", len(compressed)) + b"IDAT" + compressed + struct.pack(">I", zlib.crc32(b"IDAT" + compressed))
    # IEND
    png += struct.pack(">I", 0) + b"IEND" + struct.pack(">I", zlib.crc32(b"IEND"))
    return png

def ai_limit_icon(x, y, w, h):
    """
    Renders an AI limit meter icon:
    - Rounded squircle background with modern gradient (deep indigo to dark violet)
    - Gauge circular arc (emerald green / cyan gradient)
    - Center AI spark / lightning / needle
    """
    # Normalize coordinates to -1.0 .. 1.0
    nx = (x / (w - 1)) * 2.0 - 1.0
    ny = (y / (h - 1)) * 2.0 - 1.0
    dist_center = math.sqrt(nx * nx + ny * ny)

    # Squircle background radius
    # (nx^4 + ny^4) < 1.0 creates a smooth squircle
    squircle = math.pow(abs(nx), 4) + math.pow(abs(ny), 4)
    if squircle > 0.85:
        # Anti-aliasing border
        if squircle > 1.0:
            return (0, 0, 0, 0) # transparent
        alpha = int((1.0 - (squircle - 0.85) / 0.15) * 255)
    else:
        alpha = 255

    # Background gradient: deep violet (#1e1b4b) to (#0f172a)
    bg_t = (ny + 1.0) / 2.0
    bg_r = int(24 + 15 * (1 - bg_t))
    bg_g = int(24 + 20 * (1 - bg_t))
    bg_b = int(45 + 50 * (1 - bg_t))

    # Outer Gauge Ring: radius between 0.50 and 0.75
    angle = math.atan2(ny, nx) # -pi to pi, 0 is right, pi/2 is bottom, -pi/2 is top
    # Let gauge start from 135 deg (-3pi/4) around top to 45 deg (-pi/4) or similar
    # In math: bottom is +y, top is -y
    # angle_deg: 0 at top, clockwise
    angle_norm = math.atan2(nx, -ny) # 0 is straight UP, pi is DOWN
    
    # Ring between r=0.55 and r=0.75
    in_ring = 0.52 <= dist_center <= 0.76
    is_gauge_arc = abs(angle_norm) < 2.5 # spans about 280 degrees
    
    if in_ring and is_gauge_arc:
        # Gauge gradient from green (#10b981) to cyan (#06b6d4) to purple (#8b5cf6)
        t = (angle_norm + 2.5) / 5.0
        r_gauge = int(16 * (1 - t) + 139 * t)
        g_gauge = int(185 * (1 - t) + 92 * t)
        b_gauge = int(129 * (1 - t) + 246 * t)
        return (r_gauge, g_gauge, b_gauge, alpha)

    # Center Sparkle / AI Node (four-pointed star)
    # Equation: abs(nx)^0.5 + abs(ny)^0.5 < radius
    star_dist = math.sqrt(abs(nx)) + math.sqrt(abs(ny))
    if star_dist < 0.65 and dist_center < 0.38:
        # Glowing bright cyan / white core
        star_intensity = 1.0 - (star_dist / 0.65)
        core_r = int(255)
        core_g = int(240 + 15 * star_intensity)
        core_b = int(255)
        return (core_r, core_g, core_b, alpha)

    # Secondary glow around center
    if dist_center < 0.45:
        glow = (1.0 - dist_center / 0.45) * 0.4
        bg_r = min(255, int(bg_r + 50 * glow))
        bg_g = min(255, int(bg_g + 180 * glow))
        bg_b = min(255, int(bg_b + 230 * glow))

    return (bg_r, bg_g, bg_b, alpha)

def main():
    icons_dir = "/data/data/com.termux/files/home/ai-usage-limits-extension/icons"
    os.makedirs(icons_dir, exist_ok=True)
    
    sizes = [16, 32, 48, 128]
    for size in sizes:
        png_data = make_png(size, size, ai_limit_icon)
        file_path = os.path.join(icons_dir, f"icon{size}.png")
        with open(file_path, "wb") as f:
            f.write(png_data)
        print(f"Generated: {file_path} ({len(png_data)} bytes)")

    # Also create an SVG icon
    svg_content = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e1b4b" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>
    <linearGradient id="meterGrad" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#10b981" />
      <stop offset="50%" stop-color="#06b6d4" />
      <stop offset="100%" stop-color="#8b5cf6" />
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>
  <!-- Squircle Base -->
  <rect x="8" y="8" width="112" height="112" rx="28" fill="url(#bgGrad)" stroke="#312e81" stroke-width="2"/>
  
  <!-- Outer Gauge Arc -->
  <path d="M 32 94 A 44 44 0 1 1 96 94" fill="none" stroke="#334155" stroke-width="9" stroke-linecap="round"/>
  <path d="M 32 94 A 44 44 0 1 1 84 38" fill="none" stroke="url(#meterGrad)" stroke-width="9" stroke-linecap="round" filter="url(#glow)"/>
  
  <!-- Center AI Star -->
  <path d="M 64 36 Q 64 64 36 64 Q 64 64 64 92 Q 64 64 92 64 Q 64 64 64 36 Z" fill="#ffffff" filter="url(#glow)"/>
  <circle cx="64" cy="64" r="4" fill="#38bdf8"/>
</svg>'''
    with open(os.path.join(icons_dir, "icon.svg"), "w") as f:
        f.write(svg_content)
    print("Generated SVG icon")

if __name__ == "__main__":
    main()
