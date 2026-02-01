import json
import sys
from typing import List, Literal, Optional
from pydantic import BaseModel, Field
from guardrails import Guard

class Citation(BaseModel):
    source: str
    page: Optional[int] = None
    chunk_id: str

class QuizItem(BaseModel):
    type: Literal["mcq"]
    question: str = Field(..., min_length=5)
    options: List[str] = Field(..., min_length=4, max_length=4)
    answer: Literal["A", "B", "C", "D"]
    explanation: str = Field(..., min_length=5)
    citations: List[Citation] = Field(..., min_length=1)

class QuizPayload(BaseModel):
    items: List[QuizItem] = Field(..., min_length=5, max_length=50)
    citations: List[Citation] = Field(..., min_length=1)
    confidence: Optional[float] = None

def to_dict(x):
    if isinstance(x, str):
        return json.loads(x)
    if hasattr(x, "model_dump"):
        return x.model_dump()
    if hasattr(x, "dict"):
        return x.dict()
    return x

def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "INVALID_JSON", "details": str(e)}))
        sys.exit(2)

    guard = Guard.for_pydantic(QuizPayload)

    try:
        llm_output = json.dumps(payload, ensure_ascii=False)
        validated = guard.validate(llm_output)
        data = to_dict(validated)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "GUARDRAILS_VALIDATION_EXCEPTION", "details": str(e)}))
        sys.exit(4)

    # Block if guardrails validation failed
    if isinstance(data, dict) and data.get("validation_passed") is False:
        print(json.dumps({"ok": False, "error": "GUARDRAILS_VALIDATION_FAILED", "details": data}))
        sys.exit(6)

    # Prefer validated_output if present
    if isinstance(data, dict) and data.get("validated_output") is not None:
        print(json.dumps({"ok": True, "data": data["validated_output"]}))
        return

    print(json.dumps({"ok": True, "data": data}))

if __name__ == "__main__":
    main()
