/** Trusted finalizer only. KMS stores encrypted operator-provisioned Ed25519 PEMs. */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readRsiDeploymentRecord } from '../../apps/server/src/rsiDeploymentAuthority.mjs';
const fingerprint = key => createHash('sha256').update(createPublicKey(key).export({type:'spki',format:'der'})).digest('hex');
export async function createCampaignSigner(configuration, {sdkLoader=async()=>({kms:await import('@alicloud/kms20160120'),openapi:await import('@alicloud/openapi-client')})}={}) {
 const c=configuration;
 if(!c || c.provider!=='alibaba-secret-manager' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(c.keyId??'') || !/^[a-f0-9]{64}$/.test(c.publicKeySha256??'') || !c.secretName || !c.versionId || !c.credentialRef || !/^[a-z0-9-]+$/.test(c.region??''))throw new Error('campaign_signer_unavailable');
 let key;
 try {
  const credentials=await readRsiDeploymentRecord(c.credentialRef);
  if(Object.keys(credentials).some(k=>!['accessKeyId','accessKeySecret','securityToken'].includes(k)) || !credentials.accessKeyId || !credentials.accessKeySecret)throw new Error();
  const {kms,openapi}=await sdkLoader();
  const Client=kms.default?.default??kms.default, Config=openapi.Config??openapi.default?.Config;
  const client=new Client(new Config({...credentials,regionId:c.region,endpoint:`kms.${c.region}.aliyuncs.com`,protocol:'HTTPS',connectTimeout:10000,readTimeout:10000}));
  const response=await client.getSecretValue(new kms.GetSecretValueRequest({secretName:c.secretName,versionId:c.versionId}));
  if(response.body?.versionId!==c.versionId || response.body?.secretDataType!=='text')throw new Error();
  key=createPrivateKey(response.body.secretData);response.body.secretData='';
  if(key.asymmetricKeyType!=='ed25519' || fingerprint(key)!==c.publicKeySha256)throw new Error();
 } catch {throw new Error('campaign_signer_unavailable');}
 return {keyId:c.keyId,publicKey:createPublicKey(key),sign:bytes=>sign(null,bytes,key)};
}
