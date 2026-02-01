#!/usr/bin/env python3
import json
import sys

def evaluate_quiz(data):
    quiz = data.get('quiz', [])
    if not quiz:
        return {"error": "No quiz", "overall_score": 0, "grade": "F"}
    
    scores = {'answer_consistency': 0, 'citation_completeness': 0, 'question_clarity': 0, 'options_diversity': 0}
    
    for item in quiz:
        if item.get('answer') in item.get('explanation', ''):
            scores['answer_consistency'] += 30
        if item.get('citations'):
            scores['citation_completeness'] += 25
        if len(item.get('question', '')) > 10:
            scores['question_clarity'] += 25
        if len(item.get('options', [])) == 4:
            scores['options_diversity'] += 20
    
    num = len(quiz)
    for k in scores:
        scores[k] = min(scores[k] // num, 100)
    
    overall = sum(scores.values()) // 4
    grade = "A" if overall >= 90 else "B" if overall >= 75 else "C" if overall >= 60 else "D" if overall >= 50 else "F"
    
    return {"overall_score": overall, "grade": grade, "breakdown": scores}

if __name__ == "__main__":
    try:
        data = json.loads(sys.stdin.read())
        print(json.dumps(evaluate_quiz(data)))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
