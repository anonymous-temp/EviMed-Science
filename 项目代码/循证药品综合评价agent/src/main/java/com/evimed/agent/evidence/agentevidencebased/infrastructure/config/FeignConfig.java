package com.evimed.agent.evidence.agentevidencebased.infrastructure.config;

import com.evimed.agent.evidence.agentevidencebased.infrastructure.feign.SentumComprehensiveFeign;
import com.evimed.agent.evidence.agentevidencebased.infrastructure.util.EvidenceUtils;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;

@Slf4j
@Configuration
public class FeignConfig {

    @Autowired(required = false)
    private SentumComprehensiveFeign sentumFeign;

    @Autowired(required = false)
    private ChatModel chatModel;

    @PostConstruct
    public void init() {
        if (sentumFeign != null) {
            EvidenceUtils.setSentumFeign(sentumFeign);
            log.info("SentumComprehensiveFeign 已注入到 EvidenceUtils");
        } else {
            log.warn("SentumComprehensiveFeign 未配置，FAERS 功能将不可用");
        }

        if (chatModel != null) {
            EvidenceUtils.setLLMChatModel(chatModel);
            log.info("ChatModel 已注入到 EvidenceUtils，支持 LLM 关键词扩展");
        } else {
            log.warn("ChatModel 未配置，LLM 关键词扩展将不可用");
        }
    }
}
