script_dir=$(dirname "$(realpath "$0")")
# Get the root directory (dialogue_system/)
root_dir=$(dirname "$script_dir")

cache_root="${root_dir}/.runtime_cache"
mkdir -p "${cache_root}/matplotlib" "${cache_root}/xdg"
export MPLCONFIGDIR="${cache_root}/matplotlib"
export XDG_CACHE_HOME="${cache_root}/xdg"

export FLASHHEAD_OUTPUT_FPS=15
export FLASHHEAD_FIRST_SEGMENT_CHUNKS=3
export FLASHHEAD_STEADY_SEGMENT_CHUNKS=6
export FLASHHEAD_OUTPUT_MAX_EDGE=384
export FLASHHEAD_ENCODE_PRESET=veryfast
export FLASHHEAD_ENCODE_CRF=31
export FLASHHEAD_MP4_MOVFLAGS=empty_moov+default_base_moof+frag_keyframe

cd ${root_dir}/modules/FlashHead

python -m server.run \
    --host 0.0.0.0 \
    --port 6008 \
    --ckpt_dir /data/models/SoulX-FlashHead-1_3B \
    --wav2vec_dir /data/models/wav2vec2-base-960h \
    --model_type lite \
    --cond_image examples/girl.png \
    --device cuda:1
