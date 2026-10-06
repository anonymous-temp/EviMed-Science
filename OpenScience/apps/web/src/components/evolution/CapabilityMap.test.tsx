import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,expect,it,vi} from 'vitest';
import {CapabilityMap} from './CapabilityMap';
import {fetchEvolutionCapabilityMap} from '@/lib/evolutionClient';
vi.mock('@/lib/evolutionClient',()=>({fetchEvolutionCapabilityMap:vi.fn()}));
const fetchMap = vi.mocked(fetchEvolutionCapabilityMap);
const names = new Map([['analysis','统计分析']]);
beforeEach(()=>vi.resetAllMocks());
it('keeps the loading table while the capability map is being read',()=>{
  fetchMap.mockReturnValue(new Promise(()=>{}));
  const {container} = render(<CapabilityMap names={names} />);
  expect(screen.queryByText('暂无符合条件的研究能力')).not.toBeInTheDocument();
  expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
});
it('shows an empty result without inventing supported capabilities',async()=>{
  fetchMap.mockResolvedValue({cells:[],counts:{},derivedAt:null});
  render(<CapabilityMap names={names} />);
  expect(await screen.findByText('暂无符合条件的研究能力')).toBeInTheDocument();
});
it('retries an unreadable capability map',async()=>{
  fetchMap.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({cells:[],counts:{},derivedAt:null});
  render(<CapabilityMap names={names} />);
  await userEvent.click(await screen.findByRole('button',{name:'重试'}));
  await waitFor(()=>expect(fetchMap).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('暂无符合条件的研究能力')).toBeInTheDocument();
});
it('separates untested capability inventory from demonstrated support',async()=>{
  fetchMap.mockResolvedValue({cells:[{id:'1',capabilityId:'analysis',version:'1',taskFamily:{operation:'compare-groups',estimator:'welch',inputShape:'table',evidenceType:'dataset',deliverable:'report'},status:'untested',dependencies:[],demand:{occurrences:0,distinctAccounts:0},newThisMonth:true}],counts:{untested:1},derivedAt:null});
  render(<CapabilityMap names={names} />);
  expect(await screen.findByText('统计分析')).toBeInTheDocument();
  expect(screen.getByText('尚未验证')).toBeInTheDocument();
  expect(screen.queryByText('已支持')).not.toBeInTheDocument();
  expect(screen.getByText('本月新增')).toBeInTheDocument();
});
