/** Metadata-only contract shared by the local server and Studio. */
export interface InventoryItem {
  id: string;
  kind: "profile" | "skill" | "mcp";
  name: string;
  description: string;
  state: "installed" | "configured" | "available" | "referenced" | "unreadable";
  sources: string[];
  path?: string;
  related: string[];
}
export interface InventorySource {
  path: string;
  state: "scanned" | "missing" | "unreadable" | "partial";
}
export interface LocalInventoryData {
  items: InventoryItem[];
  sources: InventorySource[];
  scannedAt: string;
}
