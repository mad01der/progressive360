"""
Run E3PO comp1 on_demand preprocessing for a local video.

Outputs (under this directory, same layout as BaseData):
  {video_stem}_{chunk_duration}s/
    video_size.json
    dst_video_folder/

Usage (from repo root or from this folder):
  python system/progressive360/run_e3po_preprocessing.py
  python system/progressive360/run_e3po_preprocessing.py --video other.mp4

Requires: ffmpeg/ffprobe on PATH, repo dependencies for e3po.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from pathlib import Path


def _repo_root() -> Path:
    # system/progressive360/ -> progressive_360/
    return Path(__file__).resolve().parent.parent.parent


def _ffprobe_json(path: Path) -> dict:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate,avg_frame_rate",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    out = subprocess.check_output(cmd, text=True)
    return json.loads(out)


def _parse_fps(r_frame_rate: str | None) -> float:
    if not r_frame_rate or r_frame_rate == "0/0":
        return 30.0
    n, d = r_frame_rate.split("/")
    return float(n) / float(d)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="E3PO preprocessing (comp1 / on_demand) into this folder."
    )
    parser.add_argument(
        "--video",
        default="video.mp4",
        help="Video filename inside this directory (default: video.mp4)",
    )
    args = parser.parse_args()

    here = Path(__file__).resolve().parent
    repo = _repo_root()
    video_path = here / args.video
    if not video_path.is_file():
        print(f"ERROR: video not found: {video_path}", file=sys.stderr)
        sys.exit(1)

    e3po_yml = repo / "e3po" / "e3po.yml"
    if not e3po_yml.is_file():
        print(f"ERROR: missing {e3po_yml}", file=sys.stderr)
        sys.exit(1)

    import yaml

    with open(e3po_yml, encoding="utf-8") as f:
        opt = yaml.safe_load(f.read())

    es = opt["e3po_settings"]
    probe = _ffprobe_json(video_path)
    stream = probe.get("streams", [{}])[0]
    fmt = probe.get("format", {})
    duration = float(fmt.get("duration", 0.0))
    if duration <= 0:
        print("ERROR: could not read duration from ffprobe", file=sys.stderr)
        sys.exit(1)

    fps = _parse_fps(stream.get("avg_frame_rate") or stream.get("r_frame_rate"))
    width = int(stream.get("width", 3840))
    height = int(stream.get("height", 1920))

    chunk_dur = es["video"]["chunk_duration"]
    stem = Path(args.video).stem
    work_folder_name = f"{stem}_{chunk_dur}s"

    # Paths consumed by BaseData / BaseDecision / BaseEvaluation
    es["video"]["origin"]["video_dir"] = str(here.resolve())
    es["video"]["origin"]["video_name"] = args.video
    es["video"]["origin"]["width"] = width
    es["video"]["origin"]["height"] = height
    es["video"]["video_duration"] = duration
    es["video"]["video_fps"] = fps
    es["tile_size"]["folder_name"] = work_folder_name

    opt["approach_name"] = "comp1"
    opt["approach_type"] = "on_demand"
    opt["project_path"] = str(repo)

    sys.path.insert(0, str(repo))
    os.chdir(repo)

    # Match e3po.utils.options.get_opt logger setup (minimal)
    from e3po.utils import get_logger

    test_group = opt.get("test_group", "progressive")
    log_dir = repo / "log" / test_group / stem
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "comp1_make_preprocessing.log"
    console_level = es["log"].get("console_log_level") or logging.INFO
    if not isinstance(console_level, int):
        console_level = logging.INFO
    file_level = es["log"].get("file_log_level") or logging.DEBUG
    if not isinstance(file_level, int):
        file_level = logging.DEBUG
    get_logger(
        log_file=str(log_file),
        console_log_level=console_level,
        file_log_level=file_level,
    )

    from e3po.data import build_data

    get_logger().info("[preprocessing data] start (progressive360 helper)")
    data = build_data(opt)
    data.make_preprocessing()
    get_logger().info("[preprocessing data] end")

    out_dir = here / work_folder_name
    print("")
    print("Preprocessing finished.")
    print(f"  Output folder: {out_dir}")
    print(f"  video_size.json: {out_dir / 'video_size.json'}")
    print(f"  Encoded tiles:   {out_dir / 'dst_video_folder'}")
    print("")
    print(
        "For decision/evaluation, point e3po.yml to the same video_dir / video_name, "
        f"and set tile_size.folder_name to: {work_folder_name}"
    )


if __name__ == "__main__":
    main()
