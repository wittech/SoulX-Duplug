import argparse
import uvicorn

from server.app import ServerConfig, create_app


def parse_args():
    p = argparse.ArgumentParser(description="FlashHead WebRTC digital human service")
    p.add_argument("--host", type=str, default="0.0.0.0")
    p.add_argument("--port", type=int, default=6008)
    p.add_argument("--ckpt_dir", type=str, required=True, help="FlashHead checkpoint directory")
    p.add_argument("--wav2vec_dir", type=str, required=True, help="wav2vec2 model directory")
    p.add_argument("--model_type", type=str, choices=["lite", "pro", "pretrained"], default="lite")
    p.add_argument("--cond_image", type=str, required=True, help="Default condition image path")
    p.add_argument("--device", type=str, default="cuda:0", help="GPU device, e.g. cuda:0")
    p.add_argument("--base_seed", type=int, default=42)
    p.add_argument("--use_face_crop", action="store_true")
    return p.parse_args()


def main():
    args = parse_args()
    cfg = ServerConfig(
        ckpt_dir=args.ckpt_dir,
        wav2vec_dir=args.wav2vec_dir,
        model_type=args.model_type,
        cond_image=args.cond_image,
        device=args.device,
        base_seed=args.base_seed,
        use_face_crop=bool(args.use_face_crop),
    )
    app = create_app(cfg)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
