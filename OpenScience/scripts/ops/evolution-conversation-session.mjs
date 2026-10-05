/** Complete public creation and binding; a legacy reserved ID may be replaced only before actual runs. */
export async function prepareEvolutionConversationSession({checkpoint,runs,request}) {
  const used=checkpoint?.session && runs.some(run=>run.sessionId===checkpoint.session.id);
  if(used)return {session:checkpoint.session,created:false,replacedSessionId:null};
  const session=checkpoint?.createdThroughPublicApi===true ? checkpoint.session : await request('/api/runtime/sessions',{},'POST');
  if(!session?.id)throw new Error('The public runtime returned no conversation session.');
  await request(`/api/research-sessions/${encodeURIComponent(session.id)}`,{mode:'open-domain'},'PUT');
  return {session,created:true,replacedSessionId:checkpoint?.session?.id!==session.id ? checkpoint?.session?.id??null : null};
}
