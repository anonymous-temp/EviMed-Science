/** Build-only dependency admission checks; these do not qualify a SaaS extension. */
export function validateOverlayClosure(closure){
  const packages=closure.packages;
  if(!Array.isArray(packages)||packages.some(item=>['buffers','binary'].includes(item.name)))throw new Error('overlay_forbidden_dependency_present');
  const zip=packages.filter(item=>item.name==='unzipper');
  if(zip.length!==1||zip[0].version!=='0.12.3'||zip[0].license!=='MIT')throw new Error('overlay_unzipper_identity_differs');
  if(packages.some(item=>!item.license||item.license==='UNKNOWN'))throw new Error('overlay_unknown_license');
  return true;
}
