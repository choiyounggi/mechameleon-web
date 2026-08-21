import { z } from 'zod';

// ---- Phases & core domain types ------------------------------------------

export type Phase = 'lobby' | 'hide' | 'seek' | 'result';

export type PartKey = 'head' | 'torso' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

/** One brush stroke, in stickman-local coordinates (feet-center origin, unscaled). */
export interface StickmanStroke {
  color: string; // '#rrggbb'
  size: number; // brush diameter in local px
  points: Array<{ x: number; y: number }>;
}

export interface StickmanState {
  x: number;
  y: number;
  scale: number;
  strokes: StickmanStroke[]; // painted over a white base body, clipped to the silhouette
}

export interface Background {
  imageUrl: string;
  width: number;
  height: number;
}

export interface PlayerPublic {
  id: string;
  nickname: string;
  isHost: boolean;
}

export interface RoomStatePublic {
  code: string;
  name: string;
  isPrivate: boolean;
  phase: Phase;
  players: PlayerPublic[];
  background: Background | null;
  endsAt: number | null;
  /** Host-configured hider count for the next round; null = auto (floor(n/2)). */
  hiderCount: number | null;
}

/** One hider's live stickman, broadcast at `phase:seek` so seekers can render every hider. */
export interface SeekStickman {
  playerId: string;
  nickname: string;
  stickman: StickmanState;
}

/** One row of the public room list (lobby browser). */
export interface RoomSummary {
  code: string;
  name: string;
  isPrivate: boolean;
  playerCount: number;
  maxPlayers: number;
  phase: Phase;
}

export type Winner = 'hider' | 'seekers';

// ---- Timer / room constants (D8, D13, D6) ----------------------------------

export const HIDE_MS = 60_000;
export const SEEK_MS = 120_000;
export const RESULT_MS = 10_000;
export const LOCKOUT_MS = 3_000;
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
export const IMAGE_WIDTH = 1440;
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 2;

// Room code alphabet (D12): uppercase A-Z + digits, minus confusable chars 0/O/1/I/L.
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

// ---- Error contract (D10) --------------------------------------------------

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'NOT_HOST'
  | 'BAD_PHASE'
  | 'NOT_HIDER'
  | 'NOT_SEEKER'
  | 'LOCKED'
  | 'BAD_PAYLOAD'
  | 'BAD_COUNT'
  | 'NEED_BACKGROUND'
  | 'NEED_PLAYERS'
  | 'WRONG_PASSWORD';

/** WS ack envelope: `{ok:true, ...}` on success, `{ok:false, code}` on failure. */
export type Result<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; code: ErrorCode };

// ---- zod schemas ------------------------------------------------------------

export const zNickname = z.string().min(1).max(12);

export const zRoomCode = z
  .string()
  .length(ROOM_CODE_LENGTH)
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`));

const zColor = z.string().regex(/^#[0-9a-f]{6}$/i);

// Brush-painting bounds — keep the phase:seek payload and per-update cost sane.
export const MAX_STROKES = 300;
export const MAX_STROKE_POINTS = 600;
export const MAX_TOTAL_POINTS = 4000;
export const MIN_BRUSH = 2;
export const MAX_BRUSH = 40;

const zStroke = z.object({
  color: zColor,
  size: z.number().min(MIN_BRUSH).max(MAX_BRUSH),
  points: z
    .array(z.object({ x: z.number().finite(), y: z.number().finite() }))
    .min(1)
    .max(MAX_STROKE_POINTS),
}) satisfies z.ZodType<StickmanStroke>;

// Coordinate range (0..background width/height) is checked server-side against
// the room's actual background, since that dimension isn't known statically here.
export const zStickmanState = z
  .object({
    x: z.number(),
    y: z.number(),
    scale: z.number().positive(),
    strokes: z.array(zStroke).max(MAX_STROKES),
  })
  .refine((s) => s.strokes.reduce((n, st) => n + st.points.length, 0) <= MAX_TOTAL_POINTS, {
    message: 'too many stroke points',
  }) satisfies z.ZodType<StickmanState>;

export const zCaptureReq = z.object({
  url: z.string().url(),
});

// ---- C->S request/ack payloads ----------------------------------------------

export const zRoomName = z.string().min(1).max(20);
export const zRoomPassword = z.string().min(2).max(20);

export const zRoomCreateReq = z
  .object({
    nickname: zNickname,
    roomName: zRoomName,
    isPrivate: z.boolean(),
    password: zRoomPassword.optional(),
  })
  .refine((req) => !req.isPrivate || req.password !== undefined, {
    message: 'private rooms require a password',
  });
export type RoomCreateReq = z.infer<typeof zRoomCreateReq>;
export type RoomCreateAck = Result<{ code: string; playerId: string }>;

export const zRoomJoinReq = z.object({
  code: zRoomCode,
  nickname: zNickname,
  password: zRoomPassword.optional(),
});
export type RoomJoinReq = z.infer<typeof zRoomJoinReq>;
export type RoomJoinAck = Result<{ playerId: string }>;

// The capture API hands back same-origin relative paths (/api/screenshots/…),
// so a bare `.url()` (absolute-only) would reject every real background.
const zImageUrl = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => v.startsWith('/') || /^https?:\/\//.test(v), {
    message: 'imageUrl must be a same-origin path or http(s) URL',
  });

export const zSetBackgroundReq = z.object({
  background: z.object({
    imageUrl: zImageUrl,
    width: z.number().positive(),
    height: z.number().positive(),
  }),
});
export type SetBackgroundReq = z.infer<typeof zSetBackgroundReq>;

export const zHideUpdateReq = z.object({ stickman: zStickmanState });
export type HideUpdateReq = z.infer<typeof zHideUpdateReq>;

export const zSeekClickReq = z.object({ x: z.number(), y: z.number() });
export type SeekClickReq = z.infer<typeof zSeekClickReq>;
export type SeekClickAck = Result<{ result: 'hit' | 'miss' | 'locked' | 'rejected' }>;

// null = auto (floor(n/2)); a non-null count must still be an integer in
// [1, players.length-1] at the point it's applied, but that range check is
// engine-side (BAD_COUNT) since it depends on live room size -- this schema
// only enforces the static shape (int or null), everything else -> BAD_PAYLOAD.
export const zSetHiderCountReq = z.object({ count: z.union([z.number().int(), z.null()]) });
export type SetHiderCountReq = z.infer<typeof zSetHiderCountReq>;

// ---- Socket.io event maps -----------------------------------------------------

export interface ServerToClientEvents {
  'room:state': (state: RoomStatePublic) => void;
  'game:role': (payload: { role: 'hider' | 'seeker' }) => void;
  'phase:hide': (payload: { background: Background; endsAt: number; stickman: StickmanState }) => void;
  'phase:hideWait': (payload: { endsAt: number }) => void;
  'phase:seek': (payload: { background: Background; stickmen: SeekStickman[]; endsAt: number }) => void;
  'seek:miss': (payload: { x: number; y: number; by: string }) => void;
  // One hider revealed by a hit; the game keeps running until every hider is found.
  'seek:found': (payload: { playerId: string; nickname: string; by: string; remaining: number }) => void;
  'game:end': (payload: {
    winner: Winner;
    stickmen: Array<{ playerId: string; nickname: string; stickman: StickmanState; found: boolean }>;
    reason: 'all_found' | 'timeout';
  }) => void;
  // Mid-game abort: the room dropped below a playable state (hider left, or
  // fewer than MIN_PLAYERS remain) — everyone returns to the lobby.
  'game:aborted': (payload: { reason: 'hider_left' | 'not_enough_players' }) => void;
}

export interface ClientToServerEvents {
  'room:create': (req: RoomCreateReq, ack: (res: RoomCreateAck) => void) => void;
  'room:join': (req: RoomJoinReq, ack: (res: RoomJoinAck) => void) => void;
  'rooms:list': (ack: (res: { ok: true; rooms: RoomSummary[] }) => void) => void;
  'room:setBackground': (req: SetBackgroundReq, ack: (res: Result) => void) => void;
  'room:setHiderCount': (req: SetHiderCountReq, ack: (res: Result) => void) => void;
  'game:start': (ack: (res: Result) => void) => void;
  'hide:update': (req: HideUpdateReq) => void;
  'hide:confirm': (ack: (res: Result) => void) => void;
  'seek:click': (req: SeekClickReq, ack: (res: SeekClickAck) => void) => void;
}
