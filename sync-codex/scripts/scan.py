#!/usr/bin/env python3
"""Inventory the CLAUDE.md / AGENTS.md pairs and the Claude/Codex skill sets.

This script does the *census* only — it finds what exists and how things pair
up. It deliberately does NOT judge whether two files have "diverged" in meaning;
that needs reading and judgment, which the model does after this runs.

Output is JSON on stdout so the calling agent can reason over it.

Usage:
    python scan.py --workspace "C:/Users/khe61/OneDrive/Documents/CS Programs"

Defaults: --claude-home ~/.claude, --codex-home ~/.codex, --workspace = cwd.
Pass --no-global to skip the two global instruction files.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Directories that never contain instruction files we care about, and that are
# expensive or noisy to walk. Matched by exact name at any depth.
SKIP_DIRS = {
    "node_modules", ".git", ".next", ".turbo", "dist", "build", "out",
    ".venv", "venv", "__pycache__", ".cache", "coverage", ".vercel",
    ".expo", "ios", "android", "vendor", ".idea", ".vscode", "Pods",
}

# Skill directories that are not user-authored and must not be synced.
SKIP_SKILL_DIRS = {".system"}


def file_info(p: Path) -> dict:
    info = {"path": str(p), "exists": p.exists()}
    if p.exists() and p.is_file():
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
            info["lines"] = text.count("\n") + 1
            info["bytes"] = len(text.encode("utf-8"))
            info["mtime"] = p.stat().st_mtime
        except OSError as e:
            info["error"] = str(e)
    return info


def find_instruction_files(workspace: Path) -> list[Path]:
    found: list[Path] = []
    for p in workspace.rglob("*"):
        # Prune skip dirs cheaply by checking path parts.
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.is_file() and p.name in ("CLAUDE.md", "AGENTS.md"):
            found.append(p)
    return found


def pair_instruction_files(files: list[Path]) -> list[dict]:
    by_dir: dict[Path, dict] = {}
    for f in files:
        slot = by_dir.setdefault(f.parent, {})
        slot[f.name] = f
    pairs = []
    for d in sorted(by_dir, key=lambda x: str(x).lower()):
        claude = by_dir[d].get("CLAUDE.md")
        codex = by_dir[d].get("AGENTS.md")
        if claude and codex:
            status = "both"
        elif claude:
            status = "claude_only"
        else:
            status = "codex_only"
        pairs.append({
            "dir": str(d),
            "status": status,
            "claude": file_info(claude) if claude else None,
            "codex": file_info(codex) if codex else None,
        })
    return pairs


def list_skills(skills_dir: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not skills_dir.is_dir():
        return out
    for d in sorted(skills_dir.iterdir(), key=lambda x: x.name.lower()):
        if not d.is_dir():
            continue
        if d.name in SKIP_SKILL_DIRS or d.name.endswith("-workspace"):
            continue
        skill_md = d / "SKILL.md"
        if not skill_md.is_file():
            continue
        out[d.name] = {
            "name": d.name,
            "skill_md": file_info(skill_md),
            "has_openai_yaml": (d / "agents" / "openai.yaml").is_file(),
            "files": sorted(
                str(p.relative_to(d)) for p in d.rglob("*") if p.is_file()
            ),
        }
    return out


def pair_skills(claude_skills: dict, codex_skills: dict) -> list[dict]:
    names = sorted(set(claude_skills) | set(codex_skills))
    pairs = []
    for n in names:
        c = claude_skills.get(n)
        x = codex_skills.get(n)
        if c and x:
            status = "both"
        elif c:
            status = "claude_only"
        else:
            status = "codex_only"
        pairs.append({"name": n, "status": status, "claude": c, "codex": x})
    return pairs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", default=".")
    ap.add_argument("--claude-home", default=str(Path.home() / ".claude"))
    ap.add_argument("--codex-home", default=str(Path.home() / ".codex"))
    ap.add_argument("--no-global", action="store_true")
    args = ap.parse_args()

    workspace = Path(args.workspace).expanduser().resolve()
    claude_home = Path(args.claude_home).expanduser()
    codex_home = Path(args.codex_home).expanduser()

    result: dict = {"workspace": str(workspace)}

    # Global instruction files.
    if not args.no_global:
        result["global_instructions"] = {
            "claude": file_info(claude_home / "CLAUDE.md"),
            "codex": file_info(codex_home / "AGENTS.md"),
        }

    # Repo instruction-file pairs.
    inst = find_instruction_files(workspace)
    result["instruction_pairs"] = pair_instruction_files(inst)

    # Skills.
    claude_skills = list_skills(claude_home / "skills")
    codex_skills = list_skills(codex_home / "skills")
    result["skills"] = {
        "claude_dir": str(claude_home / "skills"),
        "codex_dir": str(codex_home / "skills"),
        "pairs": pair_skills(claude_skills, codex_skills),
    }

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
