
json_value <- function(x) {
 if (is.matrix(x)) return(paste0('[',paste(apply(x,1,function(row)json_value(as.numeric(row))),collapse=','),']'))
 if (is.list(x)) {
  values <- vapply(x,json_value,character(1))
  if (!is.null(names(x))) return(paste0('{',paste(paste0('"',names(x),'":',values),collapse=','),'}'))
  return(paste0('[',paste(values,collapse=','),']'))
 }
 if (length(x)>1) return(paste0('[',paste(format(x,digits=17,scientific=FALSE,trim=TRUE),collapse=','),']'))
 as.character(x)
}
strategies <- list()
labels <- c('soc','a','b','ab')
for(i in 1:4) {
 transitions <- if(exists('a_P_SoC')) get(c('a_P_SoC','a_P_strA','a_P_strB','a_P_strAB')[i]) else array(rep(get(c('m_P','m_P_strA','m_P_strB','m_P_strAB')[i]),n_cycles),c(n_states,n_states,n_cycles))
 cost_rewards <- matrix(rep(l_c[[i]],each=n_states),nrow=n_states)
 utility_rewards <- matrix(rep(l_u[[i]],each=n_states),nrow=n_states)
 dimnames(cost_rewards) <- dimnames(utility_rewards) <- list(v_names_states,v_names_states)
 if(exists('du_HS1')) {
  utility_rewards['H','S1'] <- utility_rewards['H','S1'] - du_HS1
  cost_rewards['H','S1'] <- cost_rewards['H','S1'] + ic_HS1
  cost_rewards[-n_states,'D'] <- cost_rewards[-n_states,'D'] + ic_D
 }
 strategies[[labels[i]]] <- list(transitionMatrices=lapply(1:n_cycles,function(t)transitions[,,t]),costRewards=cost_rewards,utilityRewards=utility_rewards)
}
specification <- list(initial=as.numeric(c(1,0,0,0)),strategies=strategies,costWeights=as.numeric(v_dwc*v_wcc),utilityWeights=as.numeric(v_dwe*v_wcc))
cat('SPECIFICATION:',json_value(specification),'\n',sep='')
write.csv(data.frame(cost=v_tot_cost,qaly=v_tot_qaly),stdout(),row.names=FALSE)
