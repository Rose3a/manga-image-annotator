from manga_ocr import MangaOcr
print("Loading MangaOCR...")
try:
    mocr = MangaOcr()
    print("MangaOCR loaded successfully!")
except Exception as e:
    print(f"Error loading MangaOCR: {e}")
