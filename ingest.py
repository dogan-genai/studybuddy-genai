import os
from pathlib import Path
from typing import List

import chromadb
from chromadb.config import Settings
from pypdf import PdfReader
import requests

CHROMA_HOST = "localhost"
CHROMA_PORT = 8000
COLLECTION = "studybuddy_elektrotechnik"
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")

PDF_DIR = os.getenv("PDF_DIR", str(Path.home() / "studybuddy-pdfs"))

def chunk_text(text: str, chunk_size: int = 900, overlap: int = 150) -> List[str]:
    text = " ".join(text.split())
    chunks = []
    i = 0
    while i < len(text):
        chunks.append(text[i:i+chunk_size])
        i += chunk_size - overlap
    return chunks

def extract_pdf_pages(pdf_path: Path) -> List[tuple[int,str]]:
    reader = PdfReader(str(pdf_path))
    pages = []
    for idx, page in enumerate(reader.pages, start=1):
        t = page.extract_text() or ""
        if t.strip():
            pages.append((idx, t))
    return pages

def embed_texts(texts: List[str]) -> List[List[float]]:
    embs = []
    for t in texts:
        r = requests.post(f"{OLLAMA_URL}/api/embeddings", json={
            "model": EMBED_MODEL,
            "prompt": t
        }, timeout=120)
        r.raise_for_status()
        data = r.json()
        if "embedding" not in data:
            raise RuntimeError(f"Ollama embedding missing in response: {data}")
        embs.append(data["embedding"])
    return embs

def main():
    pdf_dir = Path(PDF_DIR)
    if not pdf_dir.exists():
        raise SystemExit(f"PDF_DIR not found: {pdf_dir}\nCreate it and put PDFs inside, or set PDF_DIR env var.")

    pdfs = list(pdf_dir.glob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"No PDFs found in {pdf_dir}. Put at least 1 PDF there.")

    print(f"Found {len(pdfs)} PDFs in {pdf_dir}")

    client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT, settings=Settings(allow_reset=False))
    col = client.get_or_create_collection(name=COLLECTION)

    ids, docs, metas, embs = [], [], [], []

    for pdf in pdfs:
        # Extract course_tag from filename (e.g., EEN2910__sap_mm.pdf -> EEN2910)
        course_tag = pdf.stem.split("__")[0] if "__" in pdf.stem else "UNKNOWN"
        
        pages = extract_pdf_pages(pdf)
        print(f"- {pdf.name}: {len(pages)} pages with text, course_tag={course_tag}")
        
        for page_num, page_text in pages:
            chunks = chunk_text(page_text)
            for ci, ch in enumerate(chunks):
                _id = f"{pdf.stem}-p{page_num}-c{ci}"
                ids.append(_id)
                docs.append(ch)
                metas.append({
                    "source": pdf.name,
                    "page": page_num,
                    "course_tag": course_tag
                })

    print(f"Total chunks: {len(docs)} — embedding...")
    embs = embed_texts(docs)

    print("Upserting to Chroma...")
    col.upsert(ids=ids, documents=docs, metadatas=metas, embeddings=embs)

    print("Done.")
    print("Collections now:", [c.name for c in client.list_collections()])

if __name__ == "__main__":
    main()
