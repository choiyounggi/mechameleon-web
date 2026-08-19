import { z } from 'zod';

// ---- Phases & core domain types ------------------------------------------

export type Phase = 'lobby' | 'hide' | 'seek' | 'result';

export type PartKey = 'head' | 'torso' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export interface StickmanState {
  x: number;
  y: number;
  scale: number;
  colors: Record<PartKey, string>; // color = '#rrggbb'
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

const zColors = z.object({
  head: zColor,
  torso: zColor,
  leftArm: zColor,
  rightArm: zColor,
  leftLeg: zColor,
  rightLeg: zColor,
}) satisfies z.ZodType<Record<PartKey, string>>;

// Coordinate range (0..background width/height) is checked server-side against
// the room's actual background, since that dimension isn't known statically here.
export const zStickmanState = z.object({
  x: z.number(),
  y: z.number(),
  scale: z.number().positive(),
  colors: zColors,
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

export const zSetBackgroundReq = z.object({
  background: z.object({
    imageUrl: z.string().url(),
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

// ---- Socket.io event maps -----------------------------------------------------

export interface ServerToClientEvents {
  'room:state': (state: RoomStatePublic) => void;
  'game:role': (payload: { role: 'hider' | 'seeker' }) => void;
  'phase:hide': (payload: { background: Background; endsAt: number }) => void;
  'phase:hideWait': (payload: { endsAt: number }) => void;
  'phase:seek': (payload: { background: Background; stickman: StickmanState; endsAt: number }) => void;
  'seek:miss': (payload: { x: number; y: number; by: string }) => void;
  'game:end': (payload: {
    winner: Winner;
    foundBy?: string;
    stickman: StickmanState | null;
    reason: 'found' | 'timeout' | 'forfeit';
  }) => void;
}

export interface ClientToServerEvents {
  'room:create': (req: RoomCreateReq, ack: (res: RoomCreateAck) => void) => void;
  'room:join': (req: RoomJoinReq, ack: (res: RoomJoinAck) => void) => void;
  'rooms:list': (ack: (res: { ok: true; rooms: RoomSummary[] }) => void) => void;
  'room:setBackground': (req: SetBackgroundReq, ack: (res: Result) => void) => void;
  'game:start': (ack: (res: Result) => void) => void;
  'hide:update': (req: HideUpdateReq) => void;
  'hide:confirm': (ack: (res: Result) => void) => void;
  'seek:click': (req: SeekClickReq, ack: (res: SeekClickAck) => void) => void;
}
