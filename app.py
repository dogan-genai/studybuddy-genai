from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import sqlite3
import json
import uuid
from datetime import datetime
from typing import Optional, List

app = FastAPI()

DB_PATH = "/data/studybuddy.db"

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# Initialize DB on startup
@app.on_event("startup")
async def startup():
    conn = get_db()
    with open('schema.sql', 'r') as f:
        conn.executescript(f.read())
    conn.commit()
    conn.close()

# Models
class StudentProfile(BaseModel):
    semester: int
    enrolled_courses: List[str]
    weekly_availability_minutes: int

class WeeklyPlan(BaseModel):
    student_id: str
    plan_json: dict
    supported_courses: List[str]
    unsupported_courses: List[str]

class Quiz(BaseModel):
    student_id: str
    course_id: str
    items_json: dict
    trulens_metrics: Optional[dict] = None

class QuizAttempt(BaseModel):
    quiz_id: str
    student_id: str
    answers_json: dict
    score: float

# API Endpoints

@app.post("/profiles")
async def create_profile(profile: StudentProfile):
    profile_id = str(uuid.uuid4())
    conn = get_db()
    
    conn.execute(
        "INSERT INTO student_profiles (id, semester, enrolled_courses, weekly_availability_minutes) VALUES (?, ?, ?, ?)",
        (profile_id, profile.semester, json.dumps(profile.enrolled_courses), profile.weekly_availability_minutes)
    )
    conn.commit()
    conn.close()
    
    return {"id": profile_id, "profile": profile.dict()}

@app.get("/profiles")
async def get_all_profiles():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM student_profiles ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    
    profiles = []
    for row in rows:
        profiles.append({
            "id": row["id"],
            "semester": row["semester"],
            "enrolled_courses": row["enrolled_courses"],
            "weekly_availability_minutes": row["weekly_availability_minutes"],
            "created_at": row["created_at"]
        })
    
    return {"profiles": profiles}

@app.get("/profiles/{profile_id}")
async def get_profile(profile_id: str):
    conn = get_db()
    row = conn.execute("SELECT * FROM student_profiles WHERE id = ?", (profile_id,)).fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail="Profile not found")
    
    return {
        "id": row["id"],
        "semester": row["semester"],
        "enrolled_courses": json.loads(row["enrolled_courses"]),
        "weekly_availability_minutes": row["weekly_availability_minutes"],
        "created_at": row["created_at"]
    }

@app.post("/plans")
async def save_plan(plan: WeeklyPlan):
    plan_id = str(uuid.uuid4())
    conn = get_db()
    
    conn.execute(
        """INSERT INTO weekly_plans 
           (id, student_id, plan_json, supported_courses, unsupported_courses) 
           VALUES (?, ?, ?, ?, ?)""",
        (
            plan_id,
            plan.student_id,
            json.dumps(plan.plan_json),
            json.dumps(plan.supported_courses),
            json.dumps(plan.unsupported_courses)
        )
    )
    conn.commit()
    conn.close()
    
    return {"id": plan_id}

@app.get("/plans/student/{student_id}")
async def get_plans(student_id: str):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM weekly_plans WHERE student_id = ? ORDER BY created_at DESC",
        (student_id,)
    ).fetchall()
    conn.close()
    
    plans = []
    for row in rows:
        plans.append({
            "id": row["id"],
            "plan_json": json.loads(row["plan_json"]),
            "supported_courses": json.loads(row["supported_courses"]),
            "unsupported_courses": json.loads(row["unsupported_courses"]),
            "created_at": row["created_at"]
        })
    
    return {"plans": plans}

@app.post("/quizzes")
async def save_quiz(quiz: Quiz):
    quiz_id = str(uuid.uuid4())
    conn = get_db()
    
    conn.execute(
        """INSERT INTO quizzes 
           (id, student_id, course_id, items_json, trulens_metrics) 
           VALUES (?, ?, ?, ?, ?)""",
        (
            quiz_id,
            quiz.student_id,
            quiz.course_id,
            json.dumps(quiz.items_json),
            json.dumps(quiz.trulens_metrics) if quiz.trulens_metrics else None
        )
    )
    conn.commit()
    conn.close()
    
    return {"id": quiz_id}

@app.post("/quiz-attempts")
async def save_attempt(attempt: QuizAttempt):
    attempt_id = str(uuid.uuid4())
    conn = get_db()
    
    conn.execute(
        """INSERT INTO quiz_attempts 
           (id, quiz_id, student_id, answers_json, score) 
           VALUES (?, ?, ?, ?, ?)""",
        (
            attempt_id,
            attempt.quiz_id,
            attempt.student_id,
            json.dumps(attempt.answers_json),
            attempt.score
        )
    )
    
    # Update progress
    conn.execute(
        """INSERT OR REPLACE INTO student_progress 
           (id, student_id, course_id, completed_tasks, avg_quiz_score, last_updated)
           VALUES (?, ?, ?, 
                   COALESCE((SELECT completed_tasks FROM student_progress WHERE student_id = ? AND course_id = ?), 0) + 1,
                   ?,
                   ?)""",
        (
            str(uuid.uuid4()),
            attempt.student_id,
            "UNKNOWN",  # We'd need to get this from quiz
            attempt.student_id,
            "UNKNOWN",
            attempt.score,
            datetime.utcnow().isoformat()
        )
    )
    
    conn.commit()
    conn.close()
    
    return {"id": attempt_id, "score": attempt.score}

@app.get("/progress/{student_id}")
async def get_progress(student_id: str):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM student_progress WHERE student_id = ?",
        (student_id,)
    ).fetchall()
    conn.close()
    
    progress = []
    for row in rows:
        progress.append({
            "course_id": row["course_id"],
            "completed_tasks": row["completed_tasks"],
            "total_tasks": row["total_tasks"],
            "avg_quiz_score": row["avg_quiz_score"],
            "last_updated": row["last_updated"]
        })
    
    return {"progress": progress}

@app.get("/health")
async def health():
    return {"status": "ok"}
