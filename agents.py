from crewai import Agent, Task, Crew, LLM
import requests
import os

# Configure Ollama LLM
llm = LLM(
    model="ollama/gemma3:4b",
    base_url="http://host.docker.internal:11434"
)

def haystack_retrieval(query: str, course_id: str, top_k: int = 10) -> dict:
    """Retrieve relevant chunks from Haystack."""
    haystack_url = os.getenv("HAYSTACK_URL", "http://haystack:8010")
    
    try:
        response = requests.post(
            f"{haystack_url}/retrieve",
            json={
                "query": query,
                "course_tag": course_id,
                "top_k": top_k
            },
            timeout=10
        )
        return response.json()
    except Exception as e:
        return {"error": str(e), "retrieved_chunks": []}

# Agents with Ollama LLM
planner_agent = Agent(
    role="Learning Plan Creator",
    goal="Create personalized weekly learning plans",
    backstory="Expert educational planner",
    verbose=True,
    allow_delegation=False,
    llm=llm
)

explainer_agent = Agent(
    role="Concept Explainer",
    goal="Answer questions using course materials",
    backstory="Patient tutor",
    verbose=True,
    allow_delegation=False,
    llm=llm
)

quiz_agent = Agent(
    role="Quiz Generator",
    goal="Create quiz questions from materials",
    backstory="Assessment expert",
    verbose=True,
    allow_delegation=False,
    llm=llm
)

motivator_agent = Agent(
    role="Student Motivator",
    goal="Provide encouragement",
    backstory="Supportive mentor",
    verbose=True,
    allow_delegation=False,
    llm=llm
)

def create_plan_crew(student_profile: dict, goal: str):
    courses = student_profile.get('enrolled_courses', [])
    chunks_data = []
    
    for course in courses:
        data = haystack_retrieval(goal, course, 10)
        chunks_data.extend(data.get('retrieved_chunks', []))
    
    context = "\n\n".join([
        f"[Chunk from {c.get('source', 'unknown')}, page {c.get('page', '?')}]:\n{c.get('text', '')[:200]}"
        for c in chunks_data[:5]
    ])
    
    task = Task(
        description=f"""
        Create a weekly learning plan:
        - Courses: {courses}
        - Time: {student_profile.get('weekly_availability_minutes')} min
        - Goal: {goal}
        
        Materials:
        {context}
        
        Create 3-5 tasks, each 60 minutes.
        Output only: Task 1: [title], Task 2: [title], etc.
        """,
        agent=planner_agent,
        expected_output="List of learning tasks"
    )
    
    crew = Crew(
        agents=[planner_agent],
        tasks=[task],
        verbose=True
    )
    
    return crew

def create_quiz_crew(query: str, course_id: str, num_questions: int = 3):
    data = haystack_retrieval(query, course_id, 10)
    chunks = data.get('retrieved_chunks', [])
    
    context = "\n\n".join([
        f"Chunk {i+1}: {c.get('text', '')[:150]}"
        for i, c in enumerate(chunks[:3])
    ])
    
    task = Task(
        description=f"""
        Create {num_questions} quiz questions about: {query}
        
        Materials:
        {context}
        
        For each question, provide:
        Q: [question]
        A: [answer]
        """,
        agent=quiz_agent,
        expected_output="Quiz questions with answers"
    )
    
    crew = Crew(
        agents=[quiz_agent],
        tasks=[task],
        verbose=True
    )
    
    return crew

def create_explain_crew(question: str, course_id: str):
    data = haystack_retrieval(question, course_id, 5)
    chunks = data.get('retrieved_chunks', [])
    
    # Use more chunks and full text
    context = "\n\n".join([
        f"Quelle: {c.get('source', 'Unknown')}, Seite {c.get('page', 'N/A')}\n{c.get('text', '')}"
        for c in chunks[:5]  # Use 5 chunks instead of 2
    ])
    
    task = Task(
        description=f"""
Du bist ein geduldiger SAP MM Tutor. Erkläre das folgende Konzept klar und verständlich.

Frage des Studenten: {question}

Relevante Informationen aus dem Kursmaterial:
{context}

Aufgabe:
1. Gib eine klare, strukturierte Erklärung in ganzen Sätzen
2. Verwende Beispiele aus dem Kursmaterial wenn möglich
3. Erkläre Fachbegriffe wenn nötig
4. Keine Tabellen oder Rohdaten - nur verständliche Prosa

Deine Erklärung:
""",
        agent=explainer_agent,
        expected_output="Clear, structured explanation in complete sentences"
    )
    
    crew = Crew(
        agents=[explainer_agent],
        tasks=[task],
        verbose=True
    )
    
    return crew
