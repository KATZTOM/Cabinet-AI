import sys
import fitz  # PyMuPDF

if len(sys.argv) < 3:
    sys.exit(1)

pdf_path = sys.argv[1]
output_png = sys.argv[2]

try:
    doc = fitz.open(pdf_path)
    if len(doc) > 0:
        page = doc[0]  # Load Page 1
        pix = page.get_pixmap(dpi=150)
        pix.save(output_png)
        print("CONVERT_SUCCESS")
    else:
        sys.exit(1)
except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)