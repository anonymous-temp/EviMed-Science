import {useEffect,useId,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';
import {trapTab} from '@/lib/focusTrap';
import {IconButton} from './IconButton';

/** A bounded centered form panel; writes stay visible until their caller settles. */
export function FormDialog({title,children,onClose,busy=false}:{title:string;children:ReactNode;onClose:()=>void;busy?:boolean}) {
 const panel=useRef<HTMLDivElement>(null),titleId=useId(),close=useRef(onClose),working=useRef(busy);
 close.current=onClose;working.current=busy;
 useEffect(()=>{
  const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const field=panel.current?.querySelector<HTMLElement>('input:not(:disabled),textarea:not(:disabled),select:not(:disabled)');
  // A field, or else the panel itself — not the corner 关闭: focusing it shows its tooltip unasked, and the tooltip, the top layer
  // while it is up, takes the reader's first Escape (the Drawer's release-11 finding; a dialog with no field needed two presses).
  (field??panel.current)?.focus();
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.stopPropagation();if(!working.current)close.current();}
   else if(event.key==='Tab'){
    if(working.current){event.preventDefault();panel.current?.focus();}
    else trapTab(panel.current,event);
   }
  };
  document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('keydown',key);trigger?.focus();};
 },[]);
 return <div role="presentation" className="fixed inset-0 z-modal flex items-center justify-center bg-scrim p-4"
  onClick={event=>{if(event.target===event.currentTarget&&!working.current)close.current();}}>
  <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy||undefined}
   className="flex max-h-full w-full max-w-xl flex-col rounded-panel border border-border bg-surface shadow-e3 focus:outline-none">
   <header className="flex shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5">
    <h2 id={titleId} className="text-body font-semibold text-text">{title}</h2>
    <IconButton icon={X} label="关闭" disabled={busy} onClick={()=>close.current()}/>
   </header>
   <div className="min-h-0 overflow-y-auto px-6 pb-5">{children}</div>
  </div>
 </div>;
}
