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

it('shows the preserved clinical condition basis for reasonable nonrecommendation',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_support',view:{viewId:'V09'},rowKey:'support',columnKey:'expressions',expectedDigest:'support',unit:'expressions',total:1,exact:true};
 read.mockResolvedValue({unit:'expressions',total:1,nextOffset:null,digest:'support',items:[{id:'supported',unit:'expressions',snapshotId:'answer-support',expression:{quote:'Alpha is contraindicated during pregnancy.',entity:'Alpha',state:'reasonable_nonrecommendation',conditionQuote:'during pregnancy',claimRefs:[{claimId:'c1',claimVersion:3}],explicitPosition:null,positionQuote:null,nonrecommendationBasis:{relation:'supports_nonrecommendation',entity:'Alpha',statementQuote:'Alpha is contraindicated during pregnancy.',conditionQuote:'during pregnancy',claimId:'c1',claimVersion:3,evidenceQuote:'Source confirms Alpha is contraindicated during pregnancy.',evidenceConditionQuote:'during pregnancy'}}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('合理不推荐')).toBeVisible();
 expect(screen.getByText('不推荐的依据原文')).toBeVisible();
 expect(screen.getByText('Source confirms Alpha is contraindicated during pregnancy.')).toBeVisible();
 expect(screen.getByText('条件的依据原文')).toBeVisible();
});

it('opens every preserved source page, original alias and partial judgment without source attribution',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_source',view:{viewId:'V18'},rowKey:'news',columnKey:'answers',expectedDigest:'source-digest',unit:'answers',total:1,exact:true};
 const pages=Array.from({length:251},(_,n)=>({sourceKey:`news.example/s?id=${n+1}`,domain:'news.example',sourceType:'news',originalUrls:[`https://news.example/s?id=${n+1}`],titles:[],snapshotIds:['source-answer']}));
 pages[250].originalUrls.push('http://www.news.example/s?id=251#original');
 read.mockResolvedValue({unit:'answers',total:1,nextOffset:null,digest:'source-digest',items:[{id:'source-answer',unit:'answers',snapshotId:'source-answer',question:{text:'Exact original question'},judgment:{checks:{judgementCoverage:{status:'partial'}}},source:{pages,cooccurrenceOnly:true},answer:{answer_text:'Full preserved source answer',asked_at:null,surface:{mode:'web'},citations:[{url:'https://news.example/s?id=251'}]}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('Exact original question')).toBeVisible();
 screen.getByText('完整来源页面与原始地址').click();
 expect(screen.getByRole('link',{name:'http://www.news.example/s?id=251#original'})).toBeVisible();
 expect(new Set(screen.getAllByRole('link').filter(link=>link.textContent?.startsWith('http')).map(link=>link.getAttribute('href'))).size).toBe(252);
 expect(screen.getByText(/不能据此推断来源导致错误/)).toBeVisible();
});
