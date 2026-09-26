# Generates web/icon-512.png (512x512, <256 KiB) — the muse.ai/platform icon.
from PIL import Image, ImageDraw

S = 512
BLUE = (30, 95, 235, 255)      # #1E5FEB
WHITE = (255, 255, 255, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded-square background
d.rounded_rectangle([16, 16, S - 16, S - 16], radius=96, fill=BLUE)

# map pin: head (circle) + tail (triangle)
cx, cy, r = 256, 208, 140
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)
d.polygon([(cx - 95, cy + 95), (cx + 95, cy + 95), (cx, 440)], fill=WHITE)

# clock face inside the head
fr = 96
d.ellipse([cx - fr, cy - fr, cx + fr, cy + fr], fill=BLUE)

# clock hands (12 o'clock minute hand, ~2 o'clock hour hand) + center dot
d.line([(cx, cy), (cx, cy - 62)], fill=WHITE, width=18)
d.line([(cx, cy), (cx + 44, cy + 10)], fill=WHITE, width=18)
d.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=WHITE)

img.save("web/icon-512.png")

import os
size = os.path.getsize("web/icon-512.png")
print(f"web/icon-512.png written: {img.size[0]}x{img.size[1]}, {size} bytes ({'OK' if size <= 256 * 1024 else 'TOO BIG'})")
