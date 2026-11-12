/** Operator-selected first-party release catalogue. Requests never supply paths or package code. */
import fs from 'node:fs';
import { patientMatchingCatalogue } from './patientMatchingLifecycleArtifacts.mjs';
export function loadPatientMatchingDeployment(config){
  if(!config.patientMatchingCataloguePath)return [];
  const descriptor=fs.openSync(config.patientMatchingCataloguePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(descriptor);if(!stat.isFile()||stat.size>2*1024*1024||(stat.mode&0o022)!==0)throw new Error('Protected matching catalogue required.');
    const value=JSON.parse(fs.readFileSync(descriptor,'utf8'));patientMatchingCatalogue(value);return value;
  }finally{fs.closeSync(descriptor);}
}
