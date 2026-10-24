# Watch bench

Local browser timing wizard for the Seiko 7009A. Audio stays on this device.

Live: https://f1nb0.dev/seiko/

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:8765/. Microphone capture needs HTTPS or localhost.

## Publishing

```sh
python3 scripts/stage.py
npx wrangler deploy
```

Only `/seiko` and `/seiko/*` are routed to this Worker. Other site paths stay unchanged. Audio and saved baselines stay in the browser. No audio is uploaded.

The initial snapshot came from the “Guide Seiko 7009A adjustment” chat on 24 October 2026. This repository is the tracked publishing source.

The live worker uses the unchanged tg C timing engine compiled to WebAssembly by [MAC Bespoke Web Timegrapher](https://github.com/natemac/mac-timegrapher), revision `c0f93752332804b30064b91db557471162ca65b9`. The prior custom detector remains only as a synthetic fixture and experimental module. It does not supply the live measurements.

The input passband uses the MIT [jrigol/timegrapher](https://github.com/jrigol/timegrapher) filter, revision `a3021900b49eb1ec30e9497be4f0a0509b3c9d62`. Its tracker is not used: local checks found false candidates from random transients and stale metrics after silence.

Capture defaults to 48 kHz. Higher-rate requests remain available up to 384 kHz, with a 192 kHz fallback for the highest-rate option. Input 1 is selected by default; Input 2 and Mix are explicit choices. Mono sources fall back to their only channel. Per-channel levels expose silent inputs. Stereo imports retain both channels for selection. Native AudioWorklet samples remain in a rolling 65-second buffer. Live timing analyzes the latest 32 seconds for its two independent windows; the latest 60 seconds remain available for export. Save WAV exports the latest 60 seconds as mono PCM16. Native PCM WAV imports retain their timebase; other formats can be resampled by browser decoding.

The default uses tg’s own filters without an external bandpass. Custom mode adds the selected bandpass first. A Blackman-windowed sinc decimator limits analysis to 48 kHz or below in either mode. The capture rate, browser audio rate and tg rate are displayed separately. tg applies a 3 kHz high-pass, rectification and a 3 kHz low-pass to the envelope. The continuous STFT uses raw audio with the custom passband highlighted when enabled, 20 ms Hann windows and a 5 ms hop.

The tg engine chooses among 2, 4, 8 and 16-second analysis windows. Its valid flag controls whether the UI shows rate and beat error. The four-window convergence indicator is not a probability of correctness. A baseline needs at least 32 seconds, valid readings in separate 16-second input windows, convergence of at least three windows in each result, and rate disagreement no greater than 20 s/day. These baseline thresholds and the 300 s/day guidance cutoff are app choices, not Seiko service limits.

The adapter corrects the sample clock with the explicit sign: positive ppm increases measured rate. Correction is limited to the UI's ±5000 ppm range. The bundled tg waveform API returns a full oscillation period despite its header saying one beat; the adapter divides it by two. Real-WASM checks protect this conversion.

Amplitude comes from tg's resolved lift pulses and remains blank until the movement's lift angle is confirmed. The starting 53° value is unverified for this movement. Manual unlock/drop markers provide an optional alternative. Beat error remains an acoustic estimate. No automatic stud-holder adjustment is prescribed.

The timing strip uses time downward and early/late beat phase horizontally. Zero rate makes a vertical trace. Positive gain slopes left; loss slopes right. The phase wraps at the chosen width. Beat indices are tracked across updates so gross drift does not silently renumber beats. Live history accumulates after lock, up to 120 seconds. Imported recordings and demos are replayed through tg to recover actual beat positions across the take. No marks are fabricated. The stable demo has zero rate so its vertical tracks can be inspected.

Source changes cancel obsolete operations. Settings invalidate their earlier results. A capture gap restarts the take. Clipping blocks a baseline. Lost-lock values remain dimmed with their age; they never supply saving or adjustment guidance. Clear, source changes and timing-setting edits discard cached values. Capture gaps preserve them as stale within the same take. Saved baselines include engine, sample rates, clock correction and lift angle, and remain in localStorage. Demo readings stay labelled.

Validation:

```sh
node --test capture.test.mjs spectrum.test.mjs app-state.test.mjs dist/dsp.test.mjs dist/rate.test.mjs watch-engine.test.mjs timing-strip.test.mjs
```

The actual vendored WASM is checked against independent synthetic rates, beat error and pulse spacing, native 192 kHz capture, alias rejection, clock correction, clipping, noise, random transients, stopped-watch recordings and rate changes. UI checks cover automatic amplitude confirmation, baseline gates and source races. Real Scarlett/SM58 recordings were compared through unchanged tg and the selected input filters; they did not achieve a valid lock. Accuracy against a calibrated physical timegrapher remains unverified.

The wizard and wrapper use GPL version 2. See `LICENSE`. The local [credits page](dist/credits.html) includes upstream notices, the MIT filter licence and a source archive for the vendored tg project. No upstream branding is used in the interface.
