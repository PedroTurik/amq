// Types and constants shared by the server and the web client (the socket protocol).

export const TIERS = ['easy', 'medium', 'hard', 'expert'] as const;
export type Tier = (typeof TIERS)[number];

export const FORMATS = ['TV', 'TV_SHORT', 'ONA', 'MOVIE', 'OVA', 'SPECIAL'] as const;
export type Format = (typeof FORMATS)[number];

export interface Settings {
  rounds: number;
  guessSeconds: number;
  revealSeconds: number;
  tiers: Tier[];
  formats: Format[];
  yearMin: number | null;
  yearMax: number | null;
  /** 'random': clip starts at a random point of the song; 'start': from the beginning. */
  startPoint: 'random' | 'start';
  /** Correct answers earn up to +50% points for answering fast. */
  speedBonus: boolean;
  /** Prefer songs this room hasn't heard before. */
  avoidRepeats: boolean;
}

export const LIMITS = {
  rounds: [1, 100],
  guessSeconds: [5, 90],
  revealSeconds: [5, 60],
  year: [1960, 2100],
  roomName: 30,
  playerName: 20,
  roomPassword: 64,
  maxPlayers: 24,
} as const;

export const DEFAULT_SETTINGS: Settings = {
  rounds: 15,
  guessSeconds: 20,
  revealSeconds: 15,
  tiers: ['easy', 'medium'],
  formats: [...FORMATS],
  yearMin: null,
  yearMax: null,
  startPoint: 'random',
  speedBonus: true,
  avoidRepeats: true,
};

export const BASE_POINTS = 100;
export const MAX_SPEED_BONUS = 50;

/** Autocomplete entry, served by GET /api/titles as a compact array. */
export interface TitleEntry {
  id: number; // AniList id
  /** Display title (English if known, else romaji). */
  t: string;
  /** Every searchable alias (romaji, english, native, synonyms, AMQ names). */
  a: string[];
  y: number | null;
  f: string;
  /** Popularity rank (1 = most popular). */
  p: number;
  /** Franchise id: every season of a show shares it, and any of them is a correct answer. */
  g: number;
}

export type GamePhase = 'loading' | 'guessing' | 'reveal' | 'finished';

export interface PlayerView {
  id: string;
  name: string;
  connected: boolean;
  isAdmin: boolean;
  /** Current game points (0 outside a game). */
  points: number;
  correct: number;
  /** During guessing: has this player picked / locked an answer? */
  answered: boolean;
  locked: boolean;
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  points: number;
  correct: number;
  gamesPlayed: number;
  gamesWon: number;
}

export interface MediaInfo {
  audio: string;
  video: string;
  /** Seconds into the song where the guessing clip starts. */
  offset: number;
}

export interface AnswerInfo {
  anilistId: number;
  title: string;
  romaji: string;
  native: string | null;
  cover: string;
  format: string;
  year: number | null;
  songType: string;
  songName: string;
  songArtist: string;
  tier: Tier;
  /** % of AnimeMusicQuiz players who get this song right. */
  amqDifficulty: number;
  /** Other anime that use the same song (also accepted). */
  alsoAccepted: string[];
}

export interface GuessResult {
  playerId: string;
  name: string;
  guess: string | null;
  correct: boolean;
  points: number;
  /** ms after the clip started when the answer was picked. */
  ms: number | null;
  /** Was disconnected for this round without answering. */
  away: boolean;
}

export interface RoundSummary {
  round: number;
  title: string;
  songName: string;
  songArtist: string;
  cover: string;
  correctCount: number;
  playerCount: number;
}

export interface GameView {
  id: string;
  /** 0-based index of the current round. */
  round: number;
  totalRounds: number;
  phase: GamePhase;
  /** Server-clock ms when the current phase ends (null = waiting / paused / no timer). */
  phaseEndsAt: number | null;
  /** Server-clock ms when the clip starts playing (guessing phase). */
  clipStartAt: number | null;
  clipSeconds: number;
  paused: boolean;
  media: MediaInfo | null;
  /** Media for the following round, sent during reveal so clients can preload it. */
  next: (MediaInfo & { round: number }) | null;
  myGuess: { anilistId: number; title: string; locked: boolean } | null;
  reveal: {
    answer: AnswerInfo;
    results: GuessResult[];
    /** Where the video continues from (seconds), i.e. where the audio stopped. */
    videoStart: number;
    skipVotes: string[];
  } | null;
  history: RoundSummary[];
}

export interface RoomView {
  id: string;
  name: string;
  meId: string;
  adminId: string | null;
  settings: Settings;
  /** How many distinct songs match the current settings. */
  poolSize: number;
  players: PlayerView[];
  leaderboard: LeaderboardEntry[];
  game: GameView | null;
}

export interface RoomListItem {
  id: string;
  name: string;
  online: number;
  players: number;
  inGame: boolean;
  lastActiveAt: number;
}

export type Ack<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export interface ClientToServer {
  sync: (clientTime: number, ack: (serverTime: number) => void) => void;
  'room:create': (p: { roomName: string; password: string; playerName: string; token: string }, ack: (r: Ack<{ roomId: string }>) => void) => void;
  'room:join': (p: { roomId: string; token: string; password?: string; playerName?: string }, ack: (r: Ack<{ needPassword?: boolean }>) => void) => void;
  'room:leave': (ack?: (r: Ack) => void) => void;
  'room:settings': (p: Partial<Settings>, ack?: (r: Ack) => void) => void;
  'room:delete': (ack?: (r: Ack) => void) => void;
  'game:start': (ack?: (r: Ack) => void) => void;
  'game:end': (ack?: (r: Ack) => void) => void;
  'game:toLobby': (ack?: (r: Ack) => void) => void;
  /** The clip for this round (identified by index + audio URL) is buffered and ready to play. */
  'round:ready': (p: { round: number; audio: string }) => void;
  'round:mediaError': (p: { round: number; audio: string }) => void;
  'guess:set': (p: { anilistId: number }, ack?: (r: Ack) => void) => void;
  'guess:lock': (ack?: (r: Ack) => void) => void;
  'reveal:skip': () => void;
  'admin:pause': (p: { paused: boolean }, ack?: (r: Ack) => void) => void;
  'admin:skipRound': (ack?: (r: Ack) => void) => void;
  'admin:kick': (p: { playerId: string }, ack?: (r: Ack) => void) => void;
  'admin:transfer': (p: { playerId: string }, ack?: (r: Ack) => void) => void;
}

export interface ServerToClient {
  'room:state': (s: RoomView) => void;
  /** You were removed from the room (kicked, room deleted). */
  'room:gone': (p: { reason: 'kicked' | 'deleted' }) => void;
  /** The same player opened the room in another tab/device; this connection was detached. */
  'session:replaced': () => void;
}
