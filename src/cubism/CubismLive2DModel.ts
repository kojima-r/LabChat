// Cubism SDK for Web 5 r.5 の Framework を直接使うモデルラッパ。
//
// pixi-live2d-display を使わない理由: 同梱の Framework が Core 6 の API 変更
// （renderOrders が drawables から model 直下へ移動）に追随しておらず、Core 6 が必要な
// moc3 version 6 のモデル（理研提供の Live2D_0730）と両立しない。詳細は CLAUDE.md。
//
// 再生の設計は riken_live2d_controller/src/cubism/Live2DModel.ts を踏襲した3層構成:
//   背景 (_idleManager)      … ベンダーの待機ループ。常時ループ再生
//   前景 (_motionManager)    … 形態遷移 / 感情ポーズ。stop-then-play で1本だけ。これが保持ポーズ
//   単発 (_actionManager)    … うなずき / あいさつ / 驚き。保持ポーズに重ねて、終わると戻る
// 前景だけ loadParameters()〜saveParameters() の間で更新し、背景・単発・まばたき・
// リップシンクは saveParameters() の後に重ねる。こうすると保持ポーズが汚れない。
//
// Framework は strict TS では通らないので型は any（src/cubism/framework.d.ts）。
// アプリ側に見せる API はこのファイルで型を付ける。

import { CubismUserModel } from "@framework/model/cubismusermodel";
import { CubismModelSettingJson } from "@framework/cubismmodelsettingjson";
import { CubismMatrix44 } from "@framework/math/cubismmatrix44";
import { CubismMotion } from "@framework/motion/cubismmotion";
import { CubismMotionManager } from "@framework/motion/cubismmotionmanager";
import { CubismExpressionMotion } from "@framework/motion/cubismexpressionmotion";
import { CubismExpressionMotionManager } from "@framework/motion/cubismexpressionmotionmanager";

/** ブレンドモード用シェーダの置き場所。Framework が実行時に fetch する（public/shaders/）。 */
const SHADER_PATH = "/shaders/";
/** startMotionPriority に渡す優先度。常に差し替えたいので最大。 */
const PRIORITY_FORCE = 3;

// ---- Framework 側（any）に最低限の型を付けるためのローカル型 ----

type CoreModel = {
  getParameterCount: () => number;
  getParameterId: (index: number) => unknown;
  getParameterValueByIndex: (index: number) => number;
  setParameterValueByIndex: (index: number, value: number) => void;
  addParameterValueByIndex: (index: number, value: number, weight?: number) => void;
  getParameterMinimumValue: (index: number) => number;
  getParameterMaximumValue: (index: number) => number;
  getCanvasWidth: () => number;
  getCanvasHeight: () => number;
  loadParameters: () => void;
  saveParameters: () => void;
  update: () => void;
};

type MotionManagerLike = {
  startMotionPriority: (motion: unknown, autoDelete: boolean, priority: number) => unknown;
  updateMotion: (model: CoreModel, deltaSeconds: number) => boolean;
  stopAllMotions: () => void;
  isFinished: () => boolean;
};

type ExpressionManagerLike = {
  startMotion: (motion: unknown, autoDelete: boolean) => unknown;
  updateMotion: (model: CoreModel, deltaSeconds: number) => boolean;
  stopAllMotions: () => void;
};

type MotionLike = {
  setLoop: (loop: boolean) => void;
  setLoopFadeIn: (loopFadeIn: boolean) => void;
  setEffectIds: (eyeBlinkIds: unknown[], lipSyncIds: unknown[]) => void;
};

type RendererLike = {
  setIsPremultipliedAlpha: (enable: boolean) => void;
  startUp: (gl: WebGL2RenderingContext) => void;
  bindTexture: (index: number, texture: WebGLTexture) => void;
  setMvpMatrix: (matrix: unknown) => void;
  setRenderState: (fbo: WebGLFramebuffer | null, viewport: number[]) => void;
  drawModel: (shaderPath?: string) => void;
};

/** CubismUserModel のうち、こちらから触る分だけ型を付けた形。 */
type UserModelLike = {
  loadModel: (buffer: ArrayBuffer, shouldCheckMocConsistency?: boolean) => void;
  loadPhysics: (buffer: ArrayBuffer, size: number) => void;
  loadPose: (buffer: ArrayBuffer, size: number) => void;
  createRenderer: (width: number, height: number) => void;
  getRenderer: () => RendererLike | null;
  getModel: () => CoreModel | null;
  getModelMatrix: () => unknown;
  /** protected だが Framework は any 扱いなので参照できる */
  _physics: { evaluate: (model: CoreModel, deltaSeconds: number) => void } | null;
  _pose: { updateParameters: (model: CoreModel, deltaSeconds: number) => void } | null;
};

/** model3.json を読んだ設定オブジェクト（必要なメソッドだけ） */
type ModelSettingLike = {
  getModelFileName: () => string;
  getTextureCount: () => number;
  getTextureFileName: (index: number) => string;
  getPhysicsFileName: () => string;
  getPoseFileName: () => string;
  getMotionGroupCount: () => number;
  getMotionGroupName: (index: number) => string;
  getMotionCount: (group: string) => number;
  getMotionFileName: (group: string, index: number) => string;
  getExpressionCount: () => number;
  getExpressionName: (index: number) => string;
  getExpressionFileName: (index: number) => string;
};

export type LoadOptions = {
  /** model3.json の URL */
  settingsUrl: string;
  /** ベンダーの model3.json をそのまま使えない場合のインメモリ補正 */
  patchSettings?: (json: Record<string, unknown>) => Record<string, unknown>;
  /** まばたきを自前で駆動するか（EyeBlink グループが空のモデル向け） */
  manualBlink: boolean;
  log?: (msg: string) => void;
  warn?: (msg: string, ...rest: unknown[]) => void;
};

/** 画面への収め方。scale は「キャンバスに収まる大きさ」を 1 とした倍率、offset は NDC。 */
export type ViewTransform = { scale: number; offsetX: number; offsetY: number };

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.arrayBuffer();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image ${url}`));
    img.src = url;
  });
}

function createGlTexture(gl: WebGL2RenderingContext, img: HTMLImageElement): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/** Cubism の CubismId#getString() は環境により {s} かプレーン文字列を返すので吸収する。 */
function idToString(id: unknown): string {
  const s = (id as { getString?: () => unknown }).getString?.();
  if (typeof s === "string") return s;
  const inner = (s as { s?: unknown } | undefined)?.s;
  return typeof inner === "string" ? inner : String(s);
}

/** 前景モーションのレイヤー。単発が終わったら保持ポーズへ戻すため区別する。 */
export type MotionLayer = "foreground" | "action";

export class CubismLive2DModel {
  private readonly gl: WebGL2RenderingContext;
  private readonly user: UserModelLike;
  private readonly settings: ModelSettingLike;
  private readonly baseUrl: string;
  private readonly log: (msg: string) => void;
  private readonly warn: (msg: string, ...rest: unknown[]) => void;

  // 3層それぞれ専用のマネージャ。ひとつに混ぜてはいけない
  private readonly foreground: MotionManagerLike = new CubismMotionManager();
  private readonly idle: MotionManagerLike = new CubismMotionManager();
  private readonly action: MotionManagerLike = new CubismMotionManager();
  private readonly expressions: ExpressionManagerLike = new CubismExpressionMotionManager();

  private readonly motionCache = new Map<string, MotionLike>();
  private readonly expressionCache = new Map<string, unknown>();
  private readonly expressionFiles = new Map<string, string>();

  private currentForeground: string | null = null;
  private currentIdle: string | null = null;
  private currentAction: string | null = null;
  private currentExpression: string | null = null;

  // まばたき。ベンダーがまばたきモーションを持たないモデル用に自前で駆動する
  // （riken_live2d_controller の eyeOpenness() と同じカーブ）
  private readonly manualBlink: boolean;
  private blinkClock = 0;
  private nextBlink = 1.5;
  private blinkInterval = 3.5;
  private eyeLIndex = -1;
  private eyeRIndex = -1;

  // マウス追従の視線。pixi 時代と同じく「加算」で当てるのでモーションの首振りを消さない
  private gazeIndices: Record<string, number> = {};
  private gazeX = 0;
  private gazeY = 0;
  private gazeActive = false;

  // リップシンク。saveParameters() の後に重ねるので保持ポーズを汚さない
  private mouthOpenIndex = -1;
  private mouthFormIndex = -1;
  private lipSyncOpen = 0;
  private lipSyncForm: number | null = null;
  private lipSyncActive = false;

  private constructor(
    gl: WebGL2RenderingContext,
    user: UserModelLike,
    settings: ModelSettingLike,
    baseUrl: string,
    opts: LoadOptions,
  ) {
    this.gl = gl;
    this.user = user;
    this.settings = settings;
    this.baseUrl = baseUrl;
    this.manualBlink = opts.manualBlink;
    this.log = opts.log ?? (() => {});
    this.warn = opts.warn ?? (() => {});
  }

  static async load(gl: WebGL2RenderingContext, opts: LoadOptions): Promise<CubismLive2DModel> {
    const log = opts.log ?? (() => {});
    const baseUrl = opts.settingsUrl.replace(/[^/]*$/, "");

    // 1. model3.json（必要ならメモリ上で補正してから Framework へ渡す）
    const res = await fetch(opts.settingsUrl);
    if (!res.ok) throw new Error(`Failed to fetch ${opts.settingsUrl}: ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    const effective = opts.patchSettings ? opts.patchSettings(json) : json;
    const bytes = new TextEncoder().encode(JSON.stringify(effective));
    const settings = new CubismModelSettingJson(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      bytes.byteLength,
    ) as ModelSettingLike;
    log(`settings 読み込み: ${opts.settingsUrl}`);

    const user = new CubismUserModel() as UserModelLike;
    const model = new CubismLive2DModel(gl, user, settings, baseUrl, opts);

    // 2. moc3 → モデル
    const mocFile = settings.getModelFileName();
    const mocBuffer = await fetchArrayBuffer(baseUrl + mocFile);
    log(`moc3 取得: ${mocFile} (${(mocBuffer.byteLength / 1048576).toFixed(1)}MB)`);
    user.loadModel(mocBuffer, false);
    if (!user.getModel()) {
      // Core が moc3 のフォーマット版に対応していないとここに来る
      throw new Error(
        `moc3 からモデルを構築できませんでした (${mocFile})。` +
          `Cubism Core が moc3 のフォーマット版に対応しているか確認してください。`,
      );
    }

    // 3. レンダラ + テクスチャ
    user.createRenderer(gl.drawingBufferWidth || 800, gl.drawingBufferHeight || 600);
    const renderer = user.getRenderer();
    if (!renderer) throw new Error("createRenderer に失敗しました");
    renderer.setIsPremultipliedAlpha(true);
    renderer.startUp(gl);
    const textureCount = settings.getTextureCount();
    for (let i = 0; i < textureCount; i++) {
      const file = settings.getTextureFileName(i);
      const img = await loadImage(baseUrl + file);
      renderer.bindTexture(i, createGlTexture(gl, img));
    }
    log(`テクスチャ ${textureCount}件 を読み込みました`);

    // 4. 物理演算 / パーツ切替（あるモデルだけ。Haru は両方持っている）
    const physicsFile = settings.getPhysicsFileName();
    if (physicsFile) {
      const buf = await fetchArrayBuffer(baseUrl + physicsFile);
      user.loadPhysics(buf, buf.byteLength);
      log(`物理演算: ${physicsFile}`);
    }
    const poseFile = settings.getPoseFileName();
    if (poseFile) {
      const buf = await fetchArrayBuffer(baseUrl + poseFile);
      user.loadPose(buf, buf.byteLength);
      log(`ポーズ: ${poseFile}`);
    }

    // 5. 表情ファイルの一覧（実体は使うときに遅延読み込み）
    for (let i = 0; i < settings.getExpressionCount(); i++) {
      model.expressionFiles.set(settings.getExpressionName(i), settings.getExpressionFileName(i));
    }

    // 6. 初期姿勢を保存し、直接書き込むパラメータの index を引いておく
    const core = user.getModel()!;
    core.saveParameters();
    model.eyeLIndex = model.findParamIndex("ParamEyeLOpen");
    model.eyeRIndex = model.findParamIndex("ParamEyeROpen");
    model.mouthOpenIndex = model.findParamIndex("ParamMouthOpenY");
    model.mouthFormIndex = model.findParamIndex("ParamMouthForm");
    for (const id of ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamEyeBallX", "ParamEyeBallY", "ParamBodyAngleX"]) {
      model.gazeIndices[id] = model.findParamIndex(id);
    }

    // 直接書き込むパラメータが見つからないと、リップシンクもまばたきも「何も起きない」
    // という無言の失敗になる。必ず結果を出す。
    const driven: Record<string, number> = {
      ParamMouthOpenY: model.mouthOpenIndex,
      ParamMouthForm: model.mouthFormIndex,
      ParamEyeLOpen: model.eyeLIndex,
      ParamEyeROpen: model.eyeRIndex,
    };
    log(
      "直接制御するパラメータの索引: " +
        Object.entries(driven)
          .map(([id, i]) => `${id}=${i}`)
          .join(" "),
    );
    const missing = Object.entries(driven).filter(([, i]) => i < 0).map(([id]) => id);
    if (missing.length) {
      (opts.warn ?? (() => {}))(
        `このモデルに無いパラメータ: ${missing.join(", ")}` +
          `（該当する制御は効きません。モデルのパラメータ一覧は window.__live2d.getModel().getParameters() で確認できます）`,
      );
    }
    return model;
  }

  // ---- 診断用 ----

  get motionGroups(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.settings.getMotionGroupCount(); i++) {
      out.push(this.settings.getMotionGroupName(i));
    }
    return out;
  }

  get expressionNames(): string[] {
    return [...this.expressionFiles.keys()];
  }

  get canvasSize(): { width: number; height: number } {
    const core = this.user.getModel();
    return { width: core?.getCanvasWidth() ?? 0, height: core?.getCanvasHeight() ?? 0 };
  }

  get playing(): { foreground: string | null; idle: string | null; action: string | null; expression: string | null } {
    return {
      foreground: this.currentForeground,
      idle: this.currentIdle,
      action: this.currentAction,
      expression: this.currentExpression,
    };
  }

  private findParamIndex(id: string): number {
    const core = this.user.getModel();
    if (!core) return -1;
    for (let i = 0; i < core.getParameterCount(); i++) {
      if (idToString(core.getParameterId(i)) === id) return i;
    }
    return -1;
  }

  /** モーションファイルを取得して CubismMotion を作る（グループ名+index で1本を指す）。 */
  private async getMotion(group: string, index: number): Promise<MotionLike | null> {
    const key = `${group}#${index}`;
    const cached = this.motionCache.get(key);
    if (cached) return cached;
    if (this.settings.getMotionCount(group) <= index) {
      this.warn(`モーションがありません: ${group}[${index}]（グループ: ${this.motionGroups.join(", ")}）`);
      return null;
    }
    const file = this.settings.getMotionFileName(group, index);
    if (!file) {
      this.warn(`モーションのファイル名が空です: ${group}[${index}]`);
      return null;
    }
    const buf = await fetchArrayBuffer(this.baseUrl + file);
    const motion = CubismMotion.create(buf, buf.byteLength) as MotionLike | null;
    if (!motion) {
      this.warn(`CubismMotion.create に失敗: ${file}`);
      return null;
    }
    // これを呼ばないと eyeblink/lipsync の id 配列が null のままで初回 update で落ちる。
    // 対象モデルは EyeBlink / LipSync グループが空なので空配列が正しい（まばたきと
    // リップシンクはこちらで重ねる）。
    motion.setEffectIds([], []);
    this.motionCache.set(key, motion);
    return motion;
  }

  /**
   * 前景（保持ポーズ）または単発アクションとしてモーションを再生する。
   * 前景は stop-then-play で常に1本だけ。ループ指定したものだけ setLoop(true) にし、
   * それ以外は最終フレームで止まる（= 保持ポーズ）。フェード時間はベンダーの値のまま。
   */
  async playMotion(
    group: string,
    index: number,
    opts: { layer: MotionLayer; loop?: boolean } = { layer: "foreground" },
  ): Promise<boolean> {
    const motion = await this.getMotion(group, index);
    if (!motion) return false;
    const loop = opts.loop ?? false;
    motion.setLoop(loop);
    // ループのたびにフェードインが再実行されるとパラメータが一瞬ベースラインへ落ちて
    // カクつくので切る（デモが待機ループで踏んだのと同じ問題）。
    if (loop) motion.setLoopFadeIn(false);

    if (opts.layer === "action") {
      this.action.stopAllMotions();
      this.action.startMotionPriority(motion, false, PRIORITY_FORCE);
      this.currentAction = `${group}[${index}]`;
      this.log(`単発アクション: ${group}[${index}]`);
      return true;
    }
    // 新しい保持ポーズは進行中の単発アクションを打ち切る
    this.action.stopAllMotions();
    this.currentAction = null;
    this.foreground.stopAllMotions();
    this.foreground.startMotionPriority(motion, false, PRIORITY_FORCE);
    this.currentForeground = `${group}[${index}]`;
    this.log(`前景（保持ポーズ）: ${group}[${index}]${loop ? " ループ" : ""}`);
    return true;
  }

  /** 背景の待機ループ。前景の下で回り続ける（マネージャを分けているので混ざらない）。 */
  async playIdle(group: string, index = 0): Promise<boolean> {
    const key = `${group}[${index}]`;
    if (this.currentIdle === key) return true;
    const motion = await this.getMotion(group, index);
    if (!motion) return false;
    motion.setLoop(true);
    motion.setLoopFadeIn(false);
    this.idle.stopAllMotions();
    this.idle.startMotionPriority(motion, false, PRIORITY_FORCE);
    this.currentIdle = key;
    this.log(`背景の待機ループ: ${key}`);
    return true;
  }

  stopIdle(): void {
    this.idle.stopAllMotions();
    this.currentIdle = null;
  }

  /** 単発アクションが終わったか（終わったら保持ポーズへ戻す判断に使う）。 */
  isActionFinished(): boolean {
    return this.currentAction === null || this.action.isFinished();
  }

  /** .exp3.json による表情。モーションとは独立したレイヤーとして重なる。 */
  async setExpression(name: string): Promise<boolean> {
    const file = this.expressionFiles.get(name);
    if (!file) {
      this.warn(`表情がありません: ${name}（利用可能: ${this.expressionNames.join(", ") || "なし"}）`);
      return false;
    }
    let expression = this.expressionCache.get(name);
    if (!expression) {
      const buf = await fetchArrayBuffer(this.baseUrl + file);
      expression = CubismExpressionMotion.create(buf, buf.byteLength);
      if (!expression) {
        this.warn(`CubismExpressionMotion.create に失敗: ${file}`);
        return false;
      }
      this.expressionCache.set(name, expression);
    }
    this.expressions.stopAllMotions();
    this.expressions.startMotion(expression, false);
    this.currentExpression = name;
    this.log(`表情 (exp3): ${name} (${file})`);
    return true;
  }

  /** 表情を外す（素の顔に戻す）。 */
  resetExpression(): void {
    this.expressions.stopAllMotions();
    this.currentExpression = null;
  }

  /**
   * 音声から求めた口の形。open は 0..1。
   * form は -1..1、null なら ParamMouthForm に触らない（音量のみのリップシンク時は
   * モーションが作った口の形を残したいので null を渡す）。
   */
  setLipSync(open: number, form: number | null = null): void {
    this.lipSyncActive = true;
    this.lipSyncOpen = open < 0 ? 0 : open > 1 ? 1 : open;
    this.lipSyncForm = form === null ? null : form < -1 ? -1 : form > 1 ? 1 : form;
  }

  /**
   * マウス追従の視線。x, y はともに -1..1（キャンバス中心が 0）。
   * pixi-live2d-display の updateFocus と同じく加算で当てるので、
   * モーションが動かしている首や目を打ち消さない。
   */
  setGaze(x: number, y: number): void {
    this.gazeActive = true;
    this.gazeX = x < -1 ? -1 : x > 1 ? 1 : x;
    this.gazeY = y < -1 ? -1 : y > 1 ? 1 : y;
  }

  clearGaze(): void {
    this.gazeActive = false;
    this.gazeX = 0;
    this.gazeY = 0;
  }

  /** リップシンクを切る（口の制御をモーションへ返す）。 */
  clearLipSync(): void {
    this.lipSyncActive = false;
    this.lipSyncOpen = 0;
    this.lipSyncForm = null;
  }

  setBlinkInterval(seconds: number): void {
    this.blinkInterval = Math.max(0.2, seconds);
  }

  /**
   * まばたきの目の開き（1 開 → 0 閉）。1回終わるたびに次を 2〜6 秒後へ入れ直す。
   * riken_live2d_controller の eyeOpenness() と同じカーブ。
   */
  private eyeOpenness(): number {
    const t = this.blinkClock - this.nextBlink;
    if (t < 0) return 1; // 次のまばたきを待っている
    const CLOSE = 0.06;
    const HOLD = 0.04;
    const OPEN = 0.12;
    if (t < CLOSE) return 1 - t / CLOSE;
    if (t < CLOSE + HOLD) return 0;
    if (t < CLOSE + HOLD + OPEN) return (t - CLOSE - HOLD) / OPEN;
    this.nextBlink = this.blinkClock + this.blinkInterval * (0.7 + Math.random() * 0.6); // ±30% ゆらぎ
    return 1;
  }

  /**
   * 1フレーム進める。
   *
   * モーションは目標ポーズだけをキーフレームに持ち、現在のポーズからそこへ補間される
   * （ベンダーの言う「自動補完」）。なので毎フレーム保持ポーズをベースラインとして
   * 復元し、デフォルト姿勢へ戻さない。前景だけを save/load の間で更新し、他は後に重ねる。
   */
  update(deltaSeconds: number): void {
    const core = this.user.getModel();
    if (!core) return;

    core.loadParameters(); // 前フレームの保持ポーズを復元
    const foregroundUpdated = this.foreground.updateMotion(core, deltaSeconds);
    core.saveParameters(); // 保持ポーズを次フレームへ引き継ぐ

    // ここから下は saveParameters() の後なので、保持ポーズを汚さない
    // 表情 (exp3) は独立レイヤー
    this.expressions.updateMotion(core, deltaSeconds);
    // 背景の待機ループ
    if (this.currentIdle) this.idle.updateMotion(core, deltaSeconds);
    // 単発アクション。終わったらその場で落として保持ポーズへ戻す
    if (this.currentAction) {
      this.action.updateMotion(core, deltaSeconds);
      if (this.action.isFinished()) this.currentAction = null;
    }

    // まばたき。前景モーションが動いている間はモーション側に目を任せる
    // （Haru のモーションは目を動かすため。理研モデルはどのモーションも目に触れない）
    this.blinkClock += deltaSeconds;
    if (this.manualBlink && !foregroundUpdated && this.eyeLIndex >= 0) {
      const open = this.eyeOpenness();
      core.setParameterValueByIndex(this.eyeLIndex, open);
      if (this.eyeRIndex >= 0) core.setParameterValueByIndex(this.eyeRIndex, open);
    }

    // マウス追従の視線（加算）
    if (this.gazeActive) {
      const add = (id: string, value: number) => {
        const i = this.gazeIndices[id];
        if (i >= 0) core.addParameterValueByIndex(i, value);
      };
      add("ParamAngleX", this.gazeX * 30);
      add("ParamAngleY", this.gazeY * 30);
      add("ParamAngleZ", this.gazeX * this.gazeY * -30);
      add("ParamEyeBallX", this.gazeX);
      add("ParamEyeBallY", this.gazeY);
      add("ParamBodyAngleX", this.gazeX * 10);
    }

    // リップシンク。鳴っている間は口をこちらで持つ
    if (this.lipSyncActive) {
      if (this.mouthOpenIndex >= 0) {
        core.setParameterValueByIndex(this.mouthOpenIndex, this.lipSyncOpen);
      }
      if (this.mouthFormIndex >= 0 && this.lipSyncForm !== null) {
        core.setParameterValueByIndex(this.mouthFormIndex, this.lipSyncForm);
      }
    }

    // 物理演算とパーツ切替はすべてのパラメータが決まった後
    this.user._physics?.evaluate(core, deltaSeconds);
    this.user._pose?.updateParameters(core, deltaSeconds);

    core.update();
  }

  /**
   * 描画。キャンバスのアスペクトを補正して収め、view で倍率と位置を調整する。
   * （riken_live2d_controller/src/cubism/Live2DModel.ts の draw() に view を足したもの）
   */
  draw(canvasWidth: number, canvasHeight: number, view: ViewTransform): void {
    const renderer = this.user.getRenderer();
    if (!renderer) return;
    const projection = new CubismMatrix44() as unknown as {
      scale: (x: number, y: number) => void;
      scaleRelative: (x: number, y: number) => void;
      translateRelative: (x: number, y: number) => void;
      multiplyByMatrix: (m: unknown) => void;
    };
    if (canvasWidth > canvasHeight) {
      projection.scale(canvasHeight / canvasWidth, 1.0);
    } else {
      projection.scale(1.0, canvasWidth / canvasHeight);
    }
    projection.scaleRelative(view.scale, view.scale);
    projection.translateRelative(view.offsetX, view.offsetY);
    projection.multiplyByMatrix(this.user.getModelMatrix());
    renderer.setMvpMatrix(projection);
    const fbo = this.gl.getParameter(this.gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    renderer.setRenderState(fbo, [0, 0, canvasWidth, canvasHeight]);
    renderer.drawModel(SHADER_PATH);
  }

  /** 口・目のいまの状態（診断用）。value は core から読み戻した実値。 */
  get mouthState(): {
    active: boolean;
    open: number;
    form: number | null;
    openIndex: number;
    formIndex: number;
    openValue: number | null;
    formValue: number | null;
  } {
    const core = this.user.getModel();
    return {
      active: this.lipSyncActive,
      open: this.lipSyncOpen,
      form: this.lipSyncForm,
      openIndex: this.mouthOpenIndex,
      formIndex: this.mouthFormIndex,
      openValue:
        core && this.mouthOpenIndex >= 0 ? core.getParameterValueByIndex(this.mouthOpenIndex) : null,
      formValue:
        core && this.mouthFormIndex >= 0 ? core.getParameterValueByIndex(this.mouthFormIndex) : null,
    };
  }

  /** 全パラメータの現在値（デバッグ用）。 */
  getParameters(): { id: string; value: number; min: number; max: number }[] {
    const core = this.user.getModel();
    if (!core) return [];
    const out: { id: string; value: number; min: number; max: number }[] = [];
    for (let i = 0; i < core.getParameterCount(); i++) {
      out.push({
        id: idToString(core.getParameterId(i)),
        value: core.getParameterValueByIndex(i),
        min: core.getParameterMinimumValue(i),
        max: core.getParameterMaximumValue(i),
      });
    }
    return out;
  }

  release(): void {
    this.foreground.stopAllMotions();
    this.idle.stopAllMotions();
    this.action.stopAllMotions();
    this.expressions.stopAllMotions();
    this.motionCache.clear();
    this.expressionCache.clear();
    const releasable = this.user as unknown as { release?: () => void };
    try {
      releasable.release?.();
    } catch {
      /* 破棄の失敗は無視 */
    }
  }
}
