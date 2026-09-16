"""
code_assist.py

Real LLM-backed implementations for the Tests and Migrate workspaces
(TestsPage.jsx / MigratePage.jsx on the frontend). Unlike /api/ai/ask and
/index/{repository_id}, these are stateless — the frontend already has the
function/file source in memory (from the Analysis Engine that ran in the
browser at upload time), so it's sent directly in the request body instead
of being looked up from Postgres/Neo4j. The only hard requirement is a
configured LEGACYBRIDGE_LLM_API_KEY (see config.py); no DB/graph needed.

Both functions ask the model to return ONLY a JSON object (no markdown
fences, no prose) matching a fixed shape, then parse it defensively —
models occasionally wrap JSON in ```json fences or add a stray sentence
despite instructions, so `_extract_json` pulls out the first {...} block
rather than trusting `content` to be clean JSON.
"""
import json
import re

from . import llm_client


def _extract_json(text: str | None) -> dict:
    if not text:
        raise ValueError("empty LLM response")
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else text
    match = re.search(r"\{.*\}", candidate, re.DOTALL)
    if not match:
        raise ValueError(f"no JSON object found in LLM response: {text[:200]!r}")
    return json.loads(match.group(0))


def generate_tests(function_name: str, file_path: str, code: str) -> dict:
    """Real unit tests for one function, from its actual source.
    Returns {testCode, coverageEstimate, notes}."""
    system = (
        "You are a senior software engineer writing unit tests for a legacy "
        "codebase migration tool. Given one function's real source code, write "
        "a focused, runnable unit test file for it. Pick the idiomatic test "
        "framework for the file's language (e.g. vitest/jest for JS/TS, JUnit 5 "
        "for Java, pytest for Python). Cover the typical case and at least one "
        "realistic edge case. Base everything only on the source actually "
        "given — don't invent behavior you can't see. Respond with ONLY a JSON "
        "object, no prose, no markdown fences, matching exactly this shape:\n"
        '{"testCode": "<the full test file source, as a single string with '
        '\\n newlines>", "coverageEstimate": <integer 0-100, your honest '
        "estimate of % of the function's branches this covers>, \"notes\": "
        '"<1-2 sentences on any behavior you could not verify from the source '
        'alone, or empty string>"}'
    )
    user = (
        f"File: {file_path}\n"
        f"Function under test: {function_name}\n\n"
        f"Source:\n{code or '// source not available'}"
    )
    turn = llm_client.chat_with_tools([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ])
    result = _extract_json(turn.content)
    return {
        "testCode": result.get("testCode", ""),
        "coverageEstimate": int(result.get("coverageEstimate", 0) or 0),
        "notes": result.get("notes", ""),
    }


def suggest_migration(file_path: str, code: str) -> dict:
    """Finds real legacy/risky patterns in one file's actual source and
    proposes modern replacements. Returns {hunks: [...]}, possibly empty."""
    system = (
        "You are a senior software engineer reviewing legacy code for a "
        "modernization tool. Given one file's real source, find UP TO 6 "
        "concrete legacy or risky patterns (e.g. deprecated APIs, hardcoded "
        "secrets, unsafe eval/exec, outdated syntax, missing error handling, "
        "clear security issues). For each, quote the exact offending line(s) "
        "verbatim and propose a specific modern replacement. Never invent "
        "issues that aren't actually in the source — if the file is already "
        "clean, return an empty hunks list. Respond with ONLY a JSON object, "
        "no prose, no markdown fences, matching exactly this shape:\n"
        '{"hunks": [{"before": "<offending line(s), verbatim from source>", '
        '"after": "<the suggested replacement code, or a one-line comment '
        "explaining the fix if a full rewrite isn't a single-line swap>\", "
        '"category": "<one of: Security, Deprecated API, Performance, '
        'Stylistic>", "severity": "<one of: High, Medium, Low>", '
        '"explanation": "<one sentence on why this matters>"}]}'
    )
    user = f"File: {file_path}\n\nSource:\n{code or '// source not available'}"
    turn = llm_client.chat_with_tools([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ])
    result = _extract_json(turn.content)
    hunks = result.get("hunks", [])
    return {"hunks": hunks if isinstance(hunks, list) else []}
