# Stitches frames from capture-demo.mjs into docs/demo.gif
import glob, os, sys, tempfile
from PIL import Image

src = os.path.join(tempfile.gettempdir(), 'jevbox-frames')
files = sorted(glob.glob(os.path.join(src, '*.jpg')))[::2]   # 7.5 fps keeps the file small
width = int(sys.argv[1]) if len(sys.argv) > 1 else 560
frames = []
for f in files:
    im = Image.open(f).convert('RGB')
    im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    frames.append(im.quantize(colors=160, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
out = os.path.join('docs', 'demo.gif')
frames[0].save(out, save_all=True, append_images=frames[1:], duration=133, loop=0, optimize=True, disposal=1)
print(out, len(frames), 'frames', round(os.path.getsize(out) / 1e6, 2), 'MB')
