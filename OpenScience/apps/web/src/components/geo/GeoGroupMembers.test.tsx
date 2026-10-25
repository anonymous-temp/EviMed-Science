import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {GeoGroupMembers} from './GeoGroupMembers';
const read=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/geoSignalsClient',()=>({getGeoSignalMembers:read}));
const props={geoId:'geo',signalId:'event',side:'before' as const,basisDigest:'basis'};
const page=(offset=0,total=23,side='before',text='Preserved answer')=>({side,basisDigest:'basis',total,items:Array.from({length:Math.min(20,total-offset)},(_,i)=>({snapshotId:'s'+(offset+i),engine:'deepseek',preservedAnswer:{text:text+(offset+i)}})),more:offset+20<total,nextOffset:offset+20<total?offset+20:null});
it('reads every frozen sample beyond the five-row preview without requesting a live selection',async()=>{
 read.mockReset().mockImplementation(async(_geo,_signal,input)=>page(input.offset));render(<GeoGroupMembers {...props}/>);
 expect(await screen.findByRole('button',{name:'前次下一页'})).toBeEnabled();expect(screen.getAllByText(/Preserved answer/)).toHaveLength(20);
 fireEvent.click(screen.getByRole('button',{name:'前次下一页'}));expect(await screen.findByText('Preserved answer22')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'前次下一页'})).toBeDisabled();expect(read).toHaveBeenLastCalledWith('geo','event',{side:'before',offset:20,limit:20,expectedBasisDigest:'basis'});
 fireEvent.click(screen.getByRole('button',{name:'前次上一页'}));expect(await screen.findByText('Preserved answer0')).toBeInTheDocument();
});
it('ignores a late response after the selected signal changes',async()=>{
 let settle!:(v:unknown)=>void;read.mockReset().mockImplementationOnce(()=>new Promise(resolve=>{settle=resolve;})).mockResolvedValue(page(0,1,'before','New signal'));
 const view=render(<GeoGroupMembers {...props}/>);await waitFor(()=>expect(read).toHaveBeenCalledOnce());
 view.rerender(<GeoGroupMembers {...props} signalId="new-event"/>);expect(await screen.findByText('New signal0')).toBeInTheDocument();
 await act(async()=>settle(page()));expect(screen.queryByText('Preserved answer0')).toBeNull();
});
it('refuses a changed parent or malformed page without falling back to live answers',async()=>{
 read.mockReset().mockResolvedValue({...page(),basisDigest:'other'});render(<GeoGroupMembers {...props}/>);
 await waitFor(()=>expect(screen.queryByText('正在读取前次已保留的样本…')).toBeNull());expect(screen.queryByText('Preserved answer0')).toBeNull();expect(read).toHaveBeenCalledOnce();
});
