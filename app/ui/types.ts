export type Organization = {
  entityId: string;
  id?: string;
  slug: string;
  name: string;
  description?: string | null;
  credibility_score?: number | null;
  source?: string | null;
  sourceCount?: number | null;
  updated_at?: string | null;
  entityType: string;
  isCoreTracking: boolean;
  region: string;
  country: string;
  founded: string | null;
  analysisType: string | null;
  relatedTypes: string | null;
  mentionCount: number;
  context: string | null;
  sourceLocation: string | null;
  sourceDocument: string | null;
  originalName: string | null;
  locationBasis: string | null;
  locationConfidence: string | null;
  summary: string | null;
  websiteUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Event = {
  id: string;
  organizationId: string;
  eventDate: string;
  eventType: string | null;
  title: string;
  summary: string | null;
  translatedTitle?: string | null;
  translatedDescription?: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  createdAt: string;
};

export type Insights = {
  organizationCount: number;
  eventCount: number;
  recentEvents: Event[];
  configured: boolean;
};

export type OrganizationSearchResponse = {
  items: Organization[];
  total: number;
  limit: number;
  offset: number;
  query: string;
  configured: boolean;
  fts?: boolean;
};

export type OrganizationProfile = {
  organization: Organization;
  events: Event[];
  credibilityAnalysis?: {
    score: number;
    summary: string;
    factors: Array<{ label: string; value: string }>;
  };
  newsSources: Array<{
    id: string;
    name: string;
    url: string;
    last_fetch_status: string | null;
    last_checked_at: string | null;
    next_check_at: string | null;
  }>;
};
