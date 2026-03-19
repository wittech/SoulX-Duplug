# AGENTS.md — SoulX-FlashHead

## Project Overview

SoulX-FlashHead is a PyTorch-based ML research project for real-time streaming talking head video generation from audio input. Built on top of the Wan video model with wav2vec2 audio encoding. Two model variants: Pro (higher quality, multi-GPU) and Lite (faster, single GPU).

Key frameworks: PyTorch, torchvision, transformers (HuggingFace), einops, loguru, PIL, numpy, scipy.

## Project Structure

```
flash_head/                  # Core library
  inference.py               # Main inference entry point (FlashHeadInference class)
  configs/
    infer_params.yaml        # Default inference parameters
  src/
    modules/
      flash_head_model.py    # WanModelAudioProject — main model architecture
      block.py               # Transformer blocks, attention layers
    pipeline/
      flash_head_pipeline.py # FlashHeadPipeline — orchestrates inference
  audio_analysis/
    wav2vec2.py              # Wav2Vec2 audio feature extraction
    torch_utils.py           # PyTorch utility functions
  utils/
    utils.py                 # Color space transforms, image processing
    facecrop.py              # Face detection and cropping
    cpu_face_handler.py      # CPU-based face handling
server/
  app.py                     # FastAPI server for HTTP inference API
generate_video.py            # CLI entry point for video generation
configs/                     # Additional config files
examples/                    # Sample images and audio files
```

## Build & Run Commands

### Environment Setup
```bash
conda create -n flashhead python=3.10
conda activate flashhead
pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu128
pip install -r requirements.txt
pip install ninja && pip install flash_attn==2.8.0.post2 --no-build-isolation
```

### Inference (CLI)
```bash
# Single GPU — Lite model
bash inference_script_single_gpu_lite.sh

# Single GPU — Pro model
bash inference_script_single_gpu_pro.sh

# Multi GPU — Pro model (torchrun)
bash inference_script_multi_gpu_pro.sh
```

### Direct Python invocation
```bash
# Single GPU
python generate_video.py \
    --ckpt_dir models/SoulX-FlashHead-1_3B \
    --wav2vec_dir models/wav2vec2-base-960h \
    --model_type lite \
    --cond_image examples/girl.png \
    --audio_path examples/podcast_sichuan_16k.wav

# Multi GPU (torchrun)
CUDA_VISIBLE_DEVICES=0,1 torchrun --nproc_per_node=2 generate_video.py \
    --ckpt_dir models/SoulX-FlashHead-1_3B \
    --wav2vec_dir models/wav2vec2-base-960h \
    --model_type pro \
    --cond_image examples/girl.png \
    --audio_path examples/podcast_sichuan_16k.wav
```

### Server
```bash
python server/app.py  # FastAPI server on port 8188
```

### Tests
No formal test suite exists. Validate changes by running inference scripts.

### Lint / Format
No linter or formatter is configured. No pyproject.toml, setup.py, or setup.cfg exists.

## Code Style Guidelines

### Language
- Python 3.10+. Code comments and docstrings are a mix of English and Chinese (中文). Both are acceptable.

### Imports
- Standard library first, then third-party, then local — but no enforced separator lines.
- Absolute imports from project root: `from flash_head.src.modules.flash_head_model import WanModelAudioProject`
- No `__init__.py` files — modules are imported by full dotted path.
- Inline imports are used occasionally inside functions (e.g., `import glob` inside a function body).

### Naming Conventions
- **Files**: `snake_case.py` (e.g., `flash_head_model.py`, `flash_head_pipeline.py`)
- **Classes**: `PascalCase` (e.g., `FlashHeadPipeline`, `WanModelAudioProject`, `FlashHeadInference`)
- **Functions/methods**: `snake_case` (e.g., `get_cond_image_dict`, `timestep_transform`)
- **Constants**: `UPPER_SNAKE_CASE` at module level (e.g., `COMPILE_MODEL = True`, `USE_PARALLEL_VAE = True`)
- **Variables**: `snake_case`, short math-style names acceptable in tensor ops (e.g., `t`, `L`, `a`, `b`, `f_xyz`)

### Type Hints
- Minimal usage. Type hints appear on some function signatures (e.g., `rgb: torch.Tensor -> torch.Tensor`) but are not consistently applied.
- No strict typing enforcement. No mypy or pyright config.

### Error Handling
- `try/except` with `loguru.logger.error()` for non-fatal errors, then fallback behavior.
- Pattern: try operation → catch Exception → log error → return fallback value.
- Example from pipeline: `try: image = process_image(path) except Exception as e: logger.error(f"Error: {e}")` then falls back to `Image.open()`.

### Logging
- Uses `loguru` exclusively (`from loguru import logger`).
- `logger.info()` for progress, `logger.error()` for errors, `logger.warning()` for warnings.
- f-string formatting in log messages: `logger.info(f"Processing {filename}")`.

### Configuration
- YAML config files in `flash_head/configs/` loaded at runtime.
- CLI args via `argparse` in `generate_video.py` with defaults from YAML.
- Module-level constants for compile/optimization flags.

### Tensor Operations
- Heavy use of `einops.rearrange` for tensor reshaping.
- `torch.no_grad()` context managers for inference.
- Distributed training via `torch.distributed` (torchrun).
- Device management: explicit `.to(device)` and `CUDA_VISIBLE_DEVICES`.

### Architecture Patterns
- **Pipeline pattern**: `FlashHeadPipeline` orchestrates model loading, preprocessing, and inference.
- **Inference wrapper**: `FlashHeadInference` wraps pipeline with config management and CLI integration.
- **Server layer**: FastAPI app in `server/app.py` wraps inference for HTTP API.
- No dependency injection — direct instantiation throughout.
- No abstract base classes or interfaces.

### Key Dependencies
- `torch` / `torchvision` — core ML framework
- `transformers` — HuggingFace models (Wav2Vec2)
- `einops` — tensor operations
- `loguru` — logging
- `PIL` / `Pillow` — image processing
- `numpy` / `scipy` — numerical operations
- `flash_attn` — FlashAttention for fast inference
- `sageattention` (optional) — additional attention optimization
- `ffmpeg` — video encoding (system dependency)
- `fastapi` / `uvicorn` — HTTP server

### Things to Watch Out For
- No `__init__.py` files — don't add them without understanding the import structure.
- Model weights are downloaded separately via `huggingface-cli` into `models/` directory.
- Multi-GPU code uses `torchrun` and `torch.distributed` — test distributed changes carefully.
- `COMPILE_MODEL` and `COMPILE_VAE` flags in pipeline control `torch.compile` — can cause issues during development.
- Chinese comments are normal and expected — do not remove or translate them.
