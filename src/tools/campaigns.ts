import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { CAMPAIGN_AMOUNT_LABELS, statedAmounts } from "../meta/account-currency.js";
import { amountLine, currencyOffset, MINOR_UNIT_NOTE } from "../meta/currency.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { CAMPAIGN_DEFAULT_FIELDS } from "../meta/types/campaign.js";
import type { Campaign, MetaApiResponse } from "../meta/types/index.js";
import { READ, CREATE, UPDATE, DELETE, WRITE_WARNING } from "./_register.js";

export const objectiveEnum = z.enum([
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_TRAFFIC",
  "OUTCOME_APP_PROMOTION",
]);

const statusEnum = z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]);

export const bidStrategyEnum = z.enum([
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
]);

export const specialAdCategoryEnum = z.enum([
  "NONE",
  "EMPLOYMENT",
  "HOUSING",
  "CREDIT",
  "FINANCIAL_PRODUCTS_SERVICES",
  "ISSUES_ELECTIONS_POLITICS",
  "ONLINE_GAMBLING_AND_GAMING",
]);

const ADSET_BUDGET_SHARING_EXPLAINER =
  "Ad set budget sharing lets Meta move up to 20% of each ad set's daily budget to other ad sets in the same campaign when that is likely to perform better. It only works when the budget lives on the ad sets (Meta rejects it next to a campaign daily_budget or lifetime_budget, error 4834002), only with daily ad set budgets, and every ad set in the campaign must use the same bid strategy (Meta rejects enabling it without one, error 4834005). Meta recommends true.";

/**
 * Meta's documented value for a campaign spend_cap that removes the cap
 * (minor units). It is sent only from ads_update_campaign's explicit
 * remove_spend_cap flag, never computed from an amount.
 */
export const SPEND_CAP_REMOVAL_MINOR = "922337203685478";

/**
 * The digits of a spend cap given in the account currency's standard unit
 * (1000 = USD 1,000.00). Refuses anything but a positive number written as
 * plain digits with an optional fraction, so exponent forms (1e-7, 1e+21)
 * never reach the conversion.
 */
export function spendCapDigits(amount: unknown): { int: string; frac: string } {
  const match = typeof amount === "number" && amount > 0 ? /^(\d+)(?:\.(\d+))?$/.exec(String(amount)) : null;
  if (!match) throw new Error("spend_cap must be a positive amount written as plain digits, in the account currency's standard unit (1000 = USD 1,000.00).");
  return { int: match[1], frac: match[2] ?? "" };
}

/**
 * A spend cap in the account currency's standard unit as Meta's minor unit,
 * as a decimal string: (1000, "USD") is "100000", (500000, "COP") is
 * "500000". The conversion works on the digits, never on amount * offset,
 * so 0.29 is 29 and not 28. Throws when the amount has more decimal places
 * than the currency's unit allows, when the currency is not in Meta's
 * table, or when the result would be the removal value or above.
 */
export function campaignSpendCapMinor(amount: unknown, currency: string): string {
  const { int, frac } = spendCapDigits(amount);
  const offset = currencyOffset(currency);
  if (offset === undefined) throw new Error(`The account currency ${currency} is not in Meta's currency table, so the spend cap cannot be converted.`);
  const places = String(offset).length - 1;
  if (frac.length > places) {
    throw new Error(`spend_cap ${String(amount)} has more decimal places than ${currency} allows (${places}).`);
  }
  const minor = BigInt(int) * BigInt(offset) + BigInt(frac.padEnd(places, "0") || "0");
  if (minor >= BigInt(SPEND_CAP_REMOVAL_MINOR)) {
    throw new Error(`spend_cap ${String(amount)} ${currency} is at or above Meta's value for "no cap"; use remove_spend_cap to remove a cap.`);
  }
  return minor.toString();
}

/** The account currency of a campaign, read from Meta; throws rather than guess. */
async function campaignCurrency(campaignId: string): Promise<string> {
  const campaign = await metaApiClient.get<{ account_id?: unknown }>(`/${campaignId}`, { fields: "account_id" });
  const accountId = campaign?.account_id;
  if (typeof accountId !== "string" || !/^\d{1,30}$/.test(accountId)) {
    throw new Error(`Meta did not report campaign ${campaignId}'s ad account, so its spend cap was not changed.`);
  }
  const account = await metaApiClient.get<{ currency?: unknown }>(`/act_${accountId}`, { fields: "currency" });
  const currency = account?.currency;
  // currencyOffset takes only a three-letter code in Meta's table.
  if (typeof currency !== "string" || currencyOffset(currency) === undefined) {
    throw new Error(`Meta did not report a known currency for ad account act_${accountId}, so the spend cap was not changed.`);
  }
  return currency.toUpperCase();
}

export function registerCampaignTools(server: McpServer): void {
  // ─── Get Campaigns ───────────────────────────────────────────
  server.registerTool(
    "ads_get_campaigns",
    {
      description:
        "Get campaigns for an ad account. Filter by status to see active, paused, or all campaigns.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().min(1).max(100).default(25),
        status_filter: z
          .array(statusEnum)
          .optional()
          .describe("Filter by status (e.g., ['ACTIVE', 'PAUSED'])"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, status_filter, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...CAMPAIGN_DEFAULT_FIELDS]);
      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (status_filter && status_filter.length > 0) {
        params.filtering = JSON.stringify([
          {
            field: "effective_status",
            operator: "IN",
            value: status_filter,
          },
        ]);
      }

      const response = await metaApiClient.get<MetaApiResponse<Campaign>>(
        `/${id}/campaigns`,
        params,
      );

      const campaigns = response.data ?? [];

      const text =
        campaigns.length === 0
          ? "No campaigns found."
          : campaigns
              .map(
                (c) =>
                  `• ${c.name} (${c.id}) — ${c.status} — Objective: ${c.objective} — Budget: ${c.daily_budget ? `${c.daily_budget}/day` : c.lifetime_budget ? `${c.lifetime_budget} lifetime` : "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${campaigns.length} campaign(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(campaigns, null, 2) },
        ],
      };
    },
  );

  // ─── Get Campaign Details ────────────────────────────────────
  server.registerTool(
    "ads_get_campaign_details",
    {
      description: "Get detailed information about a specific campaign.",
      inputSchema: {
        campaign_id: z.string().describe("Campaign ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ campaign_id, fields }) => {
      const id = validateMetaId(campaign_id, "campaign");
      const fieldsParam = buildFieldsParam(fields, [...CAMPAIGN_DEFAULT_FIELDS]);
      const campaign = await metaApiClient.get<Campaign>(`/${id}`, {
        fields: fieldsParam,
      });

      return {
        content: [
          {
            type: "text",
            text: `Campaign: ${campaign.name}\nID: ${campaign.id}\nStatus: ${campaign.status} (effective: ${campaign.effective_status})\nObjective: ${campaign.objective}\nBuying Type: ${campaign.buying_type}\nBid Strategy: ${campaign.bid_strategy ?? "N/A"}\nDaily Budget: ${campaign.daily_budget ?? "N/A"}\nLifetime Budget: ${campaign.lifetime_budget ?? "N/A"}\nCreated: ${campaign.created_time}`,
          },
          { type: "text", text: JSON.stringify(campaign, null, 2) },
        ],
      };
    },
  );

  // ─── Create Campaign ─────────────────────────────────────────
  server.registerTool(
    "ads_create_campaign",
    {
      description: `${WRITE_WARNING}Create a new Meta advertising campaign. Uses outcome-based (ODAX) objectives. Campaigns are always created PAUSED; turn one on with ads_update_campaign status ACTIVE, which the spend guard checks. Budget belongs at exactly one level: pass daily_budget or lifetime_budget here for a campaign budget, or omit both and set budgets on each ad set. For ad-set budgets Meta requires an explicit is_adset_budget_sharing_enabled; this tool sends false unless you pass true.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).max(400).describe("Campaign name"),
        objective: objectiveEnum.describe(
          "Campaign objective (OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_APP_PROMOTION)",
        ),
        special_ad_categories: z
          .array(specialAdCategoryEnum)
          .default(["NONE"])
          .describe("Special ad categories (NONE, EMPLOYMENT, HOUSING, CREDIT, FINANCIAL_PRODUCTS_SERVICES, ISSUES_ELECTIONS_POLITICS, ONLINE_GAMBLING_AND_GAMING)"),
        daily_budget: z
          .number()
          .optional()
          .describe(`Campaign daily budget ${MINOR_UNIT_NOTE}. Omit to set budgets on the ad sets instead.`),
        lifetime_budget: z
          .number()
          .optional()
          .describe("Campaign lifetime budget, in the account currency's MINOR unit, the same unit as daily_budget. Omit to set budgets on the ad sets instead."),
        is_adset_budget_sharing_enabled: z
          .boolean()
          .optional()
          .describe(`${ADSET_BUDGET_SHARING_EXPLAINER} Marketing API v24.0+ requires this whenever the campaign has no budget of its own; when omitted in that case the tool sends false.`),
        bid_strategy: bidStrategyEnum.optional(),
        buying_type: z.enum(["AUCTION", "RESERVED"]).default("AUCTION"),
        spend_cap: z
          .number()
          .int()
          .positive()
          .max(Number(SPEND_CAP_REMOVAL_MINOR) - 1)
          .optional()
          .describe("Most the campaign may spend over its lifetime, in the account currency's MINOR unit, the same unit as daily_budget (USD 10000 = USD 100.00, COP 500000 = 500,000 pesos). This is NOT the standard unit of the account spend cap (ads_update_spend_cap). Meta's minimum is about USD 100 in the account currency. Changing it later with ads_update_campaign takes the STANDARD unit instead (1000 = USD 1,000.00)."),
        special_ad_category_country: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).optional().describe("Countries (ISO codes) where the special ad categories apply, e.g. [\"CO\"]"),
      },
      annotations: { ...CREATE },
    },
    async ({
      account_id,
      name,
      objective,
      special_ad_categories,
      daily_budget,
      lifetime_budget,
      is_adset_budget_sharing_enabled,
      bid_strategy,
      buying_type,
      spend_cap,
      special_ad_category_country,
    }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, unknown> = {
        name,
        objective,
        status: "PAUSED",
        special_ad_categories: JSON.stringify(special_ad_categories.filter((category) => category !== "NONE")),
        buying_type,
      };

      if (daily_budget !== undefined) body.daily_budget = String(daily_budget);
      if (lifetime_budget !== undefined) body.lifetime_budget = String(lifetime_budget);
      const hasCampaignBudget = daily_budget !== undefined || lifetime_budget !== undefined;
      if (is_adset_budget_sharing_enabled === true && hasCampaignBudget) {
        throw new Error("is_adset_budget_sharing_enabled cannot be true on a campaign with its own daily_budget or lifetime_budget: Meta only shares budget between ad set budgets (error 4834002). Remove the campaign budget, or leave ad set budget sharing off.");
      }
      if (is_adset_budget_sharing_enabled !== undefined) {
        body.is_adset_budget_sharing_enabled = is_adset_budget_sharing_enabled;
      } else if (!hasCampaignBudget) {
        body.is_adset_budget_sharing_enabled = false;
      }
      if (bid_strategy) body.bid_strategy = bid_strategy;
      if (spend_cap !== undefined) {
        // Meta reads its removal value as "no cap": it is never an amount.
        if (spend_cap >= Number(SPEND_CAP_REMOVAL_MINOR)) {
          throw new Error(`spend_cap ${spend_cap} is at or above Meta's value for "no cap"; create the campaign with a cap below it, or with none (remove_spend_cap on ads_update_campaign removes a cap).`);
        }
        body.spend_cap = String(spend_cap);
      }
      if (special_ad_category_country) body.special_ad_category_country = JSON.stringify(special_ad_category_country);

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/campaigns`,
        body as Record<string, string | number | boolean>,
      );

      const budgetSharingLine = body.is_adset_budget_sharing_enabled === undefined
        ? ""
        : `\nAd set budget sharing: ${body.is_adset_budget_sharing_enabled ? "on" : "off"}`;
      const amountLines = await statedAmounts(body, { accountId: id }, CAMPAIGN_AMOUNT_LABELS);

      return {
        content: [
          {
            type: "text",
            text: `Campaign created successfully!\nID: ${result.id}\nName: ${name}\nObjective: ${objective}\nStatus: PAUSED${budgetSharingLine}${amountLines}`,
          },
        ],
      };
    },
  );

  // ─── Update Campaign ─────────────────────────────────────────
  server.registerTool(
    "ads_update_campaign",
    {
      description: `${WRITE_WARNING}Update an existing campaign's name, status, budget, bid strategy, ad set budget sharing, or lifetime spend cap.`,
      inputSchema: {
        campaign_id: z.string().describe("Campaign ID to update"),
        name: z.string().optional(),
        status: statusEnum.optional(),
        daily_budget: z.number().optional().describe(`Daily budget ${MINOR_UNIT_NOTE}.`),
        lifetime_budget: z.number().optional().describe("Lifetime budget, in the account currency's MINOR unit, the same unit as daily_budget. Not the STANDARD unit spend_cap takes here."),
        is_adset_budget_sharing_enabled: z
          .boolean()
          .optional()
          .describe(`${ADSET_BUDGET_SHARING_EXPLAINER} On an existing campaign Meta only supports turning it off; turning it on for a running campaign is rejected (error 3858418). Omit to keep the current setting.`),
        bid_strategy: bidStrategyEnum.optional(),
        spend_cap: z
          .number()
          .positive()
          .optional()
          .describe("Most the campaign may spend over its lifetime, in the account currency's STANDARD unit: 1000 = USD 1,000.00, 500000 = COP 500,000. This is NOT the minor unit of daily_budget, lifetime_budget or ads_create_campaign's spend_cap; the tool reads the account currency and converts. Meta's minimum is about USD 100. The spend guard refuses a cap change sent together with other fields, so send it alone."),
        remove_spend_cap: z
          .boolean()
          .optional()
          .describe("true removes the campaign's spend cap (sends Meta's removal value). Not with spend_cap."),
      },
      annotations: { ...UPDATE },
    },
    async ({ campaign_id, name, status, daily_budget, lifetime_budget, is_adset_budget_sharing_enabled, bid_strategy, spend_cap, remove_spend_cap }) => {
      const id = validateMetaId(campaign_id, "campaign");
      const removeCap = remove_spend_cap === true;
      const setCap = spend_cap !== undefined;
      if (setCap && removeCap) throw new Error("Pass spend_cap or remove_spend_cap, not both.");
      // A cap on act_<n> would be the account's limit, in another unit; a
      // campaign ID is all digits.
      if ((setCap || removeCap) && !/^\d+$/.test(id)) {
        throw new Error(`${id} is not a campaign ID (campaign IDs are numeric), so no spend cap was sent.`);
      }
      if (setCap) spendCapDigits(spend_cap);

      const body: Record<string, string | number | boolean> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (daily_budget !== undefined) body.daily_budget = String(daily_budget);
      if (lifetime_budget !== undefined) body.lifetime_budget = String(lifetime_budget);
      if (is_adset_budget_sharing_enabled !== undefined) {
        body.is_adset_budget_sharing_enabled = is_adset_budget_sharing_enabled;
      }
      if (bid_strategy !== undefined) body.bid_strategy = bid_strategy;
      let capLine = "";
      if (removeCap) {
        body.spend_cap = SPEND_CAP_REMOVAL_MINOR;
        capLine = "\nSpend cap: removed";
      } else if (setCap) {
        const currency = await campaignCurrency(id);
        const minor = campaignSpendCapMinor(spend_cap, currency);
        body.spend_cap = minor;
        capLine = `\n${amountLine("Spend cap", Number(minor), currency)} (spend_cap=${minor})`;
      }

      await metaApiClient.postForm<{ success: boolean }>(
        `/${id}`,
        body,
      );
      const amountLines = (await statedAmounts(body, { entityId: id })) + capLine;

      return {
        content: [
          {
            type: "text",
            text: `Campaign ${id} updated successfully.\nChanges: ${JSON.stringify(body)}${amountLines}`,
          },
        ],
      };
    },
  );

  // ─── Delete Campaign ─────────────────────────────────────────
  server.registerTool(
    "ads_delete_campaign",
    {
      description: `${WRITE_WARNING}Delete a campaign (soft delete — sets status to DELETED). The campaign can still be viewed but will stop serving.`,
      inputSchema: {
        campaign_id: z.string().describe("Campaign ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ campaign_id }) => {
      const id = validateMetaId(campaign_id, "campaign");
      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, {
        status: "DELETED",
      });

      return {
        content: [
          {
            type: "text",
            text: `Campaign ${id} has been deleted (status set to DELETED).`,
          },
        ],
      };
    },
  );
}
