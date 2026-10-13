import type {
  Aggregate,
  FrameProfile,
  ScanConfig,
  ScanSession,
  StoredFrame,
} from "./model";
import type { Json } from "../types";
type Table<T> = {
  Row: T;
  Insert: Partial<T>;
  Update: Partial<T>;
  Relationships: [];
};
export type ScanTables = {
  scan_fit_frame_profiles: Table<{
    id: string;
    name: string;
    model: string;
    version: string;
    active: boolean;
    definition: FrameProfile;
    created_at: string;
    created_by: string;
  }>;
  scan_fit_config: Table<{
    id: boolean;
    thresholds: ScanConfig;
    version: number;
    updated_at: string;
  }>;
  scan_fit_sessions: Table<ScanSession>;
  scan_fit_frames: Table<StoredFrame & { image_sha256: string }>;
  scan_fit_results: Table<{
    id: string;
    session_id: string;
    result: Aggregate;
    manually_adjusted: boolean;
    accepted_at: string | null;
    accepted_by: string | null;
  }>;
  scan_fit_validation: Table<{
    id: string;
    session_id: string;
    reference: Json;
    errors: Json;
    operator_id: string;
    created_at: string;
  }>;
  scan_fit_adjustments: Table<{
    id: string;
    session_id: string;
    frame_id: string;
    operator_id: string;
    original_pixels: Json;
    corrected_pixels: Json;
    reason: string;
    previous_correction: Json | null;
    created_at: string;
  }>;
};
