/** One song row from the m-on.jp on-air list. */
export interface Track {
  title: string;
  artist: string;
}

/** One program block: a program-name row plus its continuation rows. */
export interface Program {
  /** Time slot as printed in the TSV, e.g. "6:00～6:30". */
  time: string;
  name: string;
  tracks: Track[];
}

export interface SearchResult {
  track: Track;
  /** spotify:track:... URI, or null when no match was found. */
  uri: string | null;
}

export type PipelineStatus =
  | 'updated' // playlist overwritten
  | 'dry_run' // matched only, Spotify not touched
  | 'program_not_found' // target does not air in this TSV; playlist untouched
  | 'no_tracks_found'; // every Spotify search missed; playlist untouched (not emptied)

export interface PipelineResult {
  status: PipelineStatus;
  program: string | null;
  fetched: number;
  added: number;
  skipped: Track[];
  dryRun: boolean;
}
