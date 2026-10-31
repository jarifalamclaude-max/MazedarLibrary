"""Gentle music-box lullaby for the promo (synthesised, no samples, no licences).

Usage: python3 tools/promo/music.py OUT.wav SECONDS
D major, I-V-vi-IV, 84 bpm: music-box arpeggio + soft pad + light bass,
fade-in/out, peak -3 dBFS. Reverb is added by ffmpeg in render.sh.
"""
import sys
import wave

import numpy as np

SR = 44100
OUT = sys.argv[1]
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 36.0
BPM = 84
BEAT = 60 / BPM
EIGHTH = BEAT / 2
N = int(SR * DUR)
left = np.zeros(N)
right = np.zeros(N)


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def add(buf_l, buf_r, start, sig, pan=0.0):
    i = int(start * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    gl = np.sqrt(0.5 * (1 - pan))
    gr = np.sqrt(0.5 * (1 + pan))
    buf_l[i:i + len(sig)] += sig * gl
    buf_r[i:i + len(sig)] += sig * gr


def music_box(freq, length=1.6, vel=1.0):
    t = np.arange(int(SR * length)) / SR
    env = np.minimum(1, t / 0.004) * np.exp(-t / 0.55)
    tone = (np.sin(2 * np.pi * freq * t) + 0.22 * np.sin(2 * np.pi * 2 * freq * t) * np.exp(-t / 0.25)
            + 0.06 * np.sin(2 * np.pi * 4.01 * freq * t) * np.exp(-t / 0.12))
    return 0.16 * vel * env * tone


def pad(freqs, length):
    t = np.arange(int(SR * length)) / SR
    env = np.minimum(1, t / 0.9) * np.minimum(1, (length - t) / 0.9)
    s = np.zeros_like(t)
    for f in freqs:
        for detune in (-0.0015, 0.0015):
            s += np.sin(2 * np.pi * f * (1 + detune) * t)
    return 0.018 * env * s


def bass(freq, length=2.4):
    t = np.arange(int(SR * length)) / SR
    env = np.minimum(1, t / 0.01) * np.exp(-t / 1.1)
    return 0.12 * env * (np.sin(2 * np.pi * freq * t) + 0.15 * np.sin(2 * np.pi * 2 * freq * t))


# D major: I (D) - V (A) - vi (Bm) - IV (G); chord tones as MIDI notes
CHORDS = [
    (50, [62, 66, 69]),  # D
    (45, [61, 64, 69]),  # A
    (47, [62, 66, 71]),  # Bm
    (43, [62, 67, 71]),  # G
]
# eighth-note arpeggio pattern over the chord (index into a 2-octave chord ladder)
PATTERN = [0, 2, 4, 3, 5, 4, 2, 3]

bar = 4 * BEAT
t = 0.6  # tiny intro breath
k = 0
while t < DUR - bar * 0.5:
    root, tones = CHORDS[k % 4]
    ladder = tones + [n + 12 for n in tones]
    add(left, right, t, pad([midi(n) for n in tones], bar + 0.6))
    add(left, right, t, bass(midi(root)))
    add(left, right, t + 2 * BEAT, bass(midi(root)), 0.0)
    for j, p in enumerate(PATTERN):
        note = ladder[p] + (12 if k % 8 >= 4 and j in (3, 5) else 0)
        vel = 1.0 if j % 4 == 0 else 0.78
        add(left, right, t + j * EIGHTH, music_box(midi(note), vel=vel), pan=(-0.25 if j % 2 else 0.25))
    t += bar
    k += 1

# a final tonic chime
add(left, right, min(t, DUR - 2.4), music_box(midi(74), length=2.4, vel=0.9), 0.1)
add(left, right, min(t, DUR - 2.4), music_box(midi(78), length=2.4, vel=0.6), -0.1)

stereo = np.stack([left, right], axis=1)
fade_in = np.minimum(1, np.arange(N) / (SR * 0.8))
fade_out = np.minimum(1, (N - np.arange(N)) / (SR * 2.2))
stereo *= (fade_in * fade_out)[:, None]
stereo /= max(1e-9, np.abs(stereo).max())
stereo *= 10 ** (-3 / 20)
pcm = (stereo * 32767).astype(np.int16)
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f'{OUT}: {DUR:.1f}s')
