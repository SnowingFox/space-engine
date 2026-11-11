# Contact sheet of screenshots: sheet.py out.png a.png b.png ...  (2 columns, each 720 wide)
import sys
from PIL import Image
out, files = sys.argv[1], sys.argv[2:]
cols = 2
w, h = 720, 450
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * w, rows * h))
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB').resize((w, h), Image.LANCZOS)
    sheet.paste(im, ((i % cols) * w, (i // cols) * h))
sheet.save(out)
