import math, sys
out = sys.argv[1]
W = 88            # stroke width (stem and caret)
GAP = 38          # gap between the stem and the caret's point
H = 352           # glyph height
m = (W / 2) / math.sin(math.radians(45))   # half the caret's horizontal thickness
oa = W + GAP                               # caret outer apex x (glyph coords)
right = oa + 2 * m + H / 2
ox = 512 - right / 2 - 8                   # optical nudge: the caret is lighter than the stem
oy = 512 - H / 2

def pts(ps):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in ps)

def glyph(fill, dx=0.0, dy=0.0):
    caret = [(oa + H/2, 0), (oa + 2*m + H/2, 0), (oa + 2*m, H/2),
             (oa + 2*m + H/2, H), (oa + H/2, H), (oa, H/2)]
    caret = [(x + dx, y + dy) for x, y in caret]
    return (f'<rect x="{dx:.1f}" y="{dy:.1f}" width="{W}" height="{H}" fill="{fill}"/>'
            f'<polygon points="{pts(caret)}" fill="{fill}"/>')

def icon(bg_top, bg_bot, edge, fg):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <!-- Kemudi "Prompt K": a stem and a caret, with a gap like a cursor. -->
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{bg_top}"/>
      <stop offset="1" stop-color="{bg_bot}"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <rect x="101" y="101" width="822" height="822" rx="184" fill="none" stroke="{edge}" stroke-width="2"/>
  {glyph(fg, ox, oy)}
</svg>
'''
open(f"{out}/kemudi-icon-dark.svg", "w").write(icon("#1b1b1f", "#0b0b0c", "rgba(255,255,255,0.10)", "#ededed"))
open(f"{out}/kemudi-icon-inverse.svg", "w").write(icon("#ffffff", "#ececee", "rgba(0,0,0,0.10)", "#111113"))
open(f"{out}/kemudi-mark.svg", "w").write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {right:.1f} {H}">{glyph("currentColor")}</svg>\n')
print(f"glyph {right:.1f}x{H}  mark: {glyph('currentColor')}")
