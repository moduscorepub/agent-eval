"""Call sites, imports, and same-named definitions of Python names, found with the ast module.

usage: python3 callsites.py <repo-root> <target-rel-path> <name>[,<name>...]
prints JSON: {"<name>": {"calls": [[file, line, code]], "imports": [...], "defs": [...]}}
Only files other than the target are reported; definitions inside classes are reported as
same-named implementations (methods with the same name on other classes).
"""
import ast
import json
import os
import sys

SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", "site-packages", "build", "dist", ".mypy_cache", ".tox"}


def main() -> None:
    root, target, names_arg = sys.argv[1], sys.argv[2], sys.argv[3]
    names = set(n for n in names_arg.split(",") if n)
    out = {n: {"calls": [], "imports": [], "defs": []} for n in names}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            abs_path = os.path.join(dirpath, fn)
            rel = os.path.relpath(abs_path, root)
            if rel == target:
                continue
            try:
                with open(abs_path, encoding="utf-8") as fh:
                    src = fh.read()
                tree = ast.parse(src)
            except (SyntaxError, UnicodeDecodeError, OSError, ValueError):
                continue
            lines = src.splitlines()

            def code(lineno: int) -> str:
                return lines[lineno - 1].strip()[:160] if 0 < lineno <= len(lines) else ""

            for node in ast.walk(tree):
                if isinstance(node, ast.Call):
                    f = node.func
                    name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
                    if name in names:
                        out[name]["calls"].append([rel, node.lineno, code(node.lineno)])
                elif isinstance(node, ast.ImportFrom):
                    for alias in node.names:
                        if alias.name in names:
                            out[alias.name]["imports"].append([rel, node.lineno, code(node.lineno)])
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in names:
                    out[node.name]["defs"].append([rel, node.lineno, code(node.lineno)])
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
