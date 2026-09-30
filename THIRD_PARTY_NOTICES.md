# Third-party notices

OpenK is licensed under the [MIT License](LICENSE). That license covers only
the original OpenK code and documentation in this repository.

OpenK uses or interoperates with third-party software, services, models, and
media. Those items remain governed by their own licenses and terms. This file
is a practical notice for major direct components; it is not an exhaustive
software bill of materials.

## Source included in this repository

### qrcode-generator 2.0.4

- Project: <https://github.com/kazuhikoarase/qrcode-generator>
- License: MIT
- Local license copy: [`frontend/vendor/LICENSE.qrcode-generator`](frontend/vendor/LICENSE.qrcode-generator)

## Major runtime and build-time components

- [audio-separator](https://github.com/nomadkaraoke/python-audio-separator)
  — MIT
- [WhisperX](https://github.com/m-bain/whisperX) — BSD 2-Clause
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — The Unlicense
- [Deno](https://github.com/denoland/deno) — MIT
- [FFmpeg](https://ffmpeg.org/legal.html) — LGPL or GPL, depending on the
  build configuration and enabled components
- [PyTorch](https://github.com/pytorch/pytorch) and
  [TorchAudio](https://github.com/pytorch/audio) — see their distributions for
  the applicable BSD-style license notices

Python and operating-system packages installed from `requirements*.txt` or by
the container base image retain the license metadata and notices supplied by
their respective distributions. Redistributors should review the exact resolved
dependency set and container contents for the version they ship.

## Models, media, lyrics, and external services

Model weights downloaded by audio-separator, WhisperX, Hugging Face, PyTorch, or
other providers are not licensed by OpenK. Model licenses can differ from the
license of the code that loads them.

OpenK's MIT License does not grant rights to songs, videos, lyrics, subtitles,
recordings, cover art, or other media processed with the software. Users and
redistributors are responsible for obtaining any permissions required by
copyright law, service terms, model licenses, and local regulations.

External services and content sources, including YouTube and LRCLIB, remain
subject to their own terms and policies.
