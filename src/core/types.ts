/**
 * Wire types of the Viggle Scene API (`https://apis.viggle.ai/v1/scenes/*`),
 * plus `ViggleScene`, the scene as this SDK keeps it.
 *
 * THE API KEEPS NO SCENE. A scene there is an ordered list of BATCH IDS (the
 * images it was reconstructed from) that the CALLER holds, under a
 * `sessionId` the caller chooses. Every call carries the whole list; each
 * answers with one new batch id and a splat built from all of them. So the
 * state lives here, in `ViggleScene`, and is plain JSON - store it to reopen
 * or expand a scene later.
 */

export type Vec3Tuple = [number, number, number];

/** A 4x4 camera-to-world matrix, OpenCV convention (right, DOWN, forward), last row [0,0,0,1]. */
export type C2W = number[][];

/**
 * A camera pose in THE SCENE FILE'S OWN FRAME: the provider's units, origin at
 * the panorama's capture point, Y down. `SceneRenderer.getPose()` returns one;
 * `poseToC2W` turns it into the matrix the API takes.
 */
export interface ScenePose {
  position: Vec3Tuple;
  forward: Vec3Tuple;
}

/**
 * A camera as angles, in degrees, in the same frame as `ScenePose`: easier to
 * write by hand (or from an agent) than a forward vector.
 *
 * `yaw` turns right from the panorama's front: 0 front (+Z), 90 right (+X),
 * 180 back, -90 / 270 left. `pitch` looks up when positive, down when
 * negative (-90..90). The camera is always level - there is no roll.
 */
export interface CameraAngles {
  /** Where the camera stands. Default the panorama's capture point, `[0, 0, 0]`. */
  position?: Vec3Tuple;
  yaw: number;
  /** Default 0, the horizon. */
  pitch?: number;
}

/** Any of the three ways to give a camera: a pose, angles, or the 4x4 matrix itself. */
export type CameraInput = ScenePose | CameraAngles | C2W;

// ── Wire ────────────────────────────────────────────────────────────────────

/** A pre-signed GET. Expires about three hours after the call that returned it. */
export interface SceneDownload {
  url: string;
}

export interface SceneBatchView {
  index: number;
  url: string;
  c2w: C2W;
  /** `[fx, fy, cx, cy]`, normalised by the image edge. */
  intrinsic: number[];
}

export interface SceneBatch {
  batchId: string;
  createdAt: number;
  /** `initial`: a panorama's six cube faces. `generated`: what one generate added. */
  kind: 'initial' | 'generated' | (string & {});
  views: SceneBatchView[];
  manifest?: SceneDownload | null;
}

export type SceneOperation = 'pano' | 'custom-pano' | 'reconstruct' | 'generate';
/** `queued` and `processing` are still running; the other three are final. */
export type SceneTaskStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled';
export type SceneProjection = 'perspective' | 'pano';
/**
 * Panorama quality. `low` is the API's default. (`fast` appears in older
 * descriptions of the API; `apis.viggle.ai` refuses it.)
 */
export type SceneQuality = 'low' | 'medium' | 'high';

export interface SceneResult {
  operation: SceneOperation;
  sessionId: string;
  /** The batch this call added; null for `reconstruct`, which adds none. */
  outputBatch: SceneBatch | null;
  /** The reconstruction, built from every batch sent plus the new one. */
  spz: SceneDownload;
  /** The generated view (`generate` only). */
  preview: SceneDownload | null;
  /** The panorama used or produced (`pano` only). */
  panorama: SceneDownload | null;
  referenceViewCount: number;
  newViewCount: number;
  seconds: Record<string, number>;
}

/** What every submit returns at once, and what a poll returns: the same envelope. */
export interface SceneTask {
  /** `scn_<runId>.<sessionId>`. */
  id: string;
  sessionId: string;
  operation: SceneOperation;
  status: SceneTaskStatus;
  createdAt: number;
  completedAt: number | null;
  /** Set only when `status` is `ready`. */
  result: SceneResult | null;
  /** Set only when `status` is `failed`. */
  error: SceneApiErrorBody | null;
  /** Credits the task was charged (6 for a `low` panorama). */
  credits?: number;
}

/** The API's error envelope, on a refused request and on a failed task alike. */
export interface SceneApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  remediation?: { action?: string; retry_after_ms?: number | null };
  request_id?: string;
  retryable?: boolean;
}

// ── Requests ────────────────────────────────────────────────────────────────

/**
 * An image's bytes as base64 - what a tool call or a JSON payload can carry.
 * Sent as a file, like a `Blob`.
 */
export interface Base64Image {
  /** Plain base64, no `data:` prefix. */
  base64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** File name sent with it. Default `reference-<n>` / `panorama` plus the type's extension. */
  name?: string;
}

/**
 * An image the API should read:
 * - an http(s) URL the API downloads itself;
 * - a `data:image/...;base64,...` URL, or a `Base64Image`, uploaded as a file;
 * - a `Blob` / `File`, uploaded as is.
 */
export type ImageInput = string | Blob | Base64Image;

/** 创建场景 - `POST /v1/scenes/pano`. A prompt (with optional reference images) OR a panorama. */
export interface CreateSceneInput {
  /** Defaults to a fresh random id. 1-128 of `[A-Za-z0-9_-]`. */
  sessionId?: string;
  /** 1 to 1000 characters. */
  prompt?: string;
  /**
   * Up to 8, in order. JPEG / PNG / WebP, 36 MP each, 50 MiB in all. All URLs
   * (sent as JSON) or all files (sent as multipart), not a mix.
   */
  referenceImages?: ImageInput[];
  /** Default `low` upstream. */
  quality?: SceneQuality;
  /** A finished 2:1 equirectangular panorama. Excludes the three above. */
  panorama?: ImageInput;
  /** A signed PUT URL the splat is written to instead of the API's own storage. */
  spzOutputUrl?: string;
}

/** 从自定义全景图创建场景 - `POST /v1/scenes/custom-pano`: a panorama placed at a pose. */
export interface CreateSceneFromPanoramaInput {
  sessionId?: string;
  panorama: ImageInput;
  /** Where the panorama was captured, and which way its centre faces. Default: identity (the scene's own origin). */
  pose?: CameraInput;
  spzOutputUrl?: string;
}

/** 生成场景视图 - `POST /v1/scenes/generate`: one more view, and a rebuild with it. */
export interface GenerateViewInput {
  sessionId: string;
  /** Every batch of the scene, initial first. */
  referenceBatchIds: string[];
  /** The camera of the view to generate. */
  pose: CameraInput;
  /** Default `perspective` (one image). `pano` adds six. */
  projection?: SceneProjection;
  /** 20-140 degrees, perspective only. */
  fov?: number;
  seed?: number;
  spzOutputUrl?: string;
}

/** 重建场景 - `POST /v1/scenes/reconstruct`: rebuild from a batch list, adding nothing. */
export interface ReconstructInput {
  sessionId: string;
  referenceBatchIds: string[];
  spzOutputUrl?: string;
}

// ── The scene as this SDK keeps it ─────────────────────────────────────────

/** One state of a scene: what a task produced. */
export interface SceneVersion {
  taskId: string;
  operation: SceneOperation;
  /** The batch list this version was built from, in order. */
  batchIds: string[];
  /** The splat. Signed, expires ~3 h after it was read: see `refreshScene`. */
  splatUrl: string;
  previewUrl?: string | null;
  panoramaUrl?: string | null;
  /** For an expand: the camera it was generated from. */
  pose?: ScenePose | null;
  /**
   * The batch this version added - its images and the camera of each - or
   * null when it added none (a rebuild). Its URLs are signed like `splatUrl`.
   */
  batch?: SceneBatch | null;
  /** Images the splat was built from. The API takes at most 40 (`LIMITS.imagesPerScene`). */
  viewCount?: number;
  createdAt: number;
}

/** A scene: its session and its history. The last version is the current one. Plain JSON. */
export interface ViggleScene {
  sessionId: string;
  versions: SceneVersion[];
}
