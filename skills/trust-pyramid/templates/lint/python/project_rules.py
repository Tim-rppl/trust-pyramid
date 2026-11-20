"""Project lint rules (AST + comment checks) that ruff cannot express.

Template from the trust-pyramid skill. Adapt the paths and messages to the project; delete rules
that do not apply. Each message says what is wrong, why, how to fix it, and the sanctioned exception.
Usage: python -m lint.project_rules [paths...]   (default: app/)   exit 1 on violations.
Prove each rule with lint/fixtures/violations.py and lint/fixtures/compliant.py.
"""

import ast
import io
import re
import sys
import tokenize
from dataclasses import dataclass
from pathlib import Path

ENV_ALLOWED = {"app/config.py"}
MODEL_HTTP_ALLOWED = {"app/adapters/ai.py"}
MODEL_HTTP_MODULES = {"httpx", "openai", "requests", "urllib.request", "aiohttp"}
EXCUSE = re.compile(r"\b(hack|workaround|temporary fix|temp fix|for now|quick fix|patch for now)\b", re.IGNORECASE)

MESSAGES = {
    "TP001": (
        "Environment variable read outside app/config.py. Env vars are read and validated once at startup. "
        "Fix: add a field to Settings in app/config.py and pass Settings in. Exception: none."
    ),
    "TP002": (
        "HTTP client '{module}' imported outside app/adapters/ai.py. Model calls must go through AIClient "
        "(timeout, retry cap, max_tokens, schema validation). Fix: call app.adapters.ai.AIClient. "
        "Exception: a new external service gets its own adapter in app/adapters/ - ask the user first."
    ),
    "TP003": (
        "print() in application code. Output may leak user content and is not structured. "
        "Fix: use app.log.event(name, **numeric_fields). Exception: none in app/."
    ),
    "TP004": (
        "Comment excuses a workaround ('{word}'). Agents copy workarounds. Fix the root cause and delete the "
        "comment. If it truly cannot be fixed now, add a row to quality/rule-candidates.md instead of a comment."
    ),
}


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.code} {self.message}"


def _relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _reads_env(node: ast.AST) -> bool:
    if isinstance(node, ast.Attribute) and node.attr in {"environ", "getenv"}:
        return isinstance(node.value, ast.Name) and node.value.id == "os"
    if isinstance(node, ast.ImportFrom) and node.module == "os":
        return any(alias.name in {"environ", "getenv"} for alias in node.names)
    return False


def _imported_modules(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    if isinstance(node, ast.ImportFrom) and node.module:
        return [node.module]
    return []


def check_source(source: str, rel: str) -> list[Violation]:
    found: list[Violation] = []
    tree = ast.parse(source, filename=rel)
    for node in ast.walk(tree):
        if rel not in ENV_ALLOWED and _reads_env(node):
            found.append(Violation(rel, getattr(node, "lineno", 0), "TP001", MESSAGES["TP001"]))
        if rel not in MODEL_HTTP_ALLOWED:
            for module in _imported_modules(node):
                if module in MODEL_HTTP_MODULES or module.split(".")[0] in MODEL_HTTP_MODULES - {"urllib.request"}:
                    message = MESSAGES["TP002"].format(module=module)
                    found.append(Violation(rel, getattr(node, "lineno", 0), "TP002", message))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "print":
            found.append(Violation(rel, node.lineno, "TP003", MESSAGES["TP003"]))
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT and (match := EXCUSE.search(token.string)):
            found.append(Violation(rel, token.start[0], "TP004", MESSAGES["TP004"].format(word=match.group(0))))
    return sorted(found, key=lambda v: (v.line, v.code))


def check_paths(paths: list[Path], root: Path, as_rel: dict[Path, str] | None = None) -> list[Violation]:
    found: list[Violation] = []
    for base in paths:
        files = sorted(base.rglob("*.py")) if base.is_dir() else [base]
        for file in files:
            rel = (as_rel or {}).get(file, _relative(file, root))
            found.extend(check_source(file.read_text(encoding="utf-8"), rel))
    return found


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parents[1]
    paths = [Path(arg) for arg in argv] or [root / "app"]
    violations = check_paths(paths, root)
    for violation in violations:
        sys.stdout.write(f"{violation}\n")
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
