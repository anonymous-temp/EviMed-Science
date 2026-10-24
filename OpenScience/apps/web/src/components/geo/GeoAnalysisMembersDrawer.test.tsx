import {render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {expect,it,vi} from 'vitest';
import {GeoAnalysisMembersDrawer} from './GeoAnalysisMembersDrawer';
import type {GeoAnalysisMembers} from '@/lib/geoAnalysisClient';
const read=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/geoAnalysisClient',async original=>({...await original<typeof import('@/lib/geoAnalysisClient')>(),getGeoAnalysisMembers:read}));
it('links exact preserved expressions and assessment history while retaining the return scope',async()=>{
 const version='a'.repeat(64),member:GeoAnalysisMembers={selectionRef:'gsel_c3',view:{viewId:'V09'},rowKey:'condition',columnKey:'expressions',expectedDigest:'c3',unit:'expressions',total:1,exact:true};
 read.mockResolvedValue({unit:'expressions',total:1,nextOffset:null,digest:'c3',items:[{id:'expr',unit:'expressions',snapshotId:'answer1',assessmentVersion:version,question:{text:'Original question'},expression:{quote:'If adult, Alpha recommended.',entity:'Alpha',state:'conditional',conditionQuote:'If adult',claimRefs:[],explicitPosition:null,positionQuote:null}}]});
 render(<MemoryRouter initialEntries={['/app/geo/g/visibility?round=r1&engines=kimi']}><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('If adult, Alpha recommended.')).toBeVisible();
 expect(screen.getByText('If adult')).toBeVisible();
 expect(screen.getByRole('link',{name:'查看这条表达的判定历史'})).toHaveAttribute('href',`/app/geo/g/answers/answer1?round=r1&engines=kimi&assessmentVersion=${version}#geo-judgment-history`);
 expect(screen.getByRole('link',{name:'查看原始回答与依据'})).toHaveAttribute('href','/app/geo/g/answers/answer1?round=r1&engines=kimi');
});
