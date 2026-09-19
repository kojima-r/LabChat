import { CubismFramework, LogLevel, Option } from "@framework/live2dcubismframework";

// CubismFramework はプロセス内で一度だけ startUp する。
// （riken_live2d_controller/src/cubism/CubismRuntime.ts と同じ形）

let started = false;

export const CubismRuntime = {
  start(log: (msg: string) => void = console.log): void {
    if (started) return;
    const option = new Option();
    option.logFunction = log;
    option.loggingLevel = LogLevel.LogLevel_Warning;
    CubismFramework.startUp(option);
    CubismFramework.initialize();
    started = true;
  },
  get started(): boolean {
    return started;
  },
};
