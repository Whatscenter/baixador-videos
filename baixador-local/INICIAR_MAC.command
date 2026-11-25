#!/bin/bash
cd "$(dirname "$0")"
python3 -m pip install -U -q yt-dlp
python3 baixar_videos.py
