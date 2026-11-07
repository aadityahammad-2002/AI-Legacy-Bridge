"""Protect externally supplied model context; never alter the stored repository.

Source and tool results are *untrusted data*.  This module blocks accidental
credential disclosure into hosted LLM prompts.  Heuristic masking cannot
replace a secret scanner or guarantee that every possible secret is detected.
"""
from __future__ import annotations

import ntpath
import re
from pathlib import PurePosixPath

REDACTED = "[REDACTED_SECRET]"

# Treat these files as off-limits to external LLMs even if the user opened them
# in the editor.  The editor and the database retain their original content.
_PRIVATE_PARTS = frozenset({".ssh", ".aws", ".git", "secrets", "credentials"})
_PRIVATE_NAMES = frozenset({
    ".env", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519",
    "credentials.json", "service-account.json", "service_account.json",
})
_PRIVATE_SUFFIXES = (".pem", ".p12", ".pfx", ".key", ".keystore", ".jks")


def is_sensitive_path(path: str) -> bool:
    if not isinstance(path, str):
        return True
    lowered = path.replace("\\", "/").lower().split("/")
    filename = lowered[-1]
    return (any(part in _PRIVATE_PARTS for part in lowered)
            or filename in _PRIVATE_NAMES
            or (filename.startswith(".env.") and not filename.endswith((".example", ".sample", ".template")))
            or filename.endswith(_PRIVATE_SUFFIXES)
            or "private_key" in filename)


def is_valid_repo_path(path: str) -> bool:
    """Exact relative repository paths only; never filesystem traversal input."""
    if not isinstance(path, str) or not path or len(path) > 1024:
        return False
    if "\\" in path or "\x00" in path or any(ord(ch) < 32 for ch in path):
        return False
    if path.startswith("/") or ntpath.isabs(path):
        return False
    parts = PurePosixPath(path).parts
    return bool(parts) and all(part not in (".", "..") for part in path.split("/"))


_PRIVATE_KEY = re.compile(
    r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----.*?"
    r"-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----",
    re.I | re.S,
)
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9_.~+/-]{10,}={0,2}")
_COMMON_TOKENS = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{25,}|"
    r"AKIA[0-9A-Z]{16})\b"
)
# Supports .env, YAML, Python, JS, and JSON credential *literal* assignments.
# A variable reference e.g. os.getenv('KEY') is not a credential.
_SECRET_KEY = (
    r"(?:[a-zA-Z0-9_]*?(?:api[_-]?key|access[_-]?token|auth[_-]?token|"
    r"password|passwd|client[_-]?secret|secret|token|secret[_-]?key|private[_-]?key|"
    r"access[_-]?key|authorization)[a-zA-Z0-9_]*)"
)
_ASSIGNMENT = re.compile(
    rf"(?im)(?P<prefix>\b{_SECRET_KEY}\s*[:=]\s*)"
    r"(?P<quote>['\"]?)(?P<value>[^\s,'\";#]+)(?P=quote)"
)
_JSON_ASSIGNMENT = re.compile(
    rf"(?im)(?P<prefix>['\"]{_SECRET_KEY}['\"]\s*:\s*['\"])"
    r"(?P<value>[^\r\n'\"]+)(?P<suffix>['\"])"
)
_NOT_LITERALS = ("os.getenv", "os.environ", "process.env", "getenv(", "${", "{{", "<", "[", "None", "null", "undefined")


def _mask_assignment(match: re.Match) -> str:
    value = match.group("value")
    if value.startswith(_NOT_LITERALS) or value.lower() in {"none", "null", "true", "false"}:
        return match.group(0)
    prefix = match.group("prefix")
    return prefix + (match.groupdict().get("quote") or "") + REDACTED + (match.groupdict().get("suffix") or match.groupdict().get("quote") or "")


def redact_text(value: str | None) -> str:
    if value is None:
        return ""
    text = str(value)
    text = _PRIVATE_KEY.sub("[REDACTED_PRIVATE_KEY]", text)
    text = _BEARER.sub("Bearer " + REDACTED, text)
    text = _COMMON_TOKENS.sub(REDACTED, text)
    text = _JSON_ASSIGNMENT.sub(_mask_assignment, text)
    text = _ASSIGNMENT.sub(_mask_assignment, text)
    return text
