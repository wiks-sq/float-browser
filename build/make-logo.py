# Float logo: a white feather. Its vane is a set of separate, rounded strips (panes) with
# gaps between them, clipped to a feather outline, with a split in the vane and a bare quill.
import math, sys

def feather(tile=True):
    # local coords: feather vertical, tip y=-360, quill end y=+360; rotated as a whole below
    left  = "M 0 -360 C -70 -300 -150 -170 -146 -30 C -142 80 -90 170 -14 222 L 0 222"
    right = "M 0 -360 C 60 -300 124 -180 120 -50 C 116 60 74 150 12 205 L 0 205"
    strips = []
    a = math.radians(30)                     # barbs at 30 degrees from the shaft, sweeping to the tip
    step, th = 54, 18
    for side, path in ((-1, 'L'), (1, 'R')):
        y = -330 + (0 if side < 0 else step / 2)
        k = 0
        while y < 240:
            x2, y2 = side * 420 * math.sin(a), y - 420 * math.cos(a)
            # the split: one missing strip on the right side, two thirds down
            if not (side == 1 and k == 7):
                strips.append(f'<line x1="{side*(th/2+9)}" y1="{y:.1f}" x2="{side*(th/2+9)+x2:.1f}" y2="{y2:.1f}" clip-path="url(#clip{path})"/>')
            y += step; k += 1
    shaft = '<path d="M 0 -352 Q 10 0 0 360" fill="none" stroke="url(#shaft)" stroke-width="14" stroke-linecap="round"/>'
    body = (f'<g transform="translate(512 492) rotate(38) scale(1.1)" filter="url(#lift)">'
            f'<g stroke="url(#vane)" stroke-width="{th}" stroke-linecap="round">{"".join(strips)}</g>{shaft}</g>')
    defs = f'''<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2440"/><stop offset="1" stop-color="#0d1018"/></linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.38" r="0.62"><stop offset="0" stop-color="#7aa2f7" stop-opacity=".28"/><stop offset="1" stop-color="#7aa2f7" stop-opacity="0"/></radialGradient>
  <linearGradient id="vane" gradientUnits="userSpaceOnUse" x1="0" y1="-360" x2="0" y2="240"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e2e9f7"/></linearGradient>
  <linearGradient id="shaft" gradientUnits="userSpaceOnUse" x1="0" y1="-360" x2="0" y2="360"><stop offset="0" stop-color="#ffffff"/><stop offset=".65" stop-color="#e6edfb"/><stop offset="1" stop-color="#9fbaf5"/></linearGradient>
  <clipPath id="clipL"><path d="{left} Z"/></clipPath>
  <clipPath id="clipR"><path d="{right} Z"/></clipPath>
  <filter id="lift" x="-40%" y="-30%" width="180%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="16" flood-color="#000" flood-opacity=".42"/></filter>
  <filter id="soft" x="-50%" y="-300%" width="200%" height="700%"><feGaussianBlur stdDeviation="20"/></filter>
  <clipPath id="sq"><rect x="64" y="64" width="896" height="896" rx="220"/></clipPath>
</defs>'''
    shadow = '<ellipse cx="512" cy="846" rx="210" ry="22" fill="#000" opacity=".55" filter="url(#soft)"/>'
    tilebg = (f'<rect x="64" y="64" width="896" height="896" rx="220" fill="url(#bg)"/><g clip-path="url(#sq)">'
              f'<rect x="64" y="64" width="896" height="896" fill="url(#glow)"/>{shadow}</g>') if tile else shadow
    box = 'viewBox="0 0 1024 1024" width="1024" height="1024"' if tile else 'viewBox="230 150 560 740" width="560" height="740"'  # mark: cropped to the feather
    return (f'<svg xmlns="http://www.w3.org/2000/svg" {box}>\n'
            f'<!-- Float: a feather whose vane is made of separate floating strips -->\n{defs}\n{tilebg}\n{body}\n</svg>\n')

open(sys.argv[1], 'w').write(feather(True))
open(sys.argv[2], 'w').write(feather(False))
