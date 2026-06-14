import { normalizeAppState, withCampaignStats } from "./campaigns.js";

const STATE_KEY = "zapsenderState";

export async function loadState() {
  const result = await chrome.storage.local.get(STATE_KEY);
  return normalizeAppState(result[STATE_KEY] || {});
}

export async function saveState(state) {
  const payload = {
    ...stripDerivedState(normalizeAppState(state)),
    lastUpdated: new Date().toISOString()
  };
  await chrome.storage.local.set({ [STATE_KEY]: payload });
  return withCampaignStats(payload);
}

export function withStats(state) {
  return withCampaignStats(state);
}

export function normalizeStoredState(raw) {
  return normalizeAppState(raw);
}

function stripDerivedState(state) {
  return {
    version: 2,
    activeCampaignId: state.activeCampaignId,
    lastUpdated: state.lastUpdated || null,
    campaigns: (state.campaigns || []).map((campaign) => {
      const { stats: _stats, ...persistedCampaign } = campaign;
      return persistedCampaign;
    })
  };
}
