import {HttpError,sendJson,readJson} from './security.mjs';
import {assertClientProject} from './internalProjects.mjs';
/** Authenticated lifecycle actions accept only release identity and optimistic state revision. */
export function createPatientMatchingRoutes({store,lifecycle,access}){
  return async(req,res)=>{
    const url=new URL(req.url??'/','http://localhost');if(url.pathname!=='/api/patient-matching')return false;
    const {user}=await store.ensureSessionUser(req,res,{allowDevAuth:false});await store.assertCsrf(req,url.pathname);
    const projectId=url.searchParams.get('projectId');assertClientProject(projectId);const project=await access(user,projectId,{manage:req.method!=='GET'});
    if(req.method==='GET'){
      const state=lifecycle?await lifecycle.current(project):null;
      sendJson(res,200,{data:{available:Boolean(lifecycle),revision:state?.revision??0,state:state?.payload.phase??'uninstalled',selected:state?.payload.selected??null,
        effective:state?.payload.effective?{releaseId:state.payload.effective.release.releaseId,generation:state.payload.effective.reference.generationHash}:null,
        releases:lifecycle?[...lifecycle.catalogue.values()].map(entry=>({releaseId:entry.releaseId,version:entry.packageVersion,reasoningModel:entry.modelProfile.reasoningModel})):[]}});return true;
    }
    if(req.method==='POST'){
      if(!lifecycle)throw new HttpError(503,'patient_matching_unavailable','Patient matching is unavailable.');
      const state=await lifecycle.reconcile(user,projectId,await readJson(req,8192));sendJson(res,202,{data:{revision:state.revision,state:state.payload.phase,selected:state.payload.selected}});return true;
    }
    throw new HttpError(404,'not_found','Not found.');
  };
}
