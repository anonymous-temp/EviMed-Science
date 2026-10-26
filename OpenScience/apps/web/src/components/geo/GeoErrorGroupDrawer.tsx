import {Button} from '@/components/ui/Button';
import {Drawer} from '@/components/ui/Drawer';
import {Note} from '@/components/ui/Note';
import {FilesSkeleton} from '@/components/cards/Skeletons';
import {useGeoLoad} from './geoProjectData';
import {readGeoErrorGroup} from './geoErrorGroupRead';
import {ErrorDrawer} from './spine/ErrorDrawer';

type Props=Omit<Parameters<typeof ErrorDrawer>[0],'claim'>&{
  selectionRef:string|null|undefined;
  fingerprint:string;
  onRefreshScope():void;
};

/** The addressed group has its own read state; it cannot alter chart or list pagination. */
export function GeoErrorGroupDrawer({selectionRef,fingerprint,onRefreshScope,...props}:Props){
  const {state,reload}=useGeoLoad(`error-group:${props.geoId}:${selectionRef??'missing'}:${fingerprint}`,
    ()=>readGeoErrorGroup(props.geoId,selectionRef,fingerprint));
  if(state.kind==='loading')return <Drawer title="读取这条说法" onClose={props.onClose}><FilesSkeleton/></Drawer>;
  if(state.kind==='error')return <Drawer title="这条说法暂时无法读取" onClose={props.onClose}>
    <Note action={<div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" onClick={reload}>重试读取</Button><Button variant="text" size="sm" onClick={onRefreshScope}>刷新范围</Button></div>}>{state.message}</Note>
  </Drawer>;
  if(!state.data)return <Drawer title="所选范围内没有这条说法" onClose={props.onClose}>
    <Note action={<Button variant="secondary" size="sm" onClick={onRefreshScope}>刷新范围</Button>}>这次选择未返回对应记录，可刷新范围后重新查看。</Note>
  </Drawer>;
  return <ErrorDrawer {...props} claim={state.data}/>;
}
