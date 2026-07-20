package com.evimed.agent.evidence.agentevidencebased.infrastructure.feign;

import com.alibaba.fastjson2.JSONObject;
import com.evimed.agent.evidence.agentevidencebased.entity.mongo.Condition;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

@FeignClient(name = "sentum-evimed-evidence-comprehensive")
public interface SentumComprehensiveFeign {

    @PostMapping("/evidence-api/adverse-api/drug-safe-info-zx")
    JSONObject drugSafeInfoZx(@RequestBody Condition condition);
}
