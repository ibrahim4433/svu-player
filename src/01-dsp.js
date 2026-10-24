(function () {
  'use strict';
  const Dsp = {
    energy(samples, start, end) {
      let total = 0;
      for (let i = start; i < end; i++) {
        total += samples[i] * samples[i];
      }
      return total;
    },
    rms(samples, start, end) {
      let total = 0;
      for (let i = start; i < end; i += 4) {
        total += samples[i] * samples[i];
      }
      return Math.sqrt(total / Math.max(1, (end - start) / 4));
    },
    // Client-side studio voice enhancement:
    // 1. 120 Hz High-Pass Filter (removes low-frequency hum, AC rumble & plosives)
    // 2. Vocal Presence Boost (+5.5 dB around 2.5 kHz for speech intelligibility)
    // 3. Speech-Aware Smooth Envelope Noise Gate (suppresses background hiss between words)
    // 4. 2:1 Soft-Knee Speech Compressor + Loudness Normalization
    enhance(pcm, rate) {
      const n = pcm.length;
      if (!n) return new Int16Array(0);
      const sr = rate || 16000;
      const flt = new Float32Array(n);

      // Stage 1: 120 Hz High-Pass Filter (1st-order IIR)
      const rcHp = 1.0 / (2.0 * Math.PI * 120.0);
      const dt = 1.0 / sr;
      const alphaHp = rcHp / (rcHp + dt);
      let prevX = pcm[0] / 32768.0;
      let prevY = 0.0;
      for (let i = 0; i < n; i++) {
        const x = pcm[i] / 32768.0;
        const y = alphaHp * (prevY + x - prevX);
        prevX = x;
        prevY = y;
        flt[i] = y;
      }

      // Stage 2: Vocal Presence & Clarity Boost (Biquad Peaking EQ @ 2400 Hz, Q=1.0, +5.5 dB)
      const f0 = Math.min(2400.0, sr * 0.38);
      const A = Math.pow(10, 5.5 / 40);
      const w0 = (2 * Math.PI * f0) / sr;
      const cosW0 = Math.cos(w0);
      const alphaEq = Math.sin(w0) / (2.0 * 1.0);
      const b0 = 1 + alphaEq * A;
      const b1 = -2 * cosW0;
      const b2 = 1 - alphaEq * A;
      const a0 = 1 + alphaEq / A;
      const a1 = -2 * cosW0;
      const a2 = 1 - alphaEq / A;
      const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0;
      const na1 = a1 / a0, na2 = a2 / a0;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < n; i++) {
        const x = flt[i];
        const y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
        x2 = x1; x1 = x;
        y2 = y1; y1 = y;
        flt[i] = y;
      }

      // Stage 3: Speech-Aware Noise Floor & Smooth Envelope Gate
      // Ignore pure-silence windows (muted mic) when estimating background hiss
      const winSize = Math.max(64, Math.floor(sr * 0.05));
      const activeRms = [];
      for (let i = 0; i + winSize <= n; i += winSize) {
        let sum = 0;
        for (let j = i; j < i + winSize; j++) {
          sum += flt[j] * flt[j];
        }
        const r = Math.sqrt(sum / winSize);
        if (r > 0.0005) {
          activeRms.push(r);
        }
      }
      activeRms.sort((a, b) => a - b);
      const noiseFloor = activeRms.length
        ? activeRms[Math.floor(activeRms.length * 0.15)]
        : 0.002;
      const gateThresh = Math.min(0.04, Math.max(noiseFloor * 2.2, 0.003));
      const speechRef = activeRms.length
        ? activeRms[Math.floor(activeRms.length * 0.85)]
        : 0.15;

      // Makeup gain so quiet speech reaches a strong, clear studio level
      const targetRms = 0.22;
      const makeupGain = Math.min(4.5, Math.max(1.35, targetRms / Math.max(0.02, speechRef)));

      const attCoeff = Math.exp(-1.0 / (sr * 0.004)); // 4ms attack
      const relCoeff = Math.exp(-1.0 / (sr * 0.060)); // 60ms release
      let env = 0.0;
      const out = new Int16Array(n);

      // Stage 4: Envelope Gate + Soft-Knee Speech Compressor + Limiter
      for (let i = 0; i < n; i++) {
        const absX = Math.abs(flt[i]);
        env = absX > env
          ? attCoeff * env + (1 - attCoeff) * absX
          : relCoeff * env + (1 - relCoeff) * absX;

        // Smooth noise gate ratio
        let gateGain = 1.0;
        if (env < gateThresh) {
          const ratio = env / gateThresh;
          gateGain = ratio * ratio * 0.18; // reduce background hiss by ~15 dB
        }

        let s = flt[i] * gateGain * makeupGain;

        // Soft-knee compression above 0.45 to boost body without clipping
        const absS = Math.abs(s);
        if (absS > 0.45) {
          const compressed = 0.45 + (absS - 0.45) * 0.45;
          s = (s < 0 ? -1 : 1) * Math.tanh(compressed);
        }

        out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      }
      return out;
    }
  };
  globalThis.Dsp = Dsp;
})();
