// SDK 5 r.5 の Framework ソースは strict TS では通らない（ベンダー側の既知事情。
// riken_live2d_controller/CLAUDE.md も "tsconfig intentionally has no strict" と書いている）。
// アプリ本体の strict を落としたくないので、Framework は型なし(any)として扱い、
// 実体解決は vite.config.ts の @framework エイリアスに任せる。
// アプリ側のコードは src/cubism/ の薄いラッパを通すので、型はそこで付ける。
declare module "@framework/*";
