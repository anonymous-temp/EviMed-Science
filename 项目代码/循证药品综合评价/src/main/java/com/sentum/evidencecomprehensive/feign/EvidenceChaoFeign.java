package com.sentum.evidencecomprehensive.feign;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import io.swagger.annotations.ApiOperation;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/5/31
 */
@Component
@FeignClient("sentum-evimed-evidence-comprehensive")
public interface EvidenceChaoFeign {

    @ApiOperation(value = "药品安全性分析-获取图表数据", notes = "drug-safe-info-zx")
    @PostMapping("/evidence-api/adverse-api/drug-safe-info-zx")
    JSONObject drugSafeInfoZx(@RequestBody Condition condition);
}
