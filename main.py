from urllib.parse import urlparse
import os
import requests
from typing import List, Dict, Any, Optional
import io

from fastapi import FastAPI
from fastapi import UploadFile, File, Form
from pydantic import BaseModel, Field

import chromadb

import hashlib
from datetime import datetime
from pypdf import PdfReader

from haystack import Pipeline, component
from haystack.dataclasses import Document


# ---------------------------
# Config
# ---------------------------
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://host.docker.internal:11434")
OLLAMA_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")

CHROMA_URL = os.getenv("CHROMA_URL", "http://chroma:8000")
u = urlparse(CHROMA_URL)
CHROMA_HOST = u.hostname or "chroma"
CHROMA_PORT = u.port or 8000

CHROMA_TENANT = os.getenv("CHROMA_TENANT", "default_tenant")
CHROMA_DATABASE = os.getenv("CHROMA_DATABASE", "default_database")
CHROMA_COLLECTION_NAME = os.getenv("CHROMA_COLLECTION_NAME")


# ---------------------------
# Haystack Components
# ---------------------------
@component
class OllamaQueryEmbedder:
    """
    Creates an embedding for a query via Ollama local endpoint.
    """
    @component.output_types(embedding=List[float])
    def run(self, query: str) -> Dict[str, Any]:
        r = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": OLLAMA_EMBED_MODEL, "prompt": query},
            timeout=60,
        )
        r.raise_for_status()
        emb = r.json()["embedding"]
        return {"embedding": emb}

@component
class ChromaEmbeddingRetriever:
    """
    Retrieves top_k documents from Chroma using a query embedding.
    Returns Haystack Documents with metadata + id preserved.
    """
    def __init__(self, top_k: int = 12):
        if not CHROMA_COLLECTION_NAME:
            raise ValueError("CHROMA_COLLECTION_NAME is not set")

        self.top_k = top_k
        self.client = chromadb.HttpClient(
            host=CHROMA_HOST,
            port=CHROMA_PORT,
            tenant=CHROMA_TENANT,
            database=CHROMA_DATABASE,
        )
        self.collection = self.client.get_or_create_collection(name=CHROMA_COLLECTION_NAME)

    @component.output_types(documents=List[Document])
    def run(self, embedding: List[float], top_k: Optional[int] = None, course_tag: Optional[str] = None) -> Dict[str, Any]:
        k = top_k or self.top_k

        where = {"course_tag": course_tag} if course_tag else None

        res = self.collection.query(
            query_embeddings=[embedding],
            n_results=k,
            include=["documents", "metadatas", "distances"],
            where=where,
        )

        ids = res.get("ids", [[]])[0]
        docs = res.get("documents", [[]])[0]
        metas = res.get("metadatas", [[]])[0]
        dists = res.get("distances", [[]])[0]

        out_docs: List[Document] = []
        for i in range(len(ids)):
            meta = metas[i] or {}
            # Document.id is important: we keep chroma id as chunk_id for integrity checks later
            out_docs.append(
                Document(
                    id=str(ids[i]),
                    content=docs[i],
                    meta={
                        "source": meta.get("source"),
                        "page": meta.get("page"),
                        "course_tag": meta.get("course_tag"),
                        "distance": dists[i],
                    },
                )
            )

        return {"documents": out_docs}


# ---------------------------
# Build Haystack Pipeline
# ---------------------------
def build_pipeline() -> Pipeline:
    pipe = Pipeline()
    pipe.add_component("embedder", OllamaQueryEmbedder())
    pipe.add_component("retriever", ChromaEmbeddingRetriever(top_k=12))

    pipe.connect("embedder.embedding", "retriever.embedding")
    return pipe


PIPELINE = build_pipeline()


# ---------------------------
# FastAPI
# ---------------------------
app = FastAPI(title="StudyBuddy Haystack Retrieval Service", version="1.0")


class RetrieveRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(12, ge=1, le=50)
    course_tag: Optional[str] = None


class RetrieveResponse(BaseModel):
    retrieved_chunks: List[Dict[str, Any]]


@app.post("/retrieve", response_model=RetrieveResponse)
def retrieve(req: RetrieveRequest):
    # Get more results for filtering
    retrieval_top_k = req.top_k * 5 if req.course_tag else req.top_k
    
    result = PIPELINE.run(
        data={
            "embedder": {"query": req.query},
            "retriever": {"top_k": retrieval_top_k, "course_tag": req.course_tag},
        }
    )
    
    docs: List[Document] = result["retriever"]["documents"]
    print(f"DEBUG: Retrieved {len(docs)} documents from retriever")

    # Post-filter by source
    if req.course_tag and docs:
        print(f"Filtering {len(docs)} docs by: {req.course_tag}")
        filtered_docs = []
        for d in docs:
            source = d.meta.get("source", "")
            if req.course_tag in source:
                filtered_docs.append(d)
                print(f"  ✓ Matched: {source}")
            else:
                print(f"  ✗ Skipped: {source}")
        
        print(f"Filtered: {len(docs)} → {len(filtered_docs)}")
        docs = filtered_docs[:req.top_k]
    
    chunks = []
    for d in docs:
        chunks.append({
            "chunk_id": d.id,
            "text": d.content,
            "source": d.meta.get("source"),
            "page": d.meta.get("page"),
            "score": d.meta.get("distance"),
        })
    
    return {"retrieved_chunks": chunks}
# ---------------------------
# Ingest (PDF -> Chroma)
# ---------------------------

def _chunk_text(text: str, chunk_size: int = 1200, overlap: int = 150):
    text = (text or "").strip()
    if not text:
        return []
    chunks = []
    i = 0
    n = len(text)
    while i < n:
        j = min(n, i + chunk_size)
        chunks.append(text[i:j])
        if j == n:
            break
        i = max(0, j - overlap)
    return chunks


def _embed_text(prompt: str) -> List[float]:
    r = requests.post(
        f"{OLLAMA_URL}/api/embeddings",
        json={"model": OLLAMA_EMBED_MODEL, "prompt": prompt},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["embedding"]


@app.post("/ingest")
async def ingest(
    file: UploadFile = File(...),
    course_tag: str = Form(...),
    source: str = Form(""),
):
    data = await file.read()
    if not data:
        return {"status": "error", "error": "EMPTY_FILE"}

    reader = PdfReader(io.BytesIO(data))
    pages = []
    for idx, page in enumerate(reader.pages):
        try:
            txt = page.extract_text() or ""
        except Exception:
            txt = ""
        if txt.strip():
            pages.append((idx + 1, txt))

    if not pages:
        return {"status": "error", "error": "PDF_TEXT_EMPTY"}

    collection = chromadb.HttpClient(
        host=CHROMA_HOST,
        port=CHROMA_PORT,
        tenant=CHROMA_TENANT,
        database=CHROMA_DATABASE,
    ).get_or_create_collection(name=CHROMA_COLLECTION_NAME)

    base = hashlib.sha256(
        (course_tag + "|" + (source or file.filename or "") + "|" + str(len(data))).encode("utf-8")
    ).hexdigest()[:16]

    inserted = 0
    ids_batch, docs_batch, metas_batch, embs_batch = [], [], [], []

    for page_no, txt in pages:
        for ci, chunk in enumerate(_chunk_text(txt)):
            chunk_id = f"{course_tag}:{base}:p{page_no}:c{ci}"
            emb = _embed_text(chunk)

            ids_batch.append(chunk_id)
            docs_batch.append(chunk)
            metas_batch.append({
                "source": source or file.filename or "unknown.pdf",
                "page": page_no,
                "course_tag": course_tag,
                "ingested_at": datetime.utcnow().isoformat() + "Z",
            })
            embs_batch.append(emb)

            if len(ids_batch) >= 32:
                collection.upsert(ids=ids_batch, documents=docs_batch, metadatas=metas_batch, embeddings=embs_batch)
                inserted += len(ids_batch)
                ids_batch, docs_batch, metas_batch, embs_batch = [], [], [], []

    if ids_batch:
        collection.upsert(ids=ids_batch, documents=docs_batch, metadatas=metas_batch, embeddings=embs_batch)
        inserted += len(ids_batch)

    return {"status": "ok", "inserted": inserted, "course_tag": course_tag, "source": source or file.filename}

@app.get("/health")
def health():
    return {"status": "ok", "haystack": "2.x", "collection_name": CHROMA_COLLECTION_NAME}
