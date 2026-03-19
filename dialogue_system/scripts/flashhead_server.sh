script_dir=$(dirname "$(realpath "$0")")
# Get the root directory (dialogue_system/)
root_dir=$(dirname "$script_dir")

cd ${root_dir}/modules/FlashHead

python -m server.run \
    --host 0.0.0.0 \
    --port 6008 \
    --ckpt_dir /data/models/SoulX-FlashHead-1_3B \
    --wav2vec_dir /data/models/wav2vec2-base-960h \
    --model_type lite \
    --cond_image examples/girl.png \
    --device cuda:1
