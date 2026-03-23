# AGENTS.md — SoulX-Duplug

Practical instructions for agentic coding in this repository.

## Project map

- Root turn-taking service:
  - `server.py`
  - `service/` (`model.py`, `engine.py`, `session.py`)
  - `config/` (`config.py`, `config.yaml`)
  - `run.sh`
- Dialogue app stack:
  - `dialogue_system/app.py`
  - `dialogue_system/scripts/*.sh`
  - `dialogue_system/clients/*`
- Large integrated modules (treat as vendor-like unless task requires changes):
  - `dialogue_system/modules/*`

## Environment

Primary docs target Python 3.10.

```bash
conda create -n dialogue-system -y python=3.10.16
conda activate dialogue-system
conda install -y -c conda-forge pynini==2.1.5
pip install -r requirements.txt
```

For dialogue system subtree:

```bash
cd dialogue_system
pip install -r requirements.txt
```

## Build / run commands

### Root service

```bash
bash run.sh
# equivalent:
uvicorn server:app --host 127.0.0.1 --port 8000 --workers 1
```

### Dialogue system services (run from `dialogue_system/`)

```bash
bash scripts/tts_server.sh
bash scripts/llm_server.sh
bash scripts/vad_server.sh
bash scripts/flashhead_server.sh
bash deploy.sh   # deploy.sh runs: python app.py
```

## Test / validation commands

There is no unified root test config (`pytest.ini`, `tox.ini`, `noxfile`, standard `tests/` layout not found at root).

Use these checks:

```bash
python test.py                 # root smoke client
python server.py               # root server entry check
python dialogue_system/app.py  # dialogue app entry check
```

If/when pytest tests are added, single-test patterns:

```bash
pytest path/to/test_file.py
pytest path/to/test_file.py::test_case_name
pytest -k "keyword"
```

## Lint / format / typecheck status

- No authoritative root lint/format config detected (`.flake8`, root `pyproject.toml`, `setup.cfg`, `.editorconfig` absent).
- Dependencies include `black` and `ruff`, but no repo-level policy file was found.
- Guidance:
  - Keep edits local and style-consistent with surrounding code.
  - Avoid mass reformatting untouched files.
  - Only run formatter/linter in targeted scope when task requires it.

## Code style conventions (observed)

### Imports

- Typical order in active service code:
  1) stdlib
  2) third-party
  3) local modules
- Reference files: `server.py`, `dialogue_system/app.py`, `service/model.py`.
- Existing code sometimes uses compact imports (`import os, sys`); prefer one import per line in new code unless matching file style is important.

### Formatting

- 4-space indentation.
- Blank lines between top-level defs.
- Parentheses for multiline expressions.
- f-strings are common for logs and diagnostics.

### Types

- Type usage is partial (mixture of typed and untyped functions).
- In new code, add type hints for public functions and complex returns.
- Do not weaken types with blanket `Any` unless unavoidable.

### Naming

- Files/modules: `snake_case.py`
- Variables/functions: `snake_case`
- Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`

### Error handling

- Broad `try/except Exception` exists in realtime paths.
- When changing code:
  - prefer specific exceptions if practical,
  - keep graceful fallback behavior for user-facing runtime paths,
  - include actionable error logs/messages.
- Avoid silent failure for critical logic.

### Logging

- Mixed style exists:
  - `print(...)` in some root/model code,
  - `logging` logger in dialogue/FlashHead service layers.
- For new runtime code, prefer `logging`-based structured logs.
- Keep debug noise behind flags.

### Config patterns

- Central config flow is YAML + dataclass/OmegaConf:
  - `config/config.yaml`
  - `config/config.py`
- Prefer extending config centrally rather than scattering hard-coded constants.

## Runtime assumptions to preserve

Ports used by scripts:

- TTS: `6006`
- LLM: `6007`
- FlashHead: `6008`
- VAD/root turn server: `8010` / `8000` (entrypoint dependent)
- Dialogue UI app: `55556`

Do not change these defaults unless task explicitly requests it.

## Cursor / Copilot instruction files

Checked for repository instructions in:

- `.cursor/rules/`
- `.cursorrules`
- `.github/copilot-instructions.md`

None were found in this repository root during analysis.

## Agent change checklist

Before finishing a task:

1. Re-check touched files for local style consistency.
2. Run the closest relevant command from the sections above.
3. Verify config/service paths still match runtime expectations.
4. Keep changes minimal when modifying realtime-critical code.
5. Document assumptions and limitations in your final summary.
