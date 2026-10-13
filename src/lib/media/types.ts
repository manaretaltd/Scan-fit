export type MediaFile = {
  id: string;
  customer_id: string;
  order_id: string | null;
  invoice_id: string | null;
  payment_id: string | null;
  filename: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  category: string;
  description: string;
  storage_bucket: string;
  storage_path: string;
  thumbnail_path: string | null;
  sha256: string | null;
  visibility: "Internal Only" | "Shareable";
  status: "Uploading" | "Active" | "Archived";
  source: string;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
};
export type MediaItem = Omit<
  MediaFile,
  "storage_bucket" | "storage_path" | "thumbnail_path" | "sha256"
> & {
  uploader: string;
  customer_name: string;
  invoice_number: string | null;
  related_orders: { id: string; number: number }[];
  has_thumbnail: boolean;
  can_edit: boolean;
};
export type MediaSettings = {
  id: boolean;
  image_limit: number;
  pdf_limit: number;
  video_limit: number;
  pack_limit: number;
  max_pack_files: number;
  manufacturer_name: string;
  manufacturer_email: string;
  allowed_mimes: string[];
};
export type MediaCategory = {
  name: string;
  permission: string;
  audience: string;
  manufacturer_allowed: boolean;
  sort_order: number;
};
export type MediaConfig = {
  settings: MediaSettings;
  categories: MediaCategory[];
};
export type MediaResult = {
  items: MediaItem[];
  total: number;
  counts: Record<string, number>;
};
export type DocumentPackage = {
  id: string;
  customer_id: string;
  order_id: string | null;
  audience: "Manufacturer" | "Customer";
  pack_id: string | null;
  file_ids: string[];
  snapshot: {
    id: string;
    filename: string;
    sha256: string | null;
    size_bytes: number;
  }[];
  destination: string;
  status: "Prepared";
  prepared_by: string;
  created_at: string;
};
export const fileLimit = (mime: string, settings: MediaSettings) =>
  mime.startsWith("video/")
    ? settings.video_limit
    : mime === "application/pdf"
      ? settings.pdf_limit
      : settings.image_limit;
export const bytesLabel = (bytes: number) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
