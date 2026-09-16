"""
Lightweight Ragas/TruLens-style evaluation.

Honesty note on scope: the real `ragas` and `trulens` packages pull in
heavy dependencies (datasets, HF hub pipelines, etc.) and are built around
batch-evaluating a labeled dataset — genuinely worth adopting if/when you
have a curated set of (question, expected_answer) pairs for this codebase.
This module implements the two metrics that matter most for AI Explorer
specifically, using the same LLM-as-judge approach those libraries use
under the hood, so you get real signal today without the extra dependency
weight. Swap in real `ragas` later by replacing `evaluate_answer()`'s body
with `ragas.evaluate(...)` — the call site (main.py's /evaluate endpoint)
doesn't need to change.

Two metrics, each scored 0.0-1.0 by asking the LLM to judge:

- Faithfulness: does the answer only make claims that are actually
  supported by the retrieved context? (catches hallucination)
- Relevance: does the answer actually address what was asked?
  (catches technically-true-but-off-topic answers)
"""
import json
import logging
import re
from dataclasses import dataclass
from . import llm_client

log = logging.getLogger("legacybridge.evaluation")


@dataclass
class EvalResult:
    faithfulness: float
    relevance: float
    faithfulness_reason: str
    relevance_reason: str


def _judge(prompt: str) -> dict:
    messages = [
        {"role": "system", "content": (
            "You are an evaluation judge. Respond with ONLY a JSON object: "
            '{"score": <float 0.0-1.0>, "reason": "<one sentence>"}. No other text.'
        )},
        {"role": "user", "content": prompt},
    ]
    turn = llm_client.chat_with_tools(messages, tools=None)
    content = (turn.content or "").strip()
    content = re.sub(r"^```(json)?|```$", "", content, flags=re.MULTILINE).strip()
    try:
        parsed = json.loads(content)
        return {"score": float(parsed.get("score", 0.0)), "reason": parsed.get("reason", "")}
    except Exception as e:
        log.warning("Eval judge returned unparseable output (%s): %r", e, content)
        return {"score": 0.0, "reason": "Judge output could not be parsed"}


def evaluate_answer(question: str, context_text: str, answer: str) -> EvalResult:
    faithfulness = _judge(
        "Given this retrieved context from a codebase:\n\n"
        f"{context_text[:6000]}\n\n"
        f"And this answer that was given: \"{answer}\"\n\n"
        "Score how well the answer's claims are actually supported by the context above "
        "(1.0 = every claim is grounded in the context, 0.0 = the answer makes claims the "
        "context doesn't support). Don't penalize the answer for using tools to look up "
        "additional information not shown here — only penalize unsupported/fabricated claims."
    )
    relevance = _judge(
        f"Question: \"{question}\"\n\nAnswer: \"{answer}\"\n\n"
        "Score how directly and completely this answer addresses the question "
        "(1.0 = fully addresses it, 0.0 = off-topic or non-answer)."
    )
    return EvalResult(
        faithfulness=faithfulness["score"],
        relevance=relevance["score"],
        faithfulness_reason=faithfulness["reason"],
        relevance_reason=relevance["reason"],
    )


def run_eval_suite(cases: list[dict]) -> list[dict]:
    """
    cases: [{"question": ..., "context_text": ..., "answer": ...}, ...]
    Standalone/offline use — not called from the request path (evaluating
    every live answer would double LLM cost and latency per question).
    Run manually or wire into a CI/regression check: `python -m app.evaluation`.
    """
    results = []
    for case in cases:
        result = evaluate_answer(case["question"], case["context_text"], case["answer"])
        results.append({**case, "faithfulness": result.faithfulness, "relevance": result.relevance,
                         "faithfulness_reason": result.faithfulness_reason,
                         "relevance_reason": result.relevance_reason})
    return results


if __name__ == "__main__":
    # Minimal smoke example — replace with real (question, context, answer)
    # triples pulled from actual AI Explorer usage for a meaningful run.
    example_cases = [{
        "question": "What does the checkout service's discount rule do?",
        "context_text": "if (order.date < promotionExpiry && customer.loyaltyTier > 2) { applyLegacyDiscount(order); }",
        "answer": "It applies a discount for loyalty tier 3+ customers before the promotion expiry date.",
    }]
    for r in run_eval_suite(example_cases):
        print(json.dumps(r, indent=2))
