// ---------------------------------------------------------------------------
// Quiz Renderer — Interactive Quizzes and Flashcards
// ---------------------------------------------------------------------------
//
// Renders quiz components with multiple modes: practice, test, flashcard.
// Tracks progress, shows explanations, and calculates scores.
//
// ---------------------------------------------------------------------------

import React, { useState, useMemo, useCallback } from "react";
import { QuizComponent, QuizQuestion } from "../../lib/interactive-types";

interface QuizRendererProps {
  component: QuizComponent;
  instanceId: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
  className?: string;
}

type QuizMode = "practice" | "test" | "flashcard";
type AnswerState = Record<string, string | string[]>; // questionId -> answer

interface QuizRendererState {
  currentIndex: number;
  answers: AnswerState;
  showExplanation: boolean;
  submitted: boolean;
  score: number;
  mode: QuizMode;
}

export default function QuizRenderer({
  component,
  instanceId,
  onUpdate,
  className = "",
}: QuizRendererProps) {
  const { questions, mode: initialMode = "practice", shuffle = false, showExplanations = true } = component;

  const [state, setState] = useState<QuizRendererState>(() => {
    let qs = [...questions];
    if (shuffle) {
      qs = qs.sort(() => Math.random() - 0.5);
    }
    return {
      currentIndex: 0,
      answers: {},
      showExplanation: false,
      submitted: false,
      score: 0,
      mode: initialMode,
    };
  });

  const questionsToUse = shuffle ? [...questions].sort(() => Math.random() - 0.5) : questions;
  const currentQuestion = questionsToUse[state.currentIndex];
  const isLastQuestion = state.currentIndex === questionsToUse.length - 1;
  const isFirstQuestion = state.currentIndex === 0;

  const handleAnswer = useCallback((questionId: string, answer: string | string[]) => {
    setState(prev => ({
      ...prev,
      answers: { ...prev.answers, [questionId]: answer },
    }));
    onUpdate?.(instanceId, { answers: { ...state.answers, [questionId]: answer }, ...state });
  }, [instanceId, onUpdate, state.answers, state]);

  const checkAnswer = useCallback((question: QuizQuestion, answer: string | string[]): boolean => {
    if (Array.isArray(question.correctAnswer)) {
      const correct = new Set(question.correctAnswer.map(String));
      const given = new Set((Array.isArray(answer) ? answer : [answer]).map(String));
      return correct.size === given.size && [...correct].every(v => given.has(v));
    }
    return String(question.correctAnswer) === String(answer);
  }, []);

  const handleSubmit = useCallback(() => {
    if (!currentQuestion) return;
    const answer = state.answers[currentQuestion.id];
    if (answer === undefined) return;

    const correct = checkAnswer(currentQuestion, answer);
    setState(prev => ({
      ...prev,
      showExplanation: true,
      submitted: true,
      score: prev.score + (correct ? (currentQuestion.points || 1) : 0),
    }));
  }, [currentQuestion, state.answers, checkAnswer]);

  const handleNext = useCallback(() => {
    setState(prev => ({
      ...prev,
      currentIndex: Math.min(prev.currentIndex + 1, questionsToUse.length - 1),
      showExplanation: false,
      submitted: false,
    }));
  }, [questionsToUse.length]);

  const handlePrevious = useCallback(() => {
    setState(prev => ({
      ...prev,
      currentIndex: Math.max(prev.currentIndex - 1, 0),
      showExplanation: false,
      submitted: false,
    }));
  }, []);

  const handleRestart = useCallback(() => {
    let qs = [...questions];
    if (shuffle) qs = qs.sort(() => Math.random() - 0.5);
    setState({
      currentIndex: 0,
      answers: {},
      showExplanation: false,
      submitted: false,
      score: 0,
      mode: initialMode,
    });
  }, [questions, shuffle, initialMode]);

  const handleModeChange = useCallback((newMode: QuizMode) => {
    setState(prev => ({ ...prev, mode: newMode, currentIndex: 0, answers: {}, showExplanation: false, submitted: false, score: 0 }));
  }, []);

  // Flashcard mode rendering
  if (state.mode === "flashcard") {
    const card = questionsToUse[state.currentIndex];
    const isFlipped = state.showExplanation;

    return (
      <div className={`quiz-renderer flashcard-mode ${className}`} data-instance-id={instanceId}>
        <div className="quiz-header">
          <h3 className="quiz-title">{component.title}</h3>
          {component.description && <p className="quiz-description">{component.description}</p>}
          <div className="quiz-mode-selector">
            <label htmlFor={`${instanceId}-mode`} className="visually-hidden">Quiz mode</label>
            <select
              id={`${instanceId}-mode`}
              value={state.mode}
              onChange={(e) => handleModeChange(e.target.value as QuizMode)}
            >
              <option value="flashcard">Flashcard</option>
              <option value="practice">Practice</option>
              <option value="test">Test</option>
            </select>
          </div>
        </div>

        <div className="flashcard-progress">
          Card {state.currentIndex + 1} of {questionsToUse.length}
        </div>

        <div
          className={`flashcard ${isFlipped ? "flipped" : ""}`}
          onClick={() => setState(prev => ({ ...prev, showExplanation: !prev.showExplanation }))}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setState(prev => ({ ...prev, showExplanation: !prev.showExplanation })); }}
          aria-label={isFlipped ? "Show question" : "Show answer"}
        >
          <div className="flashcard-inner">
            <div className="flashcard-front">
              <div className="flashcard-content">
                <p className="flashcard-question">{card.question}</p>
                {card.type === "multiple_choice" && card.options && (
                  <ul className="flashcard-options">
                    {card.options.map(opt => (
                      <li key={opt.id}>{opt.text}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flashcard-hint">Click to flip</div>
            </div>
            <div className="flashcard-back">
              <div className="flashcard-content">
                <p className="flashcard-answer">
                  {Array.isArray(card.correctAnswer) ? card.correctAnswer.join(", ") : card.correctAnswer}
                </p>
                {showExplanations && card.explanation && (
                  <p className="flashcard-explanation">{card.explanation}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flashcard-nav">
          <button
            onClick={handlePrevious}
            disabled={isFirstQuestion}
            className="nav-btn"
            aria-label="Previous card"
          >
            ← Previous
          </button>
          <span className="card-counter">{state.currentIndex + 1} / {questionsToUse.length}</span>
          <button
            onClick={handleNext}
            disabled={isLastQuestion}
            className="nav-btn"
            aria-label="Next card"
          >
            Next →
          </button>
        </div>

        <button onClick={handleRestart} className="restart-btn">Restart</button>
      </div>
    );
  }

  // Practice/Test mode rendering
  const answer = state.answers[currentQuestion?.id];
  const isAnswered = answer !== undefined;
  const isCorrect = isAnswered && currentQuestion ? checkAnswer(currentQuestion, answer) : false;
  const maxScore = questionsToUse.reduce((sum, q) => sum + (q.points || 1), 0);

  const renderQuestion = () => {
    if (!currentQuestion) return null;

    const q = currentQuestion;
    const answered = state.answers[q.id] !== undefined;

    return (
      <div className="quiz-question" data-question-id={q.id}>
        <div className="question-header">
          <span className="question-number">Question {state.currentIndex + 1} of {questionsToUse.length}</span>
          {q.points && <span className="question-points">{q.points} pt</span>}
        </div>

        <p className="question-text">{q.question}</p>

        {q.type === "multiple_choice" && q.options && (
          <fieldset className="question-options">
            {q.options.map(opt => (
              <label key={opt.id} className={`option-label ${answered && String(answer) === opt.id ? (isCorrect ? "correct" : "incorrect") : ""} ${answered && q.correctAnswer === opt.id ? "correct-answer" : ""}`}>
                <input
                  type="radio"
                  name={`${instanceId}-${q.id}`}
                  value={opt.id}
                  checked={answer === opt.id}
                  onChange={() => !answered && handleAnswer(q.id, opt.id)}
                  disabled={answered}
                />
                <span className="option-text">{opt.text}</span>
                {answered && String(answer) === opt.id && !isCorrect && <span className="option-result incorrect" aria-hidden="true">✗</span>}
                {answered && q.correctAnswer === opt.id && <span className="option-result correct" aria-hidden="true">✓</span>}
              </label>
            ))}
          </fieldset>
        )}

        {q.type === "true_false" && (
          <fieldset className="question-options tf-options">
            {["True", "False"].map(val => (
              <label key={val} className={`option-label ${answered && String(answer) === val ? (isCorrect ? "correct" : "incorrect") : ""} ${answered && q.correctAnswer === val ? "correct-answer" : ""}`}>
                <input
                  type="radio"
                  name={`${instanceId}-${q.id}`}
                  value={val}
                  checked={answer === val}
                  onChange={() => !answered && handleAnswer(q.id, val)}
                  disabled={answered}
                />
                <span className="option-text">{val}</span>
                {answered && String(answer) === val && !isCorrect && <span className="option-result incorrect" aria-hidden="true">✗</span>}
                {answered && q.correctAnswer === val && <span className="option-result correct" aria-hidden="true">✓</span>}
              </label>
            ))}
          </fieldset>
        )}

        {q.type === "short_answer" && (
          <div className="short-answer">
            <input
              type="text"
              value={answer as string || ""}
              onChange={(e) => !answered && handleAnswer(q.id, e.target.value)}
              disabled={answered}
              placeholder="Type your answer..."
              className={`short-answer-input ${answered ? (isCorrect ? "correct" : "incorrect") : ""}`}
            />
            {answered && (
              <div className="short-answer-feedback">
                <span className={isCorrect ? "correct" : "incorrect"}>
                  {isCorrect ? "Correct!" : "Incorrect"}
                </span>
                <span>Your answer: {answer}</span>
                <span>Correct: {Array.isArray(q.correctAnswer) ? q.correctAnswer.join(", ") : q.correctAnswer}</span>
              </div>
            )}
          </div>
        )}

        {state.showExplanation && showExplanations && q.explanation && (
          <div className="question-explanation">
            <strong>Explanation:</strong> {q.explanation}
          </div>
        )}

        {state.mode === "practice" && answered && !state.submitted && (
          <button onClick={handleSubmit} className="submit-btn" disabled={!isAnswered}>
            Check Answer
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={`quiz-renderer ${className}`} data-instance-id={instanceId}>
      <div className="quiz-header">
        <h3 className="quiz-title">{component.title}</h3>
        {component.description && <p className="quiz-description">{component.description}</p>}
        <div className="quiz-mode-selector">
          <label htmlFor={`${instanceId}-mode`} className="visually-hidden">Quiz mode</label>
          <select
            id={`${instanceId}-mode`}
            value={state.mode}
            onChange={(e) => handleModeChange(e.target.value as QuizMode)}
          >
            <option value="practice">Practice</option>
            <option value="test">Test</option>
            <option value="flashcard">Flashcard</option>
          </select>
        </div>
      </div>

      <div className="quiz-progress">
        <div className="progress-bar" role="progressbar" aria-valuenow={state.currentIndex + 1} aria-valuemin={1} aria-valuemax={questionsToUse.length}>
          <div className="progress-fill" style={{ width: `${((state.currentIndex + 1) / questionsToUse.length) * 100}%` }} />
        </div>
        <span className="progress-text">
          {state.mode === "test" ? `Score: ${state.score} / ${maxScore}` : `Question ${state.currentIndex + 1} of ${questionsToUse.length}`}
        </span>
      </div>

      {renderQuestion()}

      <div className="quiz-nav">
        <button
          onClick={handlePrevious}
          disabled={isFirstQuestion}
          className="nav-btn"
          aria-label="Previous question"
        >
          ← Previous
        </button>

        <div className="question-dots" role="tablist" aria-label="Questions">
          {questionsToUse.map((_, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === state.currentIndex}
              aria-label={`Question ${i + 1}`}
              className={`question-dot ${i === state.currentIndex ? "active" : ""} ${state.answers[questionsToUse[i].id] !== undefined ? "answered" : ""} ${state.answers[questionsToUse[i].id] !== undefined && checkAnswer(questionsToUse[i], state.answers[questionsToUse[i].id]!) ? "correct" : ""}`}
              onClick={() => setState(prev => ({ ...prev, currentIndex: i, showExplanation: false, submitted: false }))}
            />
          ))}
        </div>

        {isLastQuestion && state.mode === "test" && state.submitted ? (
          <button onClick={handleRestart} className="nav-btn primary">View Results</button>
        ) : (
          <button
            onClick={state.mode === "practice" && !state.submitted ? handleSubmit : handleNext}
            disabled={state.mode === "practice" && !isAnswered}
            className="nav-btn primary"
            aria-label={isLastQuestion ? "Finish" : "Next question"}
          >
            {state.mode === "practice" && !state.submitted ? "Check Answer" : isLastQuestion ? "Finish" : "Next →"}
          </button>
        )}
      </div>

      {state.mode === "test" && state.submitted && isLastQuestion && (
        <div className="quiz-results" role="status" aria-live="polite">
          <h4>Test Complete!</h4>
          <div className="score-display">
            <span className="score-value">{state.score}</span>
            <span className="score-max">/ {maxScore}</span>
          </div>
          <div className="score-percent">
            {Math.round((state.score / maxScore) * 100)}%
          </div>
          <button onClick={handleRestart} className="restart-btn">Retake Test</button>
        </div>
      )}
    </div>
  );
}