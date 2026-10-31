#!/usr/bin/env bash
# Rebuilds the promo video from the real app: docs/promo/{mazedar-library-promo.mp4,poster.jpg,teaser.webp}
# Needs: Node 22, Playwright Chromium, ffmpeg, Python 3 + numpy, Java (for the Firebase emulators).
set -euo pipefail
cd "$(dirname "$0")/../.."
SHOTS=.tmp/promo/shots
mkdir -p "$SHOTS" docs/promo
# 1. capture the app (the two-phone scene uses the real Firebase emulators)
npx -y firebase-tools@15.34.0 emulators:exec --only auth,firestore --project demo-mazedar "node tools/promo/capture.mjs $SHOTS"
# 2. music: a synthesised music-box lullaby (no samples, no licences) + a little reverb
python3 tools/promo/music.py .tmp/promo/music-dry.wav 36
ffmpeg -y -loglevel error -i .tmp/promo/music-dry.wav -af "aecho=0.8:0.55:47|83|131:0.22|0.15|0.09,alimiter=limit=0.89" .tmp/promo/music.wav
# 3. frames (deterministic timeline in tools/promo/compose.html)
rm -rf .tmp/promo/frames
node tools/promo/render.mjs .tmp/promo/frames 30
# 4. encode
ffmpeg -y -loglevel error -framerate 30 -i .tmp/promo/frames/%05d.jpg -i .tmp/promo/music.wav \
  -filter_complex "[1:a]loudnorm=I=-16:TP=-1.5:LRA=9[a]" -map 0:v -map "[a]" \
  -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -profile:v high -level 4.2 -movflags +faststart \
  -c:a aac -b:a 160k -ar 44100 -shortest -metadata title="মাজেদার লাইব্রেরি" docs/promo/mazedar-library-promo.mp4
ffmpeg -y -loglevel error -ss 9.4 -i docs/promo/mazedar-library-promo.mp4 -frames:v 1 -vf scale=540:960 -q:v 3 docs/promo/poster.jpg
ffmpeg -y -loglevel error -ss 7.4 -t 12.4 -i docs/promo/mazedar-library-promo.mp4 -vf "fps=10,scale=360:640:flags=lanczos" \
  -an -c:v libwebp_anim -quality 58 -compression_level 6 -loop 0 docs/promo/teaser.webp
echo "done: docs/promo/"
