export interface SearchDefinition {
  q?: string | undefined;
  category?: string | undefined;
  dealType?: 'sale' | 'long_rent' | 'short_rent' | undefined;
  price?: { min?: number; max?: number };
  pricePerM2?: { min?: number; max?: number };
  attributes?: Record<
    string,
    string | boolean | { min?: number; max?: number }
  >;
  locality?: string | undefined;
  district?: string | undefined;
  sellerType?: 'owner' | 'agent' | 'agency' | 'developer' | 'admin' | undefined;
  sourceType?: 'direct' | 'agency' | 'developer' | 'feed' | 'api' | undefined;
  publishedAfter?: string | undefined;
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'area_desc';
  bounds?: [number, number, number, number];
  polygon?: [number, number][] | undefined;
  limit?: number;
  cursor?: string | undefined;
}
export interface ListingCard {
  id: string;
  title: string;
  price: number;
  price_per_m2: number | null;
  deal_type: string;
  category: string;
  address: string;
  locality: string;
  district: string;
  longitude: number;
  latitude: number;
  attributes: Record<string, unknown>;
  media: { id: string; url: string }[];
}
export interface SearchPage {
  items: ListingCard[];
  cursor: string | null;
  total: number;
  totalIsEstimate: boolean;
  facets: Record<string, unknown>;
}
export interface MapMarker {
  id: string;
  count: number;
  longitude: number;
  latitude: number;
  minPrice: number;
  listingIds: string[];
}
export type AnalyticsEvent =
  | { type: 'search_performed'; resultCount: number }
  | {
      type:
        | 'result_viewed'
        | 'listing_viewed'
        | 'favorite_added'
        | 'favorite_removed'
        | 'contact_initiated';
      listingId: string;
    }
  | { type: 'filter_changed'; fields: string[] }
  | { type: 'mode_changed'; mode: 'map' | 'list' };
export interface AnalyticsAdapter {
  emit(event: AnalyticsEvent): void;
}
export interface GeoProvider {
  boundaries(
    kind: 'district' | 'okrug',
    locality: string,
  ): Promise<GeoJSONFeature[]>;
  pois(bounds: [number, number, number, number]): Promise<GeoJSONFeature[]>;
}
export interface GeoJSONFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}
