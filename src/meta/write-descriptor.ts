// The meta-ads-guard contract layer (docs/contracts/meta-ads-guard.md@1.1 §2-§6): the descriptor's types, the
// endpoint table, and the pure derivations the descriptor builder uses. Nothing here reads Graph or the guard.
// matchEndpoint, deriveKind, deriveAccountLimit, deriveCreativeBearing, hostAllowed and validateDescriptor port the
// contract's fake guard (tests/fixtures/meta-ads-guard/fake-guard.mjs) line for line; a test holds them equal.
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { classifyMetaError } from "./errors.js";

export const CONTRACT_VERSION = "1.0";

/** Contract §3 `object.type`. */
export type ObjectType =
  | "campaign"
  | "adset"
  | "ad"
  | "creative"
  | "image"
  | "video"
  | "audience"
  | "custom_conversion"
  | "study"
  | "budget_schedule"
  | "page_post"
  | "account"
  | "other";

/** Contract §3 `kind`. */
export type Kind = "create" | "update" | "delete" | "copy" | "study" | "budget-schedule" | "post-edit" | "boost" | "other";

export type ObjectStatus = "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";
export type EffectiveStatus = ObjectStatus | "IN_PROCESS" | "WITH_ISSUES";
export type BudgetKind = "daily" | "lifetime";
export type CampaignRole = "self" | "parent" | "destination" | "study-cell";
export type IdentityVia = "direct" | "creative" | "creative_id" | "source_ad" | "asset_feed_spec";

/** Contract §3.2: each identity field and the owner key that carries its resolution (null: a pixel, none). */
export const OWNER_KEY = {
  "object_story_spec.page_id": "owner_page",
  object_story_id: "owner_page",
  "promoted_object.page_id": "owner_page",
  "object_story_spec.instagram_user_id": "owner_ig",
  instagram_user_id: "owner_ig",
  instagram_actor_id: "owner_ig",
  source_instagram_media_id: "owner_ig",
  object_id: "owner_page",
  creative_id: "owner_page",
  "object_story_spec.link_data.call_to_action.value.lead_gen_form_id": "owner_page",
  "object_story_spec.video_data.call_to_action.value.lead_gen_form_id": "owner_page",
  "promoted_object.pixel_id": null,
  pixel_id: null,
  "objectives.adspixels.id": null,
} as const satisfies Readonly<Record<string, "owner_page" | "owner_ig" | null>>;

export type IdentityField = keyof typeof OWNER_KEY;

/** Contract §3.1. */
export interface CampaignEntry {
  id: string | null;
  account_id: string | null;
  created: boolean;
  role: CampaignRole;
  spend_cap_minor_before: number | null;
  spend_cap_minor_after: number | null;
  name: string | null;
  status_after: EffectiveStatus | null;
  buying_type: string | null;
}

/** Contract §3.2. */
export interface IdentityEntry {
  field: IdentityField;
  via: IdentityVia;
  id: string;
  owner_page: string | null;
  owner_ig: string | null;
}

/** Contract §3: every field present, none added. */
export interface Descriptor {
  v: "1.0";
  request_id: string;
  tool: string;
  method: "POST" | "DELETE";
  path: string;
  params_keys: string[];
  ad_account: string | null;
  account: { spend_cap_minor: number | null; amount_spent_minor: number | null };
  object: { type: ObjectType; id: string | null; created: boolean };
  status: { before: ObjectStatus | null; after: ObjectStatus | null };
  budget: {
    currency: string | null;
    kind_before: BudgetKind | null;
    kind_after: BudgetKind | null;
    before_minor: number | null;
    after_minor: number | null;
    end_time: string | null;
  };
  campaigns: CampaignEntry[];
  identity: IdentityEntry[];
  kind: Kind;
  account_limit: boolean;
  validate_only: boolean;
}

/** Contract §9. */
export interface OutcomeRecord {
  v: "1.0";
  outcome_for: string;
  ok: boolean;
  meta_id: string | null;
  error: string | null;
}

/** A write the fork refuses itself, before the guard is asked. The lowest layer, so every module can throw it. */
export class WriteRefusal extends McpError {
  constructor(detail: string) {
    super(ErrorCode.InvalidRequest, `write refused: ${detail}`);
    // .message is McpError's "MCP error -32600: write refused: <detail>"; the runner's tests (Task 3) rely on the prefix.
    this.name = "WriteRefusal";
  }
}

/** One row of the contract §4 endpoint table (`endpoints.json` `rows`). */
export interface EndpointRow {
  id: string;
  method: "POST" | "DELETE";
  path: string;
  object_type: ObjectType | "any";
  kind: Kind;
  refine: "boost-if-inline-post" | "delete-if-status-deleted" | null;
  no_campaign: boolean;
  account_limit: "always" | "never" | "by-keys";
  roles: readonly CampaignRole[];
  validate_only: "documented" | "unconfirmed" | "contradicted";
  creative_bearing: "always" | "never" | "if-creative-key";
  keys: Readonly<Record<string, readonly string[]>>;
}

export interface EndpointTable {
  v: string;
  host_list: readonly string[];
  /** Contract §2: a host listed here takes only a request matching one of its rows. */
  host_rows: Readonly<Record<string, readonly string[]>>;
  read_post: string;
  account_limit_keys: {
    exact: readonly string[];
    prefix: readonly string[];
    contains: readonly string[];
    except: readonly string[];
    spend_cap_allowed_rows: readonly string[];
  };
  rows: readonly EndpointRow[];
  sub_keys: Readonly<Record<string, readonly string[]>>;
}

// Contract 1.1's endpoints.json, embedded (coverage left out: it is the guard's, not the fork's). A test holds
// it equal to the vendored copy; re-vendor and regenerate together.
export const ENDPOINTS: EndpointTable = {
  v: "1.1",
  host_list: ["graph.facebook.com", "graph-video.facebook.com"],
  host_rows: { "graph-video.facebook.com": ["POST /act_{id}/advideos"] },
  read_post: "^/(v\\d+\\.\\d+/)?(act_\\d+|\\d+)/insights$",
  account_limit_keys: {
    exact: ["spend_cap_action"],
    prefix: ["funding"],
    contains: ["billing"],
    except: ["billing_event"],
    spend_cap_allowed_rows: ["POST /act_{id}/campaigns"],
  },
  rows: [
    {
      id: "POST /act_{id}", method: "POST", path: "/{act}", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "always",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /act_{id}/campaigns", method: "POST", path: "/{act}/campaigns", object_type: "any",
      kind: "create", refine: null, no_campaign: false, account_limit: "by-keys",
      roles: ["self"], validate_only: "documented", creative_bearing: "never",
      keys: {
        "paused-create": ["name", "objective", "status", "special_ad_categories", "special_ad_category_country", "buying_type", "bid_strategy", "daily_budget", "lifetime_budget", "spend_cap", "is_adset_budget_sharing_enabled", "start_time", "stop_time", "execution_options"],
        "live-create": ["name", "objective", "status", "special_ad_categories", "special_ad_category_country", "buying_type", "bid_strategy", "daily_budget", "lifetime_budget", "spend_cap", "is_adset_budget_sharing_enabled", "start_time", "stop_time", "execution_options"],
      },
    },
    {
      id: "POST /act_{id}/adsets", method: "POST", path: "/{act}/adsets", object_type: "any",
      kind: "create", refine: null, no_campaign: false, account_limit: "by-keys",
      roles: ["parent"], validate_only: "documented", creative_bearing: "never",
      keys: {
        "paused-create": ["name", "campaign_id", "status", "daily_budget", "lifetime_budget", "bid_amount", "bid_strategy", "bid_constraints", "billing_event", "optimization_goal", "promoted_object", "targeting", "start_time", "end_time", "destination_type", "attribution_spec", "pacing_type", "is_dynamic_creative", "dsa_beneficiary", "dsa_payor", "frequency_control_specs", "execution_options"],
        "live-create": ["name", "campaign_id", "status", "daily_budget", "lifetime_budget", "bid_amount", "bid_strategy", "bid_constraints", "billing_event", "optimization_goal", "promoted_object", "targeting", "start_time", "end_time", "destination_type", "attribution_spec", "pacing_type", "is_dynamic_creative", "dsa_beneficiary", "dsa_payor", "frequency_control_specs", "execution_options"],
      },
    },
    {
      id: "POST /act_{id}/ads", method: "POST", path: "/{act}/ads", object_type: "any",
      kind: "create", refine: "boost-if-inline-post", no_campaign: false, account_limit: "by-keys",
      roles: ["parent"], validate_only: "documented", creative_bearing: "if-creative-key",
      keys: {
        "paused-create": ["name", "adset_id", "status", "creative", "creative.creative_id", "creative.name", "creative.object_story_spec", "creative.object_story_id", "creative.source_instagram_media_id", "creative.instagram_user_id", "creative.asset_feed_spec", "creative.url_tags", "creative.degrees_of_freedom_spec", "creative.contextual_multi_ads", "creative.object_id", "creative.call_to_action", "creative.image_crops", "creative.portrait_customizations", "creative.categorization_criteria", "creative.link_url", "creative.platform_customizations", "creative.adlabels", "conversion_domain", "adlabels", "creative_asset_groups_spec", "execution_options"],
        "live-create": ["name", "adset_id", "status", "creative", "creative.creative_id", "creative.name", "creative.object_story_spec", "creative.object_story_id", "creative.source_instagram_media_id", "creative.instagram_user_id", "creative.asset_feed_spec", "creative.url_tags", "creative.degrees_of_freedom_spec", "creative.contextual_multi_ads", "creative.object_id", "creative.call_to_action", "creative.image_crops", "creative.portrait_customizations", "creative.categorization_criteria", "creative.link_url", "creative.platform_customizations", "creative.adlabels", "conversion_domain", "adlabels", "creative_asset_groups_spec", "execution_options"],
        "boost": ["name", "adset_id", "status", "creative", "creative.creative_id", "creative.name", "creative.object_story_spec", "creative.object_story_id", "creative.source_instagram_media_id", "creative.instagram_user_id", "creative.asset_feed_spec", "creative.url_tags", "creative.degrees_of_freedom_spec", "creative.contextual_multi_ads", "creative.object_id", "creative.call_to_action", "creative.image_crops", "creative.portrait_customizations", "creative.categorization_criteria", "creative.link_url", "creative.platform_customizations", "creative.adlabels", "conversion_domain", "adlabels", "creative_asset_groups_spec", "execution_options"],
      },
    },
    {
      id: "POST /act_{id}/adcreatives", method: "POST", path: "/{act}/adcreatives", object_type: "any",
      kind: "create", refine: null, no_campaign: true, account_limit: "by-keys",
      roles: [], validate_only: "documented", creative_bearing: "always",
      keys: {
        "no-campaign-create": ["name", "object_story_spec", "object_story_id", "source_instagram_media_id", "instagram_user_id", "asset_feed_spec", "url_tags", "degrees_of_freedom_spec", "contextual_multi_ads", "object_id", "call_to_action", "image_crops", "portrait_customizations", "categorization_criteria", "link_url", "platform_customizations", "adlabels", "creative_sourcing_spec", "execution_options"],
      },
    },
    {
      id: "POST /act_{id}/adimages", method: "POST", path: "/{act}/adimages", object_type: "any",
      kind: "create", refine: null, no_campaign: true, account_limit: "by-keys",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "no-campaign-create": ["bytes", "filename", "name", "execution_options"],
      },
    },
    {
      id: "POST /act_{id}/advideos", method: "POST", path: "/{act}/advideos", object_type: "any",
      kind: "create", refine: null, no_campaign: true, account_limit: "by-keys",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "no-campaign-create": ["file_url", "source", "name", "title", "description", "source_instagram_media_id", "upload_phase", "upload_session_id", "start_offset", "video_file_chunk", "file_size", "execution_options"],
      },
    },
    {
      id: "POST /act_{id}/customaudiences", method: "POST", path: "/{act}/customaudiences", object_type: "any",
      kind: "create", refine: null, no_campaign: true, account_limit: "by-keys",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "no-campaign-create": ["name", "subtype", "origin_audience_id", "lookalike_spec", "description", "execution_options"],
      },
    },
    {
      id: "POST /act_{id}/customconversions", method: "POST", path: "/{act}/customconversions", object_type: "any",
      kind: "create", refine: null, no_campaign: true, account_limit: "by-keys",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "no-campaign-create": ["name", "pixel_id", "rule", "custom_event_type", "default_conversion_value", "description", "event_source_type", "execution_options"],
      },
    },
    {
      id: "POST /act_{id}/adrules_library", method: "POST", path: "/{act}/adrules_library", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "by-keys",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /act_{id}/assigned_users", method: "POST", path: "/{act}/assigned_users", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "by-keys",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "DELETE /act_{id}/assigned_users", method: "DELETE", path: "/{act}/assigned_users", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "by-keys",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{campaign_id}", method: "POST", path: "/{id}", object_type: "campaign",
      kind: "update", refine: "delete-if-status-deleted", no_campaign: false, account_limit: "never",
      roles: ["self"], validate_only: "documented", creative_bearing: "never",
      keys: {
        "pause": ["status", "execution_options"],
        "delete": ["status", "execution_options"],
        "cap-cut-or-first-cap": ["spend_cap", "execution_options"],
        "budget-cut": ["daily_budget", "lifetime_budget", "execution_options"],
        "edit": ["name", "execution_options"],
        "activation": ["status", "execution_options"],
        "budget-raise": ["daily_budget", "lifetime_budget", "stop_time", "execution_options"],
        "cap-raise": ["spend_cap", "execution_options"],
      },
    },
    {
      id: "POST /{adset_id}", method: "POST", path: "/{id}", object_type: "adset",
      kind: "update", refine: "delete-if-status-deleted", no_campaign: false, account_limit: "never",
      roles: ["parent"], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "pause": ["status", "execution_options"],
        "delete": ["status", "execution_options"],
        "budget-cut": ["daily_budget", "lifetime_budget", "execution_options"],
        "edit": ["name", "targeting", "execution_options"],
        "activation": ["status", "execution_options"],
        "budget-raise": ["daily_budget", "lifetime_budget", "end_time", "execution_options"],
      },
    },
    {
      id: "POST /{ad_id}", method: "POST", path: "/{id}", object_type: "ad",
      kind: "update", refine: "delete-if-status-deleted", no_campaign: false, account_limit: "never",
      roles: ["parent"], validate_only: "unconfirmed", creative_bearing: "if-creative-key",
      keys: {
        "pause": ["status", "execution_options"],
        "delete": ["status", "execution_options"],
        "edit": ["name", "creative", "creative.creative_id", "creative.name", "creative.object_story_spec", "creative.object_story_id", "creative.source_instagram_media_id", "creative.instagram_user_id", "creative.asset_feed_spec", "creative.url_tags", "creative.degrees_of_freedom_spec", "creative.contextual_multi_ads", "creative.object_id", "creative.call_to_action", "creative.image_crops", "creative.portrait_customizations", "creative.categorization_criteria", "creative.link_url", "creative.platform_customizations", "creative.adlabels", "execution_options"],
        "activation": ["status", "execution_options"],
      },
    },
    {
      id: "POST /{creative_id}", method: "POST", path: "/{id}", object_type: "creative",
      kind: "update", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{study_id}", method: "POST", path: "/{id}", object_type: "study",
      kind: "study", refine: null, no_campaign: false, account_limit: "never",
      roles: ["study-cell"], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "study": ["name", "description", "start_time", "end_time", "cells", "objectives", "type", "confidence_level", "cooldown_start_time", "observation_end_time", "execution_options"],
      },
    },
    {
      id: "POST /{page_post_id}", method: "POST", path: "/{id}", object_type: "page_post",
      kind: "post-edit", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{account_id}", method: "POST", path: "/{id}", object_type: "account",
      kind: "other", refine: null, no_campaign: false, account_limit: "always",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{other_id}", method: "POST", path: "/{id}", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/copies", method: "POST", path: "/{id}/copies", object_type: "any",
      kind: "copy", refine: null, no_campaign: false, account_limit: "never",
      roles: ["destination"], validate_only: "unconfirmed", creative_bearing: "always",
      keys: {
        "copy": ["adset_id", "campaign_id", "status_option", "rename_options", "deep_copy", "start_time", "end_time", "execution_options"],
      },
    },
    {
      id: "POST /{campaign_id}/budget_schedules", method: "POST", path: "/{id}/budget_schedules", object_type: "any",
      kind: "budget-schedule", refine: null, no_campaign: false, account_limit: "never",
      roles: ["self"], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{business_id}/ad_studies", method: "POST", path: "/{id}/ad_studies", object_type: "any",
      kind: "study", refine: null, no_campaign: false, account_limit: "never",
      roles: ["study-cell"], validate_only: "contradicted", creative_bearing: "never",
      keys: {
        "study": ["name", "description", "start_time", "end_time", "cells", "objectives", "type", "confidence_level", "cooldown_start_time", "observation_end_time", "execution_options"],
      },
    },
    {
      id: "POST /{id}/insights", method: "POST", path: "/{id}/insights", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/adaccounts", method: "POST", path: "/{id}/adaccounts", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/users", method: "POST", path: "/{id}/users", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/comments", method: "POST", path: "/{id}/comments", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/leadgen_forms", method: "POST", path: "/{id}/leadgen_forms", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/photos", method: "POST", path: "/{id}/photos", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/test_leads", method: "POST", path: "/{id}/test_leads", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/assigned_users", method: "POST", path: "/{id}/assigned_users", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/register", method: "POST", path: "/{id}/register", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/deregister", method: "POST", path: "/{id}/deregister", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/request_code", method: "POST", path: "/{id}/request_code", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/verify_code", method: "POST", path: "/{id}/verify_code", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/whatsapp_business_profile", method: "POST", path: "/{id}/whatsapp_business_profile", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/message_templates", method: "POST", path: "/{id}/message_templates", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/flows", method: "POST", path: "/{id}/flows", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/assets", method: "POST", path: "/{id}/assets", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/publish", method: "POST", path: "/{id}/publish", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/deprecate", method: "POST", path: "/{id}/deprecate", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/message_qrdls", method: "POST", path: "/{id}/message_qrdls", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "POST /{id}/subscribed_apps", method: "POST", path: "/{id}/subscribed_apps", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "DELETE /{campaign_id}", method: "DELETE", path: "/{id}", object_type: "campaign",
      kind: "delete", refine: null, no_campaign: false, account_limit: "never",
      roles: ["self"], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "delete": [],
      },
    },
    {
      id: "DELETE /{adset_id}", method: "DELETE", path: "/{id}", object_type: "adset",
      kind: "delete", refine: null, no_campaign: false, account_limit: "never",
      roles: ["parent"], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "delete": [],
      },
    },
    {
      id: "DELETE /{ad_id}", method: "DELETE", path: "/{id}", object_type: "ad",
      kind: "delete", refine: null, no_campaign: false, account_limit: "never",
      roles: ["parent"], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "delete": [],
      },
    },
    {
      id: "DELETE /{study_id}", method: "DELETE", path: "/{id}", object_type: "study",
      kind: "delete", refine: null, no_campaign: false, account_limit: "never",
      roles: ["study-cell"], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {
        "delete": [],
      },
    },
    {
      id: "DELETE /{other_id}", method: "DELETE", path: "/{id}", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "DELETE /{id}/adaccounts", method: "DELETE", path: "/{id}/adaccounts", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "DELETE /{id}/assigned_users", method: "DELETE", path: "/{id}/assigned_users", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "DELETE /{id}/message_templates", method: "DELETE", path: "/{id}/message_templates", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "DELETE /{id}/subscribed_apps", method: "DELETE", path: "/{id}/subscribed_apps", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
    {
      id: "DELETE /{id}/message_qrdls/{id}", method: "DELETE", path: "/{id}/message_qrdls/{id}", object_type: "any",
      kind: "other", refine: null, no_campaign: false, account_limit: "never",
      roles: [], validate_only: "unconfirmed", creative_bearing: "never",
      keys: {},
    },
  ],
  sub_keys: {
    object_story_spec: ["page_id", "instagram_user_id", "link_data.link", "link_data.message", "link_data.caption", "link_data.name", "link_data.description", "link_data.image_hash", "link_data.picture", "link_data.multi_share_optimized", "link_data.multi_share_end_card", "link_data.page_welcome_message", "link_data.call_to_action.type", "link_data.call_to_action.value.link", "link_data.call_to_action.value.lead_gen_form_id", "link_data.call_to_action.value.app_destination", "link_data.child_attachments.link", "link_data.child_attachments.name", "link_data.child_attachments.description", "link_data.child_attachments.image_hash", "link_data.child_attachments.picture", "link_data.child_attachments.video_id", "link_data.child_attachments.call_to_action.type", "link_data.child_attachments.call_to_action.value.link", "video_data.video_id", "video_data.image_hash", "video_data.image_url", "video_data.message", "video_data.title", "video_data.link_description", "video_data.page_welcome_message", "video_data.call_to_action.type", "video_data.call_to_action.value.link", "video_data.call_to_action.value.lead_gen_form_id", "video_data.call_to_action.value.app_destination"],
    call_to_action: ["type", "value.link"],
    asset_feed_spec: ["images.hash", "images.adlabels.name", "videos.video_id", "videos.thumbnail_hash", "videos.adlabels.name", "bodies.text", "bodies.adlabels.name", "titles.text", "titles.adlabels.name", "descriptions.text", "descriptions.adlabels.name", "link_urls.website_url", "link_urls.display_url", "link_urls.adlabels.name", "call_to_action_types", "ad_formats", "optimization_type", "audios.type", "asset_customization_rules.is_default", "asset_customization_rules.customization_spec.publisher_platforms", "asset_customization_rules.customization_spec.facebook_positions", "asset_customization_rules.customization_spec.instagram_positions", "asset_customization_rules.customization_spec.messenger_positions", "asset_customization_rules.customization_spec.audience_network_positions", "asset_customization_rules.customization_spec.threads_positions", "asset_customization_rules.customization_spec.locales", "asset_customization_rules.image_label.name", "asset_customization_rules.video_label.name", "asset_customization_rules.body_label.name", "asset_customization_rules.title_label.name", "asset_customization_rules.description_label.name", "asset_customization_rules.link_url_label.name"],
    promoted_object: ["page_id", "pixel_id", "custom_event_type"],
    lookalike_spec: ["ratio", "country", "type"],
    objectives: ["name", "type", "is_primary", "adspixels.id", "adspixels.event_names"],
    creative_asset_groups_spec: ["groups.images.hash", "groups.videos.video_id", "groups.texts.text", "groups.texts.text_type", "groups.call_to_action.type", "groups.call_to_action.value.link"],
    cells: ["name", "treatment_percentage", "control_percentage", "adsets", "campaigns", "id"],
    creative_sourcing_spec: ["site_links_spec.site_link_title", "site_links_spec.site_link_url", "site_links_spec.site_link_image_hash"],
  },
};

// `{id}` is digits, or Graph's `<digits>_<digits>` for a Page post or comment (contract §4).
const PATH_PART: Readonly<Record<string, string>> = { "{act}": "act_\\d+", "{id}": "\\d+(?:_\\d+)?" };

/** The endpoint row for a request (contract §4): method, path pattern (optional /vNN.N prefix), object type. */
export function matchEndpoint(method: string, path: string, objectType: ObjectType): EndpointRow | null {
  for (const row of ENDPOINTS.rows) {
    if (row.method !== method) continue;
    if (row.object_type !== "any" && row.object_type !== objectType) continue;
    const pattern = row.path
      .split("/")
      .map((part) => PATH_PART[part] ?? part.replace(/[^A-Za-z0-9_]/g, ""))
      .join("/");
    if (new RegExp(`^(/v\\d+\\.\\d+)?${pattern}$`).test(path)) return row;
  }
  return null;
}

/**
 * M11, the client's key-set check (spec check 3): the first key of `params_keys` outside its row's key set, the
 * union of the row's `keys` lists, `execution_options` aside; `null` when every key is in it. A dotted key is in the
 * set when the set lists it, or lists its prefix up to a bounded name (`sub_keys`); deeper paths are the guard's
 * (rule 8, §5.1). A write that matches no row has an empty set (`row: "no row"`).
 */
export function keySetMiss(d: Descriptor): { key: string; row: string } | null {
  const row = matchEndpoint(d.method, d.path, d.object.type);
  const set = new Set(row ? Object.values(row.keys).flat() : []);
  const inSet = (key: string): boolean => {
    if (set.has(key)) return true;
    const parts = key.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      if (Object.hasOwn(ENDPOINTS.sub_keys, parts[i]) && set.has(parts.slice(0, i + 1).join("."))) return true;
    }
    return false;
  };
  const key = d.params_keys.find((k) => k !== "execution_options" && !inSet(k));
  return key === undefined ? null : { key, row: row ? row.id : "no row" };
}

/** The video upload host (contract 1.1 §2, C14): it takes only the `host_rows` rows, `POST /act_{id}/advideos`. */
export const VIDEO_HOST = "graph-video.facebook.com";

/**
 * Contract §2 (1.1, C14), the fake's `hostAllowed` on `ENDPOINTS`: whether the client may send this request to this
 * host. A host outside `host_list`: never. A host without `host_rows`: any request. Otherwise only a request matching
 * one of its rows (matched with object type `video`, so a GET matches none). `host` is the URL's `host`, port
 * included, matched exactly.
 */
export function hostAllowed(method: string, host: string, path: string): boolean {
  if (!ENDPOINTS.host_list.includes(host)) return false;
  const only = ENDPOINTS.host_rows[host];
  if (!only) return true;
  const row = matchEndpoint(method, path, "video");
  return row !== null && only.includes(row.id);
}

const INLINE_POST_FIELDS: readonly string[] = ["source_instagram_media_id", "object_story_id"];

/** A request's kind (contract §4): the row's kind, refined where the path alone does not decide. */
export function deriveKind(
  row: EndpointRow | null,
  d: Pick<Descriptor, "identity" | "params_keys" | "status">,
): Kind {
  if (!row) return "other";
  if (row.refine === "boost-if-inline-post") {
    const inlinePost = d.identity.some((e) => e.via === "creative" && INLINE_POST_FIELDS.includes(e.field));
    return inlinePost ? "boost" : row.kind;
  }
  if (row.refine === "delete-if-status-deleted") {
    const keys = d.params_keys.filter((k) => k !== "execution_options");
    const onlyStatus = keys.length === 1 && keys[0] === "status";
    return onlyStatus && d.status.after === "DELETED" ? "delete" : row.kind;
  }
  return row.kind;
}

/** Whether a write carries a creative, so rule 1's Instagram identity check applies (contract §4). */
export function deriveCreativeBearing(row: EndpointRow | null, d: Pick<Descriptor, "params_keys">): boolean {
  if (!row) return false;
  if (row.creative_bearing === "always") return true;
  if (row.creative_bearing === "if-creative-key") return d.params_keys.includes("creative");
  return false;
}

/** Whether a request touches the account's limits or billing (contract §4.1, interpretation I2). */
export function deriveAccountLimit(
  row: EndpointRow | null,
  d: Pick<Descriptor, "object" | "path" | "params_keys">,
): boolean {
  if (d.object.type === "account") return true;
  if (!row) return /^\/(v\d+\.\d+\/)?act_\d+/.test(d.path);
  if (row.account_limit === "always") return true;
  if (row.account_limit === "never") return false;
  const rule = ENDPOINTS.account_limit_keys;
  return d.params_keys.some((key) => {
    const k = key.toLowerCase();
    if (rule.except.includes(k)) return false;
    if (k === "spend_cap") return !rule.spend_cap_allowed_rows.includes(row.id);
    return (
      rule.exact.includes(k) || rule.prefix.some((p) => k.startsWith(p)) || rule.contains.some((c) => k.includes(c))
    );
  });
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
// A value that is not a leaf (contract §3 params_keys): an object, or an array holding one (at any depth).
const holdsObject = (x: unknown): boolean => isObj(x) || (Array.isArray(x) && x.some(holdsObject));

// The leaf paths of a bounded object's value, relative to it: keys joined by dots, array indices dropped. A
// non-object inside an array of objects is a leaf at the array's own path, so it cannot pass unseen; directly
// inside the bounded key's own array that path is "" (no sub_keys entry), which paramsKeys drops and
// admittedCreativeSpec refuses.
function leafPaths(value: unknown, prefix: string, out: string[]): void {
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) leafPaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (Array.isArray(value) && value.some(holdsObject)) {
    for (const e of value) {
      if (!prefix && !holdsObject(e)) out.push("");
      else leafPaths(e, prefix, out);
    }
  } else if (prefix) {
    out.push(prefix);
  }
}

const SUB_KEYS = new Map(Object.entries(ENDPOINTS.sub_keys));

// One level of params: each key, and a bounded object's leaf paths after it.
function levelKeys(params: Readonly<Record<string, unknown>>, at: string, out: string[]): void {
  for (const [key, value] of Object.entries(params)) {
    out.push(`${at}${key}`);
    if (!SUB_KEYS.has(key)) continue;
    const paths: string[] = [];
    leafPaths(value, "", paths);
    for (const p of paths) if (p) out.push(`${at}${key}.${p}`);
  }
}

/** Contract §3 `params_keys`: every key sent but `access_token`; an inline creative's keys; bounded leaf paths. */
export function paramsKeys(params: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const { access_token: _token, ...rest } = params;
  for (const [key, value] of Object.entries(rest)) {
    levelKeys({ [key]: value }, "", out);
    if (key === "creative" && isObj(value)) levelKeys(value, "creative.", out);
  }
  return [...new Set(out)];
}

// The ad-create row's `creative.<k>` keys, without `creative_id` (an attached creative's id, not a creative field).
const AD_CREATE_ROW = ENDPOINTS.rows.find((r) => r.id === "POST /act_{id}/ads");
const CREATIVE_KEYS: readonly string[] = [
  ...new Set(
    Object.values(AD_CREATE_ROW?.keys ?? {})
      .flat()
      .filter((k) => k.startsWith("creative."))
      .map((k) => k.slice("creative.".length)),
  ),
].filter((k) => k !== "creative_id");

/**
 * Contract §5's creative keys left out of every key set: read, so admittedCreativeSpec sees and refuses them.
 * `interactive_components_spec` left the key sets at 1.1 (C10) and is still read (C12: §3.3 and §5 name it).
 */
const LEFT_OUT_CREATIVE_KEYS = [
  "branded_content",
  "facebook_branded_content",
  "instagram_branded_content",
  "product_set_id",
  "template_url_spec",
  "applink_treatment",
  "interactive_components_spec",
  "creative_sourcing_spec",
  "destination_spec",
  "wamo_whatsapp_identity_spec",
] as const;

/**
 * The fields of an attached creative's GET (contract §3.2 `creative_id`; ruling R1; 1.1 C12): exactly the creative
 * keys §3.2, §3.3 and §5 name, from the 1.1 table's creative keys and §5's left-out ones.
 */
export const CREATIVE_READ_FIELDS: string = [
  ...CREATIVE_KEYS,
  "effective_object_story_id",
  "actor_id",
  "instagram_actor_id",
  ...LEFT_OUT_CREATIVE_KEYS,
].join(",");

const ADMITTED_CREATIVE_KEYS = new Set([
  ...CREATIVE_KEYS,
  "id",
  "account_id",
  "effective_object_story_id",
  "actor_id",
  "instagram_actor_id",
]);

/** Whether a creative as read holds only keys a key set admits, and bounded objects only their §5.1 paths. */
export function admittedCreativeSpec(spec: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(spec)) {
    if (!ADMITTED_CREATIVE_KEYS.has(key)) return false;
    const allowed = SUB_KEYS.get(key);
    if (!allowed) continue;
    if (!isObj(value) && !(Array.isArray(value) && value.some(holdsObject))) return false;
    const paths: string[] = [];
    leafPaths(value, "", paths);
    // An empty bounded object has no path: in a request it goes to rule 8, so it is not admitted here either.
    if (paths.length === 0 || !paths.every((p) => allowed.includes(p))) return false;
  }
  return true;
}

// Meta's removal value for a campaign spend_cap (contract §6): no cap, so null.
const SPEND_CAP_REMOVAL = 922337203685478;

/** An amount in minor units: a safe integer ≥ 0, or its decimal string. Anything else, and §6's removal value, is null. */
export function minorAmount(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\d{1,16}$/.test(v)) n = Number(v);
  else return null;
  if (!Number.isSafeInteger(n) || n < 0 || n === SPEND_CAP_REMOVAL) return null;
  return n + 0; // -0 → 0
}

// Graph `metadata.type` names for each object type. Meta's live names are unconfirmed (258): a wrong guess is
// `other`, which fails closed.
const TYPE_ALIASES: ReadonlyMap<string, ObjectType> = new Map<string, ObjectType>([
  ["campaign", "campaign"],
  ["adcampaign_group", "campaign"],
  ["adset", "adset"],
  ["adcampaign", "adset"],
  ["ad", "ad"],
  ["adgroup", "ad"],
  ["adcreative", "creative"],
  ["adimage", "image"],
  ["advideo", "video"],
  ["video", "video"],
  ["customaudience", "audience"],
  ["customconversion", "custom_conversion"],
  ["adstudy", "study"],
  ["ad_study", "study"],
  ["budget_schedule", "budget_schedule"],
  ["post", "page_post"],
  ["page_post", "page_post"],
  ["pagepost", "page_post"],
  ["adaccount", "account"],
]);

/** The contract object type of a Graph `metadata.type`; unknown is `other`. */
export function objectTypeOf(metadataType: unknown): ObjectType {
  return (typeof metadataType === "string" && TYPE_ALIASES.get(metadataType)) || "other";
}

// Graph v27 answers no metadata.type, and a whole read fails if one field is wrong for the kind, so each field is read
// alone. A creative answers 200 for fields it lacks, so only a present value counts.
export const TYPE_PROBES: ReadonlyArray<readonly [string, ObjectType | "page"]> = [
  ["objective", "campaign"],
  ["optimization_goal", "adset"],
  ["adset_id", "ad"],
  ["object_story_spec", "creative"],
  ["effective_object_story_id", "creative"],
  ["fan_count", "page"],
];

const PROBED_TYPES: ReadonlySet<ObjectType> = new Set<ObjectType>(["campaign", "adset", "ad", "creative", "account"]);
const presentField = (v: unknown): boolean =>
  (typeof v === "string" && v.length > 0) ||
  (typeof v === "number" && Number.isFinite(v)) ||
  (isObj(v) && Object.keys(v).length > 0);

// The client keeps no Meta code on its McpError, so code 10 is known by the classifier's own wording.
const CODE_10_PREFIX = classifyMetaError({ message: "", type: "", code: 10 }).mcpError.message.replace(/\(Meta: \)$/, "(Meta: ");
const isCode10 = (err: unknown): boolean => err instanceof McpError && err.message.startsWith(CODE_10_PREFIX);
const POST_ID = /^(\d{1,30})_\d{1,30}$/;

/** A create row's id → the type it creates (contract §3 `object.type`, "for a create, the type being created"). */
export const CREATED_TYPE: Readonly<Record<string, ObjectType>> = {
  "POST /act_{id}/campaigns": "campaign",
  "POST /act_{id}/adsets": "adset",
  "POST /act_{id}/ads": "ad",
  "POST /act_{id}/adcreatives": "creative",
  "POST /act_{id}/adimages": "image",
  "POST /act_{id}/advideos": "video",
  "POST /act_{id}/customaudiences": "audience",
  "POST /act_{id}/customconversions": "custom_conversion",
  "POST /{business_id}/ad_studies": "study",
  "POST /{campaign_id}/budget_schedules": "budget_schedule",
};

// Contract §3.2's fields as a request carries them, each path equal to its field name.
const REQUEST_IDENTITY_FIELDS = [
  "object_id",
  "object_story_id",
  "instagram_user_id",
  "instagram_actor_id",
  "source_instagram_media_id",
  "pixel_id",
  "object_story_spec.page_id",
  "object_story_spec.instagram_user_id",
  "object_story_spec.link_data.call_to_action.value.lead_gen_form_id",
  "object_story_spec.video_data.call_to_action.value.lead_gen_form_id",
  "promoted_object.page_id",
  "promoted_object.pixel_id",
  "objectives.adspixels.id",
] as const satisfies readonly IdentityField[];

/**
 * Where each contract §3.2 field is read in a request: `direct` from the body's top level, `creative` from an
 * inline `creative`, each entry both the field and its dotted path. An id inside `asset_feed_spec` is read by
 * its leaf's last key instead (`ASSET_FEED_KINDS`): no §5.1 `asset_feed_spec` path carries an id.
 */
export const IDENTITY_FIELDS: Readonly<{ direct: readonly IdentityField[]; creative: readonly IdentityField[] }> = {
  direct: REQUEST_IDENTITY_FIELDS,
  creative: REQUEST_IDENTITY_FIELDS,
};

/**
 * Contract 1.1 §3.2 `via: "asset_feed_spec"` (C5, C17): the identity kinds a leaf inside an `asset_feed_spec` can
 * name, by the leaf's last key, each to the §3.2 field of its kind. A leaf whose last key is one of these and whose
 * value is a Graph id is an entry; its path stays in `params_keys`, outside §5.1, so rule 8 decides once rule 1 has
 * passed. Any other leaf, or a value that is not a Graph id, is no entry, and its path reaches `params_keys` too.
 */
export const ASSET_FEED_KINDS: Readonly<Record<string, IdentityField>> = {
  page: "object_story_spec.page_id",
  page_id: "object_story_spec.page_id",
  instagram_user_id: "object_story_spec.instagram_user_id",
  instagram_actor_id: "object_story_spec.instagram_user_id",
  lead_gen_form_id: "object_story_spec.link_data.call_to_action.value.lead_gen_form_id",
  pixel_id: "promoted_object.pixel_id",
};

// Every leaf of an `asset_feed_spec` value as [last key, value], walked as leafPaths walks it (array indices
// dropped; a non-object in an array of objects is a leaf at the array's own key).
function assetFeedLeaves(value: unknown, key: string, out: Array<[string, unknown]>): void {
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) assetFeedLeaves(v, k, out);
  } else if (Array.isArray(value) && value.some(holdsObject)) {
    for (const e of value) {
      if (holdsObject(e)) assetFeedLeaves(e, key, out);
      else if (key) out.push([key, e]);
    }
  } else if (key) {
    out.push([key, value]);
  }
}

/** Spec M16: the object types an id-taking tool may write; a GET type outside its list is refused. */
export const TOOL_EXPECTED_TYPES: Readonly<Record<string, readonly ObjectType[]>> = {
  ads_update_campaign: ["campaign"],
  ads_delete_campaign: ["campaign"],
  ads_update_ad_set: ["adset"],
  ads_delete_ad_set: ["adset"],
  ads_update_ad: ["ad"],
  ads_delete_ad: ["ad"],
  ads_update_ad_creative: ["creative"],
  ads_experiment_abtest_update_test: ["study"],
  ads_update_custom_audience: ["audience"],
  ads_delete_custom_audience: ["audience"],
};

/** The only tools that may write an `act_<n>` node path (`/act_<n>`, no edge) (spec M16; P15). */
export const ACCOUNT_TOOLS: ReadonlySet<string> = new Set(["ads_update_spend_cap", "ads_update_entity"]);

// validateDescriptor: the fake's field tables (contract §3), ported.
type Pred = (x: unknown) => boolean;
const V = CONTRACT_VERSION;
const PATH_RE = /^\/(v\d+\.\d+\/)?[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
const KINDS: readonly Kind[] = ["create", "update", "delete", "copy", "study", "budget-schedule", "post-edit", "boost", "other"];
const OBJECT_TYPES: readonly ObjectType[] = [
  "campaign",
  "adset",
  "ad",
  "creative",
  "image",
  "video",
  "audience",
  "custom_conversion",
  "study",
  "budget_schedule",
  "page_post",
  "account",
  "other",
];
const STATUSES: readonly string[] = ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"];
const EFFECTIVE_STATUSES: readonly string[] = ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"];
const BUDGET_KINDS: readonly string[] = ["daily", "lifetime"];
const ROLES: readonly string[] = ["self", "parent", "destination", "study-cell"];
const VIAS: readonly string[] = ["direct", "creative", "creative_id", "source_ad", "asset_feed_spec"];

const isStr: Pred = (x) => typeof x === "string" && x.length > 0;
const isMinor: Pred = (x) => Number.isSafeInteger(x) && (x as number) >= 0;
const orNull =
  (pred: Pred): Pred =>
  (x) =>
    x === null || pred(x);
const oneOf =
  (list: readonly unknown[]): Pred =>
  (x) =>
    list.includes(x);
const isAct: Pred = (x) => typeof x === "string" && /^act_\d+$/.test(x);
const hasOwnerKey = (x: unknown): x is IdentityField => typeof x === "string" && Object.hasOwn(OWNER_KEY, x);

// Checks one object against a {key: predicate} shape: every key present, no others.
function checkShape(where: string, value: unknown, shape: Readonly<Record<string, Pred>>, problems: string[]): void {
  if (!isObj(value)) {
    problems.push(`${where} must be an object`);
    return;
  }
  for (const [key, pred] of Object.entries(shape)) {
    if (!Object.hasOwn(value, key)) problems.push(`${where}.${key} is missing`);
    else if (!pred(value[key])) problems.push(`${where}.${key} is invalid: ${JSON.stringify(value[key])}`);
  }
  for (const key of Object.keys(value))
    if (!Object.hasOwn(shape, key)) problems.push(`${where}.${key} is not a contract field`);
}

const TOP: Readonly<Record<string, Pred>> = {
  v: (x) => x === V,
  request_id: isStr,
  tool: isStr,
  method: oneOf(["POST", "DELETE"]),
  path: (x) => typeof x === "string" && PATH_RE.test(x),
  params_keys: (x) => Array.isArray(x) && x.every(isStr) && new Set(x).size === x.length,
  ad_account: orNull(isAct),
  account: isObj,
  object: isObj,
  status: isObj,
  budget: isObj,
  campaigns: Array.isArray,
  identity: Array.isArray,
  kind: oneOf(KINDS),
  account_limit: (x) => typeof x === "boolean",
  validate_only: (x) => typeof x === "boolean",
};
const ACCOUNT: Readonly<Record<string, Pred>> = { spend_cap_minor: orNull(isMinor), amount_spent_minor: orNull(isMinor) };
const OBJECT: Readonly<Record<string, Pred>> = {
  type: oneOf(OBJECT_TYPES),
  id: orNull(isStr),
  created: (x) => typeof x === "boolean",
};
const STATUS: Readonly<Record<string, Pred>> = { before: orNull(oneOf(STATUSES)), after: orNull(oneOf(STATUSES)) };
const BUDGET: Readonly<Record<string, Pred>> = {
  currency: orNull((x) => typeof x === "string" && /^[A-Z]{3}$/.test(x)),
  kind_before: orNull(oneOf(BUDGET_KINDS)),
  kind_after: orNull(oneOf(BUDGET_KINDS)),
  before_minor: orNull(isMinor),
  after_minor: orNull(isMinor),
  end_time: orNull(isStr),
};
const CAMPAIGN: Readonly<Record<string, Pred>> = {
  id: orNull(isStr),
  account_id: orNull(isAct),
  created: (x) => typeof x === "boolean",
  role: oneOf(ROLES),
  spend_cap_minor_before: orNull(isMinor),
  spend_cap_minor_after: orNull(isMinor),
  name: orNull(isStr),
  status_after: orNull(oneOf(EFFECTIVE_STATUSES)),
  buying_type: orNull(isStr),
};
const IDENTITY: Readonly<Record<string, Pred>> = {
  field: hasOwnerKey,
  via: oneOf(VIAS),
  id: isStr,
  owner_page: orNull(isStr),
  owner_ig: orNull(isStr),
};

/** Problems with a descriptor against the contract's field tables (§3); empty when it is valid. */
export function validateDescriptor(d: unknown): string[] {
  const problems: string[] = [];
  checkShape("descriptor", d, TOP, problems);
  if (!isObj(d)) return problems;
  if (isObj(d.account)) checkShape("account", d.account, ACCOUNT, problems);
  if (isObj(d.object)) checkShape("object", d.object, OBJECT, problems);
  if (isObj(d.status)) checkShape("status", d.status, STATUS, problems);
  if (isObj(d.budget)) checkShape("budget", d.budget, BUDGET, problems);
  for (const [i, c] of (Array.isArray(d.campaigns) ? d.campaigns : []).entries()) {
    checkShape(`campaigns[${i}]`, c, CAMPAIGN, problems);
  }
  for (const [i, e] of (Array.isArray(d.identity) ? d.identity : []).entries()) {
    checkShape(`identity[${i}]`, e, IDENTITY, problems);
    if (!isObj(e) || !hasOwnerKey(e.field)) continue;
    // A creative_id entry exists only when the creative's GET failed: unresolved, so its carrier is null too.
    if (e.field === "creative_id" && e.owner_page !== null)
      problems.push(`identity[${i}].owner_page must be null for creative_id`);
    for (const key of ["owner_page", "owner_ig"] as const) {
      if (key !== OWNER_KEY[e.field] && key in e && e[key] !== null) {
        problems.push(`identity[${i}].${key} must be null for ${e.field}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// buildDescriptor: the descriptor of a write, from its request and the fork's own GETs (contract §3, §3.1, §3.2).
// Every read is wrapped: a read that throws or answers no object is null, and what it would have given is null
// (or, for a listing, a fail-closed entry), so the guard refuses wherever its rules need the value.

/** A Graph GET, injected so the builder reads through the client's own read path. */
export type GraphGet = <T>(path: string, params: Record<string, string | number>) => Promise<T>;

/** A write as the client is about to send it, its params decoded (objects, not form strings). */
export interface WriteRequest {
  method: "POST" | "DELETE";
  path: string;
  params: Readonly<Record<string, unknown>>;
}

export interface BuildContext {
  tool: string;
  validateOnly: boolean;
  requestId: string;
  /** The ad accounts this session has read; a Page post's write lands in the one account when there is one. */
  accounts: ReadonlySet<string>;
}

type Obj = Record<string, unknown>;

const OBJECT_FIELDS: Readonly<Partial<Record<ObjectType, string>>> = {
  campaign: "account_id,status,effective_status,name,spend_cap,buying_type,daily_budget,lifetime_budget,stop_time",
  adset: "account_id,status,campaign_id,daily_budget,lifetime_budget,end_time",
  ad: "account_id,status,adset_id,campaign_id,creative{id}",
  creative: "account_id",
  study: "business{id}",
};
const CAMPAIGN_FIELDS = "account_id,name,spend_cap,effective_status,buying_type";
const ACCOUNT_FIELDS = "spend_cap,amount_spent,currency";
// Rule 10's bounds: the ads of a copy and the cells of a study.
const COPY_ADS_BOUND = 200;
const STUDY_CELLS_BOUND = 50;
const LIST_LIMIT = 100;
// Contract §3.2: how each identity field's id is resolved, and which owner key carries it.
type Resolution = { fields: string; owner: (a: Obj) => unknown };
const RESOLVE: Readonly<Partial<Record<IdentityField, Resolution>>> = (() => {
  const itself: Resolution = { fields: "id", owner: (a) => a.id };
  const nested = (key: string): Resolution => ({
    fields: `${key}{id}`,
    owner: (a) => (isObj(a[key]) ? (a[key] as Obj).id : undefined),
  });
  return {
    "object_story_spec.page_id": itself,
    "promoted_object.page_id": itself,
    object_id: itself,
    object_story_id: nested("from"),
    "object_story_spec.link_data.call_to_action.value.lead_gen_form_id": nested("page"),
    "object_story_spec.video_data.call_to_action.value.lead_gen_form_id": nested("page"),
    "object_story_spec.instagram_user_id": itself,
    instagram_user_id: itself,
    instagram_actor_id: itself,
    source_instagram_media_id: nested("owner"),
  };
})();
// A creative GET's own names for two §3.2 fields.
const CREATIVE_READ_ALIASES: ReadonlyArray<[string, IdentityField]> = [
  ["actor_id", "object_story_spec.page_id"],
  ["effective_object_story_id", "object_story_id"],
];

// A Graph id: digits, or `<digits>_<digits>` for a Page post. Nothing else is put in a GET path.
const GRAPH_ID = /^\d{1,30}(_\d{1,30})?$/;
const idString = (x: unknown): string | null =>
  typeof x === "string" && x.length > 0 ? x : Number.isSafeInteger(x) && (x as number) >= 0 ? String(x) : null;
const graphId = (x: unknown): string | null => {
  const s = idString(x);
  return s !== null && GRAPH_ID.test(s) ? s : null;
};
const actOf = (x: unknown): string | null => {
  const s = idString(x);
  if (s === null) return null;
  if (/^act_\d+$/.test(s)) return s;
  return /^\d+$/.test(s) ? `act_${s}` : null;
};
const strOrNull = (x: unknown): string | null => (typeof x === "string" && x.length > 0 ? x : null);
const statusOf = (x: unknown): ObjectStatus | null => (STATUSES.includes(x as string) ? (x as ObjectStatus) : null);
const effectiveOf = (x: unknown): EffectiveStatus | null =>
  EFFECTIVE_STATUSES.includes(x as string) ? (x as EffectiveStatus) : null;
const has = (o: Readonly<Obj>, k: string): boolean => Object.hasOwn(o, k);

// Rule 11: a value the builder would read inside must be readable, or the write is refused. A bounded object
// (§5.1) or an inline creative's bounded object is an object or an array of objects; `creative` is an object;
// `cells` and `objectives` are arrays of objects; no object inside any of them has an empty key.
function assertReadable(params: Readonly<Obj>): void {
  const refuse = (key: string): never => {
    throw new WriteRefusal(`${key} is not an object`);
  };
  const emptyKey = (x: unknown): boolean =>
    Array.isArray(x) ? x.some(emptyKey) : isObj(x) && Object.entries(x).some(([k, v]) => k === "" || emptyKey(v));
  const objects = (x: unknown): boolean => isObj(x) || (Array.isArray(x) && x.every(isObj));
  const check = (key: string, value: unknown, ok: boolean): void => {
    if (!ok || emptyKey(value)) refuse(key);
  };
  for (const [key, value] of Object.entries(params)) {
    if (key === "cells" || key === "objectives") check(key, value, Array.isArray(value) && value.every(isObj));
    else if (key === "creative") {
      check(key, value, isObj(value));
      for (const [ck, cv] of Object.entries(value as Obj)) if (SUB_KEYS.has(ck)) check(`creative.${ck}`, cv, objects(cv));
    } else if (SUB_KEYS.has(key)) check(key, value, objects(value));
  }
}

// The cell keys the builder reads (contract §3.1 study-cell). Every other cell key is left to the guard: `cells` is
// bounded at 1.1 (C10), so each cell key's path is in params_keys and §5.1 decides it (rule 8: `cells.adaccounts`).
const CELL_ID_LISTS = ["campaigns", "adsets"] as const;
const STATUS_OPTIONS = ["ACTIVE", "PAUSED", "INHERITED_FROM_SOURCE"];

// A request value that names a Graph object must be one: a value present but unreadable refuses, never drops.
function requestId(key: string, value: unknown): string {
  const id = graphId(value);
  if (id === null) throw new WriteRefusal(`${key} is not an id`);
  return id;
}

// Every request value the builder reads, checked before any GET (T4-1, T4-3): identity ids, an attached
// creative, parent and destination ids, study cells, status, status_option and the end time. A key present
// with a value of the wrong shape refuses; one absent is left to the rules.
function assertRequestValues(params: Readonly<Obj>): void {
  for (const field of IDENTITY_FIELDS.direct) for (const v of valuesAt(params, field.split("."))) requestId(field, v);
  if (has(params, "creative_id")) requestId("creative_id", params.creative_id);
  if (isObj(params.creative)) {
    const creative = params.creative;
    for (const field of IDENTITY_FIELDS.creative) {
      for (const v of valuesAt(creative, field.split("."))) requestId(`creative.${field}`, v);
    }
    if (has(creative, "creative_id")) requestId("creative.creative_id", creative.creative_id);
  }
  for (const key of ["campaign_id", "adset_id"]) if (has(params, key)) requestId(key, params[key]);
  if (has(params, "status") && statusOf(params.status) === null) throw new WriteRefusal("status is not a status");
  if (has(params, "status_option") && !STATUS_OPTIONS.includes(params.status_option as string)) {
    throw new WriteRefusal("status_option is not a status option");
  }
  for (const key of ["end_time", "stop_time"]) {
    if (has(params, key) && strOrNull(params[key]) === null && !Number.isSafeInteger(params[key])) {
      throw new WriteRefusal(`${key} is not a time`);
    }
  }
  for (const cell of Array.isArray(params.cells) ? (params.cells as Obj[]) : []) {
    for (const [k, v] of Object.entries(cell)) {
      if (!(CELL_ID_LISTS as readonly string[]).includes(k)) continue;
      if (!Array.isArray(v)) throw new WriteRefusal(`cells.${k} is not a list of ids`);
      for (const e of v) {
        const onlyId = isObj(e) && Object.keys(e).length === 1 && has(e, "id");
        requestId(`cells.${k}`, onlyId ? e.id : e);
      }
    }
  }
}

// Every value at a dotted path, through arrays at any step.
function valuesAt(value: unknown, path: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value.flatMap((v) => valuesAt(v, path));
  if (path.length === 0) return [value];
  if (!isObj(value) || !has(value, path[0])) return [];
  return valuesAt(value[path[0]], path.slice(1));
}

// The items of a Graph list or a nested edge ({data: [...]}), or a plain array.
const listItems = (x: unknown): unknown[] =>
  Array.isArray(x) ? x : isObj(x) && Array.isArray(x.data) ? (x.data as unknown[]) : [];
const hasMore = (x: unknown): boolean => isObj(x) && isObj(x.paging) && Boolean((x.paging as Obj).next);

/** Builds the contract §3 descriptor of a write: Task 2's derivations over the request and the fork's GETs. */
export async function buildDescriptor(req: WriteRequest, ctx: BuildContext, get: GraphGet): Promise<Descriptor> {
  const params = req.params;
  assertReadable(params);
  assertRequestValues(params);
  const pkeys = paramsKeys(params);

  // One GET, wrapped: a throw or an answer that is not an object is null. Repeated reads share one answer.
  const cache = new Map<string, Promise<Obj | null>>();
  const readOnce = (path: string, query: Record<string, string | number>): Promise<Obj | null> =>
    get<unknown>(path, query).then(
      (a) => (isObj(a) ? a : null),
      () => null,
    );
  const read = (path: string, query: Record<string, string | number>): Promise<Obj | null> => {
    const key = `${path}?${JSON.stringify(query)}`;
    let p = cache.get(key);
    if (!p) {
      p = readOnce(path, query);
      cache.set(key, p);
    }
    return p;
  };
  const readId = (id: unknown, fields: string): Promise<Obj | null> => {
    const g = graphId(id);
    return g === null ? Promise.resolve(null) : read(`/${g}`, { fields });
  };
  // Every item of a paged list, as readList pages it (rule 10): complete only when Meta ends it within the bound.
  const readListing = async (path: string, fields: string, bound: number): Promise<{ items: unknown[]; complete: boolean }> => {
    const items: unknown[] = [];
    const cursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page <= bound; page++) {
      const query: Record<string, string | number> = { fields, limit: LIST_LIMIT };
      if (after !== undefined) query.after = after;
      const res = await readOnce(path, query);
      if (!res || !Array.isArray(res.data)) return { items, complete: false };
      items.push(...res.data);
      if (items.length > bound) return { items, complete: false };
      if (!hasMore(res)) return { items, complete: true };
      const cursor = isObj(res.paging) && isObj((res.paging as Obj).cursors) ? ((res.paging as Obj).cursors as Obj).after : undefined;
      if (typeof cursor !== "string" || cursor === "" || cursors.has(cursor)) return { items, complete: false };
      cursors.add(cursor);
      after = cursor;
    }
    return { items, complete: false };
  };

  // Contract 1.1 §3 object.type: exactly one kind's field present names the type; anything else fails closed.
  const liveType = async (id: string): Promise<ObjectType> => {
    const answers = await Promise.all(TYPE_PROBES.map(([field]) => read(`/${id}`, { fields: field })));
    const kinds = new Set(TYPE_PROBES.filter(([field], i) => presentField(answers[i]?.[field])).map(([, kind]) => kind));
    if (kinds.size > 1) return "other";
    const [kind] = kinds;
    if (kind === "page") return "other";
    if (kind) return kind;
    const meta = await read(`/${id}`, { metadata: 1, fields: "id" });
    const type = objectTypeOf(meta && isObj(meta.metadata) ? (meta.metadata as Obj).type : undefined);
    return PROBED_TYPES.has(type) ? "other" : type;
  };

  // ---- rule 1: path and object ----
  const segments = req.path.replace(/^\/(v\d+\.\d+\/)?/, "").split("/");
  const node = segments[0] ?? "";
  const pathAct = /^act_\d+$/.test(node) ? node : null;
  const expected = TOOL_EXPECTED_TYPES[ctx.tool];
  const m16 = (id: string, type: ObjectType): never => {
    const types = expected ? expected.join(" or ") : "non-account object";
    throw new WriteRefusal(`${ctx.tool} expects a ${types}, ${id} is a ${type}`);
  };
  // Rule 2 (M16, P2-4): only an account tool writes an account node.
  if (pathAct && segments.length === 1 && !ACCOUNT_TOOLS.has(ctx.tool)) m16(pathAct, "account");

  const anyRow = matchEndpoint(req.method, req.path, "other");
  const createdType = anyRow ? CREATED_TYPE[anyRow.id] : undefined;
  let object: Descriptor["object"];
  let row: EndpointRow | null;
  if (createdType) {
    object = { type: createdType, id: null, created: true };
    row = anyRow;
  } else {
    const type: ObjectType = pathAct ? "account" : graphId(node) ? await liveType(node) : "other";
    object = { type, id: node || null, created: false };
    row = matchEndpoint(req.method, req.path, type);
    // Rule 2 (M16): a tool that names its object type writes only that type.
    if (expected && !expected.includes(type)) m16(node, type);
  }

  // ---- rule 3: the object's own fields ----
  const objectFields = OBJECT_FIELDS[object.type];
  const facts: Obj | null = !object.created && objectFields ? await readId(object.id, objectFields) : null;

  // ---- rule 4: status ----
  const before = object.created ? null : statusOf(facts?.status);
  let after: ObjectStatus | null;
  if (has(params, "status")) after = statusOf(params.status);
  else if (has(params, "status_option")) {
    const option = params.status_option;
    after = option === "ACTIVE" || option === "PAUSED" ? option : option === "INHERITED_FROM_SOURCE" ? before : null;
  } else after = before;
  const status = { before, after };

  // ---- rule 8: campaigns ----
  const isCampaignObject = (id: string): boolean => !object.created && object.type === "campaign" && object.id === id;
  const nullCampaign = (id: string | null, role: CampaignRole): CampaignEntry => ({
    id,
    account_id: null,
    created: false,
    role,
    spend_cap_minor_before: null,
    spend_cap_minor_after: null,
    name: null,
    status_after: null,
    buying_type: null,
  });
  const readCampaign = async (id: string, role: CampaignRole): Promise<CampaignEntry> => {
    const c = await readId(id, CAMPAIGN_FIELDS);
    if (!c) return nullCampaign(id, role);
    const cap = minorAmount(c.spend_cap);
    const own = isCampaignObject(id);
    return {
      id,
      account_id: actOf(c.account_id),
      created: false,
      role,
      spend_cap_minor_before: cap,
      spend_cap_minor_after: own && has(params, "spend_cap") ? minorAmount(params.spend_cap) : cap,
      name: strOrNull(c.name),
      status_after: own && has(params, "status") ? status.after : effectiveOf(c.effective_status),
      buying_type: strOrNull(c.buying_type),
    };
  };
  const createdCampaign = (role: CampaignRole, accountId: string | null, fromParams: boolean): CampaignEntry => ({
    id: null,
    account_id: accountId,
    created: true,
    role,
    spend_cap_minor_before: null,
    spend_cap_minor_after: fromParams ? minorAmount(params.spend_cap) : null,
    name: null,
    status_after: fromParams ? statusOf(params.status) : status.after,
    buying_type: fromParams ? strOrNull(params.buying_type) : null,
  });
  // An ad set's campaign id, by GET.
  const campaignOfAdset = async (adsetId: unknown): Promise<string | null> =>
    idString((await readId(adsetId, "campaign_id"))?.campaign_id);
  // The written object's own campaign: itself, or an ad set's or ad's campaign_id.
  const ownCampaign = (): string | null =>
    object.type === "campaign" ? object.id : object.type === "adset" || object.type === "ad" ? idString(facts?.campaign_id) : null;

  const roles: readonly CampaignRole[] =
    row && row.kind !== "other"
      ? row.roles
      : object.type === "campaign"
        ? ["self"]
        : object.type === "adset" || object.type === "ad"
          ? ["parent"]
          : [];
  const campaigns: CampaignEntry[] = [];
  for (const role of roles) {
    if (role === "self") {
      if (object.created && object.type === "campaign") campaigns.push(createdCampaign("self", pathAct, true));
      else {
        const id = object.type === "budget_schedule" ? graphId(node) : ownCampaign();
        if (id) campaigns.push(await readCampaign(id, "self"));
      }
    } else if (role === "parent") {
      let id: string | null = null;
      if (!object.created) id = ownCampaign();
      else if (object.type === "adset") id = idString(params.campaign_id);
      else if (object.type === "ad") id = await campaignOfAdset(params.adset_id);
      if (id) campaigns.push(await readCampaign(id, "parent"));
    } else if (role === "destination") {
      // Every destination key the body sends is a destination, whatever the source's type (T4-2): Meta lands
      // an ad copy by adset_id and an ad set copy by campaign_id, and the guard must see whichever decides.
      const keyed: string[] = [];
      if (has(params, "campaign_id")) keyed.push(requestId("campaign_id", params.campaign_id));
      if (has(params, "adset_id")) {
        const id = await campaignOfAdset(params.adset_id);
        if (id === null) throw new WriteRefusal(`the campaign of adset_id ${String(params.adset_id)} can't be read`);
        keyed.push(id);
      }
      if (object.type === "campaign") {
        campaigns.push(createdCampaign("destination", actOf(facts?.account_id), false));
      } else if (!has(params, object.type === "ad" ? "adset_id" : "campaign_id")) {
        // The key that decides for this source type is absent: the copy lands in the source's own campaign.
        const id = ownCampaign();
        if (id) campaigns.push(await readCampaign(id, "destination"));
      }
      for (const id of new Set(keyed)) campaigns.push(await readCampaign(id, "destination"));
    } else {
      campaigns.push(...(await studyCampaigns()));
    }
  }

  // Study cells (rule 8, rule 10): the body's cells, and an existing study's cells by listing.
  async function studyCampaigns(): Promise<CampaignEntry[]> {
    const ids: Array<string | null> = [];
    const fromCell = async (cell: unknown, listed: boolean): Promise<void> => {
      if (!isObj(cell)) return void ids.push(null);
      for (const c of listItems(cell.campaigns)) ids.push(idString(isObj(c) ? c.id : c));
      for (const a of listItems(cell.adsets)) {
        ids.push(listed ? idString(isObj(a) ? a.campaign_id : undefined) : await campaignOfAdset(isObj(a) ? a.id : a));
      }
      // A nested edge Meta cut short: its other campaigns are unknown.
      if (hasMore(cell.campaigns) || hasMore(cell.adsets)) ids.push(null);
    };
    for (const cell of Array.isArray(params.cells) ? params.cells : []) await fromCell(cell, false);
    if (!object.created) {
      const listing = await readListing(`/${graphId(object.id) ?? "0"}/cells`, "campaigns{id},adsets{campaign_id}", STUDY_CELLS_BOUND);
      for (const cell of listing.items) await fromCell(cell, true);
      if (!listing.complete) ids.push(null);
    }
    const out: CampaignEntry[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const key = id ?? "";
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id === null ? nullCampaign(null, "study-cell") : await readCampaign(id, "study-cell"));
    }
    return out;
  }

  // ---- rule 6: ad_account ----
  let adAccount: string | null = pathAct ?? actOf(facts?.account_id);
  if (!adAccount) {
    if (object.type === "study") adAccount = campaigns.find((c) => c.role === "study-cell")?.account_id ?? null;
    else if (object.type === "page_post") adAccount = ctx.accounts.size === 1 ? actOf([...ctx.accounts][0]) : null;
    else adAccount = campaigns.find((c) => c.role === "self" || c.role === "parent")?.account_id ?? null;
  }

  // ---- rule 7: the account ----
  const acct = adAccount ? await read(`/${adAccount}`, { fields: ACCOUNT_FIELDS }) : null;
  const account = { spend_cap_minor: minorAmount(acct?.spend_cap), amount_spent_minor: minorAmount(acct?.amount_spent) };

  // ---- rule 5: budget ----
  const budget: Descriptor["budget"] = {
    currency: typeof acct?.currency === "string" && /^[A-Z]{3}$/.test(acct.currency) ? acct.currency : null,
    kind_before: null,
    kind_after: null,
    before_minor: null,
    after_minor: null,
    end_time: null,
  };
  if (object.type === "campaign" || object.type === "adset") {
    if (facts) {
      const daily = minorAmount(facts.daily_budget);
      const lifetime = minorAmount(facts.lifetime_budget);
      const dailyIn = has(facts, "daily_budget") && facts.daily_budget !== null;
      const lifetimeIn = has(facts, "lifetime_budget") && facts.lifetime_budget !== null;
      if ((daily ?? 0) > 0 !== (lifetime ?? 0) > 0) {
        [budget.kind_before, budget.before_minor] = (daily ?? 0) > 0 ? ["daily", daily] : ["lifetime", lifetime];
      } else if ((daily ?? 0) === 0 && (lifetime ?? 0) === 0 && dailyIn !== lifetimeIn) {
        [budget.kind_before, budget.before_minor] = dailyIn ? ["daily", daily] : ["lifetime", lifetime];
      }
    }
    const dailySent = has(params, "daily_budget");
    const lifetimeSent = has(params, "lifetime_budget");
    if (dailySent && !lifetimeSent) [budget.kind_after, budget.after_minor] = ["daily", minorAmount(params.daily_budget)];
    else if (lifetimeSent && !dailySent) [budget.kind_after, budget.after_minor] = ["lifetime", minorAmount(params.lifetime_budget)];
    else if (!dailySent && !lifetimeSent) [budget.kind_after, budget.after_minor] = [budget.kind_before, budget.before_minor];
    const end = has(params, "end_time") ? params.end_time : params.stop_time;
    budget.end_time = strOrNull(end) ?? (Number.isSafeInteger(end) ? String(end) : null);
  }

  // ---- rule 9: identity ----
  const identity: IdentityEntry[] = [];
  const entryKeys = new Set<string>();
  const add = (e: IdentityEntry): void => {
    const key = `${e.field}|${e.via}|${e.id}`;
    if (entryKeys.has(key)) return;
    entryKeys.add(key);
    identity.push(e);
  };
  const unresolvedCreative = (id: string, via: IdentityVia): IdentityEntry => ({
    field: "creative_id",
    via,
    id,
    owner_page: null,
    owner_ig: null,
  });
  // One identity value; false when it is not a readable id (a request's were refused up front, so only a value
  // Graph reported, or one inside an asset_feed_spec, reaches here unreadable: a reported one's creative is then
  // unresolved, and an asset_feed_spec one is no entry). This GRAPH_ID test is the asset_feed_spec entries' Graph-id
  // test (spec check 6).
  // A post id Meta itself reported on a creative: when its owner read is refused with code 10, its prefix is its Page.
  const reportedPostOwner = async (id: string): Promise<string | null> => {
    try {
      const a = await get<unknown>(`/${id}`, { fields: "from{id}" });
      return isObj(a) && isObj(a.from) ? idString(a.from.id) : null;
    } catch (err) {
      return isCode10(err) ? (POST_ID.exec(id)?.[1] ?? null) : null;
    }
  };
  const resolve = async (field: IdentityField, via: IdentityVia, value: unknown, reportedPost: string | null = null): Promise<boolean> => {
    const id = graphId(value);
    if (id === null) return false;
    const ownerKey = OWNER_KEY[field];
    const how = RESOLVE[field];
    let owner: string | null = null;
    if (field === "object_story_id" && id === reportedPost) owner = await reportedPostOwner(id);
    else if (ownerKey && how) {
      const a = await readId(id, how.fields);
      owner = a ? idString(how.owner(a)) : null;
    }
    add({
      field,
      via,
      id,
      owner_page: ownerKey === "owner_page" ? owner : null,
      owner_ig: ownerKey === "owner_ig" ? owner : null,
    });
    return true;
  };
  // Every identity value in a request or a creative as read; true when every one is a readable id.
  const fromRequest = async (source: unknown, fields: readonly IdentityField[], via: IdentityVia, reportedPost: string | null = null): Promise<boolean> => {
    let readable = true;
    for (const field of fields) {
      for (const v of valuesAt(source, field.split("."))) readable = (await resolve(field, via, v, reportedPost)) && readable;
    }
    return readable;
  };
  // A creative read by GET (contract §3.2 creative_id, source_ad): each identity field it holds is an entry; a
  // failed read, or a spec holding a key or path no key set admits, also makes the creative itself one.
  const fromCreative = async (creativeId: unknown, via: IdentityVia): Promise<void> => {
    const cid = idString(creativeId);
    if (cid === null) return;
    const spec = graphId(cid) === null ? null : await read(`/${cid}`, { fields: CREATIVE_READ_FIELDS });
    if (!spec) return add(unresolvedCreative(cid, via));
    const reportedPost = idString(spec.effective_object_story_id);
    let readable = await fromRequest(spec, IDENTITY_FIELDS.creative, via, reportedPost);
    for (const [key, field] of CREATIVE_READ_ALIASES) {
      if (has(spec, key)) readable = (await resolve(field, via, spec[key], reportedPost)) && readable;
    }
    if (!readable || !admittedCreativeSpec(spec)) add(unresolvedCreative(cid, via));
  };

  // Contract 1.1 §3.2 `via: "asset_feed_spec"` (C5, C17; spec check 6): an `asset_feed_spec` sent top-level or
  // in an inline creative. A leaf whose last key is a kind is an entry when `resolve` finds its value a Graph id
  // (GRAPH_ID), resolved as that field is (a lead form to its Page, a pixel to no owner). Only a request's
  // asset_feed_spec: a read creative's goes through admittedCreativeSpec, and an id path there leaves it unresolved.
  const fromAssetFeed = async (spec: unknown): Promise<void> => {
    const leaves: Array<[string, unknown]> = [];
    assetFeedLeaves(spec, "", leaves);
    for (const [key, value] of leaves) {
      if (Object.hasOwn(ASSET_FEED_KINDS, key)) await resolve(ASSET_FEED_KINDS[key], "asset_feed_spec", value);
    }
  };

  await fromRequest(params, IDENTITY_FIELDS.direct, "direct");
  if (has(params, "asset_feed_spec")) await fromAssetFeed(params.asset_feed_spec);
  if (has(params, "creative_id")) await fromCreative(params.creative_id, "creative_id");
  if (isObj(params.creative)) {
    await fromRequest(params.creative, IDENTITY_FIELDS.creative, "creative");
    if (has(params.creative, "asset_feed_spec")) await fromAssetFeed(params.creative.asset_feed_spec);
    if (has(params.creative, "creative_id")) await fromCreative(params.creative.creative_id, "creative_id");
  }
  if (row?.id === "POST /{id}/copies" && object.id) {
    const source = object.id;
    if (object.type === "ad") {
      const cid = isObj(facts?.creative) ? (facts.creative as Obj).id : undefined;
      if (idString(cid) === null) add(unresolvedCreative(source, "source_ad"));
      else await fromCreative(cid, "source_ad");
    } else {
      const listing = await readListing(`/${graphId(source) ?? "0"}/ads`, "creative{id}", COPY_ADS_BOUND);
      for (const ad of listing.items) {
        const cid = isObj(ad) && isObj(ad.creative) ? ad.creative.id : undefined;
        if (idString(cid) === null) add(unresolvedCreative(source, "source_ad"));
        else await fromCreative(cid, "source_ad");
      }
      if (!listing.complete) add(unresolvedCreative(source, "source_ad"));
    }
  }

  // ---- rule 12: assembly ----
  const derived = { identity, params_keys: pkeys, status, object, path: req.path };
  return {
    v: CONTRACT_VERSION,
    request_id: ctx.requestId,
    tool: ctx.tool,
    method: req.method,
    path: req.path,
    params_keys: pkeys,
    ad_account: adAccount,
    account,
    object,
    status,
    budget,
    campaigns,
    identity,
    kind: deriveKind(row, derived),
    account_limit: deriveAccountLimit(row, derived),
    validate_only: pkeys.includes("execution_options"),
  };
}
