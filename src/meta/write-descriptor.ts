// The meta-ads-guard contract layer (docs/contracts/meta-ads-guard.md@1.0 §3-§6): the descriptor's types, the
// endpoint table, and the pure derivations the descriptor builder uses. Nothing here reads Graph or the guard.
// matchEndpoint, deriveKind, deriveAccountLimit, deriveCreativeBearing and validateDescriptor port the
// contract's fake guard (tests/fixtures/meta-ads-guard/fake-guard.mjs) line for line; a test holds them equal.
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

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

// Contract 1.0's endpoints.json, embedded (coverage left out: it is the guard's, not the fork's). A test holds
// it equal to the vendored copy; re-vendor and regenerate together.
export const ENDPOINTS: EndpointTable = {
  v: "1.0",
  host_list: ["graph.facebook.com"],
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
        "paused-create": ["name", "adset_id", "status", "creative", "creative.creative_id", "creative.name", "creative.object_story_spec", "creative.object_story_id", "creative.source_instagram_media_id", "creative.instagram_user_id", "creative.asset_feed_spec", "creative.url_tags", "creative.degrees_of_freedom_spec", "creative.contextual_multi_ads", "creative.object_id", "creative.call_to_action", "creative.image_crops", "creative.interactive_components_spec", "creative.portrait_customizations", "creative.categorization_criteria", "creative.link_url", "creative.platform_customizations", "creative.adlabels", "conversion_domain", "adlabels", "creative_asset_groups_spec", "execution_options"],
        "live-create": ["name", "adset_id", "status", "creative", "creative.creative_id", "creative.name", "creative.object_story_spec", "creative.object_story_id", "creative.source_instagram_media_id", "creative.instagram_user_id", "creative.asset_feed_spec", "creative.url_tags", "creative.degrees_of_freedom_spec", "creative.contextual_multi_ads", "creative.object_id", "creative.call_to_action", "creative.image_crops", "creative.interactive_components_spec", "creative.portrait_customizations", "creative.categorization_criteria", "creative.link_url", "creative.platform_customizations", "creative.adlabels", "conversion_domain", "adlabels", "creative_asset_groups_spec", "execution_options"],
        "boost": ["name", "adset_id", "status", "creative", "creative.creative_id", "creative.name", "creative.object_story_spec", "creative.object_story_id", "creative.source_instagram_media_id", "creative.instagram_user_id", "creative.asset_feed_spec", "creative.url_tags", "creative.degrees_of_freedom_spec", "creative.contextual_multi_ads", "creative.object_id", "creative.call_to_action", "creative.image_crops", "creative.interactive_components_spec", "creative.portrait_customizations", "creative.categorization_criteria", "creative.link_url", "creative.platform_customizations", "creative.adlabels", "conversion_domain", "adlabels", "creative_asset_groups_spec", "execution_options"],
      },
    },
    {
      id: "POST /act_{id}/adcreatives", method: "POST", path: "/{act}/adcreatives", object_type: "any",
      kind: "create", refine: null, no_campaign: true, account_limit: "by-keys",
      roles: [], validate_only: "documented", creative_bearing: "always",
      keys: {
        "no-campaign-create": ["name", "object_story_spec", "object_story_id", "source_instagram_media_id", "instagram_user_id", "asset_feed_spec", "url_tags", "degrees_of_freedom_spec", "contextual_multi_ads", "object_id", "call_to_action", "image_crops", "interactive_components_spec", "portrait_customizations", "categorization_criteria", "link_url", "platform_customizations", "adlabels", "execution_options"],
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
        "edit": ["name", "creative", "creative.creative_id", "creative.name", "creative.object_story_spec", "creative.object_story_id", "creative.source_instagram_media_id", "creative.instagram_user_id", "creative.asset_feed_spec", "creative.url_tags", "creative.degrees_of_freedom_spec", "creative.contextual_multi_ads", "creative.object_id", "creative.call_to_action", "creative.image_crops", "creative.interactive_components_spec", "creative.portrait_customizations", "creative.categorization_criteria", "creative.link_url", "creative.platform_customizations", "creative.adlabels", "execution_options"],
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
// non-object inside an array of objects is a leaf at the array's own path, so it cannot pass unseen.
function leafPaths(value: unknown, prefix: string, out: string[]): void {
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) leafPaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (Array.isArray(value) && value.some(holdsObject)) {
    for (const e of value) leafPaths(e, prefix, out);
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
    for (const p of paths) out.push(`${at}${key}.${p}`);
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

/** Contract §5's creative keys left out of every key set: read, so admittedCreativeSpec sees and refuses them. */
const LEFT_OUT_CREATIVE_KEYS = [
  "branded_content",
  "facebook_branded_content",
  "instagram_branded_content",
  "product_set_id",
  "template_url_spec",
  "applink_treatment",
  "creative_sourcing_spec",
  "destination_spec",
  "wamo_whatsapp_identity_spec",
] as const;

/** The fields of an attached creative's GET (contract §3.2 `creative_id`; ruling R1): every key §3.2 or §5 names. */
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
    if (!paths.every((p) => allowed.includes(p))) return false;
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
  return n;
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
 * inline `creative`, each entry both the field and its dotted path. No `asset_feed_spec` entry: in 1.0 no
 * `sub_keys` leaf path there holds an identity id, so an id elsewhere in it puts its path in `params_keys`,
 * which rule 8 refuses.
 */
export const IDENTITY_FIELDS: Readonly<{ direct: readonly IdentityField[]; creative: readonly IdentityField[] }> = {
  direct: REQUEST_IDENTITY_FIELDS,
  creative: REQUEST_IDENTITY_FIELDS,
};

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
