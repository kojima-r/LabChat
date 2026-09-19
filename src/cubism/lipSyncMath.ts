// 音量→口の開きの算出。riken_live2d_controller/src/audio/lipSyncMath.ts をそのまま持ってきたもの
// （あちらは純粋関数として単体テストされている）。

/** 口が全開 (openness = 1) になる RMS。音声の RMS はおおむね 0.15 を超えないので、
 *  通常の発話が 0..1 のほぼ全域に収まる。 */
export const OPENNESS_REF = 0.15;

/** 1フレームで前回値から目標値へ寄せる割合。小さいほど滑らか（遅れる）、大きいほど機敏（震える）。 */
export const OPENNESS_SMOOTHING = 0.5;

/** PCM 1フレーム（各サンプル -1..1）の二乗平均平方根。 */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** RMS を 0..1 の開き具合へ正規化（クランプ付き）。 */
export function opennessFromRms(rmsValue: number, ref: number = OPENNESS_REF): number {
  if (ref <= 0) return 0;
  const v = rmsValue / ref;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** prev を target へ factor (0..1) だけ寄せる。 */
export function smoothOpenness(
  prev: number,
  target: number,
  factor: number = OPENNESS_SMOOTHING,
): number {
  return prev + (target - prev) * factor;
}
