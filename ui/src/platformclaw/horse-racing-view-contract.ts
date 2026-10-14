import type {
  HorseBetMarket,
  HorseRacingSnapshot,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import type { RacingWinReaction } from "./horse-racing-celebration.ts";

export type HorseRacingView = {
  reaction: RacingWinReaction | null;
  snapshot: HorseRacingSnapshot | null;
  now: number;
  market: HorseBetMarket;
  selection: string[];
  amount: number;
  message: string;
  busy: boolean;
  stale: boolean;
  pending: boolean;
  pendingCancelId: string | null;
  onCancel: (betId: string) => void;
  muted: boolean;
  reducedMotion: boolean;
  historical: boolean;
  verification: string;
  presentation: "compact" | "expanded" | "collapsed";
  onPresentation: (presentation: "compact" | "expanded" | "collapsed") => void;
  onVerify: () => void;
  onExit: (action: "games" | "baseball" | "close") => void;
  onMarket: (market: HorseBetMarket) => void;
  onSelect: (id: string) => void;
  onAmount: (amount: number) => void;
  onBet: () => void;
  onRefresh: () => void;
  onHistory: (id: string | null) => void;
  onMute: () => void;
  onMotion: () => void;
};
