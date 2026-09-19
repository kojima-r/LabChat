import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Cubism SDK for Web 5 r.5。Live2D 公式配布物を手置きしたものでリポジトリには入っていない
// （CLAUDE.md の hand-placed assets 参照）。置き場所を変えたらこの1行だけ直せばよい。
// Framework のソースを直接バンドルする（同梱 Framework が Core 6 に追随していない
// pixi-live2d-display は使わない）。
const CUBISM_SDK = resolve(rootDir, "riken_live2d_controller/CubismSdkForWeb-5-r.5");

// Framework から実際に import しているもの。これを事前バンドルさせると
// dev で 44 個の個別モジュールを配信する代わりに 1 ファイルで済む。
const FRAMEWORK_ENTRIES = [
  "@framework/live2dcubismframework",
  "@framework/cubismmodelsettingjson",
  "@framework/math/cubismmatrix44",
  "@framework/model/cubismusermodel",
  "@framework/motion/cubismmotion",
  "@framework/motion/cubismmotionmanager",
  "@framework/motion/cubismexpressionmotion",
  "@framework/motion/cubismexpressionmotionmanager",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@framework": resolve(CUBISM_SDK, "Framework/src") },
  },
  optimizeDeps: {
    // SDK の Framework は node_modules の外のソースなので、既定では事前バンドルされず
    // dev で 1ファイルずつ配信されてしまう（44 リクエスト / 1.7MB）。明示して束ねる。
    include: FRAMEWORK_ENTRIES,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
