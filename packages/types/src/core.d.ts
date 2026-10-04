/** REST contracts: opaque UUID strings, monetary values as decimal strings. */
export type UserRole =
  'buyer' | 'owner' | 'agent' | 'agency' | 'developer' | 'admin';
export type ListingStatus =
  | 'draft'
  | 'processing'
  | 'moderation'
  | 'published'
  | 'paused'
  | 'archived'
  | 'sold'
  | 'rented'
  | 'rejected';
export type DealType = 'sale' | 'long_rent' | 'short_rent';
export type MembershipRole = 'owner' | 'admin' | 'member';
export type SourceKind = 'direct' | 'agency' | 'developer' | 'feed' | 'api';
export interface AddressDto {
  id: string;
  formatted: string;
  locality: string;
  district: string | null;
  longitude: number;
  latitude: number;
  provider: string;
}
export interface PropertyDto {
  id: string;
  created_by: string;
  organization_id: string | null;
  category_code: string;
  address_id: string;
  building_id: string | null;
  floor_id: string | null;
  attributes: Record<string, string | number | boolean>;
  version: number;
}
export interface ListingDto {
  id: string;
  property_id: string;
  source_id: string;
  seller_id: string;
  organization_id: string | null;
  deal_type: DealType;
  price: string | null;
  currency: 'RUB';
  title: string;
  description: string;
  status: ListingStatus;
  version: number;
}
export interface ListingSourceDto {
  id: string;
  kind: SourceKind;
  organization_id: string | null;
  external_reference: string | null;
  metadata: Record<string, unknown>;
}
export interface MediaVariantDto {
  url: string;
  mime: string;
  width: number;
  height: number;
}
export interface PublicMediaDto {
  id: string;
  kind: 'photo' | 'floor_plan';
  variants: Record<string, MediaVariantDto>;
}

export type ViewerRole = UserRole | 'guest';
