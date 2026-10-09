import math, sys
# Usage: python3 generate-malaysia.py <dir> (the earlier drawn variants).
out = sys.argv[1]
W, GAP, H = 88, 38, 352
m = (W / 2) / math.sin(math.radians(45))
oa = W + GAP
right = oa + 2 * m + H / 2
NAVY_T, NAVY_B = "#0b1a7a", "#010046"   # Jalur Gemilang blue, deepened
RED, WHITE, YELLOW = "#cc0001", "#ffffff", "#ffcc00"

def glyph(stem, caret, ox, oy):
    c = [(oa + H/2, 0), (oa + 2*m + H/2, 0), (oa + 2*m, H/2), (oa + 2*m + H/2, H), (oa + H/2, H), (oa, H/2)]
    pts = " ".join(f"{x+ox:.1f},{y+oy:.1f}" for x, y in c)
    return f'<rect x="{ox:.1f}" y="{oy:.1f}" width="{W}" height="{H}" fill="{stem}"/><polygon points="{pts}" fill="{caret}"/>'

def svg(body, defs=""):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <!-- Kemudi "Prompt K" in Jalur Gemilang colours. -->
  <defs>
    <clipPath id="sq"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    <linearGradient id="navy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{NAVY_T}"/><stop offset="1" stop-color="{NAVY_B}"/></linearGradient>
    {defs}
  </defs>
  <g clip-path="url(#sq)">{body}</g>
  <rect x="101" y="101" width="822" height="822" rx="184" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
</svg>
'''

def stripes(y0, y1, n, first=RED):
    h = (y1 - y0) / n
    return "".join(f'<rect x="100" y="{y0 + i*h:.2f}" width="824" height="{h + 0.6:.2f}" fill="{first if i % 2 == 0 else (WHITE if first == RED else RED)}"/>' for i in range(n))

cx = 512 - right / 2 - 8
# A: navy, white stem + yellow caret, red/white stripes along the bottom.
band = 760
a = svg(f'<rect x="100" y="100" width="824" height="824" fill="url(#navy)"/>' + stripes(band, 924, 6)
        + glyph(WHITE, YELLOW, cx, 512 - 40 - H/2 + 10))
# B: navy, white K, yellow caret, thin red underline (minimal).
b = svg(f'<rect x="100" y="100" width="824" height="824" fill="url(#navy)"/>'
        f'<rect x="100" y="872" width="824" height="52" fill="{RED}"/><rect x="100" y="856" width="824" height="16" fill="{WHITE}"/>'
        + glyph(WHITE, YELLOW, cx, 512 - H/2 - 12))
# C: the flag's layout — 14 red/white stripes, navy canton holding the K in yellow.
c = svg(stripes(100, 924, 14) + f'<rect x="100" y="100" width="560" height="560" fill="url(#navy)"/>'
        + f'<g transform="translate({380 - right*0.62/2 - 5:.1f},{380 - H*0.62/2:.1f}) scale(0.62)">' + glyph(WHITE, YELLOW, 0, 0) + '</g>')
for name, s in (("a", a), ("b", b), ("c", c)):
    open(f"{out}/kemudi-icon-malaysia-{name}.svg", "w").write(s)
