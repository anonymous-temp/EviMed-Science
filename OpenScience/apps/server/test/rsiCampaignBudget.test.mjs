import test from 'node:test';
import assert from 'node:assert/strict';
import { RsiCampaignBudget } from '../src/rsiCampaignBudget.mjs';
test('budget cannot bind to an unconfigured or customer deployment',()=>{assert.throws(()=>new RsiCampaignBudget({database:{},configuration:{}}),{code:'campaign_lab_unavailable'});});
