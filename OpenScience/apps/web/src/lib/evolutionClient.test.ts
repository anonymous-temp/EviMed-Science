import {beforeEach,expect,it,vi} from 'vitest';
import {fetchEvolutionCapabilityMap} from './evolutionClient';
import {productRequest} from './productClient';
vi.mock('./productClient',()=>({productRequest:vi.fn()}));
beforeEach(()=>vi.resetAllMocks());
it('reads the safe capability map endpoint and drops demand below five accounts',async()=>{
  vi.mocked(productRequest).mockResolvedValue({cells:[{id:'1',capabilityId:'analysis',status:'untested',taskFamily:{operation:'extract'},dependencies:[],demand:{occurrences:8,distinctAccounts:4}}],counts:{untested:1},derivedAt:'2026-10-06'});
  const map = await fetchEvolutionCapabilityMap();
  expect(productRequest).toHaveBeenCalledWith('/evolution/capability-map');
  expect(map.cells[0].demand).toEqual({occurrences:0,distinctAccounts:0});
});
it('rejects unknown support labels instead of treating them as supported',async()=>{
  vi.mocked(productRequest).mockResolvedValue({cells:[{id:'1',capabilityId:'analysis',status:'verified',taskFamily:{operation:'extract'}}]});
  expect((await fetchEvolutionCapabilityMap()).cells).toEqual([]);
});
