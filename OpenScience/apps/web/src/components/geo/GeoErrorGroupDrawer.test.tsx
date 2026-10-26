import {act,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {expect,it,vi} from 'vitest';
import {GeoErrorGroupDrawer} from './GeoErrorGroupDrawer';
const read=vi.hoisted(()=>vi.fn());
vi.mock('./geoErrorGroupRead',()=>({readGeoErrorGroup:read}));
vi.mock('./spine/ErrorDrawer',()=>({ErrorDrawer:({claim}:{claim:{key:string;rows:unknown[]}})=><div data-testid="complete-error">{claim.key}:{claim.rows.length}</div>}));
const props={geoId:'geo',project:{} as never,actions:[],groupOf:new Map(),onClose:vi.fn(),onRefreshScope:vi.fn(),selectionRef:'gsel_exact',fingerprint:'first'};
it('loads the whole selected group rather than trusting the current list page',async()=>{
 read.mockResolvedValue({key:'first',rows:[{},{}]});
 render(<MemoryRouter><GeoErrorGroupDrawer {...props}/></MemoryRouter>);
 expect(await screen.findByTestId('complete-error')).toHaveTextContent('first:2');
 expect(read).toHaveBeenCalledWith('geo','gsel_exact','first');
});
it('an absent result does not claim the error has closed or improved',async()=>{
 read.mockResolvedValue(null);render(<MemoryRouter><GeoErrorGroupDrawer {...props}/></MemoryRouter>);
 expect(await screen.findByText('所选范围内没有这条说法')).toBeVisible();
 expect(screen.queryByText(/没有再测到|已经关闭|改善/)).toBeNull();
 expect(screen.queryByTestId('complete-error')).toBeNull();
});
it('rejects a late response after the selected group changes',async()=>{
 let first!:(value:unknown)=>void;
 read.mockReset().mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockResolvedValue({key:'second',rows:[{}]});
 const view=render(<MemoryRouter><GeoErrorGroupDrawer {...props}/></MemoryRouter>);
 await waitFor(()=>expect(read).toHaveBeenCalledOnce());
 view.rerender(<MemoryRouter><GeoErrorGroupDrawer {...props} fingerprint="second"/></MemoryRouter>);
 expect(await screen.findByTestId('complete-error')).toHaveTextContent('second:1');
 await act(async()=>first({key:'first',rows:[{},{}]}));
 expect(screen.getByTestId('complete-error')).toHaveTextContent('second:1');
});
it('a refused read exposes retry and scope refresh without a partial correction action',async()=>{
 read.mockRejectedValue(new Error('Unavailable'));render(<MemoryRouter><GeoErrorGroupDrawer {...props}/></MemoryRouter>);
 expect(await screen.findByRole('button',{name:'重试读取'})).toBeVisible();
 expect(screen.getByRole('button',{name:'刷新范围'})).toBeVisible();
 expect(screen.queryByTestId('complete-error')).toBeNull();
});
